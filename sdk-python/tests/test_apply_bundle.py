"""T39: the fleet pattern. One puller (``pull_bundle``, no store, the only Agent key) writes each release into a
customer's own store; every runtime holds no key, boots from the newest row, and hands the next row to
``apply_bundle()`` when the generation rises. A dial is a new generation and lands on every runtime the same way; an
older row is refused; a restart serves the applied generation from the host's store with no network;
``unlock_required`` stages instead of activating."""

from __future__ import annotations

import json
import shutil
import tempfile

import httpx
from datetime import datetime, timezone
import pytest

from airprompter_agent.agent import AgentStartError, AirPrompterAgent
from airprompter_agent_core.bundle.apbundle import create_encrypted_bundle
from airprompter_agent_core._util import b64url_encode
from airprompter_agent_core.bundle.apbundle import DistributionKey
from airprompter_agent_core.bundle.hpke import generate_x25519_key_pair
from airprompter_agent_core.control.client import SyncClient
from airprompter_agent_core.protocol.trust import public_jwk_of, trusted_root_from_pinned_key
from airprompter_agent_sync import next_pull_delay_ms, pull_bundle

from .control_plane import FakeControlPlane

SCOPE = {"organizationId": "org_1", "agentId": "agt_1", "target": "prod"}
KW = {"organization_id": "org_1", "agent_id": "agt_1", "target": "prod"}


class ReleaseTable:
    """The customer's store: one row per generation, newest wins."""

    def __init__(self) -> None:
        self.rows: dict[int, dict] = {}

    def newest(self) -> dict | None:
        if not self.rows:
            return None
        generation = max(self.rows)
        return {"generation": generation, **self.rows[generation]}


def puller(plane: FakeControlPlane, table: ReleaseTable, distribution_public_key: bytes, scope: dict = SCOPE):
    client = SyncClient(base_url="https://api.test", agent_id=scope["agentId"], target=scope["target"], api_key=plane.api_key, transport=plane.transport())
    trusted_root = trusted_root_from_pinned_key(purpose="platform", environment="prod", pinned_root=public_jwk_of(plane.root_key))
    edge = httpx.Client(transport=plane.transport())

    def fetch_root():
        return edge.get("https://edge.test/roots/prod/root.json").json()

    def pull() -> int:
        result = pull_bundle(client=client, scope=scope, trusted_root=trusted_root, fetch_root=fetch_root, now=lambda: "2026-09-16T00:00:00.000Z", distribution_public_key=distribution_public_key)
        assert result.status == "ok", result
        table.rows.setdefault(result.generation, {"bundle": json.dumps(result.bundle), "release_digest": result.release_digest})
        return result.generation

    return pull


