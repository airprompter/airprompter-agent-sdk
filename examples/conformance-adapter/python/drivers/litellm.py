"""The LiteLLM driver (Python): the real ``litellm.completion`` with its own ``mock_response`` (a full OpenAI-shaped
response per recorded turn, so the usage is the fixture's), and the AirPrompter callback in ``litellm.callbacks``, as
the adapter's docs say to write it:

- inside ``ap.run``: place the slot, put the release's model and settings on the call (``litellm_params``) and its
  text first in the messages, and measure the call where it is made (``measure_call``);
- a sync ``stream=True`` call inside ``ap.run`` marked with ``litellm_metadata((run, slot))``: LiteLLM logs it after the
  stream ends, on a worker thread without the caller's context; the callback finds the run by its reference;
- with no run: ``litellm_metadata(rendered)`` on a prompt rendered outside any run, a one-call row.

LiteLLM has no client object, so ``modelFor`` is the application's: the id it sends the release's model under, or
``None`` to decline the slot (``run.decline``). The calls the fixture reads are the keyword arguments each
``litellm.completion`` received. ``measure_call`` comes from ``frameworks.contract``: LiteLLM's own subpath has no
measuring helper yet (AIR-2545, ``instrument(litellm)``).

Example::

    result = drive_run(ap=ap, fixture=fixture, clock=clock)
"""
from __future__ import annotations

import json
import os
import threading
from typing import Any

# The bundled model map, never a fetch: it decides which settings LiteLLM accepts per model, so it is pinned with LiteLLM.
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")

import litellm  # noqa: E402

from airprompter_agent.frameworks.contract import measure_call  # noqa: E402  AIR-2545 moves this onto the litellm subpath
from airprompter_agent.frameworks.litellm import AirPrompterLiteLLMCallback, litellm_metadata, litellm_params  # noqa: E402
from drivers.program import run_input  # noqa: E402

#: How long the logger may take after a stream ends; past it the case fails rather than reading a missing record as none.
LOGGER_WAIT_S = 20

SETTINGS = ("temperature", "top_p", "max_tokens", "max_completion_tokens", "stop", "reasoning_effort")


def _tool(name: str) -> dict:
    return {"type": "function", "function": {"name": name, "description": f"the {name} tool", "parameters": {"type": "object", "properties": {}}}}


def _response(turn: dict, n: int, model: str) -> dict:
    usage = turn.get("usage") or {}
    tool_calls = [{"id": f"call_{n}_{i}", "type": "function", "function": {"name": name, "arguments": "{}"}} for i, name in enumerate(turn.get("toolCalls") or [])]
    message: dict = {"role": "assistant", "content": turn.get("content") or ""}
    if tool_calls:
        message["tool_calls"] = tool_calls
    inp, out, cached = usage.get("input", 3), usage.get("output", 2), usage.get("cachedInput", 0)
    return {"id": f"chatcmpl-{n}", "object": "chat.completion", "created": 1, "model": model, "choices": [{"index": 0, "finish_reason": turn.get("finish") or ("tool_calls" if tool_calls else "stop"), "message": message}],
            "usage": {"prompt_tokens": inp, "completion_tokens": out, "total_tokens": inp + out, "prompt_tokens_details": {"cached_tokens": cached}}}


class _Seen:
    def __init__(self, turns: list, clock: Any):
        self.turns, self.clock, self.calls = turns, clock, []

    def completion(self, **kwargs: Any) -> Any:
        """One ``litellm.completion``, its next recorded turn as the mock response; the arguments are kept as the provider would see them."""
        sent = {k: v for k, v in kwargs.items() if k != "metadata"}
        self.calls.append({"raw": json.dumps(sent, sort_keys=True), "request": json.dumps(sent, sort_keys=True), "model": sent.get("model"), "system": [m["content"] for m in sent.get("messages", []) if m.get("role") in ("system", "developer")], "settings": {k: sent[k] for k in SETTINGS if k in sent}, "stream": sent.get("stream") is True})
        turn = self.turns[min(len(self.calls) - 1, len(self.turns) - 1)]
        if self.clock is not None:
            self.clock.ms += turn.get("latencyMs", 100)
        if kwargs.get("stream"):
            # LiteLLM 1.111 logs a mocked stream only from a text mock (a full response mocked as a stream is never
            # logged), so a streamed turn is its text, and the usage is LiteLLM's own count of it.
            return litellm.completion(**kwargs, mock_response=turn.get("content") or "")
        return litellm.completion(**kwargs, mock_response=_response(turn, len(self.calls), kwargs.get("model") or "none"))

    def seen(self) -> list:
        return [{k: c[k] for k in ("model", "system", "settings", "stream")} for c in self.calls]


def _turns(seen: _Seen, step: dict, history: list, call: Any) -> None:
    """The application's tool loop for one step: ``call(messages, extra)`` makes one completion."""
    for _ in range(12):
        response = call(list(history), {"tools": [_tool(n) for n in step["tools"]]} if step.get("tools") else {})
        message = response.choices[0].message
        tool_calls = getattr(message, "tool_calls", None) or []
        if not tool_calls:
            return
        history.append({"role": "assistant", "content": message.content or "", "tool_calls": [{"id": c.id, "type": "function", "function": {"name": c.function.name, "arguments": c.function.arguments}} for c in tool_calls]})
        history.extend({"role": "tool", "tool_call_id": c.id, "content": "found it"} for c in tool_calls)


