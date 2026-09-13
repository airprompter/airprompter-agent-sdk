"""S8 (AIR-1976): store.json joins the protocol with an N/N-1 rule. Parity with ``sdk-typescript/test/storeFormat.test.ts``."""
from __future__ import annotations

import json
import os
import shutil
import tempfile

import pytest

from airprompter_agent import AirPrompterAgent
from airprompter_agent._util import b64url_encode
from airprompter_agent.agent import SDK_VERSION, AgentStartError
from airprompter_agent.protocol.trust import public_jwk_of
from airprompter_agent.store.key_provider import file_key
from airprompter_agent.store.slot_store import STORE_FORMAT_VERSION, STORE_FORMATS_READ, SlotStore, StoreError, StoreHooks

from .control_plane import FakeControlPlane

SCOPE = {"organizationId": "org_1", "agentId": "agt_store", "target": "prod"}
KW = {"agent_id": "agt_store", "target": "prod"}
EXAMPLES = os.path.join(os.path.dirname(__file__), "..", "..", "protocol", "examples")


def example(name: str) -> dict:
    with open(os.path.join(EXAMPLES, name), encoding="utf-8") as f:
        return json.load(f)


def write_store(state_dir: str, shape: dict):
    directory = SlotStore.path(state_dir=state_dir, **KW)
    os.makedirs(os.path.join(directory, "slots", "A", "payloads"), exist_ok=True)
    provider = file_key(os.path.join(directory, "store.key"))
    wrapped = provider.wrap(b"\x07" * 32)
    with open(os.path.join(directory, "store.json"), "w", encoding="utf-8") as f:
        json.dump({**shape, "agentId": KW["agent_id"], "target": KW["target"], "wrappedDek": b64url_encode(wrapped), "storageProtection": provider.storage_protection, "root": None}, f, indent=2)
    return directory, provider


def on_disk(directory: str) -> dict:
    with open(os.path.join(directory, "store.json"), encoding="utf-8") as f:
        return json.load(f)


@pytest.fixture
def state_dir():
    path = tempfile.mkdtemp(prefix="ap-storefmt-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


def test_n_minus_one_is_read_and_migrates_forward_on_first_write(state_dir):
    v1 = example("store.v1.json")
    directory, provider = write_store(state_dir, {**v1, "active": None, "staged": None, "generation": 0})
    store = SlotStore.open(state_dir=state_dir, **KW, key_provider=provider)
    assert store.state["version"] == 1 and "writer" not in store.state and "applyPolicyPin" not in store.state
    assert on_disk(directory)["version"] == 1, "opening never rewrites: the rollback window"
    store.pin_apply_policy(value="unlock_required", source="manifest", generation=1, set_at="2026-09-13T12:00:00Z")
    written = on_disk(directory)
    assert written["version"] == STORE_FORMAT_VERSION
    assert written["writer"] == {"name": "agent-sdk-python", "version": "0.1.0"}
    assert written["applyPolicyPin"]["value"] == "unlock_required"
    assert written["instanceId"] == v1["instanceId"], "everything the N-1 file said is kept"
    daemon = SlotStore.open(state_dir=state_dir, **KW, key_provider=provider, hooks=StoreHooks(writer={"name": "airprompterd", "version": "0.1.0"}))
    daemon.pin_apply_policy(value="auto", source="operator", generation=1, set_at="2026-09-13T12:01:00Z")
    assert on_disk(directory)["writer"] == {"name": "airprompterd", "version": "0.1.0"}


def test_n_is_read_as_written_and_a_fresh_store_is_format_two(state_dir):
    v2 = example("store.v2.json")
    _, provider = write_store(state_dir, {**v2, "active": None, "staged": None, "generation": 0})
    store = SlotStore.open(state_dir=state_dir, **KW, key_provider=provider)
    assert store.state["version"] == 2 and store.state["writer"] == {"name": "airprompterd", "version": "0.1.0"}
    assert store.state["applyPolicyPin"] == {"value": "unlock_required", "source": "manifest", "generation": 41, "setAt": "2026-09-12T10:03:00Z"}
    fresh = tempfile.mkdtemp(prefix="ap-storefmt-fresh-")
    try:
        created = SlotStore.open(state_dir=fresh, **KW, key_provider=file_key(os.path.join(SlotStore.path(state_dir=fresh, **KW), "store.key")))
        assert created.state["version"] == STORE_FORMAT_VERSION and created.state["writer"] == {"name": "agent-sdk-python", "version": "0.1.0"}
        assert sorted(STORE_FORMATS_READ) == [1, 2]
    finally:
        shutil.rmtree(fresh, ignore_errors=True)


def test_n_plus_one_is_refused_naming_the_writer(state_dir):
    v2 = example("store.v2.json")
    directory, provider = write_store(state_dir, {**v2, "version": 3, "writer": {"name": "airprompterd", "version": "0.9.0"}, "active": None, "staged": None, "generation": 0, "someFutureField": {"a": 1}})
    with pytest.raises(StoreError) as refused:
        SlotStore.open(state_dir=state_dir, **KW, key_provider=provider)
    assert refused.value.code == "store_newer" and refused.value.detail == "airprompterd 0.9.0"
    assert "format 3, written by airprompterd 0.9.0; this runtime reads formats 1 and 2" in str(refused.value)
    assert on_disk(directory)["version"] == 3, "untouched"
    plane = FakeControlPlane(SCOPE)
    plane.promote([plane.slot(tag="support.reply", text="Reply.")])
    with pytest.raises(AgentStartError) as start:
        AirPrompterAgent.start(organization_id="org_1", **KW, api_key=plane.api_key, base_url="https://api.test", state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, transport=plane.transport())
    assert start.value.code == "store_newer" and "airprompterd 0.9.0" in str(start.value)
    write_store(state_dir, {**v2, "version": 3, "active": None, "staged": None, "generation": 0, "writer": None})
    with pytest.raises(StoreError) as unknown:
        SlotStore.open(state_dir=state_dir, **KW, key_provider=provider)
    assert unknown.value.code == "store_newer" and unknown.value.detail == "an unknown writer"
    assert SDK_VERSION == "0.1.0"
