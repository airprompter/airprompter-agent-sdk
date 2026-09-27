"""Cross-language interop: a store the TypeScript SDK wrote (file key, an
encrypted A slot, a closed spool segment) opens in this SDK — the same
KEK wrap, the same payload AAD, the same manifest verification, the same
segment names — and a ``run_ref`` minted there parses here with the same
per-store key derivation. Runs when ``node`` and the TypeScript SDK's
dev dependencies are present (CI installs them; locally it skips otherwise).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import shutil
import subprocess
import tempfile

import pytest

from airprompter_agent.agent import AirPrompterAgent
from airprompter_agent_core.render.run_ref import parse_run_ref
from airprompter_agent_telemetry.spool.writer import epoch_minute
from airprompter_agent_core._util import instant

HERE = os.path.dirname(__file__)
TS_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "sdk-typescript"))
FIXTURE = os.path.join(HERE, "interop", "write_ts_store.mts")


def _node_available() -> bool:
    return shutil.which("node") is not None and os.path.isdir(os.path.join(TS_DIR, "node_modules", "tsx"))


@pytest.mark.skipif(not _node_available(), reason="node + sdk-typescript/node_modules (npm ci) needed for the cross-language store fixture")
def test_store_written_by_typescript_opens_here():
    state_dir = tempfile.mkdtemp(prefix="ap-interop-")
    try:
        completed = subprocess.run(["node", "--import", "tsx", FIXTURE, state_dir], cwd=TS_DIR, capture_output=True, text=True, check=True, timeout=120)
        expected = json.loads(completed.stdout)
        ap = AirPrompterAgent.start(organization_id="org_1", agent_id="agt_1", target="prod", state_dir=state_dir, root={"pinned": expected["pinnedRoot"]})
        try:
            assert ap.generation == expected["generation"]
            assert ap.instance_id != expected["instanceId"], "S6: the process's id is its own, never the store's"
            assert ap._run_ref_key == hmac.new(expected["instanceId"].encode("utf-8"), b"runRef", hashlib.sha256).digest(), "the runRef key is the store's, shared by every process on the host"
            assert ap.status().signing_key_id == expected["signingKeyId"]
            assert ap.status().storage_protection == "file_key"
            assert ap.manifest["payload"]["releaseDigest"] == expected["releaseDigest"]
            assert ap.prompt("support.triage").render(team="Billing", ticket="x").text == expected["texts"]["support.triage"].replace("{{team}}", "Billing").replace("{{ticket}}", "<ticket>x</ticket>")
            assert ap.prompt("support.reply").render(name="Bo").text == "Reply politely to Bo."
            facts = parse_run_ref(expected["runRef"], ap._run_ref_key)
            assert facts is not None and facts.tag == "support.triage" and facts.generation == 1, "a run_ref minted by TypeScript parses under the Python-derived key"
            assert ap.feedback(expected["runRef"], thumbs="up") is True
            spool_dir = os.path.join(state_dir, "airprompter", "agt_1", "prod", "spool", "telemetry")
            segments = sorted(n for n in os.listdir(spool_dir) if n.startswith("seg-") and n.endswith(".ndjson"))
            assert segments == [f"seg-{expected['instanceId']}-{epoch_minute(instant('2026-09-12T14:04:10Z'))}-0.ndjson"]
        finally:
            ap.stop()
        # And after this SDK wrote to it (feedback closes into a new segment on stop), the layout is still one the daemon reads.
        segments_after = sorted(n for n in os.listdir(os.path.join(state_dir, "airprompter", "agt_1", "prod", "spool", "telemetry")) if n.startswith("seg-"))
        assert len(segments_after) >= 1 and not any(n.endswith(".open") for n in segments_after)
    finally:
        shutil.rmtree(state_dir, ignore_errors=True)


def _datastore_backends(tmp_dir: str) -> list[tuple[str, str]]:
    """``(TypeScript target, name)`` for every backend this run can reach: always a directory; live ones when configured."""
    backends = [(f"file:{tmp_dir}", "file")]
    if os.environ.get("AIRPROMPTER_TEST_POSTGRES_URL"):
        backends.append((f"postgres:{os.environ['AIRPROMPTER_TEST_POSTGRES_URL']}", "postgres"))
    if os.environ.get("AIRPROMPTER_TEST_REDIS_URL"):
        backends.append((f"redis:{os.environ['AIRPROMPTER_TEST_REDIS_URL']}", "redis"))
    if os.environ.get("AIRPROMPTER_TEST_S3_ENDPOINT"):
        backends.append((f"s3:{os.environ['AIRPROMPTER_TEST_S3_ENDPOINT']}|ap-kv-interop", "s3"))
    return backends


def _python_kv(name: str, tmp_dir: str):
    """The Python adapter for the backend the TypeScript adapter wrote: the same table, keys, hashes or objects."""
    if name == "file":
        from airprompter_agent_sync import FileKvStore

        return FileKvStore(tmp_dir), lambda: None
    if name == "postgres":
        import psycopg
        from airprompter_datastore_postgres import postgres_kv_store

        conn = psycopg.connect(os.environ["AIRPROMPTER_TEST_POSTGRES_URL"], autocommit=True)
        return postgres_kv_store(connection=conn, table="ap_kv_interop"), conn.close
    if name == "redis":
        import redis
        from airprompter_datastore_redis import redis_kv_store

        client = redis.Redis.from_url(os.environ["AIRPROMPTER_TEST_REDIS_URL"])
        return redis_kv_store(client=client, namespace="ap-interop"), client.close
    import boto3
    from airprompter_datastore_s3 import s3_kv_store

    client = boto3.client("s3", endpoint_url=os.environ["AIRPROMPTER_TEST_S3_ENDPOINT"], region_name="us-east-1", aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID", "test"), aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY", "test"))
    return s3_kv_store(client=client, bucket="ap-kv-interop"), client.close


@pytest.mark.skipif(not _node_available(), reason="node + sdk-typescript/node_modules (npm ci) needed for the cross-language datastore fixture")
def test_datastore_written_by_typescript_hydrates_here_through_every_adapter():
    """T40: rows and a fleet rollback the TypeScript puller wrote through a TypeScript adapter hydrate a Python runtime
    through the Python adapter for the same backend — the shared format and each adapter's layout, end to end."""
    import base64

    from airprompter_agent_core.bundle.apbundle import DistributionKey
    from airprompter_agent_core.bundle.hpke import x25519_private_key_from_raw
    from airprompter_agent_sync import ReleaseKey, clear_datastore_rollback, kv_release_datastore

    fixture = os.path.join(HERE, "interop", "write_ts_datastore.mts")
    tmp_dir = tempfile.mkdtemp(prefix="ap-interop-ds-")
    try:
        for target, name in _datastore_backends(tmp_dir):
            prefix = f"interop-{name}-{os.getpid()}/"
            completed = subprocess.run(["node", "--import", "tsx", fixture, target, prefix], cwd=TS_DIR, capture_output=True, text=True, timeout=180)
            assert completed.returncode == 0, completed.stderr[-2000:]
            expected = json.loads(completed.stdout)
            raw = base64.urlsafe_b64decode(expected["distributionPrivateKey"] + "==")
            key = DistributionKey(x25519_private_key_from_raw(raw), base64.urlsafe_b64decode(expected["distributionPublicKey"] + "=="))
            kv, close = _python_kv(name, tmp_dir)
            state_dir = tempfile.mkdtemp(prefix=f"ap-interop-{name}-")
            try:
                releases = kv_release_datastore(kv, prefix=prefix)
                assert releases.generations(ReleaseKey("org_1", "agt_1", "prod", None)) == [3, 2, 1], name
                ap = AirPrompterAgent.start(organization_id="org_1", agent_id="agt_1", target="prod", state_dir=state_dir, root={"pinned": expected["pinnedRoot"]}, distribution_key=key, datastore={"store": releases})
                try:
                    assert ap.generation == expected["generation"], name
                    assert ap.prompt("support.reply").render().text == expected["text"], name
                    assert ap.status().datastore["rollback"]["held_back_below"] == expected["heldBackBelow"], name
                    # And the other way: a clear written here is what the TypeScript layout reads as "no rollback".
                    clear_datastore_rollback(datastore=releases, key=ReleaseKey("org_1", "agt_1", "prod", None))
                    assert ap.hydrate() == {"outcome": "activated", "generation": 3}, name
                finally:
                    ap.stop()
                for stale in kv.list(prefix):
                    kv.delete(stale)
            finally:
                close()
                shutil.rmtree(state_dir, ignore_errors=True)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
