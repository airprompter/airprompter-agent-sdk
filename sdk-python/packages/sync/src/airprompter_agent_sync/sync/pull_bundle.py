"""One pull, no store: fetch the release promoted to a target, run the whole verification chain, and hand back an
``.apbundle`` — the artifact a fleet carries through its own store (a database row, an object, a config entry) to
runtimes that never hold an Agent key. ``airprompter pull`` is this function with files around it; a puller job is
this function with a database around it. The bundle is sealed to the fleet's distribution key unless the caller asks
for plaintext, which only the dev target permits.

The cheap path: the control plane names an edge pointer (a few hundred bytes behind a CDN, ``generation.json``) in
its manifest answer; a puller that hands back ``edge`` from the last result reads the pointer first — a 304, or a
generation it already holds, means nothing moved and the origin is never called. Only a moved pointer (or none known)
reaches the API, and that read is conditional too. Steady state costs a CDN 304 per interval, not an API request;
``next_pull_delay_ms`` stretches the interval while nothing changes."""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Mapping, Optional

from airprompter_agent_core.bundle.apbundle import create_encrypted_bundle, create_plaintext_bundle
from airprompter_agent_core.control.client import SyncClient
from airprompter_agent_core.protocol.trust import referenced_payloads, verify_manifest, verify_root_metadata


DEFAULT_MAX_POINTER_AGE_MS = 60 * 60 * 1000


@dataclass
class PullEdgeState:
    """The puller's memory between pulls: content-free. Persist it WITH the row it was returned beside (the same
    transaction), never before it — a saved ``manifest_etag`` for a row that was never written makes the next origin
    read a 304 and the row is never written."""

    pointer_url: Optional[str] = None
    pointer_etag: Optional[str] = None
    manifest_etag: Optional[str] = None
    #: When the origin last answered (ISO); the pointer is trusted to say "nothing moved" only for ``max_pointer_age_ms`` after it.
    last_origin_at: Optional[str] = None


def next_pull_delay_ms(*, outcome: str, unchanged_streak: int, interval_ms: int, cap_ms: int = 5 * 60 * 1000) -> int:
    """How long to wait before the next pull: the interval while things change, doubling while nothing does, never past
    ``cap_ms``; back to the interval on any change, refusal or outage — those are what a puller is for."""
    if outcome != "unchanged":
        return interval_ms
    stretched = interval_ms * 2 ** min(unchanged_streak, 20)
    return min(max(interval_ms, stretched), max(cap_ms, interval_ms))


@dataclass
class PullBundleResult:
    status: str  # "ok" | "unchanged" | "nothing_promoted" | "refused" | "unavailable"
    #: For "unchanged": "pointer" (a CDN read, no origin call) or "origin" (the API's 304).
    via: Optional[str] = None
    #: Hand this back as ``edge`` on the next pull.
    edge: PullEdgeState = field(default_factory=PullEdgeState)
    bundle: Optional[dict[str, Any]] = None
    manifest: Optional[dict[str, Any]] = None
    generation: Optional[int] = None
    release_digest: Optional[str] = None
    created_at: Optional[str] = None
    not_after: Optional[str] = None
    trusted_root: Optional[Mapping[str, Any]] = None
    reason: Optional[str] = None
    content_hash: Optional[str] = None
    detail: Optional[str] = None
    held: Optional[int] = None
    extra: dict[str, Any] = field(default_factory=dict)


