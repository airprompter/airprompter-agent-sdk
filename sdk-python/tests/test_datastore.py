"""T40: the customer's datastore as the fleet's copy. Parity with ``sdk-typescript/test/datastore.test.ts``: the puller
writes each sealed release through a DAO (``pull_to_datastore``) — the row and its edge state together, a content-free
rollout summary beside it; every runtime hydrates from the datastore at start and on ``hydrate()``: the dial-up
percentages and ramp walk as signed, a rollback set in the datastore moves the whole fleet down (verified, forced,
held) and clearing it moves it back, and a region reads its own rows and rollback before the global ones."""

from __future__ import annotations

import shutil
import tempfile
from datetime import datetime, timedelta, timezone

import httpx

from airprompter_agent.agent import AirPrompterAgent
from airprompter_agent_core.bundle.apbundle import DistributionKey
from airprompter_agent_core.bundle.hpke import generate_x25519_key_pair
from airprompter_agent_core.control.client import SyncClient
from airprompter_agent_core.protocol.trust import public_jwk_of, trusted_root_from_pinned_key
from airprompter_agent_sync import MemoryReleaseDatastore, ReleaseKey, clear_datastore_rollback, pull_to_datastore, resolve_hydration, rollback_datastore

from .control_plane import FakeControlPlane

