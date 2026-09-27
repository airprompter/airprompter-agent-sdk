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

Example::

    class PostgresReleases:                       # implements ReleaseDatastore over your own connection
        def latest(self, key): ...                # SELECT … ORDER BY generation DESC LIMIT 1
        def put(self, key, row, edge): ...        # the row AND the edge state in ONE transaction
        ...

    pull_to_datastore(datastore=releases, region="eu-west-1", client=client, scope=scope, trusted_root=root,
                      fetch_root=fetch_root, now=now_iso, distribution_public_key=fleet_public_raw)
    ap = AirPrompterAgent.start(..., distribution_key=fleet_key, datastore={"store": releases, "region": "eu-west-1"})
"""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Mapping, Optional, Protocol

from airprompter_agent_core.protocol.trust import experiments_of

from ..sync.pull_bundle import PullEdgeState


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


class ReleaseDatastore(Protocol):
    """The DAO the application implements. Every method may raise (the datastore is down): the puller reports it, a
    runtime keeps serving what it holds. ``put`` writes the row AND the puller's edge state in one transaction; a row
    is immutable once written (``put`` of a generation already held for the key is a no-op)."""

    def latest(self, key: ReleaseKey) -> Optional[StoredReleaseRow]: ...
    def get(self, key: ReleaseKey, generation: int) -> Optional[StoredReleaseRow]: ...
    def generations(self, key: ReleaseKey) -> list[int]: ...
    def put(self, key: ReleaseKey, row: StoredReleaseRow, edge: PullEdgeState) -> None: ...
    def edge(self, key: ReleaseKey) -> Optional[PullEdgeState]: ...
    def put_edge(self, key: ReleaseKey, edge: PullEdgeState) -> None: ...
    def control(self, key: ReleaseKey) -> Optional[ReleaseControl]: ...
    def set_control(self, key: ReleaseKey, control: Optional[ReleaseControl]) -> None: ...


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
    reason: Optional[str] = None  # "no_release" | "no_previous_release" | "generation_missing" | "not_a_rollback"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def rollback_datastore(*, datastore: ReleaseDatastore, key: ReleaseKey, to_generation: Optional[int] = None, reason: Optional[str] = None, set_by: Optional[str] = None, now: Optional[str] = None) -> DatastoreRollbackResult:
    """Roll the fleet in ``key.region`` (or every region, with ``region=None``) back to an older row — one step down
    from what serves without ``to_generation``. Held until a generation above today's newest is promoted, or
    ``clear_datastore_rollback`` ends it."""
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
    datastore.set_control(key, control)
    return DatastoreRollbackResult(ok=True, control=control)


def clear_datastore_rollback(*, datastore: ReleaseDatastore, key: ReleaseKey) -> None:
    """End the rollback set for exactly this key: the newest row serves again on the next hydrate."""
    datastore.set_control(key, None)


def _key_string(key: ReleaseKey) -> str:
    return json.dumps([key.organization_id, key.agent_id, key.target, key.region])


class MemoryReleaseDatastore:
    """A ``ReleaseDatastore`` in memory: tests, a dev loop, and the reference for what a real DAO must do."""

    def __init__(self) -> None:
        self._rows: dict[str, dict[int, StoredReleaseRow]] = {}
        self._edges: dict[str, PullEdgeState] = {}
        self._controls: dict[str, ReleaseControl] = {}

    def latest(self, key: ReleaseKey) -> Optional[StoredReleaseRow]:
        rows = self._rows.get(_key_string(key))
        return copy.deepcopy(rows[max(rows)]) if rows else None

    def get(self, key: ReleaseKey, generation: int) -> Optional[StoredReleaseRow]:
        row = self._rows.get(_key_string(key), {}).get(generation)
        return copy.deepcopy(row) if row else None

    def generations(self, key: ReleaseKey) -> list[int]:
        return sorted(self._rows.get(_key_string(key), {}), reverse=True)

    def put(self, key: ReleaseKey, row: StoredReleaseRow, edge: PullEdgeState) -> None:
        rows = self._rows.setdefault(_key_string(key), {})
        rows.setdefault(row.generation, copy.deepcopy(row))
        self._edges[_key_string(key)] = copy.copy(edge)

    def edge(self, key: ReleaseKey) -> Optional[PullEdgeState]:
        edge = self._edges.get(_key_string(key))
        return copy.copy(edge) if edge else None

    def put_edge(self, key: ReleaseKey, edge: PullEdgeState) -> None:
        self._edges[_key_string(key)] = copy.copy(edge)

    def control(self, key: ReleaseKey) -> Optional[ReleaseControl]:
        control = self._controls.get(_key_string(key))
        return copy.copy(control) if control else None

    def set_control(self, key: ReleaseKey, control: Optional[ReleaseControl]) -> None:
        if control is None:
            self._controls.pop(_key_string(key), None)
        else:
            self._controls[_key_string(key)] = copy.copy(control)
