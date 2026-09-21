"""0.3.5 pins.md: the customer's own copy of a release (``MirrorPort``), materialised once, rendered from once
written, its seal recomputed each tick with core's ``verify_seal``. Beside the store tests: the store is the
VERIFIED copy, the mirror is the CUSTOMER's copy, and the seal is the bridge between them. Two-slot fixtures
throughout, so a materialise that touches only what changed is distinguishable from one that touches everything.
"""

from __future__ import annotations

import base64
import shutil
import tempfile
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import pytest

from airprompter_agent.agent import AirPrompterAgent, SyncOptions
from airprompter_agent.mirror import MirrorCopy, seal_for_heartbeat
from airprompter_agent_core.protocol.seal import seal_id_of
from airprompter_agent_core.protocol.trust import public_jwk_of

from .control_plane import FakeControlPlane

SCOPE = {"organizationId": "org_1", "agentId": "agt_mirror", "target": "prod"}
KW = {"organization_id": "org_1", "agent_id": "agt_mirror", "target": "prod"}


def slots(plane: FakeControlPlane, marker: str):
    return [
        plane.slot(tag="support.triage", text=f"Triage {marker} {{{{ticket}}}}.", variables=[{"name": "ticket", "required": True, "trust": "operator"}]),
        plane.slot(tag="support.reply", text=f"Reply {marker} to {{{{name}}}}.", variables=[{"name": "name", "required": False, "trust": "operator"}], model="gpt-5"),
    ]


