"""S14: the in-process healthz. Parity with ``sdk-typescript/test/healthz.test.ts``: the rules over a status
document (each a vector), then a live host — 200 while serving, 503 once the lease lapsed under ``halt``."""
from __future__ import annotations

import dataclasses
import json
import shutil
import tempfile
import time

import pytest

from airprompter_agent import AirPrompterAgent, healthz_of, healthz_response
from airprompter_agent.agent import SyncOptions, TelemetryOptions
from airprompter_agent_core._util import iso_ms
from airprompter_agent_core.protocol.trust import public_jwk_of

from .control_plane import FakeControlPlane

SCOPE = {"organizationId": "org_1", "agentId": "agt_health", "target": "prod"}
KW = {"organization_id": "org_1", "agent_id": "agt_health", "target": "prod"}
T0 = 1_789_300_800_000.0
MIB = 1024 * 1024


class Clock:
    def __init__(self, ms: float):
        self.ms = ms

    def __call__(self) -> float:
        return self.ms


@pytest.fixture
def state_dir():
    path = tempfile.mkdtemp(prefix="ap-healthz-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


def host(plane: FakeControlPlane, state_dir: str, clock: Clock) -> AirPrompterAgent:
    ap = AirPrompterAgent.start(**KW, api_key=plane.api_key, base_url="https://api.test", state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, sync=SyncOptions(mode="resident", poll_seconds=3600, root_url="https://edge.test/roots/prod/root.json"), transport=plane.transport(), now=clock, random=lambda: 0.5, telemetry=TelemetryOptions(upload=False))
    deadline = time.time() + 5
    while ap.status().heartbeat["last_at"] is None and time.time() < deadline:
        time.sleep(0.02)
    return ap


def test_every_rule_in_order_failing_beats_degraded(state_dir):
    plane = FakeControlPlane(SCOPE)
    clock = Clock(T0)
    plane.now = clock
    plane.promote([plane.slot(tag="support.reply", text="Reply {{name}}", variables=[{"name": "name", "required": False, "trust": "operator"}])], lease_seconds=3600)
    ap = host(plane, state_dir, clock)
    try:
        base = ap.status()
    finally:
        ap.stop()

    def at(budget=100 * MIB, **patch):
        return healthz_of(dataclasses.replace(base, **patch), spool_budget_bytes=budget, now_ms=T0)

    ok = at()
    assert (ok["ok"], ok["status"], ok["reasons"], ok["generation"]) == (True, "ok", [], 1)
    assert at(generation=0)["reasons"] == ["no_verified_release"] and at(generation=0)["ok"] is False
    halt = at(lease_expired=True, on_lease_expiry="halt")
    assert (halt["ok"], halt["status"], halt["reasons"]) == (False, "failing", ["lease_expired_halt"])
    degrade = at(lease_expired=True, on_lease_expiry="degrade")
    assert (degrade["ok"], degrade["status"], degrade["reasons"]) == (True, "degraded", ["lease_expired_degrade"])
    assert at(consecutive_sync_failures=2)["reasons"] == [], "two failures is a bad minute, not a rule"
    assert at(consecutive_sync_failures=3)["reasons"] == ["sync_failing"]
    assert at(upload={"backoffUntil": iso_ms(T0 + 60_000), "lastUploadAt": None})["reasons"] == ["upload_backing_off"]
    assert at(upload={"backoffUntil": iso_ms(T0 - 1), "lastUploadAt": None})["reasons"] == [], "a backoff already over is not a reason"
    assert at(forced_downgrade=True)["reasons"] == ["forced_downgrade"]
    assert at(daemon={"attached": False, "socket_path": "/x"})["reasons"] == ["daemon_detached"]
    assert at(daemon={"attached": True, "socket_path": "/x"})["reasons"] == []
    assert at(spool={"depth_segments": 80, "depth_bytes": 80 * MIB})["reasons"] == ["spool_near_budget"], "80 % of the budget"
    assert at(spool={"depth_segments": 79, "depth_bytes": 79 * MIB})["reasons"] == []
    assert at(None, spool={"depth_segments": 80, "depth_bytes": 80 * MIB})["reasons"] == [], "no budget known (a memory sink): no rule"
    both = at(generation=0, forced_downgrade=True, consecutive_sync_failures=5)
    assert (both["ok"], both["status"], both["reasons"]) == (False, "failing", ["no_verified_release", "sync_failing", "forced_downgrade"])
    assert healthz_response(both)[0] == 503
    code, headers, body = healthz_response(ok)
    assert code == 200 and headers["cache-control"] == "no-store"
    assert json.loads(body)["spool"] == {"depthSegments": 0, "depthBytes": 0, "budgetBytes": 100 * MIB}
    assert set(json.loads(body)) == {"ok", "status", "reasons", "generation", "stagedGeneration", "applyState", "source", "leaseExpiresAt", "leaseExpired", "onLeaseExpiry", "lastSyncAt", "lastSyncOutcome", "consecutiveSyncFailures", "forcedDowngrade", "daemon", "spool", "lastUploadAt", "backoffUntil"}, "the wire document is the TypeScript SDK's"


def test_live_host_200_then_503_once_the_lease_lapsed_under_halt(state_dir):
    plane = FakeControlPlane(SCOPE)
    clock = Clock(T0)
    plane.now = clock
    plane.promote([plane.slot(tag="support.reply", text="Reply {{name}}", variables=[{"name": "name", "required": False, "trust": "operator"}])], lease_seconds=60, on_lease_expiry="halt")
    ap = host(plane, state_dir, clock)
    try:
        code, _, body = ap.healthz_response()
        doc = json.loads(body)
        assert (code, doc["ok"], doc["status"], doc["generation"], doc["spool"]["budgetBytes"]) == (200, True, "ok", 1, 100 * MIB)
        clock.ms = T0 + 61_000
        code, _, body = ap.healthz_response()
        assert code == 503 and json.loads(body)["reasons"] == ["lease_expired_halt"]
        assert ap.healthz()["ok"] is False
    finally:
        ap.stop()
