"""LiteLLM as an adapter. The callback cannot measure a call made inside ``ap.run``: LiteLLM logs after the call returns,
usually after the run ended. Inside a run, measure the call where you make it with ``measure_call`` (below). LiteLLM has
no client object: it is module functions and a callback list, so the adapter is a callback for calls outside any run,
and the call site puts the release's model and settings on the call itself (``litellm_params``).

::

    import litellm
    from airprompter_agent.frameworks.litellm import AirPrompterLiteLLMCallback, litellm_metadata, litellm_params

    litellm.callbacks = [AirPrompterLiteLLMCallback(ap)]
    with ap.run(subject=user_id) as run:
        placed = run.place("support.reply")
        if placed.kind == "approved":
            messages = [{"role": "system", "content": placed.instructions}, *messages]
            # Inside a run, measure at the call: LiteLLM logs after the call returns, often after the run has ended.
            measure_call(run, "support.reply", lambda: litellm.completion(messages=messages, **litellm_params(placed)), model=placed.model)

The callback attributes a call only from ``metadata["airprompter"]``, which carries the slot's ``tag`` and a signed
``runRef``. The reference is the authority: the entry whose tag matches is read, and a reference that does not verify
is dropped. Nothing is matched by text, and a call sent under another model than the entry's is not counted.

LiteLLM 1.111 runs its logger after the call returns: a sync call on a thread pool, an async one on a logging worker,
and a sync ``stream=True`` call without the caller's context. So the callback finds the run by the reference, through a
lookup that never opens, extends or revives one:

- ``metadata=litellm_metadata((run, slot))`` marks the call as the run's. Live, it is recorded into the run; ended
  before the logger fired, it is dropped with one ``adapter_late_record`` log, never counted twice. LiteLLM's pre-call
  hook (``log_pre_api_call``, with the caller's context, before the request) opens the call on the run, so a run that
  ends before its log writes ``callsReported`` false: its row says the call was not measured, never that none was made.
  Measure in-run calls with ``measure_call`` (above) to keep every one.
- ``metadata=litellm_metadata(rendered)`` (or a workflow step), for a call outside any run: a one-call row through
  ``ap.report``. A live run the reference names takes it instead.

Use one of ``measure_call`` and run metadata for a call, not both.

The class derives from ``litellm.integrations.custom_logger.CustomLogger`` when LiteLLM is installed and from ``object``
otherwise, so it imports (and tests) without the library.
"""

from __future__ import annotations

import datetime as dt
import threading
from collections import OrderedDict
from typing import Any, Callable, Mapping, Optional, Protocol, Sequence, Union

from .contract import _find_run, _open_call
from .contract import ADAPTER_EVENTS, AgentRuntime, Approved, Placement, RunSession, apply_settings, classify_error, classify_result, normalize_usage, output_text_of

try:  # pragma: no cover - exercised only when litellm is installed
    from litellm.integrations.custom_logger import CustomLogger as _Base  # type: ignore[import-not-found]
except Exception:  # noqa: BLE001

    class _Base:  # type: ignore[no-redef]
        pass


METADATA_KEY = "airprompter"
#: Calls the pre-call hook opened, by ``litellm_call_id``. Past this many, ended runs' calls go first (LiteLLM never logs
#: some: a retry that raised, an abandoned stream); a live one goes only past this many in flight, and reads unmeasured.
OPEN_CALLS_MAX = 1024


class LiteLLMRuntime(AgentRuntime, Protocol):
    """What the callback needs from the agent: the run, a reference read back, and a one-call row."""

    def explain(self, run_ref: str) -> Optional[Sequence[Mapping[str, Any]]]: ...

    def report(self, observation: Any = None, /, **kwargs: Any) -> None: ...


