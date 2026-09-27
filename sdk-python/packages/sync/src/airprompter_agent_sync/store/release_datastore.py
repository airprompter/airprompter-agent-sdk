"""The release datastore (T40): the customer's own database, bucket or config service as the fleet's copy of what
AirPrompter sealed. The SDK owns no connection: the application hands in a ``ReleaseDatastore`` — a DAO over its
Postgres table, its DynamoDB item, its Redis hash — and the puller writes through it (``pull_to_datastore``) while
every runtime hydrates from it (``AirPrompterAgent.start(datastore=...)``, ``ap.hydrate()``).

A row holds the sealed ``.apbundle`` — ciphertext to the fleet's distribution key, signed end to end — so the
datastore is a carrier, never a root of trust: a runtime verifies every row through the same chain as OTA before a
byte is served. Beside it the row keeps a content-free ``rollout`` summary (the arms, their dial-up percentages and
ramp steps, the disabled scopes) for the customer's own queries; hydration never reads it — the signed manifest inside
the bundle is what serves, so a ramp keeps walking on each host's clock exactly as signed.

Two things live only here, because they are the fleet's and not the control plane's: the ROLLBACK in force
(``ReleaseControl``: serve an older row, held until the fleet moves past the generation it stepped down from), and the
REGION: every row and control is keyed by ``(organizationId, agentId, target, region)``. A region with rows of its own
serves them; one with none reads the global rows (``region=None``). A rollback set for a region binds that region
only; one set globally binds every region without one of its own. The same rules as ``releaseDatastore.ts``.

Most applications never implement ``ReleaseDatastore`` themselves: ``kv_release_datastore(kv)`` implements it over a
``KvStore`` (four operations; ``airprompter-datastore-s3``, ``-postgres`` and ``-redis`` ship three) in the shared
format of ``protocol/datastore-format.md``, so a Python puller and a TypeScript runtime read each other's rows.

Example::

    from airprompter_datastore_postgres import postgres_kv_store
    releases = kv_release_datastore(postgres_kv_store(connection=psycopg.connect(url, autocommit=True)))
    pull_to_datastore(datastore=releases, region="eu-west-1", client=client, scope=scope, trusted_root=root,
                      fetch_root=fetch_root, now=now_iso, distribution_public_key=fleet_public_raw)
    ap = AirPrompterAgent.start(..., distribution_key=fleet_key, datastore={"store": releases, "region": "eu-west-1"})
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Mapping, Optional, Protocol

from airprompter_agent_core.protocol.trust import experiments_of

from ..sync.pull_bundle import PullEdgeState
from .datastore_records import datastore_keys, decode_datastore_record, encode_datastore_record, generation_of_release_key
from .kv_store import KvStore, MemoryKvStore


@dataclass(frozen=True)
class ReleaseKey:
    """Where a row lives: the signed scope, and the region the customer deploys to (``None``: every region without its own)."""

    organization_id: str
    agent_id: str
    target: str
    region: Optional[str] = None

    def global_key(self) -> "ReleaseKey":
        return ReleaseKey(self.organization_id, self.agent_id, self.target, None)


@dataclass
class StoredReleaseRow:
    """One generation as the datastore carries it. ``bundle`` is the ``.apbundle`` as JSON text; ``rollout`` the
    content-free summary (``rollout_of``) — for queries, never for serving."""

    generation: int
    release_digest: str
    bundle: str
    created_at: str
    not_after: str
    rollout: dict[str, Any] = field(default_factory=dict)


@dataclass
class ReleaseControl:
    """The fleet's rollback in force: serve ``generation`` while the newest row is at or below ``held_back_below``."""

    generation: int
    held_back_below: int
    set_at: str
    reason: Optional[str] = None
    set_by: Optional[str] = None


#: ``set_control``'s "no expectation": write whatever the control is now.
UNSET: Any = object()


