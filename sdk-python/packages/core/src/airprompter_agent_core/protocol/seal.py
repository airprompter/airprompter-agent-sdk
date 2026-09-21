"""The customer-store seal (``protocol/pins.md``): recompute what a customer-held copy of a release proves against
the pins it was sealed with, and the short id a release digest goes by in a pin. A faithful port of
``conformance/reference.mjs``'s ``verifySeal`` over this package's own canonical JSON and digest projection
(``release_digest_input`` / ``release_digest`` in ``.trust``) — never a re-derivation of the projection, so the two
never drift.

Example::

    seal_id = seal_id_of(release["payload"]["releaseDigest"])   # "a3a20ff4f7fb"
    verdict = verify_seal(seal_id=seal_id, sealed_pins=release["payload"]["slots"], pins=mirror.pins, texts=mirror.texts)
    if not verdict.intact:
        report(seal_id=seal_id, observed_digest=verdict.observed_digest, intact=False, checked_at=now, changed_tags=verdict.changed_tags)
"""

from __future__ import annotations

import base64
import re
from dataclasses import dataclass
from typing import Any, Mapping

from .canonical_json import canonical_json, sha256_prefixed
from .trust import inference_digest_input, release_digest, release_digest_input

_RELEASE_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


def seal_id_of(release_digest: str) -> str:
    """The first 12 hex characters after ``sha256:`` in a release digest (pins.md). Raises ``ValueError`` on
    anything that is not a ``sha256:`` + 64 hex digest."""
    if not _RELEASE_DIGEST.match(release_digest):
        raise ValueError(f"seal_id_of: not a release digest: {release_digest}")
    return release_digest[7:19]


@dataclass(frozen=True)
class SealVerdict:
    observed_digest: str
    intact: bool
    #: Sorted, deduped, never text: a slot by ``tag``, or a workflow step by its ``stepId``.
    changed_tags: list[str]


def verify_seal(*, seal_id: str, sealed_pins: list[dict], pins: list[dict], texts: dict[str, str]) -> SealVerdict:
    """Recompute the seal (pins.md › "Customer-store seal"): every pin's (and, for a workflow, every step's) text is
    rehashed against ``texts``; a missing or mismatching text substitutes the rehashed value before the digest is
    recomputed. Per-tag attribution goes further than the text: every pin's and step's full digest projection
    (``release_digest_input`` — model, settings, variables, checks, golden set) is diffed between the sealed and the
    (rehashed) observed copy, so a settings-only drift is named by its tag too, not just a text tamper."""
    changed: set[str] = set()

    def rehash(content_hash: str, tag: str) -> str:
        encoded = texts.get(content_hash)
        if encoded is None:
            changed.add(tag)
            return content_hash
        # base64url, padding optional.
        padded = encoded + "=" * (-len(encoded) % 4)
        raw = base64.urlsafe_b64decode(padded)
        rehashed = sha256_prefixed(raw)
        if rehashed != content_hash:
            changed.add(tag)
            return rehashed
        return content_hash

    def observe_pin(pin: Mapping[str, Any]) -> dict[str, Any]:
        observed = dict(pin)
        observed["contentHash"] = rehash(pin["contentHash"], pin["tag"])
        steps = pin.get("steps")
        if steps is not None:
            observed["steps"] = [{**step, "contentHash": rehash(step["contentHash"], step["stepId"])} for step in steps]
        return observed

    observed_pins = [observe_pin(pin) for pin in pins]
    observed_digest = release_digest(observed_pins)

    def pin_projection(pin: Mapping[str, Any]) -> str:
        return canonical_json(release_digest_input([pin])[0])

    def without_steps(pin: Mapping[str, Any]) -> dict[str, Any]:
        return {k: v for k, v in pin.items() if k != "steps"}

    def step_digest_projection(step: Mapping[str, Any]) -> dict[str, Any]:
        """A workflow step's own digest projection — the same fields ``release_digest_input``'s ``steps`` mapping
        builds inline (trust.py has no standalone export for one step, only for a whole slot's ``steps`` array),
        reusing its ``inference_digest_input`` so a step's settings are never re-derived here."""
        out: dict[str, Any] = {
            "stepId": step["stepId"],
            "ordinal": step["ordinal"],
            "promptArtifactId": step["promptArtifactId"],
            "promptVersionId": step["promptVersionId"],
            "contentHash": step["contentHash"],
            "byteLength": step["byteLength"],
        }
        inference = step.get("inference")
        if inference is not None:
            out["inference"] = inference_digest_input(inference)
        return out

    sealed_by_tag = {p["tag"]: p for p in sealed_pins}
    observed_by_tag = {p["tag"]: p for p in observed_pins}
    all_tags = set(sealed_by_tag.keys()) | set(observed_by_tag.keys())
    for tag in all_tags:
        sealed_pin = sealed_by_tag.get(tag)
        observed_pin = observed_by_tag.get(tag)
        # (d) a tag present on only one side.
        if sealed_pin is None or observed_pin is None:
            changed.add(tag)
            continue
        is_workflow = sealed_pin.get("steps") is not None or observed_pin.get("steps") is not None
        if not is_workflow:
            # (b) a prompt pin: compare its full digest projection.
            if pin_projection(sealed_pin) != pin_projection(observed_pin):
                changed.add(tag)
            continue
        # (c) a workflow pin: compare with steps removed, then each step by stepId.
        if pin_projection(without_steps(sealed_pin)) != pin_projection(without_steps(observed_pin)):
            changed.add(tag)
        sealed_steps = {s["stepId"]: s for s in sealed_pin.get("steps") or []}
        observed_steps = {s["stepId"]: s for s in observed_pin.get("steps") or []}
        all_step_ids = set(sealed_steps.keys()) | set(observed_steps.keys())
        for step_id in all_step_ids:
            sealed_step = sealed_steps.get(step_id)
            observed_step = observed_steps.get(step_id)
            if sealed_step is None or observed_step is None:
                changed.add(step_id)
                continue
            if canonical_json(step_digest_projection(sealed_step)) != canonical_json(step_digest_projection(observed_step)):
                changed.add(step_id)

    changed_tags = sorted(changed)
    short_id_matches = observed_digest[7:19] == seal_id
    intact = len(changed_tags) == 0 and observed_digest == release_digest(sealed_pins) and short_id_matches
    return SealVerdict(observed_digest=observed_digest, intact=intact, changed_tags=changed_tags)
