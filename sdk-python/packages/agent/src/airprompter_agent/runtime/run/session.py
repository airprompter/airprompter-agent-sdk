"""One open run. A slot pins once, on its first ``place`` (or its first direct ``ap.prompt`` / ``ap.workflow`` inside the
run), and the rendered placement stays in memory, because a release swap drops the old payload and a pin could not be
rendered again. Reductions are the exception: every ``place`` reads the current disables (rule 2, ``pin.py``). Ramp
steps and rollbacks reach the next run.

Records only add to counters here. Nothing reaches the writer until the run ends: then, for every slot with a pin, one
run row and its step rows, all at one instant, ``agentRun`` 1 on the first row only. Tag values, prompt text and output
text are never kept in a field that outlives a call, logged or written.

Threads: tools run on threads, so every method takes the session's lock. Variables are filled outside it, and sync
and async callers share one per-slot future, so concurrent ``place`` calls render once.

Example::

    run = registry.open(RunInput(subject=user_id))
    placed = run.place("support.reply")  # pins the arm for this run
    run.record_model_call("support.reply", step="agent", model="gpt-5", latency_ms=300, usage=usage)
    run.record_tool_call("support.reply", step="tools", ok=True)
    run.end()  # one run row with count 1, however many calls; one step row per step

A row cannot change once written, so a record that arrives after ``end`` is dropped with one log. What the row can say is
that a call began and had not settled: ``begin_measure`` opens the call here (``_call_begun``), and a slot with a call
still open at the end writes ``callsReported`` false and ``usageSource`` ``unavailable``.
"""

from __future__ import annotations

import asyncio
import math
import threading
import weakref
from concurrent.futures import Future
from dataclasses import replace
from typing import Any, Callable, Mapping, Optional, Protocol, Union

from airprompter_agent.core import LATENCY_BUCKET_EDGES_MS, RUN_REF_MAX_ENTRIES, ReleaseSlot, RunDimensions, RunTotals, StepTotals, evaluate_checks, latency_bucket_index, step_name

from .pin import pin_verdict
from .placement import PlaceContext, PreparedRender, SlotPin, dimensions_of, entry_of, prepare_slot, render_async, render_sync
from .ports import RunHost, RunRecorder
from .types import Passthrough, Placement, RunInput


class _Counts:
    def __init__(self) -> None:
        self.model_calls = 0
        self.input = 0
        self.cached_input = 0
        self.output = 0
        self.all_reported = True
        self.tool_calls = 0
        self.tool_errors = 0
        #: True once a tool hook or a ``tools_observed`` call said the tools were seen, so zero calls means none ran.
        self.tools_reported = False

    def add_call(self, tokens: tuple[int, int, int], reported: bool) -> None:
        self.model_calls += 1
        self.input += tokens[0]
        self.cached_input += tokens[1]
        self.output += tokens[2]
        self.all_reported = self.all_reported and reported

    def add_tool(self, ok: bool) -> None:
        self.tools_reported = True
        self.tool_calls += 1
        if not ok:
            self.tool_errors += 1

    @property
    def usage_source(self) -> str:
        return "reported" if self.model_calls > 0 and self.all_reported else "unavailable"

    @property
    def tokens(self) -> dict[str, int]:
        return {"input": self.input, "cachedInput": self.cached_input, "output": self.output}

    @property
    def tools(self) -> dict[str, int]:
        return {"calls": self.tool_calls, "errors": self.tool_errors}


class _StepCounts(_Counts):
    def __init__(self, step: str, status: str, error_class: Optional[str]) -> None:
        super().__init__()
        self.step = step
        self.status = status
        self.error_class = error_class
        self.buckets = [0] * len(LATENCY_BUCKET_EDGES_MS)
        self.latency_sum = 0

    def add_latency(self, latency_ms: Any) -> None:
        value = float(latency_ms) if isinstance(latency_ms, (int, float)) and not isinstance(latency_ms, bool) else 0.0
        self.buckets[latency_bucket_index(value)] += 1
        self.latency_sum += max(0, round(value)) if math.isfinite(value) else 0


