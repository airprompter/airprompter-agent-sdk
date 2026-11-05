"""S14: the in-process healthz. Parity with ``sdk-typescript/test/healthz.test.ts``: the rules over a status
document (each a vector), then a live host — 200 while serving and 200 once the lease lapsed: stale, still serving."""
from __future__ import annotations

import dataclasses
import json
import shutil
import tempfile
import time

import pytest

from airprompter_agent import AirPrompterAgent, healthz_of, healthz_response
from airprompter_agent.agent import SyncOptions, TelemetryOptions
from airprompter_agent.core._util import iso_ms
from airprompter_agent.core.protocol.trust import public_jwk_of

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


def test_every_rule_in_order(state_dir):
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
    assert (at(generation=0)["ok"], at(generation=0)["status"], at(generation=0)["reasons"]) == (True, "degraded", ["no_verified_release"]), "generation 0 serves the agent's own prompt: a 503 would restart a working agent"
    degrade = at(lease_expired=True)
    assert (degrade["ok"], degrade["status"], degrade["reasons"]) == (True, "degraded", ["lease_expired"])
    assert at(consecutive_sync_failures=2)["reasons"] == [], "two failures is a bad minute, not a rule"
    assert at(consecutive_sync_failures=3)["reasons"] == ["sync_failing"]
    assert at(upload={"backoffUntil": iso_ms(T0 + 60_000), "lastUploadAt": None})["reasons"] == ["upload_backing_off"]
    assert at(upload={"backoffUntil": iso_ms(T0 - 1), "lastUploadAt": None})["reasons"] == [], "a backoff already over is not a reason"
    assert at(forced_downgrade=True)["reasons"] == ["forced_downgrade"]
    def placed(uploaded_by, live):
        daemon = None if live is None else {"live": live, "pid": 42, "version": "0.3.0", "heartbeat_at": iso_ms(T0), "spool_dir": "/x"}
        return {"sink": "directory", "spool_dir": "/x", "spool_dir_from": "default", "uploaded_by": uploaded_by, "daemon": daemon}

    assert at(telemetry=placed("none", False))["reasons"] == ["upload_daemon_stale"], "the daemon's file went stale and nothing here uploads"
    assert at(telemetry=placed("self", False))["reasons"] == [], "stale, but this process took the upload back"
    assert at(telemetry=placed("daemon", True))["reasons"] == []
    assert at(telemetry=placed("none", None))["reasons"] == [], "no daemon at all is not a reason"
    assert at(telemetry=placed("daemon", True))["telemetry"] == {"uploadedBy": "daemon", "daemon": "live"}
    assert at(spool={"depth_segments": 80, "depth_bytes": 80 * MIB})["reasons"] == ["spool_near_budget"], "80 % of the budget"
    assert at(spool={"depth_segments": 79, "depth_bytes": 79 * MIB})["reasons"] == []
    assert at(None, spool={"depth_segments": 80, "depth_bytes": 80 * MIB})["reasons"] == [], "no budget known (a memory sink): no rule"
    both = at(lease_expired=True, forced_downgrade=True, consecutive_sync_failures=5)
    assert (both["ok"], both["status"], both["reasons"]) == (True, "degraded", ["lease_expired", "sync_failing", "forced_downgrade"]), "every reason is listed in rule order"
    assert healthz_response(both)[0] == 200, "a stale agent keeps serving, so a probe keeps it"
    assert healthz_response({"ok": False})[0] == 200, "there is no 503 branch"
    code, headers, body = healthz_response(ok)
    assert code == 200 and headers["cache-control"] == "no-store"
    assert json.loads(body)["spool"] == {"depthSegments": 0, "depthBytes": 0, "budgetBytes": 100 * MIB}
    assert set(json.loads(body)) == {"ok", "status", "reasons", "generation", "stagedGeneration", "applyState", "source", "leaseExpiresAt", "leaseExpired", "lastSyncAt", "lastSyncOutcome", "consecutiveSyncFailures", "forcedDowngrade", "telemetry", "spool", "lastUploadAt", "backoffUntil"}, "the wire document is the TypeScript SDK's"


def test_live_host_200_while_serving_and_200_once_the_lease_lapsed(state_dir):
    plane = FakeControlPlane(SCOPE)
    clock = Clock(T0)
    plane.now = clock
    plane.promote([plane.slot(tag="support.reply", text="Reply {{name}}", variables=[{"name": "name", "required": False, "trust": "operator"}])], lease_seconds=60)
    ap = host(plane, state_dir, clock)
    try:
        code, _, body = ap.healthz_response()
        doc = json.loads(body)
        assert (code, doc["ok"], doc["status"], doc["generation"], doc["spool"]["budgetBytes"]) == (200, True, "ok", 1, 100 * MIB)
        clock.ms = T0 + 61_000
        code, _, body = ap.healthz_response()
        assert code == 200 and json.loads(body)["reasons"] == ["lease_expired"]
        assert ap.healthz()["ok"] is True
        assert ap.prompt("support.reply").render(name="a").text == "Reply a"
    finally:
        ap.stop()
