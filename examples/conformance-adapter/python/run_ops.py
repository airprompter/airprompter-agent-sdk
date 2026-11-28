"""The Python SDK's answers to the conformance harness's framework sections (AIR-2233).

``session_scenario`` runs a run-session vector on a real offline agent (memory sink, fake clock, the harness's sealed
bundle through ``apply_bundle``); ``drive_run`` starts the same agent and hands it to the framework's driver in
``drivers/<framework>.py``, which builds the framework as a developer would: ``def drive_run(*, ap, fixture, clock, **_)``
(sync or async) returning ``{"calls": [...], "runRefs": [...], "state"?: ...}``. ``adapter.py`` routes the operations here::

    from run_ops import RUN_OPS   # sessionScenario, unavailableReasons, driveRun
    OPS.update(RUN_OPS)
"""
from __future__ import annotations

import asyncio
import dataclasses
import importlib.metadata
import importlib.util
import inspect
import json
import os
import shutil
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Optional

from airprompter_agent import AirPrompterAgent
from airprompter_agent.core.render.run_ref import parse_run_ref, run_ref_key_from
from airprompter_agent.runtime.run import UNAVAILABLE_REASONS, RunInput
from airprompter_agent.telemetry.spool.writer import _row_bytes

HERE = os.path.dirname(os.path.abspath(__file__))
DRIVERS = os.path.join(HERE, "drivers")


class Clock:
    """The fake clock every scenario and fixture runs on: moved by a step, never by wall time."""

    def __init__(self, ms: float):
        self.ms = float(ms)

    def __call__(self) -> float:
        return self.ms


def _start(agent: dict, *, state_dir: str, clock: Clock, log: list, variable_sources: Optional[dict] = None, source_calls: Optional[dict] = None, run_ref_secret: Optional[str] = None, run_ref_previous_secrets: Optional[list] = None) -> AirPrompterAgent:
    variables: dict[str, Any] = {}
    lock = threading.Lock()
    for name, value in (variable_sources or {}).items():
        def resolve(_context: Any, name: str = name, value: str = value) -> str:
            with lock:
                source_calls[name] = source_calls.get(name, 0) + 1  # type: ignore[union-attr]
            time.sleep(0.02)  # a real source takes time: concurrent places overlap here
            return value

        variables[name] = {"resolve": resolve, "trust": "operator"}
    return AirPrompterAgent.start(
        organization_id=agent["organizationId"], agent_id=agent["agentId"], target=agent["target"], state_dir=state_dir,
        root={"pinned": agent["rootPublicJwk"]}, telemetry={"sink": "memory"}, now=clock, logger=log.append,
        run_ref_secret=run_ref_secret or agent["runRefSecret"], run_idle_timeout_ms=agent["idleTimeoutMs"], **({"variables": variables} if variables else {}),
        **({"run_ref_previous_secrets": run_ref_previous_secrets} if run_ref_previous_secrets else {}),
    )


def _apply(ap: AirPrompterAgent, bundle: dict) -> None:
    outcome = ap.apply_bundle(bundle)
    if outcome.get("outcome") not in ("activated", "staged"):
        raise RuntimeError(f"apply_bundle: {outcome.get('outcome')} {outcome.get('reason') or ''} {outcome.get('detail') or ''}".strip())


def _new_out() -> dict:
    return {"rows": [], "steps": [], "refusals": [], "wire": {"rows": [], "steps": [], "refusals": []}, "runCounters": {"passthrough": {}}}


def _finish(ap: AirPrompterAgent, out: dict) -> None:
    """Stop the agent (open runs end, windows close) and take its rows, as objects and as the spool's lines, and its counters."""
    ap.stop()
    for row in ap.drain_memory_sink():
        kind = "rows" if row.get("type") == "window" else "steps" if row.get("type") == "step" else "refusals"
        out[kind].append(row)
        # What the uploader would send: the writer's own serialisation, strict, so a value JSON has no type for fails here.
        out["wire"][kind].append(_row_bytes(row).decode("utf-8").rstrip("\n"))
    for reason, n in (ap.heartbeat_body().get("runCounters") or {}).get("passthrough", {}).items():
        out["runCounters"]["passthrough"][reason] = out["runCounters"]["passthrough"].get(reason, 0) + n


