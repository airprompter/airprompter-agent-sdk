"""One pull, no store: fetch the release promoted to a target, run the whole verification chain, and hand back an
``.apbundle`` — the artifact a fleet carries through its own store (a database row, an object, a config entry) to
runtimes that never hold an Agent key. ``airprompter pull`` is this function with files around it; a puller job is
this function with a database around it. The bundle is sealed to the fleet's distribution key unless the caller asks
for plaintext, which only the dev target permits."""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Mapping, Optional

from airprompter_agent_core.bundle.apbundle import create_encrypted_bundle, create_plaintext_bundle
from airprompter_agent_core.control.client import SyncClient
from airprompter_agent_core.protocol.trust import referenced_payloads, verify_manifest, verify_root_metadata


@dataclass
class PullBundleResult:
    status: str  # "ok" | "nothing_promoted" | "refused" | "unavailable"
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
) -> PullBundleResult:
    """``distribution_public_key``: the fleet's X25519 public key (32 raw bytes) the bundle is sealed to; ``None`` writes
    plaintext, allowed for the dev target only. ``fetch_root``: the environment's root document — a pinned key alone
    names the ROOT, not the signing keys under it, so without it every manifest refuses ``unknown_signing_key`` unless
    ``trusted_root`` is already a full document. ``minimum_generation``: the newest generation the caller already holds;
    an older answer is reported as ``generation_rollback`` instead of becoming a quiet extra row."""
    at = now()
    if distribution_public_key is None and scope["target"] != "dev":
        return PullBundleResult(status="refused", reason="plaintext_not_allowed")
    if not (0 < not_after_days <= 365):
        raise ValueError("not_after_days must be a positive number of days, 365 at most")
    root = trusted_root
    try:
        if fetch_root is not None:
            candidate = fetch_root()
            if candidate is not None:
                verdict = verify_root_metadata(candidate=candidate, trusted=root, now=at)
                # A root that does not descend from the trusted one is the finding, not a detail behind unknown_signing_key.
                if not verdict.ok:
                    return PullBundleResult(status="refused", reason="root_refused", detail=verdict.reason)
                root = candidate
        fetched = client.manifest()
        if fetched.status == "not_found":
            return PullBundleResult(status="nothing_promoted")
        if fetched.status == "unauthorized":
            return PullBundleResult(status="unavailable", reason="unauthorized")
        if fetched.status == "forbidden":
            return PullBundleResult(status="unavailable", reason="forbidden", detail=fetched.code)
        if fetched.status == "error":
            return PullBundleResult(status="unavailable", reason=f"http_{fetched.http_status}")
        if fetched.status == "not_modified":
            return PullBundleResult(status="unavailable", reason="http_304")
        manifest = fetched.manifest
        assert manifest is not None
        if int(manifest["payload"]["generation"]) < minimum_generation:
            return PullBundleResult(status="refused", reason="generation_rollback", detail=f"the control plane answered generation {manifest['payload']['generation']}; the caller holds {minimum_generation}", held=minimum_generation)

        payloads: dict[str, bytes] = {}
        for content_hash, byte_length in referenced_payloads(manifest["payload"]).items():
            data = client.payload(content_hash)
            if data is None:
                return PullBundleResult(status="refused", reason="payload_missing", content_hash=content_hash)
            if len(data) != byte_length:
                return PullBundleResult(status="refused", reason="payload_length_mismatch", content_hash=content_hash)
            payloads[content_hash] = data
        # No stored generation here: a puller has no host to move backwards. Anti-rollback is the store's rule, applied
        # by every runtime that opens this bundle.
        verdict = verify_manifest(manifest=manifest, root=root, now=at, scope=scope, stored_generation=0, payloads=payloads, countersign_root=countersign_root, require_countersign=require_countersign)
        if not verdict.ok:
            return PullBundleResult(status="refused", reason=verdict.reason)

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
        )
    except Exception as error:  # noqa: BLE001 — a puller reports, it does not crash the job
        return PullBundleResult(status="unavailable", reason="network", detail=str(error))
