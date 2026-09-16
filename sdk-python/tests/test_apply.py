"""T9 apply control on the runtime — the update window (parsing, boundaries,
wrap, named days, a DST night), a staged release activating inside the
window and waiting outside it; the local window winning over the
manifest's; the hook that rejects keeping the release staged; a Freeze
honoured from a manifest that is otherwise left staged; the heartbeat body
(the protocol's shape, content-free, the cadence adopted from the answer,
the open request reported as seen); halt without a way home degrading.
"""

from __future__ import annotations

import json
import shutil
import tempfile
import time

import pytest

from airprompter_agent_core import PROTOCOL_VERSION

from airprompter_agent_core._util import instant, iso_ms, now_ms
from airprompter_agent.agent import SDK_VERSION, AirPrompterAgent, RenderRefusedError, SyncOptions
from airprompter_agent_sync.apply.window import parse_window, window_state
from airprompter_agent_core.protocol.trust import public_jwk_of

from .control_plane import FakeControlPlane

SCOPE = {"organizationId": "org_1", "agentId": "agt_1", "target": "prod"}
KW = {"organization_id": "org_1", "agent_id": "agt_1", "target": "prod"}


def slots(plane: FakeControlPlane):
    return [
        plane.slot(tag="support.triage", text="Triage {{ticket}}.", variables=[{"name": "ticket", "required": True, "trust": "end_user"}]),
        plane.slot(tag="support.reply", text="Reply to {{name}}.", variables=[{"name": "name", "required": False, "trust": "operator"}], model="gpt-5"),
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
    }
    options.update(extra)
    return AirPrompterAgent.start(**options)


