"""``airprompter-datastore-redis`` — the release datastore's ``KvStore`` over Redis or Valkey (T40,
``protocol/datastore-format.md``). The same keys, hashes, index and Lua scripts as ``@airprompter/datastore-redis``, so
a Python puller and a TypeScript runtime share one namespace. No client is bundled: hand in anything with
``execute_command(*args)`` (``redis.Redis``, ``redis.cluster.RedisCluster``, Valkey's client). Each key is a hash
(``value``, ``version``); a sorted set indexes the keys so ``list`` is an exact prefix range; every key carries one
hash tag (``{namespace}``), so a cluster keeps them in one slot. Redis 6.2 or later.

Example::

    import redis
    from airprompter_agent import kv_release_datastore
    from airprompter_datastore_redis import redis_kv_store

    releases = kv_release_datastore(redis_kv_store(client=redis.Redis.from_url(os.environ["REDIS_URL"])))
"""

from __future__ import annotations

import re
from typing import Any, Optional

from airprompter_agent_sync.store.kv_store import KvEntry, check_condition

__all__ = ["RedisKvStore", "redis_kv_store"]

# The same scripts, byte for byte, as the TypeScript adapter. KEYS[1] the entry hash, KEYS[2] the index;
# ARGV[1] the value, ARGV[2] the logical key, ARGV[3] the version read.
PUT_IF_ABSENT = """if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1], 'value', ARGV[1], 'version', '1')
redis.call('ZADD', KEYS[2], 0, ARGV[2])
return 1"""
PUT_IF_VERSION = """local current = redis.call('HGET', KEYS[1], 'version')
if not current or current ~= ARGV[3] then return 0 end
redis.call('HSET', KEYS[1], 'value', ARGV[1], 'version', tostring(tonumber(current) + 1))
return 1"""
DELETE = """redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1"""


def _text(reply: Any) -> Optional[str]:
    if reply is None:
        return None
    if isinstance(reply, (bytes, bytearray)):
        return bytes(reply).decode("utf-8")
    return str(reply)


class RedisKvStore:
    def __init__(self, *, client: Any, namespace: str = "airprompter", list_batch: int = 500) -> None:
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", namespace):
            raise ValueError(f"not a namespace: {namespace!r}")
        self._client = client
        self._tag = "{" + namespace + "}"
        self._index = f"{self._tag}:index"
        self._batch = max(1, list_batch)

    def _entry(self, key: str) -> str:
        return f"{self._tag}:v:{key}"

    def get(self, key: str) -> Optional[KvEntry]:
        reply = self._client.execute_command("HMGET", self._entry(key), "value", "version") or [None, None]
        value, version = _text(reply[0]), _text(reply[1])
        return None if value is None or version is None else KvEntry(value, version)

    def put(self, key: str, value: str, *, if_absent: bool = False, if_version: Optional[str] = None) -> bool:
        check_condition(if_absent, if_version)
        if if_absent:
            reply = self._client.execute_command("EVAL", PUT_IF_ABSENT, 2, self._entry(key), self._index, value, key)
        else:
            reply = self._client.execute_command("EVAL", PUT_IF_VERSION, 2, self._entry(key), self._index, value, key, if_version)
        return int(reply) == 1

    def list(self, prefix: str) -> list[str]:
        # The index is ordered byte-wise, so every key with the prefix sits in one run right after "[prefix".
        keys: list[str] = []
        offset = 0
        while True:
            page = [_text(member) or "" for member in self._client.execute_command("ZRANGEBYLEX", self._index, "-" if prefix == "" else f"[{prefix}", "+", "LIMIT", offset, self._batch) or []]
            for key in page:
                if not key.startswith(prefix):
                    return keys
                keys.append(key)
            if len(page) < self._batch:
                return keys
            offset += len(page)

    def delete(self, key: str) -> None:
        self._client.execute_command("EVAL", DELETE, 2, self._entry(key), self._index, key)


def redis_kv_store(*, client: Any, namespace: str = "airprompter", list_batch: int = 500) -> RedisKvStore:
    return RedisKvStore(client=client, namespace=namespace, list_batch=list_batch)
