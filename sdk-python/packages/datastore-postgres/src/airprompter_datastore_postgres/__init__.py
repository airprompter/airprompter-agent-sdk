"""``airprompter-datastore-postgres`` — the release datastore's ``KvStore`` over one PostgreSQL table (T40,
``protocol/datastore-format.md``). The same table as ``@airprompter/datastore-postgres``, so a Python puller and a
TypeScript runtime share it. No driver is bundled: hand in a DB-API connection (``psycopg`` 3 or ``psycopg2``) or a
``psycopg_pool.ConnectionPool``, and the adapter keeps the contract in plain SQL — ``INSERT … ON CONFLICT DO
NOTHING`` for ``if_absent``, ``UPDATE … WHERE version = %s`` for ``if_version`` (a counter bumped on every write), an
escaped ``LIKE`` over a ``text_pattern_ops`` index for ``list``. Postgres 11 or later.

Example::

    import psycopg
    from airprompter_agent import kv_release_datastore
    from airprompter_datastore_postgres import postgres_kv_store

    kv = postgres_kv_store(connection=psycopg.connect(os.environ["DATABASE_URL"], autocommit=True))
    kv.ensure_schema()                     # or run postgres_kv_schema() in your own migrations
    releases = kv_release_datastore(kv)
"""

from __future__ import annotations

import re
import threading
from contextlib import contextmanager
from typing import Any, Iterator, Optional, Sequence

from airprompter_agent_sync.store.kv_store import KvEntry, check_condition

__all__ = ["PostgresKvStore", "postgres_kv_schema", "postgres_kv_store"]

_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")


def _quoted(table: str) -> tuple[str, str]:
    parts = table.split(".")
    if len(parts) > 2 or not all(_IDENTIFIER.match(part) for part in parts):
        raise ValueError(f"not a table name: {table!r} (letters, digits and _; optionally schema.name)")
    return ".".join(f'"{part}"' for part in parts), f'"{parts[-1]}_key_prefix"'


def postgres_kv_schema(table: str = "airprompter_kv") -> list[str]:
    """The DDL the adapter needs, for teams that run migrations themselves (the same as the TypeScript adapter's)."""
    quoted, index = _quoted(table)
    return [
        f"CREATE TABLE IF NOT EXISTS {quoted} (key text PRIMARY KEY, value text NOT NULL, version bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now())",
        f"CREATE INDEX IF NOT EXISTS {index} ON {quoted} (key text_pattern_ops)",
    ]


def _like_prefix(prefix: str) -> str:
    return re.sub(r"([\\%_])", r"\\\1", prefix) + "%"


class PostgresKvStore:
    def __init__(self, *, connection: Any = None, pool: Any = None, table: str = "airprompter_kv") -> None:
        if (connection is None) == (pool is None):
            raise ValueError("pass exactly one of connection= (a DB-API connection) or pool= (a psycopg_pool.ConnectionPool)")
        self.table = table
        self._quoted, _ = _quoted(table)
        self._connection = connection
        self._pool = pool
        # One connection is one transaction at a time: operations from several threads take turns.
        self._lock = threading.Lock()

    @contextmanager
    def _conn(self) -> Iterator[Any]:
        if self._pool is not None:
            with self._pool.connection() as conn:
                yield conn
        else:
            with self._lock:
                yield self._connection

    def _run(self, sql: str, params: Sequence[Any] = ()) -> tuple[list[Sequence[Any]], int]:
        with self._conn() as conn:
            try:
                cur = conn.cursor()
                try:
                    cur.execute(sql, tuple(params))
                    rows = list(cur.fetchall()) if cur.description is not None else []
                    count = cur.rowcount
                finally:
                    cur.close()
                if not getattr(conn, "autocommit", False):
                    conn.commit()
                return rows, count
            except Exception:
                if not getattr(conn, "autocommit", False):
                    conn.rollback()
                raise

    def ensure_schema(self) -> None:
        """Create the table and its prefix index when they are missing (idempotent)."""
        for statement in postgres_kv_schema(self.table):
            self._run(statement)

    def get(self, key: str) -> Optional[KvEntry]:
        rows, _ = self._run(f"SELECT value, version::text FROM {self._quoted} WHERE key = %s", (key,))
        return KvEntry(str(rows[0][0]), str(rows[0][1])) if rows else None

    def put(self, key: str, value: str, *, if_absent: bool = False, if_version: Optional[str] = None) -> bool:
        check_condition(if_absent, if_version)
        if if_absent:
            _, count = self._run(f"INSERT INTO {self._quoted} (key, value, version) VALUES (%s, %s, 1) ON CONFLICT (key) DO NOTHING", (key, value))
            return count == 1
        # A version this adapter never issued cannot match; never let it reach the cast.
        if not re.fullmatch(r"\d{1,19}", if_version or ""):
            return False
        _, count = self._run(f"UPDATE {self._quoted} SET value = %s, version = version + 1, updated_at = now() WHERE key = %s AND version = %s::bigint", (value, key, if_version))
        return count == 1

    def list(self, prefix: str) -> list[str]:
        rows, _ = self._run(f"SELECT key FROM {self._quoted} WHERE key LIKE %s ESCAPE '\\'", (_like_prefix(prefix),))
        return [str(row[0]) for row in rows if str(row[0]).startswith(prefix)]

    def delete(self, key: str) -> None:
        self._run(f"DELETE FROM {self._quoted} WHERE key = %s", (key,))


def postgres_kv_store(*, connection: Any = None, pool: Any = None, table: str = "airprompter_kv") -> PostgresKvStore:
    return PostgresKvStore(connection=connection, pool=pool, table=table)
