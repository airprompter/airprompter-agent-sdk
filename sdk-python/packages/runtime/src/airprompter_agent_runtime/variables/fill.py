"""Filling a render's variables: the call site first, then the application's sources, then nothing.

Pure functions over a slot's declarations, the text about to be rendered, the values the call site passed and
the registry of sources. The precedence is fixed and visible: a call-site value always wins (the caller knows
more than a source); a source is consulted only for a declared variable the render actually needs — required,
or present in the text — and only when the call site did not pass it; what is still missing is the render's
problem, and ``render_template`` says so loudly. Trust comes out stricter than it went in: a value a source of
``end_user`` trust filled is named in ``fenced``, and the resolver renders it fenced whatever the prompt declared.

Two fills, one plan. ``fill_sync`` runs literals and plain callables (each on a daemon thread of its own under
its own timeout, all at once, the first failure ending the fill) and refuses a coroutine-function source with
``VariableSourceRequiredError``; ``fill_async`` runs every kind under an asyncio timeout. Neither holds any lock of
the agent's: a source is the customer's code and may take its time. A source that ignores its timeout keeps its
daemon thread until it returns — a thread cannot be killed — but the render has already failed by name, and the
interpreter's exit is never held up by it.

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
import queue
import threading
import time
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Literal, Mapping, Optional, Sequence

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




# ----------------------------------------------------------------------------- one lookup, bounded

#: What one lookup came back with: ("ok", value) from the source, or ("err", exception) raised inside it. The
#: wrappers below are the only code that runs the source, so a failure they catch is always the source's own — never
#: a KeyboardInterrupt delivered to the thread that waits, never the SDK's own deadline.
_Outcome = tuple[str, Any]


def _guarded(resolve: Callable[[VariableSourceContext], Any], context: VariableSourceContext) -> _Outcome:
    """On the source's own daemon thread, where a KeyboardInterrupt is never delivered: everything is the source's,
    a SystemExit included — left uncaught it would end the thread silently and the fill would time out with no cause."""
    try:
        return ("ok", resolve(context))
    except BaseException as error:  # noqa: BLE001 — every failure of the source is reported by name, not raised raw
        return ("err", error)


async def _await_guarded(awaitable: Any) -> _Outcome:
    """The asynchronous twin, on the event loop's thread: only an ``Exception`` is the source's. A cancellation is
    the caller's, and a KeyboardInterrupt or SystemExit raised while the source's frame is on top is the process's —
    both pass through."""
    try:
        return ("ok", await awaitable)
    except Exception as error:  # noqa: BLE001
        return ("err", error)


def _bounded(tag: str, name: str, entry: RegisteredSource, outcome: _Outcome, *, awaited: bool) -> Optional[str]:
    """One answer, checked: the source's own failure is ``threw`` (its own ``TimeoutError`` included — the SDK's
    deadline is the only ``timeout``); text only; within the byte bound. ``[object Object]`` never reaches a prompt."""
    kind, value = outcome
    if kind == "err":
        if is_variable_source_error(value):
            raise value
        raise VariableSourceError(tag, name, "threw", value) from value
    if value is None:
        return None
    if inspect.isawaitable(value):
        # A plain callable handed back a coroutine (a callable object with ``async __call__``, a sync decorator over an
        # async function): the async fill awaits it; the sync fill cannot, and says so by the true reason.
        close = getattr(value, "close", None)
        if callable(close):
            close()
        if awaited:
            raise VariableSourceError(tag, name, "not_text")
        raise VariableSourceRequiredError(tag, [name])
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


def _entries(plan: FillPlan, registry: VariableSourceRegistry) -> dict[str, Optional[RegisteredSource]]:
    """Everything the plan named, re-read now: a literal that became a source is looked up; a source that became a
    literal is used as one; anything revoked is left to the render."""
    return {name: registry.get(name) for name in [*plan.literal, *plan.async_]}


def _spawn(name: str, entry: RegisteredSource, context: VariableSourceContext, deliver: Callable[[str, _Outcome], None]) -> None:
    """One lookup on its own DAEMON thread: a source that ignores its timeout keeps the thread until it returns (a
    thread cannot be killed), but never blocks the interpreter's exit — every other thread the SDK runs is a daemon
    too. ``deliver`` is called from the source's thread, so it must be thread-safe."""
    assert entry.source is not None
    resolve = entry.source.resolve

    def run() -> None:
        deliver(name, _guarded(resolve, replace(context, name=name)))

    try:
        threading.Thread(target=run, name=f"airprompter-variable-source:{name}", daemon=True).start()
    except RuntimeError as error:  # the host is out of threads: the lookup failed, and says so by name
        deliver(name, ("err", error))


# ----------------------------------------------------------------------------- the fills


