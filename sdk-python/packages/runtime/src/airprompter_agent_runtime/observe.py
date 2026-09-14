"""``ap.observe(rendered, lambda: client.chat.completions.create(...))`` (T11,
D52/D66): time the model call, read ``usage`` off whatever the provider
answered — OpenAI, Anthropic Messages, Bedrock Converse / InvokeModel, as a
dict or as an SDK object — and classify a failure into the protocol's closed
``errorClass`` set. The observation is a content-free window increment: no
text, no ids, no error message.

Usage shapes recognised (all optional, first match wins per field)::

    OpenAI       usage.prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens
    Responses    usage.input_tokens / output_tokens / input_tokens_details.cached_tokens (cached inside input, as OpenAI)
    Anthropic    usage.input_tokens / output_tokens / cache_read_input_tokens
    Bedrock      usage.inputTokens / outputTokens / cacheReadInputTokens (Converse);
                 InvokeModel with an Anthropic body reads as Anthropic
    Truncation   choices[0].finish_reason == "length" | stop_reason == "max_tokens" | stopReason == "max_tokens"
                 | status == "incomplete" and incomplete_details.reason == "max_output_tokens" (Responses)
    Content filter choices[0].finish_reason == "content_filter" | stopReason == "content_filtered"
                 | status == "incomplete" and incomplete_details.reason == "content_filter" (Responses)

A result with no usage is reported as ``usageSource: "unavailable"`` with
zero tokens — the window still counts the run and its latency.
"""

from __future__ import annotations

import inspect
import math
import re
import threading
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Mapping, Optional, TypeVar, Union

from airprompter_agent_core._util import now_ms
from airprompter_agent_core.telemetry.rows import Observation

T = TypeVar("T")


@dataclass(frozen=True)
class UsageNormalized:
    input: int
    cached_input: int
    output: int
    source: str  # "reported" | "unavailable"


def _get(value: Any, name: str) -> Any:
    """A key on a mapping, else an attribute on an object (OpenAI / Anthropic SDK models); never raises."""
    if value is None:
        return None
    if isinstance(value, Mapping):
        return value.get(name)
    if isinstance(value, (str, bytes, int, float, bool)):
        return None
    try:
        return getattr(value, name, None)
    except Exception:  # noqa: BLE001
        return None