def _placement(placed: Any) -> dict:
    return {k: v for k, v in dataclasses.asdict(placed).items()} | {"kind": placed.kind}


def _forge(ref: str) -> str:
    return ref[:-3] + ("BBB" if ref.endswith("AAA") else "AAA")


def _fill(value: Any, i: int) -> Any:
    if isinstance(value, str):
        return value.replace("{i}", str(i))
    if isinstance(value, dict):
        return {k: _fill(v, i) for k, v in value.items()}
    return value


def _run_input(fields: dict) -> RunInput:
    return RunInput(subject=fields.get("subject"), conversation_id=fields.get("conversationId"), tags=fields.get("tags"), variables=fields.get("variables"), resume=fields.get("resume"))


def _model_call(call: dict) -> dict:
    names = {"model": "model", "latencyMs": "latency_ms", "step": "step", "usage": "usage", "errorClass": "error_class", "outputText": "output_text", "toolsObserved": "tools_observed"}
    return {names[k]: v for k, v in call.items() if k in names}


def session_scenario(a: dict) -> dict:
    agent = a["agent"]
    clock = Clock(agent["t0"])
    log: list = []
    source_calls: dict = {}
    state_dir = tempfile.mkdtemp(prefix="ap-conformance-run-")
    out = _new_out()
    key = run_ref_key_from(agent["runRefSecret"], agent["agentId"], agent["target"])
    runs: dict[str, Any] = {}
    scopes: dict[str, Any] = {}
    results: list = []
    ap = _start(agent, state_dir=state_dir, clock=clock, log=log, variable_sources=a.get("variableSources"), source_calls=source_calls)
    stopped = False

    def release_scopes() -> None:
        """Leave every scope still open (each ``ap.run`` then ends its run), as the TypeScript adapter does."""
        open_scopes = list(scopes.values())
        scopes.clear()
        for context in open_scopes:
            context.__exit__(None, None, None)

    try:
        if a.get("bundle"):
            _apply(ap, a["bundle"])

        def input_of(fields: dict) -> RunInput:
            resolved = dict(fields)
            if isinstance(fields.get("subject"), dict):
                facts = parse_run_ref(runs[fields["subject"]["runIdOf"]].run_ref, [key])
                resolved["subject"] = facts.run_id if facts else None
            if isinstance(fields.get("resume"), dict):
                resume = fields["resume"]
                resolved["resume"] = runs[resume["ref"]].run_ref if "ref" in resume else _forge(runs[resume["forged"]].run_ref)
            return _run_input(resolved)

        def token_of(step: dict) -> str:
            if "token" in step:
                return step["token"]
            if "forged" in step:
                return _forge(runs[step["forged"]].run_ref)
            return runs[step["run"]].run_ref

        for step in a["steps"]:
            try:
                op = step["op"]
                run = runs.get(step["run"]) if "run" in step else None
                if op == "open":
                    if step.get("scope") == "run":
                        context = ap.run(input_of(step["input"]))
                        runs[step["run"]] = context.__enter__()
                        scopes[step["run"]] = context
                    else:
                        runs[step["run"]] = ap.open_run(input_of(step["input"]))
                    results.append({"runRef": runs[step["run"]].run_ref})
                elif op == "place":
                    if step.get("concurrent"):
                        barrier = threading.Barrier(step["concurrent"])

                        def place(_: int, run: Any = run) -> Any:
                            barrier.wait()
                            return run.place(step["slot"])

                        with ThreadPoolExecutor(max_workers=step["concurrent"]) as pool:
                            results.append({"placements": [_placement(p) for p in pool.map(place, range(step["concurrent"]))]})
                    else:
                        results.append({"placement": _placement(run.place(step["slot"]))})
                elif op == "decline":
                    results.append({"placement": _placement(run.decline(step["slot"], "model_unresolved"))})
                elif op == "setTags":
                    run.set_tags(step["tags"])
                    results.append({})
                elif op == "slotFor":
                    slot = run.slot_for(step["slots"]) if isinstance(step["slots"], str) else run.slot_for(step["slots"], step.get("name"))
                    results.append({"slot": slot})
                elif op == "recordModelCall":
                    run.record_model_call(step["slot"], **_model_call(step["call"]))
                    results.append({})
                elif op == "recordToolCall":
                    run.record_tool_call(step["slot"], ok=step["call"]["ok"], step=step["call"].get("step"))
                    results.append({})
                elif op == "end":
                    context = scopes.pop(step["run"], None)
                    if context is not None:
                        if step.get("errorClass") or step.get("interrupted"):
                            run.end(error_class=step.get("errorClass"), interrupted=bool(step.get("interrupted")))
                        context.__exit__(None, None, None)
                    else:
                        run.end(error_class=step.get("errorClass"), interrupted=bool(step.get("interrupted")))
                    results.append({})
                elif op == "advance":
                    clock.ms += step["ms"]
                    results.append({})
                elif op == "sweep":
                    # The registry sweeps idle runs at every open (the spool timer and an invocation's edges call the same sweep).
                    ap.open_run().end()
                    results.append({})
                elif op in ("swapRelease", "applyDirective"):
                    _apply(ap, step["bundle"])
                    results.append({})
                elif op == "feedback":
                    results.append({"filed": ap.feedback(token_of(step), step["signals"], slot=step.get("slot"), model=step.get("model"))})
                elif op == "explain":
                    entries = ap.explain(token_of(step))
                    results.append({"entries": [dict(e) for e in entries] if entries is not None else None})
                elif op == "ref":
                    results.append({"token": run.run_ref})
                elif op == "sample":
                    placements = []
                    for i in range(step["runs"]):
                        sampled = ap.open_run(input_of(_fill(step["input"], i)))
                        placements.append(_placement(sampled.place(step["slot"])))
                        sampled.end()
                    results.append({"placements": placements})
                elif op == "restart":
                    release_scopes()
                    stopped = True
                    _finish(ap, out)
                    ap = _start(agent, state_dir=state_dir, clock=clock, log=log, variable_sources=a.get("variableSources"), source_calls=source_calls)
                    stopped = False
                    results.append({})
                else:
                    raise ValueError(f"unknown step op {op}")
            except Exception as error:  # noqa: BLE001 — a step that throws is reported by the harness, by step
                results.append({"error": f"{type(error).__name__}: {error}"})
        release_scopes()
        stopped = True
        _finish(ap, out)
    finally:
        # A step that raised out of the loop (apply_bundle) still stops the agent, so no timer outlives the state folder.
        if not stopped:
            ap.stop()
        shutil.rmtree(state_dir, ignore_errors=True)
    return {"results": results, **out, "log": _loggable(log), "sourceCalls": source_calls}


