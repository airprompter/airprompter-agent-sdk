"""The slot store: stage → activate → load round trip; a crash between fsync
and rename leaves the previous slot intact; swapping A and B on disk is
refused by the AAD; anti-rollback; the file-key fallback is reported; KEK
rotation re-wraps the DEK without touching a payload; and the layout is
the one the TypeScript SDK writes.
"""

from __future__ import annotations

import json
import os

import pytest

from airprompter_agent_core._util import iso_ms, now_ms
from airprompter_agent_sync.store.key_provider import custom_key_provider, file_key, unwrap_with_raw_key, wrap_with_raw_key
from airprompter_agent_sync.store.slot_store import SlotStore, StoreError, StoreHooks

from .control_plane import FakeControlPlane

SCOPE = {"organizationId": "org_1", "agentId": "agt_1", "target": "prod"}


def now() -> str:
    return iso_ms(now_ms())


def open_store(state_dir: str, hooks=None) -> SlotStore:
    return SlotStore.open(state_dir=state_dir, agent_id="agt_1", target="prod", key_provider=file_key(os.path.join(state_dir, "store.key")), hooks=hooks)


def test_stage_activate_load_roundtrip_and_layout(tmp_path):
    state_dir = str(tmp_path)
    plane = FakeControlPlane(SCOPE)
    manifest = plane.promote([plane.slot(tag="a", text="Hello {{name}}", variables=[{"name": "name", "required": True, "trust": "operator"}]), plane.slot(tag="b", text="Second")])
    store = open_store(state_dir)
    assert store.storage_protection == "file_key"
    store.accept_root(plane.root)
    assert store.stage(manifest=manifest, payloads=plane.payloads) == "A"
    assert store.state["staged"] == "A" and store.state["active"] is None
    assert store.activate() == "A"
    assert store.state["generation"] == 1
    loaded = store.load("A", now=now())
    assert loaded.payloads[manifest["payload"]["slots"][0]["contentHash"]] == b"Hello {{name}}"
    assert loaded.signing_key_id == manifest["signatures"][0]["keyId"]
    # On disk: the TypeScript layout, and no plaintext anywhere.
    assert store.dir == os.path.join(state_dir, "airprompter", "agt_1", "prod")
    files = store.list_slot_files("A")
    assert "manifest.json" in files and any(f.startswith("payloads/sha256-") and f.endswith(".enc") for f in files)
    for name in files:
        if name.endswith(".enc"):
            assert b"Hello" not in open(os.path.join(store.dir, "slots", "A", name), "rb").read()
    store_json = open(os.path.join(store.dir, "store.json"), encoding="utf-8").read()
    assert "Hello" not in store_json
    assert set(json.loads(store_json)) >= {"version", "agentId", "target", "instanceId", "wrappedDek", "storageProtection", "active", "staged", "generation", "root", "updatedAt"}
    reopened = open_store(state_dir)
    assert reopened.state["active"] == "A"
    assert len(reopened.load("A", now=now()).payloads) == 2


def test_second_release_and_anti_rollback(tmp_path):
    state_dir = str(tmp_path)
    plane = FakeControlPlane(SCOPE)
    first = plane.promote([plane.slot(tag="a", text="one")])
    store = open_store(state_dir)
    store.accept_root(plane.root)
    store.stage(manifest=first, payloads=plane.payloads)
    store.activate()
    # One release only: there is nothing to go back to, and the store says so by name.
    with pytest.raises(StoreError) as none:
        store.rollback_local()
    assert none.value.code == "no_previous_release"
    second = plane.promote([plane.slot(tag="a", text="two")])
    assert store.stage(manifest=second, payloads=plane.payloads) == "B"
    # Staged, not yet active: a rollback would be a silent unlock, so it is refused; the staged slot is untouched.
    with pytest.raises(StoreError) as staged:
        store.rollback_local()
    assert staged.value.code == "release_staged"
    assert (store.state["active"], store.state["staged"], store.state["generation"]) == ("A", "B", 1)
    assert store.activate() == "B"
    assert store.state["generation"] == 2
    with pytest.raises(StoreError) as refused:
        store.stage(manifest=first, payloads=plane.payloads)
    assert refused.value.code == "generation_rollback"
    assert store.rollback_local() == "A"
    assert store.state["generation"] == 1 and store.state["forcedDowngrade"] is True and store.state["heldBackBelow"] == 2
    assert store.rollback_local() == "B"
    assert store.stage(manifest=first, payloads=plane.payloads, force=True) == "A"
    assert store.activate() == "A"
    assert store.state["generation"] == 1 and store.state["forcedDowngrade"] is True


