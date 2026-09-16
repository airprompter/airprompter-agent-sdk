"""T33 (AIR-1963, D65): ``ap.wrap()`` over clients shaped like the ``openai`` and ``anthropic`` SDKs (recorded
responses, ``stream=True`` streams, the ``.stream()`` context-manager helpers, sync and async), attribution by
rendered text and by ``with ap.attribute()``, the declared checks running on what the wrapper saw, error classes,
the LiteLLM callback attributing by text, and the rule that nothing the wrapper does can fail the customer's call."""

from __future__ import annotations

import asyncio
import shutil
import tempfile
from types import SimpleNamespace
from typing import Any

import pytest

from airprompter_agent.integrations.litellm import AirPrompterLiteLLMCallback
from airprompter_agent_runtime.attribution import RenderRegistry, request_texts
from airprompter_agent_runtime.observe import ObserveTarget, PendingObservation
from airprompter_agent_runtime.wrap import WrapHooks, wrap_client

from .control_plane import FakeControlPlane
from .test_agent import SCOPE, start


@pytest.fixture
def state_dir():
    path = tempfile.mkdtemp(prefix="ap-wrap-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


def start_agent(state_dir: str, events: list | None = None):
    plane = FakeControlPlane(SCOPE)
    triage = plane.slot(tag="support.triage", text="Triage for {{team}}.", variables=[{"name": "team", "required": True, "trust": "operator"}], model="gpt-5")
    plane.promote([
        {**triage, "outputChecks": [{"kind": "must_not_match", "name": "no-guarantee", "pattern": "refund guaranteed", "flags": "i"}]},
        plane.slot(tag="support.reply", text="Reply politely.", model="claude-haiku-4-5"),
    ])
    extra: dict[str, Any] = {"telemetry": {"sink": "memory"}}
    if events is not None:
        extra["logger"] = events.append
    ap = start(plane, state_dir, **extra)

    def windows():
        ap.stop()
        return [r for r in ap.drain_memory_sink() if r["type"] == "window"]

    return ap, windows


# --- clients shaped like the real ones ---------------------------------------------------------------------------

USAGE = {"prompt_tokens": 120, "completion_tokens": 30, "prompt_tokens_details": {"cached_tokens": 20}}


def ns(value: Any) -> Any:
    """Dicts into attribute objects, the way the SDKs hand back pydantic models."""
    if isinstance(value, dict):
        return SimpleNamespace(**{k: ns(v) for k, v in value.items()})
    if isinstance(value, list):
        return [ns(v) for v in value]
    return value


def chat_completion(content: str, finish: str = "stop") -> Any:
    return ns({"id": "chatcmpl_1", "choices": [{"index": 0, "finish_reason": finish, "message": {"role": "assistant", "content": content}}], "usage": USAGE})


def chat_chunks(content: str, finish: str = "stop") -> list:
    words = content.split(" ")
    return ns(
        [{"id": "c", "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}]}]
        + [{"id": "c", "choices": [{"index": 0, "delta": {"content": (" " if i else "") + w}, "finish_reason": None}]} for i, w in enumerate(words)]
        + [{"id": "c", "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]}, {"id": "c", "choices": [], "usage": USAGE}]
    )


class FakeStream:
    """An ``openai.Stream`` / ``anthropic.Stream``: an iterator with ``response`` and a context manager."""

    def __init__(self, chunks: list):
        self._chunks = iter(chunks)
        self.response = SimpleNamespace(status_code=200)
        self.closed = False

    def __iter__(self):
        return self

    def __next__(self):
        return next(self._chunks)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def close(self):
        self.closed = True


class FakeAsyncStream:
    def __init__(self, chunks: list):
        self._chunks = iter(chunks)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self._chunks)
        except StopIteration:
            raise StopAsyncIteration from None


class FakeChatStreamManager:
    """``client.chat.completions.stream(...)``: a context manager whose stream keeps a ``current_completion_snapshot``."""

    def __init__(self, content: str):
        self._content = content

    def __enter__(self):
        chunks = chat_chunks(self._content)
        stream = FakeStream(chunks)
        stream.current_completion_snapshot = None  # type: ignore[attr-defined]

        def get_final_completion():
            for _ in stream:
                pass
            return chat_completion(self._content, "length")

        stream.get_final_completion = get_final_completion  # type: ignore[attr-defined]
        return stream

    def __exit__(self, *exc):
        return None


class FakeOpenAI:
    """Private state reached only through the real receiver, a nested resource tree, and unrelated members."""

    def __init__(self):
        self.__calls = 0
        self.calls: list = []
        self.fail: Any = None
        self.timeout = 30
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._chat_create, stream=self._chat_stream))
        self.responses = SimpleNamespace(create=self._responses_create)
        self.models = SimpleNamespace(list=lambda: ["gpt-5"])

    def count(self) -> int:
        return self.__calls

    def _chat_create(self, **params):
        self.__calls += 1
        self.calls.append(params)
        if self.fail is not None:
            raise self.fail
        content = f"answer {self.__calls} refund guaranteed"
        if params.get("stream"):
            return FakeStream(chat_chunks("streamed " + content, "length"))
        return chat_completion(content)

    def _chat_stream(self, **params):
        self.calls.append(params)
        return FakeChatStreamManager("helper answer")

    def _responses_create(self, **params):
        self.calls.append(params)
        response = {
            "id": "resp_1",
            "status": "incomplete",
            "incomplete_details": {"reason": "max_output_tokens"},
            "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "responses answer"}]}],
            "usage": {"input_tokens": 50, "output_tokens": 10, "input_tokens_details": {"cached_tokens": 5}},
        }
        if params.get("stream"):
            return FakeStream(ns([
                {"type": "response.created", "response": {"id": "resp_1"}},
                {"type": "response.output_text.delta", "delta": "responses "},
                {"type": "response.output_text.delta", "delta": "answer"},
                {"type": "response.incomplete", "response": response},
            ]))
        return ns({**response, "output_text": "responses answer"})


def anthropic_message(text: str, stop: str = "end_turn") -> Any:
    return ns({"id": "msg_1", "type": "message", "role": "assistant", "content": [{"type": "text", "text": text}], "stop_reason": stop, "usage": {"input_tokens": 40, "output_tokens": 12, "cache_read_input_tokens": 8}})


def anthropic_events(text: str, stop: str = "end_turn") -> list:
    words = text.split(" ")
    return ns(
        [{"type": "message_start", "message": {"id": "msg_2", "role": "assistant", "content": [], "usage": {"input_tokens": 40, "output_tokens": 1, "cache_read_input_tokens": 8}}}, {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}]
        + [{"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": (" " if i else "") + w}} for i, w in enumerate(words)]
        + [{"type": "content_block_stop", "index": 0}, {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": 12}}, {"type": "message_stop"}]
    )


class FakeMessageStreamManager:
    """``client.messages.stream(...)``: the stream has ``text_stream``, ``get_final_message`` and a snapshot."""

    def __init__(self, text: str, stop: str = "end_turn"):
        self._text, self._stop = text, stop

    def __enter__(self):
        stream = FakeStream(anthropic_events(self._text, self._stop))
        stream.current_message_snapshot = anthropic_message(self._text, self._stop)  # type: ignore[attr-defined]
        stream.get_final_message = lambda: anthropic_message(self._text, self._stop)  # type: ignore[attr-defined]
        stream.text_stream = iter(self._text.split(" "))  # type: ignore[attr-defined]
        return stream

    def __exit__(self, *exc):
        return None


class FakeAnthropic:
    def __init__(self):
        self.calls: list = []
        self.messages = SimpleNamespace(create=self._create, stream=self._stream)

    def _create(self, **params):
        self.calls.append(params)
        if params.get("stream"):
            return FakeStream(anthropic_events("streamed reply", "max_tokens"))
        return anthropic_message("plain reply")

    def _stream(self, **params):
        self.calls.append(params)
        return FakeMessageStreamManager("helper reply", "max_tokens")


class FakeAsyncAnthropic:
    def __init__(self):
        self.messages = SimpleNamespace(create=self._create, stream=self._stream)

    async def _create(self, **params):
        await asyncio.sleep(0)
        if params.get("stream"):
            return FakeAsyncStream(anthropic_events("async streamed", "max_tokens"))
        return anthropic_message("async plain")

    def _stream(self, **params):
        manager = FakeMessageStreamManager("async helper")

        class AsyncManager:
            async def __aenter__(self):
                return manager.__enter__()

            async def __aexit__(self, *exc):
                return None

        return AsyncManager()


def by_key(rows):
    return sorted(rows, key=lambda r: (r["tag"], r["model"], r["status"], r.get("errorClass") or ""))


# ---------------------------------------------------------------------------------------------------------------------


def test_openai_chat_attributed_by_rendered_text_and_returned_unchanged(state_dir):
    events: list = []
    ap, windows = start_agent(state_dir, events)
    client = FakeOpenAI()
    openai = ap.wrap(client)
    assert isinstance(openai, FakeOpenAI)
    assert ap.wrap(openai) is openai, "wrapping twice is once"
    assert openai.timeout == 30 and openai.models.list() == ["gpt-5"], "unrelated members are the client's own"
    rendered = ap.prompt("support.triage").render(team="Billing")
    completion = openai.chat.completions.create(model="gpt-5-mini", messages=[{"role": "system", "content": rendered.text}, {"role": "user", "content": "hi"}])
    assert completion.choices[0].message.content == "answer 1 refund guaranteed"
    openai.chat.completions.create(model="gpt-5-mini", messages=[{"role": "system", "content": [{"type": "text", "text": rendered.text}]}])
    assert client.count() == 2, "the private field saw both calls through the real receiver"
    rows = windows()
    assert len(rows) == 1
    row = rows[0]
    assert (row["tag"], row["model"], row["count"]) == ("support.triage", "gpt-5-mini", 2)
    assert row["tokens"] == {"input": 200, "cachedInput": 40, "output": 60}
    assert row["checks"] == {"passed": 0, "failed": 2}, "the must-not-match check ran on the answer the wrapper saw"
    assert not any(e.get("event") == "wrap_unattributed" for e in events)
    assert "guaranteed" not in str(rows), "no output text on the wire"


def test_openai_stream_true_and_helpers_and_responses(state_dir):
    ap, windows = start_agent(state_dir)
    openai = ap.wrap(FakeOpenAI())
    triage = ap.prompt("support.triage").render(team="Billing")
    stream = openai.chat.completions.create(model="gpt-5", stream=True, messages=[{"role": "system", "content": triage.text}])
    assert stream.response.status_code == 200, "the stream's own members are reachable"
    text = ""
    with stream as chunks:
        for chunk in chunks:
            text += chunk.choices[0].delta.content if chunk.choices and getattr(chunk.choices[0].delta, "content", None) else ""
    assert text == "streamed answer 1 refund guaranteed"
    with openai.chat.completions.stream(model="gpt-5", messages=[{"role": "system", "content": triage.text}]) as helper:
        final = helper.get_final_completion()
    assert final.choices[0].message.content == "helper answer"
    responses = openai.responses.create(model="gpt-5", instructions=triage.text, input="hi")
    assert responses.output_text == "responses answer"
    seen = 0
    for _ in openai.responses.create(model="gpt-5", stream=True, instructions=triage.text, input=[{"role": "user", "content": [{"type": "input_text", "text": "hi"}]}]):
        seen += 1
    assert seen == 4
    rows = by_key(windows())
    assert [(r["status"], r.get("errorClass"), r["count"], r["tokens"], r.get("checks")) for r in rows] == [
        ("error", "truncated", 4, {"input": 290, "cachedInput": 50, "output": 80}, {"passed": 3, "failed": 1}),
    ]


def test_anthropic_plain_stream_and_helper_sync_and_async(state_dir):
    ap, windows = start_agent(state_dir)
    anthropic = ap.wrap(FakeAnthropic())
    reply = ap.prompt("support.reply").render()
    plain = anthropic.messages.create(model="claude-haiku-4-5", max_tokens=100, system=[{"type": "text", "text": reply.text}], messages=[{"role": "user", "content": "hi"}])
    assert plain.content[0].text == "plain reply"
    types = [event.type for event in anthropic.messages.create(model="claude-haiku-4-5", max_tokens=100, stream=True, system=reply.text, messages=[{"role": "user", "content": "hi"}])]
    assert types[0] == "message_start" and types[-1] == "message_stop"
    with anthropic.messages.stream(model="claude-haiku-4-5", max_tokens=100, system=reply.text, messages=[{"role": "user", "content": "hi"}]) as helper:
        text = " ".join(helper.text_stream)
    assert text == "helper reply"

    async_client = ap.wrap(FakeAsyncAnthropic())

    async def run_async():
        message = await async_client.messages.create(model="claude-haiku-4-5", max_tokens=100, system=reply.text, messages=[])
        assert message.content[0].text == "async plain"
        seen = 0
        async for _ in await async_client.messages.create(model="claude-haiku-4-5", max_tokens=100, stream=True, system=reply.text, messages=[]):
            seen += 1
        assert seen == 7
        async with async_client.messages.stream(model="claude-haiku-4-5", max_tokens=100, system=reply.text, messages=[]) as helper:
            final = helper.get_final_message()
        assert final.content[0].text == "async helper"

    asyncio.run(run_async())
    rows = by_key(windows())
    assert [(r["status"], r.get("errorClass"), r["count"], r["tokens"]) for r in rows] == [
        ("error", "truncated", 3, {"input": 120, "cachedInput": 24, "output": 36}),
        ("ok", None, 3, {"input": 120, "cachedInput": 24, "output": 36}),
    ]


def test_unattributed_passes_through_and_attribute_scopes(state_dir):
    events: list = []
    ap, windows = start_agent(state_dir, events)
    client = FakeOpenAI()
    openai = ap.wrap(client)
    triage = ap.prompt("support.triage").render(team="Billing")
    reply = ap.prompt("support.reply").render()
    openai.chat.completions.create(model="gpt-5", messages=[{"role": "user", "content": "no prompt of ours here"}])
    assert [e["event"] for e in events if e["event"].startswith("wrap_")] == ["wrap_unattributed"]
    assert len(client.calls) == 1
    with ap.attribute(reply):
        openai.chat.completions.create(model="gpt-5", messages=[{"role": "user", "content": reply.text + "\n\nToday is Friday."}])
        # Even a message that IS a triage render is the reply's inside the block.
        openai.chat.completions.create(model="gpt-5", messages=[{"role": "system", "content": triage.text}])
    rows = windows()
    assert len(rows) == 1 and rows[0]["tag"] == "support.reply" and rows[0]["count"] == 2


def test_failures_are_classified_and_re_raised(state_dir):
    ap, windows = start_agent(state_dir)
    client = FakeOpenAI()
    openai = ap.wrap(client)
    triage = ap.prompt("support.triage").render(team="Billing")

    class RateLimitError(Exception):
        status_code = 429

    client.fail = RateLimitError("rate limited")
    with pytest.raises(RateLimitError):
        openai.chat.completions.create(model="gpt-5", messages=[{"role": "system", "content": triage.text}])
    client.fail = None
    # A stream that breaks mid-way: the error is the call's, and the customer's exception.
    anthropic = wrap_client(SimpleNamespace(messages=SimpleNamespace(create=lambda **_: _Broken())), ap._wrap_hooks())
    with ap.attribute(triage):
        with pytest.raises(TimeoutError):
            for _ in anthropic.messages.create(model="claude-haiku-4-5", stream=True, messages=[]):
                pass
    rows = by_key(windows())
    assert [(r["status"], r["errorClass"], r["count"], r["usageSource"]) for r in rows] == [
        ("error", "provider_timeout", 1, "unavailable"),
        ("error", "provider_rate_limited", 1, "unavailable"),
    ]


class _Broken:
    def __init__(self):
        self._n = 0

    def __iter__(self):
        return self

    def __next__(self):
        self._n += 1
        if self._n == 1:
            return anthropic_events("x")[0]
        raise TimeoutError("read timed out")


def test_nothing_the_wrapper_does_fails_the_call():
    log: list = []
    recorded: list = []

    def broken_attribute(_params):
        raise RuntimeError("registry exploded")

    client = FakeOpenAI()
    broken = wrap_client(client, WrapHooks(attribute=broken_attribute, begin=lambda *_: None, log=log.append))
    assert broken.chat.completions.create(model="gpt-5", messages=[]).choices[0].message.content == "answer 1 refund guaranteed"
    assert [e["event"] for e in log] == ["wrap_attribution_failed", "wrap_unattributed"]

    target = ObserveTarget("t", "v", "none", "m")
    hooks = WrapHooks(attribute=lambda _p: SimpleNamespace(tag="t", version_id="v", arm="none", model="m"), begin=lambda a, model: PendingObservation(target, recorded.append, model=model), log=log.append)
    odd = wrap_client(SimpleNamespace(messages=SimpleNamespace(create=lambda **_: FakeStream([None, 42, ns({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "x"}}), "str"]))), hooks)
    chunks = list(odd.messages.create(model="m2"))
    assert chunks[0] is None and chunks[1] == 42 and chunks[2].type == "content_block_delta" and chunks[3] == "str"
    assert recorded[0].model == "m2" and recorded[0].status == "ok" and recorded[0].usage_source == "unavailable"
    # A consumer that stops after the first chunk: what was seen is reported when the stream is closed.
    recorded.clear()
    early = wrap_client(FakeOpenAI(), hooks)
    with early.chat.completions.create(model="gpt-5", stream=True, messages=[]) as stream:
        next(iter(stream))
    assert len(recorded) == 1 and recorded[0].usage_source == "unavailable" and recorded[0].status == "ok"


def test_litellm_callback_attributes_by_text_without_metadata(state_dir):
    ap, windows = start_agent(state_dir)
    triage = ap.prompt("support.triage").render(team="Billing")
    callback = AirPrompterLiteLLMCallback(ap)
    response = {"choices": [{"message": {"content": "fine"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 2}}
    callback.log_success_event({"model": "gpt-5", "messages": [{"role": "system", "content": triage.text}]}, response, 0.0, 0.5)
    callback.log_success_event({"model": "gpt-5", "messages": [{"role": "user", "content": "unrelated"}]}, response, 0.0, 0.5)
    rows = windows()
    assert len(rows) == 1 and rows[0]["tag"] == "support.triage" and rows[0]["count"] == 1 and rows[0]["model"] == "gpt-5"


def test_request_texts_and_registry():
    params = {
        "system": [{"type": "text", "text": "S"}],
        "instructions": "I",
        "messages": [{"role": "user", "content": "M1"}, ns({"role": "assistant", "content": [{"type": "text", "text": "M2"}, {"type": "image_url", "image_url": {"url": "…"}}]})],
        "input": [{"role": "user", "content": [{"type": "input_text", "text": "R1"}]}],
        "prompt": [{"role": "system", "content": "P1"}],
        "model": "gpt-5",
        "temperature": 0.2,
    }
    assert request_texts(params) == ["S", "I", "M1", "M2", "R1", "P1"]
    assert request_texts(None) == []
    assert request_texts({"messages": "just a string"}) == ["just a string"]
    registry = RenderRegistry(3)
    for n in (1, 2, 3, 4):
        registry.register(f"text {n}", SimpleNamespace(tag=f"t{n}"))
    assert len(registry) == 3
    assert registry.match(["text 1"]) is None, "the oldest was evicted"
    assert registry.match(["nothing", "text 3"]).tag == "t3"
    registry.register("text 2", SimpleNamespace(tag="t2b"))
    assert registry.match(["text 2"]).tag == "t2b", "the newest render of the same text wins"


def test_inference_settings_ride_the_render_and_go_out_on_the_wrapped_call(state_dir):
    """0.3.1: the release's values, whatever the call site wrote; integers on the wire, floats to the provider."""
    events: list = []
    plane = FakeControlPlane(SCOPE)
    plane.promote([
        {**plane.slot(tag="support.reply", text="Reply politely.", model="gpt-5"), "inference": {"temperatureMilli": 200, "topPBps": 9000, "maxOutputTokens": 800, "stopSequences": ["\n\nHuman:"], "reasoningEffort": "low"}},
        plane.slot(tag="support.triage", text="Triage.", model="gpt-5"),
    ])
    ap = start(plane, state_dir, logger=events.append)
    rendered = ap.prompt("support.reply").render()
    assert rendered.inference == {"temperatureMilli": 200, "topPBps": 9000, "maxOutputTokens": 800, "stopSequences": ["\n\nHuman:"], "reasoningEffort": "low"}
    assert ap.prompt("support.triage").render().inference is None

    openai = FakeOpenAI()
    ap.wrap(openai).chat.completions.create(model="gpt-5", temperature=1, max_tokens=50, messages=[{"role": "system", "content": rendered.text}, {"role": "user", "content": "hi"}])
    chat = openai.calls[0]
    assert chat["temperature"] == 0.2 and chat["top_p"] == 0.9 and chat["max_completion_tokens"] == 800
    assert "max_tokens" not in chat
    assert chat["stop"] == ["\n\nHuman:"] and chat["reasoning_effort"] == "low"
    overridden = next(e for e in events if e.get("event") == "wrap_inference_overridden")
    assert overridden["parameters"] == ["temperature", "max_tokens"]

    anthropic = FakeAnthropic()
    ap.wrap(anthropic).messages.create(model="claude-haiku-4-5", max_tokens=100, system=rendered.text, messages=[{"role": "user", "content": "hi"}])
    message = anthropic.calls[0]
    assert message["temperature"] == 0.2 and message["top_p"] == 0.9 and message["max_tokens"] == 800
    assert message["stop_sequences"] == ["\n\nHuman:"] and "reasoning_effort" not in message
    assert next(e for e in events if e.get("event") == "wrap_inference_unsupported")["settings"] == ["reasoningEffort"]

    quiet = FakeOpenAI()
    before = len(events)
    ap.wrap(quiet).chat.completions.create(model="gpt-5", temperature=0.2, messages=[{"role": "system", "content": rendered.text}])
    assert not any(e.get("event") == "wrap_inference_overridden" for e in events[before:])
    ap.stop()
