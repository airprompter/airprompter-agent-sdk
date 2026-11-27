"""The ``openai`` client (``OpenAI`` or ``AsyncOpenAI``) as an adapter. ``instrument(client, ap, slot=...)`` puts the
approved instructions, the release's model and its sealed settings on every Chat Completions and Responses call, and
measures the call into the run. Without a slot the client only measures, inside ``with ap.attribute(rendered):`` where
the caller placed the text; outside any scope a call passes through unobserved. The ``openai`` package is never
imported: the shapes read here are its documented response and stream-event shapes, as SDK objects or dicts.

With a slot, stream with ``create(stream=True)``: a ``.stream()`` helper passes through unmeasured, with one log, as it
does in TypeScript.

Example::

    from openai import OpenAI
    from airprompter_agent.frameworks.openai import instrument

    openai = instrument(OpenAI(), ap, slot="support.reply")
    with ap.run(subject=user_id):
        reply = openai.chat.completions.create(model="gpt-5", messages=[{"role": "user", "content": question}])
    # the system message is the approved text; one run row
"""

from __future__ import annotations

from typing import Any, Callable, Mapping, Optional

from .contract import Approved, ClientMethod, InstrumentRuntime, apply_settings, instrument_client, read_field


def _first(value: Any) -> Any:
    return value[0] if isinstance(value, (list, tuple)) and value else None


class ChatAccumulator:
    """Chat Completions chunks folded into one completion: text deltas, the finish reason, the last chunk's usage."""

    def __init__(self) -> None:
        self.text = ""
        self.finish: Optional[str] = None
        self.usage: Any = None

    def push(self, chunk: Any) -> None:
        choice = _first(read_field(chunk, "choices"))
        delta = read_field(read_field(choice, "delta"), "content")
        if isinstance(delta, str):
            self.text += delta
        finish = read_field(choice, "finish_reason")
        if isinstance(finish, str):
            self.finish = finish
        usage = read_field(chunk, "usage")
        if usage is not None:
            self.usage = usage

    def final(self) -> Any:
        result: dict[str, Any] = {"choices": [{"finish_reason": self.finish or "stop", "message": {"role": "assistant", "content": self.text}}]}
        if self.usage is not None:
            result["usage"] = self.usage
        return result


class ResponsesAccumulator:
    """Responses events folded into the final response: the terminal event's response, or the text deltas seen."""

    def __init__(self) -> None:
        self.text = ""
        self.response: Any = None

    def push(self, chunk: Any) -> None:
        kind = str(read_field(chunk, "type") or "")
        if kind == "response.output_text.delta":
            delta = read_field(chunk, "delta")
            if isinstance(delta, str):
                self.text += delta
        if kind in ("response.completed", "response.incomplete", "response.failed") and read_field(chunk, "response") is not None:
            self.response = read_field(chunk, "response")

    def final(self) -> Any:
        return self.response if self.response is not None else {"output_text": self.text}


#: The OpenAI client's model-call methods. Anything else on the client is its own.
OPENAI_METHODS = (
    ClientMethod(("chat", "completions", "create"), "chat", ChatAccumulator),
    ClientMethod(("chat", "completions", "parse"), "chat", ChatAccumulator),
    ClientMethod(("chat", "completions", "stream"), "chat", ChatAccumulator, helper=True),
    ClientMethod(("beta", "chat", "completions", "parse"), "chat", ChatAccumulator),
    ClientMethod(("responses", "create"), "responses", ResponsesAccumulator),
    ClientMethod(("responses", "parse"), "responses", ResponsesAccumulator),
    ClientMethod(("responses", "stream"), "responses", ResponsesAccumulator, helper=True),
)

_SYSTEM_ROLES = ("system", "developer")


def apply_placement(params: Mapping[str, Any], placement: Approved, kind: str = "chat") -> dict[str, Any]:
    """A copy of ``params`` with the approved instructions in the system position, the placement's model and its sealed
    settings. Chat Completions replaces a leading ``system`` or ``developer`` message or prepends one; Responses sets
    ``instructions``. ``params`` is never mutated."""
    out: dict[str, Any] = {**params, "model": placement.model}
    if kind == "responses":
        out["instructions"] = placement.instructions
        return apply_settings("responses", out, placement.settings).params
    messages = list(params.get("messages") or [])
    role = read_field(messages[0], "role") if messages else None
    # A leading developer message keeps its role: reasoning models read it as the system position.
    system = {"role": role if role in _SYSTEM_ROLES else "system", "content": placement.instructions}
    if role in _SYSTEM_ROLES:
        messages[0] = system
    else:
        messages.insert(0, system)
    out["messages"] = messages
    return apply_settings("chat", out, placement.settings).params


def instrument(client: Any, ap: InstrumentRuntime, *, slot: Optional[str] = None, model_for: Optional[Callable[[str, Optional[str]], Optional[str]]] = None, now: Optional[Callable[[], float]] = None) -> Any:
    """``client`` with its model calls placed and measured. ``model_for(release_model_id, caller_model)`` maps the
    release's id onto the one this client sends (an Azure deployment, a gateway alias); None declines. ``now`` is the agent's clock for latencies.
    Instrumenting twice is once: the first slot stays."""
    return instrument_client(client, ap, adapter="openai", methods=OPENAI_METHODS, apply=apply_placement, slot=slot, model_for=model_for, now=now)


__all__ = ["OPENAI_METHODS", "ChatAccumulator", "ResponsesAccumulator", "apply_placement", "instrument"]