class ReleaseDatastore(Protocol):
    """What the puller writes and every runtime reads. Every method may raise (the datastore is down): the puller
    reports it, a runtime keeps serving what it holds. No method needs a transaction: the puller writes the row
    (``put_release``), then the edge state (``put_edge``) — never the edge before its row. A row is immutable once
    written. ``set_control`` with ``expected`` (what the caller read, ``None`` for none) writes only if the control is
    still that and answers ``False`` when another operator changed it first. ``prune(key, keep)`` is optional."""

    def latest(self, key: ReleaseKey) -> Optional[StoredReleaseRow]: ...
    def get(self, key: ReleaseKey, generation: int) -> Optional[StoredReleaseRow]: ...
    def generations(self, key: ReleaseKey) -> list[int]: ...
    def put_release(self, key: ReleaseKey, row: StoredReleaseRow) -> None: ...
    def edge(self, key: ReleaseKey) -> Optional[PullEdgeState]: ...
    def put_edge(self, key: ReleaseKey, edge: PullEdgeState) -> None: ...
    def control(self, key: ReleaseKey) -> Optional[ReleaseControl]: ...
    def set_control(self, key: ReleaseKey, control: Optional[ReleaseControl], expected: Any = UNSET) -> bool: ...


def rollout_of(manifest: Mapping[str, Any]) -> dict[str, Any]:
    """The rollout summary of a manifest — what the signed payload says, copied as data (camelCase, as the TS SDK writes it)."""
    payload = manifest["payload"]
    experiments = [
        {
            "experimentId": experiment["experimentId"],
            "tag": experiment.get("tag"),
            "arms": [{"arm": arm["arm"], "weightBps": arm["weightBps"]} for arm in experiment["arms"]],
            "ramp": [{"notBefore": step["notBefore"], "weightBps": list(step["weightBps"])} for step in experiment.get("ramp") or []],
        }
        for experiment in experiments_of(payload)
    ]
    disabled: dict[str, Any] = {"agent": False, "slots": [], "arms": []}
    for directive in payload.get("directives") or []:
        if directive.get("kind") != "disable":
            continue
        if directive.get("scope") == "agent":
            disabled["agent"] = True
        elif directive.get("scope") == "slot" and directive.get("tag"):
            disabled["slots"].append(directive["tag"])
        elif directive.get("scope") == "arm" and directive.get("arm"):
            disabled["arms"].append({"arm": directive["arm"], "experimentId": directive.get("experimentId")})
    return {"applyPolicy": payload.get("applyPolicy"), "experiments": experiments, "disabled": disabled}


@dataclass
class HydrationPlan:
    """What a runtime should serve: the row, the newest generation held, the rollback in force (with its scope) and
    where the rows came from."""

    row: Optional[StoredReleaseRow]
    newest: int
    control: Optional[ReleaseControl] = None
    control_scope: Optional[str] = None  # "region" | "global"
    rows_from: Optional[str] = None  # "region" | "global"
    missing_rollback_generation: Optional[int] = None


def resolve_hydration(datastore: ReleaseDatastore, key: ReleaseKey) -> HydrationPlan:
    """Rows: the region's own when it has any, else the global ones. Rollback: the region's own control, else the
    global one — in force while the newest row is at or below its ``held_back_below``; a promotion past that ends it."""
    regional = key.region is not None
    rows_key, rows_from = key, ("region" if regional else "global")
    newest_row = datastore.latest(key)
    if newest_row is None and regional:
        rows_key, rows_from = key.global_key(), "global"
        newest_row = datastore.latest(rows_key)
    if newest_row is None:
        return HydrationPlan(row=None, newest=0)
    control, scope = datastore.control(key), ("region" if regional else "global")
    if control is None and regional:
        control, scope = datastore.control(key.global_key()), "global"
    if control is None or newest_row.generation > control.held_back_below:
        return HydrationPlan(row=newest_row, newest=newest_row.generation, rows_from=rows_from)
    if control.generation == newest_row.generation:
        return HydrationPlan(row=newest_row, newest=newest_row.generation, control=control, control_scope=scope, rows_from=rows_from)
    target = datastore.get(rows_key, control.generation)
    if target is None:
        return HydrationPlan(row=newest_row, newest=newest_row.generation, rows_from=rows_from, missing_rollback_generation=control.generation)
    return HydrationPlan(row=target, newest=newest_row.generation, control=control, control_scope=scope, rows_from=rows_from)


