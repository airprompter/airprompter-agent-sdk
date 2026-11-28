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
from .inference import AppliedInference, apply_inference
from .observe import ObserveTarget, PendingObservation, UsageNormalized, classify_error, classify_result, normalize_usage, observe_call, observe_call_async
from .release.resolver import Disabled, ReleaseResolver, Rendered, ResolveOutcome, Workflow, WorkflowStep, copy_inference, disabled_from, new_subject
from .variables import (
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
    unsourced,
)
from .run import (
    DEFAULT_RUN_IDLE_TIMEOUT_MS,
    AgentRuntime,
    Approved,
    ModelResolver,
    Passthrough,
    Placement,
    Run,
    RunInput,
    RunRegistry,
    RunScope,
    RunSession,
)

# The names 1.0 promises (docs/stability.md), one per line: tests/test_package_shape.py pins them. Every other name
# imported above is the layer's own, for the layers above it, and not public.
__all__ = [
    "AgentRuntime",
    "AppliedInference",
    "Approved",
    "Attribution",
    "Disabled",
    "ModelResolver",
    "ObserveTarget",
    "Passthrough",
    "Placement",
    "RegisteredSource",
    "ReleaseResolver",
    "RenderValues",
    "Rendered",
    "ResolveOutcome",
    "RunInput",
    "RunSession",
    "UsageNormalized",
    "VariableSource",
    "VariableSourceContext",
    "VariableSourceError",
    "VariableSourceInput",
    "VariableSourceRegistry",
    "VariableSourceRequiredError",
    "apply_inference",
    "attribution_scope",
    "current_attribution",
    "is_variable_source_error",
    "is_variable_source_required_error",
    "new_subject",
    "normalize_usage",
    "observe_call",
    "observe_call_async",
]

# Imported for the layers above and never public: named here so each import is used on purpose, and so no one
# reads one as a promise. tests/test_package_shape.py checks this and ``__all__`` cover every import, apart.
_FOR_THE_LAYERS_ABOVE = (
    DEFAULT_RUN_IDLE_TIMEOUT_MS,
    FillPlan,
    FilledRender,
    PendingObservation,
    Run,
    RunRegistry,
    RunScope,
    Workflow,
    WorkflowStep,
    classify_error,
    classify_result,
    copy_inference,
    disabled_from,
    fill_async,
    fill_sync,
    plan_fill,
    unsourced,
)
