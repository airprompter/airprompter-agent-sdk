"""T11 ``observe()`` in Python: usage read off OpenAI, Anthropic and Bedrock
shapes as dicts AND as SDK-style objects (attributes), the OpenAI cached
split, truncation and filtering as error classes, raised failures
classified by class name, code and status (never by carrying the message),
the result returned unchanged and the error re-raised; the coroutine
variant. The framework adapters' own tests are ``test_frameworks_*.py`` and ``test_litellm.py``.
"""

from __future__ import annotations

import asyncio
import types

import pytest

from airprompter_agent.runtime.observe import ObserveTarget, UsageNormalized, classify_error, classify_result, normalize_usage, observe_call, observe_call_async


TARGET = ObserveTarget("support.triage", "ver_1", "none", "gpt-5", "art_1")


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
