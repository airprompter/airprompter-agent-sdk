"""The pin sidecar and the "content pinned, control live" merge (``protocol/pins.md``). A pin names one sealed
release; ``store.json`` and ``store.schema.json`` stay format 2 (``additionalProperties: false``) so the pin never
rides inside them — it lives beside the store, in its own file, written with the same temp-file + fsync + rename
discipline :class:`~airprompter_agent_sync.store.slot_store.SlotStore` uses for its own files
(:mod:`airprompter_agent_sync.store.atomic`). ``merge_live_control`` is the other half of the contract: while
pinned, a runtime renders the pinned envelope's slots but keeps obeying the live manifest's directives, lease and
countersign requirement — this function is the one place that rule is expressed.

Example::

    write_pin_file(state_dir, agent_id, target, PinFile(version=1, release="a3a20ff4f7fb", pinned_at=now, by="sdk"))
    pin = read_pin_file(state_dir, agent_id, target)   # None when never pinned, or after clear_pin_file
    view = merge_live_control(pinned_manifest, live_manifest)   # content from pinned_manifest, control from live_manifest
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any, Literal, Mapping, Optional

from ..store.atomic import write_file_atomically


@dataclass
class PinFile:
    version: Literal[1]
    #: As given to ``start(release=...)`` or ``pin()`` — a seal id (12 hex) or a full release digest.
    release: str
    pinned_at: str
    by: Literal["sdk", "cli"]

    def to_json(self) -> dict[str, Any]:
        return {"version": self.version, "release": self.release, "pinnedAt": self.pinned_at, "by": self.by}

    @staticmethod
    def from_json(data: Mapping[str, Any]) -> Optional["PinFile"]:
        version = data.get("version")
        release = data.get("release")
        pinned_at = data.get("pinnedAt")
        by = data.get("by")
        if version != 1 or not isinstance(release, str) or not release or not isinstance(pinned_at, str) or by not in ("sdk", "cli"):
            return None
        return PinFile(version=1, release=release, pinned_at=pinned_at, by=by)


def _pin_path(state_dir: str, agent_id: str, target: str) -> str:
    return os.path.join(state_dir, "airprompter", agent_id, target, "pin.json")


def read_pin_file(fs: Any, state_dir: str, agent_id: str, target: str) -> Optional[PinFile]:
    """``None`` when this target has never been pinned, or after :func:`clear_pin_file`. A file this reader cannot
    parse is treated as absent — never a boot failure. ``fs`` is accepted for parity with the TypeScript signature
    (an ``FsPort``) but this implementation reads the path directly, as :class:`SlotStore` does."""
    path = _pin_path(state_dir, agent_id, target)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "rb") as f:
            parsed = json.loads(f.read().decode("utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    return PinFile.from_json(parsed)


def write_pin_file(fs: Any, state_dir: str, agent_id: str, target: str, pin: PinFile) -> None:
    directory = os.path.join(state_dir, "airprompter", agent_id, target)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    write_file_atomically(_pin_path(state_dir, agent_id, target), json.dumps(pin.to_json(), indent=2).encode("utf-8"))


def clear_pin_file(fs: Any, state_dir: str, agent_id: str, target: str) -> None:
    """``unpin()``: the pin file is removed so the next boot resumes unpinned. Never raises when there was nothing
    to remove."""
    try:
        os.remove(_pin_path(state_dir, agent_id, target))
    except FileNotFoundError:
        pass


def merge_live_control(pinned: Mapping[str, Any], live: Mapping[str, Any]) -> dict[str, Any]:
    """"Content pinned, control live" (pins.md): the returned manifest is ``pinned`` with its control members —
    ``directives``, ``leaseSeconds``, ``onLeaseExpiry``, ``requireCountersign``, ``unlockWindow`` — replaced by
    ``live``'s. ``generation``, ``slots``, ``experiment(s)`` and ``releaseDigest`` stay the pinned envelope's own:
    pinning is a statement about slots, not about the release identity or the generation counter a pinned reader
    tracks (pins.md › "Content pinned, control live", scoping anti-rollback to the pinned envelope's own
    generation). The result is a VIEW for control decisions only — its signature is ``pinned``'s, over ``pinned``'s
    own payload, so this merged payload must never be re-verified or written to the store as if it were a signed
    envelope."""
    # Drop the pinned envelope's own unlockWindow first: control is live's, so a pinned envelope that carried one
    # must not leak past a live manifest that no longer has one (or never had one).
    pinned_payload_rest = {k: v for k, v in pinned["payload"].items() if k != "unlockWindow"}
    payload = {
        **pinned_payload_rest,
        "directives": live["payload"]["directives"],
        "leaseSeconds": live["payload"]["leaseSeconds"],
        "onLeaseExpiry": live["payload"]["onLeaseExpiry"],
        "requireCountersign": live["payload"]["requireCountersign"],
    }
    if "unlockWindow" in live["payload"]:
        payload["unlockWindow"] = live["payload"]["unlockWindow"]
    return {**pinned, "payload": payload}
