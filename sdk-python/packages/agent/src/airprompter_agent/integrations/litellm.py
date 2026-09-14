"""A LiteLLM callback (T17, T33): every ``litellm.completion`` that carries
``metadata=litellm_metadata(rendered)`` — or whose messages carry a recent
render's text (the same rule as ``ap.wrap()``) — is reported against that
rendered prompt: latency from LiteLLM's own start/end times, usage off the
response, a failure classified into the closed set. A call that names no
render is ignored: the callback never guesses which slot a call was.

::

    import litellm
    litellm.callbacks = [AirPrompterLiteLLMCallback(ap)]
    litellm.completion(model="gpt-5", messages=[...], metadata=litellm_metadata(rendered))

The class derives from ``litellm.integrations.custom_logger.CustomLogger``
when LiteLLM is installed and from ``object`` otherwise, so it imports (and
tests) without the library.
"""

from __future__ import annotations

import datetime as dt
from typing import Any, Mapping, Optional

from ..agent import AirPrompterAgent, Rendered, WorkflowStep
from airprompter_agent_telemetry.spool.writer import Observation
from airprompter_agent_runtime.observe import classify_error, classify_result, normalize_usage

try:  # pragma: no cover - exercised only when litellm is installed
    from litellm.integrations.custom_logger import CustomLogger as _Base  # type: ignore[import-not-found]
except Exception:  # noqa: BLE001

    class _Base:  # type: ignore[no-redef]
        pass


METADATA_KEY = "airprompter"


def litellm_metadata(rendered: Rendered | WorkflowStep, *, model: Optional[str] = None) -> dict[str, Any]:
    """The ``metadata=`` to pass to ``litellm.completion`` so the callback can attribute the call. Content-free: ids and the model only."""
    if isinstance(rendered, WorkflowStep):
        return {METADATA_KEY: {"tag": rendered.step_id, "versionId": rendered.version_id, "arm": "none", "model": model or "unknown", "runRef": rendered.run_ref}}
    return {METADATA_KEY: {"tag": rendered.tag, "versionId": rendered.version_id, "arm": rendered.arm, "model": model or rendered.model, "runRef": rendered.run_ref}}


def _attribution(kwargs: Mapping[str, Any]) -> Optional[Mapping[str, Any]]:
    params = kwargs.get("litellm_params") or {}
    metadata = params.get("metadata") if isinstance(params, Mapping) else None
    if not isinstance(metadata, Mapping):
        metadata = kwargs.get("metadata")
    if not isinstance(metadata, Mapping):
        return None
    attribution = metadata.get(METADATA_KEY)
    return attribution if isinstance(attribution, Mapping) and "tag" in attribution and "versionId" in attribution else None


def _latency_ms(start_time: Any, end_time: Any) -> float:
    if isinstance(start_time, dt.datetime) and isinstance(end_time, dt.datetime):
        return max(0.0, (end_time - start_time).total_seconds() * 1000)
    if isinstance(start_time, (int, float)) and isinstance(end_time, (int, float)):
        return max(0.0, (end_time - start_time) * 1000)
    return 0.0


class AirPrompterLiteLLMCallback(_Base):
    def __init__(self, ap: AirPrompterAgent):
        super().__init__()
        self._ap = ap

    def _observe(self, kwargs: Mapping[str, Any], response_obj: Any, start_time: Any, end_time: Any, error: Any) -> None:
        attribution = _attribution(kwargs)
        if attribution is None:
            # T33: no metadata — the messages may still carry a render's text (or an `ap.attribute()` block is open).
            matched = self._ap.attribution_for({"messages": kwargs.get("messages")})
            if matched is None:
                return
            attribution = {"tag": matched.tag, "versionId": matched.version_id, "arm": matched.arm, "model": matched.model}
        model = str(kwargs.get("model") or attribution.get("model") or "unknown")
        latency = _latency_ms(start_time, end_time)
        if error is not None:
            observation = Observation(tag=str(attribution["tag"]), version_id=str(attribution["versionId"]), arm=str(attribution.get("arm", "none")), model=model, status="error", error_class=classify_error(error), latency_ms=latency, usage_source="unavailable")
        else:
            usage = normalize_usage(response_obj)
            error_class = classify_result(response_obj)
            observation = Observation(
                tag=str(attribution["tag"]),
                version_id=str(attribution["versionId"]),
                arm=str(attribution.get("arm", "none")),
                model=model,
                status="error" if error_class else "ok",
                error_class=error_class,
                latency_ms=latency,
                tokens={"input": usage.input, "cachedInput": usage.cached_input, "output": usage.output},
                usage_source=usage.source,
            )
        self._ap.report(observation)

    # LiteLLM's CustomLogger hooks (sync and async).
    def log_success_event(self, kwargs: Mapping[str, Any], response_obj: Any, start_time: Any, end_time: Any) -> None:
        self._observe(kwargs, response_obj, start_time, end_time, None)

    def log_failure_event(self, kwargs: Mapping[str, Any], response_obj: Any, start_time: Any, end_time: Any) -> None:
        self._observe(kwargs, response_obj, start_time, end_time, kwargs.get("exception") or response_obj or RuntimeError("litellm failure"))

    async def async_log_success_event(self, kwargs: Mapping[str, Any], response_obj: Any, start_time: Any, end_time: Any) -> None:
        self._observe(kwargs, response_obj, start_time, end_time, None)

    async def async_log_failure_event(self, kwargs: Mapping[str, Any], response_obj: Any, start_time: Any, end_time: Any) -> None:
        self._observe(kwargs, response_obj, start_time, end_time, kwargs.get("exception") or response_obj or RuntimeError("litellm failure"))
