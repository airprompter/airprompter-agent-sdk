"""Managed mode (T23) in Python: the catalogue read, then runs over a
recorded SSE response. The subject never appears on the wire (the request
body is asserted byte for byte); ``subject_hash`` is the salted client-mode
hash; ``run()`` assembles the done frame; ``stream()`` yields the deltas in
order; refusals are typed with their status; a 429 is retried once per
Retry-After and then surfaced; an error frame after the head raises from
``result``; a workflow step carries its stepId; SSE parsing survives any
chunk boundary.
"""

from __future__ import annotations

import hashlib
import json

import httpx
import pytest

from airprompter_agent._util import b64url_decode, b64url_encode
from airprompter_agent.managed import ManagedAgent, ManagedRunError, SseFrame, parse_sse
from airprompter_agent.protocol.assignment import subject_hash

SALT = b64url_encode(b"0123456789abcdef0123456789abcdef")

# Recorded from a dev run on 2026-09-12 (contract 0.2.5 + the next tag's fields).
CATALOGUE = {
    "agentId": "agent-1",
    "target": "prod",
    "generation": 3,
    "releaseDigest": "sha256:" + "a" * 64,
    "slots": [
        {"tag": "support.triage", "kind": "prompt", "model": "anthropic.claude-sonnet-5", "variables": [{"name": "team", "required": True, "trust": "operator"}, {"name": "ticket", "required": True, "trust": "end_user"}], "steps": None},
        {"tag": "onboarding.flow", "kind": "workflow", "model": "anthropic.claude-haiku-4-5", "variables": [{"name": "name", "required": True, "trust": "operator"}], "steps": [{"stepId": "welcome#1"}, {"stepId": "verify#2"}]},
    ],
    "experiment": {"salt": SALT, "subjectKey": "request", "arms": ["control", "warmer"]},
}
DONE = {
    "runId": "run_0f3a",
    "runRef": "YWdlbnQtMcK3cHJvZMK3c3VwcG9ydC50cmlhZ2XCt3Jldi01wrdub25lwrczwrctwrdydW5fMGYzYQ" + "ABCDEFGHIJKLMNOPQRSTUV",
    "output": "Priority: P2. The customer was charged twice; refund and apologise.",
    "model": "anthropic.claude-sonnet-5",
    "versionId": "rev-5",
    "arm": "warmer",
    "generation": 3,
    "usage": {"inputTokens": 412, "cachedInputTokens": 256, "outputTokens": 37},
    "latencyMs": 812,
    "priceMicros": 3200,
    "priceBookRevision": "apb-2026-09-11",
    "stopReason": "end_turn",
    "source": "executed",
}


def sse(frames):
    return "".join(f"event: {event}\ndata: {json.dumps(data)}\n\n" for event, data in frames)


RUN_SSE = sse([("delta", {"delta": "Priority: P2. "}), ("delta", {"delta": "The customer was charged twice; refund and apologise."}), ("done", DONE)])


def chunked(text: str, size: int = 7):
    data = text.encode("utf-8")
    for offset in range(0, len(data), size):
        yield data[offset : offset + size]


def scripted(script):
    """A transport that answers each request from the next step; records every request."""
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if not script:
            raise AssertionError(f"unexpected call {request.method} {request.url}")
        reply = script.pop(0)
        if reply.get("stream"):
            return httpx.Response(reply["status"], headers=reply.get("headers", {}), stream=httpx.ByteStream(b"".join(chunked(reply["body"]))))
        return httpx.Response(reply["status"], headers=reply.get("headers", {}), content=(reply.get("body") or "").encode("utf-8"))

    return httpx.MockTransport(handler), calls


CATALOGUE_REPLY = {"status": 200, "headers": {"x-agent-generation": "3"}, "body": json.dumps(CATALOGUE)}


def start_with(script):
    transport, calls = scripted([CATALOGUE_REPLY, *script])
    agent = ManagedAgent.start(agent_id="agent-1", target="prod", api_key="apr_run_key", base_url="https://run.example/", transport=transport, sleep=lambda _s: None)
    return agent, calls


def test_start_reads_catalogue_and_run_sends_salted_hash_never_subject():
    agent, calls = start_with([{"status": 200, "body": RUN_SSE, "stream": True}])
    assert str(calls[0].url) == "https://run.example/v1/agents/agent-1/targets/prod/slots"
    assert calls[0].headers["authorization"] == "Bearer apr_run_key"
    assert [s["tag"] for s in agent.slots["slots"]] == ["support.triage", "onboarding.flow"]
    result = agent.run("support.triage", {"team": "Billing", "ticket": "charged twice"}, subject="user-42", metadata={"trace": "t-1"})
    assert result.raw == DONE and result.run_id == "run_0f3a" and result.usage["cachedInputTokens"] == 256 and result.output.startswith("Priority")
    run = calls[1]
    assert str(run.url) == "https://run.example/v1/agents/agent-1/targets/prod/run" and run.method == "POST" and run.headers["accept"] == "text/event-stream"
    expected = subject_hash(SALT, "user-42")
    assert expected == hashlib.sha256(b64url_decode(SALT) + b"user-42").hexdigest(), "the client-mode formula"
    assert json.loads(run.content) == {"tag": "support.triage", "variables": {"team": "Billing", "ticket": "charged twice"}, "stream": True, "subjectHash": expected, "metadata": {"trace": "t-1"}}
    assert b"user-42" not in run.content, "the subject never leaves the process"
    agent.close()


