"""Capabilities at the edges of the trust chain, end to end. Parity with ``sdk-typescript/test/capabilityCarry.test.ts``.
A puller without a capability carries what a newer runtime needs. A slot stored without its payload is absent, so a
host that gains the capability comes up serving and picks the slot up at the same generation. A release refused whole
still delivers its disables, and the active release's own disables stand until a newer signed manifest replaces them. A store holding an older major
upgrades in place.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from contextlib import contextmanager

import httpx
import pytest

from airprompter_agent.agent import AgentStartError, AirPrompterAgent, ApplyOptions, GoldenOptions, RenderRefusedError, SyncOptions, VendoredBundle
from airprompter_agent_core._util import b64url_encode, iso_ms, now_ms
from airprompter_agent_core.bundle.apbundle import DistributionKey, create_encrypted_bundle, create_plaintext_bundle, open_bundle
from airprompter_agent_core.bundle.hpke import generate_x25519_key_pair
from airprompter_agent_core.control.client import SyncClient
from airprompter_agent_core.protocol import assignment
from airprompter_agent_core.protocol.canonical_json import canonical_bytes, sha256_prefixed
from airprompter_agent_core.protocol.trust import carried_payloads, experiment_conflict, optional_payloads, public_jwk_of, referenced_payloads, release_digest, slot_hashes, trusted_root_from_pinned_key, verify_manifest
from airprompter_agent_core.release.bundle_release import BundleRelease, BundleReleaseRefused
from airprompter_agent_core.render.run_ref import parse_run_ref, run_ref_key_from
from airprompter_agent_runtime.managed import ManagedAgent, ManagedRunError
from airprompter_agent_runtime.observe import ObserveTarget, observe_call, observe_call_async
from airprompter_agent_sync import pull_bundle
from airprompter_agent_sync.store.key_provider import file_key
from airprompter_agent_sync.store.payload_crypto import encrypt_payload, payload_aad
from airprompter_agent_sync.store.slot_store import SlotStore, StoreError
from airprompter_agent_sync.sync.loop import sync_once

from .control_plane import FakeControlPlane, new_key

SCOPE = {"organizationId": "org_1", "agentId": "agt_1", "target": "prod"}
KW = {"organization_id": "org_1", "agent_id": "agt_1", "target": "prod"}
FUTURE = "future_slots"


@pytest.fixture
def state_dir():
    path = tempfile.mkdtemp(prefix="ap-carry-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


@contextmanager
def gaining():
    """Runs a block as an SDK that implements FUTURE."""
    original = assignment.SUPPORTED_CAPABILITIES
    assignment.SUPPORTED_CAPABILITIES = frozenset({*original, FUTURE})
    try:
        yield
    finally:
        assignment.SUPPORTED_CAPABILITIES = original


def release(plane: FakeControlPlane):
    return plane.slot(tag="support.reply", text="Reply politely."), {**plane.slot(tag="support.future", text="From the future."), "requires": [FUTURE]}


def pull_of(plane: FakeControlPlane, public_raw: bytes):
    client = SyncClient(base_url="https://api.test", agent_id=SCOPE["agentId"], target=SCOPE["target"], api_key=plane.api_key, transport=plane.transport())
    trusted_root = trusted_root_from_pinned_key(purpose="platform", environment="prod", pinned_root=public_jwk_of(plane.root_key))
    return pull_bundle(client=client, scope=SCOPE, trusted_root=trusted_root, fetch_root=lambda: plane.root, now=lambda: iso_ms(now_ms()), distribution_public_key=public_raw)


def start(plane: FakeControlPlane, directory: str, **extra):
    options = {**KW, "api_key": plane.api_key, "base_url": "https://api.test", "state_dir": directory, "root": {"pinned": public_jwk_of(plane.root_key)}, "sync": SyncOptions(mode="resident", poll_seconds=3600, root_url="https://edge.test/roots/prod/root.json"), "transport": plane.transport(), **extra}
    return AirPrompterAgent.start(**options)


def no_network(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("no network here", request=request)


def store_for(directory: str) -> SlotStore:
    return SlotStore.open(state_dir=directory, agent_id=SCOPE["agentId"], target=SCOPE["target"], key_provider=file_key(os.path.join(SlotStore.path(state_dir=directory, agent_id=SCOPE["agentId"], target=SCOPE["target"]), "store.key")))


def golden_slot(plane: FakeControlPlane) -> dict:
    """A slot with a golden set whose one case fails on any answer but ``ok``."""
    golden_set = {"format": "airprompter-golden-set", "version": 1, "setId": "set_1", "minPassBps": 10000, "cases": [{"caseId": "a", "variables": {}, "expect": [{"kind": "must_match", "name": "ok", "pattern": "ok"}]}]}
    data = canonical_bytes(golden_set)
    content_hash = sha256_prefixed(data)
    plane.payloads[content_hash] = data
    return {**plane.slot(tag="support.reply", text="Reply."), "goldenSet": {"setId": "set_1", "cases": 1, "contentHash": content_hash, "byteLength": len(data), "minPassBps": 10000}}


def payload_fetches(plane: FakeControlPlane) -> int:
    return len([url for url in plane.requests if "/payloads/" in url])


def test_a_puller_without_the_capability_carries_a_slot_it_cannot_serve_and_a_runtime_with_it_applies_the_bundle(state_dir):
    plane = FakeControlPlane(SCOPE)
    base, future = release(plane)
    manifest = plane.promote([base, future])
    assert len(referenced_payloads(manifest["payload"])) == 1, "this SDK serves one of them"
    assert len(carried_payloads(manifest["payload"])) == 2, "and carries both"
    key = generate_x25519_key_pair()
    pulled = pull_of(plane, key.public_raw)
    assert pulled.status == "ok", pulled
    distribution_key = DistributionKey(key.private_key, key.public_raw)
    contents = open_bundle(pulled.bundle, SCOPE, distribution_key)
    assert sorted(payload["contentHash"] for payload in contents["payloads"]) == sorted([base["contentHash"], future["contentHash"]])
    with gaining():
        ap = AirPrompterAgent.start(**KW, state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, transport=httpx.MockTransport(no_network), distribution_key=distribution_key, vendored_bundle=VendoredBundle(pulled.bundle))
        try:
            assert ap.prompt("support.future").render().text == "From the future."
            assert ap.prompt("support.reply").render().text == "Reply politely."
        finally:
            ap.stop()


def test_the_walk_reaches_a_pin_no_reader_of_this_release_knows_and_a_top_level_capability_does_not_stop_a_puller():
    plane = FakeControlPlane(SCOPE)
    base, future = release(plane)
    pin = plane.slot(tag="support.variant", text="A variant nobody here can read.")
    open_slot = {**future, "variants": [{"name": "b", "pin": {"contentHash": pin["contentHash"], "byteLength": pin["byteLength"]}}]}
    manifest = plane.promote([base, open_slot], required_capabilities=[FUTURE])
    assert sorted(carried_payloads(manifest["payload"])) == sorted([base["contentHash"], future["contentHash"], pin["contentHash"]])
    key = generate_x25519_key_pair()
    pulled = pull_of(plane, key.public_raw)
    assert pulled.status == "ok", pulled
    assert len(open_bundle(pulled.bundle, SCOPE, DistributionKey(key.private_key, key.public_raw))["payloads"]) == 3
    verdict = verify_manifest(manifest=manifest, root=plane.root, now=iso_ms(now_ms()), scope=SCOPE, stored_generation=0, payloads=None)
    assert verdict.ok is False, "the runtime still refuses it at apply"


def test_a_carrier_refuses_a_tampered_payload_and_a_missing_one_a_release_needs():
    plane = FakeControlPlane(SCOPE)
    base, future = release(plane)
    plane.promote([base, future])
    key = generate_x25519_key_pair()
    del plane.payloads[future["contentHash"]]
    absent = pull_of(plane, key.public_raw)
    assert absent.status == "ok", absent
    assert len(open_bundle(absent.bundle, SCOPE, DistributionKey(key.private_key, key.public_raw))["payloads"]) == 1, "a `requires` payload that was never served is absent"
    plane.payloads[future["contentHash"]] = bytes(future["byteLength"])
    tampered = pull_of(plane, key.public_raw)
    assert (tampered.status, tampered.reason) == ("refused", "payload_hash_mismatch"), "bytes this SDK cannot serve are still checked"
    del plane.payloads[future["contentHash"]]
    del plane.payloads[base["contentHash"]]
    missing = pull_of(plane, key.public_raw)
    assert (missing.status, missing.reason, missing.content_hash) == ("refused", "payload_missing", base["contentHash"])


def test_a_carrier_reads_a_manifest_of_any_shape_and_still_asks_for_countersignatures():
    plane = FakeControlPlane(SCOPE)
    base, future = release(plane)
    plane.promote([base, future])
    manifest = plane.promote([base, future], required_capabilities=[FUTURE], experiments=[{"tag": "support.reply", "arms": "not a list"}, {"tag": "support.future", "arms": ["not an arm"]}], directives=[{"kind": "a later kind"}])
    verdict = verify_manifest(manifest=manifest, root=plane.root, now=iso_ms(now_ms()), scope=SCOPE, stored_generation=0, payloads=dict(plane.payloads), carrying=True)
    assert verdict.ok is True, verdict
    asked = verify_manifest(manifest=manifest, root=plane.root, now=iso_ms(now_ms()), scope=SCOPE, stored_generation=0, payloads=None, carrying=True, require_countersign=True)
    assert (asked.ok, asked.reason) == (False, "countersign_missing")


def test_m9_is_strict_by_default_only_a_store_or_a_carrier_goes_without_a_payload_named_only_under_requires():
    plane = FakeControlPlane(SCOPE)
    base, future = release(plane)
    manifest = plane.promote([base, future])
    base_bytes = plane.payloads[base["contentHash"]]

    def verify(payloads, absent_requires):
        return verify_manifest(manifest=manifest, root=plane.root, now=iso_ms(now_ms()), scope=SCOPE, stored_generation=0, payloads=payloads, absent_requires=absent_requires)

    assert optional_payloads(manifest["payload"]) == {future["contentHash"]}
    assert optional_payloads({"slots": "nope"}) == set(), "a manifest of any shape: a puller may hold one it cannot read"
    with gaining():
        assert len(referenced_payloads(manifest["payload"])) == 2
        strict = verify({base["contentHash"]: base_bytes}, False)
        assert (strict.ok, strict.reason) == (False, "payload_missing"), "strict for every other caller"
        assert verify({base["contentHash"]: base_bytes}, True).ok is True
        refused = verify({future["contentHash"]: plane.payloads[future["contentHash"]]}, True)
        assert (refused.ok, refused.reason) == (False, "payload_missing")
        bundle = create_plaintext_bundle({"createdAt": iso_ms(now_ms()), "notAfter": "2027-01-01T00:00:00Z", "manifest": manifest, "keySet": plane.root, "payloads": [{"contentHash": base["contentHash"], "byteLength": len(base_bytes), "bytes": b64url_encode(base_bytes)}]})
        with pytest.raises(BundleReleaseRefused, match="payload_missing"):
            BundleRelease.load(bundle=bundle, root=plane.root, scope=SCOPE, now=iso_ms(now_ms()))


def test_slot_hashes_names_main_steps_and_golden_set():
    plane = FakeControlPlane(SCOPE)
    main = golden_slot(plane)
    step = plane.slot(tag="support.step", text="A step.")
    entry = {**main, "steps": [{"contentHash": step["contentHash"], "byteLength": step["byteLength"]}, "not a step"]}
    assert slot_hashes(entry) == {main["contentHash"]: main["byteLength"], step["contentHash"]: step["byteLength"], main["goldenSet"]["contentHash"]: main["goldenSet"]["byteLength"]}
    assert slot_hashes({"steps": "nope"}) == {}, "a slot of a shape this reader cannot read names nothing"


def test_a_requires_slot_naming_no_payload_at_all_is_absent(state_dir):
    plane = FakeControlPlane(SCOPE)
    base = plane.slot(tag="support.reply", text="Reply politely.")
    plane.promote([base, {"tag": "support.open", "kind": "prompt", "requires": [FUTURE]}])
    with gaining():
        ap = start(plane, state_dir)
        try:
            with pytest.raises(KeyError, match="no slot support.open"):
                ap.prompt("support.open").render()
        finally:
            ap.stop()


def test_a_requires_slot_sharing_a_hash_with_an_ordinary_slot_serves_no_empty_step(state_dir):
    plane = FakeControlPlane(SCOPE)
    base = plane.slot(tag="support.reply", text="Reply politely.")
    step_only = plane.slot(tag="support.step", text="A step this host never stored.")
    workflow = {**base, "tag": "support.flow", "kind": "workflow", "requires": [FUTURE], "steps": [{"stepId": "support.flow#1", "ordinal": 1, "promptArtifactId": "prm_s", "promptVersionId": "ver_s", "contentHash": step_only["contentHash"], "byteLength": step_only["byteLength"]}]}
    plane.promote([base, workflow])
    start(plane, state_dir).stop()
    del plane.payloads[step_only["contentHash"]]
    with gaining():
        ap = start(plane, state_dir, transport=httpx.MockTransport(no_network))
        try:
            assert ap.generation == 1
            with pytest.raises(KeyError, match="no slot support.flow"):  # the main hash is held; the step is not
                ap.workflow("support.flow")
            assert ap.prompt("support.reply").render().text == "Reply politely."
        finally:
            ap.stop()


def test_a_pull_refuses_a_missing_payload_unless_it_is_named_only_under_requires_and_reads_no_payload_for_a_forged_manifest():
    plane = FakeControlPlane(SCOPE)
    base = plane.slot(tag="support.reply", text="Reply politely.")
    pin = plane.slot(tag="support.pin", text="A pin outside any requires.")
    plane.promote([{**base, "variants": [{"pin": {"contentHash": pin["contentHash"], "byteLength": pin["byteLength"]}}]}])
    key = generate_x25519_key_pair()
    del plane.payloads[pin["contentHash"]]
    missing = pull_of(plane, key.public_raw)
    assert (missing.status, missing.reason) == ("refused", "payload_missing"), "not ok: nothing excuses it"
    plane.requests.clear()
    plane.promote([base], sign_with=new_key())
    forged = pull_of(plane, key.public_raw)
    assert forged.status == "refused", forged
    assert payload_fetches(plane) == 0, "the envelope comes before the walk"


def test_a_requires_slot_with_no_payload_resolves_as_no_slot_and_a_stranded_override_sits_out_before_assignment(state_dir):
    plane = FakeControlPlane(SCOPE)
    base, future = release(plane)
    override = {**plane.slot(tag="support.reply", text="The candidate."), "requires": [FUTURE]}
    digest = plane.promote([base, future])["payload"]["releaseDigest"]
    experiment = {"experimentId": "exp_a", "tag": "support.reply", "salt": "AAECAwQFBgcICQoLDA0ODw", "subjectKey": "request", "arms": [{"arm": "control", "weightBps": 0, "releaseDigest": digest, "overrides": []}, {"arm": "candidate", "weightBps": 10000, "releaseDigest": "sha256:" + "1" * 64, "overrides": [override]}]}
    plane.promote([base, future], experiments=[experiment])
    start(plane, state_dir).stop()  # stored by an SDK without the capability: neither payload is held
    with gaining():
        ap = start(plane, state_dir, transport=httpx.MockTransport(no_network))
        try:
            with pytest.raises(KeyError, match="no slot support.future"):
                ap.prompt("support.future").render()
            for number in range(40):
                rendered = ap.prompt("support.reply", subject=f"user-{number}").render()
                assert (rendered.text, rendered.arm) == ("Reply politely.", "none"), "no run takes a label, control included"
        finally:
            ap.stop()


def test_the_stranded_host_serves_generation_one_on_restart_then_picks_up_the_slot(state_dir):
    plane = FakeControlPlane(SCOPE)
    base, future = release(plane)
    plane.promote([base, future])
    before = start(plane, state_dir)
    assert before.generation == 1
    with pytest.raises(KeyError, match="no slot support.future"):
        before.prompt("support.future").render()
    before.stop()

    with gaining():
        events: list[dict] = []
        # The first boot has no network: it serves from the store, with no slot to show for what it never stored.
        offline = start(plane, state_dir, transport=httpx.MockTransport(no_network), logger=events.append)
        assert offline.generation == 1, "serving, not generation 0"
        assert offline.prompt("support.reply").render().text == "Reply politely."
        with pytest.raises(KeyError, match="no slot support.future"):
            offline.prompt("support.future").render()
        assert not any(event.get("event") == "slot_unusable" for event in events), events
        offline.stop()

        online = start(plane, state_dir)
        try:
            online.sync_now()
            assert online.generation == 1, "the same generation"
            assert online.prompt("support.future").render().text == "From the future."
            assert online.prompt("support.reply").render().text == "Reply politely."
            assert future["contentHash"] in online.release.payloads, "the store holds it now"
            requests = len(plane.requests)
            online.sync_now()
            assert online.status().last_sync_outcome in ("unchanged", "pointer_unchanged") and len(plane.requests) > requests, "and the next pass is a plain one"
        finally:
            online.stop()


def test_a_stranded_pass_skips_the_pointer_and_sends_no_etag_and_the_same_generation_is_news_once(state_dir):
    plane = FakeControlPlane(SCOPE)
    base, future = release(plane)
    plane.promote([base, future])
    start(plane, state_dir).stop()
    with gaining():
        store = store_for(state_dir)
        active = store.load(store.state["active"], now=iso_ms(now_ms()), root=plane.root, expect_generation=1)
        assert future["contentHash"] not in active.payloads

        class Client:
            pointer_asked = 0
            etag: object = "unset"

            def edge_pointer(self, *_):
                Client.pointer_asked += 1
                raise AssertionError("a stranded pass never asks the pointer")

            def manifest(self, *, if_none_match=None):
                Client.etag = if_none_match
                return real.manifest(if_none_match=if_none_match)

            def payload(self, content_hash):
                return real.payload(content_hash)

        real = SyncClient(base_url="https://api.test", agent_id=SCOPE["agentId"], target=SCOPE["target"], api_key=plane.api_key, transport=plane.transport())
        done = sync_once(store=store, client=Client(), now=lambda: iso_ms(now_ms()), scope=SCOPE, trusted_root=plane.root, active=active, etag="etag-held", edge_pointer_url="https://edge.test/g.json", apply_policy=lambda _m: "activated")
        assert (done.outcome, done.generation, Client.pointer_asked, Client.etag) == ("activated", 1, 0, None)
        assert future["contentHash"] in done.active.payloads
        again = sync_once(store=store, client=real, now=lambda: iso_ms(now_ms()), scope=SCOPE, trusted_root=plane.root, active=done.active, etag=None, apply_policy=lambda _m: "activated")
        assert again.outcome == "unchanged", "held now: the same generation is no news"


def test_a_stranded_host_with_an_unobtainable_payload_tries_once_then_returns_to_the_idle_path(state_dir):
    plane = FakeControlPlane(SCOPE)
    base, future = release(plane)
    plane.promote([base, future])
    start(plane, state_dir).stop()
    del plane.payloads[future["contentHash"]]
    with gaining():
        ap = start(plane, state_dir, sync=SyncOptions(mode="resident", poll_seconds=3600, edge_pointer_url="https://edge.test/g/token/generation.json"))
        try:
            ap.sync_now()
            assert ap.generation == 1
            ap.sync_now()
            plane.requests.clear()
            ap.sync_now()
            ap.sync_now()
            assert not any(httpx.URL(url).path.endswith("/manifest") for url in plane.requests), plane.requests
            assert ap.prompt("support.reply").render().text == "Reply politely."
        finally:
            ap.stop()


def test_a_bundle_host_picks_a_stranded_slot_up_at_its_next_generation_not_from_a_same_generation_bundle(state_dir):
    plane = FakeControlPlane(SCOPE)
    base, future = release(plane)
    plane.promote([base, future])
    key = generate_x25519_key_pair()
    distribution_key = DistributionKey(key.private_key, key.public_raw)
    whole = pull_of(plane, key.public_raw)
    assert whole.status == "ok", whole
    contents = open_bundle(whole.bundle, SCOPE, distribution_key)
    store = store_for(state_dir)
    store.accept_root(plane.root)
    store.stage(manifest=contents["manifest"], payloads={base["contentHash"]: plane.payloads[base["contentHash"]]})
    store.activate()
    plane.promote([base, future])
    following = pull_of(plane, key.public_raw)
    assert following.status == "ok", following
    with gaining():
        ap = AirPrompterAgent.start(**KW, state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, transport=httpx.MockTransport(no_network), distribution_key=distribution_key)
        try:
            assert ap.apply_bundle(whole.bundle)["outcome"] == "unchanged"
            with pytest.raises(KeyError, match="no slot support.future"):
                ap.prompt("support.future").render()
            ap.apply_bundle(following.bundle)
            assert ap.generation == 2
            assert ap.prompt("support.future").render().text == "From the future."
        finally:
            ap.stop()


def test_store_load_excuses_a_missing_payload_and_nothing_else(state_dir):
    plane = FakeControlPlane(SCOPE)
    base, future = release(plane)
    manifest = plane.promote([base, future])
    store = store_for(state_dir)
    store.accept_root(plane.root)
    store.stage(manifest=manifest, payloads=dict(plane.payloads))
    slot = store.activate()
    sealed = os.path.join(store.dir, "slots", slot, "payloads", f"{future['contentHash'].replace(':', '-')}.enc")
    aad = payload_aad(agent_id=SCOPE["agentId"], target=SCOPE["target"], generation=1, content_hash=future["contentHash"])
    with gaining():
        with open(sealed, "wb") as f:
            f.write(encrypt_payload(store._dek, b"sealed, and not those bytes", aad))
        with pytest.raises(StoreError) as tampered:
            store.load(slot, now=iso_ms(now_ms()), root=plane.root)
        assert tampered.value.code == "slot_corrupt", "tampered"
        with open(sealed, "wb") as f:
            f.write(b"not sealed")
        with pytest.raises(StoreError) as undecryptable:
            store.load(slot, now=iso_ms(now_ms()), root=plane.root)
        assert undecryptable.value.code == "slot_corrupt", "undecryptable"
        os.remove(sealed)
        assert sorted(store.load(slot, now=iso_ms(now_ms()), root=plane.root).payloads) == [base["contentHash"]], "missing is absent"


def test_store_stage_refuses_any_entry_referenced_or_not_that_is_not_named_for_its_bytes(state_dir):
    plane = FakeControlPlane(SCOPE)
    base, future = release(plane)
    manifest = plane.promote([base, future])
    store = store_for(state_dir)
    held = plane.payloads[base["contentHash"]]
    with pytest.raises(StoreError) as wrong:
        store.stage(manifest=manifest, payloads={base["contentHash"]: held, future["contentHash"]: b"wrong bytes"})
    assert wrong.value.code == "slot_corrupt", "wrong bytes for a slot this SDK skips"
    with pytest.raises(StoreError) as traversal:
        store.stage(manifest=manifest, payloads={base["contentHash"]: held, "../../../escape": b"x"})
    assert traversal.value.code == "slot_corrupt", "a path for a name"
    assert not [name for name in os.listdir(store.dir) if "escape" in name]
    assert not os.path.exists(os.path.join(store.dir, "slots", "A", "manifest.json")), "nothing was written"
    assert not store.state.get("staged")


def test_a_bundle_with_wrong_bytes_for_a_skipped_slot_is_refused_at_stage_and_gaining_the_capability_strands_nothing(state_dir):
    plane = FakeControlPlane(SCOPE)
    base, future = release(plane)
    key = generate_x25519_key_pair()
    distribution_key = DistributionKey(key.private_key, key.public_raw)
    plane.promote([base])
    first = pull_of(plane, key.public_raw)
    options = dict(**KW, state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, transport=httpx.MockTransport(no_network), distribution_key=distribution_key)
    ap = AirPrompterAgent.start(**options, vendored_bundle={"bundle": first.bundle})
    manifest = plane.promote([base, future])
    held = plane.payloads[base["contentHash"]]
    wrong = bytes(future["byteLength"])
    bundle = create_encrypted_bundle({"createdAt": iso_ms(now_ms()), "notAfter": "2030-01-01T00:00:00Z", "manifest": manifest, "keySet": plane.root, "payloads": [{"contentHash": base["contentHash"], "byteLength": len(held), "bytes": b64url_encode(held)}, {"contentHash": future["contentHash"], "byteLength": len(wrong), "bytes": b64url_encode(wrong)}]}, key.public_raw)
    assert ap.apply_bundle(bundle)["outcome"] == "refused"
    assert ap.generation == 1, "the active release stands"
    assert ap.prompt("support.reply").render().text == "Reply politely."
    ap.stop()
    with gaining():
        after = AirPrompterAgent.start(**options)
        assert after.generation == 1, "no slot holds the wrong bytes to come up on"
        after.stop()


def test_a_capability_refused_bundle_delivers_its_disables_and_a_later_refused_bundle_lifts_them(state_dir):
    plane = FakeControlPlane(SCOPE)
    a = plane.slot(tag="support.a", text="A")
    b = plane.slot(tag="support.b", text="B")
    key = generate_x25519_key_pair()
    plane.promote([a, b])
    first = pull_of(plane, key.public_raw)
    plane.promote([a, b], required_capabilities=[FUTURE], directives=[{"kind": "disable", "scope": "slot", "tag": "support.a", "issuedAt": "2026-09-12T11:00:00Z"}])
    disabling = pull_of(plane, key.public_raw)
    plane.promote([a, b], required_capabilities=[FUTURE], directives=[])
    lifting = pull_of(plane, key.public_raw)
    assert (first.status, disabling.status, lifting.status) == ("ok", "ok", "ok")
    ap = AirPrompterAgent.start(**KW, state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, transport=httpx.MockTransport(no_network), distribution_key=DistributionKey(key.private_key, key.public_raw), vendored_bundle={"bundle": first.bundle})
    try:
        assert ap.prompt("support.a").render().text == "A"
        assert ap.apply_bundle(disabling.bundle)["outcome"] == "refused"
        assert ap.generation == 1
        with pytest.raises(RenderRefusedError):  # the disable reached a bundle host
            ap.prompt("support.a").render()
        assert ap.apply_bundle(lifting.bundle)["outcome"] == "refused"
        assert ap.prompt("support.a").render().text == "A", "and a lift lands"
    finally:
        ap.stop()


def test_store_load_on_an_expired_root_still_comes_up_without_an_optional_payload(state_dir):
    plane = FakeControlPlane(SCOPE)
    base, future = release(plane)
    manifest = plane.promote([base, future])
    store = store_for(state_dir)
    store.accept_root(plane.root)
    store.stage(manifest=manifest, payloads={base["contentHash"]: plane.payloads[base["contentHash"]]})
    slot = store.activate()
    with gaining():
        assert sorted(store.load(slot, now="2199-01-01T00:00:00Z", root=plane.root).payloads) == [base["contentHash"]]


def test_store_load_keeps_a_hash_mismatch_on_an_ordinary_payload_corrupt(state_dir):
    plane = FakeControlPlane(SCOPE)
    base = plane.slot(tag="support.reply", text="Reply politely.")
    manifest = plane.promote([base])
    store = store_for(state_dir)
    store.accept_root(plane.root)
    store.stage(manifest=manifest, payloads={base["contentHash"]: plane.payloads[base["contentHash"]]})
    slot = store.activate()
    aad = payload_aad(agent_id=SCOPE["agentId"], target=SCOPE["target"], generation=1, content_hash=base["contentHash"])
    with open(os.path.join(store.dir, "slots", slot, "payloads", f"{base['contentHash'].replace(':', '-')}.enc"), "wb") as sealed:
        sealed.write(encrypt_payload(store._dek, b"sealed, and not those bytes", aad))
    with pytest.raises(StoreError) as corrupt:
        store.load(slot, now=iso_ms(now_ms()), root=plane.root)
    assert (corrupt.value.code, corrupt.value.detail) == ("slot_corrupt", "payload_hash_mismatch")


def test_a_refused_generation_delivers_its_disables_each_refused_manifest_replaces_the_last_and_a_lift_undoes_only_what_a_refused_generation_added(state_dir):
    plane = FakeControlPlane(SCOPE)
    a = plane.slot(tag="support.a", text="A")
    b = plane.slot(tag="support.b", text="B")
    plane.promote([a, b], directives=[{"kind": "disable", "scope": "slot", "tag": "support.a", "issuedAt": "2026-09-12T10:00:00Z"}])
    ap = start(plane, state_dir)
    try:
        with pytest.raises(RenderRefusedError):
            ap.prompt("support.a").render()
        # The new generation lifts A's disable and disables B. This SDK cannot read it, so only the second half stands.
        plane.promote([a, b], required_capabilities=[FUTURE], apply_policy="unlock_required", directives=[{"kind": "disable", "scope": "slot", "tag": "support.b", "issuedAt": "2026-09-12T11:00:00Z"}, {"kind": "request_unlock", "releaseDigest": "sha256:" + "0" * 64, "issuedAt": "2026-09-12T11:00:00Z"}])
        ap.sync_now()
        assert ap.generation == 1, "the release itself is refused"
        assert ap.status().last_refusal == "protocol_unsupported"
        with pytest.raises(RenderRefusedError):
            ap.prompt("support.b").render()
        with pytest.raises(RenderRefusedError):
            ap.prompt("support.a").render()
        assert sorted(ap.status().disabled["slots"]) == ["support.a", "support.b"]
        assert ap.status().apply_policy["effective"] == "auto", "nothing but the disables moved"
        assert ap.status().unlock_requests == [], "nothing but the disables moved"
        # The next refused generation lifts B: it replaces the last one and leaves the active release's own.
        plane.promote([a, b], required_capabilities=[FUTURE], directives=[])
        ap.sync_now()
        assert ap.prompt("support.b").render().text == "B", "a lift lifts"
        with pytest.raises(RenderRefusedError):  # the active release's own disable stands
            ap.prompt("support.a").render()
        assert ap.status().disabled["slots"] == ["support.a"]
        # A non-object beside a disable, on a generation refused for a capability.
        plane.promote([a, b], required_capabilities=[FUTURE], directives=[None, {"kind": "disable", "scope": "slot", "tag": "support.b", "issuedAt": "2026-09-12T12:00:00Z"}])
        ap.sync_now()
        assert ap.generation == 1
        with pytest.raises(RenderRefusedError):  # a disable beside a non-object stands
            ap.prompt("support.b").render()
        plane.promote([a, b], directives=[{"kind": "later_kind"}, {"kind": "disable", "scope": "slot", "tag": "support.a", "issuedAt": "2026-09-12T13:00:00Z"}])
        ap.sync_now()
        assert ap.status().last_refusal == "directive_unknown"
    finally:
        ap.stop()


def test_a_first_release_waiting_for_unlock_costs_one_fetch_one_on_staged_and_then_304s(state_dir):
    plane = FakeControlPlane(SCOPE)
    plane.promote([plane.slot(tag="support.reply", text="Reply.")], apply_policy="unlock_required")
    staged: list[int] = []
    ap = start(plane, state_dir, apply=ApplyOptions(on_staged=lambda entry: staged.append(entry.generation)))
    try:
        ap.sync_now()
        ap.sync_now()
        ap.sync_now()
        assert staged == [1], "one on_staged"
        assert payload_fetches(plane) == 1, "one payload fetch"
        assert ap.generation == 0, "the store's generation stays 0 while a first release is only staged"
    finally:
        ap.stop()


def test_a_failed_golden_set_on_a_first_release_runs_once_and_then_sees_304s_and_a_host_with_nothing_promoted_still_uses_the_pointer(state_dir, tmp_path):
    plane = FakeControlPlane(SCOPE)
    plane.promote([golden_slot(plane)])
    invoked: list[object] = []

    def invoke(invocation):
        invoked.append(invocation)
        return "wrong"

    ap = start(plane, state_dir, root=plane.root, golden=GoldenOptions(invoke=invoke, concurrency=1))
    try:
        after = len(invoked)
        assert after >= 1, "the set ran"
        ap.sync_now()
        ap.sync_now()
        assert len(invoked) == after, "one golden run"
        assert payload_fetches(plane) == 2, "the slot and its set, once each"
    finally:
        ap.stop()
    empty = FakeControlPlane(SCOPE)
    client = SyncClient(base_url="https://api.test", agent_id=SCOPE["agentId"], target=SCOPE["target"], api_key=empty.api_key, transport=empty.transport())
    sync_once(store=store_for(str(tmp_path)), client=client, now=lambda: iso_ms(now_ms()), scope=SCOPE, trusted_root=empty.root, active=None, etag=None, edge_pointer_url="https://edge.test/g/token/generation.json", apply_policy=lambda _m: "activated")
    assert any(url.endswith("/generation.json") for url in empty.requests), "nothing active, nothing stored: the pointer still answers"


def test_an_arm_that_loses_the_override_of_its_own_tag_sits_the_experiment_out_base_text_arm_none_bucket_null(state_dir):
    plane = FakeControlPlane(SCOPE)
    base = plane.slot(tag="support.reply", text="Base")
    candidate = plane.slot(tag="support.reply", text="Candidate", version_id="ver_candidate")
    experiment = {"tag": "support.reply", "experimentId": "exp_1", "salt": "AAECAwQFBgcICQoLDA0ODw", "subjectKey": "request", "arms": [{"arm": "control", "weightBps": 0, "releaseDigest": release_digest([base]), "overrides": []}, {"arm": "candidate", "weightBps": 10000, "releaseDigest": release_digest([candidate]), "overrides": [{**candidate, "requires": [FUTURE]}]}]}
    plane.promote([base], experiments=[experiment], directives=[{"kind": "disable", "scope": "arm", "arm": "candidate", "experimentId": "exp_1", "issuedAt": "2026-09-12T10:00:00Z"}])
    ap = start(plane, state_dir, run_ref_secret="s")
    try:
        assert ap.generation == 1, "an arm disable naming the experiment still loads"
        rendered = ap.prompt("support.reply", subject="u1").render()
        facts = parse_run_ref(rendered.run_ref, [run_ref_key_from("s", SCOPE["agentId"], SCOPE["target"])])
        assert (rendered.text, rendered.arm, facts.entries[0]["arm"], facts.entries[0]["bucket"]) == ("Base", "none", "none", None)
    finally:
        ap.stop()


def _frozen_release(plane: FakeControlPlane, directives: list, **extra) -> None:
    base = plane.slot(tag="support.reply", text="Base")
    candidate = plane.slot(tag="support.reply", text="Candidate", version_id="ver_candidate")
    experiment = {"tag": "support.reply", "experimentId": "exp_1", "salt": "AAECAwQFBgcICQoLDA0ODw", "subjectKey": "request", "arms": [{"arm": "control", "weightBps": 5000, "releaseDigest": release_digest([base]), "overrides": []}, {"arm": "candidate", "weightBps": 5000, "releaseDigest": release_digest([candidate]), "overrides": [{**candidate, "requires": [FUTURE]}]}], **extra.pop("experiment", {})}
    plane.promote([base], experiments=[experiment], directives=directives, **extra)


def _arm_off(arm: str) -> dict:
    return {"kind": "disable", "scope": "arm", "arm": arm, "experimentId": "exp_1", "issuedAt": "2026-09-12T10:00:00Z"}


def test_a_frozen_experiment_stops_a_host_that_sits_it_out_with_or_without_the_capability(state_dir, tmp_path):
    plane = FakeControlPlane(SCOPE)
    _frozen_release(plane, [_arm_off("control"), _arm_off("candidate")])
    ap = start(plane, state_dir)
    with pytest.raises(RenderRefusedError):
        ap.prompt("support.reply", subject="u1").render()
    ap.stop()
    with gaining():
        capable = start(plane, str(tmp_path / "capable"))
        with pytest.raises(RenderRefusedError):
            capable.prompt("support.reply", subject="u1").render()
        capable.stop()
    partly = FakeControlPlane(SCOPE)
    _frozen_release(partly, [_arm_off("candidate")])
    one = start(partly, str(tmp_path / "partly"))
    assert one.prompt("support.reply", subject="u1").render().text == "Base", "one arm off is no freeze"
    one.stop()


def test_a_frozen_experiment_with_an_audience_stops_only_the_runs_in_that_audience(state_dir):
    plane = FakeControlPlane(SCOPE)
    audience_id = "aud_AAAAAAAAAAAAAAAAAAAAAA"
    selector = {"mode": "when", "when": {"key": "region", "is": "west"}}
    _frozen_release(plane, [_arm_off("control"), _arm_off("candidate")], experiment={"audience": {"audienceId": audience_id, "selector": selector}}, observations=[{"audienceId": audience_id, "selector": selector, "tag": "support.reply", "observeFrom": "2026-01-01T00:00:00Z"}])
    ap = start(plane, state_dir)
    try:
        ap.set_tags({"region": "east"})
        assert ap.prompt("support.reply").render().text == "Base", "outside the audience"
        with pytest.raises(RenderRefusedError):
            ap.prompt("support.reply", tags={"region": "west"}).render()
    finally:
        ap.stop()


def test_an_unknown_subject_key_sits_the_experiment_out_and_never_hashes_by_run(state_dir):
    plane = FakeControlPlane(SCOPE)
    base = plane.slot(tag="support.reply", text="Base")
    candidate = plane.slot(tag="support.reply", text="Candidate", version_id="ver_candidate")
    plane.promote([base], experiments=[{"tag": "support.reply", "experimentId": "exp_1", "salt": "AAECAwQFBgcICQoLDA0ODw", "subjectKey": "later_key", "arms": [{"arm": "control", "weightBps": 0, "releaseDigest": release_digest([base]), "overrides": []}, {"arm": "candidate", "weightBps": 10000, "releaseDigest": release_digest([candidate]), "overrides": [candidate]}]}])
    ap = start(plane, state_dir)
    try:
        rendered = ap.prompt("support.reply", subject="u1").render()
        assert (rendered.text, rendered.arm) == ("Base", "none")
    finally:
        ap.stop()


def test_an_outage_does_not_use_a_stranded_hosts_one_try_only_an_answered_miss_does(state_dir):
    plane = FakeControlPlane(SCOPE)
    base, future = release(plane)
    plane.promote([base, future])
    start(plane, state_dir).stop()
    down = {"on": True}
    real = plane.transport().handler

    def flaky(request: httpx.Request) -> httpx.Response:
        if down["on"] and future["contentHash"] in str(request.url):
            raise httpx.ConnectError("reset", request=request)
        return real(request)

    with gaining():
        ap = start(plane, state_dir, transport=httpx.MockTransport(flaky))
        try:
            ap.sync_now()
            ap.sync_now()
            with pytest.raises(KeyError):
                ap.prompt("support.future").render()
            down["on"] = False
            ap.sync_now()
            assert ap.prompt("support.future").render().text == "From the future."
        finally:
            ap.stop()


def test_a_telemetry_failure_never_replaces_a_callers_own_error(state_dir):
    plane = FakeControlPlane(SCOPE)
    plane.promote([plane.slot(tag="support.reply", text="Reply to {{name}}", variables=[{"name": "name", "required": True, "trust": "operator"}])])
    events: list[dict] = []
    ap = start(plane, state_dir, logger=events.append)

    def broken(*_args, **_kwargs):
        raise RuntimeError("disk full")

    ap.spool.observe = broken
    try:
        with pytest.raises(Exception) as caught:
            ap.prompt("support.reply").render()
        assert type(caught.value).__name__ == "MissingVariableError", "the caller's error stays the caller's"
        assert [event["event"] for event in events if event.get("event") == "observation_dropped"] == ["observation_dropped"]
    finally:
        del ap.spool.observe
        ap.stop()


def test_an_unmet_override_of_another_tag_goes_alone_and_the_experiment_stays(state_dir):
    plane = FakeControlPlane(SCOPE)
    base = plane.slot(tag="support.reply", text="Base")
    candidate = plane.slot(tag="support.reply", text="Candidate", version_id="ver_candidate")
    other = {**plane.slot(tag="support.other", text="Other"), "requires": [FUTURE]}
    experiment = {"tag": "support.reply", "experimentId": "exp_1", "salt": "AAECAwQFBgcICQoLDA0ODw", "subjectKey": "request", "arms": [{"arm": "control", "weightBps": 0, "releaseDigest": release_digest([base]), "overrides": []}, {"arm": "candidate", "weightBps": 10000, "releaseDigest": release_digest([candidate]), "overrides": [candidate, other]}]}
    plane.promote([base], experiments=[experiment])
    ap = start(plane, state_dir)
    try:
        rendered = ap.prompt("support.reply", subject="u1").render()
        assert (rendered.text, rendered.arm) == ("Candidate", "candidate")
    finally:
        ap.stop()


def test_an_audience_this_reader_cannot_read_the_manifest_loads_the_run_takes_arm_none_no_cohort_is_captured_a_disable_stands(state_dir):
    plane = FakeControlPlane(SCOPE)
    base = plane.slot(tag="support.reply", text="Base")
    other = plane.slot(tag="support.other", text="Other")
    candidate = plane.slot(tag="support.reply", text="Candidate", version_id="ver_candidate")
    audience_id = "aud_AAAAAAAAAAAAAAAAAAAAAA"
    selector = {"mode": "when", "when": {"not": {"key": "region", "later": "west"}}}
    plane.promote(
        [base, other],
        experiments=[{"tag": "support.reply", "experimentId": "exp_1", "salt": "AAECAwQFBgcICQoLDA0ODw", "subjectKey": "request", "audience": {"audienceId": audience_id, "selector": selector}, "arms": [{"arm": "control", "weightBps": 0, "releaseDigest": release_digest([base, other]), "overrides": []}, {"arm": "candidate", "weightBps": 10000, "releaseDigest": release_digest([candidate, other]), "overrides": [candidate]}]}],
        observations=[{"audienceId": audience_id, "selector": selector, "tag": "support.reply", "observeFrom": "2026-01-01T00:00:00Z"}],
        directives=[{"kind": "disable", "scope": "slot", "tag": "support.other", "issuedAt": "2026-09-12T10:00:00Z"}],
    )
    ap = start(plane, state_dir, tags={"region": "east"})
    try:
        assert ap.generation == 1, "unknown is not malformed"
        rendered = ap.prompt("support.reply", subject="u1").render()
        assert (rendered.text, rendered.arm) == ("Base", "none")
        assert not rendered.audience_ids, "no cohort"
        with pytest.raises(RenderRefusedError):
            ap.prompt("support.other").render()
    finally:
        ap.stop()


def test_a_refused_manifest_older_than_what_stands_changes_nothing(state_dir):
    plane = FakeControlPlane(SCOPE)
    a = plane.slot(tag="support.a", text="A")
    plane.promote([a])
    ap = start(plane, state_dir)
    try:
        ap._take_verified({"generation": 5, "directives": [{"kind": "disable", "scope": "slot", "tag": "support.a", "issuedAt": "2026-09-12T10:00:00Z"}]})
        before = ap.status().disabled
        ap._take_verified({"generation": 4, "directives": [{"kind": "disable", "scope": "agent", "issuedAt": "2026-09-12T10:00:00Z"}]}, reduce_only=True)
        assert ap.status().disabled == before
        ap._take_verified({"generation": 5, "directives": "not a list"}, reduce_only=True)
        assert ap.status().disabled == {"agent": False, "slots": [], "arms": []}, "directives of no shape disable nothing, and replace the last"
    finally:
        ap.stop()


def test_a_store_holding_a_major_2_manifest_at_generation_1_upgrades_to_the_3_manifest_of_the_same_generation(state_dir):
    plane = FakeControlPlane(SCOPE)
    slot = plane.slot(tag="support.reply", text="Reply politely.")
    manifest = plane.promote([slot])
    store = SlotStore.open(state_dir=state_dir, agent_id=SCOPE["agentId"], target=SCOPE["target"], key_provider=file_key(os.path.join(SlotStore.path(state_dir=state_dir, agent_id=SCOPE["agentId"], target=SCOPE["target"]), "store.key")))
    older = {**manifest, "payload": {**manifest["payload"], "protocol": "2.9.0"}}
    store.stage(manifest=older, payloads=dict(plane.payloads))
    store.activate()
    assert store.state["generation"] == 1
    ap = start(plane, state_dir)
    try:
        assert ap.generation == 1
        assert ap.prompt("support.reply").render().text == "Reply politely."
        assert ap.status().apply_state == "active"
    finally:
        ap.stop()


def test_arms_of_a_shape_this_reader_cannot_read_do_not_raise_in_the_conflict_check():
    assert experiment_conflict({"slots": [{"tag": "a"}], "directives": [], "experiments": [{"tag": "a", "experimentId": "exp_1", "arms": 5}]}) is None


@pytest.mark.parametrize("agent_id", ["../../escape", "a/b", "", ".hidden", "a" * 129, "agent\n", None])
def test_an_agent_id_outside_the_grammar_never_reaches_the_filesystem_in_either_start(state_dir, agent_id):
    plane = FakeControlPlane(SCOPE)
    with pytest.raises(AgentStartError) as refused:
        AirPrompterAgent.start(organization_id="org_1", agent_id=agent_id, target="prod", state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, transport=httpx.MockTransport(no_network))
    assert refused.value.code == "invalid_options"
    with pytest.raises(ManagedRunError) as managed:
        ManagedAgent.start(agent_id=agent_id, target="prod", api_key="apr_run_key", base_url="https://run.example", transport=httpx.MockTransport(no_network))
    assert managed.value.code == "invalid_options"
    assert os.listdir(state_dir) == [], "nothing was written"


@pytest.mark.parametrize("target", ["../../escape", "Prod", "", "a" * 33, "with/slash", "prod\n", "ｑａ", None])
def test_a_target_that_is_not_a_slug_never_reaches_the_filesystem_in_either_start(state_dir, target):
    plane = FakeControlPlane(SCOPE)
    with pytest.raises(AgentStartError) as refused:
        AirPrompterAgent.start(organization_id="org_1", agent_id="agt_1", target=target, state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, transport=httpx.MockTransport(no_network))
    assert refused.value.code == "invalid_options"
    with pytest.raises(ManagedRunError) as managed:
        ManagedAgent.start(agent_id="agent-1", target=target, api_key="apr_run_key", base_url="https://run.example", transport=httpx.MockTransport(no_network))
    assert managed.value.code == "invalid_options"
    assert os.listdir(state_dir) == [], "nothing was written"


def test_telemetry_never_replaces_a_model_result_and_a_providers_error_stays_the_providers(state_dir):
    import asyncio

    events: list[dict] = []
    target = ObserveTarget("a.b", "v1", "none", "m", "prm_1")

    def broken(_observation):
        raise RuntimeError("disk full")

    assert observe_call(target, lambda: "the answer", broken, log=events.append) == "the answer"
    assert [event["event"] for event in events] == ["observation_dropped"], "logged once"
    assert observe_call(target, lambda: "no log", broken) == "no log"

    async def answer():
        return "the async answer"

    assert asyncio.run(observe_call_async(target, answer, broken, log=events.append)) == "the async answer"
    assert len(events) == 2

    class ProviderError(Exception):
        pass

    provider = ProviderError("rate limited")

    def failing():
        raise provider

    async def failing_async():
        raise provider

    with pytest.raises(ProviderError) as raised:
        observe_call(target, failing, broken)
    assert raised.value is provider
    with pytest.raises(ProviderError) as raised:
        asyncio.run(observe_call_async(target, failing_async, broken))
    assert raised.value is provider
    with pytest.raises(TypeError):
        ObserveTarget("a.b", "v1", "none", "m")  # type: ignore[call-arg]

    plane = FakeControlPlane(SCOPE)
    plane.promote([plane.slot(tag="support.reply", text="Hi")])
    logged: list[dict] = []
    ap = start(plane, state_dir, logger=logged.append)
    try:
        ap.report(tag="support.reply", artifact_id="prm 1 not valid", version_id="v", arm="none", model="m", status="ok", latency_ms=1)
        ap.report(tag="support.reply", version_id="v", arm="none", model="m", status="ok", latency_ms=1)
        assert len([event for event in logged if event["event"] == "observation_dropped"]) == 2, [event["event"] for event in logged]
        assert ap.feedback(None, thumbs="up") is False, "no token, no feedback"
        bad = ObserveTarget("support.reply", "v", "none", "m", "prm 1 not valid")
        assert ap.observe(bad, lambda: "still the answer") == "still the answer"
        assert len([event for event in logged if event["event"] == "observation_dropped"]) == 3
    finally:
        ap.stop()
