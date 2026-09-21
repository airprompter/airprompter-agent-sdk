"""The customer's own copy of a release (``protocol/pins.md`` › "Customer-store seal"): a :class:`MirrorPort` the
application supplies (a config row, a database, a file in its own deploy), the seal recomputed against it each
tick with core's ``verify_seal``, and the render path that reads from it once it is written. The runtime never
overwrites the customer's copy on its own initiative — only :class:`AirPrompterAgent`'s materialise rule (a copy
that is ``None``, or intact for the release this SDK itself last wrote) and ``resync(approved_by=...)`` write to
it; a broken copy is reported, never repaired behind the application's back.

Example::

    mirror = Mirror(port)
    mirror.refresh()   # read into cache; an exception propagates so the caller can log mirror_unreadable and leave the cache as it was
    if mirror.copy is None:
        mirror.materialise(release)   # write once, cache it
    report = mirror.compute_report(release, now)   # SealReport(seal_id, observed_digest, intact, checked_at, broken_at?, changed_tags?)
    slot = mirror.slot_for("support.triage")   # reads from the cached copy, not the store
"""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Optional, Protocol

from airprompter_agent_core.protocol.seal import seal_id_of, verify_seal
from airprompter_agent_core.release.reader import LoadedRelease


@dataclass
class MirrorCopy:
    """What the customer's store holds against the seal it was written from (pins.md): the pins verbatim, and
    every text they reference, base64url by ``contentHash``."""

    seal_id: str
    pins: list[dict]
    texts: dict[str, str]

    def to_json(self) -> dict[str, Any]:
        return {"sealId": self.seal_id, "pins": self.pins, "texts": self.texts}

    @staticmethod
    def from_json(data: Mapping[str, Any]) -> "MirrorCopy":
        return MirrorCopy(seal_id=data["sealId"], pins=list(data["pins"]), texts=dict(data["texts"]))


class MirrorPort(Protocol):
    """The seam to the application's own store. ``read()`` returns ``None`` when nothing has been written yet (or
    the store was reset); an exception is the application's own failure to reach its store, never a seal break.
    ``write()`` is called only by ``Mirror.materialise`` / ``Mirror.resync``, orchestrated by
    :class:`AirPrompterAgent` — never on a schedule, never because a heartbeat round trip suggested it (pins.md).
    ``on_resync_requested`` is informational: the runtime never re-materialises on its own when a
    ``request_resync`` directive arrives, it only calls this hook."""

    def read(self) -> Optional[MirrorCopy]: ...

    def write(self, copy: MirrorCopy) -> None: ...

    def on_resync_requested(self, request: Mapping[str, Any]) -> None: ...


@dataclass
class SealReport:
    """The result of the last recomputation (pins.md ``seal`` heartbeat member), content-free."""

    seal_id: str
    observed_digest: str
    intact: bool
    checked_at: str
    #: The instance's own first observation of a broken store; held across re-checks (never moved) until it heals.
    broken_at: Optional[str] = None
    #: Sorted, deduped, never text — ``None`` (never an empty list) once every pin re-hashes and re-projects clean.
    changed_tags: Optional[list[str]] = None

    def to_wire(self) -> dict[str, Any]:
        """The camelCase heartbeat member: ``brokenAt`` only when set, ``changedTags`` only when non-empty."""
        out: dict[str, Any] = {"sealId": self.seal_id, "observedDigest": self.observed_digest, "intact": self.intact, "checkedAt": self.checked_at}
        if self.broken_at is not None:
            out["brokenAt"] = self.broken_at
        if self.changed_tags:
            out["changedTags"] = self.changed_tags
        return out


def copy_from_release(release: LoadedRelease) -> MirrorCopy:
    """The mirror copy this SDK itself would write for a release: every slot pin verbatim, every text it
    references, base64url."""
    pins = list(release.manifest["payload"]["slots"])
    texts: dict[str, str] = {}

    def take(content_hash: str) -> None:
        data = release.payloads.get(content_hash)
        if data is not None:
            texts[content_hash] = base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")

    for slot in pins:
        take(slot["contentHash"])
        for step in slot.get("steps") or []:
            take(step["contentHash"])
    return MirrorCopy(seal_id=seal_id_of(release.manifest["payload"]["releaseDigest"]), pins=pins, texts=texts)


def seal_for_heartbeat(report: SealReport) -> SealReport:
    """protocol/schemas/heartbeat.schema.json caps ``seal.changedTags`` at 64 items — a strict schema, so one
    oversize array refuses the WHOLE heartbeat, not just that field. ``changed_tags`` is already sorted, so the cut
    is deterministic; the log event (``seal_broken``) is never touched by this — only the wire body is capped. The
    "absent, never empty" rule is unaffected: a report with no ``changed_tags`` still has none here."""
    if not report.changed_tags or len(report.changed_tags) <= 64:
        return report
    return SealReport(seal_id=report.seal_id, observed_digest=report.observed_digest, intact=report.intact, checked_at=report.checked_at, broken_at=report.broken_at, changed_tags=report.changed_tags[:64])