def test_stream_yields_deltas_and_error_frame_raises_from_result():
    agent, _calls = start_with([{"status": 200, "body": RUN_SSE, "stream": True}, {"status": 200, "body": sse([("delta", {"delta": "Prio"}), ("error", {"error": "the model is unavailable right now; retry", "code": "model_unavailable", "retryAfterSeconds": 5})]), "stream": True}])
    stream = agent.stream("support.triage", {"team": "Billing", "ticket": "x"})
    assert list(stream) == ["Priority: P2. ", "The customer was charged twice; refund and apologise."]
    assert stream.result.run_id == "run_0f3a"
    failing = agent.stream("support.triage", {"team": "Billing", "ticket": "x"})
    assert list(failing) == ["Prio"]
    with pytest.raises(ManagedRunError) as refused:
        failing.result
    assert refused.value.code == "model_unavailable" and refused.value.retry_after_seconds == 5
    agent.close()


def test_refusals_typed_and_429_retried_then_surfaced():
    agent, calls = start_with(
        [
            {"status": 402, "body": json.dumps({"error": "allowance exhausted", "code": "allowance_exhausted"})},
            {"status": 429, "headers": {"retry-after": "2"}, "body": json.dumps({"error": "organization runs per minute reached", "code": "rate_limited", "retryAfterSeconds": 2})},
            {"status": 200, "body": RUN_SSE, "stream": True},
            {"status": 429, "body": json.dumps({"error": "x", "code": "agent_rate_limited", "retryAfterSeconds": 1})},
            {"status": 429, "body": json.dumps({"error": "x", "code": "agent_rate_limited", "retryAfterSeconds": 1})},
            {"status": 429, "body": json.dumps({"error": "x", "code": "agent_rate_limited", "retryAfterSeconds": 1})},
            {"status": 400, "body": json.dumps({"error": "render support.triage: missing required variable ticket", "code": "render_missing_variable", "detail": "ticket"})},
        ]
    )
    with pytest.raises(ManagedRunError) as exhausted:
        agent.run("support.triage", {"team": "Billing", "ticket": "x"})
    assert exhausted.value.code == "allowance_exhausted" and exhausted.value.status == 402
    assert agent.run("support.triage", {"team": "Billing", "ticket": "x"}).run_id == "run_0f3a", "one 429 then success"
    with pytest.raises(ManagedRunError) as limited:
        agent.run("support.triage", {"team": "Billing", "ticket": "x"})
    assert limited.value.code == "agent_rate_limited" and limited.value.status == 429, "two retries, then the refusal"
    with pytest.raises(ManagedRunError) as missing:
        agent.run("support.triage", {"team": "Billing"})
    assert missing.value.code == "render_missing_variable" and missing.value.detail == "ticket"
    assert len(calls) == 1 + 1 + 2 + 3 + 1, "no retry on anything but 429"
    agent.close()


def test_workflow_step_and_unhosted_target():
    agent, calls = start_with([{"status": 200, "body": RUN_SSE, "stream": True}])
    flow = agent.workflow("onboarding.flow", subject="user-42")
    assert [s["stepId"] for s in flow.steps] == ["welcome#1", "verify#2"]
    flow.step("welcome#1", {"name": "Ada"})
    body = json.loads(calls[1].content)
    assert body["tag"] == "onboarding.flow" and body["stepId"] == "welcome#1" and isinstance(body["subjectHash"], str)
    agent.close()
    transport, _ = scripted([{"status": 403, "body": json.dumps({"error": "this environment runs on your systems; hosted runs are not enabled for it", "code": "target_not_hosted", "detail": "dev"})}])
    with pytest.raises(ManagedRunError) as unhosted:
        ManagedAgent.start(agent_id="agent-1", target="dev", api_key="k", base_url="https://run.example", transport=transport)
    assert unhosted.value.code == "target_not_hosted" and unhosted.value.status == 403


def test_sse_parsing_survives_chunk_boundaries():
    text = 'event: delta\ndata: {"delta":"a\\nb"}\n\nevent: done\ndata: {"x":1}\n\n'
    for size in (1, 3, 5, 64):
        frames = list(parse_sse(text[i : i + size] for i in range(0, len(text), size)))
        assert frames == [SseFrame("delta", '{"delta":"a\\nb"}'), SseFrame("done", '{"x":1}')], f"chunk {size}"
