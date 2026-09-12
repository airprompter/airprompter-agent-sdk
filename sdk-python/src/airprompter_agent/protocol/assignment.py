"""Sticky assignment (``protocol/assignment-hash.md``): SHA-256(salt ‖ subject), first 8 bytes big-endian mod 10000, cumulative weights."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Any, Mapping, Sequence, TypeVar

from .._util import b64url_decode

ASSIGNMENT_MODULUS = 10000
_MIN_SALT_BYTES = 16
_SALT = re.compile(r"^[A-Za-z0-9_-]+$")
_SLOT_TAG = re.compile(r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$")

A = TypeVar("A", bound=Mapping[str, Any])


class AssignmentError(ValueError):
    def __init__(self, reason: str):  # "salt_invalid" | "too_few_arms" | "weight_invalid" | "weights_not_10000"
        super().__init__(reason)
        self.reason = reason


def validate_arms(arms: Sequence[Mapping[str, Any]]) -> None:
    if len(arms) < 2:
        raise AssignmentError("too_few_arms")
    total = 0
    for arm in arms:
        weight = arm.get("weightBps")
        if isinstance(weight, bool) or not isinstance(weight, int) or weight < 0:
            raise AssignmentError("weight_invalid")
        total += weight
    if total != ASSIGNMENT_MODULUS:
        raise AssignmentError("weights_not_10000")


def subject_hash(salt: str, subject: str) -> str:
    if not _SALT.match(salt):
        raise AssignmentError("salt_invalid")
    salt_bytes = b64url_decode(salt)
    if len(salt_bytes) < _MIN_SALT_BYTES:
        raise AssignmentError("salt_invalid")
    return hashlib.sha256(salt_bytes + subject.encode("utf-8")).hexdigest()


def bucket_from_hash(hex_digest: str) -> int:
    return int(hex_digest[:16], 16) % ASSIGNMENT_MODULUS


def arm_for_bucket(bucket: int, arms: Sequence[A]) -> A:
    cumulative = 0
    for arm in arms:
        cumulative += arm["weightBps"]
        if bucket < cumulative:
            return arm
    return arms[-1]


@dataclass(frozen=True)
class Assignment:
    subject_hash: str
    bucket: int
    arm: Mapping[str, Any]


def assign_arm(*, salt: str, subject: str, arms: Sequence[A]) -> Assignment:
    validate_arms(arms)
    digest = subject_hash(salt, subject)
    bucket = bucket_from_hash(digest)
    return Assignment(subject_hash=digest, bucket=bucket, arm=arm_for_bucket(bucket, arms))


class StepError(ValueError):
    def __init__(self, reason: str):  # "slot_tag_grammar" | "step_ordinal_gap" | "step_tag_mismatch"
        super().__init__(reason)
        self.reason = reason


def ordered_steps(slot_tag: str, steps: Sequence[A]) -> list[A]:
    """Workflow steps: 1-based, contiguous, tagged ``<tag>#<ordinal>``; yielded in ordinal order."""
    if not _SLOT_TAG.match(slot_tag):
        raise StepError("slot_tag_grammar")
    ordered = sorted(steps, key=lambda step: step["ordinal"])
    for index, step in enumerate(ordered):
        if step["ordinal"] != index + 1:
            raise StepError("step_ordinal_gap")
        if step["stepId"] != f"{slot_tag}#{step['ordinal']}":
            raise StepError("step_tag_mismatch")
    return ordered
