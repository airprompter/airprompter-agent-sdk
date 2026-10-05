"""Sticky assignment (``protocol/assignment-hash.md``): SHA-256(salt ‖ subject), first 8 bytes big-endian mod 10000, cumulative weights.

Example::

    arms = [{"arm": "a", "weightBps": 9000}, {"arm": "b", "weightBps": 1000}]   # weights sum to 10000
    assignment = assign_arm(salt=experiment["salt"], subject="user-42", arms=arms)
    assignment.arm["arm"], assignment.bucket   # ("a", 3729) — the same subject lands here on every host
    effective_arms(arms=arms, ramp=experiment.get("ramp"), disabled_arms=["b"], now_ms=now_ms)   # b's share goes to the control
    ordered_steps("onboarding.flow", slot["steps"])   # the steps sorted by ordinal (ids onboarding.flow#1, #2, …), or StepError
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Any, Mapping, Sequence, TypeVar

from .._util import b64url_decode, instant

ASSIGNMENT_MODULUS = 10000
#: S9: ramp steps are at least this far apart, and at most this many.
RAMP_MIN_STEP_MS = 60 * 60 * 1000
RAMP_MAX_STEPS = 8
_MIN_SALT_BYTES = 16
_SALT = re.compile(r"^[A-Za-z0-9_-]+$")
_SLOT_TAG = re.compile(r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$")

A = TypeVar("A", bound=Mapping[str, Any])


class AssignmentError(ValueError):
    def __init__(self, reason: str):  # "salt_invalid" | "too_few_arms" | "weight_invalid" | "weights_not_10000" | "ramp_invalid"
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


# ---------------------------------------------------------------------------
# S9: the signed ramp plan (assignment-hash.md › The ramp plan)
# ---------------------------------------------------------------------------


def _instant(text: Any) -> int:
    if not isinstance(text, str):
        raise AssignmentError("ramp_invalid")
    try:
        return instant(text)
    except Exception as error:  # noqa: BLE001
        raise AssignmentError("ramp_invalid") from error


def validate_ramp(ramp: Any, arm_count: int) -> None:
    """The plan's shape: 1–8 steps, strictly increasing, ≥ 1 h apart, one integer weight per arm each summing to 10000."""
    if ramp is None:
        return
    if not isinstance(ramp, list) or len(ramp) < 1 or len(ramp) > RAMP_MAX_STEPS:
        raise AssignmentError("ramp_invalid")
    previous = None
    for step in ramp:
        if not isinstance(step, Mapping) or not isinstance(step.get("weightBps"), list):
            raise AssignmentError("ramp_invalid")
        at = _instant(step.get("notBefore"))
        if previous is not None and at - previous < RAMP_MIN_STEP_MS:
            raise AssignmentError("ramp_invalid")
        previous = at
        weights = step["weightBps"]
        if len(weights) != arm_count:
            raise AssignmentError("ramp_invalid")
        total = 0
        for weight in weights:
            if not isinstance(weight, int) or isinstance(weight, bool) or weight < 0:
                raise AssignmentError("ramp_invalid")
            total += weight
        if total != ASSIGNMENT_MODULUS:
            raise AssignmentError("ramp_invalid")


def ramp_weights_at(arms: Sequence[Mapping[str, Any]], ramp: Any, now_ms: float) -> list[int]:
    """The weights in force at ``now_ms``: the last step whose ``notBefore`` has passed (inclusive), else the arms' own."""
    weights = [int(arm["weightBps"]) for arm in arms]
    for step in ramp or []:
        if _instant(step.get("notBefore")) <= now_ms:
            weights = [int(w) for w in step["weightBps"]]
    return weights


def effective_arms(*, arms: Sequence[A], ramp: Any = None, disabled_arms: Any = None, now_ms: float) -> list[dict[str, Any]] | None:
    """The arms as they stand at ``now_ms``: the plan's weights, then any disabled arm's share handed to the first arm in manifest
    order that is not disabled (the control). Every arm disabled is the caller's agent-level refusal (None)."""
    weights = ramp_weights_at(arms, ramp, now_ms)
    disabled = set(disabled_arms or ())
    first_live = next((i for i, arm in enumerate(arms) if arm["arm"] not in disabled), -1)
    if first_live == -1:
        return None
    reassigned = 0
    effective: list[dict[str, Any]] = []
    for index, arm in enumerate(arms):
        if arm["arm"] in disabled:
            reassigned += weights[index]
            effective.append({**arm, "weightBps": 0})
        else:
            effective.append({**arm, "weightBps": weights[index]})
    effective[first_live] = {**effective[first_live], "weightBps": effective[first_live]["weightBps"] + reassigned}
    return effective


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

# 1.0.0: one exact local audience model; no matching function returns or logs values.
AUDIENCE_CAPABILITY = "audience_v1"
AUDIENCE_PROTOCOL_VERSION = "1.0.0"

def _audience_string(value: Any, limit: int) -> bool:
    return isinstance(value, str) and len(value.encode("utf-16-le", errors="surrogatepass")) // 2 <= limit and not re.search(r"[\x00-\x1f\x7f]", value)

def valid_audience_key(value: Any) -> bool:
    return _audience_string(value, 64) and bool(value.strip())