def _no_network(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("runtimes never reach the control plane", request=request)


def test_puller_store_apply_bundle_dial_refuse_restart():
    plane = FakeControlPlane(SCOPE)
    control = plane.slot(tag="support.reply", text="Reply politely to {{name}}.", variables=[{"name": "name", "required": False, "trust": "operator"}], version_id="ver_1")
    plane.promote([control])
    fleet = generate_x25519_key_pair()
    key = DistributionKey(fleet.private_key, fleet.public_raw)
    table = ReleaseTable()
    pull = puller(plane, table, fleet.public_raw)
    assert pull() == 1
    assert "Reply politely" not in table.newest()["bundle"], "the row is ciphertext"

    dir_a = tempfile.mkdtemp(prefix="ap-apply-a-")
    dir_b = tempfile.mkdtemp(prefix="ap-apply-b-")
    try:
        boot = lambda d: AirPrompterAgent.start(**KW, state_dir=d, root={"pinned": public_jwk_of(plane.root_key)}, transport=httpx.MockTransport(_no_network), distribution_key=key, vendored_bundle={"bundle": json.loads(table.newest()["bundle"])})
        a = boot(dir_a)
        b = boot(dir_b)
        assert a.generation == 1
        assert b.prompt("support.reply").render(name="Ann").text == "Reply politely to Ann."

        candidate = plane.slot(tag="support.reply", text="Reply warmly to {{name}}.", variables=[{"name": "name", "required": False, "trust": "operator"}], version_id="ver_2")
        plane.promote([control], experiment={"experimentId": "exp_1", "salt": "AAECAwQFBgcICQoLDA0ODw", "subjectKey": "request", "arms": [{"arm": "control", "weightBps": 5000, "releaseDigest": "sha256:" + "0" * 64, "overrides": []}, {"arm": "candidate", "weightBps": 5000, "releaseDigest": "sha256:" + "1" * 64, "overrides": [candidate]}]})
        assert pull() == 2
        changes: list[int] = []
        a.on_change(lambda change: changes.append(change.generation) if change.generation is not None else None)
        assert a.apply_bundle(table.newest()["bundle"]) == {"outcome": "activated", "generation": 2}
        assert b.apply_bundle(json.loads(table.newest()["bundle"])) == {"outcome": "activated", "generation": 2}
        assert changes == [2]
        assert a.prompt("support.reply", subject="customer-42").render(name="Ann").text == b.prompt("support.reply", subject="customer-42").render(name="Ann").text
        assert a.apply_bundle(table.newest()["bundle"]) == {"outcome": "unchanged", "generation": 2}

        stale = a.apply_bundle(table.rows[1]["bundle"])
        assert stale["outcome"] == "refused" and stale["reason"] == "generation_rollback"
        assert a.generation == 2

        other = FakeControlPlane({**SCOPE, "target": "staging"}, hosted_environment="prod")
        other.promote([other.slot(tag="support.reply", text="staging text", version_id="ver_s")])
        other_table = ReleaseTable()
        puller(other, other_table, fleet.public_raw, {**SCOPE, "target": "staging"})()
        relabelled = a.apply_bundle(other_table.newest()["bundle"])
        assert relabelled["outcome"] == "refused"

        a.stop()
        again = AirPrompterAgent.start(**KW, state_dir=dir_a, root={"pinned": public_jwk_of(plane.root_key)}, transport=httpx.MockTransport(_no_network), distribution_key=key)
        assert again.generation == 2 and again.status().source == "store"
        again.stop()
        b.stop()
    finally:
        shutil.rmtree(dir_a, ignore_errors=True)
        shutil.rmtree(dir_b, ignore_errors=True)


def test_apply_bundle_unlock_required_stages_and_plaintext_off_dev_refused():
    plane = FakeControlPlane(SCOPE)
    plane.promote([plane.slot(tag="support.reply", text="v1", version_id="ver_1")])
    fleet = generate_x25519_key_pair()
    key = DistributionKey(fleet.private_key, fleet.public_raw)
    table = ReleaseTable()
    pull = puller(plane, table, fleet.public_raw)
    pull()
    d = tempfile.mkdtemp(prefix="ap-apply-u-")
    try:
        staged: list[int] = []
        ap = AirPrompterAgent.start(**KW, state_dir=d, root={"pinned": public_jwk_of(plane.root_key)}, transport=httpx.MockTransport(_no_network), distribution_key=key, vendored_bundle={"bundle": json.loads(table.newest()["bundle"])}, apply={"on_staged": lambda s: staged.append(s.generation)})
        plane.promote([plane.slot(tag="support.reply", text="v2", version_id="ver_2")], apply_policy="unlock_required")
        pull()
        assert ap.apply_bundle(table.newest()["bundle"]) == {"outcome": "staged", "generation": 2}
        assert staged == [2] and ap.generation == 1 and ap.status().apply_state == "awaiting_unlock"
        assert ap.unlock() == {"generation": 2}
        assert ap.prompt("support.reply").render().text == "v2"
        ap.stop()
    finally:
        shutil.rmtree(d, ignore_errors=True)

    client = SyncClient(base_url="https://api.test", agent_id="agt_1", target="prod", api_key=plane.api_key, transport=plane.transport())
    plaintext = pull_bundle(client=client, scope=SCOPE, trusted_root=trusted_root_from_pinned_key(purpose="platform", environment="prod", pinned_root=public_jwk_of(plane.root_key)), now=lambda: "2026-09-16T00:00:00.000Z", distribution_public_key=None)
    assert (plaintext.status, plaintext.reason) == ("refused", "plaintext_not_allowed")

def _forged(plane: FakeControlPlane, public_raw: bytes, generation: int, not_after: str = "2027-01-01T00:00:00Z") -> str:
    """A bundle re-sealed to the fleet's public key (no secret) around a manifest the trusted root did not sign."""
    rogue = FakeControlPlane(SCOPE, "apa_live_testkey")
    rogue.root_key = plane.root_key
    manifest = rogue.promote([rogue.slot(tag="support.reply", text="forged", version_id="ver_x")], generation=generation)
    contents = {"createdAt": "2026-09-16T00:00:00.000Z", "notAfter": not_after, "manifest": manifest, "keySet": plane.root, "payloads": [{"contentHash": h, "byteLength": len(b), "bytes": b64url_encode(b)} for h, b in rogue.payloads.items()]}
    return json.dumps(create_encrypted_bundle(contents, public_raw))


def test_compromised_store_cannot_poison_a_runtime():
    plane = FakeControlPlane(SCOPE)
    plane.promote([plane.slot(tag="support.reply", text="v1", version_id="ver_1")])
    fleet = generate_x25519_key_pair()
    key = DistributionKey(fleet.private_key, fleet.public_raw)
    table = ReleaseTable()
    pull = puller(plane, table, fleet.public_raw)
    pull()
    d = tempfile.mkdtemp(prefix="ap-poison-")
    try:
        events: list[dict] = []
        with pytest.raises(AgentStartError):
            AirPrompterAgent.start(**KW, state_dir=d, root={"pinned": public_jwk_of(plane.root_key)}, transport=httpx.MockTransport(_no_network), distribution_key=key, vendored_bundle={"bundle": json.loads(_forged(plane, fleet.public_raw, 999))}, logger=events.append)
        assert any(e.get("event") == "vendored_bundle_refused" for e in events), events
        real = AirPrompterAgent.start(**KW, state_dir=d, root={"pinned": public_jwk_of(plane.root_key)}, transport=httpx.MockTransport(_no_network), distribution_key=key, vendored_bundle={"bundle": json.loads(table.newest()["bundle"])})
        assert real.generation == 1, "the forgery left no generation behind"
        forged = real.apply_bundle(_forged(plane, fleet.public_raw, 2))
        assert forged["outcome"] == "refused" and forged["reason"] in ("signature_invalid", "unknown_signing_key")
        assert real.generation == 1
        expired = real.apply_bundle(_forged(plane, fleet.public_raw, 3, "2020-01-01T00:00:00Z"))
        assert expired["reason"] == "expired"
        other = generate_x25519_key_pair()
        other_table = ReleaseTable()
        puller(plane, other_table, other.public_raw)()
        assert real.apply_bundle(other_table.newest()["bundle"])["outcome"] == "refused"
        real.stop()
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_staged_first_release_is_a_held_generation_for_apply_bundle():
    plane = FakeControlPlane(SCOPE)
    plane.promote([plane.slot(tag="support.reply", text="v1", version_id="ver_1")], apply_policy="unlock_required")
    fleet = generate_x25519_key_pair()
    table = ReleaseTable()
    puller(plane, table, fleet.public_raw)()
    d = tempfile.mkdtemp(prefix="ap-staged-")
    try:
        from airprompter_agent.agent import SyncOptions
        ap = AirPrompterAgent.start(**KW, api_key=plane.api_key, base_url="https://api.test", state_dir=d, root={"pinned": public_jwk_of(plane.root_key)}, sync=SyncOptions(mode="resident", poll_seconds=3600, root_url="https://edge.test/roots/prod/root.json"), transport=plane.transport(), distribution_key=DistributionKey(fleet.private_key, fleet.public_raw))
        assert ap.status().apply_state == "awaiting_unlock"
        assert ap.apply_bundle(table.newest()["bundle"]) == {"outcome": "unchanged", "generation": 1}
        assert ap.generation == 0 and ap.status().apply_state == "awaiting_unlock"
        assert ap.unlock() == {"generation": 1}
        ap.stop()
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_rollback_holds_back_a_row_until_a_newer_generation():
    plane = FakeControlPlane(SCOPE)
    plane.promote([plane.slot(tag="support.reply", text="v1", version_id="ver_1")])
    fleet = generate_x25519_key_pair()
    key = DistributionKey(fleet.private_key, fleet.public_raw)
    table = ReleaseTable()
    pull = puller(plane, table, fleet.public_raw)
    pull()
    d = tempfile.mkdtemp(prefix="ap-hold-")
    try:
        ap = AirPrompterAgent.start(**KW, state_dir=d, root={"pinned": public_jwk_of(plane.root_key)}, transport=httpx.MockTransport(_no_network), distribution_key=key, vendored_bundle={"bundle": json.loads(table.newest()["bundle"])})
        plane.promote([plane.slot(tag="support.reply", text="v2", version_id="ver_2")])
        pull()
        row = table.newest()["bundle"]
        assert ap.apply_bundle(row) == {"outcome": "activated", "generation": 2}
        assert ap.rollback() == {"generation": 1, "forced": True}
        assert ap.apply_bundle(row)["outcome"] == "held_back"
        plane.promote([plane.slot(tag="support.reply", text="v3", version_id="ver_3")])
        pull()
        assert ap.apply_bundle(table.newest()["bundle"]) == {"outcome": "activated", "generation": 3}
        ap.stop()
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_pointer_first_pull_polls_the_cdn_not_the_origin():
    plane = FakeControlPlane(SCOPE)
    plane.promote([plane.slot(tag="support.reply", text="Reply politely.", version_id="ver_1")])
    fleet_key = generate_x25519_key_pair()
    client = SyncClient(base_url="https://api.test", agent_id=SCOPE["agentId"], target=SCOPE["target"], api_key=plane.api_key, transport=plane.transport())
    trusted_root = trusted_root_from_pinned_key(purpose="platform", environment="prod", pinned_root=public_jwk_of(plane.root_key))
    edge_http = httpx.Client(transport=plane.transport())
    fetch_root = lambda: edge_http.get("https://edge.test/roots/prod/root.json").json()  # noqa: E731
    origin_calls = lambda: sum(1 for u in plane.requests if "/manifest" in u)  # noqa: E731
    pointer_calls = lambda: sum(1 for u in plane.requests if u.endswith("/generation.json"))  # noqa: E731
    base = dict(client=client, scope=SCOPE, trusted_root=trusted_root, fetch_root=fetch_root, now=lambda: "2026-09-17T00:00:00.000Z", distribution_public_key=fleet_key.public_raw)

    first = pull_bundle(**base)
    assert first.status == "ok"
    assert first.edge.pointer_url == "https://edge.test/g/target-token/generation.json"
    assert first.edge.manifest_etag
    assert pointer_calls() == 0
    held = first.generation

    before = origin_calls()
    second = pull_bundle(**base, edge=first.edge, minimum_generation=held)
    assert (second.status, second.via) == ("unchanged", "pointer")
    assert second.edge.pointer_etag
    third = pull_bundle(**base, edge=second.edge, minimum_generation=held)
    assert (third.status, third.via) == ("unchanged", "pointer")
    assert origin_calls() == before, "two idle pulls, zero origin calls"
    assert pointer_calls() == 2

    plane.promote([plane.slot(tag="support.reply", text="Reply warmly.", version_id="ver_2")])
    fourth = pull_bundle(**base, edge=third.edge, minimum_generation=held)
    assert fourth.status == "ok" and fourth.generation == held + 1
    assert origin_calls() == before + 1
    held = fourth.generation

    nudged = pull_bundle(**base, edge=fourth.edge, minimum_generation=held, skip_pointer=True)
    assert (nudged.status, nudged.via) == ("unchanged", "origin")
    assert origin_calls() == before + 2

    assert next_pull_delay_ms(outcome="unchanged", unchanged_streak=0, interval_ms=10_000) == 10_000
    assert next_pull_delay_ms(outcome="unchanged", unchanged_streak=3, interval_ms=10_000) == 80_000
    assert next_pull_delay_ms(outcome="unchanged", unchanged_streak=12, interval_ms=10_000) == 300_000
    assert next_pull_delay_ms(outcome="unchanged", unchanged_streak=12, interval_ms=10_000, cap_ms=60_000) == 60_000
    assert next_pull_delay_ms(outcome="ok", unchanged_streak=12, interval_ms=10_000) == 10_000

    plane.edge_pointer_url = None
    bare = pull_bundle(**base)
    assert bare.status == "ok" and bare.edge.pointer_url is None
    bare_again = pull_bundle(**base, edge=bare.edge, minimum_generation=held)
    assert (bare_again.status, bare_again.via) == ("unchanged", "origin")

def test_pointer_hides_nothing_for_long():
    plane = FakeControlPlane(SCOPE)
    plane.promote([plane.slot(tag="support.reply", text="Reply politely.", version_id="ver_1")])
    fleet_key = generate_x25519_key_pair()
    clock = {"ms": 1789000000000}
    now = lambda: datetime.fromtimestamp(clock["ms"] / 1000, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")  # noqa: E731
    inner = plane.transport()
    mode = {"origin_fail": False, "pointer": "ok"}

    class Transport(httpx.BaseTransport):
        def handle_request(self, request):
            url = str(request.url)
            if url.endswith("/generation.json") and mode["pointer"] == "outage":
                raise httpx.ConnectError("cdn unreachable")
            if url.endswith("/generation.json") and mode["pointer"] == "garbage":
                return httpx.Response(200, text="<html>not json</html>")
            if "/payloads/" in url and mode["origin_fail"]:
                raise httpx.ConnectError("origin blip")
            return inner.handle_request(request)

    client = SyncClient(base_url="https://api.test", agent_id=SCOPE["agentId"], target=SCOPE["target"], api_key=plane.api_key, transport=Transport())
    trusted_root = trusted_root_from_pinned_key(purpose="platform", environment="prod", pinned_root=public_jwk_of(plane.root_key))
    edge_http = httpx.Client(transport=plane.transport())
    fetch_root = lambda: edge_http.get("https://edge.test/roots/prod/root.json").json()  # noqa: E731
    origin_calls = lambda: sum(1 for u in plane.requests if "/manifest" in u)  # noqa: E731
    base = dict(client=client, scope=SCOPE, trusted_root=trusted_root, fetch_root=fetch_root, now=now, distribution_public_key=fleet_key.public_raw)

    first = pull_bundle(**base)
    assert first.status == "ok" and first.edge.last_origin_at
    edge, held = first.edge, first.generation

    # 1. The pointer moves, the origin blips mid-pull: the edge handed in comes back untouched; the next pull sees the move.
    plane.promote([plane.slot(tag="support.reply", text="Reply warmly.", version_id="ver_2")])
    mode["origin_fail"] = True
    blip = pull_bundle(**base, edge=edge, minimum_generation=held)
    assert blip.status == "unavailable" and blip.edge == edge
    mode["origin_fail"] = False
    recovered = pull_bundle(**base, edge=blip.edge, minimum_generation=held)
    assert recovered.status == "ok"
    edge, held = recovered.edge, recovered.generation

    # 2. A pinned pointer hides a promotion only until max_pointer_age_ms.
    plane.pinned_pointer = held
    plane.promote([plane.slot(tag="support.reply", text="Reply briefly.", version_id="ver_3")])
    before = origin_calls()
    for _ in range(5):
        clock["ms"] += 60_000
        r = pull_bundle(**base, edge=edge, minimum_generation=held)
        assert (r.status, r.via) == ("unchanged", "pointer")
        edge = r.edge
    assert origin_calls() == before
    clock["ms"] += 60 * 60_000 + 1
    bounded = pull_bundle(**base, edge=edge, minimum_generation=held)
    assert bounded.status == "ok" and bounded.generation == held + 1
    edge, held = bounded.edge, bounded.generation
    plane.pinned_pointer = None

    # 3. A CDN outage or a pointer that is not JSON is not an answer: the origin is asked, conditionally.
    mode["pointer"] = "outage"
    outage = pull_bundle(**base, edge=edge, minimum_generation=held)
    assert (outage.status, outage.via) == ("unchanged", "origin")
    mode["pointer"] = "garbage"
    garbage = pull_bundle(**base, edge=outage.edge, minimum_generation=held)
    assert (garbage.status, garbage.via) == ("unchanged", "origin")