def seal_of(release: LoadedRelease, copy: MirrorCopy, now: str, previous: Optional[SealReport]) -> SealReport:
    """Recompute the seal of ``copy`` against ``release``'s own pins (pins.md). ``previous`` carries ``broken_at``
    forward while the same release is still broken — a re-check never moves the instance's own first-observation
    timestamp — and drops it once the copy heals (no ``broken_at`` on an intact report)."""
    seal_id = seal_id_of(release.manifest["payload"]["releaseDigest"])
    result = verify_seal(seal_id=seal_id, sealed_pins=list(release.manifest["payload"]["slots"]), pins=copy.pins, texts=copy.texts)
    carried_broken_at = previous.broken_at if (previous and previous.seal_id == seal_id and not previous.intact) else None
    return SealReport(
        seal_id=seal_id,
        observed_digest=result.observed_digest,
        intact=result.intact,
        checked_at=now,
        broken_at=(carried_broken_at or now) if not result.intact else None,
        changed_tags=list(result.changed_tags) if result.changed_tags else None,
    )


class Mirror:
    """The port, the cached copy and the last report, together — :class:`AirPrompterAgent` only orchestrates WHEN
    to ``refresh`` / ``materialise`` / ``resync`` (the rule in ``mirror()``'s doc comment); this class owns HOW."""

    def __init__(self, port: MirrorPort):
        self._port = port
        self._cached_copy: Optional[MirrorCopy] = None
        self._last_report: Optional[SealReport] = None

    @property
    def copy(self) -> Optional[MirrorCopy]:
        """The cached copy from the last successful ``refresh``/``materialise``/``resync``; ``None`` before any of
        them ran, or after a ``read()`` that answered ``None``."""
        return self._cached_copy

    @property
    def last_computed_report(self) -> Optional[SealReport]:
        """The last computed report, or ``None`` before ``compute_report`` has run once."""
        return self._last_report

    def refresh(self) -> None:
        """Read the application's store and cache it. Propagates whatever ``port.read()`` raises — the cache stays
        whatever it was, so the caller (the agent) can log ``mirror_unreadable`` and fall back without losing a
        good copy."""
        self._cached_copy = self._port.read()

    def materialise(self, release: LoadedRelease) -> MirrorCopy:
        """Write this SDK's own copy of ``release`` and cache it — the ONLY two writers of the customer's store
        (with ``resync``), both called by the agent, never by a timer."""
        copy = copy_from_release(release)
        self._port.write(copy)
        self._cached_copy = copy
        return copy

    def resync(self, release: LoadedRelease, now: str) -> SealReport:
        """``ap.mirror(port).resync(approved_by=...)``: re-materialise deliberately (a broken copy, or an
        application's own re-sync hook answering a ``request_resync``) and report the healed state. ``approved_by``
        is logged by the caller, never here — this class carries no prompt text or identifiers past what it is
        handed."""
        copy = self.materialise(release)
        report = seal_of(release, copy, now, None)
        self._last_report = report
        return report

    def compute_report(self, release: LoadedRelease, now: str) -> Optional[SealReport]:
        """Recompute the seal of the cached copy against ``release`` and remember the report (for ``broken_at``
        carry-over next time). ``None`` when nothing is cached yet."""
        if self._cached_copy is None:
            return None
        report = seal_of(release, self._cached_copy, now, self._last_report)
        self._last_report = report
        return report

    def copy_is_self_consistent(self) -> bool:
        """The restart rule's one home (F6): whether the cached copy is internally consistent — its texts still
        hash to its own pins, and its pins' digest still matches the ``seal_id`` it carries — with no reference to
        whatever release is active right now. ``_mirror_materialised_for`` (the in-process "this SDK wrote it"
        memory) does not survive a restart, so after one, a copy this SDK genuinely wrote for release N is
        indistinguishable from any other copy by that fact alone; but a copy nobody has tampered with since IT was
        written verifies against ITSELF regardless of which release is active. ``False`` when nothing is cached
        yet."""
        if self._cached_copy is None:
            return False
        return verify_seal(seal_id=self._cached_copy.seal_id, sealed_pins=self._cached_copy.pins, pins=self._cached_copy.pins, texts=self._cached_copy.texts).intact

    def slot_for(self, tag: str) -> Optional[dict]:
        """A pin from the cached copy — the render source when a mirror is registered and readable. ``None``
        before any copy is cached."""
        if self._cached_copy is None:
            return None
        return next((pin for pin in self._cached_copy.pins if pin.get("tag") == tag), None)

    def text_for(self, content_hash: str) -> Optional[bytes]:
        """A text from the cached copy, decoded — ``None`` when the copy holds no text for that hash (a break the
        seal already names)."""
        if self._cached_copy is None:
            return None
        encoded = self._cached_copy.texts.get(content_hash)
        if encoded is None:
            return None
        padded = encoded + "=" * (-len(encoded) % 4)
        return base64.urlsafe_b64decode(padded)

    def notify_resync_requested(self, request: Mapping[str, Any]) -> None:
        """``request_resync`` (pins.md): informational only — hands the directive to the application's own hook,
        never writes anything itself."""
        hook: Optional[Callable[[Mapping[str, Any]], None]] = getattr(self._port, "on_resync_requested", None)
        if hook is not None:
            hook(request)
