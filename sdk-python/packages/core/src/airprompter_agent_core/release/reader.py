"""The seam between the packages (S10): a verified release as a runtime consumes it, and where one comes from.
``airprompter_agent_sync`` produces a ``LoadedRelease`` from the encrypted slot store or a daemon (its ``LoadedSlot``
is one); ``airprompter_agent_core`` produces one from a bundle the customer loads (``BundleRelease``);
``airprompter_agent_runtime`` renders and assigns over either without knowing which. Structural (a ``Protocol``),
never a class to ``isinstance``: two copies of a package in one environment must agree on it (S1).

Example::

    release = reader.current()   # a store, a daemon or a bundle: the runtime does not know which
    if release is not None:
        slot = release.manifest["payload"]["slots"][0]
        text = release.payloads[slot["contentHash"]].decode("utf-8")
        resolved = ReleaseSlot(slot, arm="none", bucket=None)   # what the resolver hands to render()
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Optional, Protocol, runtime_checkable


@runtime_checkable
class LoadedRelease(Protocol):
    """A verified release: the manifest, its generation, and the verified payload bytes by content hash."""

    manifest: Mapping[str, Any]
    generation: int
    payloads: Mapping[str, bytes]


class ReleaseReader(Protocol):
    """Where a runtime reads releases from: the slot store, a daemon, or a bundle the customer loaded."""

    #: What the reader is, as data — never branch on a class: "store" | "daemon" | "bundle".
    kind: str

    def current(self) -> Optional[LoadedRelease]:
        """The release in force, or None when nothing verified is held."""
        ...


@dataclass(frozen=True)
class ReleaseSlot:
    """One slot of a release as the runtime resolves it: the manifest slot, and the arm and bucket the subject fell in."""

    slot: Mapping[str, Any]
    arm: str
    bucket: Optional[int]