class _SlotState(_Counts):
    """A pinned slot's counters, against the version it pinned."""

    def __init__(self, pin: SlotPin, dims: RunDimensions) -> None:
        super().__init__()
        self.pin = pin
        self.dims = dims
        self.checks: Optional[dict[str, int]] = None
        self.steps: dict[tuple[str, str, str], _StepCounts] = {}
        #: Model calls begun through ``_call_begun`` and not yet recorded. One still open at the end is a call the row lacks.
        self.in_flight = 0

    @property
    def calls_reported(self) -> bool:
        """Every call of the slot measured, a slot with none included: nothing recorded without usage, nothing open. A slot
        that declined or failed to render served nothing."""
        return self.all_reported and self.in_flight == 0 and not self.pin.row_error

    def add_checks(self, passed: int, failed: int) -> None:
        self.checks = {"passed": (self.checks or {}).get("passed", 0) + passed, "failed": (self.checks or {}).get("failed", 0) + failed}


class RegistryHooks(Protocol):
    recorder: RunRecorder

    def forget(self, session: "Session") -> None: ...

    def first_time(self, kind: str, key: str) -> bool:
        """True the first time a process sees this key (bounded), so a name is logged once."""
        ...


def _tokens_of(usage: Any) -> tuple[tuple[int, int, int], bool]:
    """A ``UsageNormalized`` or a mapping with ``input`` / ``cached_input`` (or ``cachedInput``) / ``output`` / ``source``."""
    if usage is None:
        return (0, 0, 0), False

    def read(*names: str) -> Any:
        for name in names:
            value = usage.get(name) if isinstance(usage, Mapping) else getattr(usage, name, None)
            if value is not None:
                return value
        return None

    def count(value: Any) -> int:
        return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0 else 0

    return (count(read("input")), count(read("cached_input", "cachedInput")), count(read("output"))), read("source") == "reported"


