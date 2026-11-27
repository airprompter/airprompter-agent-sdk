"""LiteLLM as an adapter. LiteLLM has no client object: it is module functions and a callback list, so the adapter is
a callback, and the call site puts the release's model and settings on the call itself.

::

    import litellm
    from airprompter_agent.frameworks.litellm import AirPrompterLiteLLMCallback, litellm_metadata, litellm_params

    litellm.callbacks = [AirPrompterLiteLLMCallback(ap)]
    with ap.run(subject=user_id) as run:
        placed = run.place("support.reply")
        if placed.kind == "approved":
            litellm.completion(messages=[{"role": "system", "content": placed.instructions}, *messages], metadata=litellm_metadata((run, "support.reply")), **litellm_params(placed))

The callback attributes a call only from ``metadata["airprompter"]``, which carries the slot's ``tag`` and a signed
``runRef``. The reference is the authority: the entry whose tag matches is read, and a reference that does not verify
is dropped. Nothing is matched by text. Inside a run (``ap.current_run()`` in the logger) the call is recorded into it;
with none, it is filed as a one-call row through ``ap.report``.

LiteLLM runs its sync logger on a worker thread. For a sync ``completion`` it copies the caller's context there, so the
run is seen; for a sync ``stream=True`` call it does not (litellm 1.111), so such a call inside ``ap.run`` is filed as its
own one-call row. Async calls and async streams log on the caller's loop and are recorded into the run.

The class derives from ``litellm.integrations.custom_logger.CustomLogger`` when LiteLLM is installed and from ``object``
otherwise, so it imports (and tests) without the library.
"""

from __future__ import annotations

import datetime as dt
from typing import Any, Mapping, Optional, Protocol, Sequence, Union

from .contract import ADAPTER_EVENTS, AgentRuntime, Approved, Placement, RunSession, apply_settings, classify_error, classify_result, normalize_usage, output_text_of

try:  # pragma: no cover - exercised only when litellm is installed
    from litellm.integrations.custom_logger import CustomLogger as _Base  # type: ignore[import-not-found]
except Exception:  # noqa: BLE001

    class _Base:  # type: ignore[no-redef]
        pass


METADATA_KEY = "airprompter"


class LiteLLMRuntime(AgentRuntime, Protocol):
    """What the callback needs from the agent: the run, a reference read back, and a one-call row."""

    def explain(self, run_ref: str) -> Optional[Sequence[Mapping[str, Any]]]: ...

    def report(self, observation: Any = None, /, **kwargs: Any) -> None: ...


def litellm_metadata(target: Union[Any, tuple[RunSession, str]], *, model: Optional[str] = None) -> dict[str, Any]:
    """The ``metadata=`` for ``litellm.completion``: ``(run, slot)``, a rendered prompt or a workflow step. Content-free:
    the tag, the signed run reference, and the model when given. Read ``run.run_ref`` here, at the call: it grows."""
    if isinstance(target, tuple):
        run, slot = target
        fields: dict[str, Any] = {"tag": slot, "runRef": run.run_ref}
    else:
        step = getattr(target, "step_id", None)
        fields = {"tag": step.split("#")[0], "step": step, "runRef": target.run_ref} if step else {"tag": target.tag, "runRef": target.run_ref}
    if model:
        fields["model"] = model
    return {METADATA_KEY: fields}


def litellm_params(placement: Placement) -> dict[str, Any]:
    """The release's model and sealed settings as ``litellm.completion`` keyword arguments (OpenAI chat names); ``{}``
    for a passthrough, so the call site's own model and settings run."""
    if not isinstance(placement, Approved):
        return {}
    return apply_settings("chat", {"model": placement.model}, placement.settings).params


def _metadata(kwargs: Mapping[str, Any]) -> Optional[Mapping[str, Any]]:
    params = kwargs.get("litellm_params") or {}
    metadata = params.get("metadata") if isinstance(params, Mapping) else None
    if not isinstance(metadata, Mapping):
        metadata = kwargs.get("metadata")
    fields = metadata.get(METADATA_KEY) if isinstance(metadata, Mapping) else None
    return fields if isinstance(fields, Mapping) and isinstance(fields.get("tag"), str) and isinstance(fields.get("runRef"), str) else None


