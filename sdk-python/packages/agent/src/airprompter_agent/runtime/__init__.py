"""``airprompter_agent.runtime``: serving a verified release: which slot a subject gets under which arm (the ramp
walked on this host's clock, a retreat honoured), the rendered text with its run reference, the run session, and the
``ap.attribute`` scope. What the framework adapters share is in ``runtime.adapter``, reached only through
``airprompter_agent.frameworks.contract``. Consumes a
``LoadedRelease`` from ``airprompter_agent.core`` — the slot store, a daemon or a bundle the customer loaded — and
never imports the sync or the telemetry layer.

Example::

    from airprompter_agent.runtime import ReleaseResolver, Rendered

    resolver = ReleaseResolver(release=reader.current(), run_ref_key=key, agent_id="agt_1", target="prod", instance_id="host-1", now_ms=now_ms)
    outcome = resolver.resolve("support.reply", subject="user-42")                  # ok with the slot and arm, or a refusal as data
    rendered: Rendered = resolver.render(outcome.slot, {"customer_name": "Ada"})   # .text, .model, .run_ref
"""

from .attribution import Attribution, attribution_scope, current_attribution
from .inference import INFERENCE_KEYS, AppliedInference, apply_inference, temperature_of, top_p_of
from .observe import ObserveTarget, PendingObservation, UsageNormalized, classify_error, classify_result, normalize_usage, observe_call, observe_call_async
from .release.resolver import Disabled, ReleaseResolver, Rendered, ResolveOutcome, Workflow, WorkflowStep, copy_inference, disabled_from, new_subject
from .variables import (
    DEFAULT_SOURCE_MAX_BYTES,
    DEFAULT_SOURCE_TIMEOUT_SECONDS,
    Filled,
    FilledRender,
    FillPlan,
    RegisteredSource,
    RenderValues,
    VariableSource,
    VariableSourceContext,
    VariableSourceError,
    VariableSourceInput,
    VariableSourceRegistry,
    VariableSourceRequiredError,
    fill_async,
    fill_sync,
    is_variable_source_error,
    is_variable_source_required_error,
    plan_fill,
    supplied,
    unsourced,
)
from .run import DEFAULT_RUN_IDLE_TIMEOUT_MS, MAX_OPEN_RUNS, AgentRuntime, Approved, ModelResolver, Passthrough, Placement, Run, RunHost, RunInput, RunRecorder, RunRegistry, RunScope, RunSession

__all__ = [
    "DEFAULT_SOURCE_MAX_BYTES",
    "DEFAULT_SOURCE_TIMEOUT_SECONDS",
    "FillPlan",
    "Filled",
    "FilledRender",
    "RegisteredSource",
    "RenderValues",
    "VariableSource",
    "VariableSourceContext",
    "VariableSourceError",
    "VariableSourceInput",
    "VariableSourceRegistry",
    "VariableSourceRequiredError",
    "fill_async",
    "fill_sync",
    "is_variable_source_error",
    "is_variable_source_required_error",
    "plan_fill",
    "supplied",
    "unsourced",
    "AppliedInference",
    "Attribution",
    "INFERENCE_KEYS",
    "apply_inference",
    "temperature_of",
    "top_p_of",
    "Disabled",
    "ObserveTarget",
    "PendingObservation",
    "ReleaseResolver",
    "Rendered",
    "ResolveOutcome",
    "UsageNormalized",
    "Workflow",
    "WorkflowStep",
    "attribution_scope",
    "classify_error",
    "classify_result",
    "copy_inference",
    "current_attribution",
    "disabled_from",
    "new_subject",
    "DEFAULT_RUN_IDLE_TIMEOUT_MS",
    "MAX_OPEN_RUNS",
    "AgentRuntime",
    "Approved",
    "ModelResolver",
    "Passthrough",
    "Placement",
    "Run",
    "RunHost",
    "RunInput",
    "RunRecorder",
    "RunRegistry",
    "RunScope",
    "RunSession",
    "normalize_usage",
    "observe_call",
    "observe_call_async",
]
