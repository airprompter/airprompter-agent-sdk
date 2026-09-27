"""``airprompter-datastore-s3`` — the release datastore's ``KvStore`` over an S3 bucket (T40,
``protocol/datastore-format.md``), with S3's own conditional writes: ``IfNoneMatch="*"`` for ``if_absent``,
``IfMatch=<ETag>`` for ``if_version``; the version is the object's ETag, and a ``412 PreconditionFailed`` or ``409
ConditionalRequestConflict`` is a lost race, answered ``False``. The same object keys as ``@airprompter/datastore-s3``.
Pass your own configured ``boto3`` S3 client (boto3 1.35.70 or later, for ``IfMatch``); S3-compatible stores work
when they honour both headers (MinIO, Cloudflare R2) — prove yours with ``check_kv_store``.

Example::

    import boto3
    from airprompter_agent import kv_release_datastore
    from airprompter_datastore_s3 import s3_kv_store

    kv = s3_kv_store(client=boto3.client("s3", region_name="eu-west-1"), bucket="acme-airprompter-releases")
    releases = kv_release_datastore(kv)
"""

from __future__ import annotations

from typing import Any, Optional

from airprompter_agent_sync.store.kv_store import KvEntry, check_condition

__all__ = ["S3KvStore", "s3_kv_store"]


def _error(error: BaseException) -> tuple[Optional[str], Optional[int]]:
    """``(code, status)`` of a botocore ``ClientError`` without importing botocore; ``(None, None)`` for anything else."""
    response = getattr(error, "response", None)
    if not isinstance(response, dict):
        return None, None
    code = (response.get("Error") or {}).get("Code")
    status = (response.get("ResponseMetadata") or {}).get("HTTPStatusCode")
    return (str(code) if code is not None else None), (int(status) if status is not None else None)


def _missing(error: BaseException) -> bool:
    code, status = _error(error)
    return code in ("NoSuchKey", "NotFound", "404") or status == 404


def _lost_race(error: BaseException) -> bool:
    code, status = _error(error)
    return code in ("PreconditionFailed", "ConditionalRequestConflict") or status in (409, 412)


class S3KvStore:
    def __init__(self, *, client: Any, bucket: str, key_prefix: str = "") -> None:
        self._client = client
        self._bucket = bucket
        self._prefix = key_prefix

    def get(self, key: str) -> Optional[KvEntry]:
        try:
            response = self._client.get_object(Bucket=self._bucket, Key=self._prefix + key)
        except Exception as error:  # noqa: BLE001 — a missing object is None; anything else is the caller's
            if _missing(error):
                return None
            raise
        body = response["Body"].read().decode("utf-8")
        etag = response.get("ETag")
        if not etag:
            raise RuntimeError(f"S3 answered {self._prefix + key} without an ETag; conditional writes need one")
        return KvEntry(body, etag)

    def put(self, key: str, value: str, *, if_absent: bool = False, if_version: Optional[str] = None) -> bool:
        check_condition(if_absent, if_version)
        condition = {"IfNoneMatch": "*"} if if_absent else {"IfMatch": if_version}
        try:
            self._client.put_object(Bucket=self._bucket, Key=self._prefix + key, Body=value.encode("utf-8"), ContentType="application/json; charset=utf-8", **condition)
            return True
        except Exception as error:  # noqa: BLE001
            # ``IfMatch`` on a key that is gone is 404 on some stores: a lost race too.
            if _lost_race(error) or (not if_absent and _missing(error)):
                return False
            raise

    def list(self, prefix: str) -> list[str]:
        keys: list[str] = []
        token: Optional[str] = None
        full = self._prefix + prefix
        while True:
            page = self._client.list_objects_v2(Bucket=self._bucket, Prefix=full, **({"ContinuationToken": token} if token else {}))
            for obj in page.get("Contents") or []:
                name = obj.get("Key", "")
                if name.startswith(full):
                    keys.append(name[len(self._prefix):])
            if not page.get("IsTruncated"):
                return keys
            token = page.get("NextContinuationToken")

    def delete(self, key: str) -> None:
        try:
            self._client.delete_object(Bucket=self._bucket, Key=self._prefix + key)
        except Exception as error:  # noqa: BLE001
            if not _missing(error):
                raise


def s3_kv_store(*, client: Any, bucket: str, key_prefix: str = "") -> S3KvStore:
    return S3KvStore(client=client, bucket=bucket, key_prefix=key_prefix)
