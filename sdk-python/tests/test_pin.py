"""0.3.5 pins.md: a pinned runtime renders the named seal while the pointer moves on; live control (directives,
lease, onLeaseExpiry) still reaches it from the environment's live manifest; the platform's five seal refusals
surface as ``pin_refused``; ``unpin()`` re-bases without a false rollback refusal. Two-slot fixtures throughout, so
"did everything" is distinguishable from "did nothing more" (same discipline as ``test_agent.py``).
"""

from __future__ import annotations

import shutil
import tempfile

import pytest

from airprompter_agent.agent import AgentStartError, AirPrompterAgent, RenderRefusedError, SyncOptions
from airprompter_agent_core.protocol.seal import seal_id_of
from airprompter_agent_core.protocol.trust import public_jwk_of
from airprompter_agent_sync.sync.pin import merge_live_control, read_pin_file

from .control_plane import FakeControlPlane

SCOPE = {"organizationId": "org_1", "agentId": "agt_pin", "target": "prod"}
KW = {"organization_id": "org_1", "agent_id": "agt_pin", "target": "prod"}


def slots(plane: FakeControlPlane, marker: str):
    """Two slots, their text carrying ``marker`` so two promotions are distinguishable by their rendered output."""
    return [
        plane.slot(tag="support.triage", text=f"Triage {marker} {{{{ticket}}}}.", variables=[{"name": "ticket", "required": True, "trust": "operator"}]),
        plane.slot(tag="support.reply", text=f"Reply {marker} to {{{{name}}}}.", variables=[{"name": "name", "required": False, "trust": "operator"}], model="gpt-5"),
    ]


def start(plane: FakeControlPlane, state_dir: str, **extra):
    options = {
        **KW,
        "api_key": plane.api_key,
        "base_url": "https://api.test",
        "state_dir": state_dir,
        "root": {"pinned": public_jwk_of(plane.root_key)},
        "sync": SyncOptions(mode="resident", poll_seconds=3600, edge_pointer_url="https://edge.test/g/token/generation.json", root_url="https://edge.test/roots/prod/root.json"),
        "transport": plane.transport(),
        "telemetry": {"upload": False},
    }
    options.update(extra)
    return AirPrompterAgent.start(**options)


