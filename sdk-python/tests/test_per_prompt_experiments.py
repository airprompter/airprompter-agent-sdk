"""S16: one experiment per prompt — parity with ``sdk-typescript/test/perPromptExperiments.test.ts``.

Two slots split independently on their own salts (the protocol's perTag vectors, then the runtime end to end); a
candidate may be another prompt under the same key (D79); an arm-scoped disable retreats one experiment and leaves the
other alone; the conflicts are refused whole at verification (M15); a 0.2-shaped manifest still verifies.
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile

import pytest

from airprompter_agent import AirPrompterAgent
from airprompter_agent.agent import SyncOptions
from airprompter_agent_core.protocol.assignment import assign_arm
from airprompter_agent_core.protocol.trust import experiment_conflict, experiment_for_tag, experiments_of, public_jwk_of, release_digest, verify_manifest

from .control_plane import FakeControlPlane

VECTORS = os.path.join(os.path.dirname(__file__), "..", "..", "protocol", "vectors", "assignment.json")
SCOPE = {"organizationId": "org_1", "agentId": "agt_pp", "target": "prod"}
KW = {"organization_id": "org_1", "agent_id": "agt_pp", "target": "prod"}
NOW = "2026-09-14T00:00:00Z"


@pytest.fixture
def state_dir():
    path = tempfile.mkdtemp(prefix="ap-perprompt-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


def test_protocol_per_tag_vectors():
    with open(VECTORS, encoding="utf-8") as f:
        per_tag = json.load(f)["perTag"]
    assert len(per_tag["cases"]) >= 3
    for case in per_tag["cases"]:
        payload = {"experiments": [{**e, "subjectKey": "request", "arms": [{**a, "releaseDigest": "sha256:" + "0" * 64, "overrides": []} for a in e["arms"]]} for e in case["experiments"]]}
        for tag in case["tags"]:
            experiment = experiment_for_tag(payload, tag)
            expected = case["expected"][tag]
            if experiment is None:
                assert expected == {"experimentId": None, "bucket": None, "arm": "none"}, f"{case['name']}: {tag}"
                continue
            assigned = assign_arm(salt=experiment["salt"], subject=case["subject"], arms=experiment["arms"])
            assert {"experimentId": experiment["experimentId"], "bucket": assigned.bucket, "arm": assigned.arm["arm"]} == expected, f"{case['name']}: {tag}"
    assert [r["reason"] for r in per_tag["refused"]] == ["experiment_conflict"] * 3


def _experiment(plane: FakeControlPlane, experiment_id: str, tag: str, base: str, candidate_slots: list[dict], overrides: list[dict]) -> dict:
    return {
        "experimentId": experiment_id,
        "tag": tag,
        "salt": "AAECAwQFBgcICQoLDA0ODw",
        "subjectKey": "request",
        "arms": [
            {"arm": "control", "weightBps": 9000, "releaseDigest": base, "overrides": []},
            {"arm": "candidate", "weightBps": 1000, "releaseDigest": release_digest(candidate_slots), "overrides": overrides},
        ],
    }


def test_m15_conflicts_refused_and_legacy_verifies():
    plane = FakeControlPlane(SCOPE)
    triage = plane.slot(tag="support.triage", text="Triage A", version_id="a", variables=[])
    reply = plane.slot(tag="support.reply", text="Reply A", version_id="a", variables=[])
    triage_b = plane.slot(tag="support.triage", text="Triage B", version_id="b", variables=[])
    base = release_digest([triage, reply])
    exp = lambda experiment_id, tag, overrides=None: _experiment(plane, experiment_id, tag, base, [triage_b, reply], overrides or [])  # noqa: E731
    untagged = lambda experiment: {k: v for k, v in experiment.items() if k != "tag"}  # noqa: E731
    payload = plane.promote([triage, reply], generation=1)["payload"]
    conflict = lambda patch: experiment_conflict({**payload, **patch})  # noqa: E731

    assert conflict({"experiments": [exp("exp_a", "support.triage", [triage_b]), exp("exp_b", "support.reply")]}) is None
    assert conflict({"experiment": untagged(exp("exp_legacy", "x")), "experiments": [exp("exp_b", "support.reply")]}) == "experiment_conflict"
    assert conflict({"experiments": [exp("exp_a", "support.triage"), exp("exp_b", "support.triage")]}) == "experiment_conflict"
    assert conflict({"experiments": [exp("exp_a", "support.triage", [reply])]}) == "experiment_conflict"
    assert conflict({"experiments": [exp("exp_a", "docs.missing")]}) == "experiment_conflict"
    assert conflict({"experiments": [exp("exp_a", "support.triage")], "directives": [{"kind": "disable", "scope": "arm", "arm": "candidate", "issuedAt": NOW}]}) == "experiment_conflict"
    assert conflict({"experiments": [exp("exp_a", "support.triage")], "directives": [{"kind": "disable", "scope": "arm", "arm": "candidate", "experimentId": "exp_a", "issuedAt": NOW}]}) is None

    def verify(manifest):
        return verify_manifest(manifest=manifest, root=plane.root, now=NOW, scope=SCOPE, stored_generation=0, payloads=None, countersign_root=None, require_countersign=False)

    good = plane.promote([triage, reply], experiments=[exp("exp_a", "support.triage", [triage_b]), exp("exp_b", "support.reply")])
    assert verify(good).ok
    bad = plane.promote([triage, reply], experiments=[exp("exp_a", "support.triage"), exp("exp_b", "support.triage")])
    verdict = verify(bad)
    assert (verdict.ok, verdict.reason) == (False, "experiment_conflict")
    legacy = plane.promote([triage, reply], experiment=untagged(exp("exp_legacy", "support.triage", [triage_b])))
    assert verify(legacy).ok
    assert len(experiments_of(legacy["payload"])) == 1
    assert experiment_for_tag(legacy["payload"], "support.reply")["experimentId"] == "exp_legacy"


def test_two_prompts_split_independently_and_the_retreat_is_per_experiment(state_dir):
    plane = FakeControlPlane(SCOPE)
    triage = plane.slot(tag="support.triage", text="Triage A", version_id="a", variables=[])
    triage_b = plane.slot(tag="support.triage", text="Triage B", version_id="b", variables=[])
    reply = plane.slot(tag="support.reply", text="Reply A", version_id="a", variables=[])
    # D79: the reply candidate is ANOTHER prompt (its own artifact) served under the reply key.
    retention = {**plane.slot(tag="support.reply", text="Retention script", version_id="r1", variables=[]), "artifactId": "prm_retention"}
    base = release_digest([triage, reply])
    experiments = [
        {"experimentId": "exp_triage", "tag": "support.triage", "salt": "AAECAwQFBgcICQoLDA0ODw", "subjectKey": "request", "arms": [{"arm": "control", "weightBps": 5000, "releaseDigest": base, "overrides": []}, {"arm": "candidate", "weightBps": 5000, "releaseDigest": release_digest([triage_b, reply]), "overrides": [triage_b]}]},
        {"experimentId": "exp_reply", "tag": "support.reply", "salt": "EBESExQVFhcYGRobHB0eHw", "subjectKey": "request", "arms": [{"arm": "control", "weightBps": 5000, "releaseDigest": base, "overrides": []}, {"arm": "candidate", "weightBps": 5000, "releaseDigest": release_digest([triage, retention]), "overrides": [retention]}]},
    ]
    plane.promote([triage, reply], apply_policy="auto", experiments=experiments)
    ap = AirPrompterAgent.start(**KW, api_key=plane.api_key, base_url="https://api.test", state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, sync=SyncOptions(mode="resident", poll_seconds=3600, root_url="https://edge.test/roots/prod/root.json"), transport=plane.transport(), telemetry={"sink": "memory"})
    try:
        subjects = [f"user-{i}" for i in range(400)]
        render = lambda tag, s: ap.prompt(tag, subject=s).render()  # noqa: E731
        triage_candidates = [s for s in subjects if render("support.triage", s).arm == "candidate"]
        reply_candidates = [s for s in subjects if render("support.reply", s).arm == "candidate"]
        assert 150 < len(triage_candidates) < 250, len(triage_candidates)
        assert 150 < len(reply_candidates) < 250, len(reply_candidates)
        both = len([s for s in triage_candidates if s in reply_candidates])
        assert 60 < both < 140, both  # own salts: independent splits
        on_retention = render("support.reply", reply_candidates[0])
        assert (on_retention.text, on_retention.version_id) == ("Retention script", "r1")
        assert render("support.reply", next(s for s in subjects if s not in reply_candidates)).text == "Reply A"
        assert [(r["experimentId"], r["tag"], r["weightBps"]) for r in ap.status().ramps] == [("exp_triage", "support.triage", [5000, 5000]), ("exp_reply", "support.reply", [5000, 5000])]
        assert ap.status().ramp["experimentId"] == "exp_triage"

        plane.promote([triage, reply], apply_policy="auto", experiments=experiments, directives=[{"kind": "disable", "scope": "arm", "experimentId": "exp_reply", "arm": "candidate", "issuedAt": NOW}])
        ap.sync_now()
        assert sum(1 for s in subjects if render("support.reply", s).arm == "candidate") == 0
        assert sum(1 for s in subjects if render("support.triage", s).arm == "candidate") == len(triage_candidates)
        assert [r["weightBps"] for r in ap.status().ramps] == [[5000, 5000], [10000, 0]]
        assert ap.status().disabled["arms"] == ["candidate"]
    finally:
        ap.stop()