class InMemoryMirrorPort:
    """An in-memory ``MirrorPort``: a test edits ``.stored`` directly to simulate drift, and counts writes/reads."""

    def __init__(self) -> None:
        self.stored: Optional[MirrorCopy] = None
        self.writes = 0
        self.reads = 0
        self.resync_requests: list[dict[str, Any]] = []
        self.throw_on_read = False

    def read(self) -> Optional[MirrorCopy]:
        self.reads += 1
        if self.throw_on_read:
            raise RuntimeError("store unreachable")
        if self.stored is None:
            return None
        return MirrorCopy(seal_id=self.stored.seal_id, pins=[dict(p) for p in self.stored.pins], texts=dict(self.stored.texts))

    def write(self, copy: MirrorCopy) -> None:
        self.writes += 1
        self.stored = MirrorCopy(seal_id=copy.seal_id, pins=[dict(p) for p in copy.pins], texts=dict(copy.texts))

    def on_resync_requested(self, request: dict[str, Any]) -> None:
        self.resync_requests.append({"sealId": request["sealId"]})


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
    path = tempfile.mkdtemp(prefix="ap-mirror-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


def _text_of(port: InMemoryMirrorPort, content_hash: str) -> str:
    encoded = port.stored.texts[content_hash]
    padded = encoded + "=" * (-len(encoded) % 4)
    return base64.urlsafe_b64decode(padded).decode("utf-8")


def _set_text(port: InMemoryMirrorPort, content_hash: str, text: str) -> None:
    port.stored.texts[content_hash] = base64.urlsafe_b64encode(text.encode("utf-8")).decode("ascii").rstrip("=")


def test_materialise_once(state_dir):
    """The mirror writes the release's two pins and their texts on registration; a second tick writes nothing
    more."""
    plane = FakeControlPlane(SCOPE)
    t, r = slots(plane, "A")
    plane.promote([t, r])
    ap = start(plane, state_dir)
    port = InMemoryMirrorPort()
    try:
        handle = ap.mirror(port)
        handle.refresh()
        assert port.writes == 1, "materialised once"
        assert len(port.stored.pins) == 2, "both slots"
        assert len(port.stored.texts) == 2, "both texts"

        ap.sync_now()
        assert port.writes == 1, "a second tick with nothing new writes nothing more"
    finally:
        ap.stop()


def test_a_tampered_text_breaks_the_seal(state_dir):
    """intact is false, changed_tags names the tag, broken_at is stamped once, render reads the edited text,
    seal_broken is logged once."""
    plane = FakeControlPlane(SCOPE)
    t, r = slots(plane, "A")
    plane.promote([t, r])
    events = []
    ap = start(plane, state_dir, logger=events.append)
    port = InMemoryMirrorPort()
    try:
        handle = ap.mirror(port)
        handle.refresh()
        assert port.writes == 1

        # Edit one byte of the triage slot's text in the port's own store.
        triage_pin = next(p for p in port.stored.pins if p["tag"] == "support.triage")
        original = _text_of(port, triage_pin["contentHash"])
        _set_text(port, triage_pin["contentHash"], original.replace("A", "X"))

        ap.sync_now()  # reconciles the mirror; the tick itself changes nothing content-wise.
        report = ap.seal()
        assert report.intact is False
        assert report.changed_tags == ["support.triage"]
        assert report.broken_at, "broken_at stamped"
        assert port.writes == 1, "the write count did not move — a broken copy is never overwritten"

        rendered = ap.prompt("support.triage").render(ticket="t")
        assert rendered.text == "Triage X t.", "renders the EDITED text — the mirror is the source of truth, drift is reported not blocking"
        assert rendered.resolution_source == "customer_store"

        ap.heartbeat_now()
        hb = plane.heartbeats[-1]
        seal_member = hb.get("seal")
        assert seal_member is not None and seal_member["intact"] is False
        assert seal_member.get("brokenAt"), "the heartbeat carries brokenAt"

        assert len([e for e in events if e.get("event") == "seal_broken"]) == 1, "seal_broken logged exactly once across the ticks above"
    finally:
        ap.stop()


def test_settings_drift_and_missing_slot_named_by_tag(state_dir):
    plane = FakeControlPlane(SCOPE)
    t, r = slots(plane, "A")
    plane.promote([t, r])
    ap = start(plane, state_dir)
    port = InMemoryMirrorPort()
    try:
        handle = ap.mirror(port)
        handle.refresh()

        # A settings change on the reply pin, text untouched.
        reply_pin = next(p for p in port.stored.pins if p["tag"] == "support.reply")
        reply_pin["model"] = "gpt-6"
        handle.refresh()
        report = ap.seal()
        assert report.intact is False
        assert report.changed_tags == ["support.reply"]

        # Remove the triage slot from the copy entirely.
        reply_pin["model"] = "gpt-5"  # heal the settings drift first
        port.stored.pins = [p for p in port.stored.pins if p["tag"] != "support.triage"]
        handle.refresh()
        report = ap.seal()
        assert report.intact is False
        assert report.changed_tags == ["support.triage"]
    finally:
        ap.stop()


def test_new_release_activates_while_mirror_broken(state_dir):
    """The copy is untouched, the heartbeat's active digest moves but the seal member still names the old, broken
    release."""
    plane = FakeControlPlane(SCOPE)
    ta, ra = slots(plane, "A")
    manifest_a = plane.promote([ta, ra])
    ap = start(plane, state_dir)
    port = InMemoryMirrorPort()
    try:
        handle = ap.mirror(port)
        handle.refresh()
        triage_pin = next(p for p in port.stored.pins if p["tag"] == "support.triage")
        _set_text(port, triage_pin["contentHash"], "tampered")
        ap.seal()

        tb, rb = slots(plane, "B")
        manifest_b = plane.promote([tb, rb])
        ap.sync_now()
        assert ap.status().generation == manifest_b["payload"]["generation"], "the new release IS active"
        assert port.writes == 1, "the mirror copy was never overwritten while broken"

        ap.heartbeat_now()
        hb = plane.heartbeats[-1]
        assert hb.get("activeReleaseDigest") == manifest_b["payload"]["releaseDigest"], "active digest is the NEW release"
        seal_member = hb.get("seal")
        assert seal_member is not None and seal_member["sealId"] == seal_id_of(manifest_a["payload"]["releaseDigest"]), "the seal member still names the OLD release the broken copy was written for"
    finally:
        ap.stop()


def test_resync_writes_heals_and_is_logged(state_dir):
    """resync(approved_by=...) writes, heals and is logged with approved_by; seal_intact fires once."""
    plane = FakeControlPlane(SCOPE)
    t, r = slots(plane, "A")
    plane.promote([t, r])
    events = []
    ap = start(plane, state_dir, logger=events.append)
    port = InMemoryMirrorPort()
    try:
        handle = ap.mirror(port)
        handle.refresh()
        triage_pin = next(p for p in port.stored.pins if p["tag"] == "support.triage")
        _set_text(port, triage_pin["contentHash"], "tampered")
        handle.refresh()
        assert ap.seal().intact is False

        report = handle.resync(approved_by="ops@acme")
        assert report.intact is True
        assert port.writes == 2, "resync wrote once more"
        assert any(e.get("event") == "mirror_resynced" and e.get("approvedBy") == "ops@acme" for e in events)
        assert len([e for e in events if e.get("event") == "seal_intact"]) == 1, "seal_intact logged once on heal"
    finally:
        ap.stop()


def test_port_read_throws_falls_back_to_store(state_dir):
    """A port whose read() raises: render falls back to the store, resolution_source is "store", mirror_unreadable
    is logged."""
    plane = FakeControlPlane(SCOPE)
    t, r = slots(plane, "A")
    plane.promote([t, r])
    events = []
    ap = start(plane, state_dir, logger=events.append)
    port = InMemoryMirrorPort()
    port.throw_on_read = True
    try:
        handle = ap.mirror(port)
        handle.refresh()
        rendered = ap.prompt("support.triage").render(ticket="t")
        assert rendered.text == "Triage A t."
        assert rendered.resolution_source == "store"
        assert any(e.get("event") == "mirror_unreadable" for e in events)
        assert port.writes == 0, "never wrote — the port never became readable"
    finally:
        ap.stop()


def test_request_resync_directive_notifies_once(state_dir):
    """A request_resync directive notifies the mirror's on_resync_requested once — nothing is written. Pinned, so
    the active (pinned) release never changes — isolating the directive's effect from the unrelated "a new
    release activated, materialise it" rule a live promotion would otherwise also trigger."""
    plane = FakeControlPlane(SCOPE)
    ta, ra = slots(plane, "A")
    manifest_a = plane.promote([ta, ra])
    seal_a = seal_id_of(manifest_a["payload"]["releaseDigest"])
    ap = start(plane, state_dir, release=seal_a)
    port = InMemoryMirrorPort()
    try:
        handle = ap.mirror(port)
        handle.refresh()
        writes_before = port.writes

        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        later = (datetime.now(timezone.utc) + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        tb, rb = slots(plane, "B")
        plane.promote([tb, rb], directives=[{"kind": "request_resync", "releaseDigest": manifest_a["payload"]["releaseDigest"], "requestedBy": "ops@acme", "requestedAt": now, "expiresAt": later}])
        ap.sync_now()

        assert len(port.resync_requests) == 1, "on_resync_requested called once"
        assert port.resync_requests[0]["sealId"] == seal_a
        assert port.writes == writes_before, "nothing written — the pinned content never changed and the directive is informational only"
        assert ap.prompt("support.triage").render(ticket="t").text == "Triage A t.", "the pinned content is untouched"

        # A second tick with the same directive still riding the manifest does not re-announce it.
        tc, rc = slots(plane, "C")
        plane.promote([tc, rc], directives=[{"kind": "request_resync", "releaseDigest": manifest_a["payload"]["releaseDigest"], "requestedBy": "ops@acme", "requestedAt": now, "expiresAt": later}])
        ap.sync_now()
        assert len(port.resync_requests) == 1, "deduped — the same (releaseDigest, requestedAt) pair riding a later manifest is not re-announced"
    finally:
        ap.stop()


def test_restart_replaces_self_consistent_copy(state_dir):
    """F6 (positive): after a restart, a copy this SDK wrote for release A — now stale against B — is replaced on
    the seal it already carries, with no false seal_broken. Beside the tamper case: the pair proves the SDK
    overwrites only what it wrote."""
    plane = FakeControlPlane(SCOPE)
    ta, ra = slots(plane, "A")
    manifest_a = plane.promote([ta, ra])
    port = InMemoryMirrorPort()  # the customer's own store — the SAME object survives the "restart" below.

    ap1 = start(plane, state_dir)
    try:
        handle1 = ap1.mirror(port)
        handle1.refresh()
        assert port.writes == 1, "materialised for A"
        assert port.stored.seal_id == seal_id_of(manifest_a["payload"]["releaseDigest"])
    finally:
        ap1.stop()

    # Promote B on the plane — this happens while nothing is running, the way a real deploy would.
    tb, rb = slots(plane, "B")
    manifest_b = plane.promote([tb, rb])

    # "Restart": a FRESH AirPrompterAgent (_mirror_materialised_for starts None again), same store dir, same port object.
    events = []
    ap2 = start(plane, state_dir, logger=events.append)
    try:
        ap2.sync_now()
        assert ap2.status().generation == manifest_b["payload"]["generation"], "active is now B"

        handle2 = ap2.mirror(port)
        handle2.refresh()

        assert port.stored.seal_id == seal_id_of(manifest_b["payload"]["releaseDigest"]), "the port's copy was replaced for B"
        assert any(e.get("event") == "mirror_updated" and e.get("sealId") == seal_id_of(manifest_b["payload"]["releaseDigest"]) for e in events), f"expected mirror_updated for B, got {[e.get('event') for e in events]}"
        assert not any(e.get("event") == "seal_broken" for e in events), "no false seal_broken across the restart"
        assert ap2.seal().intact is True
    finally:
        ap2.stop()


def test_restart_leaves_edited_copy_untouched(state_dir):
    """F6 (negative): after a restart, a copy edited between the two runs is left exactly as it is — seal_broken
    fires, the port is never rewritten."""
    plane = FakeControlPlane(SCOPE)
    ta, ra = slots(plane, "A")
    manifest_a = plane.promote([ta, ra])
    port = InMemoryMirrorPort()

    ap1 = start(plane, state_dir)
    try:
        handle1 = ap1.mirror(port)
        handle1.refresh()
        assert port.writes == 1
    finally:
        ap1.stop()

    # Tamper the port's own copy while nothing is running — same one-byte edit the earlier tampered-text test uses.
    triage_pin = next(p for p in port.stored.pins if p["tag"] == "support.triage")
    original = _text_of(port, triage_pin["contentHash"])
    _set_text(port, triage_pin["contentHash"], original.replace("A", "X"))
    edited_seal_id = port.stored.seal_id
    edited_text = port.stored.texts[triage_pin["contentHash"]]

    tb, rb = slots(plane, "B")
    manifest_b = plane.promote([tb, rb])

    events = []
    ap2 = start(plane, state_dir, logger=events.append)
    try:
        ap2.sync_now()
        assert ap2.status().generation == manifest_b["payload"]["generation"], "active is now B"

        handle2 = ap2.mirror(port)
        handle2.refresh()

        assert any(e.get("event") == "seal_broken" for e in events), f"expected seal_broken, got {[e.get('event') for e in events]}"
        assert not any(e.get("event") == "mirror_updated" for e in events), "never treated as safe to replace"
        assert port.stored.seal_id == edited_seal_id, "the port's copy is untouched — still A's sealId"
        assert port.stored.texts[triage_pin["contentHash"]] == edited_text, "the edited text is untouched"
        assert ap2.seal().intact is False
    finally:
        ap2.stop()


def test_seal_for_heartbeat_slices_changed_tags_to_64():
    """F4: seal_for_heartbeat slices changed_tags to 64 (the heartbeat schema's cap) without touching the full
    report."""
    from airprompter_agent.mirror import SealReport

    changed_tags = [f"tag.{i:03d}" for i in range(65)]
    report = SealReport(seal_id="seal_1", observed_digest="sha256:abc", intact=False, checked_at="2026-09-21T00:00:00Z", broken_at="2026-09-21T00:00:00Z", changed_tags=changed_tags)

    sliced = seal_for_heartbeat(report)
    assert len(sliced.changed_tags) == 64, "sliced to the schema's maxItems"
    assert sliced.changed_tags == changed_tags[:64], "deterministic cut — already sorted, so the first 64 survive"
    assert len(report.changed_tags) == 65, "the original report (what seal_broken logs) is untouched"

    # The "absent, never empty" rule: a report with no changed_tags stays that way through the helper.
    clean = SealReport(seal_id="seal_2", observed_digest="sha256:def", intact=True, checked_at="2026-09-21T00:00:00Z")
    assert seal_for_heartbeat(clean).changed_tags is None, "absent stays absent, never becomes an empty list"

    # Exactly at the cap: untouched.
    exact = SealReport(seal_id=report.seal_id, observed_digest=report.observed_digest, intact=report.intact, checked_at=report.checked_at, broken_at=report.broken_at, changed_tags=changed_tags[:64])
    assert len(seal_for_heartbeat(exact).changed_tags) == 64
