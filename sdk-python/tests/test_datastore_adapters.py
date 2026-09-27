"""T40: the three Python datastore adapters. Parity with ``sdk-typescript/test/datastoreAdapters.test.ts``. Against live
backends — Postgres (``AIRPROMPTER_TEST_POSTGRES_URL``, through psycopg 3 and psycopg2), Redis
(``AIRPROMPTER_TEST_REDIS_URL``) and S3 (``AIRPROMPTER_TEST_S3_ENDPOINT``, e.g. MinIO or moto) — each keeps the
``KvStore`` contract (``check_kv_store``) and carries a release from the puller to a runtime that hydrates from it and
rolls back through it. Without a backend configured those tests skip and say so; the unit tests with fake clients
(SQL shape, error mapping, key layout) always run."""

from __future__ import annotations

import os
import shutil
import tempfile
import time
from datetime import datetime, timezone

import httpx
import pytest

from airprompter_agent.agent import AirPrompterAgent
from airprompter_agent_core.bundle.apbundle import DistributionKey
from airprompter_agent_core.bundle.hpke import generate_x25519_key_pair
from airprompter_agent_core.control.client import SyncClient
from airprompter_agent_core.protocol.trust import public_jwk_of, trusted_root_from_pinned_key
from airprompter_agent_sync import ReleaseKey, check_kv_store, datastore_keys, decode_datastore_record, kv_release_datastore, pull_to_datastore, rollback_datastore
from airprompter_datastore_postgres import postgres_kv_schema, postgres_kv_store
from airprompter_datastore_redis import redis_kv_store
from airprompter_datastore_s3 import s3_kv_store

from .control_plane import FakeControlPlane

SCOPE = {"organizationId": "org_1", "agentId": "agt_1", "target": "prod"}
KW = {"organization_id": "org_1", "agent_id": "agt_1", "target": "prod"}
RUN = f"py-run-{int(time.time() * 1000):x}-{os.getpid()}"


