"""A slot's first placement: resolve on the data path (never the facade's raising ``_resolve_slot``), then render with
the run's variables. Every refusal is data: a passthrough with its reason. A render failure keeps the version it failed
on, so the run writes one error row against it and the gates see a broken candidate.

Resolution and the render are split, so the variables are filled outside the session's lock, by ``fill_sync`` on the
sync path (a coroutine source there is ``variables_unfilled``) or ``fill_async`` on the async one.

Example::

    prepared = prepare_slot("support.reply", context)
    pin = prepared if isinstance(prepared, SlotPin) else render_sync(prepared)
    if pin.placement.kind == "approved":
        pin.entry  # the slot's run reference entry
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional, Union

from airprompter_agent.core import ReleaseSlot, RunDimensions

from ..release.resolver import ReleaseResolver
from ..variables import FilledRender, FillPlan, VariableSourceContext, fill_async, fill_sync, plan_fill
from .ports import RunHost
from .types import Approved, Passthrough, Placement


@dataclass(eq=False)
class SlotPin:
    """Compared by identity: a pin settles once, however many callers waited on it."""

    placement: Placement
    #: The version the slot's run row is written against. None for a passthrough that never chose a version.
    dims: Optional[RunDimensions] = None
    #: The run reference entry, for an approved prompt.
    entry: Optional[Mapping[str, Any]] = None
    #: What ``resolve`` chose, so the direct path and ``place`` share one pin.
    resolved: Optional[ReleaseSlot] = None
    #: A row error fixed at placement: the render failed on this version.
    row_error: Optional[str] = None
    #: Pinned by the direct path (``ap.prompt``, ``ap.workflow``): ``place`` has not rendered it.
    direct: bool = False
    #: Why the passthrough came about, for the log. Never a value.
    detail: Optional[Mapping[str, Any]] = None


def passthrough_pin(slot: str, reason: str, **extra: Any) -> SlotPin:
    return SlotPin(placement=Passthrough(slot, reason), **extra)


def dimensions_of(slot: str, resolved: ReleaseSlot) -> RunDimensions:
    return RunDimensions(tag=slot, artifact_id=resolved.slot["artifactId"], version_id=resolved.slot["versionId"], arm=resolved.arm, model=resolved.slot["model"], audience_ids=getattr(resolved, "audience_ids", None), run_minute=getattr(resolved, "run_minute", None))


def entry_of(slot: str, resolved: ReleaseSlot, run_minute: Optional[str]) -> dict[str, Any]:
    """In the key order the TypeScript SDK writes, so a token is the same bytes in both."""
    audience_ids = getattr(resolved, "audience_ids", None)
    return {
        "tag": slot,
        "artifactId": resolved.slot["artifactId"],
        "versionId": resolved.slot["versionId"],
        "model": resolved.slot["model"],
        "arm": resolved.arm,
        "bucket": resolved.bucket,
        "runMinute": getattr(resolved, "run_minute", None) or run_minute or "",
        **({"audienceIds": list(audience_ids)} if audience_ids is not None else {}),
    }


@dataclass(frozen=True)
class PlaceContext:
    host: RunHost
    subject: str
    #: Read at this slot's first placement, so a late tag reaches it.
    tags: Callable[[], Mapping[str, str]]
    values: Mapping[str, Any]
    #: A version the direct path already chose for this slot in this run.
    resolved: Optional[ReleaseSlot]


@dataclass(frozen=True)
class PreparedRender:
    """A resolved prompt slot waiting for its variables."""

    slot: str
    context: PlaceContext
    resolver: ReleaseResolver
    resolved: ReleaseSlot


def prepare_slot(slot: str, context: PlaceContext) -> Union[SlotPin, PreparedRender]:
    """Resolve one slot: a final pin for every refusal, else what the render needs. Never raises."""
    host = context.host
    release = host.release()
    if isinstance(release, str):
        return passthrough_pin(slot, release)
    resolver = release
    resolved = context.resolved
    if resolved is None:
        outcome = resolver.resolve(slot, context.subject, context.tags())
        if not outcome.ok or outcome.slot is None:
            if outcome.reason == "no_slot":
                return passthrough_pin(slot, "no_slot")
            host.stamp_disabled(resolver.release.generation, outcome.tag)
            return passthrough_pin(slot, "slot_disabled")
        resolved = outcome.slot
    if resolved.slot.get("kind", "prompt") != "prompt":
        return passthrough_pin(slot, "slot_kind_unsupported")
    return PreparedRender(slot, context, resolver, resolved)


def _plan(prepared: PreparedRender) -> tuple[str, FillPlan, VariableSourceContext]:
    resolved = prepared.resolved
    text = prepared.resolver.text_of(resolved.slot)
    plan = plan_fill(tag=prepared.slot, variables=resolved.slot.get("variables", []), text=text, values=prepared.context.values, registry=prepared.context.host.variables)
    source_context = VariableSourceContext(tag=prepared.slot, name="", subject=prepared.context.subject, version_id=resolved.slot["versionId"], arm=resolved.arm)
    return text, plan, source_context


def _rendered(prepared: PreparedRender, text: str, filled: FilledRender) -> SlotPin:
    slot, resolved = prepared.slot, prepared.resolved
    rendered = prepared.resolver.render(resolved, filled.values, fenced=filled.fenced, text=text)
    dims = dimensions_of(slot, resolved)
    if rendered.run_minute:
        dims.run_minute = rendered.run_minute
    return SlotPin(placement=Approved(slot, rendered.text, rendered.model, dict(rendered.inference or {})), dims=dims, entry=entry_of(slot, resolved, rendered.run_minute), resolved=resolved)


def _failed(prepared: PreparedRender, error: BaseException) -> SlotPin:
    return passthrough_pin(prepared.slot, "variables_unfilled", dims=dimensions_of(prepared.slot, prepared.resolved), resolved=prepared.resolved, row_error="render_missing_variable", detail={"error": type(error).__name__})


def render_sync(prepared: PreparedRender) -> SlotPin:
    """Sync sources only, each on a worker thread under its timeout. Never raises."""
    try:
        text, plan, source_context = _plan(prepared)
        return _rendered(prepared, text, fill_sync(plan, source_context, prepared.context.host.variables))
    except Exception as error:  # noqa: BLE001 — a refusal is data
        return _failed(prepared, error)


async def render_async(prepared: PreparedRender) -> SlotPin:
    """Every source, coroutine ones awaited. Never raises, except a cancellation."""
    try:
        text, plan, source_context = _plan(prepared)
        return _rendered(prepared, text, await fill_async(plan, source_context, prepared.context.host.variables))
    except Exception as error:  # noqa: BLE001 — a refusal is data
        return _failed(prepared, error)