class Session:
    def __init__(self, run_id: str, input: RunInput, host: RunHost, hooks: RegistryHooks):
        self.run_id = run_id
        self._input = input
        self._host = host
        self._hooks = hooks
        self.subject: str = input.subject if input.subject is not None else (input.conversation_id if input.conversation_id is not None else run_id)
        self._lock = threading.RLock()
        #: Single flight: the future is stored before anything is filled, so concurrent calls render once.
        self._pins: dict[str, Future] = {}
        #: The thread computing a pending placement, so a sync caller on that thread never blocks on its own work.
        self._computing: dict[int, int] = {}
        #: The settled answer per slot. A decline or a disabled reduction replaces what ``place`` answers, not the row's version.
        self._answers: dict[str, Placement] = {}
        #: Slots with a version, in pin order: the order of rows and of run reference entries.
        self._states: dict[str, _SlotState] = {}
        #: What the direct path or ``place`` chose per slot, so both serve one version.
        self._resolved: dict[str, ReleaseSlot] = {}
        self._settled: "weakref.WeakSet[SlotPin]" = weakref.WeakSet()
        self._counted: set[str] = set()
        self._logged: set[str] = set()
        self._step_names: set[str] = set()
        self._late_tags: dict[str, str] = {}
        self._opened_at = host.now()
        self._last_error_class: Optional[str] = None
        self._last_active_at = self._opened_at
        self._minted: Optional[str] = None
        self._open_scopes = 0
        self._parked = False
        self._ended = False
        if input.tags:
            self.set_tags(input.tags)

    # ---------------------------------------------------------------- the public session

    @property
    def run_ref(self) -> str:
        with self._lock:
            if self._minted is None:
                entries = [state.pin.entry for state in self._states.values() if state.pin.entry]
                if len(entries) > RUN_REF_MAX_ENTRIES:
                    self._once("ref_capped", lambda: self._host.log({"event": "run_ref_slots_capped", "runId": self.run_id, "slots": len(entries)}))
                kept = entries[:RUN_REF_MAX_ENTRIES]
                try:
                    self._minted = self._host.mint_run_ref(self.run_id, kept)
                except Exception:  # noqa: BLE001 — an entry that cannot be minted is left out, the others stay
                    self._minted = self._host.mint_run_ref(self.run_id, [entry for entry in kept if self._mints(entry)])
            return self._minted

    def _mints(self, entry: Mapping[str, Any]) -> bool:
        try:
            self._host.mint_run_ref(self.run_id, [entry])
            return True
        except Exception:  # noqa: BLE001
            return False

    @property
    def is_ended(self) -> bool:
        return self._ended

    def set_tags(self, tags: Mapping[str, str]) -> None:
        with self._lock:
            try:
                self._host.tags_for({**self._late_tags, **tags})
            except Exception:  # noqa: BLE001 — bad request data must not crash a served call
                self._host.log({"event": "run_tags_invalid", "runId": self.run_id})
                return
            self._late_tags.update(tags)

    def slot_for(self, slots: Union[str, Mapping[str, str]], name: Optional[str] = None) -> Optional[str]:
        with self._lock:
            self._touch()
            if isinstance(slots, str):
                return self._in_release(slots)
            mapped = slots[name] if name is not None and name in slots else slots.get("default")
            if mapped is None:
                key = name if name is not None else ""
                if self._hooks.first_time("unmapped_step", key):
                    self._host.log({"event": "run_step_unmapped", "runId": self.run_id, "name": key})
                self._count_once(f"unmapped\0{key}", "unmapped_step")
                return None
            return self._in_release(mapped)

    def place(self, slot: str) -> Placement:
        """Sync sources only, as ``render()``: a coroutine source answers ``variables_unfilled``. Never raises for unavailability."""
        self._touch_locked()
        stale: Optional[Future] = None
        replaced = False
        while True:
            got = self._pin_sync(slot, stale)
            if got is None:
                return Passthrough(slot, "variables_unfilled")
            step, answer = self._decide(slot, got[0], got[1], replaced)
            if step == "answer":
                assert answer is not None
                return answer
            stale, replaced = (got[0], True) if step == "replace" else (None, replaced)

    async def place_async(self, slot: str) -> Placement:
        """Every source, coroutine ones awaited. Never raises for unavailability."""
        self._touch_locked()
        stale: Optional[Future] = None
        replaced = False
        while True:
            future, pin = await self._pin_async(slot, stale)
            step, answer = self._decide(slot, future, pin, replaced)
            if step == "answer":
                assert answer is not None
                return answer
            stale, replaced = (future, True) if step == "replace" else (None, replaced)

    def decline(self, slot: str, reason: str = "model_unresolved") -> Placement:
        """The adapter could not build the released model: the slot passes through for the rest of the run, with one error row."""
        with self._lock:
            self._touch()
            placement = Passthrough(slot, reason)
            current = self._answers.get(slot)
            if isinstance(current, Passthrough) and current.reason == reason:
                return current
            self._answers[slot] = placement
            state = self._states.get(slot)
            if state is not None:
                # Feedback on a version that never served would be misfiled, so its entry leaves the reference.
                if state.pin.entry:
                    self._minted = None
                state.pin = replace(state.pin, entry=None, row_error="model_unresolved")
            self._count_once(f"{slot}\0{reason}", reason)
            self._host.log({"event": "run_passthrough", "runId": self.run_id, "slot": slot, "reason": reason})
            return placement

    def record_model_call(self, slot: str, *, model: str, latency_ms: float, step: Optional[str] = None, usage: Any = None, error_class: Optional[str] = None, output_text: Optional[str] = None, tools_observed: bool = False) -> None:
        """``output_text`` is read once for the slot's declared checks, then dropped: never kept, never recorded.
        ``tools_observed=True`` says the adapter sees this run's tool calls, so a run with none writes ``toolsReported``
        true and ``tools.calls`` 0."""
        self._add_model_call(slot, None, model=model, latency_ms=latency_ms, step=step, usage=usage, error_class=error_class, output_text=output_text, tools_observed=tools_observed)

    def _call_begun(self, slot: str) -> Callable[..., bool]:
        """Internal, AIR-2547, for ``begin_measure`` and the LiteLLM pre-call hook only: a model call on this slot has
        begun and settles later. The answer takes ``record_model_call``'s keywords and records the call, once, closing it
        under the same lock, so the run's end never sees it both recorded and open; it answers False when the run had
        already ended. A run that ends first writes
        ``callsReported`` false for the slot: the record can only arrive after the row was written, and is dropped as
        late. With no pinned slot, or after the end, it opens nothing and records as ``record_model_call`` does. Kept in
        step with the TypeScript twin (``callBegun``)."""
        with self._lock:
            state = None if self._ended else self._states.get(slot)
            if state is not None:
                state.in_flight += 1
        token = [state is not None]

        def record(**call: Any) -> bool:
            return self._add_model_call(slot, token, **call)

        return record

    def _add_model_call(self, slot: str, begun: Optional[list[bool]], *, model: str, latency_ms: float, step: Optional[str] = None, usage: Any = None, error_class: Optional[str] = None, output_text: Optional[str] = None, tools_observed: bool = False) -> bool:
        """False when the call was not taken: the run had ended (logged as late) or the slot is not pinned."""
        with self._lock:
            state = self._recordable(slot)
            if state is None:
                return False
            if begun is not None and begun[0]:
                begun[0] = False
                state.in_flight -= 1
            self._last_error_class = error_class
            tokens, reported = _tokens_of(usage)
            state.add_call(tokens, reported)
            if tools_observed:
                state.tools_reported = True
            if step is not None:
                counts = self._step(state, step, "error" if error_class else "ok", error_class)
                counts.add_call(tokens, reported)
                counts.add_latency(latency_ms)
            approved = state.pin.placement.kind == "approved"
            arm = state.dims.arm
        if output_text is not None and approved:
            declared = self._host.checks_for(slot, arm)
            if declared:
                outcome = evaluate_checks(declared, output_text, tokens[2] if reported else None)
                with self._lock:
                    state.add_checks(outcome["passed"], outcome["failed"])
        return True

    def record_tool_call(self, slot: str, *, ok: bool, step: Optional[str] = None) -> None:
        with self._lock:
            state = self._recordable(slot)
            if state is None:
                return
            state.add_tool(ok)
            if step is not None:
                self._step(state, step, "ok", None).add_tool(ok)

    def end(self, error_class: Optional[str] = None, interrupted: bool = False) -> None:
        """Idempotent. With no class given, the last model call's class decides, so a truncated reply counts.
        ``interrupted=True`` parks the run: it stays open and writes nothing until a resume picks it up and ends it, or
        the idle sweep does. A plain ``end()`` on a parked run does nothing."""
        with self._lock:
            if self._ended or self._parked:
                return
            if interrupted:
                self._parked = True
                self._touch()
                return
            chosen = error_class if error_class is not None else self._last_error_class
        self._finish(("error", chosen) if chosen else ("ok", None), self._host.now())

    # ---------------------------------------------------------------- the registry's side

    def end_idle(self) -> None:
        """The sweep's end, and ``stop()``'s: the last record's class, else interrupted. An idle run's latency stops at its last activity."""
        with self._lock:
            status = ("error", self._last_error_class) if self._last_error_class else ("interrupted", None)
            ended_at = self._host.now() if self._open_scopes > 0 else self._last_active_at
        self._finish(status, ended_at)

    def resumed(self, input: RunInput) -> None:
        """A resume of a live run: its tags merge in, the subject stays, and a parked run carries on."""
        with self._lock:
            self._parked = False
            self._touch()
        if input.tags:
            self.set_tags(input.tags)

    def enter(self) -> Callable[[], None]:
        """``with_run`` holds a scope open, so a long tool never looks idle to the sweep."""
        with self._lock:
            self._open_scopes += 1
        left = [False]

        def leave() -> None:
            with self._lock:
                if left[0]:
                    return
                left[0] = True
                self._open_scopes -= 1
                self._touch()

        return leave

    @property
    def scoped(self) -> bool:
        """Inside an open ``with_run``: never ended to make room."""
        return self._open_scopes > 0

    def idle(self, now_ms: float) -> bool:
        with self._lock:
            return self._open_scopes == 0 and now_ms - self._last_active_at >= self._host.idle_timeout_ms

    @property
    def last_active(self) -> float:
        return self._last_active_at

    # ---------------------------------------------------------------- the direct path (``ap.prompt``, ``ap.workflow``, ``observe``)

    def resolve_through(self, slot: str, resolve: Callable[[str, Mapping[str, str]], ReleaseSlot], *, entry: bool) -> ReleaseSlot:
        """The version the direct path serves for a slot in this run: the pin, after rule 2, else what ``resolve``
        chooses now, which then pins. ``resolve`` is the facade's raising path, so a refusal raises as ``ap.prompt``
        always has."""
        with self._lock:
            self._touch()
            pinned = self._resolved.get(slot)
            if pinned is not None:
                verdict = self._verdict(slot, pinned.arm)
                if verdict == "stands":
                    return pinned
                if verdict == "disabled":
                    # The pin stays, so a re-enable serves the same version: only the refusal is raised.
                    resolve(self.subject, self._tags())
                    return pinned
                del self._resolved[slot]
                if verdict == "replace":
                    self._host.log({"event": "run_replaced", "runId": self.run_id, "slot": slot})
                    self._answers.pop(slot, None)
                    self._pins.pop(slot, None)
            resolved = resolve(self.subject, self._tags())
            self._resolved[slot] = resolved
            if slot not in self._states:
                dims = dimensions_of(slot, resolved)
                self._adopt(slot, SlotPin(placement=Passthrough(slot, "no_slot"), direct=True, dims=dims, resolved=resolved, entry=entry_of(slot, resolved, dims.run_minute) if entry else None))
                self._once(f"placed\0{slot}", lambda: self._host.log({"event": "run_placed", "runId": self.run_id, "slot": slot, "versionId": dims.version_id, "artifactId": dims.artifact_id, "arm": dims.arm}))
            return resolved

    def take(self, observation: Any) -> bool:
        """An observation of a slot this run pinned folds in here, so one request counts once. False when it is not this run's."""
        with self._lock:
            if self._ended:
                return False
            state = self._states.get(observation.tag)
            if state is None:
                return False
            # The arm the row is counted on, or the arm a re-place now serves: one slot, one row.
            serving = self._resolved.get(observation.tag)
            if observation.arm != state.dims.arm and (serving is None or observation.arm != serving.arm):
                return False
            self._touch()
            error_class = None if observation.status == "ok" else observation.error_class
            self._last_error_class = error_class
            raw = observation.tokens or {}
            tokens = (int(raw.get("input") or 0), int(raw.get("cachedInput") or 0), int(raw.get("output") or 0))
            reported = (observation.usage_source or "reported") == "reported"
            tool_calls = observation.tool_calls or {}
            state.add_call(tokens, reported)
            if observation.tool_calls is not None:
                state.tools_reported = True
            state.tool_calls += int(tool_calls.get("calls") or 0)
            state.tool_errors += int(tool_calls.get("errors") or 0)
            if observation.checks:
                state.add_checks(int(observation.checks.get("passed") or 0), int(observation.checks.get("failed") or 0))
            if observation.step is not None:
                counts = self._step(state, observation.step, "error" if error_class else "ok", error_class)
                counts.add_call(tokens, reported)
                counts.tool_calls += int(tool_calls.get("calls") or 0)
                counts.tool_errors += int(tool_calls.get("errors") or 0)
                counts.add_latency(observation.latency_ms)
            return True

    def render_failed(self, slot: str) -> bool:
        """A direct-path render failed on a slot this run pinned: its row becomes the error row, and no one-call run is written."""
        with self._lock:
            if self._ended:
                return False
            state = self._states.get(slot)
            if state is None:
                return False
            state.pin = replace(state.pin, row_error="render_missing_variable")
            return True

    # ---------------------------------------------------------------- single flight

    def _obtain(self, slot: str, stale: Optional[Future]) -> tuple[Future, bool]:
        """The slot's pending placement, and whether this caller computes it. ``stale`` is a pin rule 2 replaced."""
        with self._lock:
            current = self._pins.get(slot)
            if current is not None and current is stale:
                self._host.log({"event": "run_replaced", "runId": self.run_id, "slot": slot})
                self._resolved.pop(slot, None)
                self._answers.pop(slot, None)
                current = None
            if current is not None:
                return current, False
            future: Future = Future()
            self._pins[slot] = future
            self._computing[id(future)] = threading.get_ident()
            return future, True

    def _prepared(self, slot: str) -> Union[SlotPin, PreparedRender]:
        with self._lock:
            context = PlaceContext(host=self._host, subject=self.subject, tags=self._tags, values=dict(self._input.variables or {}), resolved=self._resolved.get(slot))
        return prepare_slot(slot, context)

    def _abandon(self, slot: str, future: Future, error: BaseException) -> None:
        with self._lock:
            if self._pins.get(slot) is future:
                del self._pins[slot]
            self._computing.pop(id(future), None)
        if not future.done():
            future.set_exception(error)

    def _settle_future(self, future: Future, pin: SlotPin) -> None:
        with self._lock:
            self._computing.pop(id(future), None)
        if not future.done():
            future.set_result(pin)

    def _pin_sync(self, slot: str, stale: Optional[Future] = None) -> Optional[tuple[Future, SlotPin]]:
        while True:
            future, owner = self._obtain(slot, stale)
            stale = None
            if owner:
                try:
                    prepared = self._prepared(slot)
                    pin = prepared if isinstance(prepared, SlotPin) else render_sync(prepared)
                except BaseException as error:
                    self._abandon(slot, future, error)
                    raise
                self._settle_future(future, pin)
                return future, pin
            if not future.done() and self._computing.get(id(future)) == threading.get_ident():
                # This thread is the one computing it (an awaited source on its own loop): blocking would never return.
                return None
            try:
                return future, future.result()
            except BaseException:  # noqa: BLE001 — the computing caller was cancelled: the next caller computes
                continue

    async def _pin_async(self, slot: str, stale: Optional[Future] = None) -> tuple[Future, SlotPin]:
        while True:
            future, owner = self._obtain(slot, stale)
            stale = None
            if owner:
                try:
                    prepared = self._prepared(slot)
                    pin = prepared if isinstance(prepared, SlotPin) else await render_async(prepared)
                except BaseException as error:
                    self._abandon(slot, future, error)
                    raise
                self._settle_future(future, pin)
                return future, pin
            try:
                # Shielded: a waiter's cancellation must not cancel the placement other callers share.
                return future, await asyncio.shield(asyncio.wrap_future(future))
            except asyncio.CancelledError:
                raise
            except BaseException:  # noqa: BLE001 — the computing caller failed: the next caller computes
                continue

    def _decide(self, slot: str, future: Future, pin: SlotPin, replaced: bool) -> tuple[str, Optional[Placement]]:
        """What a settled pin answers: ``answer`` with the placement, ``replace`` when rule 2 re-places the pinned arm,
        or ``again`` when another caller re-placed it meanwhile, so this one waits on the current placement."""
        with self._lock:
            self._touch()
            if self._pins.get(slot) is not future:
                return "again", None
            self._settle(slot, pin)
            remembered = self._answers.get(slot, pin.placement)
            if isinstance(remembered, Passthrough) and remembered.reason != "slot_disabled":
                return "answer", remembered
            verdict = self._verdict(slot, pin.resolved.arm if pin.resolved else None)
            if verdict == "replace" and not replaced:
                return "replace", None
            if verdict == "disabled":
                return "answer", Passthrough(slot, "slot_disabled")
            return "answer", remembered

    # ---------------------------------------------------------------- internals (the caller holds the lock unless named _locked)

    def _finish(self, result: tuple[str, Optional[str]], ended_at: float) -> None:
        with self._lock:
            if self._ended:
                return
            self._ended = True
            now_ms = self._host.now()
            latency_ms = max(0.0, ended_at - self._opened_at)
            rows: list[tuple[RunTotals, list[StepTotals]]] = []
            for state in self._states.values():
                row_error = state.pin.row_error
                rows.append(
                    (
                        RunTotals(dimensions=state.dims, status="error" if row_error else result[0], error_class=row_error or result[1], usage_source=state.usage_source if state.calls_reported else "unavailable", tools_reported=state.tools_reported, calls_reported=state.calls_reported, agent_run=1, model_calls=state.model_calls, latency_ms=latency_ms, tokens=state.tokens, tools=state.tools, checks=dict(state.checks) if state.checks else None),
                        [StepTotals(dimensions=state.dims, step=step.step, status=step.status, error_class=step.error_class, usage_source=step.usage_source, tools_reported=state.tools_reported, model_calls=step.model_calls, latency={"buckets": list(step.buckets), "sum": step.latency_sum}, tokens=step.tokens, tools=step.tools) for step in state.steps.values()],
                    )
                )
        self._hooks.forget(self)
        recorder = self._hooks.recorder
        agent_run = 1
        for run, steps in rows:
            try:
                recorder.record_run(replace(run, agent_run=agent_run), now_ms)
                agent_run = 0
            except Exception as error:  # noqa: BLE001 — a row the writer refuses is logged and dropped
                self._host.log({"event": "observation_dropped", "runId": self.run_id, "slot": run.dimensions.tag, "reason": str(error)})
                continue
            for step in steps:
                try:
                    recorder.record_step(step, now_ms)
                except Exception as error:  # noqa: BLE001
                    self._host.log({"event": "observation_dropped", "runId": self.run_id, "slot": run.dimensions.tag, "reason": str(error)})

    def _recordable(self, slot: str) -> Optional[_SlotState]:
        if self._ended:
            self._once("late", lambda: self._host.log({"event": "run_late_record", "runId": self.run_id, "slot": slot}))
            return None
        self._touch()
        return self._states.get(slot)

    def _step(self, state: _SlotState, name: str, status: str, error_class: Optional[str]) -> _StepCounts:
        step = step_name(name, self._step_names)
        key = (step, status, error_class or "")
        counts = state.steps.get(key)
        if counts is None:
            counts = state.steps[key] = _StepCounts(step, status, error_class)
        return counts

    def _verdict(self, slot: str, arm: Optional[str]) -> str:
        """Rule 2 against the release active now: ``stands``, ``replace`` or ``disabled``."""
        release = self._host.release()
        if isinstance(release, str):
            return "stands"
        resolver = release
        experiment = resolver.experiment_for(slot)
        verdict = pin_verdict(slot=slot, arm=arm, disabled=resolver.disabled(), frozen=resolver.frozen(slot, self._tags()), experiment_id=experiment.get("experimentId") if experiment else None)
        if verdict.kind == "disabled":
            self._once(f"stamp\0{slot}", lambda: self._host.stamp_disabled(resolver.release.generation, verdict.stamp_tag))
            self._count_once(f"{slot}\0slot_disabled", "slot_disabled")
            return "disabled"
        state = self._states.get(slot)
        if state is not None and (state.pin.placement.kind == "approved" or state.pin.direct):
            self._host.stamp_lease()
        return verdict.kind

    def _settle(self, slot: str, pin: SlotPin) -> None:
        """The first settle of a pin: remember the answer, pin the version, count and log once. A pin settles once, however many callers waited on it."""
        if pin in self._settled:
            return
        self._settled.add(pin)
        self._answers[slot] = pin.placement
        if pin.resolved is not None:
            self._resolved[slot] = pin.resolved
        if pin.dims is not None:
            self._adopt(slot, pin)
        placement = pin.placement
        if isinstance(placement, Passthrough):
            self._count_once(f"{slot}\0{placement.reason}", placement.reason)
            self._host.log({"event": "run_passthrough", "runId": self.run_id, "slot": slot, "reason": placement.reason, **(pin.detail or {})})
        else:
            self._register_label(slot)
        dims = pin.dims
        self._once(f"placed\0{slot}", lambda: self._host.log({
            "event": "run_placed",
            "runId": self.run_id,
            "slot": slot,
            **({"versionId": dims.version_id, "artifactId": dims.artifact_id, "arm": dims.arm} if dims is not None else {}),
            **({"reason": placement.reason} if isinstance(placement, Passthrough) else {}),
        }))

    def _adopt(self, slot: str, pin: SlotPin) -> None:
        """Pin a version for the row. The first pin fixes the row's version and the reference entry: a re-placed arm
        serves the new arm, but the run stays counted, and takes feedback, on the arm it started on. A direct-path pin
        that ``place`` then renders keeps its counters."""
        existing = self._states.get(slot)
        if existing is not None:
            existing.pin = replace(pin, entry=existing.pin.entry, row_error=existing.pin.row_error or pin.row_error)
        else:
            assert pin.dims is not None
            self._states[slot] = _SlotState(pin, pin.dims)
        self._minted = None

    def _in_release(self, slot: str) -> Optional[str]:
        """A slot absent from the release is logged once per process and counted once per run."""
        release = self._host.release()
        if isinstance(release, str) or release.has_slot(slot):
            return slot
        if self._hooks.first_time("slot_not_in_release", slot):
            self._host.log({"event": "run_slot_not_in_release", "runId": self.run_id, "slot": slot})
        self._count_once(f"missing\0{slot}", "slot_not_in_release")
        return None

    def _count_once(self, key: str, reason: str) -> None:
        if key in self._counted:
            return
        self._counted.add(key)
        self._hooks.recorder.count_passthrough(reason)

    def _once(self, key: str, fn: Callable[[], None]) -> None:
        if key in self._logged:
            return
        self._logged.add(key)
        fn()

    def _touch(self) -> None:
        self._last_active_at = self._host.now()

    def _touch_locked(self) -> None:
        with self._lock:
            self._touch()

    def _register_label(self, slot: str) -> None:
        """A label is only a display name on the heartbeat: a bad one must not stop a served call."""
        try:
            self._host.register_label(slot)
        except Exception:  # noqa: BLE001
            self._host.log({"event": "run_label_invalid", "runId": self.run_id, "slot": slot})

    def _tags(self) -> Mapping[str, str]:
        """Read at each slot's first placement, so a late tag reaches a later slot. Bad request data must not crash a served call."""
        with self._lock:
            late = dict(self._late_tags)
        try:
            return self._host.tags_for(late)
        except Exception:  # noqa: BLE001
            self._host.log({"event": "run_tags_invalid", "runId": self.run_id})
            return self._host.tags_for()
