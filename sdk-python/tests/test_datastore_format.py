"""T40: the datastore format (``protocol/datastore-format.md``) and the ``KvStore`` port under it. Parity with
``sdk-typescript/test/datastoreFormat.test.ts``: the layout and records match the protocol's vectors byte for byte;
the memory and file stores pass ``check_kv_store`` (and a broken store fails it); the KV-backed datastore orders its
writes, never moves ``latest.json`` or the edge state back, repairs a missing pointer, refuses a newer record, prunes
without touching a rollback, and loses a racing rollback instead of overwriting it."""

from __future__ import annotations

import json
import os
import threading
import time

import pytest

from airprompter_agent_sync import (
    DatastoreRecordError,
    FileKvStore,
    KvEntry,
    KvReleaseDatastore,
    MemoryKvStore,
    PullEdgeState,
    ReleaseControl,
    ReleaseKey,
    StoredReleaseRow,
    check_kv_store,
    datastore_keys,
    decode_datastore_record,
    encode_datastore_record,
    prune_datastore,
    resolve_hydration,
    rollback_datastore,
)

VECTORS = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "protocol", "vectors", "datastore.json"), encoding="utf-8"))
KEY = ReleaseKey("org_1", "agt_1", "prod", None)


def _key_of(key: dict) -> ReleaseKey:
    return ReleaseKey(key["organizationId"], key["agentId"], key["target"], key["region"])


def test_layout_and_records_match_the_protocol_vectors_byte_for_byte():
    for case in VECTORS["keys"]:
        keys = datastore_keys(case["prefix"], _key_of(case["key"]))
        got = {"releasesPrefix": keys.releases_prefix, "release": keys.release(case["generation"]), "latest": keys.latest, "edge": keys.edge, "control": keys.control}
        assert got == case["expect"], case["name"]
    for case in VECTORS["records"]:
        fields = case["fields"]
        assert encode_datastore_record(fields) == case["text"], case["name"]
        assert decode_datastore_record(case["text"], fields["kind"], fields["generation"] if fields["kind"] == "release" else None) == fields, case["name"]
    for case in VECTORS["refused"]:
        with pytest.raises(DatastoreRecordError) as caught:
            decode_datastore_record(case["text"], case["kind"], case.get("keyGeneration"))
        assert caught.value.code == case["code"], case["name"]


def test_memory_and_file_stores_keep_the_contract(tmp_path):
    memory = check_kv_store(MemoryKvStore())
    assert memory.failures == []
    assert len(memory.passed) >= 15
    files = check_kv_store(FileKvStore(str(tmp_path)), glob_characters=os.name != "nt")
    assert files.failures == []
    with pytest.raises(ValueError, match="not a relative key"):
        FileKvStore(str(tmp_path)).get("../escape.json")


def test_check_kv_store_has_teeth():
    inner = MemoryKvStore()

    class Racy:
        """Reads, yields, then writes: the classic hand-rolled adapter."""

        def get(self, key):
            return inner.get(key)

        def list(self, prefix):
            return inner.list(prefix)

        def delete(self, key):
            inner.delete(key)

        def put(self, key, value, *, if_absent=False, if_version=None):
            current = inner.get(key)
            time.sleep(0.01)
            if (current is not None) if if_absent else (current is None or current.version != if_version):
                return False
            now = inner.get(key)
            inner.put(key, value, **({"if_version": now.version} if now else {"if_absent": True}))
            return True

    report = check_kv_store(Racy())
    assert any("racing if_absent" in failure for failure in report.failures), report.failures
    assert any("racing writes on one version" in failure for failure in report.failures), report.failures

    class Globby(Racy):
        """Treats ``_`` as a one-character wildcard, as an unescaped SQL LIKE does."""

        def put(self, key, value, *, if_absent=False, if_version=None):
            return inner.put(key, value, if_absent=if_absent, if_version=if_version)

        def list(self, prefix):
            import re

            pattern = re.compile("^" + re.escape(prefix).replace("_", "."))
            return [key for key in inner.list("") if pattern.match(key)]

    report = check_kv_store(Globby())
    assert any(failure.startswith("list returns exactly the keys under a prefix") for failure in report.failures), report.failures