@dataclass
class DatastoreRollbackResult:
    ok: bool
    control: Optional[ReleaseControl] = None
    reason: Optional[str] = None  # "no_release" | "no_previous_release" | "generation_missing" | "not_a_rollback" | "conflict"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def rollback_datastore(*, datastore: ReleaseDatastore, key: ReleaseKey, to_generation: Optional[int] = None, reason: Optional[str] = None, set_by: Optional[str] = None, now: Optional[str] = None) -> DatastoreRollbackResult:
    """Roll the fleet in ``key.region`` (or every region, with ``region=None``) back to an older row — one step down
    from what serves without ``to_generation``. Held until a generation above today's newest is promoted, or
    ``clear_datastore_rollback`` ends it. ``conflict`` when another operator changed this key's rollback meanwhile."""
    before = datastore.control(key)
    plan = resolve_hydration(datastore, key)
    if plan.row is None:
        return DatastoreRollbackResult(ok=False, reason="no_release")
    rows_key = key.global_key() if plan.rows_from == "global" else key
    held = sorted(datastore.generations(rows_key), reverse=True)
    serving = plan.row.generation
    target = to_generation if to_generation is not None else next((g for g in held if g < serving), None)
    if target is None:
        return DatastoreRollbackResult(ok=False, reason="no_previous_release")
    if target not in held:
        return DatastoreRollbackResult(ok=False, reason="generation_missing")
    if target >= plan.newest:
        return DatastoreRollbackResult(ok=False, reason="not_a_rollback")
    control = ReleaseControl(generation=target, held_back_below=plan.newest, set_at=now or _now_iso(), reason=reason, set_by=set_by)
    if not datastore.set_control(key, control, before):
        return DatastoreRollbackResult(ok=False, reason="conflict")
    return DatastoreRollbackResult(ok=True, control=control)


def clear_datastore_rollback(*, datastore: ReleaseDatastore, key: ReleaseKey) -> None:
    """End the rollback set for exactly this key: the newest row serves again on the next hydrate."""
    datastore.set_control(key, None)


def prune_datastore(*, datastore: ReleaseDatastore, key: ReleaseKey, keep: int) -> int:
    """Delete all but the newest ``keep`` rows for exactly this key (never the one a rollback names)."""
    if not isinstance(keep, int) or keep < 1:
        raise ValueError("keep must be a positive integer")
    prune = getattr(datastore, "prune", None)
    if prune is None:
        raise ValueError("this datastore does not prune")
    return int(prune(key, keep))


_MAX_CAS_ATTEMPTS = 8


def _row_of(record: Mapping[str, Any]) -> StoredReleaseRow:
    return StoredReleaseRow(generation=record["generation"], release_digest=record["releaseDigest"], bundle=json.dumps(record["bundle"]), created_at=record["createdAt"], not_after=record["notAfter"], rollout=record["rollout"])


def _control_of(record: Mapping[str, Any]) -> ReleaseControl:
    return ReleaseControl(generation=record["generation"], held_back_below=record["heldBackBelow"], set_at=record["setAt"], reason=record.get("reason"), set_by=record.get("setBy"))


def _control_fields(control: ReleaseControl) -> dict[str, Any]:
    return {"kind": "control", "generation": control.generation, "heldBackBelow": control.held_back_below, "setAt": control.set_at, "reason": control.reason, "setBy": control.set_by}


def _same_control(a: Optional[ReleaseControl], b: Optional[ReleaseControl]) -> bool:
    if a is None or b is None:
        return a is b
    return encode_datastore_record(_control_fields(a)) == encode_datastore_record(_control_fields(b))


