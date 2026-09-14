"""A bundle the customer loads, as a ``ReleaseReader`` (S10): ``airprompter_agent_runtime`` on its own — no store, no
daemon, no network — renders and assigns over it. The same chain as OTA runs before a byte is served: the bundle's key
set must descend from the pinned root (or be it), and the manifest's signatures, scope, expiry and every payload hash
must verify. There is no anti-rollback here because there is no stored generation; that is the slot store's rule
(``airprompter_agent_sync``)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Optional

from ..bundle.apbundle import BundleError, DistributionKey, bundle_payload_bytes, open_bundle
from ..protocol.trust import verify_manifest, verify_root_metadata


@dataclass(frozen=True)
class _Loaded:
    manifest: Mapping[str, Any]
    generation: int
    payloads: Mapping[str, bytes]


class BundleReleaseRefused(Exception):
    """A bundle refused before it became a release: the bundle itself (``bundle_*``) or the chain (a refusal code)."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class BundleRelease:
    kind = "bundle"

    def __init__(self, release: _Loaded, key_set: Mapping[str, Any], not_after: str):
        self._release = release
        #: The key set the bundle carried, once it verified against the pinned root: what a host pins next.
        self.key_set = key_set
        self.not_after = not_after

    @classmethod
    def load(
        cls,
        *,
        bundle: Mapping[str, Any],
        root: Mapping[str, Any],
        scope: Mapping[str, str],
        now: str,
        distribution_key: Optional[DistributionKey] = None,
        countersign_root: Optional[Mapping[str, Any]] = None,
        require_countersign: Optional[bool] = None,
    ) -> "BundleRelease":
        """Open, verify, and hold; raises ``BundleReleaseRefused`` naming the first rule the bundle failed."""
        try:
            contents = open_bundle(bundle, {"agentId": scope["agentId"], "target": scope["target"]}, distribution_key)
        except BundleError as error:
            raise BundleReleaseRefused(f"bundle_{error.code}") from error
        except (KeyError, TypeError, ValueError) as error:
            raise BundleReleaseRefused("bundle_malformed") from error
        trusted = root
        if verify_root_metadata(candidate=contents["keySet"], trusted=trusted, now=now).ok:
            trusted = contents["keySet"]
        payloads = bundle_payload_bytes(contents)
        verdict = verify_manifest(
            manifest=contents["manifest"],
            root=trusted,
            now=now,
            scope=scope,
            stored_generation=0,
            payloads=payloads,
            countersign_root=countersign_root,
            require_countersign=require_countersign,
        )
        if not verdict.ok:
            raise BundleReleaseRefused(str(verdict.reason))
        return cls(_Loaded(manifest=contents["manifest"], generation=int(verdict.generation or contents["manifest"]["payload"]["generation"]), payloads=payloads), trusted, str(contents["notAfter"]))

    def current(self) -> _Loaded:
        return self._release