@pytest.fixture
def state_dir():
    path = tempfile.mkdtemp(prefix="ap-pin-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


def test_a_pinned_runtime_renders_the_named_seal_while_the_pointer_moves_on(state_dir):
    plane = FakeControlPlane(SCOPE)
    ta, ra = slots(plane, "A")
    manifest_a = plane.promote([ta, ra])
    digest_a = manifest_a["payload"]["releaseDigest"]
    seal_a = seal_id_of(digest_a)

    ap = start(plane, state_dir, release=seal_a)
    try:
        assert ap.prompt("support.triage").render(ticket="t1").text == "Triage A t1.", "renders A's text"
        assert ap.release_info() == {"seal_id": seal_a, "release_digest": digest_a, "generation": manifest_a["payload"]["generation"], "pinned": True}

        # The fake seals at 0.3.5 by default: the heartbeat carries pinnedReleaseDigest.
        ap.heartbeat_now()
        hb1 = plane.heartbeats[-1]
        assert hb1.get("pinnedReleaseDigest") == digest_a, "0.3.5-sealed: pinnedReleaseDigest is reported"

        # Promote B (the pointer moves) and tick: the pin still renders A.
        tb, rb = slots(plane, "B")
        plane.promote([tb, rb])
        ap.sync_now()
        assert ap.prompt("support.triage").render(ticket="t2").text == "Triage A t2.", "still A after B is promoted"
        assert ap.status().pinned_release == seal_a

        # Promote C and tick again: the pointer moves a second time, the pin still holds.
        tc, rc = slots(plane, "C")
        plane.promote([tc, rc])
        ap.sync_now()
        assert ap.prompt("support.triage").render(ticket="t3").text == "Triage A t3.", "still A after C is promoted"
        assert ap.status().pinned_release == seal_a
    finally:
        ap.stop()


def test_a_pinned_runtime_sealed_at_0_3_4_does_not_report_pinned_release_digest(state_dir):
    """The gate an older service would refuse over."""
    plane = FakeControlPlane(SCOPE)
    ta, ra = slots(plane, "A")
    manifest_a = plane.promote([ta, ra], protocol="0.3.4")
    seal_a = seal_id_of(manifest_a["payload"]["releaseDigest"])
    ap = start(plane, state_dir, release=seal_a)
    try:
        ap.heartbeat_now()
        hb = plane.heartbeats[-1]
        assert "pinnedReleaseDigest" not in hb, "0.3.4-sealed: no pinnedReleaseDigest"
    finally:
        ap.stop()


def test_live_control_reaches_a_pinned_runtime(state_dir):
    """A live disable directive refuses render while the pin still names A; a live lease and onLeaseExpiry halt
    after it lapses."""
    plane = FakeControlPlane(SCOPE)
    ta, ra = slots(plane, "A")
    manifest_a = plane.promote([ta, ra])
    seal_a = seal_id_of(manifest_a["payload"]["releaseDigest"])
    clock = {"ms": 1789948800000.0}  # 2026-09-21T00:00:00Z
    ap = start(plane, state_dir, release=seal_a, now=lambda: clock["ms"])
    try:
        assert ap.prompt("support.triage").render(ticket="t1").text == "Triage A t1."

        # A live promotion carrying a `disable` directive (scope agent) — the pointer moves, so the pass adopts it.
        tb, rb = slots(plane, "B")
        plane.promote([tb, rb], directives=[{"kind": "disable", "scope": "agent", "issuedAt": "2026-09-21T00:00:00.000Z"}])
        ap.sync_now()
        with pytest.raises(RenderRefusedError):
            ap.prompt("support.triage").render(ticket="t2")
        assert ap.release_info()["seal_id"] == seal_a, "the pin still names A even while disabled"

        # A live promotion with a short lease and onLeaseExpiry: halt.
        tc, rc = slots(plane, "C")
        plane.promote([tc, rc], lease_seconds=1, on_lease_expiry="halt")
        ap.sync_now()
        clock["ms"] += 2000
        health = ap.healthz()
        assert health["ok"] is False
        assert health["status"] == "failing"
        assert "lease_expired_halt" in health["reasons"], f"expected lease_expired_halt, got {health['reasons']}"
    finally:
        ap.stop()


def test_no_pointer_pinned_runtime_still_adopts_live_control(state_dir):
    """F1: a pinned runtime with NO edge_pointer_url still re-reads live control on every pass — a live disable
    directive reaches it, live_control_adopted is logged with the new generation, and the pinned content still
    names A. Beside the sibling sync-loop tests: together they pin that the pointer's silence never decides pinned
    content AND its absence never silences control."""
    plane = FakeControlPlane(SCOPE)
    ta, ra = slots(plane, "A")
    manifest_a = plane.promote([ta, ra])
    seal_a = seal_id_of(manifest_a["payload"]["releaseDigest"])
    events = []
    # No edge_pointer_url — a root_url-only pinned runtime (the shape F1 targets): `pointer_moved` inside
    # `_sync_pinned` is set purely from the edge pointer today, so this config never had anything to flip it to
    # true after the first activation.
    ap = start(
        plane,
        state_dir,
        release=seal_a,
        sync=SyncOptions(mode="resident", poll_seconds=3600, root_url="https://edge.test/roots/prod/root.json"),
        logger=events.append,
    )
    try:
        assert ap.prompt("support.triage").render(ticket="t1").text == "Triage A t1.", "renders A's text at start"

        # A live promotion carrying a `disable` directive — no pointer to notice it moved, but the fix means this
        # pinned pass reads the live manifest anyway.
        tb, rb = slots(plane, "B")
        manifest_b = plane.promote([tb, rb], directives=[{"kind": "disable", "scope": "agent", "issuedAt": "2026-09-21T00:00:00.000Z"}])
        ap.sync_now()

        with pytest.raises(RenderRefusedError):
            ap.prompt("support.triage").render(ticket="t2")
        assert ap.release_info()["seal_id"] == seal_a, "the pinned content still names A"
        assert any(e.get("event") == "live_control_adopted" and e.get("generation") == manifest_b["payload"]["generation"] for e in events), (
            f"expected live_control_adopted at generation {manifest_b['payload']['generation']}, got {[(e.get('event'), e.get('generation')) for e in events]}"
        )
    finally:
        ap.stop()


def test_pin_refusals_seal_invalid_and_release_unknown(state_dir):
    """An invalid grammar is seal_invalid; an unknown but well-formed digest is release_unknown."""
    plane1 = FakeControlPlane(SCOPE)
    t1, r1 = slots(plane1, "A")
    plane1.promote([t1, r1])
    events1 = []
    with pytest.raises(AgentStartError) as raised1:
        start(plane1, state_dir, release="abc", logger=events1.append)
    assert raised1.value.code == "no_verified_release", "too short to be a seal: never activates"
    assert any(e.get("event") == "pin_refused" and e.get("code") == "seal_invalid" for e in events1), f"expected pin_refused seal_invalid, got {[e.get('event') for e in events1]}"

    other_state_dir = tempfile.mkdtemp(prefix="ap-pin-")
    try:
        plane2 = FakeControlPlane(SCOPE)
        t2, r2 = slots(plane2, "A")
        plane2.promote([t2, r2])
        events2 = []
        unknown_digest = "0" * 12
        with pytest.raises(AgentStartError) as raised2:
            start(plane2, other_state_dir, release=unknown_digest, logger=events2.append)
        assert raised2.value.code == "no_verified_release", "well-formed but never sealed: never activates"
        assert any(e.get("event") == "pin_refused" and e.get("code") == "release_unknown" for e in events2), f"expected pin_refused release_unknown, got {[e.get('event') for e in events2]}"
    finally:
        shutil.rmtree(other_state_dir, ignore_errors=True)


def test_unpin_rebases_past_stale_store_generation(state_dir):
    """Pinned to A while the store's own counter was already at C's generation (from before the pin); unpin()
    activates the pointer's release without a false generation_rollback; pin.json is gone."""
    plane = FakeControlPlane(SCOPE)
    ta, ra = slots(plane, "A")
    manifest_a = plane.promote([ta, ra])
    seal_a = seal_id_of(manifest_a["payload"]["releaseDigest"])
    tb, rb = slots(plane, "B")
    plane.promote([tb, rb])
    tc, rc = slots(plane, "C")
    manifest_c = plane.promote([tc, rc])

    # First, unpinned: sync all the way to C — the store's own generation counter is now C's.
    ap1 = start(plane, state_dir)
    ap1.sync_now()
    assert ap1.status().generation == manifest_c["payload"]["generation"]
    ap1.stop()

    # Restart the SAME store, pinned to A (older than what the store's counter holds) — the first pinned sync
    # forces past it (forced_downgrade).
    ap2 = start(plane, state_dir, release=seal_a)
    ap2.sync_now()
    assert ap2.prompt("support.triage").render(ticket="t").text == "Triage A t.", "pinned to A over a store that held C"
    assert ap2.status().forced_downgrade is True, "the store recorded the forced downgrade past C"
    ap2.stop()

    # Restart once more, unpinned (as unpin() would leave it) — the pointer's current release (C) activates, and it
    # must never be refused as a rollback merely because A was below it.
    ap3 = start(plane, state_dir)
    # An initial pass under the resumed pin settles first, so the explicit unpin() below is never raced by one
    # already in flight under the old pin.
    ap3.sync_now()
    ap3.unpin()
    ap3.sync_now()
    try:
        assert ap3.prompt("support.triage").render(ticket="t").text == "Triage C t.", "unpinned: renders the pointer's current release (C)"
        assert ap3.status().generation == manifest_c["payload"]["generation"]
        assert ap3.release_info()["pinned"] is False
        assert ap3.status().last_refusal is None, "no generation_rollback on the first unpinned pass"
        assert read_pin_file(None, state_dir, SCOPE["agentId"], SCOPE["target"]) is None, "pin.json is gone"
    finally:
        ap3.stop()


def test_unpin_rebases_past_a_refused_pass(state_dir):
    """F3: unpin re-bases past a refused pass — a payload_missing refusal on the first post-unpin pointer pass
    leaves the re-base pending, so the very next sync_now() still activates the pointer's release, with no false
    generation_rollback logged along the way."""
    plane = FakeControlPlane(SCOPE)
    ta, ra = slots(plane, "A")
    manifest_a = plane.promote([ta, ra])
    seal_a = seal_id_of(manifest_a["payload"]["releaseDigest"])
    tb, rb = slots(plane, "B")
    plane.promote([tb, rb])
    tc, rc = slots(plane, "C")
    manifest_c = plane.promote([tc, rc])

    ap1 = start(plane, state_dir)
    ap1.sync_now()
    assert ap1.status().generation == manifest_c["payload"]["generation"]
    ap1.stop()

    ap2 = start(plane, state_dir, release=seal_a)
    ap2.sync_now()
    assert ap2.status().forced_downgrade is True
    ap2.stop()

    events = []
    ap3 = start(plane, state_dir, logger=events.append)
    ap3.sync_now()
    ap3.unpin()
    try:
        # The first post-unpin pass must fetch C's payload fresh — ap3's in-memory active release is still A, so
        # C's bytes are not held and the pass goes to the network for them. Withhold it: this pass refuses
        # payload_missing, and before the fix, that refusal wrongly cleared the pending re-base.
        plane.withhold_payloads.add(tc["contentHash"])
        ap3.sync_now()
        assert ap3.status().generation == manifest_a["payload"]["generation"], "still A: the refused pass never activated anything"
        assert any(e.get("event") == "sync_refused" and e.get("reason") == "payload_missing" for e in events), f"expected a payload_missing sync_refused, got {[(e.get('event'), e.get('reason')) for e in events]}"

        # Restore the payload and retry — the re-base must still be pending, so this pass activates C exactly as
        # the sibling test's single, uninterrupted pass does.
        plane.withhold_payloads.discard(tc["contentHash"])
        ap3.sync_now()
        assert ap3.prompt("support.triage").render(ticket="t").text == "Triage C t.", "the second pass activates the pointer's release (C)"
        assert ap3.status().generation == manifest_c["payload"]["generation"]
        assert not any(e.get("event") == "sync_refused" and e.get("reason") == "generation_rollback" for e in events), f"expected no generation_rollback anywhere, got {[(e.get('event'), e.get('reason')) for e in events]}"
    finally:
        ap3.stop()


def test_merge_live_control_content_pinned_control_live():
    """control (directives, lease, onLeaseExpiry, requireCountersign, unlockWindow) comes from live; content
    (slots, generation, releaseDigest) stays pinned."""
    plane = FakeControlPlane(SCOPE)
    ta, ra = slots(plane, "A")
    pinned = plane.promote([ta, ra], lease_seconds=111, on_lease_expiry="degrade")
    tb, rb = slots(plane, "B")
    live = plane.promote([tb, rb], lease_seconds=222, on_lease_expiry="halt", directives=[{"kind": "disable", "scope": "agent", "issuedAt": "2026-09-21T00:00:00.000Z"}])

    merged = merge_live_control(pinned, live)
    assert merged["payload"]["slots"] == pinned["payload"]["slots"], "content stays pinned's"
    assert merged["payload"]["generation"] == pinned["payload"]["generation"], "generation stays pinned's"
    assert merged["payload"]["releaseDigest"] == pinned["payload"]["releaseDigest"], "releaseDigest stays pinned's"
    assert merged["payload"]["leaseSeconds"] == 222, "lease comes from live"
    assert merged["payload"]["onLeaseExpiry"] == "halt", "onLeaseExpiry comes from live"
    assert merged["payload"]["directives"] == live["payload"]["directives"], "directives come from live"
    assert merged["signatures"] == pinned["signatures"], "the signature is the pinned envelope's own — this view is never re-verified or stored"
