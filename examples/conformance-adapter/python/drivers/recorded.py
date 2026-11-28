"""Recorded provider transports for the Python drivers: an ``httpx.MockTransport`` handler that answers each request
with the fixture's next turn in the provider's own wire shape (JSON, or server-sent events when the request streams),
moves the fake clock by the turn's latency, and keeps what the provider saw. Provider-level only: nothing here knows
AirPrompter. The provider SDKs moved to ``httpx2`` in 2026 and accept either; this uses theirs when it is installed.

Example::

    provider = openai_chat(fixture["recorded"]["turns"], clock=clock)
    client = openai.OpenAI(api_key="test-only", http_client=provider.http_client(), max_retries=0)
    provider.seen()  # [{"model": ..., "system": [...], "settings": {...}, "stream": False}, ...]

A turn: ``{content?, toolCalls?: [name | {name, arguments}...], usage?: {input, output, cachedInput?}, finish?, latencyMs?}``.
"""
from __future__ import annotations

import json
import re
from typing import Any, Callable, Optional

try:  # the provider SDKs' own HTTP stack
    import httpx2 as httpx  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    import httpx


def text_of(content: Any) -> str:
    if isinstance(content, list):
        return "".join(block.get("text", "") for block in content if isinstance(block, dict))
    return "" if content is None else str(content)


def usage_of(turn: dict) -> dict:
    usage = turn.get("usage") or {}
    return {"input": usage.get("input", 3), "output": usage.get("output", 2), "cachedInput": usage.get("cachedInput", 0)}


def tool_calls_of(turn: dict) -> list:
    """A turn's tool calls as ``{name, arguments}`` (arguments as JSON text): a bare name asks with none."""
    return [{"name": c, "arguments": "{}"} if isinstance(c, str) else {"name": c["name"], "arguments": json.dumps(c.get("arguments") or {})} for c in turn.get("toolCalls") or []]


#: Headers that differ between two identical calls by design (a fresh idempotency key), left out of ``untouched``.
VOLATILE_HEADERS = {"idempotency-key"}


def pieces(text: str) -> list:
    return re.findall(r".{1,6}", text, re.S)


def _sse(events: list, done: bool) -> Any:
    body = "".join((f"event: {e['event']}\n" if e.get("event") else "") + f"data: {json.dumps(e['data'])}\n\n" for e in events) + ("data: [DONE]\n\n" if done else "")
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body.encode("utf-8"))


class Recorder:
    """The turns in order, what each request carried (its raw bytes too), and the clock they move."""

    def __init__(self, turns: list, clock: Any, answer: Callable[[dict, dict, int], Any], read_system: Callable[[dict], list], settings_keys: tuple):
        self.turns, self.clock, self._answer, self._read_system, self._keys = turns, clock, answer, read_system, settings_keys
        self.calls: list = []

    def handler(self, request: Any) -> Any:
        raw = request.content or b"{}"
        body = json.loads(raw)
        # ``request``: the whole request (URL, method, headers, body), so a passthrough proves it left as the bare client sends it.
        headers = sorted((k.lower(), v) for k, v in request.headers.items() if k.lower() not in VOLATILE_HEADERS)
        self.calls.append({"raw": raw, "request": json.dumps([str(request.url), request.method, headers, raw.decode("utf-8")]), "model": body.get("model"), "system": self._read_system(body), "settings": {k: body[k] for k in self._keys if k in body}, "stream": body.get("stream") is True})
        turn = self.turns[min(len(self.calls) - 1, len(self.turns) - 1)]
        if self.clock is not None:
            self.clock.ms += turn.get("latencyMs", 100)
        if turn.get("fail"):
            return httpx.Response(turn["fail"], json={"error": {"message": "failed", "type": "server_error"}})
        return self._answer(turn, body, len(self.calls))

    def http_client(self) -> Any:
        return httpx.Client(transport=httpx.MockTransport(self.handler))

    def seen(self) -> list:
        return [{k: call[k] for k in ("model", "system", "settings", "stream")} for call in self.calls]


