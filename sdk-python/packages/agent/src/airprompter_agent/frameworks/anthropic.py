"""The ``anthropic`` client (``Anthropic`` or ``AsyncAnthropic``) as an adapter. ``instrument(client, ap, slot=...)``
puts the approved instructions in ``system``, the release's model and its sealed settings on every Messages call, and
measures the call into the run. Without a slot the client only measures, inside ``with ap.attribute(rendered):`` where
the caller placed the text; outside any scope a call passes through unobserved. The ``anthropic`` package is never
imported: the shapes read here are its documented response and stream-event shapes, as SDK objects or dicts.

With a slot, stream with ``create(stream=True)``: ``messages.stream()`` passes through unmeasured, with one log.

Example::

    from anthropic import Anthropic
    from airprompter_agent.frameworks.anthropic import instrument

    anthropic = instrument(Anthropic(), ap, slot="support.reply")
    with ap.run(subject=user_id):
        reply = anthropic.messages.create(model="claude-haiku-4-5", max_tokens=1024, messages=[{"role": "user", "content": question}])
    # ``system`` is the approved text; one run row
"""

from __future__ import annotations

from typing import Any, Callable, Mapping, Optional

from .contract import Approved, ClientMethod, InstrumentRuntime, apply_settings, instrument_client, read_field


class _MessagesAccumulator:
    """Messages events folded into one message: usage from ``message_start`` and ``message_delta``, text deltas, the stop reason."""

    def __init__(self) -> None:
        self.text = ""
        self.finish: Optional[str] = None
        self.input_tokens: Optional[int] = None
        self.cached: Optional[int] = None
        self.output_tokens: Optional[int] = None

    def _usage(self, usage: Any) -> None:
        for name, attr in (("input_tokens", "input_tokens"), ("cache_read_input_tokens", "cached"), ("output_tokens", "output_tokens")):
            value = read_field(usage, name)
            if isinstance(value, int) and not isinstance(value, bool):
                setattr(self, attr, value)

    def push(self, chunk: Any) -> None:
        kind = str(read_field(chunk, "type") or "")
        if kind == "message_start":
            self._usage(read_field(read_field(chunk, "message"), "usage"))
        elif kind == "content_block_delta":
            delta = read_field(chunk, "delta")
            text = read_field(delta, "text")
            if read_field(delta, "type") == "text_delta" and isinstance(text, str):
                self.text += text
        elif kind == "message_delta":
            self._usage(read_field(chunk, "usage"))
            stop = read_field(read_field(chunk, "delta"), "stop_reason")
            if isinstance(stop, str):
                self.finish = stop

    def final(self) -> Any:
        result: dict[str, Any] = {"stop_reason": self.finish or "end_turn", "content": [{"type": "text", "text": self.text}]}
        if self.input_tokens is not None or self.output_tokens is not None:
            usage: dict[str, int] = {"input_tokens": self.input_tokens or 0, "output_tokens": self.output_tokens or 0}
            if self.cached is not None:
                usage["cache_read_input_tokens"] = self.cached
            result["usage"] = usage
        return result


#: The Anthropic client's model-call methods. Anything else on the client is its own.
ANTHROPIC_METHODS = (
    ClientMethod(("messages", "create"), "messages", _MessagesAccumulator),
    ClientMethod(("messages", "stream"), "messages", _MessagesAccumulator, helper=True),
    ClientMethod(("beta", "messages", "create"), "messages", _MessagesAccumulator),
    ClientMethod(("beta", "messages", "stream"), "messages", _MessagesAccumulator, helper=True),
    # The raw response is the caller's to parse: placed, and measured for latency only.
    ClientMethod(("messages", "with_raw_response", "create"), "messages", _MessagesAccumulator),
)


def apply_placement(params: Mapping[str, Any], placement: Approved, kind: str = "messages") -> dict[str, Any]:
    """A copy of ``params`` with the approved instructions as ``system``, the placement's model and its sealed settings.
    A caller's own ``system`` blocks, with any ``cache_control``, are replaced whole. ``params`` is never mutated."""
    return apply_settings("messages", {**params, "model": placement.model, "system": placement.instructions}, placement.settings).params


def instrument(client: Any, ap: InstrumentRuntime, *, slot: Optional[str] = None, model_for: Optional[Callable[[str, Optional[str]], Optional[str]]] = None, now: Optional[Callable[[], float]] = None) -> Any:
    """``client`` with its model calls placed and measured. ``model_for(release_model_id, caller_model)`` maps the
    release's id onto the one this client sends (a Bedrock or Vertex id, a gateway alias); None declines. ``now`` is the agent's clock for latencies.
    Instrumenting twice is once: the first slot stays."""
    return instrument_client(client, ap, adapter="anthropic", methods=ANTHROPIC_METHODS, apply=apply_placement, slot=slot, model_for=model_for, now=now)


__all__ = ["ANTHROPIC_METHODS", "apply_placement", "instrument"]