def valid_audience_ids(value: Any) -> bool:
    return isinstance(value, (list, tuple)) and len(value) <= 8 and all(isinstance(v, str) and re.fullmatch(r"aud_[A-Za-z0-9_-]{22}", v) and (i == 0 or value[i-1] < v) for i, v in enumerate(value))

def valid_audience_selector(value: Any) -> bool:
    if not isinstance(value, Mapping): return False
    if value.get("mode") == "all": return set(value) == {"mode"}
    if value.get("mode") != "tags" or set(value) != {"mode", "match", "conditions"} or value.get("match") not in ("all", "any"): return False
    conditions = value.get("conditions")
    if not isinstance(conditions, list) or not 1 <= len(conditions) <= 16: return False
    pairs, keys = set(), set()
    for c in conditions:
        if not isinstance(c, Mapping) or set(c) != {"key", "value"} or not valid_audience_key(c["key"]) or not _audience_string(c["value"], 256): return False
        pair = (c["key"], c["value"])
        if pair in pairs or (value["match"] == "all" and c["key"] in keys): return False
        pairs.add(pair); keys.add(c["key"])
    return True

def matches_audience(selector: Mapping[str, Any], tags: Mapping[str, str]) -> bool:
    """Invalid/missing values never broaden targeting. Exact means no Unicode normalization or trimming."""
    if not valid_audience_selector(selector): return False
    if selector["mode"] == "all": return True
    matched = [c["key"] in tags and isinstance(tags[c["key"]], str) and tags[c["key"]] == c["value"] for c in selector["conditions"]]
    return all(matched) if selector["match"] == "all" else any(matched)

def copy_audience_tags(tags: Mapping[str, str]) -> Mapping[str, str]:
    from types import MappingProxyType
    if not isinstance(tags, Mapping) or len(tags) > 64 or any(not valid_audience_key(k) or not _audience_string(v, 256) for k,v in tags.items()): raise ValueError("audience_tags_invalid")
    return MappingProxyType(dict(tags))

def valid_audience_manifest(p: Mapping[str, Any]) -> bool:
    """Refuse unsupported/malformed audience wires before payload application; legacy stays supported."""
    experiments = p.get("experiments", [])
    if not isinstance(experiments, list) or any(not isinstance(e, Mapping) for e in experiments): return False
    legacy = p.get("experiment")
    targeted = "requiredCapabilities" in p or "observations" in p or any("audience" in e for e in experiments) or (isinstance(legacy, Mapping) and "audience" in legacy)
    if not targeted: return True
    observations = p.get("observations")
    if p.get("protocol") != AUDIENCE_PROTOCOL_VERSION or p.get("requiredCapabilities") != [AUDIENCE_CAPABILITY] or "experiment" in p or not isinstance(observations, list) or not 1 <= len(observations) <= 8 or not isinstance(p.get("slots"), list) or len(experiments) > 32: return False
    ids = set()
    for o in observations:
        if not isinstance(o, Mapping) or set(o) != {"audienceId","selector","tag","observeFrom"} or not valid_audience_ids([o.get("audienceId")]) or not valid_audience_selector(o.get("selector")) or o["audienceId"] in ids or not any(isinstance(s,Mapping) and s.get("tag") == o["tag"] for s in p["slots"]): return False
        try:
            if not isinstance(o["observeFrom"], str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})", o["observeFrom"]): return False
            instant(o["observeFrom"])
        except (ValueError, TypeError): return False
        ids.add(o["audienceId"])
    for e in experiments:
        a = e.get("audience")
        if not isinstance(a, Mapping) or set(a) != {"audienceId","selector"} or not valid_audience_selector(a.get("selector")): return False
        o = next((o for o in observations if o["audienceId"] == a["audienceId"] and o["tag"] == e.get("tag")), None)
        arms = e.get("arms")
        if o is None or o["selector"] != a["selector"] or not isinstance(arms,list) or not 2 <= len(arms) <= 8: return False
        if any(not isinstance(arm,Mapping) or type(arm.get("weightBps")) is not int or not 0 <= arm["weightBps"] <= 10000 or not isinstance(arm.get("arm"),str) or not re.fullmatch(r"[a-z0-9]+(?:[._-][a-z0-9]+)*",arm["arm"]) or len(arm["arm"]) > 32 or not isinstance(arm.get("overrides"),list) for arm in arms): return False
        if sum(arm["weightBps"] for arm in arms) != 10000 or len({arm["arm"] for arm in arms}) != len(arms) or arms[0].get("releaseDigest") != p.get("releaseDigest") or arms[0]["overrides"]: return False
        if any(len(arm["overrides"]) > 1 or any(not isinstance(pin,Mapping) or pin.get("tag") != e.get("tag") for pin in arm["overrides"]) for arm in arms): return False
    return True

def captured_audience_ids(observations: Sequence[Mapping[str, Any]], tag: str, tags: Mapping[str,str], now_ms: float) -> tuple[str, ...]:
    return tuple(sorted(o["audienceId"] for o in observations if o["tag"] == tag and instant(o["observeFrom"]) <= now_ms and matches_audience(o["selector"], tags)))