SCOPE = {"organizationId": "org_1", "agentId": "agt_1", "target": "prod"}
KW = {"organization_id": "org_1", "agent_id": "agt_1", "target": "prod"}
GLOBAL = ReleaseKey("org_1", "agt_1", "prod", None)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _no_network(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("runtimes never reach the control plane", request=request)


def puller(plane: FakeControlPlane, datastore, distribution_public_key: bytes, region=None):
    client = SyncClient(base_url="https://api.test", agent_id=SCOPE["agentId"], target=SCOPE["target"], api_key=plane.api_key, transport=plane.transport())
    trusted_root = trusted_root_from_pinned_key(purpose="platform", environment="prod", pinned_root=public_jwk_of(plane.root_key))
    edge = httpx.Client(transport=plane.transport())

    def pull():
        return pull_to_datastore(datastore=datastore, region=region, client=client, scope=SCOPE, trusted_root=trusted_root, fetch_root=lambda: edge.get("https://edge.test/roots/prod/root.json").json(), now=lambda: _iso(datetime.now(timezone.utc)), distribution_public_key=distribution_public_key)

    return pull


def _setup():
    plane = FakeControlPlane(SCOPE)
    fleet = generate_x25519_key_pair()
    return plane, fleet, DistributionKey(fleet.private_key, fleet.public_raw), MemoryReleaseDatastore()


def _boot(plane, key, datastore, state_dir, region=None):
    return AirPrompterAgent.start(**KW, state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, transport=httpx.MockTransport(_no_network), distribution_key=key, datastore={"store": datastore, "region": region})


def test_puller_writes_through_the_dao_and_a_runtime_hydrates_the_ramp_as_signed():
    plane, fleet, key, datastore = _setup()
    control = plane.slot(tag="support.reply", text="Reply politely.", version_id="ver_1")
    plane.promote([control])
    pull = puller(plane, datastore, fleet.public_raw)
    first = pull()
    assert first.status == "ok" and first.stored
    row1 = datastore.latest(GLOBAL)
    assert row1.generation == 1 and "Reply politely" not in row1.bundle, "the row is ciphertext"
    assert datastore.edge(GLOBAL) is not None, "the edge state rides with the row"

    candidate = plane.slot(tag="support.reply", text="Reply warmly.", version_id="ver_2")
    now = datetime.now(timezone.utc)
    ramp = [{"notBefore": _iso(now - timedelta(hours=2)), "weightBps": [7500, 2500]}, {"notBefore": _iso(now - timedelta(hours=1)), "weightBps": [5000, 5000]}]
    plane.promote([control], experiment={"experimentId": "exp_1", "salt": "AAECAwQFBgcICQoLDA0ODw", "subjectKey": "request", "arms": [{"arm": "control", "weightBps": 9000, "releaseDigest": "sha256:" + "0" * 64, "overrides": []}, {"arm": "candidate", "weightBps": 1000, "releaseDigest": "sha256:" + "1" * 64, "overrides": [candidate]}], "ramp": ramp})
    assert pull().status == "ok"
    row2 = datastore.latest(GLOBAL)
    assert row2.rollout["experiments"][0]["arms"] == [{"arm": "control", "weightBps": 9000}, {"arm": "candidate", "weightBps": 1000}]
    assert len(row2.rollout["experiments"][0]["ramp"]) == 2
    assert pull().stored is False
    assert datastore.generations(GLOBAL) == [2, 1]

    state_dir = tempfile.mkdtemp(prefix="ap-datastore-")
    try:
        ap = _boot(plane, key, datastore, state_dir)
        assert ap.generation == 2
        status = ap.status()
        assert status.ramp["weightBps"] == [5000, 5000], "the ramp walks on this host's clock, as signed"
        assert status.datastore["last_outcome"] == "activated" and status.datastore["newest_generation"] == 2 and status.datastore["rollback"] is None
        assert ap.hydrate() == {"outcome": "unchanged", "generation": 2}
        ap.stop()
    finally:
        shutil.rmtree(state_dir, ignore_errors=True)


def test_a_datastore_rollback_moves_the_fleet_down_verified_and_held_and_back():
    plane, fleet, key, datastore = _setup()
    pull = puller(plane, datastore, fleet.public_raw)
    for text in ("v1", "v2", "v3"):
        plane.promote([plane.slot(tag="support.reply", text=text, version_id=f"ver_{text}")])
        pull()
    dir_a, dir_b = tempfile.mkdtemp(prefix="ap-ds-a-"), tempfile.mkdtemp(prefix="ap-ds-b-")
    try:
        a = _boot(plane, key, datastore, dir_a)
        b = _boot(plane, key, datastore, dir_b)
        assert a.generation == 3

        rolled = rollback_datastore(datastore=datastore, key=GLOBAL, reason="bad release")
        assert rolled.ok and (rolled.control.generation, rolled.control.held_back_below) == (2, 3)
        assert a.hydrate() == {"outcome": "rolled_back", "generation": 2, "heldBackBelow": 3}
        assert b.hydrate() == {"outcome": "rolled_back", "generation": 2, "heldBackBelow": 3}
        assert a.prompt("support.reply").render().text == "v2"
        assert a.status().forced_downgrade is True
        assert a.status().datastore["rollback"]["generation"] == 2
        assert a.hydrate() == {"outcome": "unchanged", "generation": 2}

        b.stop()
        b2 = _boot(plane, key, datastore, dir_b)
        assert b2.generation == 2

        clear_datastore_rollback(datastore=datastore, key=GLOBAL)
        assert a.hydrate() == {"outcome": "activated", "generation": 3}
        assert a.prompt("support.reply").render().text == "v3"

        rollback_datastore(datastore=datastore, key=GLOBAL, to_generation=1)
        assert b2.hydrate() == {"outcome": "rolled_back", "generation": 1, "heldBackBelow": 3}
        plane.promote([plane.slot(tag="support.reply", text="v4", version_id="ver_v4")])
        pull()
        assert b2.hydrate() == {"outcome": "activated", "generation": 4}
        assert resolve_hydration(datastore, GLOBAL).control is None
        assert rollback_datastore(datastore=datastore, key=GLOBAL, to_generation=9).reason == "generation_missing"
        a.stop()
        b2.stop()
    finally:
        shutil.rmtree(dir_a, ignore_errors=True)
        shutil.rmtree(dir_b, ignore_errors=True)


def test_regions_read_their_own_rows_and_rollback_before_the_global_ones():
    plane, fleet, key, datastore = _setup()
    global_pull = puller(plane, datastore, fleet.public_raw, None)
    eu_pull = puller(plane, datastore, fleet.public_raw, "eu-west-1")
    for text in ("v1", "v2"):
        plane.promote([plane.slot(tag="support.reply", text=text, version_id=f"ver_{text}")])
        global_pull()
        eu_pull()
    dirs = [tempfile.mkdtemp(prefix="ap-ds-eu-"), tempfile.mkdtemp(prefix="ap-ds-us-")]
    eu_key = ReleaseKey("org_1", "agt_1", "prod", "eu-west-1")
    try:
        eu = _boot(plane, key, datastore, dirs[0], "eu-west-1")
        us = _boot(plane, key, datastore, dirs[1], "us-east-1")
        assert eu.status().datastore["rows_from"] == "region"
        assert us.status().datastore["rows_from"] == "global"
        assert eu.generation == 2 and us.generation == 2

        assert rollback_datastore(datastore=datastore, key=eu_key).ok
        assert eu.hydrate() == {"outcome": "rolled_back", "generation": 1, "heldBackBelow": 2}
        assert us.hydrate() == {"outcome": "unchanged", "generation": 2}
        assert eu.status().datastore["rollback"]["scope"] == "region"

        rollback_datastore(datastore=datastore, key=GLOBAL, to_generation=1)
        assert us.hydrate() == {"outcome": "rolled_back", "generation": 1, "heldBackBelow": 2}
        assert us.status().datastore["rollback"]["scope"] == "global"
        clear_datastore_rollback(datastore=datastore, key=eu_key)
        assert eu.hydrate() == {"outcome": "unchanged", "generation": 1}
        assert eu.status().datastore["rollback"]["scope"] == "global"
        clear_datastore_rollback(datastore=datastore, key=GLOBAL)
        assert eu.hydrate() == {"outcome": "activated", "generation": 2}
        assert us.hydrate() == {"outcome": "activated", "generation": 2}
        eu.stop()
        us.stop()
    finally:
        for d in dirs:
            shutil.rmtree(d, ignore_errors=True)


class _Flaky:
    def __init__(self, inner):
        self.inner = inner
        self.down = False

    def __getattr__(self, name):
        method = getattr(self.inner, name)

        def call(*args, **kwargs):
            if self.down:
                raise ConnectionError("connection refused")
            return method(*args, **kwargs)

        return call


def test_a_datastore_that_cannot_be_read_leaves_the_runtime_serving():
    plane, fleet, key, datastore = _setup()
    plane.promote([plane.slot(tag="support.reply", text="v1", version_id="ver_1")])
    puller(plane, datastore, fleet.public_raw)()
    flaky = _Flaky(datastore)
    state_dir = tempfile.mkdtemp(prefix="ap-ds-flaky-")
    try:
        ap = _boot(plane, key, flaky, state_dir)
        flaky.down = True
        assert ap.hydrate()["outcome"] == "unavailable"
        assert ap.generation == 1
        assert ap.status().datastore["last_outcome"] == "unavailable"
        assert puller(plane, flaky, fleet.public_raw)().status == "datastore_unavailable"
        ap.stop()
        again = _boot(plane, key, flaky, state_dir)
        assert again.generation == 1
        again.stop()
    finally:
        shutil.rmtree(state_dir, ignore_errors=True)