def _row(generation: int) -> StoredReleaseRow:
    return StoredReleaseRow(generation=generation, release_digest="sha256:" + f"{generation:02d}" * 32, bundle=json.dumps({"format": "apbundle", "version": 1, "generation": generation}), created_at="2026-09-20T01:00:00.000Z", not_after="2026-12-19T01:00:00.000Z", rollout={"applyPolicy": "auto", "experiments": [], "disabled": {"agent": False, "slots": [], "arms": []}})


def test_the_kv_datastore_writes_in_order_and_only_moves_forward():
    kv = MemoryKvStore()
    datastore = KvReleaseDatastore(kv)
    keys = datastore_keys("airprompter/", KEY)
    datastore.put_release(KEY, _row(2))
    datastore.put_release(KEY, _row(1))
    assert decode_datastore_record(kv.get(keys.latest).value, "latest")["generation"] == 2
    assert datastore.latest(KEY).generation == 2
    assert datastore.generations(KEY) == [2, 1]
    # The same bytes the TypeScript SDK writes for the same row.
    assert kv.get(keys.release(2)).value == encode_datastore_record({"kind": "release", "generation": 2, "releaseDigest": _row(2).release_digest, "createdAt": _row(2).created_at, "notAfter": _row(2).not_after, "bundle": json.loads(_row(2).bundle), "rollout": _row(2).rollout})
    datastore.put_release(KEY, StoredReleaseRow(**{**_row(2).__dict__, "release_digest": "sha256:" + "ff" * 32}))
    assert datastore.get(KEY, 2).release_digest == _row(2).release_digest, "immutable"

    datastore.put_edge(KEY, PullEdgeState(None, None, "g2", "2026-09-20T02:00:00.000Z"))
    datastore.put_edge(KEY, PullEdgeState(None, None, "g1", "2026-09-20T01:00:00.000Z"))
    assert datastore.edge(KEY).manifest_etag == "g2", "the edge state never moves back"

    kv.put(keys.release(3), encode_datastore_record({"kind": "release", "generation": 3, "releaseDigest": _row(3).release_digest, "createdAt": _row(3).created_at, "notAfter": _row(3).not_after, "bundle": json.loads(_row(3).bundle), "rollout": _row(3).rollout}), if_absent=True)
    kv.delete(keys.latest)
    assert datastore.latest(KEY).generation == 3, "a missing pointer is repaired by the listing"

    racers = [threading.Thread(target=datastore.put_release, args=(KEY, _row(g))) for g in range(4, 12)]
    for t in racers:
        t.start()
    for t in racers:
        t.join()
    assert decode_datastore_record(kv.get(keys.latest).value, "latest")["generation"] == 11, "racing pullers leave the pointer at the highest"


def test_a_newer_record_is_refused_never_served():
    kv = MemoryKvStore()
    datastore = KvReleaseDatastore(kv)
    datastore.put_release(KEY, _row(1))
    keys = datastore_keys("airprompter/", KEY)
    kv.put(keys.latest, '{"format":2,"generation":1,"kind":"latest"}', if_version=kv.get(keys.latest).version)
    with pytest.raises(DatastoreRecordError) as caught:
        resolve_hydration(datastore, KEY)
    assert caught.value.code == "datastore_record_newer"


def test_prune_keeps_the_rollback_and_a_racing_rollback_loses():
    datastore = KvReleaseDatastore(MemoryKvStore())
    for generation in (1, 2, 3, 4, 5):
        datastore.put_release(KEY, _row(generation))
    assert rollback_datastore(datastore=datastore, key=KEY, to_generation=1).ok
    assert prune_datastore(datastore=datastore, key=KEY, keep=2) == 2
    assert datastore.generations(KEY) == [5, 4, 1]
    read = datastore.control(KEY)
    assert datastore.set_control(KEY, ReleaseControl(4, 5, "2026-09-20T04:00:00.000Z"), read) is True
    assert datastore.set_control(KEY, ReleaseControl(1, 5, "2026-09-20T04:00:01.000Z"), read) is False
    assert datastore.control(KEY).generation == 4
    assert datastore.set_control(KEY, None, ReleaseControl(4, 5, "2026-09-20T04:00:00.000Z")) is True
    assert datastore.control(KEY) is None
    assert isinstance(KvEntry("v", "1"), KvEntry)
