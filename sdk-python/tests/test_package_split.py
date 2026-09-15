"""S10 — the package split, Python mirror of ``sdk-typescript/test/packageSplit.test.ts``.

1. The direction is core → clients → agent; the edge set is pinned; a planted upward import fails the lint.
2. ``airprompter-agent-runtime`` alone renders and assigns over a bundle the customer loads — verified like OTA,
   no store, no daemon, no network; a relabelled, stranger-signed or tampered bundle is refused.
3. The runtime walks the protocol's ramp vectors over a bundle release with no facade.
4. The five distributions carry one version with siblings exact-pinned, and the lockstep check says so.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

from airprompter_agent_core._util import b64url_encode, instant, iso_ms
from airprompter_agent_core.bundle.apbundle import create_plaintext_bundle
from airprompter_agent_core.protocol.trust import public_jwk_of, trusted_root_from_pinned_key
from airprompter_agent_core.release.bundle_release import BundleRelease, BundleReleaseRefused
from airprompter_agent_runtime.release.resolver import ReleaseResolver

from .control_plane import FakeControlPlane

HERE = os.path.dirname(__file__)
SDK_PY = os.path.abspath(os.path.join(HERE, ".."))
SCOPE = {"organizationId": "org_1", "agentId": "agt_split", "target": "prod"}
NOW = "2026-09-13T00:00:00Z"
PACKAGES = ["core", "sync", "runtime", "telemetry", "agent"]


def bundle_of(plane: FakeControlPlane, not_after: str = "2027-01-01T00:00:00Z") -> dict:
    return create_plaintext_bundle({"createdAt": iso_ms(instant(NOW)), "notAfter": not_after, "manifest": plane.manifest, "keySet": plane.root, "payloads": [{"contentHash": h, "byteLength": len(b), "bytes": b64url_encode(b)} for h, b in plane.payloads.items()]})


def pinned(plane: FakeControlPlane) -> dict:
    return trusted_root_from_pinned_key(purpose="platform", environment="prod", pinned_root=public_jwk_of(plane.root_key))


def lint(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, os.path.join(SDK_PY, "tools", "lint_imports.py"), *args], capture_output=True, text=True)


def test_direction_is_pinned_and_a_planted_upward_import_fails_the_lint():
    clean = lint("--json")
    assert clean.returncode == 0, clean.stderr
    edges = json.loads(clean.stdout[: clean.stdout.rindex("}") + 1])["edges"]
    assert edges == ["agent→core", "agent→runtime", "agent→sync", "agent→telemetry", "runtime→core", "sync→core", "telemetry→core"]
    probe = os.path.join(SDK_PY, "packages", "telemetry", "src", "airprompter_agent_telemetry", "_lint_probe.py")
    with open(probe, "w", encoding="utf-8") as f:
        f.write("from airprompter_agent_sync.store.slot_store import SlotStore\nPROBE = SlotStore\n")
    try:
        planted = lint()
        assert planted.returncode == 1
        assert "telemetry (layer 1) may not import sync (layer 1)" in planted.stderr
    finally:
        os.unlink(probe)


def test_runtime_alone_renders_and_assigns_over_a_bundle_and_refuses_what_the_chain_refuses():
    plane = FakeControlPlane(SCOPE)
    control = plane.slot(tag="support.reply", text="Reply A to {{name}}", version_id="v1", variables=[{"name": "name", "required": True, "trust": "operator"}])
    candidate = plane.slot(tag="support.reply", text="Reply B to {{name}}", version_id="v2", variables=[{"name": "name", "required": True, "trust": "operator"}])
    digest = "sha256:" + "0" * 64
    plane.promote([control], experiment={"experimentId": "exp_1", "salt": "c2FsdHNhbHRzYWx0c2FsdHNhbHQ", "subjectKey": "request", "arms": [{"arm": "control", "weightBps": 5000, "releaseDigest": digest, "overrides": []}, {"arm": "candidate", "weightBps": 5000, "releaseDigest": "sha256:" + "1" * 64, "overrides": [candidate]}]})
    bundle = bundle_of(plane)
    loaded = BundleRelease.load(bundle=bundle, root=pinned(plane), scope=SCOPE, now=NOW)
    assert loaded.kind == "bundle"
    resolver = ReleaseResolver(release=loaded.current(), run_ref_key=b"\x07" * 32, agent_id=SCOPE["agentId"], target="prod", instance_id="host-1", now_ms=lambda: instant(NOW))
    seen = set()
    for i in range(100):
        outcome = resolver.resolve("support.reply", f"user-{i}")
        assert outcome.ok and outcome.slot is not None
        rendered = resolver.render(outcome.slot, {"name": "Ada"})
        assert rendered.text in ("Reply A to Ada", "Reply B to Ada")
        assert (rendered.arm == "candidate") == rendered.text.startswith("Reply B"), "the arm's override is the text"
        seen.add(rendered.arm)
    assert seen == {"candidate", "control"}, "a 50/50 split lands on both arms"
    missing = resolver.resolve("nope")
    assert (missing.ok, missing.reason, missing.tag) == (False, "no_slot", "nope")
    # The chain still stands: another agent's bundle, a stranger's root, a tampered payload.
    with pytest.raises(BundleReleaseRefused) as relabelled:
        BundleRelease.load(bundle=bundle, root=pinned(plane), scope={**SCOPE, "agentId": "agt_other"}, now=NOW)
    assert relabelled.value.reason == "bundle_relabelled"
    with pytest.raises(BundleReleaseRefused) as stranger:
        BundleRelease.load(bundle=bundle, root=pinned(FakeControlPlane(SCOPE)), scope=SCOPE, now=NOW)
    assert stranger.value.reason == "unknown_signing_key"
    tampered = json.loads(json.dumps(bundle))
    tampered["encryption"]["contents"]["payloads"][0]["bytes"] = b64url_encode(b"Reply Z to {{name}}")
    with pytest.raises(BundleReleaseRefused) as bad:
        BundleRelease.load(bundle=tampered, root=pinned(plane), scope=SCOPE, now=NOW)
    assert bad.value.reason == "payload_hash_mismatch"


def test_runtime_walks_the_ramp_vectors_over_a_bundle_release_with_no_facade():
    with open(os.path.join(HERE, "..", "..", "protocol", "vectors", "ramp.json"), encoding="utf-8") as f:
        vectors = json.load(f)
    for case in vectors["cases"]:
        plane = FakeControlPlane(SCOPE)
        control = plane.slot(tag="support.reply", text="A", version_id="v1", variables=[])
        candidate = plane.slot(tag="support.reply", text="B", version_id="v2", variables=[])
        arms = [{"arm": a["arm"], "weightBps": a["weightBps"], "releaseDigest": "sha256:" + "0" * 64, "overrides": [candidate] if a["arm"] == "candidate" else []} for a in case["arms"]]
        plane.promote([control], experiment={"experimentId": "exp_ramp", "salt": case["salt"], "subjectKey": "request", "arms": arms, "ramp": case["ramp"]}, directives=[{**d, "issuedAt": d.get("issuedAt", "2026-09-14T00:00:00Z")} for d in case["directives"]])
        loaded = BundleRelease.load(bundle=bundle_of(plane), root=pinned(plane), scope=SCOPE, now=NOW)

        def at(now: str, field: str) -> None:
            resolver = ReleaseResolver(release=loaded.current(), run_ref_key=b"\x01" * 32, agent_id=SCOPE["agentId"], target="prod", instance_id="host", now_ms=lambda: instant(now))
            for entry in case["expected"]["assignments"]:
                outcome = resolver.resolve("support.reply", entry["subject"])
                assert outcome.ok and outcome.slot is not None, f"{case['name']}: {entry['subject']}"
                assert (outcome.slot.bucket, outcome.slot.arm) == (entry["bucket"], entry[field]), f"{case['name']}: {entry['subject']} at {now}"

        if case.get("hosts"):
            at(case["hosts"]["hostA"]["now"], "hostA")
            at(case["hosts"]["hostB"]["now"], "hostB")
        else:
            at(case["now"], "arm")


def test_five_distributions_one_version_exact_pinned_siblings():
    result = subprocess.run([sys.executable, os.path.join(SDK_PY, "tools", "version_lockstep.py")], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    versions = set()
    for name in PACKAGES:
        with open(os.path.join(SDK_PY, "packages", name, "pyproject.toml"), encoding="utf-8") as f:
            text = f.read()
        versions.add(text.split('version = "', 1)[1].split('"', 1)[0])
        deps = text.split("dependencies = [", 1)[1].split("]", 1)[0]
        ours = [line.strip().strip('",') for line in deps.splitlines() if "airprompter-agent" in line]
        expected = {"core": [], "sync": ["airprompter-agent-core"], "runtime": ["airprompter-agent-core"], "telemetry": ["airprompter-agent-core"], "agent": ["airprompter-agent-core", "airprompter-agent-sync", "airprompter-agent-runtime", "airprompter-agent-telemetry"]}[name]
        assert [d.split("==")[0] for d in ours] == expected, f"{name} depends on exactly its siblings below"
        assert all("==" in d for d in ours), f"{name}: exact pins"
    assert len(versions) == 1
    # The version the heartbeat and store.json report is the version that shipped: both constants match pyproject.
    from airprompter_agent_core import SDK_VERSION as core_version
    from airprompter_agent.agent import SDK_VERSION as agent_version

    assert {core_version, agent_version} == versions, "SDK_VERSION is the lockstep version"
