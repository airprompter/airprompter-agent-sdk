"""S7 (AIR-1975): vendored bundles at boot and in git. Parity with ``sdk-typescript/test/vendored.test.ts``."""
from __future__ import annotations

import shutil
import tempfile

import pytest

from airprompter_agent import AirPrompterAgent
from airprompter_agent_core._util import b64url_decode, b64url_encode, instant, iso_ms
from airprompter_agent.agent import SyncOptions
from airprompter_agent_core.bundle.apbundle import create_plaintext_bundle
from airprompter_agent_core.protocol.trust import public_jwk_of

from .control_plane import FakeControlPlane

SCOPE = {"organizationId": "org_1", "agentId": "agt_vendored", "target": "prod"}
KW = {"organization_id": "org_1", "agent_id": "agt_vendored", "target": "prod"}


def bundle_of(plane: FakeControlPlane, not_after: str = "2027-01-01T00:00:00Z") -> dict:
    return create_plaintext_bundle({"createdAt": iso_ms(instant("2026-09-13T00:00:00Z")), "notAfter": not_after, "manifest": plane.manifest, "keySet": plane.root, "payloads": [{"contentHash": h, "byteLength": len(b), "bytes": b64url_encode(b)} for h, b in plane.payloads.items()]})


def slots(plane: FakeControlPlane, version_id: str):
    return [plane.slot(tag="support.reply", text=f"Reply {version_id} to {{{{name}}}}", version_id=version_id, variables=[{"name": "name", "required": False, "trust": "operator"}])]


def online(plane: FakeControlPlane, state_dir: str) -> None:
    ap = AirPrompterAgent.start(**KW, api_key=plane.api_key, base_url="https://api.test", state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, sync=SyncOptions(mode="resident", poll_seconds=3600, root_url="https://edge.test/roots/prod/root.json"), transport=plane.transport(), telemetry={"sink": "memory"})
    ap.stop()


def offline(plane: FakeControlPlane, state_dir: str, bundle: dict, **extra):
    events: list[dict] = []
    ap = AirPrompterAgent.start(**KW, state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, vendored_bundle={"bundle": bundle}, logger=events.append, telemetry={"sink": "memory"}, **extra)
    return ap, events


@pytest.fixture
def state_dir():
    path = tempfile.mkdtemp(prefix="ap-vendored-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


def test_newer_bundle_is_an_update_and_the_policy_decides(state_dir):
    plane = FakeControlPlane(SCOPE)
    plane.promote(slots(plane, "v1"))
    online(plane, state_dir)
    plane.promote(slots(plane, "v2"))
    ap, events = offline(plane, state_dir, bundle_of(plane))
    try:
        assert ap.generation == 2, "the committed bundle moved the host forward at boot"
        assert ap.status().source == "store" and ap.status().apply_state == "active"
        assert ap.prompt("support.reply").render(name="x").text == "Reply v2 to x"
        assert any(e.get("event") == "vendored_bundle_activated" and e.get("generation") == 2 for e in events)
        assert not any(e.get("event") == "vendored_bundle_applied" for e in events), "not the fallback path"
    finally:
        ap.stop()
    plane.promote(slots(plane, "v3"))
    staged: list[int] = []
    waiting, waiting_events = offline(plane, state_dir, bundle_of(plane), apply={"policy": "unlock_required", "on_staged": lambda s: staged.append(s.generation)})
    try:
        assert waiting.generation == 2 and waiting.status().staged_generation == 3 and waiting.status().apply_state == "awaiting_unlock"
        assert staged == [3], "the change-control hook saw the committed bundle"
        assert any(e.get("event") == "vendored_bundle_staged" and e.get("generation") == 3 for e in waiting_events)
        assert waiting.unlock() == {"generation": 3}
        assert waiting.prompt("support.reply").render(name="x").text == "Reply v3 to x"
    finally:
        waiting.stop()
    same, same_events = offline(plane, state_dir, bundle_of(plane))
    try:
        assert same.generation == 3
        assert not any(str(e.get("event", "")).startswith("vendored_bundle_") for e in same_events), "a bundle at the held generation is silent"
    finally:
        same.stop()


def test_revert_is_refused_with_the_sentence_and_tampered_or_expired_newer_bundles_are_refused(state_dir):
    plane = FakeControlPlane(SCOPE)
    plane.promote(slots(plane, "v1"))
    older = bundle_of(plane)
    plane.promote(slots(plane, "v2"))
    online(plane, state_dir)
    ap, events = offline(plane, state_dir, older)
    try:
        assert ap.generation == 2, "never moved backwards"
        refusal = next(e for e in events if e.get("event") == "vendored_bundle_refused")
        assert (refusal["reason"], refusal["bundleGeneration"], refusal["heldGeneration"]) == ("generation_rollback", 1, 2)
        assert "a rollback is `airprompter rollback`, never an older bundle" in refusal["message"]
        assert ap.status().last_refusal == "generation_rollback" and ap.status().apply_state == "refused"
        assert ap.prompt("support.reply").render(name="x").text == "Reply v2 to x"
    finally:
        ap.stop()
    plane.promote(slots(plane, "v3"))
    tampered = bundle_of(plane)
    contents = tampered["encryption"]["contents"]
    referenced = next(entry for entry in contents["payloads"] if entry["contentHash"] == contents["manifest"]["payload"]["slots"][0]["contentHash"])
    assert b64url_decode(referenced["bytes"]).startswith(b"Reply v3")
    referenced["bytes"] = b64url_encode(b"Reply tampered to {{name}}")
    safe, safe_events = offline(plane, state_dir, tampered)
    try:
        assert safe.generation == 2 and safe.status().staged_generation is None
        assert any(e.get("event") == "vendored_bundle_refused" and e.get("reason") == "payload_hash_mismatch" for e in safe_events)
    finally:
        safe.stop()
    stale, stale_events = offline(plane, state_dir, bundle_of(plane, "2026-01-01T00:00:00Z"))
    try:
        assert stale.generation == 2
        assert any(e.get("event") == "vendored_bundle_refused" and e.get("reason") == "expired" for e in stale_events)
    finally:
        stale.stop()