def _latency_ms(start_time: Any, end_time: Any) -> float:
    if isinstance(start_time, dt.datetime) and isinstance(end_time, dt.datetime):
        return max(0.0, (end_time - start_time).total_seconds() * 1000)
    if isinstance(start_time, (int, float)) and isinstance(end_time, (int, float)):
        return max(0.0, (end_time - start_time) * 1000)
    return 0.0


class AirPrompterLiteLLMCallback(_Base):
    def __init__(self, ap: LiteLLMRuntime):
        super().__init__()
        self._ap = ap

    def _observe(self, kwargs: Mapping[str, Any], response_obj: Any, start_time: Any, end_time: Any, error: Any) -> None:
        try:
            self._record(kwargs, response_obj, start_time, end_time, error)
        except Exception as failure:  # noqa: BLE001 — a callback never fails the customer's call
            self._ap.log({"event": ADAPTER_EVENTS["tap_failed"], "adapter": "litellm", "reason": str(failure)})

    def _record(self, kwargs: Mapping[str, Any], response_obj: Any, start_time: Any, end_time: Any, error: Any) -> None:
        fields = _metadata(kwargs)
        if fields is None:
            return
        # The signed reference is the only authority: unsigned metadata could forge a version, an artifact or an audience.
        entries = self._ap.explain(fields["runRef"])
        entry = next((e for e in entries or () if e.get("tag") == fields["tag"]), None)
        if entry is None:
            return
        slot = str(entry["tag"])
        model = str(entry.get("model") or kwargs.get("model") or "unknown")
        step = fields.get("step") if isinstance(fields.get("step"), str) else None
        latency = _latency_ms(start_time, end_time)
        usage = normalize_usage(response_obj) if error is None else None
        error_class = classify_error(error) if error is not None else classify_result(response_obj)
        run = self._ap.current_run()
        if run is not None:
            run.record_model_call(slot, model=model, latency_ms=latency, step=step, usage=usage, error_class=error_class, output_text=output_text_of(response_obj) if error is None else None)
            return
        cohort = {"artifact_id": entry.get("artifactId"), "audience_ids": tuple(entry["audienceIds"]) if entry.get("audienceIds") is not None else None, "run_minute": entry.get("runMinute"), "step": step}
        if usage is None:
            self._ap.report(tag=slot, version_id=str(entry["versionId"]), arm=str(entry.get("arm", "none")), model=model, status="error", error_class=error_class, latency_ms=latency, usage_source="unavailable", **cohort)
            return
        self._ap.report(
            tag=slot,
            version_id=str(entry["versionId"]),
            arm=str(entry.get("arm", "none")),
            model=model,
            status="error" if error_class else "ok",
            error_class=error_class,
            latency_ms=latency,
            tokens={"input": usage.input, "cachedInput": usage.cached_input, "output": usage.output},
            usage_source=usage.source,
            **cohort,
        )

    # LiteLLM's CustomLogger hooks (sync and async).
    def log_success_event(self, kwargs: Mapping[str, Any], response_obj: Any, start_time: Any, end_time: Any) -> None:
        self._observe(kwargs, response_obj, start_time, end_time, None)

    def log_failure_event(self, kwargs: Mapping[str, Any], response_obj: Any, start_time: Any, end_time: Any) -> None:
        self._observe(kwargs, response_obj, start_time, end_time, kwargs.get("exception") or response_obj or RuntimeError("litellm failure"))

    async def async_log_success_event(self, kwargs: Mapping[str, Any], response_obj: Any, start_time: Any, end_time: Any) -> None:
        self._observe(kwargs, response_obj, start_time, end_time, None)

    async def async_log_failure_event(self, kwargs: Mapping[str, Any], response_obj: Any, start_time: Any, end_time: Any) -> None:
        self._observe(kwargs, response_obj, start_time, end_time, kwargs.get("exception") or response_obj or RuntimeError("litellm failure"))


__all__ = ["METADATA_KEY", "AirPrompterLiteLLMCallback", "LiteLLMRuntime", "litellm_metadata", "litellm_params"]
