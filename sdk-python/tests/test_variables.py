"""Variables filled from the application's own system (0.2.11) — parity with ``sdk-typescript/test/variables.test.ts``.

The registry's rules; the plan (a source is consulted only for a declared variable the render needs, never one the
version dropped); the fills (call site wins, literals sync, plain callables on worker threads, coroutine functions
awaited, every failure named and bounded); the agent path (fenced by the stricter trust, said once, one error row
under the slot's tag, status across arm overrides, a release activating mid-lookup); workflow steps; the managed
client (filled before the POST, an unfenceable source refused before any lookup).
"""

from __future__ import annotations

import asyncio
import json
import shutil
import tempfile
import threading
import time

import httpx
import pytest

from airprompter_agent import AirPrompterAgent
from airprompter_agent.agent import SyncOptions
from airprompter_agent_core._util import instant
from airprompter_agent_core.protocol.trust import public_jwk_of, release_digest
from airprompter_agent_core.render.template import MissingVariableError, UnknownVariableError, placeholders_of, render_template
from airprompter_agent_runtime.managed import ManagedAgent
from airprompter_agent_runtime.variables import (
    VariableSource,
    VariableSourceContext,
    VariableSourceError,
    VariableSourceRegistry,
    VariableSourceRequiredError,
    fill_async,
    fill_sync,
    is_variable_source_error,
    is_variable_source_required_error,
    plan_fill,
    stricter_sources,
    unsourced,
)

from .control_plane import FakeControlPlane

SCOPE = {"organizationId": "org_1", "agentId": "agt_vars", "target": "prod"}
KW = {"organization_id": "org_1", "agent_id": "agt_vars", "target": "prod"}
VARIABLES = [
    {"name": "team", "required": True, "trust": "operator"},
    {"name": "ticket", "required": True, "trust": "end_user"},
    {"name": "customer_tier", "required": False, "trust": "operator"},
    {"name": "last_ticket", "required": False, "trust": "operator"},
]
CTX = VariableSourceContext(tag="t", name="", subject=None, version_id="v", arm="none")


