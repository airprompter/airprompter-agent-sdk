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

0.3.5 (pins.md): a pass carrying ``pin`` fetches CONTENT from the named seal
instead of the pointer's manifest, while control (directives, lease,
countersign) keeps coming from the live manifest, returned as
``SyncPassOutput.live_control``. See ``_sync_pinned`` below.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional, Sequence

from airprompter_agent_core.protocol.trust import experiments_of, referenced_payloads, verify_manifest, verify_root_metadata
from ..store.slot_store import LoadedSlot, SlotStore
from airprompter_agent_core.control.client import SyncClient

#: ``activated_externally``: the customer's hook (or an operator) already made the staged release live during the decision.
ApplyPolicyDecision = str  # "activated" | "staged" | "activated_externally"


@dataclass
class PinRequest:
    #: As given to ``start(release=...)`` or ``pin()`` — a seal id (12 hex) or a full release digest.
    release: str


@dataclass
class LiveControl:
    #: Verified for signature/scope only, never staged, its payloads never fetched, its models never checked.
    manifest: Mapping[str, Any]
    etag: Optional[str]


@dataclass
class SyncPassOutput:
    #: ``pointer_unchanged``: the unsigned edge pointer said nothing moved — silence, not contact (S3).
    #: ``unchanged``: the origin's authenticated 304, or a signed manifest at the generation already held — contact.
    #: ``pinned_unchanged`` (0.3.5): pinned to a release, and the pinned envelope answered is what this pass already
    #: holds — distinct from ``pointer_unchanged`` because a pinned read always contacts the origin.
    outcome: str  # "pointer_unchanged" | "unchanged" | "pinned_unchanged" | "activated" | "activated_externally" | "staged" | "refused" | "unavailable" | "nothing_promoted" | "held_back"
    etag: Optional[str]
    edge_etag: Optional[str]
    trusted_root: Mapping[str, Any]
    active: Optional[LoadedSlot]
    generation: Optional[int] = None
    reason: Optional[str] = None
    #: The control plane's own word for a `forbidden`/`refused_seal` answer, or the transport error for `network`.
    detail: Optional[str] = None
    #: 0.3.5: set only on a pinned pass that also read the live manifest (after a successful pinned activation, or
    #: when the edge pointer moved since the last pass).
    live_control: Optional[LiveControl] = None


