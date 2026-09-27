"""The puller with the customer's datastore around it (T40): ``pull_bundle`` reading its memory (the edge state, the
newest generation held) from the datastore and writing what it sealed back through it — the row and the edge state in
that order, never the edge before the row. The Agent key lives here and nowhere else; every runtime hydrates from the
rows. A regional puller (``region="eu-west-1"``) keeps its own rows and edge state; a global one (``region=None``)
writes the rows every region without its own reads. The same rules as ``pullToDatastore.ts``.

Example::

    streak = 0
    while True:
        result = pull_to_datastore(datastore=releases, region=os.environ.get("REGION"), client=client, scope=scope,
                                   trusted_root=root, fetch_root=fetch_root, now=now_iso, distribution_public_key=fleet_public_raw)
        streak = streak + 1 if result.status == "unchanged" else 0
        time.sleep(next_pull_delay_ms(outcome=result.status, unchanged_streak=streak, interval_ms=30_000) / 1000)
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Optional

from ..store.release_datastore import ReleaseDatastore, ReleaseKey, StoredReleaseRow, rollout_of
from .pull_bundle import PullBundleResult, pull_bundle


@dataclass
class PullToDatastoreResult:
    #: The pull's status, or ``"datastore_unavailable"`` when the datastore could not be read (``stage="read"``) or written (``"write"``).
    status: str
    key: ReleaseKey
    stored: bool
    pull: Optional[PullBundleResult] = None
    stage: Optional[str] = None
    detail: Optional[str] = None


def pull_to_datastore(*, datastore: ReleaseDatastore, region: Optional[str] = None, scope: Any, **pull: Any) -> PullToDatastoreResult:
    """``pull``: every ``pull_bundle`` argument but ``edge`` and ``minimum_generation``, which come from the datastore."""
    key = ReleaseKey(scope["organizationId"], scope["agentId"], scope["target"], region)
    try:
        edge = datastore.edge(key)
        held = datastore.latest(key)
    except Exception as error:  # noqa: BLE001 — a datastore outage is reported, never raised past the job
        return PullToDatastoreResult(status="datastore_unavailable", key=key, stored=False, stage="read", detail=str(error)[:240])
    result = pull_bundle(scope=scope, edge=edge, minimum_generation=held.generation if held else 0, **pull)
    try:
        if result.status == "ok":
            assert result.manifest is not None and result.generation is not None
            row = StoredReleaseRow(
                generation=result.generation,
                release_digest=str(result.release_digest),
                bundle=json.dumps(result.bundle),
                created_at=str(result.created_at),
                not_after=str(result.not_after),
                rollout=rollout_of(result.manifest),
            )
            # The row, then its edge state — in that order, never together: an edge saved before its row could hide it.
            datastore.put_release(key, row)
            datastore.put_edge(key, result.edge)
            return PullToDatastoreResult(status="ok", key=key, stored=True, pull=result)
        # Nothing written: the edge moves only when the origin confirmed nothing moved.
        if result.status in ("unchanged", "nothing_promoted"):
            datastore.put_edge(key, result.edge)
    except Exception as error:  # noqa: BLE001
        return PullToDatastoreResult(status="datastore_unavailable", key=key, stored=False, pull=result, stage="write", detail=str(error)[:240])
    return PullToDatastoreResult(status=result.status, key=key, stored=False, pull=result)