def _program(ap: Any, fixture: dict, seen: _Seen, *, bare: bool, logged: threading.Semaphore) -> list:
    agent, refs = fixture["agent"], []
    mapping = agent["clients"][0].get("modelFor")

    def step_in(run: Any, step: dict) -> None:
        slot = agent["clients"][step.get("client", 0)]["slot"]
        placed = run.place(slot) if run is not None and not bare else None
        approved = placed is not None and placed.kind == "approved"
        params = litellm_params(placed) if approved else {}
        if approved and mapping is not None:
            wire = mapping.get(placed.model)
            if wire is None:
                run.decline(slot, "model_unresolved")
                approved, params = False, {}
            else:
                params = {**params, "model": wire}
        if approved and step.get("sendModel") == "caller":
            params = {k: v for k, v in params.items() if k != "model"}  # the call site dropped the release's model
        system = placed.instructions if approved else step.get("system")
        history = ([{"role": "system", "content": system}] if system is not None else []) + [{"role": "user", "content": step.get("user", "hi")}]
        caller = {"model": step["model"], **(step.get("params") or {})}

        def call(messages: list, extra: dict) -> Any:
            kwargs = {**caller, **params, "messages": messages, **extra}
            if step.get("stream"):
                kwargs["stream"] = True
                if approved:
                    kwargs["metadata"] = litellm_metadata((run, slot))
                for _ in seen.completion(**kwargs):
                    pass
                if approved and not logged.acquire(timeout=LOGGER_WAIT_S):  # the logger runs after the stream, on its own thread
                    raise TimeoutError(f"LiteLLM's logger did not fire within {LOGGER_WAIT_S} s of the stream's end")
                return _Final()
            if approved:
                return measure_call(run, slot, lambda: seen.completion(**kwargs), model=placed.model, now=seen.clock)
            return seen.completion(**kwargs)

        _turns(seen, step, history, call)
        if run is not None:
            refs.append(run.run_ref)

    if bare or (agent.get("scope") or "run") == "none":
        for step in agent["steps"]:
            if bare or not step.get("stream"):
                step_in(None, step)
                continue
            # No run: a prompt rendered outside any run, marked on the call; the callback writes its one-call row.
            slot = agent["clients"][step.get("client", 0)]["slot"]
            rendered = ap.prompt(slot).render({})
            kwargs = {"model": rendered.model, "messages": [{"role": "system", "content": rendered.text}, {"role": "user", "content": step.get("user", "hi")}], "stream": True, "metadata": litellm_metadata(rendered)}
            for _ in seen.completion(**kwargs):
                pass
            if not logged.acquire(timeout=LOGGER_WAIT_S):
                raise TimeoutError(f"LiteLLM's logger did not fire within {LOGGER_WAIT_S} s of the stream's end")
    else:
        with ap.run(run_input(fixture.get("input"))) as run:
            for step in agent["steps"]:
                step_in(run, step)
    return refs


class _Final:
    """A streamed call's end, for the tool loop: a stream step asks for no tools."""

    class _Choice:
        class message:  # noqa: N801 — read as response.choices[0].message
            content = ""
            tool_calls = None

    choices = [_Choice]


class _Callback(AirPrompterLiteLLMCallback):
    """The callback, counting the logger's calls marked for AirPrompter (a measured call's own log must not stand in for a stream's)."""

    logged: threading.Semaphore

    def _observe(self, call_kwargs: Any, *args: Any, **kwargs: Any) -> None:
        try:
            super()._observe(call_kwargs, *args, **kwargs)
        finally:
            metadata = ((call_kwargs or {}).get("litellm_params") or {}).get("metadata") or (call_kwargs or {}).get("metadata") or {}
            if isinstance(metadata, dict) and "airprompter" in metadata:
                self.logged.release()


def _callback(ap: Any) -> Any:
    """One callback for the process, pointed at this fixture's agent. LiteLLM copies ``litellm.callbacks`` into its own
    success lists the first time it sees them, so a callback swapped in later is never called; an application
    registers one at start-up, and so does this driver."""
    callback = getattr(litellm, "_airprompter_conformance_callback", None)
    if callback is None:
        callback = _Callback(ap)
        litellm._airprompter_conformance_callback = callback
        litellm.callbacks = [*litellm.callbacks, callback]
    callback._ap = ap
    callback._said = set()
    callback.logged = threading.Semaphore(0)
    return callback


def drive_run(*, ap: Any, fixture: dict, clock: Any, **_: Any) -> dict:
    logged = _callback(ap).logged
    seen = _Seen(fixture["recorded"]["turns"], clock)
    refs = _program(ap, fixture, seen, bare=False, logged=logged)
    calls = seen.seen()
    if fixture["agent"].get("baseline"):
        baseline = _Seen(fixture["recorded"]["turns"], None)
        _program(ap, fixture, baseline, bare=True, logged=threading.Semaphore(0))
        calls = [{**c, "untouched": i < len(baseline.calls) and baseline.calls[i]["raw"] == seen.calls[i]["raw"]} for i, c in enumerate(calls)]
    return {"calls": calls, "runRefs": refs}
