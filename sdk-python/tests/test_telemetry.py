"""T11 ``observe()`` in Python: usage read off OpenAI, Anthropic and Bedrock
shapes as dicts AND as SDK-style objects (attributes), the OpenAI cached
split, truncation and filtering as error classes, raised failures
classified by class name, code and status (never by carrying the message),
the result returned unchanged and the error re-raised; the coroutine
variant; and the provider wrappers (OpenAI, Anthropic, LiteLLM callback)
against fake clients — no provider library installed.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import shutil
import tempfile
import types

import pytest

from airprompter_agent.agent import AirPrompterAgent, SyncOptions
from airprompter_agent.integrations.anthropic import messages_create, messages_create_async
from airprompter_agent.integrations.litellm import AirPrompterLiteLLMCallback, litellm_metadata
from airprompter_agent.integrations.openai import chat_completion, chat_completion_async, responses_create
from airprompter_agent.protocol.trust import public_jwk_of
from airprompter_agent.telemetry.observe import ObserveTarget, UsageNormalized, classify_error, classify_result, normalize_usage, observe_call, observe_call_async

from .control_plane import FakeControlPlane

TARGET = ObserveTarget("support.triage", "ver_1", "none", "gpt-5")


def obj(**fields):
    return types.SimpleNamespace(**fields)


def test_usage_shapes_dicts_and_objects():
    assert normalize_usage({"usage": {"prompt_tokens": 500, "completion_tokens": 90, "prompt_tokens_details": {"cached_tokens": 300}}}) == UsageNormalized(200, 300, 90, "reported")
    assert normalize_usage({"usage": {"prompt_tokens": 500, "completion_tokens": 90}}) == UsageNormalized(500, 0, 90, "reported")
    assert normalize_usage({"usage": {"input_tokens": 400, "output_tokens": 70, "cache_read_input_tokens": 100}}) == UsageNormalized(400, 100, 70, "reported")
    assert normalize_usage({"usage": {"inputTokens": 380, "outputTokens": 60, "cacheReadInputTokens": 20}}) == UsageNormalized(380, 20, 60, "reported")
    assert normalize_usage({"response": {"usage": {"input_tokens": 1, "output_tokens": 2}}}) == UsageNormalized(1, 0, 2, "reported")
    assert normalize_usage({"text": "hello"}) == UsageNormalized(0, 0, 0, "unavailable")
    assert normalize_usage(None) == UsageNormalized(0, 0, 0, "unavailable")
    assert normalize_usage({"usage": {"prompt_tokens": -4, "completion_tokens": "x"}}) == UsageNormalized(0, 0, 0, "unavailable"), "nonsense is unavailable, never negative"
    # SDK objects: openai.ChatCompletion / anthropic.Message expose usage as attributes.
    completion = obj(usage=obj(prompt_tokens=500, completion_tokens=90, prompt_tokens_details=obj(cached_tokens=300)), choices=[obj(finish_reason="stop", message=obj(content="secret"))])
    assert normalize_usage(completion) == UsageNormalized(200, 300, 90, "reported")
    message = obj(usage=obj(input_tokens=400, output_tokens=70, cache_read_input_tokens=100, cache_creation_input_tokens=0), stop_reason="max_tokens")
    assert normalize_usage(message) == UsageNormalized(400, 100, 70, "reported")
    assert classify_result(message) == "truncated"


def test_classify_result_across_providers():
    assert classify_result({"choices": [{"finish_reason": "length"}]}) == "truncated"
    assert classify_result({"stop_reason": "max_tokens"}) == "truncated"
    assert classify_result({"stopReason": "max_tokens"}) == "truncated"
    assert classify_result({"choices": [{"finish_reason": "content_filter"}]}) == "content_filter"
    assert classify_result({"stopReason": "guardrail_intervened"}) == "content_filter"
    assert classify_result({"choices": [{"finish_reason": "stop"}]}) is None
    assert classify_result({"stop_reason": "end_turn"}) is None
    assert classify_result("text") is None


class _Named(Exception):
    def __init__(self, message: str, **attrs):
        super().__init__(message)
        for name, value in attrs.items():
            setattr(self, name, value)


def test_classify_error_by_class_code_status():
    assert classify_error(_Named("Request timed out", code="ETIMEDOUT")) == "provider_timeout"
    assert classify_error(type("APITimeoutError", (Exception,), {})("x")) == "provider_timeout"
    assert classify_error(TimeoutError("slow")) == "provider_timeout"
    assert classify_error({"status": 504}) == "provider_timeout"
    assert classify_error({"status": 429}) == "provider_rate_limited"
    assert classify_error(type("RateLimitError", (Exception,), {})("Rate limit reached: the secret prompt")) == "provider_rate_limited"
    assert classify_error(_Named("Too many requests", status_code=429)) == "provider_rate_limited"
    assert classify_error({"error": {"type": "rate_limit_error"}}) == "provider_rate_limited"
    assert classify_error(_Named("Too many requests", name="ThrottlingException")) == "provider_rate_limited"
    assert classify_error({"code": "context_length_exceeded"}) == "context_length_exceeded"
    assert classify_error(RuntimeError("prompt is too long: 210000 tokens > 200000 maximum")) == "context_length_exceeded"
    assert classify_error({"code": "content_policy_violation"}) == "content_filter"
    assert classify_error(type("MissingVariableError", (Exception,), {})("missing team")) == "render_missing_variable"
    assert classify_error(RuntimeError("something odd")) == "provider_error"
    assert classify_error(None) == "provider_error"


def test_observe_call_times_returns_unchanged_reraises_and_is_content_free():
    clock = {"ms": 1000}
    observations = []

    def call():
        clock["ms"] += 812
        return {"choices": [{"message": {"content": "the secret answer"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 400, "completion_tokens": 90, "prompt_tokens_details": {"cached_tokens": 100}}}

    result = observe_call(TARGET, call, observations.append, now=lambda: clock["ms"], checks={"passed": 1})
    assert result["choices"][0]["message"]["content"] == "the secret answer", "returned unchanged"
    o = observations[0]
    assert (o.tag, o.version_id, o.arm, o.model, o.status, o.error_class, o.latency_ms, o.tokens, o.usage_source, o.checks) == ("support.triage", "ver_1", "none", "gpt-5", "ok", None, 812, {"input": 300, "cachedInput": 100, "output": 90}, "reported", {"passed": 1})
    assert "secret" not in repr(o)

    def failing():
        clock["ms"] += 30_000
        raise _Named("Rate limit reached for gpt-5: the secret prompt", status=429)

    with pytest.raises(_Named, match="Rate limit reached"):
        observe_call(TARGET, failing, observations.append, now=lambda: clock["ms"], model="gpt-5-mini")
    e = observations[1]
    assert (e.model, e.status, e.error_class, e.latency_ms, e.usage_source, e.tokens) == ("gpt-5-mini", "error", "provider_rate_limited", 30_000, "unavailable", None)
    truncated = observe_call(TARGET, lambda: {"stop_reason": "max_tokens", "usage": {"input_tokens": 10, "output_tokens": 4096}}, observations.append, now=lambda: clock["ms"])
    assert truncated["stop_reason"] == "max_tokens"
    assert observations[2].status == "error" and observations[2].error_class == "truncated" and observations[2].tokens["output"] == 4096


def test_observe_call_async():
    observations = []

    async def call():
        await asyncio.sleep(0)
        return {"usage": {"input_tokens": 3, "output_tokens": 4}, "stop_reason": "end_turn"}

    result = asyncio.run(observe_call_async(TARGET, call, observations.append))
    assert result["usage"]["output_tokens"] == 4
    assert observations[0].status == "ok" and observations[0].tokens == {"input": 3, "cachedInput": 0, "output": 4}

    async def failing():
        raise TimeoutError("slow")

    with pytest.raises(TimeoutError):
        asyncio.run(observe_call_async(TARGET, failing, observations.append))
    assert observations[1].error_class == "provider_timeout"


# ----------------------------------------------------------------------------- wrappers against fake clients


class FakeOpenAI:
    def __init__(self):
        self.calls = []
        self.chat = obj(completions=obj(create=self._create))
        self.responses = obj(create=self._responses)

    def _create(self, **kwargs):
        self.calls.append(("chat", kwargs))
        return obj(choices=[obj(finish_reason="stop", message=obj(content="hi"))], usage=obj(prompt_tokens=50, completion_tokens=5, prompt_tokens_details=obj(cached_tokens=20)))

    def _responses(self, **kwargs):
        self.calls.append(("responses", kwargs))
        return obj(output_text="hi", usage=obj(input_tokens=30, output_tokens=6, input_tokens_details=obj(cached_tokens=0)), status="completed")


class FakeAsyncOpenAI(FakeOpenAI):
    async def _create(self, **kwargs):  # type: ignore[override]
        return FakeOpenAI._create(self, **kwargs)


class FakeAnthropic:
    def __init__(self, stop_reason="end_turn"):
        self.calls = []
        self.stop_reason = stop_reason
        self.messages = obj(create=self._create)

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        return obj(content=[obj(type="text", text="hi")], stop_reason=self.stop_reason, usage=obj(input_tokens=40, output_tokens=7, cache_read_input_tokens=10))


class FakeAsyncAnthropic(FakeAnthropic):
    async def _create(self, **kwargs):  # type: ignore[override]
        return FakeAnthropic._create(self, **kwargs)


@pytest.fixture
def agent():
    state_dir = tempfile.mkdtemp(prefix="ap-integrations-")
    plane = FakeControlPlane({"organizationId": "org_1", "agentId": "agt_1", "target": "prod"})
    plane.promote([plane.slot(tag="support.triage", text="Triage for {{team}}: {{ticket}}", variables=[{"name": "team", "required": True, "trust": "operator"}, {"name": "ticket", "required": True, "trust": "end_user"}], model="gpt-5"), plane.slot(tag="support.reply", text="Reply.", model="claude-sonnet-5")])
    ap = AirPrompterAgent.start(
        organization_id="org_1", agent_id="agt_1", target="prod", api_key=plane.api_key, base_url="https://api.test", state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, sync=SyncOptions(mode="on_invoke", root_url="https://edge.test/roots/prod/root.json"), transport=plane.transport(), telemetry={"sink": "memory"}
    )
    yield ap
    ap.stop()
    shutil.rmtree(state_dir, ignore_errors=True)


def _windows(ap):
    ap.spool.close_windows(ap._now_ms())
    return [r for r in ap.drain_memory_sink() if r["type"] == "window"]


def test_openai_wrappers(agent):
    rendered = agent.prompt("support.triage").render(team="Billing", ticket="refund")
    client = FakeOpenAI()
    completion = chat_completion(agent, rendered, client, messages=[{"role": "user", "content": "refund"}], temperature=0)
    assert completion.choices[0].message.content == "hi"
    kind, kwargs = client.calls[0]
    assert kind == "chat" and kwargs["model"] == "gpt-5" and kwargs["temperature"] == 0
    assert kwargs["messages"][0] == {"role": "system", "content": "Triage for Billing: <ticket>refund</ticket>"}
    responses_create(agent, rendered, client, input="refund", model="gpt-5-mini")
    assert client.calls[1][1]["instructions"].startswith("Triage for Billing") and client.calls[1][1]["model"] == "gpt-5-mini"
    async_client = FakeAsyncOpenAI()
    asyncio.run(chat_completion_async(agent, rendered, async_client, messages=[], system_from_rendered=False))
    assert async_client.calls[0][1]["messages"] == []
    windows = _windows(agent)
    by_model = {w["model"]: w for w in windows}
    assert by_model["gpt-5"]["count"] == 2 and by_model["gpt-5"]["tokens"] == {"input": 60, "cachedInput": 40, "output": 10}
    assert by_model["gpt-5-mini"]["count"] == 1 and by_model["gpt-5-mini"]["tokens"]["input"] == 30
    assert "Billing" not in str(windows) and "refund" not in str(windows)


def test_anthropic_wrappers(agent):
    rendered = agent.prompt("support.reply").render()
    client = FakeAnthropic()
    message = messages_create(agent, rendered, client, messages=[{"role": "user", "content": "hello"}], max_tokens=64)
    assert message.content[0].text == "hi"
    assert client.calls[0]["system"] == "Reply." and client.calls[0]["model"] == "claude-sonnet-5" and client.calls[0]["max_tokens"] == 64
    truncating = FakeAnthropic(stop_reason="max_tokens")
    messages_create(agent, rendered, truncating, messages=[{"role": "user", "content": "hello"}])
    asyncio.run(messages_create_async(agent, rendered, FakeAsyncAnthropic(), messages=[{"role": "user", "content": "hello"}]))
    windows = _windows(agent)
    ok = next(w for w in windows if w["status"] == "ok")
    truncated = next(w for w in windows if w["errorClass"] == "truncated")
    assert ok["count"] == 2 and ok["tokens"] == {"input": 80, "cachedInput": 20, "output": 14}
    assert truncated["count"] == 1 and truncated["model"] == "claude-sonnet-5"


def test_litellm_callback(agent):
    rendered = agent.prompt("support.triage").render(team="Billing", ticket="refund")
    callback = AirPrompterLiteLLMCallback(agent)
    metadata = litellm_metadata(rendered)
    assert set(metadata["airprompter"]) == {"tag", "versionId", "arm", "model", "runRef"}
    assert "Billing" not in str(metadata)
    start = dt.datetime(2026, 9, 12, 14, 3, 10)
    end = start + dt.timedelta(milliseconds=812)
    response = obj(choices=[obj(finish_reason="stop")], usage=obj(prompt_tokens=100, completion_tokens=20))
    callback.log_success_event({"model": "gpt-5", "litellm_params": {"metadata": metadata}}, response, start, end)
    callback.log_failure_event({"model": "gpt-5", "litellm_params": {"metadata": metadata}, "exception": type("RateLimitError", (Exception,), {})("429")}, None, start, end)
    callback.log_success_event({"model": "gpt-5", "litellm_params": {"metadata": {"other": 1}}}, response, start, end)  # no attribution: ignored
    asyncio.run(callback.async_log_success_event({"model": "gpt-5", "metadata": metadata}, response, start, end))
    windows = _windows(agent)
    ok = next(w for w in windows if w["status"] == "ok")
    failed = next(w for w in windows if w["status"] == "error")
    assert ok["count"] == 2 and ok["tokens"] == {"input": 200, "output": 40} and ok["latencyMs"]["sum"] == 1624
    assert failed["errorClass"] == "provider_rate_limited" and failed["count"] == 1