def _int(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return None
    return int(math.floor(value + 0.5))


def _first(value: Any) -> Any:
    if isinstance(value, (list, tuple)) and value:
        return value[0]
    return None


def normalize_usage(result: Any) -> UsageNormalized:
    """Provider token counts, or "unavailable". Never raises on an unexpected shape."""
    unavailable = UsageNormalized(0, 0, 0, "unavailable")
    usage = _get(result, "usage")
    if usage is None:
        usage = _get(_get(result, "response"), "usage")
    if usage is None:
        usage = _get(_get(result, "output"), "usage")
    if usage is None:
        return unavailable
    openai_cached = _int(_get(_get(usage, "prompt_tokens_details"), "cached_tokens"))
    if openai_cached is None:
        openai_cached = _int(_get(_get(usage, "input_tokens_details"), "cached_tokens"))
    input_tokens = next((v for v in (_int(_get(usage, "prompt_tokens")), _int(_get(usage, "input_tokens")), _int(_get(usage, "inputTokens"))) if v is not None), None)
    output_tokens = next((v for v in (_int(_get(usage, "completion_tokens")), _int(_get(usage, "output_tokens")), _int(_get(usage, "outputTokens"))) if v is not None), None)
    cached = openai_cached if openai_cached is not None else next((v for v in (_int(_get(usage, "cache_read_input_tokens")), _int(_get(usage, "cacheReadInputTokens"))) if v is not None), 0)
    if input_tokens is None and output_tokens is None:
        return unavailable
    # OpenAI counts cached tokens inside prompt_tokens; Anthropic and Bedrock count them beside input. Windows carry
    # input as the UNCACHED count plus cachedInput, so the OpenAI shape is split here.
    uncached = max(0, input_tokens - openai_cached) if openai_cached is not None and input_tokens is not None else (input_tokens or 0)
    return UsageNormalized(uncached, cached, output_tokens or 0, "reported")


def classify_result(result: Any) -> Optional[str]:
    """A completed call that still counts as an error class: truncation and content filtering."""
    if result is None or isinstance(result, (str, bytes, int, float, bool)):
        return None
    choice = _first(_get(result, "choices"))
    finish = _get(choice, "finish_reason") or _get(result, "stop_reason") or _get(result, "stopReason") or ""
    finish = str(finish)
    incomplete = str(_get(_get(result, "incomplete_details"), "reason") or "") if _get(result, "status") == "incomplete" else ""
    if finish in ("length", "max_tokens") or incomplete == "max_output_tokens":
        return "truncated"
    if finish in ("content_filter", "content_filtered", "guardrail_intervened") or incomplete == "content_filter":
        return "content_filter"
    return None


_TIMEOUT_CODES = {"ETIMEDOUT", "ECONNABORTED", "UND_ERR_HEADERS_TIMEOUT", "timeout"}
_TIMEOUT_NAMES = {"AbortError", "TimeoutError", "APITimeoutError", "ReadTimeout", "ConnectTimeout", "WriteTimeout", "PoolTimeout", "ReadTimeoutError", "socket.timeout", "timeout"}
_RATE_LIMIT_CODES = {"rate_limit_exceeded", "rate_limit_error", "ThrottlingException", "insufficient_quota"}
_RATE_LIMIT_NAMES = {"ThrottlingException", "RateLimitError"}
_CONTEXT = re.compile(r"context (length|window)|too many tokens|prompt is too long|input is too long|maximum context")
_FILTER = re.compile(r"content (filter|policy)|guardrail")
_TIMED_OUT = re.compile(r"timed? ?out")


def classify_error(error: Any) -> str:
    """A raised failure into the closed set; anything unrecognised is ``provider_error``. Reads codes and statuses, never messages' free text into the window."""
    if error is None:
        return "provider_error"
    name = type(error).__name__ if isinstance(error, BaseException) else str(_get(error, "name") or "")
    explicit_name = _get(error, "name")
    if isinstance(explicit_name, str) and explicit_name:
        name = explicit_name
    nested = _get(error, "error")
    code = str(_get(error, "code") or _get(error, "type") or _get(nested, "code") or _get(nested, "type") or "")
    status = next((v for v in (_int(_get(error, "status")), _int(_get(error, "status_code")), _int(_get(error, "statusCode")), _int(_get(_get(error, "$metadata"), "httpStatusCode")), _int(_get(_get(error, "response"), "status_code")), _int(_get(_get(error, "response"), "status"))) if v is not None), None)
    message = str(error if isinstance(error, BaseException) else (_get(error, "message") or "")).lower()
    if name in _TIMEOUT_NAMES or code in _TIMEOUT_CODES or status in (408, 504) or _TIMED_OUT.search(message):
        return "provider_timeout"
    if status == 429 or code in _RATE_LIMIT_CODES or name in _RATE_LIMIT_NAMES:
        return "provider_rate_limited"
    if code == "context_length_exceeded" or _CONTEXT.search(message):
        return "context_length_exceeded"
    if code in ("content_filter", "content_policy_violation") or _FILTER.search(message):
        return "content_filter"
    if name == "MissingVariableError" or code == "render_missing_variable":
        return "render_missing_variable"
    if code == "output_schema_invalid" or name == "OutputSchemaError":
        return "output_schema_invalid"
    return "provider_error"


@dataclass(frozen=True)
class ObserveTarget:
    tag: str
    version_id: str
    arm: str
    model: str


def _observation(target: ObserveTarget, model: str, started: float, now: Callable[[], float], result: Any, error: Any, checks: Optional[Mapping[str, int]], evaluate: Optional[Callable[[Any, "UsageNormalized"], Optional[Mapping[str, int]]]] = None) -> Observation:
    latency = max(0.0, now() - started)
    if error is not None:
        return Observation(tag=target.tag, version_id=target.version_id, arm=target.arm, model=model, status="error", error_class=classify_error(error), latency_ms=latency, usage_source="unavailable", checks=checks)
    usage = normalize_usage(result)
    error_class = classify_result(result)
    if checks is None and evaluate is not None:
        # T29: the slot's declared checks, on the host, before the observation is recorded; never into the request path.
        try:
            checks = evaluate(result, usage)
        except Exception:  # noqa: BLE001
            checks = None
    return Observation(
        tag=target.tag,
        version_id=target.version_id,
        arm=target.arm,
        model=model,
        status="error" if error_class else "ok",
        error_class=error_class,
        latency_ms=latency,
        tokens={"input": usage.input, "cachedInput": usage.cached_input, "output": usage.output},
        usage_source=usage.source,
        checks=checks,
    )


class PendingObservation:
    """T33: an observation whose clock started when a wrapped client was called and that settles later — when the
    response arrives, when a stream has gone by, or when a stream helper's context closes. Settles once; never raises."""

    def __init__(self, target: ObserveTarget, record: Callable[[Observation], None], *, model: Optional[str] = None, now: Optional[Callable[[], float]] = None, evaluate: Optional[Callable[[Any, "UsageNormalized"], Optional[Mapping[str, int]]]] = None):
        self._target = target
        self._record = record
        self._model = model or target.model
        self._now = now or now_ms
        self._evaluate = evaluate
        self._started = self._now()
        self._settled = False
        self._lock = threading.Lock()

    @property
    def settled(self) -> bool:
        return self._settled

    def settle(self, result: Any) -> None:
        """The provider-shaped result (usage, finish reason, output text) — or None when nothing could be read."""
        self._finish(result, None)

    def fail(self, error: BaseException) -> None:
        self._finish(None, error)

    def _finish(self, result: Any, error: Optional[BaseException]) -> None:
        with self._lock:
            if self._settled:
                return
            self._settled = True
        try:
            self._record(_observation(self._target, self._model, self._started, self._now, result, error, None, self._evaluate))
        except Exception:  # noqa: BLE001 — a wrapper never fails the customer's call
            pass


def observe_call(target: ObserveTarget, call: Callable[[], T], record: Callable[[Observation], None], *, checks: Optional[Mapping[str, int]] = None, model: Optional[str] = None, now: Optional[Callable[[], float]] = None, evaluate: Optional[Callable[[Any, "UsageNormalized"], Optional[Mapping[str, int]]]] = None) -> T:
    """Time ``call``, then hand one observation to ``record``. The result is returned unchanged; a raised error is
    re-raised after it is observed. Nothing about the result but its usage and finish reason is read."""
    clock = now or now_ms
    started = clock()
    named = model or target.model
    try:
        result = call()
    except BaseException as error:
        record(_observation(target, named, started, clock, None, error, checks))
        raise
    record(_observation(target, named, started, clock, result, None, checks, evaluate))
    return result


async def observe_call_async(target: ObserveTarget, call: Callable[[], Union[Awaitable[T], T]], record: Callable[[Observation], None], *, checks: Optional[Mapping[str, int]] = None, model: Optional[str] = None, now: Optional[Callable[[], float]] = None, evaluate: Optional[Callable[[Any, "UsageNormalized"], Optional[Mapping[str, int]]]] = None) -> T:
    """``observe_call`` for a coroutine (an ``AsyncOpenAI`` / ``AsyncAnthropic`` call)."""
    clock = now or now_ms
    started = clock()
    named = model or target.model
    try:
        result = call()
        if inspect.isawaitable(result):
            result = await result
    except BaseException as error:
        record(_observation(target, named, started, clock, None, error, checks))
        raise
    record(_observation(target, named, started, clock, result, None, checks, evaluate))
    return result  # type: ignore[return-value]