@pytest.fixture
def state_dir():
    path = tempfile.mkdtemp(prefix="ap-vars-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


def slots(plane: FakeControlPlane, *, tier_in_text: bool, tier_required: bool = False, version_id: str = "ver_1"):
    text = "For {{team}}: <ticket/> {{ticket}}" + (" on the {{customer_tier}} plan" if tier_in_text else "")
    variables = [{**v, "required": tier_required} if v["name"] == "customer_tier" else v for v in VARIABLES]
    return [plane.slot(tag="support.triage", text=text, variables=variables, version_id=version_id, model="gpt-5")]


def start(plane: FakeControlPlane, state_dir: str, **extra):
    options = {
        **KW,
        "api_key": plane.api_key,
        "base_url": "https://api.test",
        "state_dir": state_dir,
        "root": {"pinned": public_jwk_of(plane.root_key)},
        "sync": SyncOptions(mode="resident", poll_seconds=3600, root_url="https://edge.test/roots/prod/root.json"),
        "transport": plane.transport(),
        "telemetry": {"sink": "memory"},
    }
    options.update(extra)
    return AirPrompterAgent.start(**options)


def error_rows(ap: AirPrompterAgent) -> list[dict]:
    return [r for r in ap.drain_memory_sink() if r["type"] == "window" and r["status"] == "error"]


# ----------------------------------------------------------------------------- the registry


def test_registry_rules():
    registry = VariableSourceRegistry({"team": "Billing"})
    with pytest.raises(ValueError, match="not a variable name"):
        registry.provide("bad name", "x")
    with pytest.raises(ValueError, match="resolve must be callable"):
        registry.provide("x", {"trust": "operator"})
    with pytest.raises(ValueError, match="trust must be"):
        registry.provide("x", {"resolve": lambda ctx: "v", "trust": "anyone"})
    with pytest.raises(ValueError, match="must be positive"):
        registry.provide("x", VariableSource(resolve=lambda ctx: "v", trust="operator", timeout_seconds=0))
    registry.provide("customer_tier", {"resolve": lambda ctx: "gold", "trust": "operator", "timeout_seconds": 0.5, "max_bytes": 10})

    async def latest(ctx):
        return "t"

    registry.provide("last_ticket", VariableSource(resolve=latest, trust="end_user"))
    assert registry.names() == ["customer_tier", "last_ticket", "team"]
    assert registry.describe("team") == {"kind": "literal", "trust": "operator"}
    assert registry.describe("customer_tier") == {"kind": "source", "trust": "operator"}
    entry = registry.get("customer_tier")
    assert entry is not None and (entry.timeout_seconds, entry.max_bytes, entry.awaitable) == (0.5, 10, False)
    assert registry.get("last_ticket").awaitable is True, "a coroutine function is only for render_async"
    assert registry.describe("nope") is None
    assert registry.revoke("team") is True and registry.revoke("team") is False
    assert registry.has("team") is False
    assert placeholders_of("a {{ team }} b {{team}} {{ticket}}") == {"team", "ticket"}


# ----------------------------------------------------------------------------- the plan


def test_plan_unsourced_and_stricter():
    registry = VariableSourceRegistry({"team": "Billing", "customer_tier": {"resolve": lambda ctx: "gold", "trust": "operator"}, "last_ticket": {"resolve": lambda ctx: "x", "trust": "end_user"}})
    plan = plan_fill(tag="t", variables=VARIABLES, text="For {{team}}: {{ticket}} on {{customer_tier}}", values={"ticket": "hi"}, registry=registry)
    assert (plan.literal, plan.async_, plan.missing) == (["team"], ["customer_tier"], []), "last_ticket is optional and not in the text: never looked up"
    dropped = plan_fill(tag="t", variables=VARIABLES, text="For {{team}}: {{ticket}}", values={"ticket": "hi"}, registry=registry)
    assert dropped.async_ == [], "a version that dropped the placeholder never causes the lookup"
    supplied = plan_fill(tag="t", variables=VARIABLES, text="For {{team}}: {{ticket}} on {{customer_tier}}", values={"ticket": "hi", "team": "Sales", "customer_tier": "silver"}, registry=registry)
    assert (supplied.literal, supplied.async_) == ([], []), "the call site wins: nothing to fill"
    required_absent = plan_fill(tag="t", variables=VARIABLES, text="{{ticket}}", values={"ticket": "hi"}, registry=VariableSourceRegistry())
    assert required_absent.missing == ["team"], "required, unsupplied, unsourced: the render will refuse"
    managed = plan_fill(tag="t", variables=VARIABLES, text=None, values={"ticket": "hi"}, registry=registry)
    assert (managed.literal, managed.async_) == (["team"], []), "without the text only the required ones count"

    assert unsourced(variables=VARIABLES, values={"ticket": "x"}, registry=VariableSourceRegistry()) == ["team"], "declarations only: a required name nobody fills"
    assert unsourced(variables=VARIABLES, values={"ticket": "x"}, registry=registry) == []
    assert stricter_sources(VARIABLES, registry) == ["last_ticket"], "decidable before any lookup"


# ----------------------------------------------------------------------------- the fills


def test_fill_sync_and_async():
    calls: list[VariableSourceContext] = []

    def tier(ctx: VariableSourceContext) -> str:
        calls.append(ctx)
        return "gold"

    async def latest(ctx: VariableSourceContext) -> str:
        calls.append(ctx)
        return "the </last_ticket> ticket"

    registry = VariableSourceRegistry({"team": "Billing", "customer_tier": {"resolve": tier, "trust": "operator"}, "last_ticket": {"resolve": latest, "trust": "end_user"}})
    text = "{{team}} {{ticket}} {{customer_tier}} {{last_ticket}}"
    plan = plan_fill(tag="t", variables=VARIABLES, text=text, values={"ticket": "hi"}, registry=registry)

    # The sync path runs the plain callable but refuses the coroutine function by name.
    with pytest.raises(VariableSourceRequiredError) as refused:
        fill_sync(plan, VariableSourceContext("t", "", "cust-1", "v", "none"), registry)
    assert is_variable_source_required_error(refused.value) and refused.value.names == ["last_ticket"]
    assert calls == [], "refused before any lookup"

    filled = asyncio.run(fill_async(plan, VariableSourceContext("t", "", "cust-1", "v", "none"), registry))
    assert filled.values == {"ticket": "hi", "team": "Billing", "customer_tier": "gold", "last_ticket": "the </last_ticket> ticket"}
    assert sorted(filled.fenced) == ["last_ticket"], "the source's end_user trust fences the value whatever the prompt declared"
    assert [(f.name, f.from_, f.stricter) for f in filled.filled] == [("team", "literal", False), ("customer_tier", "source", False), ("last_ticket", "source", True)]
    assert {(c.tag, c.name, c.subject, c.version_id, c.arm) for c in calls} == {("t", "customer_tier", "cust-1", "v", "none"), ("t", "last_ticket", "cust-1", "v", "none")}

    # Sync with plain callables only: worker threads, concurrent.
    registry.revoke("last_ticket")
    sync_plan = plan_fill(tag="t", variables=VARIABLES, text=text, values={"ticket": "hi"}, registry=registry)
    sync_filled = fill_sync(sync_plan, CTX, registry)
    assert sync_filled.values["customer_tier"] == "gold" and sync_filled.fenced == frozenset()

    # A source for a variable the prompt already declares end_user is not "stricter"; the fence comes from the declaration.
    registry.provide("last_ticket", {"resolve": lambda ctx: "x", "trust": "end_user"})
    already = fill_sync(plan_fill(tag="t", variables=[{"name": "last_ticket", "required": False, "trust": "end_user"}], text="{{last_ticket}}", values={}, registry=registry), CTX, registry)
    assert (already.fenced, already.filled[0].stricter) == (frozenset(), False)

    # Failures, named: a throw, a timeout, an oversize answer, a value that is not text — and nothing for a required variable.
    def slow(ctx):
        time.sleep(0.5)
        return "late"

    registry.provide("slow", VariableSource(resolve=slow, trust="operator", timeout_seconds=0.05))
    registry.provide("broken", {"resolve": lambda ctx: (_ for _ in ()).throw(RuntimeError("db down")), "trust": "operator"})
    registry.provide("huge", VariableSource(resolve=lambda ctx: "x" * 100, trust="operator", max_bytes=10))
    registry.provide("object", {"resolve": lambda ctx: {"x": 1}, "trust": "operator"})
    registry.provide("absent", {"resolve": lambda ctx: None, "trust": "operator"})

    def failing(name: str, required: bool = False):
        return plan_fill(tag="t", variables=[{"name": name, "required": required, "trust": "operator"}], text=f"{{{{{name}}}}}", values={}, registry=registry)

    for name, reason in [("slow", "timeout"), ("broken", "threw"), ("huge", "too_large"), ("object", "not_text"), ("absent", "empty")]:
        with pytest.raises(VariableSourceError) as sync_error:
            fill_sync(failing(name, required=name == "absent"), CTX, registry)
        assert is_variable_source_error(sync_error.value) and (sync_error.value.variable, sync_error.value.reason) == (name, reason), f"sync {name}"
        with pytest.raises(VariableSourceError) as async_error:
            asyncio.run(fill_async(failing(name, required=name == "absent"), CTX, registry))
        assert (async_error.value.variable, async_error.value.reason) == (name, reason), f"async {name}"
    assert isinstance(sync_error.value.__cause__, BaseException) or sync_error.value.reason == "empty"
    optional_absent = fill_sync(failing("absent", False), CTX, registry)
    assert "absent" not in optional_absent.values, "an optional variable a source has no answer for is left for the render (empty)"

    # Re-registered between plan and fill: a literal that became a source is looked up; a source that became a literal is used as one.
    swapping = VariableSourceRegistry({"team": "Billing", "customer_tier": {"resolve": lambda ctx: "gold", "trust": "operator"}})
    swap_plan = plan_fill(tag="t", variables=VARIABLES, text="{{team}} {{customer_tier}}", values={}, registry=swapping)
    swapping.provide("team", {"resolve": lambda ctx: "Sales", "trust": "operator"})
    swapping.provide("customer_tier", "silver")
    swapped = fill_sync(swap_plan, CTX, swapping)
    assert swapped.values == {"team": "Sales", "customer_tier": "silver"}
    assert [(f.name, f.from_) for f in swapped.filled] == [("team", "source"), ("customer_tier", "literal")]
    # Revoked since the plan: left to the render, never a misleading "empty".
    swapping.revoke("team")
    revoked = fill_sync(swap_plan, CTX, swapping)
    assert "team" not in revoked.values
    assert MissingVariableError.code == "render_missing_variable" and UnknownVariableError.code == "render_unknown_variable"


def test_each_source_has_its_own_timeout_and_the_first_failure_ends_the_fill():
    threads: list[threading.Thread] = []

    def slow(ctx):
        threads.append(threading.current_thread())
        time.sleep(1.0)
        return "late"

    def quick(ctx):
        time.sleep(0.05)
        return "quick"

    registry = VariableSourceRegistry({"a": VariableSource(resolve=quick, trust="operator", timeout_seconds=1.0), "b": VariableSource(resolve=slow, trust="operator", timeout_seconds=0.05)})
    variables = [{"name": "a", "required": False, "trust": "operator"}, {"name": "b", "required": False, "trust": "operator"}]
    plan = plan_fill(tag="t", variables=variables, text="{{a}} {{b}}", values={}, registry=registry)
    started = time.monotonic()
    with pytest.raises(VariableSourceError) as error:
        fill_sync(plan, CTX, registry)
    assert (error.value.variable, error.value.reason) == ("b", "timeout"), "b's own bound, though a was named first"
    assert time.monotonic() - started < 0.6, "the fill ends at b's deadline, not when b eventually answers"
    assert threads and all(t.daemon for t in threads), "a source runs on a daemon thread: a stuck one never holds up exit"
    with pytest.raises(VariableSourceError) as async_error:
        asyncio.run(fill_async(plan, CTX, registry))
    assert (async_error.value.variable, async_error.value.reason) == ("b", "timeout")

    # A throw ends the fill at once, whatever is still running before it in plan order.
    registry.provide("a", VariableSource(resolve=lambda ctx: time.sleep(1.0) or "a", trust="operator", timeout_seconds=2.0))
    registry.provide("b", {"resolve": lambda ctx: (_ for _ in ()).throw(RuntimeError("no")), "trust": "operator"})
    started = time.monotonic()
    with pytest.raises(VariableSourceError) as threw:
        fill_sync(plan, CTX, registry)
    assert (threw.value.variable, threw.value.reason) == ("b", "threw") and time.monotonic() - started < 0.6

    # A source's OWN TimeoutError is its failure (threw), never the SDK's deadline.
    registry.provide("a", {"resolve": lambda ctx: (_ for _ in ()).throw(TimeoutError("db")), "trust": "operator"})
    registry.provide("b", "ok")
    with pytest.raises(VariableSourceError) as own:
        fill_sync(plan, CTX, registry)
    assert (own.value.variable, own.value.reason) == ("a", "threw")
    with pytest.raises(VariableSourceError) as own_async:
        asyncio.run(fill_async(plan, CTX, registry))
    assert (own_async.value.variable, own_async.value.reason) == ("a", "threw")

    # A plain callable that hands back a coroutine: awaited by the async fill; refused by the true reason in the sync one.
    async def fetch(ctx):
        return "fetched"

    registry.provide("a", {"resolve": lambda ctx: fetch(ctx), "trust": "operator"})
    assert asyncio.run(fill_async(plan, CTX, registry)).values["a"] == "fetched"
    with pytest.raises(VariableSourceRequiredError) as required:
        fill_sync(plan, CTX, registry)
    assert required.value.names == ["a"]

    # The deadline wins outright in the async fill too: a coroutine source that swallows its cancellation and answers
    # late, or is slow to honour it, neither delays the render nor gets its value in.
    async def swallows(ctx):
        try:
            await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            pass
        return "late-but-here"

    async def slow_to_cancel(ctx):
        try:
            await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            await asyncio.sleep(0.5)
            raise

    for source in (swallows, slow_to_cancel):
        registry.provide("a", VariableSource(resolve=source, trust="operator", timeout_seconds=0.05))
        started = time.monotonic()
        with pytest.raises(VariableSourceError) as late:
            asyncio.run(fill_async(plan, CTX, registry))
        assert (late.value.variable, late.value.reason) == ("a", "timeout") and time.monotonic() - started < 0.6, source.__name__

    # A sibling's failure cancels a coroutine source still in flight: it does not run on to its own end.
    async def first_failure_cancels_the_rest():
        seen: list[str] = []

        async def long(ctx):
            try:
                await asyncio.sleep(1.0)
                seen.append("ran to completion")
            except asyncio.CancelledError:
                seen.append("cancelled")
                raise
            return "late"

        registry.provide("a", VariableSource(resolve=long, trust="operator", timeout_seconds=2.0))
        registry.provide("b", {"resolve": lambda ctx: (_ for _ in ()).throw(RuntimeError("no")), "trust": "operator"})
        with pytest.raises(VariableSourceError) as sibling:
            await fill_async(plan, CTX, registry)
        assert (sibling.value.variable, sibling.value.reason) == ("b", "threw")
        await asyncio.sleep(0.05)  # on the SAME loop: teardown is not what cancels it
        assert seen == ["cancelled"]

    asyncio.run(first_failure_cancels_the_rest())

    # A KeyboardInterrupt raised while a coroutine source's frame is on top is the process's, never "the source threw".
    async def interrupted(ctx):
        raise KeyboardInterrupt

    registry.provide("a", VariableSource(resolve=interrupted, trust="operator"))
    with pytest.raises(KeyboardInterrupt):
        asyncio.run(fill_async(plan, CTX, registry))


# ----------------------------------------------------------------------------- the agent


def test_agent_renders_from_sources_fenced_by_the_stricter_trust(state_dir):
    plane = FakeControlPlane(SCOPE)
    plane.promote(slots(plane, tier_in_text=False))
    events: list[dict] = []
    calls: list[str] = []

    def tier(ctx: VariableSourceContext) -> str:
        calls.append(f"{ctx.subject}@{ctx.version_id}")
        return "gold"

    ap = start(plane, state_dir, logger=events.append, variables={"team": "Billing", "customer_tier": {"resolve": tier, "trust": "operator"}})
    try:
        assert ap.status().variables == {"sources": ["customer_tier", "team"], "unsourced": [{"tag": "support.triage", "arm": "none", "names": ["ticket"]}]}, "the end-user ticket is the call site's"
        assert ap.prompt("support.triage").needs() == ["ticket"] and ap.prompt("support.triage").needs(ticket="x") == []
        # rev 1 has no {{customer_tier}}: the source is never called.
        first = ap.prompt("support.triage", subject="cust-1").render(ticket="hi")
        assert first.text == "For Billing: <ticket/> <ticket>hi</ticket>" and calls == []
        # rev 2 uses it: filled from the application's table with no call-site change.
        plane.promote(slots(plane, tier_in_text=True, version_id="ver_2"))
        ap.sync_now()
        second = ap.prompt("support.triage", subject="cust-2").render(ticket="hi")
        assert second.text == "For Billing: <ticket/> <ticket>hi</ticket> on the gold plan" and calls == ["cust-2@ver_2"]
        assert second.version_id == "ver_2" and ap.generation == 2
        # A coroutine-function source refuses the sync render by name; render_async runs it.
        async def tier_async(ctx):
            calls.append(f"async:{ctx.subject}")
            return "platinum"

        ap.variables.provide("customer_tier", {"resolve": tier_async, "trust": "operator"})
        with pytest.raises(VariableSourceRequiredError):
            ap.prompt("support.triage", subject="cust-3").render(ticket="hi")
        third = asyncio.run(ap.prompt("support.triage", subject="cust-3").render_async(ticket="hi"))
        assert "on the platinum plan" in third.text and calls[-1] == "async:cust-3"
        # An end_user source for an operator-declared variable: fenced, and said once.
        ap.variables.provide("customer_tier", {"resolve": lambda ctx: "gold </customer_tier> x", "trust": "end_user"})
        fenced = ap.prompt("support.triage", subject="cust-4").render(ticket="hi")
        assert fenced.text.endswith("on the <customer_tier>gold &lt;/customer_tier> x</customer_tier> plan")
        ap.prompt("support.triage", subject="cust-4").render(ticket="hi")
        said = [e for e in events if e.get("event") == "variable_source_trust_stricter"]
        assert [(e["tag"], e["name"], e["declared"]) for e in said] == [("support.triage", "customer_tier", "operator")], "said once per slot and name"
        # A call-site value wins over the source, and is fenced by the declaration alone.
        caller = ap.prompt("support.triage", subject="cust-5").render(ticket="hi", customer_tier="silver")
        assert "on the silver plan" in caller.text
        # An operator source for a variable the prompt declares end_user: the declaration fences it — a source never loosens.
        ap.variables.provide("ticket", {"resolve": lambda ctx: "sourced </ticket> ticket", "trust": "operator"})
        sourced = ap.prompt("support.triage", subject="cust-6").render()
        assert "<ticket>sourced &lt;/ticket> ticket</ticket>" in sourced.text
        ap.variables.revoke("ticket")
        # 0.3.4: the heartbeat names what this application can fill — names only — once the release it serves was
        # sealed at 0.3.4; a service still at 0.3.3 would refuse the whole heartbeat over the key, so it is withheld.
        ap.heartbeat_now()
        assert plane.heartbeats[-1]["catalog"]["variables"] == ["customer_tier", "team"]
        assert "gold" not in json.dumps(plane.heartbeats[-1]), "never a value"
        plane.promote(slots(plane, tier_in_text=True, version_id="ver_3"), protocol="0.3.3")
        ap.sync_now()
        ap.heartbeat_now()
        assert "variables" not in plane.heartbeats[-1]["catalog"], "withheld from a 0.3.3 service"
        # The registry is the agent's: a wrapped client finds the render by its text.
        assert ap.attribution_for({"messages": [{"role": "user", "content": caller.text}]}) is not None
    finally:
        ap.stop()


def test_failing_source_is_one_error_row_under_the_slot_and_status_names_the_arm(state_dir):
    plane = FakeControlPlane(SCOPE)
    plane.promote(slots(plane, tier_in_text=True, tier_required=True))
    clock = {"ms": instant("2026-09-17T10:00:00Z")}
    events: list[dict] = []
    ap = start(plane, state_dir, now=lambda: clock["ms"], logger=events.append, variables={"team": "Billing"})
    try:
        assert ap.status().variables == {"sources": ["team"], "unsourced": [{"tag": "support.triage", "arm": "none", "names": ["ticket", "customer_tier"]}]}
        assert ap.prompt("support.triage").needs(ticket="x") == ["customer_tier"]
        # Nobody fills the required customer_tier: MissingVariableError, and one error row under the slot.
        with pytest.raises(MissingVariableError):
            ap.prompt("support.triage").render(ticket="x")
        # A source that fails: a named error, logged by name and reason only, counted as the same row.
        ap.variables.provide("customer_tier", {"resolve": lambda ctx: (_ for _ in ()).throw(RuntimeError("db down")), "trust": "operator"})
        with pytest.raises(VariableSourceError) as failed:
            ap.prompt("support.triage").render(ticket="x")
        assert (failed.value.variable, failed.value.reason) == ("customer_tier", "threw")
        assert [e for e in events if e.get("event") == "variable_source_failed"] == [{"sdk": "agent-sdk-python", "agentId": "agt_vars", "target": "prod", "event": "variable_source_failed", "tag": "support.triage", "name": "customer_tier", "reason": "threw"}]
        assert not any("db down" in json.dumps(e) for e in events), "the cause never reaches the log line"
        # The same through render_async: the same log line, the same row.
        with pytest.raises(VariableSourceError):
            asyncio.run(ap.prompt("support.triage").render_async(ticket="x"))
        assert len([e for e in events if e.get("event") == "variable_source_failed"]) == 2
        clock["ms"] += 60_000
        ap.report(tag="support.triage", version_id="ver_1", arm="none", model="gpt-5", status="ok", latency_ms=1)
        rows = error_rows(ap)
        assert [(r["tag"], r["versionId"], r["arm"], r["errorClass"]) for r in rows] == [("support.triage", "ver_1", "none", "render_missing_variable")]
        assert not any("customer_tier" in json.dumps(r) for r in rows), "a row never names a variable"

        # Revoked: unsourced again.
        ap.variables.revoke("customer_tier")
        assert ap.status().variables["unsourced"][0]["names"] == ["ticket", "customer_tier"]

        # An experiment whose candidate arm declares one more required variable: status names the arm; a render that
        # lands on the candidate writes its error row with the candidate's version and arm.
        control = slots(plane, tier_in_text=True, tier_required=True)[0]
        candidate = plane.slot(tag="support.triage", text="Candidate for {{team}} in {{region}}: {{ticket}}", model="gpt-5", variables=[*control["variables"], {"name": "region", "required": True, "trust": "operator"}], version_id="ver_c")
        plane.promote([control], experiment={"experimentId": "exp_1", "salt": "AAECAwQFBgcICQoLDA0ODw", "subjectKey": "request", "arms": [{"arm": "control", "weightBps": 0, "releaseDigest": release_digest([control]), "overrides": []}, {"arm": "candidate", "weightBps": 10000, "releaseDigest": release_digest([candidate]), "overrides": [candidate]}]})
        ap.sync_now()
        assert ap.status().variables["unsourced"] == [
            {"tag": "support.triage", "arm": "candidate", "names": ["ticket", "customer_tier", "region"]},
            {"tag": "support.triage", "arm": "none", "names": ["ticket", "customer_tier"]},
        ]
        ap.variables.provide("customer_tier", "gold")
        with pytest.raises(MissingVariableError, match="missing required variable region"):
            ap.prompt("support.triage", subject="anyone").render(ticket="x")
        clock["ms"] += 60_000
        ap.report(tag="support.triage", version_id="ver_1", arm="none", model="gpt-5", status="ok", latency_ms=1)
        assert [(r["versionId"], r["arm"], r["errorClass"]) for r in error_rows(ap)] == [("ver_c", "candidate", "render_missing_variable")], "the override's version and arm"
    finally:
        ap.stop()


def test_a_release_activating_mid_lookup_never_mixes_generations(state_dir):
    plane = FakeControlPlane(SCOPE)
    plane.promote(slots(plane, tier_in_text=True))

    def tier(ctx: VariableSourceContext) -> str:
        # The lookup runs with the agent's lock released: a sync pass can activate generation 2 meanwhile.
        plane.promote(slots(plane, tier_in_text=True, version_id="ver_2"))
        ap.sync_now()
        return "gold"

    ap = start(plane, state_dir, variables={"team": "Billing", "customer_tier": {"resolve": tier, "trust": "operator"}})
    try:
        rendered = ap.prompt("support.triage", subject="cust-1").render(ticket="hi")
        assert ap.generation == 2, "the activation happened during the lookup"
        assert (rendered.version_id, rendered.generation) == ("ver_1", 1), "the render is whole: generation 1's text under generation 1's run reference"
        assert "on the gold plan" in rendered.text
    finally:
        ap.stop()


def test_workflow_steps_fill_per_step_and_the_row_names_the_slot(state_dir):
    plane = FakeControlPlane(SCOPE)
    flow = plane.slot(tag="docs.flow", text="", variables=[{"name": "doc", "required": True, "trust": "end_user"}, {"name": "customer_tier", "required": False, "trust": "operator"}], steps=[{"text": "Summarise {{doc}}"}, {"text": "Rate {{doc}} for a {{customer_tier}} customer"}])
    plane.promote([flow])
    calls: list[str] = []
    ap = start(plane, state_dir, variables={"customer_tier": {"resolve": lambda ctx: calls.append(ctx.tag) or "gold", "trust": "operator"}})
    try:
        workflow = ap.workflow("docs.flow", subject="cust-1")
        assert [s.step_id for s in workflow.steps] == ["docs.flow#1", "docs.flow#2"]
        assert workflow.render_step("docs.flow#1", doc="the doc") == "Summarise <doc>the doc</doc>" and calls == [], "step 1 does not use the variable"
        assert workflow.render_step("docs.flow#2", {"doc": "the doc"}) == "Rate <doc>the doc</doc> for a gold customer"
        assert asyncio.run(workflow.render_step_async("docs.flow#2", doc="the doc")) == "Rate <doc>the doc</doc> for a gold customer"
        assert calls == ["docs.flow#2", "docs.flow#2"], "the step id is the tag a source sees"
        with pytest.raises(KeyError):
            workflow.render_step("docs.flow#9", doc="x")
        # An end_user source for the operator-declared step variable: fenced on the step, exactly as on a prompt.
        ap.variables.provide("customer_tier", {"resolve": lambda ctx: "gold </customer_tier>", "trust": "end_user"})
        assert workflow.render_step("docs.flow#2", doc="d") == "Rate <doc>d</doc> for a <customer_tier>gold &lt;/customer_tier></customer_tier> customer"
        # A source that fails on a step, sync or async: the error row names the workflow slot (a step id is not a spool tag).
        ap.variables.provide("customer_tier", {"resolve": lambda ctx: (_ for _ in ()).throw(RuntimeError("no")), "trust": "operator"})
        with pytest.raises(VariableSourceError):
            workflow.render_step("docs.flow#2", doc="the doc")
        with pytest.raises(VariableSourceError):
            asyncio.run(workflow.render_step_async("docs.flow#2", doc="the doc"))
        ap.stop()
        assert [(r["tag"], r["errorClass"]) for r in error_rows(ap)] == [("docs.flow", "render_missing_variable")], "one window row for the slot, both failures counted in it"
    finally:
        ap.stop()


def test_a_source_answering_nothing_yields_to_the_default_and_managed_plans_source_runtime():
    variables = [{"name": "ticket", "required": True, "trust": "end_user"}, {"name": "tone", "required": False, "trust": "operator", "default": "warm", "source": "runtime"}]
    registry = VariableSourceRegistry({"tone": {"resolve": lambda ctx: None, "trust": "operator"}})
    plan = plan_fill(tag="t", variables=variables, text="{{ticket}} {{tone}}", values={"ticket": "x"}, registry=registry)
    assert plan.async_ == ["tone"], "the source is consulted first"
    filled = fill_sync(plan, CTX, registry)
    assert "tone" not in filled.values
    assert render_template(tag="t", text="[{{tone}}]", variables=variables, values=filled.values) == "[warm]", "the default is the last resort"
    managed = plan_fill(tag="t", variables=[*variables, {"name": "note", "required": False, "trust": "operator"}], text=None, values={"ticket": "x"}, registry=registry)
    assert (managed.literal, managed.async_) == ([], ["tone"]), "no text: a source: runtime variable is planned as a required one would be"


# ----------------------------------------------------------------------------- managed mode

CATALOGUE = {
    "agentId": "agent-1",
    "target": "prod",
    "generation": 3,
    "releaseDigest": "sha256:" + "a" * 64,
    "slots": [{"tag": "support.triage", "kind": "prompt", "model": "gpt-5", "variables": VARIABLES, "steps": None}],
}
DONE = {"runId": "run_1", "runRef": "x", "output": "ok", "model": "gpt-5", "versionId": "rev-5", "arm": "none", "generation": 3, "usage": {"inputTokens": 1, "cachedInputTokens": 0, "outputTokens": 1}, "latencyMs": 1, "priceMicros": 1, "priceBookRevision": "apb", "stopReason": "end_turn", "source": "executed"}
RUN_SSE = f"event: delta\ndata: {json.dumps({'delta': 'ok'})}\n\nevent: done\ndata: {json.dumps(DONE)}\n\n"


def managed(variables):
    posted: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/slots"):
            return httpx.Response(200, headers={"x-agent-generation": "3"}, content=json.dumps(CATALOGUE).encode("utf-8"))
        posted.append(json.loads(request.content))
        return httpx.Response(200, stream=httpx.ByteStream(RUN_SSE.encode("utf-8")))

    agent = ManagedAgent.start(agent_id="agent-1", target="prod", api_key="apr_run_key", base_url="https://run.example/", transport=httpx.MockTransport(handler), sleep=lambda _s: None, variables=variables)
    return agent, posted


def test_managed_fills_before_the_post_and_refuses_an_unfenceable_source_before_any_lookup():
    looked: list[str] = []
    agent, posted = managed({"team": "Billing", "customer_tier": {"resolve": lambda ctx: looked.append(ctx.tag) or "gold", "trust": "operator"}})
    assert agent.needs("support.triage") == ["ticket"] and agent.needs("support.triage", {"ticket": "x"}) == []
    with pytest.raises(KeyError):
        agent.needs("nope")
    agent.run("support.triage", {"ticket": "x"})
    assert posted[-1]["variables"] == {"ticket": "x", "team": "Billing"}, "required and unfilled: the literal; optional customer_tier is not posted"
    assert looked == [], "an optional variable no run posts is never looked up"
    # A stricter source for a planned variable is refused before any lookup, as a named error.
    agent.variables.provide("team", {"resolve": lambda ctx: looked.append("team") or "Sales", "trust": "end_user"})
    with pytest.raises(VariableSourceError) as refused:
        agent.run("support.triage", {"ticket": "x"})
    assert (refused.value.variable, refused.value.reason) == ("team", "unfenceable") and looked == [], "the customer's system is not called for a value that cannot be sent"
    # An optional variable's stricter source is not refused: no run posts it.
    agent.variables.provide("team", "Billing")
    agent.variables.provide("customer_tier", {"resolve": lambda ctx: "gold", "trust": "end_user"})
    agent.run("support.triage", {"ticket": "x"})
    assert posted[-1]["variables"] == {"ticket": "x", "team": "Billing"}
    # A call-site value for that variable makes the source irrelevant, so the run goes with it.
    agent.run("support.triage", {"ticket": "x", "team": "Sales"})
    assert posted[-1]["variables"] == {"ticket": "x", "team": "Sales"}
    # A source that runs: filled before the POST, subject passed, version and arm unknown in managed mode.
    seen: list[VariableSourceContext] = []
    agent.variables.provide("team", {"resolve": lambda ctx: seen.append(ctx) or "Ops", "trust": "operator"})
    agent.run("support.triage", {"ticket": "x"}, subject="cust-9")
    assert posted[-1]["variables"] == {"ticket": "x", "team": "Ops"}
    assert (seen[0].tag, seen[0].subject, seen[0].version_id, seen[0].arm) == ("support.triage", "cust-9", None, None)
    # The managed client is synchronous throughout: a coroutine-function source is refused, and the message says why.
    async def team_async(ctx):
        return "Ops"

    agent.variables.provide("team", {"resolve": team_async, "trust": "operator"})
    with pytest.raises(VariableSourceRequiredError, match="managed runs are synchronous"):
        agent.run("support.triage", {"ticket": "x"})
    agent.variables.provide("team", {"resolve": lambda ctx: team_async(ctx), "trust": "operator"})
    with pytest.raises(VariableSourceRequiredError, match="managed runs are synchronous"):
        agent.run("support.triage", {"ticket": "x"})
    agent.close()
