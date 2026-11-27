"""The framework adapters (``frameworks/openai``, ``frameworks/anthropic``, ``frameworks/litellm``) against the REAL
``openai``, ``anthropic`` and ``litellm`` packages, sync and async, with recorded responses served through each client's
own ``http_client`` option (an ``httpx.MockTransport`` — the public extension point) or LiteLLM's ``mock_response``, so
nothing here reaches the network. The packages are not dependencies of this SDK: the suite skips when they are absent and runs in
the weekly ``wrap-latest`` workflow, which installs their latest releases (``WRAP_LIVE=1`` turns a skip into a
failure there).

    pip install openai anthropic litellm && WRAP_LIVE=1 python -m pytest tests/test_frameworks_live.py
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

from airprompter_agent.frameworks.anthropic import instrument as instrument_anthropic
from airprompter_agent.frameworks.openai import instrument as instrument_openai

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
    triage = plane.slot(tag="support.triage", text="Triage this ticket.", model="gpt-5", variables=[])
    plane.promote([
        {**triage, "outputChecks": [{"kind": "must_match", "name": "signed", "pattern": "Regards"}]},
        plane.slot(tag="support.reply", text="Reply politely.", model="claude-haiku-4-5", variables=[]),
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
    client = instrument_openai(openai.OpenAI(api_key="sk-test", http_client=httpx.Client(transport=httpx.MockTransport(handler))), ap, slot="support.triage")
    assert isinstance(client, openai.OpenAI)
    messages = [{"role": "system", "content": "the caller's own prompt"}, {"role": "user", "content": "hello"}]
    plain = client.chat.completions.create(model="gpt-5", messages=messages)
    assert plain.choices[0].message.content == "Regards, us"
    raw = client.chat.completions.with_raw_response.create(model="gpt-5", messages=messages)
    assert raw.parse().choices[0].message.content == "Regards, us", "the raw response is the caller's to parse"
    streamed = ""
    with client.chat.completions.create(model="gpt-5", messages=messages, stream=True, stream_options={"include_usage": True}) as stream:
        for chunk in stream:
            streamed += (chunk.choices[0].delta.content or "") if chunk.choices else ""
    assert streamed == "Regards, us"
    with client.chat.completions.stream(model="gpt-5", messages=messages) as helper:
        final = helper.get_final_completion()
    assert final.choices[0].message.content == "Regards, us"
    responses = client.responses.create(model="gpt-5", instructions="mine", input="hello")
    assert responses.output_text == "No signature"
    assert len(seen) == 5
    assert seen[0][1]["messages"][0] == {"role": "system", "content": "Triage this ticket."}, "the approved text reached the wire"
    assert seen[1][1]["messages"][0] == {"role": "system", "content": "Triage this ticket."}, "with_raw_response is placed too"
    assert seen[3][1]["messages"][0] == {"role": "system", "content": "the caller's own prompt"}, "the .stream() helper passed through"
    assert seen[4][1]["instructions"] == "Triage this ticket."
    rows = windows()
    assert [(r["tag"], r["model"], r["status"], r.get("errorClass"), r["count"], r["tokens"], r.get("checks")) for r in rows] == [
        ("support.triage", "gpt-5", "error", "truncated", 1, {"input": 10, "cachedInput": 2, "output": 4}, {"passed": 1, "failed": 0}),
        ("support.triage", "gpt-5", "ok", None, 2, {"input": 19, "cachedInput": 2, "output": 7}, {"passed": 1, "failed": 1}),
        ("support.triage", "gpt-5", "ok", None, 1, {"input": 0, "output": 0}, None),
    ], "the raw response is measured for latency only (the row with no usage)"


def test_openai_async_client(state_dir):
    openai = load("openai")
    handler, seen = recorded(openai_routes())
    ap, windows = start_agent(state_dir)
    client = instrument_openai(openai.AsyncOpenAI(api_key="sk-test", http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler))), ap, slot="support.triage")
    messages = [{"role": "user", "content": "hello"}]

    async def run():
        async with ap.run(subject="u1"):
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
    assert seen[0][1]["messages"][0] == {"role": "system", "content": "Triage this ticket."}
    rows = windows()
    assert [(r["count"], r["modelCalls"], r["agentRun"], r["tokens"]) for r in rows] == [(1, 2, 1, {"input": 20, "cachedInput": 4, "output": 8})], "one run, two measured calls"


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
    client = instrument_anthropic(anthropic.Anthropic(api_key="sk-ant-test", http_client=httpx.Client(transport=httpx.MockTransport(handler))), ap, slot="support.reply")
    plain = client.messages.create(model="claude-haiku-4-5", max_tokens=64, system="mine", messages=[{"role": "user", "content": "hi"}])
    assert plain.content[0].text == "Hello there"
    streamed = ""
    for event in client.messages.create(model="claude-haiku-4-5", max_tokens=64, messages=[{"role": "user", "content": "hi"}], stream=True):
        if event.type == "content_block_delta" and event.delta.type == "text_delta":
            streamed += event.delta.text
    assert streamed == "Hello there"
    with client.messages.stream(model="claude-haiku-4-5", max_tokens=64, messages=[{"role": "user", "content": "hi"}]) as helper:
        text = "".join(helper.text_stream)
    assert text == "Hello there"

    aclient = instrument_anthropic(anthropic.AsyncAnthropic(api_key="sk-ant-test", http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler))), ap, slot="support.reply")

    async def run():
        message = await aclient.messages.create(model="claude-haiku-4-5", max_tokens=64, messages=[{"role": "user", "content": "hi"}])
        assert message.content[0].text == "Hello there"
        async with aclient.messages.stream(model="claude-haiku-4-5", max_tokens=64, messages=[{"role": "user", "content": "hi"}]) as helper:
            final = await helper.get_final_message()
        assert final.content[0].text == "Hello there"

    asyncio.run(run())
    assert len(seen) == 5
    assert [body.get("system") for _, body in seen] == ["Reply politely.", "Reply politely.", None, "Reply politely.", None], "the helpers passed through"
    rows = windows()
    assert [(r["tag"], r["model"], r["status"], r.get("errorClass"), r["count"], r["tokens"]) for r in rows] == [
        ("support.reply", "claude-haiku-4-5", "error", "truncated", 1, {"input": 7, "cachedInput": 3, "output": 2}),
        ("support.reply", "claude-haiku-4-5", "ok", None, 2, {"input": 14, "cachedInput": 6, "output": 4}),
    ]


def test_litellm_every_call_shape_inside_a_run_is_that_run_and_a_forged_or_stale_reference_attaches_to_nothing(state_dir):
    litellm = load("litellm")
    from airprompter_agent.frameworks.litellm import AirPrompterLiteLLMCallback, litellm_metadata, litellm_params

    ap, windows = start_agent(state_dir)
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

    def hooked(n: int = 1, timeout: float = 10.0) -> None:
        for _ in range(n):
            assert seen.acquire(timeout=timeout), "the logger hook fired"

    async def hooked_async(n: int = 1) -> None:
        for _ in range(n):
            for _ in range(200):
                if seen.acquire(blocking=False):
                    break
                await asyncio.sleep(0.05)
            else:
                raise AssertionError("the async logger hook fired")

    litellm.callbacks = [callback]
    try:
        # A call with no metadata is never guessed at.
        litellm.completion(model="gpt-4o-mini", messages=[{"role": "user", "content": "hello"}], mock_response="unrelated")
        hooked()
        # One run, four call shapes: sync, sync stream (logged on a worker thread without the caller's context), async, async stream.
        async def one_run() -> str:
            async with ap.run(subject="u1") as run:
                placed = run.place("support.triage")
                params = litellm_params(placed)
                assert params["model"] == "gpt-5"
                messages = [{"role": "system", "content": placed.instructions}, {"role": "user", "content": "hello"}]
                litellm.completion(messages=messages, mock_response="Regards, mock", metadata=litellm_metadata((run, "support.triage")), **params)
                hooked()
                for _ in litellm.completion(messages=messages, mock_response="No signature", stream=True, metadata=litellm_metadata((run, "support.triage")), **params):
                    pass
                hooked()
                await litellm.acompletion(messages=messages, mock_response="Regards, async", metadata=litellm_metadata((run, "support.triage")), **params)
                await hooked_async()
                stream = await litellm.acompletion(messages=messages, mock_response="Regards, async stream", stream=True, metadata=litellm_metadata((run, "support.triage")), **params)
                async for _ in stream:
                    pass
                await hooked_async()
                return run.run_ref

        ended_ref = asyncio.run(one_run())
        # As real code does: leave the run straight after the call. LiteLLM logs after the call returns, so the record may
        # land after the run ended: then it is dropped with one log, never counted as a second run.
        with ap.run(subject="u2") as run:
            placed = run.place("support.triage")
            litellm.completion(messages=[{"role": "user", "content": "quick"}], mock_response="Regards", metadata=litellm_metadata((run, "support.triage")), **litellm_params(placed))
        hooked()
        # The run has ended: a late call marked as its own revives nothing and is not a row.
        open_before = ap._runs.open_runs
        for _ in litellm.completion(model="gpt-5", messages=[{"role": "user", "content": "late"}], mock_response="Regards", stream=True, metadata={"airprompter": {"tag": "support.triage", "runRef": ended_ref, "run": True}}):
            pass
        hooked()
        assert ap._runs.open_runs == open_before, "the lookup opened nothing"
        # A forged reference attaches to nothing and files nothing.
        litellm.completion(model="gpt-5", messages=[{"role": "user", "content": "forged"}], mock_response="Regards", metadata={"airprompter": {"tag": "support.triage", "runRef": ended_ref[:-4] + "AAAA"}})
        hooked()
        assert ap._runs.open_runs == open_before
    finally:
        litellm.callbacks = []
    rows = windows()
    # Two runs, counted once each: the first with its four calls; the second with its one call if the logger beat the end
    # of the block, else none. The late call and the forged one are no row.
    assert {(r["tag"], r["model"]) for r in rows} == {("support.triage", "gpt-5")}, rows
    assert (sum(r["count"] for r in rows), sum(r["agentRun"] for r in rows)) == (2, 2), rows
    assert sum(r["modelCalls"] for r in rows) in (4, 5), rows
