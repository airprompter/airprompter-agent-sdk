"""S9 (AIR-1977): the signed ramp plan. Parity with ``sdk-typescript/test/ramp.test.ts``."""
from __future__ import annotations

import json
import os
import shutil
import tempfile

import pytest

from airprompter_agent import AirPrompterAgent, RenderRefusedError
from airprompter_agent._util import instant
from airprompter_agent.agent import SyncOptions
from airprompter_agent.protocol.assignment import AssignmentError, assign_arm, effective_arms, ramp_weights_at, validate_ramp
from airprompter_agent.protocol.trust import public_jwk_of, release_digest, verify_manifest

from .control_plane import FakeControlPlane

VECTORS = os.path.join(os.path.dirname(__file__), "..", "..", "protocol", "vectors", "ramp.json")
SCOPE = {"organizationId": "org_1", "agentId": "agt_ramp", "target": "prod"}
KW = {"organization_id": "org_1", "agent_id": "agt_ramp", "target": "prod"}


def test_protocol_ramp_vectors():
    with open(VECTORS, encoding="utf-8") as f:
        vectors = json.load(f)
    for case in vectors["cases"]:
        validate_ramp(case["ramp"], len(case["arms"]))
        disabled = {d["arm"] for d in case["directives"] if d.get("kind") == "disable" and d.get("scope") == "arm"}

        def check(now: str, expected_weights, field: str, case=case, disabled=disabled) -> None:
            now_ms = instant(now)
            if expected_weights is not None:
                assert ramp_weights_at(case["arms"], case["ramp"], now_ms) == expected_weights, f"{case['name']}: weights at {now}"
            arms = effective_arms(arms=case["arms"], ramp=case["ramp"], disabled_arms=disabled, now_ms=now_ms)
            assert arms is not None
            for entry in case["expected"]["assignments"]:
                result = assign_arm(salt=case["salt"], subject=entry["subject"], arms=arms)
                assert (result.bucket, result.arm["arm"]) == (entry["bucket"], entry[field]), f"{case['name']}: {entry['subject']} at {now}"

        if "hosts" in case:
            check(case["hosts"]["hostA"]["now"], case["hosts"]["hostA"]["weightBps"], "hostA")
            check(case["hosts"]["hostB"]["now"], case["hosts"]["hostB"]["weightBps"], "hostB")
            assert sum(1 for e in case["expected"]["assignments"] if e["hostA"] != e["hostB"]) == case["expected"]["disagreements"]
            assert not any(e["hostA"] == "candidate" and e["hostB"] == "control" for e in case["expected"]["assignments"]), "sticky and monotone"
        else:
            check(case["now"], case["expected"].get("weightBps"), "arm")
    for refused in vectors["refused"]:
        with pytest.raises(AssignmentError) as error:
            validate_ramp(refused["ramp"], len(refused["arms"]))
        assert error.value.reason == refused["reason"], refused["name"]
    validate_ramp(None, 2)


def _experiment(plane: FakeControlPlane):
    control = plane.slot(tag="support.reply", text="Reply A to {{name}}", version_id="a", variables=[{"name": "name", "required": False, "trust": "operator"}])
    candidate = plane.slot(tag="support.reply", text="Reply B to {{name}}", version_id="b", variables=[{"name": "name", "required": False, "trust": "operator"}])
    arms = [{"arm": "control", "weightBps": 10000, "releaseDigest": release_digest([control]), "overrides": []}, {"arm": "candidate", "weightBps": 0, "releaseDigest": release_digest([candidate]), "overrides": [candidate]}]
    return control, {"experimentId": "exp_1", "salt": "AAECAwQFBgcICQoLDA0ODw", "subjectKey": "request", "arms": arms}


def test_malformed_plan_refuses_the_manifest_whole():
    plane = FakeControlPlane(SCOPE)
    control, experiment = _experiment(plane)
    good = plane.promote([control], experiment={**experiment, "ramp": [{"notBefore": "2026-09-14T02:00:00Z", "weightBps": [9500, 500]}, {"notBefore": "2026-09-14T03:00:00Z", "weightBps": [7500, 2500]}]})
    assert verify_manifest(manifest=good, root=plane.root, now="2026-09-13T00:00:00Z", scope=SCOPE, stored_generation=0, payloads=None).ok
    bad = plane.promote([control], experiment={**experiment, "ramp": [{"notBefore": "2026-09-14T02:00:00Z", "weightBps": [9500, 500]}, {"notBefore": "2026-09-14T02:20:00Z", "weightBps": [7500, 2500]}]})
    verdict = verify_manifest(manifest=bad, root=plane.root, now="2026-09-13T00:00:00Z", scope=SCOPE, stored_generation=0, payloads=None)
    assert (verdict.ok, verdict.reason) == (False, "ramp_invalid")