def required_models_missing(payload: Mapping[str, Any], catalog: Optional[Sequence[str]]) -> list[str]:
    """The required models of a payload (its slots and every arm override) the declared catalog lacks; empty when nothing was declared."""
    if catalog is None:
        return []
    declared = set(catalog)
    slots = list(payload.get("slots", []))
    for experiment in experiments_of(payload):
        for arm in experiment.get("arms", []):
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
    pin: Optional[PinRequest] = None,
    live_etag: Optional[str] = None,
    rebase: bool = False,
) -> SyncPassOutput:
    """``on_directives`` (T9) is called with every manifest whose envelope verifies BEFORE the pass decides whether to
    stage, hold back or ignore it — so a ``disable`` (Freeze) or a ``request_unlock``/``request_resync`` rides a
    manifest the runtime would otherwise leave staged or unchanged. Never a manifest that failed the trust chain.

    ``pin`` (0.3.5, pins.md): pin the CONTENT this pass fetches and stages to one named seal, while control keeps
    coming from the live manifest fetched by ``_sync_pinned`` and returned as ``live_control``. ``live_etag`` is the
    etag of the last LIVE manifest this pass (or a previous one) fetched, for ``If-None-Match`` on the live read;
    ignored when ``pin`` is unset. ``rebase`` (0.3.5): the caller just unpinned — this (unpinned) pass's
    anti-rollback is scoped to the pointer's own generation instead of the store's counter, and forces the stage
    past it exactly once when the pointer's release sits below what the store holds (pins.md › unpinning
    re-bases). Ignored when ``pin`` is set."""
    at = now()
    root = trusted_root
    current_edge_etag = edge_etag

    def done(outcome: str, *, active_slot: Optional[LoadedSlot] = active, next_etag: Optional[str] = etag, generation: Optional[int] = None, reason: Optional[str] = None, detail: Optional[str] = None, live_control: Optional[LiveControl] = None) -> SyncPassOutput:
        return SyncPassOutput(outcome, next_etag, current_edge_etag, root, active_slot, generation, reason, detail, live_control)

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

        # 0.3.5 (pins.md): a pinned pass fetches CONTENT from the named seal, never the pointer — a separate branch,
        # because the edge pointer's silence must never decide pinned content (only whether the live manifest is
        # also re-read) and the anti-rollback scope is the pinned envelope's own generation, not the store's counter.
        if pin is not None:
            return _sync_pinned(
                store=store, client=client, scope=scope, active=active, etag=etag, apply_policy=apply_policy, edge_pointer_url=edge_pointer_url, edge_etag=current_edge_etag,
                require_countersign=require_countersign, countersign_root=countersign_root, on_refusal=on_refusal, catalog=catalog, on_model_unavailable=on_model_unavailable,
                pin=pin, live_etag=live_etag, now_value=at, trusted_root=root,
            )

        # Idle path: the edge pointer says whether anything moved, without a Lambda on the other end. It is unsigned and
        # cacheable, so its silence is never contact (S3): the lease does not move on ``pointer_unchanged``. Skipped on
        # a rebase pass (0.3.5, right after ``unpin()``): the edge pointer's cached etag may not have moved even
        # though what this runtime holds (a pinned release) is nowhere near the pointer's generation — the first
        # unpinned pass after unpinning always goes to the signed manifest.
        if edge_pointer_url and not skip_pointer and not rebase:
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
            return done("unavailable", reason=fetched.status, detail=fetched.code if fetched.status == "forbidden" and fetched.code else None)
        if fetched.status == "error":
            return done("unavailable", reason=f"http_{fetched.http_status}")
        # Never actually reached: an unpinned pass never sends `release`, so the platform never answers
        # `refused_seal` here (only `_sync_pinned` below, which passes `release`, sees this branch). Handled for
        # exhaustiveness.
        if fetched.status == "refused_seal":
            return done("unavailable", reason="network", detail=f"unexpected refused_seal: {fetched.code}")

        manifest = fetched.manifest or {}
        generation = manifest["payload"]["generation"]
        stored = store.state["generation"]
        # 0.3.5 (pins.md): the first pass after `unpin()` re-bases to the pointer — a pinned envelope may have been
        # older than the store's generation (forced past it), so the pointer's own release must never be seen as a
        # rollback merely because the pin outran it. `rebase` is consumed here, once, by whichever pass sees it first.
        envelope = verify_manifest(manifest=manifest, root=root, now=at, scope=scope, stored_generation=0 if rebase else stored, payloads=None, countersign_root=countersign_root, require_countersign=require_countersign)
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
        full = verify_manifest(manifest=manifest, root=root, now=at, scope=scope, stored_generation=0 if rebase else stored, payloads=payloads, countersign_root=countersign_root, require_countersign=require_countersign)
        if not full.ok:
            refuse(full.reason or "signature_invalid", generation)
            return done("refused", reason=full.reason, generation=generation)

        # All-or-nothing: the current slot stays whole until the new one is complete and fsynced.
        store.stage(manifest=manifest, payloads=payloads, force=bool(rebase and generation < stored))
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
        return done("unavailable", reason="network", detail=str(error)[:240])


