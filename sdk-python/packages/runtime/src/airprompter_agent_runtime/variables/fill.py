"""Filling a render's variables: the call site first, then the application's sources, then nothing.

Pure functions over a slot's declarations, the text about to be rendered, the values the call site passed and
the registry of sources. The precedence is fixed and visible: a call-site value always wins (the caller knows
more than a source); a source is consulted only for a declared variable the render actually needs — required,
or present in the text — and only when the call site did not pass it; what is still missing is the render's
problem, and ``render_template`` says so loudly. Trust comes out stricter than it went in: a value a source of
``end_user`` trust filled is named in ``fenced``, and the resolver renders it fenced whatever the prompt declared.

Two fills, one plan. ``fill_sync`` runs literals and plain callables (each on a worker thread under its own
timeout, all at once) and refuses a coroutine-function source with ``VariableSourceRequiredError``;
``fill_async`` runs every kind under an asyncio timeout. Neither holds any lock of the agent's: a source is the
customer's code and may take its time.

Example::

    plan = plan_fill(tag=tag, variables=slot["variables"], text=text, values=values, registry=registry)
    # plan.literal  — names a literal fills
    # plan.async_   — names a callable source must fill
    # plan.missing  — required names nobody fills: the render will raise MissingVariableError
    filled = fill_sync(plan, VariableSourceContext(tag, "", subject, version_id, arm), registry)
    resolver.render(resolved, filled.values, fenced=filled.fenced, text=text)
"""

from __future__ import annotations

import asyncio
import inspect
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from dataclasses import dataclass, field, replace
from typing import Any, Literal, Mapping, Optional, Sequence

from airprompter_agent_core.render.template import placeholders_of

from .sources import RegisteredSource, VariableSourceContext, VariableSourceError, VariableSourceRegistry, VariableSourceRequiredError, is_variable_source_error

#: The call site's values: None is "not passed", everything else is a value (rendered with ``str()``).
RenderValues = Mapping[str, Any]


@dataclass(frozen=True)
class FillPlan:
    """What a render needs from where — decided before anything is looked up."""

    tag: str
    variables: Sequence[Mapping[str, Any]]
    values: RenderValues
    #: Declared variables the call site left unfilled that a literal supplies.
    literal: list[str] = field(default_factory=list)
    #: Declared variables the call site left unfilled that a callable source must supply.
    async_: list[str] = field(default_factory=list)
    #: Required variables nobody supplies; ``render_template`` will refuse the render.
    missing: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Filled:
    """One variable a fill supplied, and whether the source's trust was stricter than the prompt's."""

    name: str
    from_: Literal["literal", "source"]
    stricter: bool


@dataclass(frozen=True)
class FilledRender:
    #: The call site's values plus every filled one; a literal or a source never overrides a caller.
    values: dict[str, Any]
    #: Names whose value came from an ``end_user`` source though the prompt declared ``operator``: the resolver fences them.
    fenced: frozenset[str]
    #: Variables a source filled and, for each, whether the source's trust was stricter than the prompt's.
    filled: list[Filled]


def supplied(values: RenderValues, name: str) -> bool:
    """A value the call site did pass: None is "not passed", everything else is a value."""
    return values.get(name) is not None


def plan_fill(*, tag: str, variables: Sequence[Mapping[str, Any]], text: Optional[str], values: RenderValues, registry: VariableSourceRegistry) -> FillPlan:
    """Which declared variables a render must fill from a source: required ones, and any the text uses — never one
    the current version dropped (a source is not called for a variable no longer in the prompt). ``text`` is None in
    managed mode, where only the declarations are known; then the required ones are the whole set."""
    used = None if text is None else placeholders_of(text)
    literal: list[str] = []
    async_: list[str] = []
    missing: list[str] = []
    for variable in variables:
        name = str(variable["name"])
        if supplied(values, name):
            continue
        needed = bool(variable.get("required")) or (used is not None and name in used)
        if not needed:
            continue
        entry = registry.get(name)
        if entry is None:
            if variable.get("required"):
                missing.append(name)
            continue
        (literal if entry.kind == "literal" else async_).append(name)
    return FillPlan(tag=tag, variables=list(variables), values=dict(values), literal=literal, async_=async_, missing=missing)


def stricter_sources(variables: Sequence[Mapping[str, Any]], registry: VariableSourceRegistry) -> list[str]:
    """The declared variables whose registered source is stricter than the declaration (``end_user`` over
    ``operator``). Decidable before any lookup — a hosted run, which cannot fence, refuses these at plan time
    instead of after calling the customer's system."""
    names: list[str] = []
    for variable in variables:
        entry = registry.get(str(variable["name"]))
        if variable.get("trust") != "end_user" and entry is not None and entry.trust == "end_user":
            names.append(str(variable["name"]))
    return names


def unsourced(*, variables: Sequence[Mapping[str, Any]], values: RenderValues, registry: VariableSourceRegistry) -> list[str]:
    """The required names a render would still lack after these values and the registered sources — what a call
    site checks at start-up so an uncoverable version fails there, not on the first customer request. Only
    declarations matter here (a required variable is needed whether or not the text uses it), so no payload is read."""
    return [str(v["name"]) for v in variables if v.get("required") and not supplied(values, str(v["name"])) and not registry.has(str(v["name"]))]