def _no_network(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("offline", request=request)


def _fleet_over(kv, prefix: str) -> None:
    datastore = kv_release_datastore(kv, prefix=prefix)
    plane = FakeControlPlane(SCOPE)
    fleet = generate_x25519_key_pair()
    client = SyncClient(base_url="https://api.test", agent_id=SCOPE["agentId"], target=SCOPE["target"], api_key=plane.api_key, transport=plane.transport())
    root = trusted_root_from_pinned_key(purpose="platform", environment="prod", pinned_root=public_jwk_of(plane.root_key))
    edge = httpx.Client(transport=plane.transport())
    for text in ("v1", "v2", "v3"):
        plane.promote([plane.slot(tag="support.reply", text=text, version_id=f"ver_{text}")])
        pulled = pull_to_datastore(datastore=datastore, client=client, scope=SCOPE, trusted_root=root, fetch_root=lambda: edge.get("https://edge.test/roots/prod/root.json").json(), now=lambda: datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"), distribution_public_key=fleet.public_raw)
        assert pulled.status == "ok", pulled
    key = ReleaseKey("org_1", "agt_1", "prod", None)
    keys = datastore_keys(prefix, key)
    assert decode_datastore_record(kv.get(keys.latest).value, "latest")["generation"] == 3
    state_dir = tempfile.mkdtemp(prefix="ap-py-adapter-")
    try:
        ap = AirPrompterAgent.start(**KW, state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, transport=httpx.MockTransport(_no_network), distribution_key=DistributionKey(fleet.private_key, fleet.public_raw), datastore={"store": datastore})
        assert ap.generation == 3
        assert rollback_datastore(datastore=datastore, key=key, reason="adapter test").ok
        assert ap.hydrate() == {"outcome": "rolled_back", "generation": 2, "heldBackBelow": 3}
        assert ap.prompt("support.reply").render().text == "v2"
        ap.stop()
    finally:
        shutil.rmtree(state_dir, ignore_errors=True)
    for name in kv.list(prefix):
        kv.delete(name)


POSTGRES_URL = os.environ.get("AIRPROMPTER_TEST_POSTGRES_URL")


@pytest.mark.skipif(not POSTGRES_URL, reason="AIRPROMPTER_TEST_POSTGRES_URL is not set")
def test_postgres_contract_and_fleet_on_a_live_database_through_psycopg_and_psycopg2():
    import psycopg
    import psycopg2

    table = f"ap_kv_pytest_{os.getpid()}"
    with psycopg.connect(POSTGRES_URL, autocommit=True) as conn:
        kv = postgres_kv_store(connection=conn, table=table)
        kv.ensure_schema()
        kv.ensure_schema()
        report = check_kv_store(kv, racers=12)
        assert report.failures == []
        _fleet_over(kv, f"{RUN}/")
    legacy = psycopg2.connect(POSTGRES_URL)  # not autocommit: the adapter commits
    try:
        kv2 = postgres_kv_store(connection=legacy, table=table)
        assert check_kv_store(kv2, racers=6).failures == []
        cur = legacy.cursor()
        cur.execute(f'DROP TABLE "{table}"')
        legacy.commit()
    finally:
        legacy.close()


REDIS_URL = os.environ.get("AIRPROMPTER_TEST_REDIS_URL")


@pytest.mark.skipif(not REDIS_URL, reason="AIRPROMPTER_TEST_REDIS_URL is not set")
def test_redis_contract_and_fleet_on_a_live_server_with_bytes_and_decoded_replies():
    import redis

    for decode in (False, True):
        client = redis.Redis.from_url(REDIS_URL, decode_responses=decode)
        kv = redis_kv_store(client=client, namespace=f"ap-pytest-{decode}-{os.getpid()}", list_batch=3)
        report = check_kv_store(kv, racers=12)
        assert report.failures == [], decode
        _fleet_over(kv, f"{RUN}-{decode}/")
        client.close()


S3_ENDPOINT = os.environ.get("AIRPROMPTER_TEST_S3_ENDPOINT")


@pytest.mark.skipif(not S3_ENDPOINT, reason="AIRPROMPTER_TEST_S3_ENDPOINT is not set")
def test_s3_contract_and_fleet_on_a_live_endpoint_with_conditional_writes():
    import boto3

    client = boto3.client("s3", endpoint_url=S3_ENDPOINT, region_name=os.environ.get("AWS_REGION", "us-east-1"), aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID", "test"), aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY", "test"))
    bucket = os.environ.get("AIRPROMPTER_TEST_S3_BUCKET", f"ap-kv-pytest-{os.getpid()}")
    try:
        client.create_bucket(Bucket=bucket)
    except Exception:  # noqa: BLE001 — it may exist already
        pass
    kv = s3_kv_store(client=client, bucket=bucket, key_prefix=f"{RUN}/")
    assert check_kv_store(kv, racers=8).failures == []
    _fleet_over(kv, "fleet/")


# ----------------------------------------------------------------------------- always: no backend needed


class _Cursor:
    def __init__(self, log, rowcount=0):
        self.log, self.rowcount, self.description = log, rowcount, None

    def execute(self, sql, params):
        self.log.append((sql, params))

    def fetchall(self):
        return []

    def close(self):
        pass


class _Conn:
    autocommit = True

    def __init__(self):
        self.log = []

    def cursor(self):
        return _Cursor(self.log)


def test_postgres_sql_is_parameterised_like_escapes_and_names_are_checked():
    conn = _Conn()
    kv = postgres_kv_store(connection=conn, table="ops.releases")
    kv.list("a_b%c\\/")
    sql, params = conn.log[0]
    assert 'FROM "ops"."releases" WHERE key LIKE %s ESCAPE \'\\\'' in sql
    assert params == ("a\\_b\\%c\\\\/%",)
    assert kv.put("k", "v", if_version="1; DROP TABLE x") is False
    assert len(conn.log) == 1, "a version this adapter never issued never reaches SQL"
    with pytest.raises(ValueError, match="not a table name"):
        postgres_kv_store(connection=conn, table='x"; DROP TABLE y; --')
    with pytest.raises(ValueError, match="exactly one condition"):
        kv.put("k", "v")
    assert "text_pattern_ops" in postgres_kv_schema()[1]


class _ClientError(Exception):
    def __init__(self, code, status):
        super().__init__(code)
        self.response = {"Error": {"Code": code}, "ResponseMetadata": {"HTTPStatusCode": status}}


def test_s3_lost_race_is_false_missing_is_none_anything_else_raises():
    calls = []
    answers = []

    class Client:
        def __getattr__(self, name):
            def call(**kwargs):
                calls.append((name, kwargs))
                answer = answers.pop(0)
                if isinstance(answer, Exception):
                    raise answer
                return answer

            return call

    kv = s3_kv_store(client=Client(), bucket="b", key_prefix="p/")
    answers.append(_ClientError("PreconditionFailed", 412))
    assert kv.put("k", "v", if_absent=True) is False
    assert calls[0][1]["IfNoneMatch"] == "*" and calls[0][1]["Key"] == "p/k"
    answers.append(_ClientError("ConditionalRequestConflict", 409))
    assert kv.put("k", "v", if_version='"e1"') is False
    assert calls[1][1]["IfMatch"] == '"e1"'
    answers.append(_ClientError("NoSuchKey", 404))
    assert kv.get("k") is None
    answers.append(_ClientError("AccessDenied", 403))
    with pytest.raises(_ClientError):
        kv.get("k")
    answers.extend([{"Contents": [{"Key": "p/a/1"}], "IsTruncated": True, "NextContinuationToken": "t"}, {"Contents": [{"Key": "p/a/2"}], "IsTruncated": False}])
    assert kv.list("a/") == ["a/1", "a/2"]
    assert calls[-1][1]["ContinuationToken"] == "t"


def test_redis_keys_carry_one_hash_tag_the_same_as_the_typescript_adapter():
    sent = []

    class Client:
        def execute_command(self, *args):
            sent.append(args)
            return [None, None] if args[0] == "HMGET" else 1

    kv = redis_kv_store(client=Client(), namespace="acme")
    kv.get("x/y.json")
    kv.put("x/y.json", "{}", if_absent=True)
    assert sent[0][1] == "{acme}:v:x/y.json"
    assert sent[1][3:5] == ("{acme}:v:x/y.json", "{acme}:index")
    with pytest.raises(ValueError, match="not a namespace"):
        redis_kv_store(client=Client(), namespace="a b")
