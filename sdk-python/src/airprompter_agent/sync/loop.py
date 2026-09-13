"""One sync pass, and the three ways of scheduling it.

::

    resident:   every poll_seconds (jittered) — the edge pointer first,
                the manifest only when the generation moved
    on_invoke:  the same pass at invocation start and end (serverless has
                no background timer)
    daemon:     delegate to the host's daemon socket when present (T26);
                until then, in-process

A pass never blocks a render and never raises past its caller: sync
failures degrade to the last verified release and are reported. Every
manifest goes through the trust chain before a byte is staged; payloads
already held for unchanged hashes are reused, so a pass fetches only what
moved.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional, Sequence

from ..protocol.trust import referenced_payloads, verify_manifest, verify_root_metadata
from ..store.slot_store import LoadedSlot, SlotStore
from .client import SyncClient

#: ``activated_externally``: the customer's hook (or an operator) already made the staged release live during the decision.
ApplyPolicyDecision = str  # "activated" | "staged" | "activated_externally"


@dataclass
class SyncPassOutput:
    #: ``pointer_unchanged``: the unsigned edge pointer said nothing moved — silence, not contact (S3).
    #: ``unchanged``: the origin's authenticated 304, or a signed manifest at the generation already held — contact.
    outcome: str  # "pointer_unchanged" | "unchanged" | "activated" | "activated_externally" | "staged" | "refused" | "unavailable" | "nothing_promoted" | "held_back"
    etag: Optional[str]
    edge_etag: Optional[str]
    trusted_root: Mapping[str, Any]
    active: Optional[LoadedSlot]
    generation: Optional[int] = None
    reason: Optional[str] = None


def required_models_missing(payload: Mapping[str, Any], catalog: Optional[Sequence[str]]) -> list[str]:
    """The required models of a payload (its slots and every arm override) the declared catalog lacks; empty when nothing was declared."""
    if catalog is None:
        return []
    declared = set(catalog)
    slots = list(payload.get("slots", []))
    for arm in (payload.get("experiment") or {}).get("arms", []):
        slots.extend(arm.get("overrides", []))
    return sorted({slot["model"] for slot in slots if slot.get("modelRequired") is True and slot["model"] not in declared})


def sync_once(
    *,
    store: SlotStore,
    client: SyncClient,
    now: Callable[[], str],
    scope: Mapping[str, str],
    trusted_root: Mapping[str, Any],
    active: Optional[LoadedSlot],
    etag: Optional[str],
    apply_policy: Callable[[Mapping[str, Any]], ApplyPolicyDecision],
    fetch_root: Optional[Callable[[], Optional[Mapping[str, Any]]]] = None,
    edge_pointer_url: Optional[str] = None,
    edge_etag: Optional[str] = None,
    skip_pointer: bool = False,
    require_countersign: Optional[bool] = None,
    countersign_root: Optional[Mapping[str, Any]] = None,
    on_refusal: Optional[Callable[[str, Optional[int]], None]] = None,
    on_directives: Optional[Callable[[Mapping[str, Any]], None]] = None,
    catalog: Optional[Sequence[str]] = None,
    on_model_unavailable: Optional[Callable[[list[str], int], None]] = None,
) -> SyncPassOutput:
    """``on_directives`` (T9) is called with every manifest whose envelope verifies BEFORE the pass decides whether to stage,
    hold back or ignore it — so a ``disable`` (Freeze) or a ``request_unlock`` rides a manifest the runtime would otherwise
    leave staged or unchanged. Never a manifest that failed the trust chain."""
    at = now()
    root = trusted_root
    current_edge_etag = edge_etag

    def done(outcome: str, *, active_slot: Optional[LoadedSlot] = active, next_etag: Optional[str] = etag, generation: Optional[int] = None, reason: Optional[str] = None) -> SyncPassOutput:
        return SyncPassOutput(outcome, next_etag, current_edge_etag, root, active_slot, generation, reason)

    def refuse(reason: str, generation: Optional[int]) -> None:
        if on_refusal:
            on_refusal(reason, generation)

    try:
        # A newer root document is accepted only against the one already trusted (R1–R5).
        if fetch_root:
            candidate = fetch_root()
            if candidate:
                verdict = verify_root_metadata(candidate=candidate, trusted=root, now=at)
                if verdict.ok:
                    root = candidate
                    store.accept_root(candidate)
                else:
                    refuse(verdict.reason or "root_signature_invalid", None)

        # Idle path: the edge pointer says whether anything moved, without a Lambda on the other end. It is unsigned and
        # cacheable, so its silence is never contact (S3): the lease does not move on ``pointer_unchanged``.
        if edge_pointer_url and not skip_pointer:
            edge = client.edge_pointer(edge_pointer_url, current_edge_etag)
            if edge.status == "not_modified":
                return done("pointer_unchanged")
            if edge.status == "ok" and edge.pointer is not None:
                current_edge_etag = edge.etag
                if active and edge.pointer.get("generation", 0) <= active.generation:
                    return done("pointer_unchanged")

        fetched = client.manifest(if_none_match=etag)
        if fetched.status == "not_modified":
            return done("unchanged")
        if fetched.status == "not_found":
            return done("nothing_promoted")
        if fetched.status in ("unauthorized", "forbidden"):
            refuse(fetched.status, None)
            return done("unavailable", reason=fetched.status)
        if fetched.status == "error":
            return done("unavailable", reason=f"http_{fetched.http_status}")

        manifest = fetched.manifest or {}
        generation = manifest["payload"]["generation"]
        stored = store.state["generation"]
        envelope = verify_manifest(manifest=manifest, root=root, now=at, scope=scope, stored_generation=stored, payloads=None, countersign_root=countersign_root, require_countersign=require_countersign)
        if not envelope.ok:
            refuse(envelope.reason or "signature_invalid", generation)
            return done("refused", reason=envelope.reason, generation=generation)
        # The signature verified and the generation is not a rollback: its directives stand from here on.
        if on_directives:
            on_directives(manifest["payload"])
        if generation == stored:
            return done("unchanged", next_etag=fetched.etag)
        held_back_below = store.state.get("heldBackBelow")
        if held_back_below is not None and generation <= held_back_below:
            # A local rollback stepped down from this generation on purpose; only a newer one ends the hold.
            return done("held_back", next_etag=fetched.etag, generation=generation)
        # T15: a required model this runtime cannot call refuses the release here — verified, never fetched, never staged.
        missing_models = required_models_missing(manifest["payload"], catalog)
        if missing_models:
            if on_model_unavailable:
                on_model_unavailable(missing_models, generation)
            refuse("model_unavailable", generation)
            return done("refused", reason="model_unavailable", next_etag=fetched.etag, generation=generation)

        # Fetch only what moved; the bytes already verified in the active slot are reused for unchanged hashes.
        payloads: dict[str, bytes] = {}
        for content_hash in referenced_payloads(manifest["payload"]):
            held = active.payloads.get(content_hash) if active else None
            if held is not None:
                payloads[content_hash] = held
                continue
            data = client.payload(content_hash)
            if data is None:
                refuse("payload_missing", generation)
                return done("refused", reason="payload_missing", generation=generation)
            payloads[content_hash] = data
        full = verify_manifest(manifest=manifest, root=root, now=at, scope=scope, stored_generation=stored, payloads=payloads, countersign_root=countersign_root, require_countersign=require_countersign)
        if not full.ok:
            refuse(full.reason or "signature_invalid", generation)
            return done("refused", reason=full.reason, generation=generation)

        # All-or-nothing: the current slot stays whole until the new one is complete and fsynced.
        store.stage(manifest=manifest, payloads=payloads)
        decision = apply_policy(manifest)
        if decision == "staged":
            return done("staged", next_etag=fetched.etag, generation=generation)
        # The hook activated it itself: the caller's active slot already moved; nothing here to load.
        if decision == "activated_externally":
            return done("activated_externally", next_etag=fetched.etag, generation=generation)
        slot = store.activate()
        loaded = store.load(slot, now=at, root=root, countersign_root=countersign_root, require_countersign=require_countersign)
        return done("activated", active_slot=loaded, next_etag=fetched.etag, generation=generation)
    except Exception as error:  # noqa: BLE001 — a sync pass never raises past its caller
        refuse(f"network:{error}", None)
        return done("unavailable", reason="network")


def jittered_delay_ms(base_seconds: float, rand: Callable[[], float] = random.random) -> int:
    """±20 %: a fleet restarted together must not poll together."""
    jitter = (rand() * 2 - 1) * 0.2
    return max(1000, int(round(base_seconds * 1000 * (1 + jitter))))