def _bounded(tag: str, name: str, entry: RegisteredSource, value: Any) -> Optional[str]:
    """One answer, checked: text only and within the byte bound. ``[object Object]`` never reaches a prompt."""
    if value is None:
        return None
    if inspect.isawaitable(value):
        # A plain callable handed back a coroutine: not text, and closed so it never warns about being un-awaited.
        close = getattr(value, "close", None)
        if callable(close):
            close()
        raise VariableSourceError(tag, name, "not_text")
    if not isinstance(value, str):
        raise VariableSourceError(tag, name, "not_text")
    if len(value.encode("utf-8")) > entry.max_bytes:
        raise VariableSourceError(tag, name, "too_large")
    return value


def _collect(plan: FillPlan, results: list[tuple[str, Optional[str], str, str]]) -> FilledRender:
    """Every (name, value, from, trust) into the render's values: a revoked entry is left to the render, an
    unanswered required one is a named failure, an optional unanswered one is left empty as a call site would have."""
    values: dict[str, Any] = dict(plan.values)
    filled: list[Filled] = []
    fenced: set[str] = set()
    by_name = {str(v["name"]): v for v in plan.variables}
    for name, value, from_, trust in results:
        variable = by_name.get(name)
        if from_ == "revoked":
            continue  # revoked since the plan: the render decides, exactly as the plan's missing list would
        if value is None:
            if variable is not None and variable.get("required"):
                raise VariableSourceError(plan.tag, name, "empty")
            continue
        values[name] = value
        stricter = trust == "end_user" and (variable is None or variable.get("trust") != "end_user")
        if stricter:
            fenced.add(name)
        filled.append(Filled(name=name, from_=from_, stricter=stricter))  # type: ignore[arg-type]
    return FilledRender(values=values, fenced=frozenset(fenced), filled=filled)


def fill_sync(plan: FillPlan, context: VariableSourceContext, registry: VariableSourceRegistry) -> FilledRender:
    """Literals and plain-callable sources — the synchronous path. Every callable runs on its own worker thread,
    all at once, each under its own timeout; a coroutine-function source is refused (``VariableSourceRequiredError``):
    that is what ``fill_async`` is for. The registry is re-read at fill time, so a source registered since the plan
    is treated as it stands now, never as a quiet ``MissingVariableError``."""
    names = [*plan.literal, *plan.async_]
    entries = {name: registry.get(name) for name in names}
    must_await = [name for name, entry in entries.items() if entry is not None and entry.kind == "source" and entry.awaitable]
    if must_await:
        raise VariableSourceRequiredError(plan.tag, must_await)
    callable_names = [name for name, entry in entries.items() if entry is not None and entry.kind == "source"]
    results: dict[str, tuple[str, Optional[str], str, str]] = {}
    for name, entry in entries.items():
        if entry is None:
            results[name] = (name, None, "revoked", "operator")
        elif entry.kind == "literal":
            results[name] = (name, entry.value, "literal", entry.trust)
    if callable_names:
        # One pool per fill, sized to the lookups: a source that outlives its timeout keeps its thread until it
        # returns (a thread cannot be killed), but the render has already failed by name and moved on.
        executor = ThreadPoolExecutor(max_workers=len(callable_names), thread_name_prefix="airprompter-variable-source")
        started = time.monotonic()
        futures = {name: executor.submit(entries[name].source.resolve, replace(context, name=name)) for name in callable_names}  # type: ignore[union-attr]
        try:
            for name, future in futures.items():
                entry = entries[name]
                assert entry is not None
                try:
                    value = future.result(timeout=max(0.0, started + entry.timeout_seconds - time.monotonic()))
                except FutureTimeoutError as error:
                    raise VariableSourceError(plan.tag, name, "timeout") from error
                except BaseException as error:  # noqa: BLE001 — the source's failure is the render's, named
                    if is_variable_source_error(error):
                        raise
                    raise VariableSourceError(plan.tag, name, "threw", error) from error
                results[name] = (name, _bounded(plan.tag, name, entry, value), "source", entry.trust)
        finally:
            executor.shutdown(wait=False)
    return _collect(plan, [results[name] for name in names])


async def fill_async(plan: FillPlan, context: VariableSourceContext, registry: VariableSourceRegistry) -> FilledRender:
    """Literals and every kind of source — coroutine functions awaited, plain callables run on a worker thread —
    concurrently, each under its own timeout and byte bound."""
    names = [*plan.literal, *plan.async_]

    async def one(name: str) -> tuple[str, Optional[str], str, str]:
        entry = registry.get(name)
        if entry is None:
            return (name, None, "revoked", "operator")
        if entry.kind == "literal":
            return (name, entry.value, "literal", entry.trust)
        assert entry.source is not None
        ctx = replace(context, name=name)
        try:
            if entry.awaitable:
                value = await asyncio.wait_for(entry.source.resolve(ctx), entry.timeout_seconds)
            else:
                value = await asyncio.wait_for(asyncio.to_thread(entry.source.resolve, ctx), entry.timeout_seconds)
        except asyncio.TimeoutError as error:
            raise VariableSourceError(plan.tag, name, "timeout") from error
        except asyncio.CancelledError:
            raise
        except BaseException as error:  # noqa: BLE001 — the source's failure is the render's, named
            if is_variable_source_error(error):
                raise
            raise VariableSourceError(plan.tag, name, "threw", error) from error
        return (name, _bounded(plan.tag, name, entry, value), "source", entry.trust)

    results = await asyncio.gather(*(one(name) for name in names))
    return _collect(plan, list(results))