def fill_sync(plan: FillPlan, context: VariableSourceContext, registry: VariableSourceRegistry) -> FilledRender:
    """Literals and plain-callable sources — the synchronous path. Every callable runs on its own daemon thread, all
    at once, each under its OWN timeout measured from the moment the render dispatched it; the first failure (a throw,
    or a deadline passed) ends the fill at once rather than after the sources named before it. A coroutine-function
    source is refused (``VariableSourceRequiredError``): that is what ``fill_async`` is for. The registry is re-read
    at fill time, so a source registered since the plan is treated as it stands now, never as a quiet
    ``MissingVariableError``."""
    entries = _entries(plan, registry)
    must_await = [name for name, entry in entries.items() if entry is not None and entry.kind == "source" and entry.awaitable]
    if must_await:
        raise VariableSourceRequiredError(plan.tag, must_await)
    results: dict[str, tuple[str, Optional[str], str, str]] = {}
    for name, entry in entries.items():
        if entry is None:
            results[name] = (name, None, "revoked", "operator")
        elif entry.kind == "literal":
            results[name] = (name, entry.value, "literal", entry.trust)
    pending = {name: entry for name, entry in entries.items() if entry is not None and entry.kind == "source"}
    if pending:
        inbox: "queue.Queue[tuple[str, _Outcome]]" = queue.Queue()
        started = time.monotonic()
        for name, entry in pending.items():
            _spawn(name, entry, context, lambda n, outcome: inbox.put((n, outcome)))
        deadlines = {name: started + entry.timeout_seconds for name, entry in pending.items()}
        while pending:
            # Wait for the next answer, but no longer than the nearest deadline still open.
            nearest = min(deadlines[name] for name in pending)
            try:
                name, outcome = inbox.get(timeout=max(0.0, nearest - time.monotonic()))
            except queue.Empty:
                overdue = next(name for name in pending if deadlines[name] <= time.monotonic())
                raise VariableSourceError(plan.tag, overdue, "timeout") from None
            entry = pending.pop(name)
            if time.monotonic() > deadlines[name]:
                # It answered, but after its bound: a slow source is a timed-out source, whatever it eventually said.
                raise VariableSourceError(plan.tag, name, "timeout")
            results[name] = (name, _bounded(plan.tag, name, entry, outcome, awaited=False), "source", entry.trust)
    return _collect(plan, [results[name] for name in entries])


async def fill_async(plan: FillPlan, context: VariableSourceContext, registry: VariableSourceRegistry) -> FilledRender:
    """Literals and every kind of source — coroutine functions awaited, plain callables run on a daemon thread of
    their own (never the loop's default executor, which ``asyncio.run`` joins at exit) — concurrently, each under
    its own timeout and byte bound. The first failure ends the fill."""
    loop = asyncio.get_running_loop()

    def on_thread(name: str, entry: RegisteredSource) -> "asyncio.Future[_Outcome]":
        future: "asyncio.Future[_Outcome]" = loop.create_future()

        def deliver(_name: str, outcome: _Outcome) -> None:
            def settle() -> None:
                if not future.done():
                    future.set_result(outcome)

            try:
                loop.call_soon_threadsafe(settle)
            except RuntimeError:
                pass  # the loop is closed: the render that wanted this answer is long gone

        _spawn(name, entry, context, deliver)
        return future

    async def awaited(entry: RegisteredSource, name: str) -> _Outcome:
        assert entry.source is not None
        try:
            coroutine = entry.source.resolve(replace(context, name=name))
        except Exception as error:  # noqa: BLE001 — raised before a coroutine existed: still the source's failure
            return ("err", error)
        return await _await_guarded(coroutine)

    async def until(deadline: float, name: str, pending: "asyncio.Future[_Outcome]") -> _Outcome:
        """The answer, or the deadline — whichever comes first. The deadline wins outright: a source that swallows
        its cancellation and answers late, or is slow to honour it, neither delays the render nor gets its value in
        (exactly as the sync fill treats an answer after the bound). The cancelled task is left to finish on its own;
        whatever it raises then is retrieved so the loop never logs it as unhandled."""
        task = asyncio.ensure_future(pending)
        done, _ = await asyncio.wait({task}, timeout=max(0.0, deadline - time.monotonic()))
        if task in done:
            return task.result()
        task.cancel()
        task.add_done_callback(lambda finished: finished.cancelled() or finished.exception())
        raise VariableSourceError(plan.tag, name, "timeout")

    async def one(name: str) -> tuple[str, Optional[str], str, str]:
        entry = registry.get(name)
        if entry is None:
            return (name, None, "revoked", "operator")
        if entry.kind == "literal":
            return (name, entry.value, "literal", entry.trust)
        deadline = time.monotonic() + entry.timeout_seconds
        # Everything the source can raise is caught INSIDE the wrappers: only the deadline can fail here.
        outcome = await until(deadline, name, awaited(entry, name) if entry.awaitable else on_thread(name, entry))
        if outcome[0] == "ok" and inspect.isawaitable(outcome[1]):
            # A plain callable that handed back a coroutine: await it under what is left of the same bound — or, if
            # nothing is left, close it un-run (a dropped coroutine warns at collection) and call the time.
            if time.monotonic() >= deadline:
                close = getattr(outcome[1], "close", None)
                if callable(close):
                    close()
                raise VariableSourceError(plan.tag, name, "timeout")
            outcome = await until(deadline, name, _await_guarded(outcome[1]))
        return (name, _bounded(plan.tag, name, entry, outcome, awaited=True), "source", entry.trust)

    # One task per distinct name (a declaration listed twice is one lookup, as the sync fill's entry map makes it).
    tasks = [asyncio.ensure_future(one(name)) for name in dict.fromkeys([*plan.literal, *plan.async_])]
    try:
        results = await asyncio.gather(*tasks)
    except BaseException:
        # The first failure ends the fill: the other lookups are cancelled rather than awaited to their own ends.
        for task in tasks:
            task.cancel()
        raise
    return _collect(plan, list(results))