def openai_chat(turns: list, *, clock: Any = None) -> Recorder:
    """The OpenAI Chat Completions API, plain or streamed."""

    def answer(turn: dict, body: dict, n: int) -> Any:
        usage = usage_of(turn)
        wire_usage = {"prompt_tokens": usage["input"], "completion_tokens": usage["output"], "total_tokens": usage["input"] + usage["output"], "prompt_tokens_details": {"cached_tokens": usage["cachedInput"]}}
        tool_calls = [{"id": f"call_{n}_{i}", "type": "function", "function": call} for i, call in enumerate(tool_calls_of(turn))]
        finish = turn.get("finish") or ("tool_calls" if tool_calls else "stop")
        if body.get("stream"):
            def chunk(delta: dict, reason: Optional[str] = None) -> dict:
                return {"data": {"id": f"chatcmpl-{n}", "object": "chat.completion.chunk", "created": 1, "model": body.get("model"), "choices": [{"index": 0, "delta": delta, "finish_reason": reason}]}}
            events = [chunk({"role": "assistant", "content": ""})]
            events += [chunk({"content": piece}) for piece in pieces(turn.get("content") or "")]
            events += [chunk({"tool_calls": [{"index": i, **call}]}) for i, call in enumerate(tool_calls)]
            events.append(chunk({}, finish))
            if (body.get("stream_options") or {}).get("include_usage"):
                events.append({"data": {"id": f"chatcmpl-{n}", "object": "chat.completion.chunk", "created": 1, "model": body.get("model"), "choices": [], "usage": wire_usage}})
            return _sse(events, True)
        message: dict = {"role": "assistant", "content": turn.get("content") or ""}
        if tool_calls:
            message["tool_calls"] = tool_calls
        return httpx.Response(200, json={"id": f"chatcmpl-{n}", "object": "chat.completion", "created": 1, "model": body.get("model"), "choices": [{"index": 0, "finish_reason": finish, "message": message}], "usage": wire_usage})

    return Recorder(turns, clock, answer, lambda body: [text_of(m.get("content")) for m in body.get("messages") or [] if m.get("role") in ("system", "developer")], ("temperature", "top_p", "max_tokens", "max_completion_tokens", "stop", "reasoning_effort"))


def openai_responses(turns: list, *, clock: Any = None) -> Recorder:
    """The OpenAI Responses API, plain. The system text is ``instructions``."""

    def answer(turn: dict, body: dict, n: int) -> Any:
        usage = usage_of(turn)
        output = [{"type": "function_call", "id": f"fc_{n}_{i}", "call_id": f"call_{n}_{i}", "name": c["name"], "arguments": c["arguments"], "status": "completed"} for i, c in enumerate(tool_calls_of(turn))]
        if turn.get("content"):
            output.append({"type": "message", "id": f"msg_{n}", "status": "completed", "role": "assistant", "content": [{"type": "output_text", "text": turn["content"], "annotations": []}]})
        return httpx.Response(200, json={"id": f"resp_{n}", "object": "response", "created_at": 1, "status": "completed", "model": body.get("model"), "output": output,
                                         "usage": {"input_tokens": usage["input"], "output_tokens": usage["output"], "total_tokens": usage["input"] + usage["output"], "input_tokens_details": {"cached_tokens": usage["cachedInput"]}, "output_tokens_details": {"reasoning_tokens": 0}}})

    return Recorder(turns, clock, answer, lambda body: [] if body.get("instructions") is None else [text_of(body["instructions"])], ("temperature", "top_p", "max_output_tokens", "reasoning"))


def anthropic_messages(turns: list, *, clock: Any = None) -> Recorder:
    """The Anthropic Messages API, plain or streamed."""

    def answer(turn: dict, body: dict, n: int) -> Any:
        usage = usage_of(turn)
        content = ([{"type": "text", "text": turn["content"]}] if turn.get("content") else []) + [{"type": "tool_use", "id": f"toolu_{n}_{i}", "name": call["name"], "input": json.loads(call["arguments"])} for i, call in enumerate(tool_calls_of(turn))]
        stop = turn.get("finish") or ("tool_use" if turn.get("toolCalls") else "end_turn")
        message = {"id": f"msg_{n}", "type": "message", "role": "assistant", "model": body.get("model"), "content": content, "stop_reason": stop, "stop_sequence": None, "usage": {"input_tokens": usage["input"], "output_tokens": usage["output"], "cache_read_input_tokens": usage["cachedInput"], "cache_creation_input_tokens": 0}}
        if not body.get("stream"):
            return httpx.Response(200, json=message)
        events = [{"event": "message_start", "data": {"type": "message_start", "message": {**message, "content": [], "stop_reason": None, "usage": {**message["usage"], "output_tokens": 1}}}}]
        for index, block in enumerate(content):
            events.append({"event": "content_block_start", "data": {"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""} if block["type"] == "text" else {**block, "input": {}}}})
            if block["type"] == "text":
                events += [{"event": "content_block_delta", "data": {"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": piece}}} for piece in pieces(block["text"])]
            else:
                events.append({"event": "content_block_delta", "data": {"type": "content_block_delta", "index": index, "delta": {"type": "input_json_delta", "partial_json": "{}"}}})
            events.append({"event": "content_block_stop", "data": {"type": "content_block_stop", "index": index}})
        events.append({"event": "message_delta", "data": {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": usage["output"]}}})
        events.append({"event": "message_stop", "data": {"type": "message_stop"}})
        return _sse(events, False)

    return Recorder(turns, clock, answer, lambda body: [] if body.get("system") is None else [text_of(body["system"])], ("temperature", "top_p", "top_k", "max_tokens", "stop_sequences"))