def _loggable(log: list) -> list:
    """Log events as JSON: a value JSON has no type for is written as its text here, and only here (rows stay strict)."""
    return json.loads(json.dumps(log, default=str))


def _placements_of(log: list) -> list:
    """Each slot's placement, in order, from the run's logs: what the adapter chose, never the text. A later decline of an
    approved slot (``run_passthrough model_unresolved``) turns its entry into that passthrough, keeping the version it pinned."""
    out: list = []
    runs: list = []  # each entry's run id: a decline folds into its own run's entry, as two runs can hold one slot at once
    for event in log:
        if event.get("event") == "run_passthrough" and event.get("reason") == "model_unresolved":
            for placed, run_id in reversed(list(zip(out, runs))):
                if placed["slot"] == event.get("slot") and placed["kind"] == "approved" and run_id == event.get("runId"):
                    placed.update(kind="passthrough", reason="model_unresolved", declined=True)
                    break
            continue
        if event.get("event") != "run_placed":
            continue
        placed: dict = {"slot": event.get("slot"), "kind": "passthrough" if event.get("reason") else "approved"}
        if event.get("reason"):
            placed["reason"] = event["reason"]
        if event.get("versionId"):
            placed["versionId"] = event["versionId"]
            placed["arm"] = event.get("arm")
        out.append(placed)
        runs.append(event.get("runId"))
    return out


