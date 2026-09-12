"""T33: ``ap.wrap()`` against the REAL ``openai`` and ``anthropic`` packages with recorded responses served through
each client's own ``http_client`` option (an ``httpx.MockTransport`` — the public extension point), so nothing here
reaches the network. The packages are not dependencies of this SDK: the suite skips when they are absent and runs in
the weekly ``wrap-latest`` workflow, which installs their latest releases (``WRAP_LIVE=1`` turns a skip into a
failure there).

    pip install openai anthropic && WRAP_LIVE=1 python -m pytest tests/test_wrap_live.py
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
import threading

import pytest

try:  # the provider SDKs moved to httpx2 in 2026; both accept it, and the SDK itself still runs on httpx
    import httpx2 as httpx  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    import httpx

from .control_plane import FakeControlPlane
from .test_agent import SCOPE, start

REQUIRED = os.environ.get("WRAP_LIVE") == "1"


def load(name: str):
    if REQUIRED:
        return __import__(name)
    return pytest.importorskip(name)


@pytest.fixture
def state_dir():
    path = tempfile.mkdtemp(prefix="ap-wrap-live-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


def start_agent(state_dir: str):
    plane = FakeControlPlane(SCOPE)
    triage = plane.slot(tag="support.triage", text="Triage this ticket.", model="gpt-5")
    plane.promote([
        {**triage, "outputChecks": [{"kind": "must_match", "name": "signed", "pattern": "Regards"}]},
        plane.slot(tag="support.reply", text="Reply politely.", model="claude-haiku-4-5"),
    ])
    ap = start(plane, state_dir, telemetry={"sink": "memory"})

    def windows():
        ap.stop()
        return sorted((r for r in ap.drain_memory_sink() if r["type"] == "window"), key=lambda r: (r["status"], r.get("errorClass") or ""))

    return ap, windows


def sse(events: list[dict], done: bool = False) -> httpx.Response:
    body = "".join((f"event: {e['event']}\n" if e.get("event") else "") + f"data: {json.dumps(e['data'])}\n\n" for e in events) + ("data: [DONE]\n\n" if done else "")
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body.encode("utf-8"))


def recorded(routes):
    seen: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        seen.append((request.url.path, body))
        route = routes.get(request.url.path)
        if route is None:
            return httpx.Response(404, json={"error": {"message": f"no recording for {request.url.path}"}})
        return route(body)

    return handler, seen


OPENAI_USAGE = {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 16, "prompt_tokens_details": {"cached_tokens": 2}}


def openai_routes():
    chunk = lambda delta, finish=None: {"id": "chatcmpl_s", "object": "chat.completion.chunk", "created": 1, "model": "gpt-5", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}  # noqa: E731
    return {
        "/v1/chat/completions": lambda body: (
            # A `stream=True` call (it passes stream_options) is cut off; the `.stream()` helper's recording finishes cleanly —
            # the real helper's get_final_completion() raises on a length finish, which is the SDK's own rule.
            sse([{"data": chunk({"role": "assistant", "content": "Regards, "})}, {"data": chunk({"content": "us"})}, {"data": chunk({}, "length" if body.get("stream_options") else "stop")}, {"data": {"id": "chatcmpl_s", "object": "chat.completion.chunk", "created": 1, "model": "gpt-5", "choices": [], "usage": OPENAI_USAGE}}], done=True)
            if body.get("stream")
            else httpx.Response(200, json={"id": "chatcmpl_p", "object": "chat.completion", "created": 1, "model": "gpt-5", "choices": [{"index": 0, "message": {"role": "assistant", "content": "Regards, us"}, "finish_reason": "stop"}], "usage": OPENAI_USAGE})
        ),
        "/v1/responses": lambda body: httpx.Response(
            200,
            json={
                "id": "resp_1",
                "object": "response",
                "created_at": 1,
                "status": "completed",
                "model": "gpt-5",
                "output": [{"type": "message", "id": "msg_1", "status": "completed", "role": "assistant", "content": [{"type": "output_text", "text": "No signature", "annotations": []}]}],
                "usage": {"input_tokens": 9, "output_tokens": 3, "total_tokens": 12, "input_tokens_details": {"cached_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 0}},
            },
        ),
    }


def test_openai_sync_client(state_dir):
    openai = load("openai")
    handler, seen = recorded(openai_routes())
    ap, windows = start_agent(state_dir)
    client = ap.wrap(openai.OpenAI(api_key="sk-test", http_client=httpx.Client(transport=httpx.MockTransport(handler))))
    triage = ap.prompt("support.triage").render()
    messages = [{"role": "system", "content": triage.text}, {"role": "user", "content": "hello"}]
    plain = client.chat.completions.create(model="gpt-5", messages=messages)
    assert plain.choices[0].message.content == "Regards, us"
    raw = client.chat.completions.with_raw_response.create(model="gpt-5", messages=messages)
    assert raw.parse().choices[0].message.content == "Regards, us", "with_raw_response is the client's own (not observed)"
    streamed = ""
    with client.chat.completions.create(model="gpt-5", messages=messages, stream=True, stream_options={"include_usage": True}) as stream:
        for chunk in stream:
            streamed += (chunk.choices[0].delta.content or "") if chunk.choices else ""
    assert streamed == "Regards, us"
    with client.chat.completions.stream(model="gpt-5", messages=messages) as helper:
        final = helper.get_final_completion()
    assert final.choices[0].message.content == "Regards, us"
    responses = client.responses.create(model="gpt-5", instructions=triage.text, input="hello")
    assert responses.output_text == "No signature"
    assert len(seen) == 5
    rows = windows()
    assert [(r["tag"], r["model"], r["status"], r.get("errorClass"), r["count"], r["tokens"], r.get("checks")) for r in rows] == [
        ("support.triage", "gpt-5", "error", "truncated", 1, {"input": 10, "cachedInput": 2, "output": 4}, {"passed": 1, "failed": 0}),
        ("support.triage", "gpt-5", "ok", None, 3, {"input": 29, "cachedInput": 4, "output": 11}, {"passed": 2, "failed": 1}),
    ]


def test_openai_async_client(state_dir):
    openai = load("openai")
    handler, seen = recorded(openai_routes())
    ap, windows = start_agent(state_dir)
    client = ap.wrap(openai.AsyncOpenAI(api_key="sk-test", http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler))))
    triage = ap.prompt("support.triage").render()
    messages = [{"role": "system", "content": triage.text}, {"role": "user", "content": "hello"}]

    async def run():
        plain = await client.chat.completions.create(model="gpt-5", messages=messages)
        assert plain.choices[0].message.content == "Regards, us"
        streamed = ""
        async with await client.chat.completions.create(model="gpt-5", messages=messages, stream=True, stream_options={"include_usage": True}) as stream:
            async for chunk in stream:
                streamed += (chunk.choices[0].delta.content or "") if chunk.choices else ""
        assert streamed == "Regards, us"
        async with client.chat.completions.stream(model="gpt-5", messages=messages) as helper:
            final = await helper.get_final_completion()
        assert final.choices[0].message.content == "Regards, us"

    asyncio.run(run())
    assert len(seen) == 3
    rows = windows()
    assert [(r["status"], r.get("errorClass"), r["count"], r["tokens"]) for r in rows] == [
        ("error", "truncated", 1, {"input": 10, "cachedInput": 2, "output": 4}),
        ("ok", None, 2, {"input": 20, "cachedInput": 4, "output": 8}),
    ]


ANTHROPIC_MESSAGE = {"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-haiku-4-5", "content": [{"type": "text", "text": "Hello there"}], "stop_reason": "end_turn", "stop_sequence": None, "usage": {"input_tokens": 7, "output_tokens": 2, "cache_read_input_tokens": 3, "cache_creation_input_tokens": 0}}
ANTHROPIC_EVENTS = [
    {"event": "message_start", "data": {"type": "message_start", "message": {**ANTHROPIC_MESSAGE, "content": [], "stop_reason": None, "usage": {"input_tokens": 7, "output_tokens": 1, "cache_read_input_tokens": 3, "cache_creation_input_tokens": 0}}}},
    {"event": "content_block_start", "data": {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}},
    {"event": "content_block_delta", "data": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello "}}},
    {"event": "content_block_delta", "data": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "there"}}},
    {"event": "content_block_stop", "data": {"type": "content_block_stop", "index": 0}},
    {"event": "message_delta", "data": {"type": "message_delta", "delta": {"stop_reason": "max_tokens", "stop_sequence": None}, "usage": {"output_tokens": 2}}},
    {"event": "message_stop", "data": {"type": "message_stop"}},
]


def anthropic_routes():
    return {"/v1/messages": lambda body: sse(ANTHROPIC_EVENTS) if body.get("stream") else httpx.Response(200, json=ANTHROPIC_MESSAGE)}


def test_anthropic_sync_and_async_clients(state_dir):
    anthropic = load("anthropic")
    handler, seen = recorded(anthropic_routes())
    ap, windows = start_agent(state_dir)
    reply = ap.prompt("support.reply").render()
    client = ap.wrap(anthropic.Anthropic(api_key="sk-ant-test", http_client=httpx.Client(transport=httpx.MockTransport(handler))))
    plain = client.messages.create(model="claude-haiku-4-5", max_tokens=64, system=reply.text, messages=[{"role": "user", "content": "hi"}])
    assert plain.content[0].text == "Hello there"
    streamed = ""
    for event in client.messages.create(model="claude-haiku-4-5", max_tokens=64, system=reply.text, messages=[{"role": "user", "content": "hi"}], stream=True):
        if event.type == "content_block_delta" and event.delta.type == "text_delta":
            streamed += event.delta.text
    assert streamed == "Hello there"
    with client.messages.stream(model="claude-haiku-4-5", max_tokens=64, system=[{"type": "text", "text": reply.text}], messages=[{"role": "user", "content": "hi"}]) as helper:
        text = "".join(helper.text_stream)
    assert text == "Hello there"

    aclient = ap.wrap(anthropic.AsyncAnthropic(api_key="sk-ant-test", http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler))))

    async def run():
        message = await aclient.messages.create(model="claude-haiku-4-5", max_tokens=64, system=reply.text, messages=[{"role": "user", "content": "hi"}])
        assert message.content[0].text == "Hello there"
        async with aclient.messages.stream(model="claude-haiku-4-5", max_tokens=64, system=reply.text, messages=[{"role": "user", "content": "hi"}]) as helper:
            final = await helper.get_final_message()
        assert final.content[0].text == "Hello there"

    asyncio.run(run())
    assert len(seen) == 5
    rows = windows()
    assert [(r["tag"], r["model"], r["status"], r.get("errorClass"), r["count"], r["tokens"]) for r in rows] == [
        ("support.reply", "claude-haiku-4-5", "error", "truncated", 3, {"input": 21, "cachedInput": 9, "output": 6}),
        ("support.reply", "claude-haiku-4-5", "ok", None, 2, {"input": 14, "cachedInput": 6, "output": 4}),
    ]


def test_litellm_callback_over_a_mock_response(state_dir):
    litellm = load("litellm")
    from airprompter_agent.integrations.litellm import AirPrompterLiteLLMCallback, litellm_metadata

    ap, windows = start_agent(state_dir)
    triage = ap.prompt("support.triage").render()
    seen = threading.Semaphore(0)

    class Callback(AirPrompterLiteLLMCallback):
        def _observe(self, *args, **kwargs):
            try:
                super()._observe(*args, **kwargs)
            finally:
                seen.release()

    callback = Callback(ap)
    assert isinstance(callback, litellm.integrations.custom_logger.CustomLogger), "the extension point"
    for hook in ("log_success_event", "log_failure_event", "async_log_success_event", "async_log_failure_event"):
        assert callable(getattr(litellm.integrations.custom_logger.CustomLogger, hook)), hook
    litellm.callbacks = [callback]
    try:
        completion = litellm.completion(model="gpt-4o-mini", messages=[{"role": "system", "content": triage.text}, {"role": "user", "content": "hello"}], mock_response="Regards, mock")
        assert completion.choices[0].message.content == "Regards, mock"
        # The same, attributed by metadata rather than text.
        litellm.completion(model="gpt-4o-mini", messages=[{"role": "user", "content": "hello"}], mock_response="No signature", metadata=litellm_metadata(triage))
        for _ in range(2):
            assert seen.acquire(timeout=10), "the success hook fired"
    finally:
        litellm.callbacks = []
    rows = windows()
    assert len(rows) == 1 and rows[0]["tag"] == "support.triage" and rows[0]["count"] == 2 and rows[0]["model"] == "gpt-4o-mini"