def litellm_metadata(target: Union[Any, tuple[RunSession, str]], *, model: Optional[str] = None) -> dict[str, Any]:
    """The ``metadata=`` for ``litellm.completion``: ``(run, slot)``, a rendered prompt or a workflow step. Content-free:
    the tag, the signed run reference, and ``model``: the id you send the release's model under when it is not the
    release's own (a deployment, a Bedrock id, a Router model group). Read ``run.run_ref`` here, at the call: it grows. A
    prompt rendered inside ``ap.run`` is marked as that run's, as ``(run, slot)`` is."""
    if isinstance(target, tuple):
        run, slot = target
        # ``run``: the call is this run's, so a record the logger delivers after the run ended is dropped, not re-counted.
        fields: dict[str, Any] = {"tag": slot, "runRef": run.run_ref, "run": True}
    else:
        step = getattr(target, "step_id", None)
        fields = {"tag": step.split("#")[0], "step": step, "runRef": target.run_ref} if step else {"tag": target.tag, "runRef": target.run_ref}
        if getattr(target, "_run_bound", False):
            # Rendered inside ``ap.run``: the call is the run's, so a late record is dropped, never a second row. A
            # workflow step's own reference names no run (``runRefIsRun``): the logger's open run is then the step's.
            fields["run"] = True
            if step:
                fields["runRefIsRun"] = False
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
        self._said: set[tuple[str, str]] = set()
        self._open: "OrderedDict[str, tuple[RunSession, Callable[..., bool]]]" = OrderedDict()
        self._open_lock = threading.Lock()

    def _log(self, event: str, **fields: Any) -> None:
        # A customer logger that raises never reaches LiteLLM.
        try:
            self._ap.log({"event": event, "adapter": "litellm", **fields})
        except Exception:  # noqa: BLE001
            pass

    def _observe(self, kwargs: Mapping[str, Any], response_obj: Any, start_time: Any, end_time: Any, error: Any) -> None:
        try:
            self._record(kwargs, response_obj, start_time, end_time, error)
        except Exception as failure:  # noqa: BLE001 — a callback never fails the customer's call
            self._log(ADAPTER_EVENTS["tap_failed"], method="completion", reason=str(failure))

    def _attribute(self, kwargs: Mapping[str, Any], *, say: bool) -> Optional[tuple[Mapping[str, Any], Mapping[str, Any], str, str]]:
        """``(fields, entry, slot, model)`` for a call the signed reference names on the release's model, else None."""
        fields = _metadata(kwargs)
        if fields is None:
            return None
        # The signed reference is the only authority: unsigned metadata could forge a version, an artifact or an audience.
        entries = self._ap.explain(fields["runRef"])
        entry = next((e for e in entries or () if e.get("tag") == fields["tag"]), None)
        if entry is None:
            return None
        slot = str(entry["tag"])
        model = str(entry.get("model") or "unknown")
        if not self._same_model(kwargs, fields, model):
            # Another model's numbers never count against this version.
            sent = str(kwargs.get("model"))
            if say and (slot, sent) not in self._said:
                self._said.add((slot, sent))
                self._log(ADAPTER_EVENTS["model_unresolved"], slot=slot, method="completion", model=model)
            return None
        return fields, entry, slot, model

    def _run_of(self, fields: Mapping[str, Any], entry: Mapping[str, Any]) -> Optional[RunSession]:
        """The live run this call belongs to: the one its signed reference names, whatever context the hook runs in (an
        open run in the hook's context that the reference does not name is another request's), or, for a workflow step
        whose own reference names no run, the open run in the hook's context. Never a new one."""
        run = _find_run(self._ap, fields["runRef"])
        if run is not None and not self._serves(run, entry):
            # A run resumed under the same id, or re-pinned, now serves another version: this call is not its.
            run = None
        if run is None and fields.get("run") is True and not fields.get("runRefIsRun", True):
            run = self._ap.current_run()
        return run

    def _begin(self, kwargs: Mapping[str, Any]) -> None:
        """LiteLLM's pre-call hook, with the caller's context, before the request: open the call on its live run, so a
        run that ends before the log fires says the call was not measured."""
        call_id = kwargs.get("litellm_call_id")
        attributed = self._attribute(kwargs, say=False) if isinstance(call_id, str) else None
        if attributed is None:
            return
        fields, entry, slot, _model = attributed
        run = self._run_of(fields, entry)
        if run is None:
            return
        with self._open_lock:
            if call_id in self._open:
                return  # a retry of the same call: one call, opened once
            self._open[call_id] = (run, _open_call(run, slot))
            if len(self._open) > OPEN_CALLS_MAX:
                for key in [key for key, (opened_on, _) in self._open.items() if getattr(opened_on, "is_ended", False) is True]:
                    del self._open[key]
            while len(self._open) > OPEN_CALLS_MAX:
                self._open.popitem(last=False)

    def _opened(self, kwargs: Mapping[str, Any]) -> Optional[tuple[RunSession, Callable[..., bool]]]:
        call_id = kwargs.get("litellm_call_id")
        if not isinstance(call_id, str):
            return None
        with self._open_lock:
            return self._open.pop(call_id, None)

    def _record(self, kwargs: Mapping[str, Any], response_obj: Any, start_time: Any, end_time: Any, error: Any) -> None:
        # Taken before attribution: a call that attributed at pre-call and not now stays open, and its run reads as not
        # measured, the safe side.
        opened = self._opened(kwargs)
        attributed = self._attribute(kwargs, say=True)
        if attributed is None:
            return
        fields, entry, slot, model = attributed
        step = fields.get("step") if isinstance(fields.get("step"), str) else None
        latency = _latency_ms(start_time, end_time)
        usage = normalize_usage(response_obj) if error is None else None
        error_class = classify_error(error) if error is not None else classify_result(response_obj)
        call = {"model": model, "latency_ms": latency, "step": step, "usage": usage, "error_class": error_class, "output_text": output_text_of(response_obj) if error is None else None}
        if opened is not None:
            # The run the pre-call hook opened this call on, found in the caller's context: it settles there, whatever
            # context this log runs in. An ended run drops it with one log (its row already said the call was not
            # measured); one that ends just now drops it with the session's own.
            opened_on, record = opened
            if getattr(opened_on, "is_ended", False) is True:
                self._log(ADAPTER_EVENTS["late_record"], slot=slot, method="completion")
            else:
                record(**call)
            return
        run = self._run_of(fields, entry)
        if run is not None:
            run.record_model_call(slot, **call)
            return
        if fields.get("run") is True:
            # The run this call belonged to ended before LiteLLM logged it: counted once, in that run, or not at all. Its
            # row, written at the end, already said the call it opened was not measured.
            self._log(ADAPTER_EVENTS["late_record"], slot=slot, method="completion")
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

    @staticmethod
    def _same_model(kwargs: Mapping[str, Any], fields: Mapping[str, Any], model: str) -> bool:
        """Whether the call ran on the release's model: its own id, or the id the call site named for it
        (``litellm_metadata(..., model=...)``: a deployment, a Bedrock id, a Router model group). LiteLLM logs the id
        without its provider prefix (``azure/prod-gpt5`` arrives as ``prod-gpt5``), so both forms match."""
        names = {model}
        mapped = fields.get("model")
        if isinstance(mapped, str):
            names |= {mapped, mapped.split("/", 1)[-1]}
        params = kwargs.get("litellm_params") if isinstance(kwargs.get("litellm_params"), Mapping) else {}
        metadata = params.get("metadata") if isinstance(params.get("metadata"), Mapping) else {}
        candidates = [kwargs.get("model"), metadata.get("model_group"), kwargs.get("model_group")]
        sent = [c for c in candidates if isinstance(c, str)]
        if not sent:
            return True
        return any(c in names or c.split("/", 1)[-1] in names for c in sent)

    def _serves(self, run: RunSession, entry: Mapping[str, Any]) -> bool:
        """Whether the run still serves the version, arm and artifact the call's reference names for its slot."""
        current = next((e for e in self._ap.explain(run.run_ref) or () if e.get("tag") == entry.get("tag")), None)
        return current is not None and all(current.get(key) == entry.get(key) for key in ("versionId", "arm", "artifactId"))

    # LiteLLM's CustomLogger hooks (sync and async). LiteLLM calls the sync pre-call hook for async calls too.
    def log_pre_api_call(self, model: Any, messages: Any, kwargs: Mapping[str, Any]) -> None:
        try:
            self._begin(kwargs)
        except Exception as failure:  # noqa: BLE001 — a callback never fails the customer's call
            self._log(ADAPTER_EVENTS["tap_failed"], method="completion", reason=str(failure))

    def log_success_event(self, kwargs: Mapping[str, Any], response_obj: Any, start_time: Any, end_time: Any) -> None:
        self._observe(kwargs, response_obj, start_time, end_time, None)

    def log_failure_event(self, kwargs: Mapping[str, Any], response_obj: Any, start_time: Any, end_time: Any) -> None:
        self._observe(kwargs, response_obj, start_time, end_time, kwargs.get("exception") or response_obj or RuntimeError("litellm failure"))

    async def async_log_success_event(self, kwargs: Mapping[str, Any], response_obj: Any, start_time: Any, end_time: Any) -> None:
        self._observe(kwargs, response_obj, start_time, end_time, None)

    async def async_log_failure_event(self, kwargs: Mapping[str, Any], response_obj: Any, start_time: Any, end_time: Any) -> None:
        self._observe(kwargs, response_obj, start_time, end_time, kwargs.get("exception") or response_obj or RuntimeError("litellm failure"))


__all__ = [
    "AirPrompterLiteLLMCallback",
    "LiteLLMRuntime",
    "METADATA_KEY",
    "litellm_metadata",
    "litellm_params",
]