def _driver(framework: str) -> Any:
    path = os.path.join(DRIVERS, f"{framework.replace('-', '_')}.py")
    if not os.path.exists(path):
        error = LookupError(f"no Python driver for {framework} (drivers/{os.path.basename(path)})")
        error.reason = "no_driver"  # type: ignore[attr-defined]
        raise error
    spec = importlib.util.spec_from_file_location(f"conformance_driver_{framework.replace('-', '_')}", path)
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


def _version_of(name: str) -> Optional[str]:
    """The installed distribution's version, or None when it is not installed (the harness reports it as a miss)."""
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def drive_run(a: dict) -> dict:
    fixture, agent = a["fixture"], a["agent"]
    driver = _driver(fixture["framework"])
    clock = Clock(agent["t0"])
    log: list = []
    state_dir = tempfile.mkdtemp(prefix="ap-conformance-drive-")
    out = _new_out()
    ap = _start(agent, state_dir=state_dir, clock=clock, log=log)
    others: list = []

    class Host:
        """More agents a fixture asks for (another pod, another store): each on its own store and the same clock, the
        release applied unless ``release=False``, with its own run-reference secrets. Every one is stopped and drained."""

        def start_agent(self, *, release: bool = True, run_ref_secret: Optional[str] = None, run_ref_previous_secrets: Optional[list] = None) -> AirPrompterAgent:
            folder = tempfile.mkdtemp(prefix="ap-conformance-drive-")
            started = _start(agent, state_dir=folder, clock=clock, log=log, run_ref_secret=run_ref_secret, run_ref_previous_secrets=run_ref_previous_secrets)
            others.append({"ap": started, "dir": folder, "stopped": False})
            if release and a.get("bundle"):
                _apply(started, a["bundle"])
            return started

    stopped = False
    try:
        if a.get("bundle"):
            _apply(ap, a["bundle"])
        # Keywords only, and a driver takes ``**_``: a later part adds to the context without breaking one. An async
        # driver (an async-only framework) is run to completion here.
        driven = driver.drive_run(ap=ap, fixture=fixture, clock=clock, host=Host())
        if inspect.iscoroutine(driven):
            driven = asyncio.run(driven)
        stopped = True
        _finish(ap, out)
        for other in others:
            other["stopped"] = True
            _finish(other["ap"], out)
        result = {"placements": _placements_of(log), "calls": driven["calls"], "runRefs": driven.get("runRefs", []), **out, "log": _loggable(log)}
        if a.get("package"):
            result["frameworkVersion"] = _version_of(a["package"])
        result["packageVersions"] = {name: _version_of(name) for name in a.get("packages") or []}
        for key in ("state", "results"):
            if key in driven:
                result[key] = driven[key]
        return result
    finally:
        if not stopped:
            ap.stop()
        for other in others:
            if not other["stopped"]:
                other["ap"].stop()
            shutil.rmtree(other["dir"], ignore_errors=True)
        shutil.rmtree(state_dir, ignore_errors=True)


RUN_OPS: dict[str, Callable[[dict], dict]] = {
    "sessionScenario": session_scenario,
    "unavailableReasons": lambda _a: {"reasons": list(UNAVAILABLE_REASONS)},
    "driveRun": drive_run,
}