def _sync_pinned(
    *,
    store: SlotStore,
    client: SyncClient,
    scope: Mapping[str, str],
    active: Optional[LoadedSlot],
    etag: Optional[str],
    apply_policy: Callable[[Mapping[str, Any]], ApplyPolicyDecision],
    edge_pointer_url: Optional[str],
    edge_etag: Optional[str],
    require_countersign: Optional[bool],
    countersign_root: Optional[Mapping[str, Any]],
    on_refusal: Optional[Callable[[str, Optional[int]], None]],
    catalog: Optional[Sequence[str]],
    on_model_unavailable: Optional[Callable[[list[str], int], None]],
    pin: PinRequest,
    live_etag: Optional[str],
    now_value: str,
    trusted_root: Mapping[str, Any],
) -> SyncPassOutput:
    """0.3.5 (pins.md): the pinned half of a pass. Fetches ``?release=<pin.release>`` instead of the pointer's
    manifest, verifies and stages it (forcing past the store's own generation counter only when the pinned envelope
    is older — "pinned envelopes may be older"), then — after a successful activation, or when the edge pointer
    moved since the last pass — reads the LIVE manifest (verified for signature/scope only, never staged) so the
    caller can adopt its directives, lease and countersign requirement as ``live_control``. When ``edge_pointer_url``
    is absent there is no pointer whose silence can ever report "moved", so every pinned pass treats itself as
    moved and re-reads the live manifest — otherwise a pinned runtime with no pointer configured would go deaf to
    live control (a ``disable``/Freeze directive, a lease change, a countersign requirement) forever after its
    first activation. The live read still sends ``If-None-Match: live_etag``, so this costs one 304 per quiet tick
    — the same price the unpinned path already pays with no pointer."""
    current_edge_etag = edge_etag
    # No pointer configured: there is nothing whose silence could ever flip this to true, so every pinned pass
    # must re-read the live manifest itself below — otherwise a pinned runtime with no `edge_pointer_url` would
    # never again see live control (directives/lease/countersign) after its first activation.
    pointer_moved = edge_pointer_url is None
    if edge_pointer_url:
        edge = client.edge_pointer(edge_pointer_url, current_edge_etag)
        # The pointer's silence (`not_modified`) never decides pinned content and is not itself "moved" — only a new
        # etag counts, and only for whether the live manifest is also re-read below.
        if edge.status == "ok":
            pointer_moved = edge.etag != current_edge_etag
            current_edge_etag = edge.etag

    def done(outcome: str, *, active_slot: Optional[LoadedSlot] = active, next_etag: Optional[str] = etag, generation: Optional[int] = None, reason: Optional[str] = None, detail: Optional[str] = None, live_control: Optional[LiveControl] = None) -> SyncPassOutput:
        return SyncPassOutput(outcome, next_etag, current_edge_etag, trusted_root, active_slot, generation, reason, detail, live_control)

    def refuse(reason: str, generation: Optional[int]) -> None:
        if on_refusal:
            on_refusal(reason, generation)

    def with_live_control(base: SyncPassOutput) -> SyncPassOutput:
        activated = base.outcome in ("activated", "activated_externally")
        if not activated and not pointer_moved:
            return base
        live_fetched = client.manifest(if_none_match=live_etag)
        if live_fetched.status != "ok":
            return base  # 304, refused, or unavailable: keep whatever control the caller already adopted.
        live_verdict = verify_manifest(
            manifest=live_fetched.manifest,
            root=base.trusted_root,
            now=now_value,
            scope=scope,
            # Signature/scope only — not compared against a stored generation counter, the way the trust chain's
            # anti-rollback normally is: the live manifest is never staged, so there is nothing here to protect.
            stored_generation=0,
            payloads=None,
            countersign_root=countersign_root,
            require_countersign=require_countersign,
        )
        if not live_verdict.ok:
            refuse(live_verdict.reason or "signature_invalid", live_fetched.manifest["payload"]["generation"])
            return base
        base.live_control = LiveControl(manifest=live_fetched.manifest, etag=live_fetched.etag)
        return base

    fetched = client.manifest(if_none_match=etag, release=pin.release)
    if fetched.status == "not_modified":
        return with_live_control(done("pinned_unchanged"))
    if fetched.status == "refused_seal":
        refuse(fetched.code, None)
        return with_live_control(done("refused", reason=fetched.code, detail=",".join(fetched.matches) if fetched.matches else None))
    if fetched.status == "not_found":
        return with_live_control(done("nothing_promoted"))
    if fetched.status in ("unauthorized", "forbidden"):
        refuse(fetched.status, None)
        return with_live_control(done("unavailable", reason=fetched.status, detail=fetched.code if fetched.status == "forbidden" and fetched.code else None))
    if fetched.status == "error":
        return with_live_control(done("unavailable", reason=f"http_{fetched.http_status}"))

    manifest = fetched.manifest or {}
    # Pinned envelopes may be older than whatever this runtime last held (unpinned, or a different pin): the trust
    # chain's M-check is bypassed here (stored_generation=0) rather than refusing an older pinned generation before
    # it is even staged — `store.stage()`'s own `force` below is the one real gate, against the STORE's counter.
    envelope = verify_manifest(manifest=manifest, root=trusted_root, now=now_value, scope=scope, stored_generation=0, payloads=None, countersign_root=countersign_root, require_countersign=require_countersign)
    if not envelope.ok:
        refuse(envelope.reason or "signature_invalid", manifest["payload"]["generation"])
        return with_live_control(done("refused", reason=envelope.reason, generation=manifest["payload"]["generation"]))
    generation = manifest["payload"]["generation"]
    # "Unchanged" for a pinned pass: this pass answered the same generation already held for THIS pin (the active
    # release, while pinned — never the store's counter, which may belong to a different, earlier pin or an
    # unpinned release).
    if active and generation == active.generation:
        return with_live_control(done("pinned_unchanged", active_slot=active, next_etag=fetched.etag))

    missing_models = required_models_missing(manifest["payload"], catalog)
    if missing_models:
        if on_model_unavailable:
            on_model_unavailable(missing_models, generation)
        refuse("model_unavailable", generation)
        return with_live_control(done("refused", reason="model_unavailable", generation=generation, active_slot=active, next_etag=fetched.etag))

    payloads: dict[str, bytes] = {}
    for content_hash in referenced_payloads(manifest["payload"]):
        held = active.payloads.get(content_hash) if active else None
        if held is not None:
            payloads[content_hash] = held
            continue
        data = client.payload(content_hash)
        if data is None:
            refuse("payload_missing", generation)
            return with_live_control(done("refused", reason="payload_missing", generation=generation))
        payloads[content_hash] = data
    full = verify_manifest(manifest=manifest, root=trusted_root, now=now_value, scope=scope, stored_generation=0, payloads=payloads, countersign_root=countersign_root, require_countersign=require_countersign)
    if not full.ok:
        refuse(full.reason or "signature_invalid", generation)
        return with_live_control(done("refused", reason=full.reason, generation=generation))

    # "Pinned envelopes may be older": force past the STORE's own generation counter only when this pinned
    # generation sits below it — the store records `forcedDowngrade` exactly as an operator's local rollback does.
    force_stage = generation < store.state["generation"]
    store.stage(manifest=manifest, payloads=payloads, force=force_stage)
    decision = apply_policy(manifest)
    if decision == "staged":
        return with_live_control(done("staged", generation=generation, active_slot=active, next_etag=fetched.etag))
    if decision == "activated_externally":
        return with_live_control(done("activated_externally", generation=generation, active_slot=active, next_etag=fetched.etag))
    slot = store.activate()
    loaded = store.load(slot, now=now_value, root=trusted_root, countersign_root=countersign_root, require_countersign=require_countersign)
    return with_live_control(done("activated", generation=generation, active_slot=loaded, next_etag=fetched.etag))


def jittered_delay_ms(base_seconds: float, rand: Callable[[], float] = random.random) -> int:
    """±20 %: a fleet restarted together must not poll together."""
    jitter = (rand() * 2 - 1) * 0.2
    return max(1000, int(round(base_seconds * 1000 * (1 + jitter))))