def _age_ms(now_iso: str, then_iso: Optional[str]) -> float:
    if not then_iso:
        return float("inf")
    try:
        now_dt = datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
        then_dt = datetime.fromisoformat(then_iso.replace("Z", "+00:00"))
        return (now_dt - then_dt).total_seconds() * 1000
    except ValueError:
        return float("inf")


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def pull_bundle(
    *,
    client: SyncClient,
    scope: Mapping[str, str],
    trusted_root: Mapping[str, Any],
    now: Callable[[], str],
    distribution_public_key: Optional[bytes],
    fetch_root: Optional[Callable[[], Optional[Mapping[str, Any]]]] = None,
    minimum_generation: int = 0,
    not_after_days: float = 90,
    countersign_root: Optional[Mapping[str, Any]] = None,
    require_countersign: Optional[bool] = None,
    edge: Optional[PullEdgeState] = None,
    skip_pointer: bool = False,
    max_pointer_age_ms: int = DEFAULT_MAX_POINTER_AGE_MS,
) -> PullBundleResult:
    """``distribution_public_key``: the fleet's X25519 public key (32 raw bytes) the bundle is sealed to; ``None`` writes
    plaintext, allowed for the dev target only. ``fetch_root``: the environment's root document — a pinned key alone
    names the ROOT, not the signing keys under it, so without it every manifest refuses ``unknown_signing_key`` unless
    ``trusted_root`` is already a full document. ``minimum_generation``: the newest generation the caller already holds;
    an older answer is reported as ``generation_rollback`` instead of becoming a quiet extra row. ``edge``: what the last
    result handed back (the pointer URL the control plane named and the ETags); ``skip_pointer``: a nudge said "check
    now" — read the origin, conditionally."""
    at = now()
    # What the caller handed back is returned unchanged on every failure: an ETag advanced past an answer the origin
    # never confirmed would make the next pull a 304 and hide the promotion until the one after it.
    given = PullEdgeState(edge.pointer_url, edge.pointer_etag, edge.manifest_etag, edge.last_origin_at) if edge else PullEdgeState()
    state = PullEdgeState(given.pointer_url, given.pointer_etag, given.manifest_etag, given.last_origin_at)
    if distribution_public_key is None and scope["target"] != "dev":
        return PullBundleResult(status="refused", reason="plaintext_not_allowed", edge=given)
    if not (0 < not_after_days <= 365):
        raise ValueError("not_after_days must be a positive number of days, 365 at most")
    root = trusted_root
    try:
        # The pointer first: unsigned and cacheable, it can only say "nothing moved" — never extend trust. A 304, or a
        # generation the caller already holds, ends the pull at the CDN. Anything else (moved, unknown, unreachable,
        # malformed) goes on to the origin — and so does a pointer that has said "nothing moved" for longer than
        # ``max_pointer_age_ms``, the bound on a stuck one.
        origin_age_ms = _age_ms(at, given.last_origin_at)
        pointer_etag: Optional[str] = None
        pointer_answered = False
        if given.pointer_url and not skip_pointer and origin_age_ms <= max_pointer_age_ms:
            try:
                pointer = client.edge_pointer(given.pointer_url, given.pointer_etag)
                if pointer.status == "not_modified":
                    return PullBundleResult(status="unchanged", via="pointer", edge=given)
                if pointer.status == "ok":
                    pointer_etag, pointer_answered = pointer.etag, True
                    generation = (pointer.pointer or {}).get("generation") if isinstance(pointer.pointer, Mapping) else None
                    if minimum_generation > 0 and isinstance(generation, int) and generation <= minimum_generation:
                        return PullBundleResult(status="unchanged", via="pointer", edge=PullEdgeState(given.pointer_url, pointer.etag, given.manifest_etag, given.last_origin_at))
            except Exception:  # noqa: BLE001 — a CDN outage or a malformed pointer is not an answer: the origin is asked
                pass
        if fetch_root is not None:
            candidate = fetch_root()
            if candidate is not None:
                verdict = verify_root_metadata(candidate=candidate, trusted=root, now=at)
                # A root that does not descend from the trusted one is the finding, not a detail behind unknown_signing_key.
                if not verdict.ok:
                    return PullBundleResult(status="refused", reason="root_refused", detail=verdict.reason, edge=given)
                root = candidate
        # Conditional: the origin answers 304 to the ETag it last gave, and names the pointer either way.
        fetched = client.manifest(if_none_match=given.manifest_etag)
        if fetched.status == "not_found":
            return PullBundleResult(status="nothing_promoted", edge=given)
        if fetched.status == "unauthorized":
            return PullBundleResult(status="unavailable", reason="unauthorized", edge=given)
        if fetched.status == "forbidden":
            return PullBundleResult(status="unavailable", reason="forbidden", detail=fetched.code, edge=given)
        if fetched.status == "error":
            return PullBundleResult(status="unavailable", reason=f"http_{fetched.http_status}", edge=given)
        # The origin answered: the pointer it names, the ETag it moved to, and the moment — the pointer's trust starts here.
        if fetched.edge_pointer_url:
            state.pointer_url = fetched.edge_pointer_url
        if pointer_answered:
            state.pointer_etag = pointer_etag
        state.last_origin_at = at
        if fetched.status == "not_modified":
            return PullBundleResult(status="unchanged", via="origin", edge=state)
        manifest = fetched.manifest
        assert manifest is not None
        if int(manifest["payload"]["generation"]) < minimum_generation:
            return PullBundleResult(status="refused", reason="generation_rollback", detail=f"the control plane answered generation {manifest['payload']['generation']}; the caller holds {minimum_generation}", held=minimum_generation, edge=given)

        payloads: dict[str, bytes] = {}
        for content_hash, byte_length in referenced_payloads(manifest["payload"]).items():
            data = client.payload(content_hash)
            if data is None:
                return PullBundleResult(status="refused", reason="payload_missing", content_hash=content_hash, edge=given)
            if len(data) != byte_length:
                return PullBundleResult(status="refused", reason="payload_length_mismatch", content_hash=content_hash, edge=given)
            payloads[content_hash] = data
        # No stored generation here: a puller has no host to move backwards. Anti-rollback is the store's rule, applied
        # by every runtime that opens this bundle.
        verdict = verify_manifest(manifest=manifest, root=root, now=at, scope=scope, stored_generation=0, payloads=payloads, countersign_root=countersign_root, require_countersign=require_countersign)
        if not verdict.ok:
            return PullBundleResult(status="refused", reason=verdict.reason, edge=given)
        # The bundle is built: the manifest's ETag is the caller's to keep — with the row, never before it.
        state.manifest_etag = fetched.etag

        not_after = _iso(datetime.fromisoformat(at.replace("Z", "+00:00")) + timedelta(days=not_after_days))
        contents = {
            "createdAt": at,
            "notAfter": not_after,
            "manifest": manifest,
            "keySet": root,
            "payloads": [{"contentHash": h, "byteLength": len(b), "bytes": base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")} for h, b in payloads.items()],
        }
        bundle = create_encrypted_bundle(contents, distribution_public_key) if distribution_public_key is not None else create_plaintext_bundle(contents)
        return PullBundleResult(
            status="ok",
            bundle=bundle,
            manifest=manifest,
            generation=int(manifest["payload"]["generation"]),
            release_digest=str(manifest["payload"]["releaseDigest"]),
            created_at=at,
            not_after=not_after,
            trusted_root=root,
            edge=state,
        )
    except Exception as error:  # noqa: BLE001 — a puller reports, it does not crash the job
        return PullBundleResult(status="unavailable", reason="network", detail=str(error), edge=given)
