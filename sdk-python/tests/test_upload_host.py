"""S5 (AIR-1973): telemetry without a daemon. Parity with ``sdk-typescript/test/uploadHost.test.ts``.

A resident host with no daemon uploads its own closed segments under its own
grant, in-process, off the request path; with no grant the budget holds and
the loss is counted; a grant that lapses mid-run is replaced before the
POST; a serverless invocation's rows land before ``invoke()`` returns, and
the documented opt-out hands the flush to a thread instead.
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import time

import pytest

from airprompter_agent import AirPrompterAgent
from airprompter_agent.agent import SyncOptions, TelemetryOptions
from airprompter_agent_core.protocol.trust import public_jwk_of
from airprompter_agent_sync.store.slot_store import SlotStore

from .control_plane import FakeControlPlane

SCOPE = {"organizationId": "org_1", "agentId": "agt_upload", "target": "prod"}
KW = {"organization_id": "org_1", "agent_id": "agt_upload", "target": "prod"}
T0 = 1_789_300_800_000.0


class Clock:
    def __init__(self, ms: float):
        self.ms = ms

    def __call__(self) -> float:
        return self.ms


def host(plane: FakeControlPlane, state_dir: str, clock: Clock, telemetry: TelemetryOptions | None = None, mode: str = "resident", **extra):
    options = {
        **KW,
        "api_key": plane.api_key,
        "base_url": "https://api.test",
        "state_dir": state_dir,
        "root": {"pinned": public_jwk_of(plane.root_key)},
        "sync": SyncOptions(mode=mode, poll_seconds=3600, root_url="https://edge.test/roots/prod/root.json"),
        "transport": plane.transport(),
        "now": clock,
        "random": lambda: 0.5,
        "telemetry": telemetry or TelemetryOptions(),
    }
    options.update(extra)
    ap = AirPrompterAgent.start(**options)
    if mode == "resident":
        deadline = time.time() + 5
        while ap.status().heartbeat["last_at"] is None and time.time() < deadline:
            time.sleep(0.02)
    return ap


def spool_dir(state_dir: str) -> str:
    return os.path.join(SlotStore.path(state_dir=state_dir, agent_id=SCOPE["agentId"], target=SCOPE["target"]), "spool", "telemetry")


def unsent(state_dir: str) -> list[str]:
    return [n for n in os.listdir(spool_dir(state_dir)) if n.startswith("seg-") and n.endswith(".ndjson")]


def prefix(instance_id: str) -> str:
    return f"org/{SCOPE['organizationId']}/agent/{SCOPE['agentId']}/{SCOPE['target']}/{instance_id}/"


@pytest.fixture
def state_dir():
    path = tempfile.mkdtemp(prefix="ap-uphost-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


def test_no_daemon_grant_present_uploads_own_segments(state_dir):
    plane = FakeControlPlane(SCOPE)
    plane.grant_base_url = "https://bucket.test"
    clock = Clock(T0)
    plane.now = clock
    plane.promote([plane.slot(tag="support.reply", text="Reply to {{name}}", variables=[{"name": "name", "required": False, "trust": "operator"}])])
    ap = host(plane, state_dir, clock)
    try:
        assert ap.status().upload is not None, "a resident host with a key and a directory spool runs its own uploader"
        assert ap.status().upload["sentSegments"] == 0
        assert ap.status().upload["nextPassAt"], "scheduled, off the request path"
        r = ap.prompt("support.reply").render(name="x")
        ap.report(tag=r.tag, version_id=r.version_id, arm=r.arm, model=r.model, status="ok", latency_ms=12, tokens={"input": 3, "output": 4})
        ap.spool.close_windows(clock.ms)
        assert len(unsent(state_dir)) == 1
        assert ap.upload_now() == {"uploaded": 1, "quarantined": 0, "dropped": 0, "held": False}
        assert unsent(state_dir) == [], "acknowledged: gone from the spool"
        assert not os.path.exists(os.path.join(spool_dir(state_dir), "sent")), "S6: deleted on ack, nothing parked"
        assert os.path.exists(os.path.join(spool_dir(state_dir), ".last-upload"))
        assert len(plane.uploads) == 1 and plane.uploads[0].startswith(prefix(ap.instance_id))
        assert all(g["instanceId"] == ap.instance_id for g in plane.grants), "the only grant ever asked for is this runtime's own"
        rows = [json.loads(line) for line in plane.objects[plane.uploads[0]].decode("utf-8").strip().split("\n")]
        assert [(row["type"], row["instanceId"], row.get("count")) for row in rows] == [("window", ap.instance_id, 1)]
        assert ap.status().upload["sentSegments"] == 1
        spool = ap.heartbeat_body()["spool"]
        assert (spool["depthSegments"], spool["droppedSegments"], spool["lastUploadAt"]) == (0, 0, ap.status().upload["lastUploadAt"]), "the heartbeat carries what the uploader knows"
    finally:
        ap.stop()


def test_no_daemon_no_grant_budget_holds_drops_count_and_lapsed_grant_is_replaced(state_dir):
    plane = FakeControlPlane(SCOPE)
    plane.grant_base_url = "https://bucket.test"
    plane.grant_hold = {"retryAfterSeconds": 120}
    clock = Clock(T0)
    plane.now = clock
    plane.promote([plane.slot(tag="support.reply", text="Reply to {{name}}", variables=[{"name": "name", "required": False, "trust": "operator"}])])
    events: list[dict] = []
    ap = host(plane, state_dir, clock, TelemetryOptions(spool_budget_bytes=1024 * 1024), logger=events.append)
    try:
        r = ap.prompt("support.reply").render(name="x")
        for i in range(6):
            ap.report(tag=r.tag, version_id=r.version_id, arm=r.arm, model=r.model, status="ok", latency_ms=10 + i)
            clock.ms += 60_000
            ap.spool.close_windows(clock.ms)
        assert len(unsent(state_dir)) == 6
        result = ap.upload_now()
        assert result["held"] is True and result["uploaded"] == 0, "no grant: the pass holds"
        assert len(unsent(state_dir)) == 6, "under budget: nothing is lost"
        assert ap.status().upload["backoffUntil"] is not None
        assert plane.uploads == []
        # The budget is the uploader's, the same sweep the daemon runs: past it the oldest segments go, and one dropped row says so.
        ap._uploader.budget_bytes = 700
        clock.ms += 121_000
        result = ap.upload_now()
        assert 1 <= result["dropped"] <= 5
        assert ap.status().upload["droppedSegments"] == result["dropped"]
        assert len(unsent(state_dir)) + result["dropped"] == 7, "what the sweep evicted plus the dropped row it wrote"
        assert ap.heartbeat_body()["spool"]["droppedSegments"] == result["dropped"], "counted on the heartbeat, never silent"
        assert any(e.get("component") == "uploader" and e.get("event") == "spool_evicted" for e in events)

        # The grant arrives, then lapses between two passes: the uploader replaces it a minute early, before any POST.
        plane.grant_hold = None
        clock.ms += 121_000
        result = ap.upload_now()
        assert result["held"] is False and result["uploaded"] >= 1
        assert unsent(state_dir) == []
        grants_before = len(plane.grants)
        ap.report(tag=r.tag, version_id=r.version_id, arm=r.arm, model=r.model, status="ok", latency_ms=9)
        clock.ms += 16 * 60_000
        ap.spool.close_windows(clock.ms)
        result = ap.upload_now()
        assert (result["uploaded"], result["held"]) == (1, False)
        assert len(plane.grants) == grants_before + 1, "a fresh grant before the POST; the lapsed one was never tried"
        assert all(k.startswith(prefix(ap.instance_id)) for k in plane.uploads)
    finally:
        ap.stop()


def test_upload_off_and_memory_sink_run_no_uploader(state_dir):
    plane = FakeControlPlane(SCOPE)
    plane.grant_base_url = "https://bucket.test"
    clock = Clock(T0)
    plane.promote([plane.slot(tag="support.reply", text="Reply.")])
    off = host(plane, state_dir, clock, TelemetryOptions(upload=False))
    assert off.status().upload is None and off.upload_now() is None
    r = off.prompt("support.reply").render()
    off.report(tag=r.tag, version_id=r.version_id, arm=r.arm, model=r.model, status="ok", latency_ms=1)
    off.spool.close_windows(clock.ms)
    assert len(unsent(state_dir)) == 1, "the segment stays for whoever owns the spool"
    off.stop()
    memory = host(plane, state_dir, clock, TelemetryOptions(sink="memory"))
    assert memory.status().upload is None, "a memory sink has nothing to sweep; flush_telemetry() is its path"
    memory.stop()


def test_serverless_flush_is_awaited_and_background_is_the_opt_out(state_dir):
    plane = FakeControlPlane(SCOPE)
    plane.grant_base_url = "https://bucket.test"
    clock = Clock(T0)
    plane.now = clock
    plane.promote([plane.slot(tag="support.reply", text="Reply.")])
    awaited = host(plane, state_dir, clock, mode="on_invoke")
    try:
        r = awaited.prompt("support.reply").render()
        awaited.invoke(lambda: awaited.report(tag=r.tag, version_id=r.version_id, arm=r.arm, model=r.model, status="ok", latency_ms=12))
        assert len(plane.uploads) == 1, "landed before the handler's caller got control back — a frozen process loses nothing"
        assert plane.uploads[0].startswith(prefix(awaited.instance_id))
        assert awaited.drain_memory_sink() == []
        # A hold keeps the rows for the next invocation.
        plane.grant_hold = {"retryAfterSeconds": 60}
        awaited._upload_grant = None
        awaited.report(tag=r.tag, version_id=r.version_id, arm=r.arm, model=r.model, status="ok", latency_ms=3)
        awaited.spool.close_windows(clock.ms + 60_000)
        held = awaited.flush_telemetry()
        assert held["status"] == "held"
        assert len(awaited.drain_memory_sink()) == 1, "kept for the next invocation"
        plane.grant_hold = None
    finally:
        awaited.stop()
    background = host(plane, state_dir, clock, TelemetryOptions(flush="background"), mode="on_invoke")
    try:
        r = background.prompt("support.reply").render()
        background.invoke(lambda: background.report(tag=r.tag, version_id=r.version_id, arm=r.arm, model=r.model, status="ok", latency_ms=12))
        deadline = time.time() + 5
        while len(plane.uploads) < 2 and time.time() < deadline:
            time.sleep(0.02)
        assert len(plane.uploads) == 2, "background: lands when the thread gets to it"
    finally:
        background.stop()