@pytest.fixture
def state_dir():
    path = tempfile.mkdtemp(prefix="ap-ramp-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


def test_runtime_walks_the_plan_and_the_retreat_lands_without_an_unlock(state_dir):
    plane = FakeControlPlane(SCOPE)
    control, experiment = _experiment(plane)
    ramp = [{"notBefore": "2026-09-14T02:00:00Z", "weightBps": [9500, 500]}, {"notBefore": "2026-09-14T03:00:00Z", "weightBps": [7500, 2500]}, {"notBefore": "2026-09-14T05:00:00Z", "weightBps": [0, 10000]}]
    experiment = {**experiment, "ramp": ramp}
    plane.promote([control], apply_policy="auto")
    clock = {"ms": float(instant("2026-09-14T01:00:00Z"))}
    events: list[dict] = []
    ap = AirPrompterAgent.start(**KW, api_key=plane.api_key, base_url="https://api.test", state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, sync=SyncOptions(mode="resident", poll_seconds=3600, root_url="https://edge.test/roots/prod/root.json"), transport=plane.transport(), now=lambda: clock["ms"], telemetry={"sink": "memory"}, logger=events.append)
    try:
        plane.promote([control], apply_policy="unlock_required", experiment=experiment)
        ap.sync_now()
        assert ap.status().staged_generation == 2
        assert ap.unlock() == {"generation": 2}
        subjects = [f"user-{i}" for i in range(200)]

        def share() -> float:
            return sum(1 for s in subjects if ap.prompt("support.reply", subject=s).render(name="x").arm == "candidate") / len(subjects)

        assert share() == 0
        assert (ap.status().ramp["step"], ap.status().ramp["nextStepAt"], ap.status().ramp["weightBps"]) == (-1, "2026-09-14T02:00:00Z", [10000, 0])
        fetches = len(plane.requests)
        clock["ms"] = float(instant("2026-09-14T02:00:00Z"))
        assert 0.01 < share() < 0.12 and ap.status().ramp["step"] == 0
        clock["ms"] = float(instant("2026-09-14T04:00:00Z"))
        assert 0.17 < share() < 0.33 and ap.status().ramp["step"] == 1
        on_candidate_at_25 = [s for s in subjects if ap.prompt("support.reply", subject=s).render(name="x").arm == "candidate"]
        clock["ms"] = float(instant("2026-09-14T06:00:00Z"))
        assert share() == 1 and (ap.status().ramp["step"], ap.status().ramp["nextStepAt"]) == (2, None)
        assert len(plane.requests) == fetches, "not one request to the origin while the plan walked"
        assert all(ap.prompt("support.reply", subject=s).render(name="x").arm == "candidate" for s in on_candidate_at_25), "sticky and monotone"

        plane.promote([control], apply_policy="unlock_required", experiment=experiment, directives=[{"kind": "disable", "scope": "arm", "arm": "candidate", "issuedAt": "2026-09-14T06:00:00Z", "reason": "p95 regressed"}])
        ap.sync_now()
        assert ap.status().last_sync_outcome == "staged" and ap.generation == 2
        assert ap.status().disabled == {"agent": False, "slots": [], "arms": ["candidate"]}
        assert share() == 0, "the candidate's share went to the control at once"
        assert ap.prompt("support.reply", subject="user-1").render(name="x").text == "Reply A to x"
        assert ap.status().ramp["weightBps"] == [10000, 0]
        assert ap.heartbeat_body()["disabled"]["arms"] == ["candidate"]
        assert any(e.get("event") == "disabled_by_directive" and "candidate" in (e.get("arms") or []) for e in events)
        plane.promote([control], apply_policy="unlock_required", experiment=experiment, directives=[{"kind": "disable", "scope": "arm", "arm": "candidate", "issuedAt": "2026-09-14T06:00:00Z"}, {"kind": "disable", "scope": "arm", "arm": "control", "issuedAt": "2026-09-14T06:00:00Z"}])
        ap.sync_now()
        with pytest.raises(RenderRefusedError) as refused:
            ap.prompt("support.reply", subject="user-1").render(name="x")
        assert refused.value.reason == "disabled"
    finally:
        ap.stop()