@pytest.fixture
def state_dir():
    path = tempfile.mkdtemp(prefix="ap-apply-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


def test_window_parsing_boundaries_wrap_days_dst():
    berlin = parse_window("02:00-04:00 Europe/Berlin")
    assert (berlin.timezone, berlin.start, berlin.end, berlin.days) == ("Europe/Berlin", "02:00", "04:00", None)
    at = instant
    assert window_state(berlin, at("2026-09-12T00:00:00Z")).open is True, "02:00 CEST, the first minute"
    assert window_state(berlin, at("2026-09-11T23:59:59Z")).open is False
    closed = window_state(berlin, at("2026-09-12T02:00:00Z"))
    assert closed.open is False, "04:00 is outside"
    assert iso_ms(closed.opens_at_ms) == "2026-09-13T00:00:00.000Z", "next opening tomorrow"
    night = parse_window("22:00-04:00 Europe/Berlin")
    assert window_state(night, at("2026-09-12T01:00:00Z")).open is True, "03:00 CEST inside the window that opened the evening before"
    weekend = parse_window("14:00-15:00 Asia/Tokyo sat,sun")
    assert weekend.days == ("sat", "sun")
    assert window_state(weekend, at("2026-09-12T05:30:00Z")).open is True, "Saturday"
    assert window_state(weekend, at("2026-09-14T05:30:00Z")).open is False, "Monday"
    assert iso_ms(window_state(weekend, at("2026-09-14T05:30:00Z")).opens_at_ms) == "2026-09-19T05:00:00.000Z"
    # Fall back 2026-10-25: 02:00 CEST = 00:00Z, 04:00 CET = 03:00Z — three hours of wall clock.
    fall = window_state(berlin, at("2026-10-25T00:30:00Z"))
    assert fall.open is True and iso_ms(fall.closes_at_ms) == "2026-10-25T03:00:00.000Z"
    # Spring forward 2026-03-29: 02:00 does not exist; the window opens where the clock lands (03:00 CEST = 01:00Z).
    spring = window_state(berlin, at("2026-03-29T01:30:00Z"))
    assert spring.open is True and iso_ms(spring.closes_at_ms) == "2026-03-29T02:00:00.000Z"
    with pytest.raises(ValueError, match="a window has a length"):
        parse_window("02:00-02:00 Europe/Berlin")
    with pytest.raises(ValueError, match="unknown time zone"):
        parse_window("02:00-04:00 Mars/Olympus_Mons")
    with pytest.raises(ValueError, match="expected"):
        parse_window("2-4 Europe/Berlin")
    with pytest.raises(ValueError, match="unknown day"):
        parse_window("02:00-04:00 Europe/Berlin mon,funday")
    assert parse_window({"timezone": "Europe/Berlin", "start": "02:00", "end": "04:00"}).to_wire() == {"timezone": "Europe/Berlin", "start": "02:00", "end": "04:00"}


def test_window_stages_outside_activates_inside_local_wins(state_dir):
    plane = FakeControlPlane(SCOPE)
    triage, reply = slots(plane)
    plane.promote([triage, reply])
    clock = {"ms": instant("2026-09-11T23:00:00Z")}  # 01:00 CEST: outside a 02:00–04:00 Berlin window; it opens in an hour.
    ap = start(plane, state_dir, now=lambda: clock["ms"], apply={"window": "02:00-04:00 Europe/Berlin"})
    reply2 = plane.slot(tag="support.reply", text="Reply warmly to {{name}}.", variables=[{"name": "name", "required": False, "trust": "operator"}], version_id="ver_reply_2")
    plane.promote([triage, reply2], apply_policy="unlock_required")
    ap.sync_now()
    assert ap.status().apply_state == "awaiting_unlock"
    window = ap.status().window
    assert (window["open"], window["source"], window["opens_at"]) == (False, "local", "2026-09-12T00:00:00.000Z")
    # The clock reaches the window: the timer (real time, so we drive it by hand through the same path) activates the staged release.
    clock["ms"] = instant("2026-09-12T00:00:30Z")
    ap._schedule_window_unlock()
    time.sleep(1.6)
    assert ap.generation == 2, "activated when the window opened"
    assert ap.status().apply_state == "active"
    reply3 = plane.slot(tag="support.reply", text="Reply thrice to {{name}}.", variables=[{"name": "name", "required": False, "trust": "operator"}], version_id="ver_reply_3")
    plane.promote([triage, reply3], apply_policy="unlock_required")
    ap.sync_now()
    assert ap.generation == 3, "window open on stage: live at once"
    ap.stop()

    dir2 = tempfile.mkdtemp(prefix="ap-apply-2-")
    try:
        plane2 = FakeControlPlane(SCOPE)
        t2, r2 = slots(plane2)
        plane2.promote([t2, r2])
        clock2 = {"ms": instant("2026-09-12T00:30:00Z")}  # 02:30 CEST
        carried = start(plane2, dir2, now=lambda: clock2["ms"])
        plane2.promote([t2, plane2.slot(tag="support.reply", text="R2 {{name}}.", variables=[{"name": "name", "required": False, "trust": "operator"}], version_id="v2")], apply_policy="unlock_required", unlock_window={"timezone": "Europe/Berlin", "start": "02:00", "end": "04:00"})
        carried.sync_now()
        assert carried.generation == 2, "the manifest's window was open: activated"
        assert carried.status().window["source"] == "manifest"
        carried.stop()
        narrower = start(plane2, dir2, now=lambda: clock2["ms"], apply={"window": "03:00-04:00 Europe/Berlin"})
        plane2.promote([t2, plane2.slot(tag="support.reply", text="R3 {{name}}.", variables=[{"name": "name", "required": False, "trust": "operator"}], version_id="v3")], apply_policy="unlock_required", unlock_window={"timezone": "Europe/Berlin", "start": "02:00", "end": "04:00"})
        narrower.sync_now()
        assert narrower.status().apply_state == "awaiting_unlock", "the local 03:00 window is not open at 02:30, whatever the manifest says"
        assert narrower.status().window["source"] == "local"
        narrower.stop()
    finally:
        shutil.rmtree(dir2, ignore_errors=True)


def test_hook_rejects_keeps_staged_activates_when_it_says_so(state_dir):
    plane = FakeControlPlane(SCOPE)
    triage, reply = slots(plane)
    plane.promote([triage, reply])
    seen = []
    approve = {"on": False}

    def on_staged(staged):
        seen.append({"generation": staged.generation, "request": (staged.unlock_request or {}).get("note")})
        if not approve["on"]:
            raise RuntimeError("change control said no")
        staged.activate()

    ap = start(plane, state_dir, apply={"on_staged": on_staged})
    reply2 = plane.slot(tag="support.reply", text="R2 {{name}}.", variables=[{"name": "name", "required": False, "trust": "operator"}], version_id="v2")
    requested = plane.promote([triage, reply2], apply_policy="unlock_required")
    plane.promote([triage, reply2], apply_policy="unlock_required", directives=[{"kind": "request_unlock", "releaseDigest": requested["payload"]["releaseDigest"], "requestedBy": "usr_ops", "requestedAt": iso_ms(now_ms()), "expiresAt": iso_ms(now_ms() + 3_600_000), "note": "CHG0042"}])
    ap.sync_now()
    assert seen == [{"generation": 3, "request": "CHG0042"}]
    assert ap.status().apply_state == "awaiting_unlock", "a rejecting hook leaves it staged"
    assert ap.generation == 1
    assert [r.get("note") for r in ap.status().unlock_requests] == ["CHG0042"]
    ap.heartbeat_now()
    assert plane.heartbeats[-1]["unlockRequestsSeen"] == [requested["payload"]["releaseDigest"]], "the fleet view learns who saw the request"
    assert plane.heartbeats[-1]["applyState"] == "awaiting_unlock"
    approve["on"] = True
    plane.promote([triage, plane.slot(tag="support.reply", text="R4 {{name}}.", variables=[{"name": "name", "required": False, "trust": "operator"}], version_id="v4")], apply_policy="unlock_required")
    ap.sync_now()
    assert ap.generation == 4, "the hook activated it"
    assert ap.status().apply_state == "active"
    ap.stop()


def test_freeze_honoured_from_a_staged_manifest(state_dir):
    plane = FakeControlPlane(SCOPE)
    triage, reply = slots(plane)
    plane.promote([triage, reply])
    ap = start(plane, state_dir, telemetry={"sink": "memory"})
    plane.promote([triage, reply], apply_policy="unlock_required", directives=[{"kind": "disable", "scope": "agent", "issuedAt": iso_ms(now_ms()), "reason": "Frozen from the console"}])
    ap.sync_now()
    assert ap.generation == 1, "still on generation 1 — the frozen manifest was staged, not activated"
    assert ap.status().apply_state == "awaiting_unlock"
    assert ap.status().disabled == {"agent": True, "slots": [], "arms": []}, "…and yet the Freeze took effect"
    with pytest.raises(RenderRefusedError) as frozen:
        ap.prompt("support.reply").render()
    assert frozen.value.reason == "disabled"
    ap.heartbeat_now()
    assert plane.heartbeats[-1]["disabled"] == {"agent": True, "slots": []}
    plane.promote([triage, reply], apply_policy="unlock_required")
    ap.sync_now()
    assert ap.status().disabled == {"agent": False, "slots": [], "arms": []}
    assert ap.prompt("support.reply").render().generation == 1
    ap.stop()


def test_heartbeat_body_cadence_refusal_and_offline(state_dir):
    plane = FakeControlPlane(SCOPE)
    triage, reply = slots(plane)
    plane.promote([triage, reply])
    plane.heartbeat_interval_seconds = 60
    ap = start(plane, state_dir, models={"gpt-5": {"provider": "openai"}, "claude-sonnet-5": {"provider": "anthropic"}}, heartbeat_seconds=45)
    deadline = time.time() + 2
    while not plane.heartbeats and time.time() < deadline:
        time.sleep(0.02)
    assert plane.heartbeats, "the first heartbeat goes out right after boot"
    assert plane.heartbeats[0]["heartbeatIntervalSeconds"] == 45, "the runtime declares its cadence…"
    body = ap.heartbeat_body()
    assert body["protocol"] == PROTOCOL_VERSION
    assert body["sdk"] == {"name": "agent-sdk-python", "version": SDK_VERSION}
    assert body["host"]["runtime"].startswith("python ")
    assert body["syncMode"] == "resident"
    assert body["heartbeatIntervalSeconds"] == 60, "…and holds to what the server answered"
    assert body["generation"] == {"active": 1}
    assert body["applyState"] == "active"
    assert body["storageProtection"] == "file_key"
    assert body["catalog"]["models"] == ["gpt-5", "claude-sonnet-5"]
    assert "Triage" not in json.dumps(body), "no prompt text on the wire"
    plane.heartbeat_interval_seconds = 120
    ap.heartbeat_now()
    assert ap.status().heartbeat["interval_seconds"] == 120, "the server's cadence is adopted"
    assert ap.status().heartbeat["last_at"]
    plane.heartbeat_refusal = {"status": 403, "code": "instance_cap_reached"}
    ap.heartbeat_now()
    assert ap.status().heartbeat["last_refusal"] == "instance_cap_reached"
    ap.stop()

    dir2 = tempfile.mkdtemp(prefix="ap-apply-offline-")
    try:
        plane2 = FakeControlPlane(SCOPE)
        t2, r2 = slots(plane2)
        plane2.promote([t2, r2], lease_seconds=60, on_lease_expiry="halt")
        clock = {"ms": now_ms()}
        online = start(plane2, dir2, now=lambda: clock["ms"])
        online.stop()
        heartbeats_before = len(plane2.heartbeats)
        events = []
        offline = AirPrompterAgent.start(**KW, state_dir=dir2, root={"pinned": public_jwk_of(plane2.root_key)}, sync={"mode": "offline"}, now=lambda: clock["ms"], logger=lambda e: events.append(e["event"]))
        clock["ms"] += 120_000
        assert offline.status().lease_expired is True
        assert offline.prompt("support.reply").render().text == "Reply to .", "halt without a way home degrades"
        assert "halt_without_contact_degraded" in events
        assert offline.heartbeat_body()["syncMode"] == "offline"
        offline.stop()
        assert len(plane2.heartbeats) == heartbeats_before, "only the online start heart-beat"
    finally:
        shutil.rmtree(dir2, ignore_errors=True)
