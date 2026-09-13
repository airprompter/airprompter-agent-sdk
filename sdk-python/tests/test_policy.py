"""S4 (AIR-1972): the apply policy is the customer's.

The first verified manifest pins the host's policy in store.json (trust on
first use); a later manifest may tighten the pin and never loosen it; only
an operator's act loosens it; the set of directive kinds honoured without a
local act is closed (``disable`` acts, ``request_unlock`` asks) and an
unknown kind refuses the manifest whole. Parity with
``sdk-typescript/test/policy.test.ts``.
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import time

import pytest

from airprompter_agent import AirPrompterAgent, RenderRefusedError
from airprompter_agent.agent import SyncOptions
from airprompter_agent.protocol.trust import public_jwk_of
from airprompter_agent.store.slot_store import SlotStore

from .control_plane import FakeControlPlane

SCOPE = {"organizationId": "org_1", "agentId": "agt_policy", "target": "prod"}
KW = {"organization_id": "org_1", "agent_id": "agt_policy", "target": "prod"}


def slots(plane: FakeControlPlane, version_id: str = "v1"):
    return [plane.slot(tag="support.reply", text=f"Reply {version_id} to {{{{name}}}}", version_id=version_id, variables=[{"name": "name", "required": False, "trust": "operator"}])]


def start(plane: FakeControlPlane, state_dir: str, clock, **extra):
    options = {
        **KW,
        "api_key": plane.api_key,
        "base_url": "https://api.test",
        "state_dir": state_dir,
        "root": {"pinned": public_jwk_of(plane.root_key)},
        "sync": SyncOptions(mode="resident", poll_seconds=3600, root_url="https://edge.test/roots/prod/root.json"),
        "transport": plane.transport(),
        "now": clock,
        "telemetry": {"sink": "memory"},
    }
    options.update(extra)
    ap = AirPrompterAgent.start(**options)
    time.sleep(0.3)  # the boot heartbeat rides its own thread; let it land before the case moves the clock
    return ap


def store_file(state_dir: str) -> dict:
    with open(os.path.join(SlotStore.path(state_dir=state_dir, agent_id=SCOPE["agentId"], target=SCOPE["target"]), "store.json"), encoding="utf-8") as f:
        return json.load(f)


def pin_of(state_dir: str) -> dict:
    pin = store_file(state_dir)["applyPolicyPin"]
    return {"value": pin["value"], "source": pin["source"], "generation": pin["generation"]}


@pytest.fixture
def state_dir():
    path = tempfile.mkdtemp(prefix="ap-policy-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


class Clock:
    def __init__(self, ms: float):
        self.ms = ms

    def __call__(self) -> float:
        return self.ms


def test_trust_on_first_use_tighten_never_loosen_operator_loosens(state_dir):
    plane = FakeControlPlane(SCOPE)
    clock = Clock(1_789_300_800_000.0)
    events: list[dict] = []
    plane.promote(slots(plane), apply_policy="auto")
    ap = start(plane, state_dir, clock, logger=events.append)
    assert ap.generation == 1
    assert pin_of(state_dir) == {"value": "auto", "source": "manifest", "generation": 1}
    assert any(e.get("event") == "apply_policy_pinned" and e.get("policy") == "auto" and e.get("generation") == 1 for e in events)
    assert ap.status().apply_policy == {"effective": "auto", "source": "pinned", "manifestSaid": "auto"}

    # The console tightens: the pin follows, and the release waits.
    plane.promote(slots(plane, "v2"), apply_policy="unlock_required")
    clock.ms += 1000
    ap.sync_now()
    assert ap.status().last_sync_outcome == "staged"
    assert pin_of(state_dir) == {"value": "unlock_required", "source": "manifest", "generation": 2}
    assert any(e.get("event") == "apply_policy_tightened" and e.get("from") == "auto" and e.get("generation") == 2 for e in events)
    assert ap.unlock() == {"generation": 2}

    # The console flips back to auto and promotes: pinned, so staged, not live.
    plane.promote(slots(plane, "v3"), apply_policy="auto")
    clock.ms += 1000
    ap.sync_now()
    assert ap.status().last_sync_outcome == "staged", "auto from the manifest did not activate anything"
    assert ap.generation == 2 and ap.status().staged_generation == 3
    assert ap.status().apply_policy == {"effective": "unlock_required", "source": "pinned", "manifestSaid": "auto"}
    assert ap.heartbeat_body()["applyPolicy"] == {"effective": "unlock_required", "source": "pinned"}
    advisory = [e for e in events if e.get("event") == "apply_policy_manifest_advisory"]
    assert len(advisory) == 1 and advisory[0]["generation"] == 3 and advisory[0]["pinned"] == "unlock_required"
    clock.ms += 1000
    ap.sync_now()
    assert len([e for e in events if e.get("event") == "apply_policy_manifest_advisory"]) == 1, "one line per generation"
    assert pin_of(state_dir)["value"] == "unlock_required", "the manifest never loosened the pin"
    ap.unlock()
    assert ap.generation == 3

    # The operator loosens — the one way. The next release applies automatically.
    assert ap.set_apply_policy("auto", by="seth") == {"effective": "auto", "source": "operator", "manifestSaid": "auto"}
    assert pin_of(state_dir)["source"] == "operator"
    assert any(e.get("event") == "apply_policy_set" and e.get("policy") == "auto" and e.get("previous") == "unlock_required" and e.get("by") == "seth" for e in events)
    plane.promote(slots(plane, "v4"), apply_policy="auto")
    clock.ms += 1000
    ap.sync_now()
    assert ap.status().last_sync_outcome == "activated" and ap.generation == 4
    assert ap.prompt("support.reply").render(name="x").text == "Reply v4 to x"

    # A manifest may always tighten, even over the operator's auto; and auto again changes nothing.
    plane.promote(slots(plane, "v5"), apply_policy="unlock_required")
    clock.ms += 1000
    ap.sync_now()
    assert ap.status().last_sync_outcome == "staged"
    assert pin_of(state_dir) == {"value": "unlock_required", "source": "manifest", "generation": 5}
    ap.unlock()
    plane.promote(slots(plane, "v6"), apply_policy="auto")
    clock.ms += 1000
    ap.sync_now()
    assert ap.status().last_sync_outcome == "staged" and ap.generation == 5
    ap.stop()

    # The pin survives a restart.
    again = start(plane, state_dir, clock)
    assert again.status().apply_policy == {"effective": "unlock_required", "source": "pinned", "manifestSaid": None}
    assert again.status().staged_generation == 6
    again.stop()


def test_local_unlock_required_sits_on_top_and_local_auto_is_not_a_loosening(state_dir):
    plane = FakeControlPlane(SCOPE)
    clock = Clock(1_789_300_800_000.0)
    plane.promote(slots(plane), apply_policy="auto")
    first = start(plane, state_dir, clock)
    assert first.generation == 1
    first.stop()
    strict = start(plane, state_dir, clock, apply={"policy": "unlock_required"})
    assert strict.status().apply_policy == {"effective": "unlock_required", "source": "local", "manifestSaid": None}
    plane.promote(slots(plane, "v2"), apply_policy="auto")
    clock.ms += 1000
    strict.sync_now()
    assert strict.status().last_sync_outcome == "staged"
    assert strict.status().apply_policy == {"effective": "unlock_required", "source": "local", "manifestSaid": "auto"}
    assert pin_of(state_dir)["value"] == "auto", "the local option is this process's, not the host's pin"
    strict.unlock()
    strict.stop()
    plane.promote(slots(plane, "v3"), apply_policy="unlock_required")
    clock.ms += 1000
    lax = start(plane, state_dir, clock, apply={"policy": "auto"})
    lax.sync_now()  # the boot heartbeat's latestGeneration may already have staged it (S3); either way it is staged, not live
    assert lax.generation == 2 and lax.status().staged_generation == 3
    assert lax.status().apply_policy == {"effective": "unlock_required", "source": "pinned", "manifestSaid": "unlock_required"}
    lax.unlock()
    plane.promote(slots(plane, "v4"), apply_policy="auto")
    clock.ms += 1000
    lax.sync_now()
    assert lax.status().last_sync_outcome == "staged", "a local auto does not override the pinned unlock_required"
    lax.stop()


def test_pushable_set_is_closed(state_dir):
    plane = FakeControlPlane(SCOPE)
    clock = Clock(1_789_300_800_000.0)
    events: list[dict] = []
    plane.promote(slots(plane), apply_policy="auto")
    ap = start(plane, state_dir, clock, logger=events.append)
    plane.promote(slots(plane, "v1b"), apply_policy="unlock_required")
    clock.ms += 1000
    ap.sync_now()
    ap.unlock()
    assert ap.generation == 2 and ap.status().apply_policy["effective"] == "unlock_required"

    # An unknown kind beside a Freeze: the whole manifest is refused, so the Freeze does not land by halves.
    plane.promote(slots(plane, "v2"), apply_policy="unlock_required", directives=[{"kind": "reboot", "issuedAt": "2026-09-13T12:00:00Z"}, {"kind": "disable", "scope": "agent", "issuedAt": "2026-09-13T12:00:00Z"}])
    clock.ms += 1000
    ap.sync_now()
    assert ap.status().last_sync_outcome == "refused" and ap.status().last_refusal == "directive_unknown"
    assert ap.status().apply_state == "refused"
    assert ap.heartbeat_body()["refusal"] == "directive_unknown", "counted on the heartbeat"
    assert ap.generation == 2 and ap.status().staged_generation is None
    assert ap.status().disabled == {"agent": False, "slots": [], "arms": []}, "the disable beside the unknown kind was not obeyed"
    assert ap.prompt("support.reply").render(name="x").text == "Reply v1b to x"
    assert any(e.get("event") == "sync_refused" and e.get("reason") == "directive_unknown" and e.get("generation") == 3 for e in events)

    # `disable` alone is the reduction the cloud may push: it lands on a pinned unlock_required host with no local act.
    plane.promote(slots(plane, "v3"), apply_policy="unlock_required", directives=[{"kind": "disable", "scope": "agent", "issuedAt": "2026-09-13T12:00:00Z", "reason": "incident"}])
    clock.ms += 1000
    ap.sync_now()
    assert ap.status().last_sync_outcome == "staged" and ap.generation == 2
    assert ap.status().disabled == {"agent": True, "slots": [], "arms": []}
    with pytest.raises(RenderRefusedError) as refused:
        ap.prompt("support.reply").render(name="x")
    assert refused.value.reason == "disabled"

    # `request_unlock` asks; it never activates.
    digest = plane.manifest["payload"]["releaseDigest"]
    plane.promote(slots(plane, "v3"), apply_policy="unlock_required", directives=[{"kind": "request_unlock", "releaseDigest": digest, "requestedBy": "usr_console", "requestedAt": "2026-09-13T12:00:00Z", "expiresAt": "2026-09-14T12:00:00Z", "note": "please"}])
    clock.ms += 1000
    ap.sync_now()
    assert ap.generation == 2, "a request is not an act"
    assert len(ap.status().unlock_requests) == 1
    assert ap.status().disabled == {"agent": False, "slots": [], "arms": []}, "the newer manifest lifted the Freeze"
    ap.stop()
