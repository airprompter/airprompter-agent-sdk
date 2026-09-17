"""``airprompter_agent_runtime.variables`` — prompt variables filled from the application's own system.

``sources`` is the registry (a literal, or a callable with a stated trust and bounds); ``fill`` plans and runs a
render's lookups with a fixed precedence: the call site, then a source, then nothing. Pure over declarations and
text; the resolver and the facade decide what to render and what to record.

Example::

    from airprompter_agent_runtime.variables import VariableSourceRegistry, plan_fill, fill_sync

    registry = VariableSourceRegistry({"customer_tier": {"resolve": lambda ctx: crm.tier_of(ctx.subject), "trust": "operator"}})
    plan = plan_fill(tag="support.triage", variables=slot["variables"], text=text, values={"ticket": "…"}, registry=registry)
    filled = fill_sync(plan, VariableSourceContext("support.triage", "", "cust-1", "rev-6", "none"), registry)
"""

from .fill import Filled, FilledRender, FillPlan, RenderValues, fill_async, fill_sync, plan_fill, stricter_sources, supplied, unsourced
from .sources import (
    DEFAULT_SOURCE_MAX_BYTES,
    DEFAULT_SOURCE_TIMEOUT_SECONDS,
    RegisteredSource,
    VariableSource,
    VariableSourceContext,
    VariableSourceError,
    VariableSourceInput,
    VariableSourceRegistry,
    VariableSourceRequiredError,
    is_variable_source_error,
    is_variable_source_required_error,
)

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
    "stricter_sources",
    "supplied",
    "unsourced",
]