class KvReleaseDatastore:
    """``ReleaseDatastore`` over any ``KvStore``, in the shared format (``protocol/datastore-format.md``): what one SDK
    writes, every other reads. Writes are ordered, never transactional: the release (``if_absent``), then
    ``latest.json`` moved forward only, then the edge state, never back past a later ``lastOriginAt``."""

    def __init__(self, kv: KvStore, prefix: str = "airprompter/") -> None:
        self.kv = kv
        self.prefix = prefix

    def _keys(self, key: ReleaseKey):
        return datastore_keys(self.prefix, key)

    def latest(self, key: ReleaseKey) -> Optional[StoredReleaseRow]:
        pointer = self.kv.get(self._keys(key).latest)
        if pointer is not None:
            row = self.get(key, decode_datastore_record(pointer.value, "latest")["generation"])
            if row is not None:
                return row
        # No pointer (a crash between the release and its pointer, or rows written by hand): the highest release.
        generations = self.generations(key)
        return self.get(key, generations[0]) if generations else None

    def get(self, key: ReleaseKey, generation: int) -> Optional[StoredReleaseRow]:
        entry = self.kv.get(self._keys(key).release(generation))
        return _row_of(decode_datastore_record(entry.value, "release", generation)) if entry is not None else None

    def generations(self, key: ReleaseKey) -> list[int]:
        keys = self._keys(key)
        found = {generation_of_release_key(keys.releases_prefix, name) for name in self.kv.list(keys.releases_prefix)}
        return sorted((g for g in found if g is not None), reverse=True)

    def put_release(self, key: ReleaseKey, row: StoredReleaseRow) -> None:
        keys = self._keys(key)
        text = encode_datastore_record({"kind": "release", "generation": row.generation, "releaseDigest": row.release_digest, "createdAt": row.created_at, "notAfter": row.not_after, "bundle": json.loads(row.bundle), "rollout": row.rollout})
        self.kv.put(keys.release(row.generation), text, if_absent=True)  # False: already held — immutable
        latest_text = encode_datastore_record({"kind": "latest", "generation": row.generation})
        for _ in range(_MAX_CAS_ATTEMPTS):
            current = self.kv.get(keys.latest)
            if current is not None and decode_datastore_record(current.value, "latest")["generation"] >= row.generation:
                return
            if self.kv.put(keys.latest, latest_text, **({"if_version": current.version} if current is not None else {"if_absent": True})):
                return
        raise RuntimeError(f"latest.json kept moving under {_MAX_CAS_ATTEMPTS} attempts to advance it to {row.generation}")

    def edge(self, key: ReleaseKey) -> Optional[PullEdgeState]:
        entry = self.kv.get(self._keys(key).edge)
        if entry is None:
            return None
        record = decode_datastore_record(entry.value, "edge")
        return PullEdgeState(record["pointerUrl"], record["pointerEtag"], record["manifestEtag"], record["lastOriginAt"])

    def put_edge(self, key: ReleaseKey, edge: PullEdgeState) -> None:
        edge_key = self._keys(key).edge
        text = encode_datastore_record({"kind": "edge", "pointerUrl": edge.pointer_url, "pointerEtag": edge.pointer_etag, "manifestEtag": edge.manifest_etag, "lastOriginAt": edge.last_origin_at})
        for _ in range(_MAX_CAS_ATTEMPTS):
            current = self.kv.get(edge_key)
            if current is not None:
                held = decode_datastore_record(current.value, "edge")
                # Another puller already recorded a later answer from the origin: this state is older, not newer.
                if (held["lastOriginAt"] or "") > (edge.last_origin_at or "") or current.value == text:
                    return
            if self.kv.put(edge_key, text, **({"if_version": current.version} if current is not None else {"if_absent": True})):
                return
        raise RuntimeError(f"edge.json kept moving under {_MAX_CAS_ATTEMPTS} attempts")

    def control(self, key: ReleaseKey) -> Optional[ReleaseControl]:
        entry = self.kv.get(self._keys(key).control)
        return _control_of(decode_datastore_record(entry.value, "control")) if entry is not None else None

    def set_control(self, key: ReleaseKey, control: Optional[ReleaseControl], expected: Any = UNSET) -> bool:
        control_key = self._keys(key).control
        current = self.kv.get(control_key)
        held = _control_of(decode_datastore_record(current.value, "control")) if current is not None else None
        if expected is not UNSET and not _same_control(held, expected):
            return False
        if control is None:
            if current is not None:
                self.kv.delete(control_key)
            return True
        text = encode_datastore_record(_control_fields(control))
        return self.kv.put(control_key, text, **({"if_version": current.version} if current is not None else {"if_absent": True}))

    def prune(self, key: ReleaseKey, keep: int) -> int:
        keys = self._keys(key)
        generations = self.generations(key)
        protected = set(generations[:keep])
        control = self.control(key)
        if control is not None:
            protected.add(control.generation)
        pointer = self.kv.get(keys.latest)
        if pointer is not None:
            protected.add(decode_datastore_record(pointer.value, "latest")["generation"])
        removed = 0
        for generation in generations:
            if generation not in protected:
                self.kv.delete(keys.release(generation))
                removed += 1
        return removed


def kv_release_datastore(kv: KvStore, *, prefix: str = "airprompter/") -> KvReleaseDatastore:
    """``ReleaseDatastore`` over a ``KvStore`` in the shared format; ``prefix`` is the deployment's own."""
    return KvReleaseDatastore(kv, prefix)


class MemoryReleaseDatastore(KvReleaseDatastore):
    """A ``ReleaseDatastore`` in memory — the shared format over a ``MemoryKvStore``: tests and dev loops."""

    def __init__(self, prefix: str = "airprompter/") -> None:
        super().__init__(MemoryKvStore(), prefix)