def test_crash_between_fsync_and_rename(tmp_path):
    state_dir = str(tmp_path)
    plane = FakeControlPlane(SCOPE)
    first = plane.promote([plane.slot(tag="a", text="one")])
    crash = {"on": False}

    def before_rename(_path: str) -> None:
        if crash["on"]:
            raise RuntimeError("power loss")

    store = open_store(state_dir, StoreHooks(before_rename=before_rename))
    store.accept_root(plane.root)
    store.stage(manifest=first, payloads=plane.payloads)
    store.activate()
    second = plane.promote([plane.slot(tag="a", text="two")])
    crash["on"] = True
    with pytest.raises(RuntimeError, match="power loss"):
        store.stage(manifest=second, payloads=plane.payloads)
    crash["on"] = False
    reopened = open_store(state_dir)
    assert reopened.state["active"] == "A"
    assert reopened.state["staged"] is None, "the flip never landed"
    assert reopened.state["generation"] == 1
    assert next(iter(reopened.load("A", now=now()).payloads.values())) == b"one"
    assert os.path.exists(os.path.join(reopened.dir, "slots", "B", "manifest.json")), "B's files are complete on disk"
    assert ".tmp" not in open(os.path.join(reopened.dir, "store.json"), encoding="utf-8").read()
    assert reopened.stage(manifest=second, payloads=plane.payloads) == "B"
    assert reopened.activate() == "B"


def test_swapping_slot_directories_is_refused(tmp_path):
    state_dir = str(tmp_path)
    plane = FakeControlPlane(SCOPE)
    first = plane.promote([plane.slot(tag="a", text="one")])
    store = open_store(state_dir)
    store.accept_root(plane.root)
    store.stage(manifest=first, payloads=plane.payloads)
    store.activate()
    second = plane.promote([plane.slot(tag="a", text="two")])
    store.stage(manifest=second, payloads=plane.payloads)
    store.activate()
    slots = os.path.join(store.dir, "slots")
    os.rename(os.path.join(slots, "A"), os.path.join(slots, "X"))
    os.rename(os.path.join(slots, "B"), os.path.join(slots, "A"))
    os.rename(os.path.join(slots, "X"), os.path.join(slots, "B"))
    reopened = open_store(state_dir)
    assert reopened.state["active"] == "B"
    with pytest.raises(StoreError) as swapped:
        reopened.load("B", now=now(), expect_generation=reopened.state["generation"])
    assert swapped.value.detail == "generation_rollback"
    assert reopened.load("A", now=now()).generation == 2
    hash_a = first["payload"]["slots"][0]["contentHash"].replace(":", "-")
    hash_b = second["payload"]["slots"][0]["contentHash"].replace(":", "-")
    os.rename(os.path.join(slots, "A", "payloads", f"{hash_b}.enc"), os.path.join(slots, "A", "payloads", f"{hash_a}.enc.moved"))
    os.rename(os.path.join(slots, "B", "payloads", f"{hash_a}.enc"), os.path.join(slots, "A", "payloads", f"{hash_b}.enc"))
    with pytest.raises(StoreError) as moved:
        reopened.load("A", now=now())
    assert moved.value.code == "slot_corrupt" and moved.value.detail == "payload_hash_mismatch"


def test_kek_rotation_rewraps_without_touching_payloads(tmp_path):
    state_dir = str(tmp_path)
    plane = FakeControlPlane(SCOPE)
    manifest = plane.promote([plane.slot(tag="a", text="one")])
    store = open_store(state_dir)
    store.accept_root(plane.root)
    store.stage(manifest=manifest, payloads=plane.payloads)
    store.activate()
    payload_path = os.path.join(store.dir, "slots", "A", "payloads", f"{manifest['payload']['slots'][0]['contentHash'].replace(':', '-')}.enc")
    before = open(payload_path, "rb").read()
    kek = bytes([7] * 32)
    kms = custom_key_provider(storage_protection="kms", wrap=lambda dek: wrap_with_raw_key(kek, dek), unwrap=lambda wrapped: unwrap_with_raw_key(kek, wrapped))
    store.rotate_key(kms)
    assert open(payload_path, "rb").read() == before, "no payload was rewritten"
    reopened = SlotStore.open(state_dir=state_dir, agent_id="agt_1", target="prod", key_provider=kms)
    assert reopened.storage_protection == "kms"
    assert next(iter(reopened.load("A", now=now()).payloads.values())) == b"one"
    with pytest.raises(StoreError) as locked:
        open_store(state_dir)
    assert locked.value.code == "kek_unavailable"
