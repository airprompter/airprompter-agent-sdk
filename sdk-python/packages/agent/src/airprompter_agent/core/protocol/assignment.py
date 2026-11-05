"""Sticky assignment (``protocol/assignment-hash.md``): SHA-256(salt ‖ subject), first 8 bytes big-endian mod 10000, cumulative weights.

Example::

    arms = [{"arm": "a", "weightBps": 9000}, {"arm": "b", "weightBps": 1000}]   # weights sum to 10000
    assignment = assign_arm(salt=experiment["salt"], subject="user-42", arms=arms)
    assignment.arm["arm"], assignment.bucket   # ("a", 3729) — the same subject lands here on every host
    effective_arms(arms=arms, ramp=experiment.get("ramp"), disabled_arms=["b"], now_ms=now_ms)   # b's share goes to the control
    ordered_steps("onboarding.flow", slot["steps"])   # the steps sorted by ordinal (ids onboarding.flow#1, #2, …), or StepError
    matches_audience({"mode": "when", "when": {"key": "plan", "in": ["team", "business"]}}, {"plan": "team"})   # True, evaluated locally
    servable_slots(payload)   # the slots this SDK can serve: a slot with an unmet ``requires`` is absent
    servable_overrides(arm)   # the same for one arm: only the unmet override goes
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from typing import Callable, Any, Mapping, Sequence, TypeVar

from .._util import b64url_decode, instant
from .canonical_json import MAX_SAFE_INTEGER
from .capabilities import SUPPORTED_CAPABILITIES

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

# Audience targeting (``protocol/audiences.md``): a condition tree evaluated locally. Values never leave this process.
#: A leaf alone is depth 1; each ``all``, ``any`` or ``not`` adds one.
AUDIENCE_LIMITS = {"maxDepth": 4, "maxLeaves": 32, "maxGroupItems": 16, "maxInValues": 64}
ECMASCRIPT_TRIM = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_AUDIENCE_DECIMAL = re.compile(r"-?[0-9]+(?:\.[0-9]+)?")
_ARM_NAME = re.compile(r"[a-z0-9]+(?:[._-][a-z0-9]+)*")
_AUDIENCE_MINUTE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z", re.ASCII)


def _audience_string(value: Any, limit: int) -> bool:
    """Length counts code points. A lone surrogate (JSON can spell one, UTF-8 cannot carry it) is refused."""
    return isinstance(value, str) and len(value) <= limit and not re.search(r"[\x00-\x1f\x7f]", value) and not any(0xD800 <= ord(char) <= 0xDFFF for char in value)

def valid_audience_key(value: Any) -> bool:
    return _audience_string(value, 64) and bool(value.strip(ECMASCRIPT_TRIM))

def valid_audience_label(value: Any) -> bool:
    return _audience_string(value, 128) and bool(value.strip(ECMASCRIPT_TRIM))

def valid_audience_instant(value: Any) -> bool:
    """Strict RFC 3339 instant parity with JavaScript Date parsing."""
    if not isinstance(value, str): return False
    match = re.fullmatch(r"(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))", value, re.ASCII)
    if not match or int(match.group(1)) == 0: return False
    if match.group(3) is not None and (int(match.group(3)) > 23 or int(match.group(4)) > 59): return False
    try:
        instant(value)
        return True
    except (ValueError, TypeError, OverflowError):
        return False

def valid_audience_minute(value: Any) -> bool:
    return isinstance(value, str) and _AUDIENCE_MINUTE.fullmatch(value) is not None and valid_audience_instant(value)

def valid_audience_ids(value: Any) -> bool:
    return isinstance(value, (list, tuple)) and len(value) <= 8 and all(isinstance(v, str) and re.fullmatch(r"aud_[A-Za-z0-9_-]{22}", v) and (i == 0 or value[i-1] < v) for i, v in enumerate(value))

def _finite_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)): return False
    try:
        return math.isfinite(value)
    except OverflowError:  # an integer past every double: JavaScript reads it as Infinity
        return False

def _safe_integer(value: Any) -> bool:
    return _finite_number(value) and value == int(value) and abs(value) <= MAX_SAFE_INTEGER

def _valid_condition(condition: Any, depth: int, leaves: list[int]) -> bool:
    if not isinstance(condition, Mapping) or depth > AUDIENCE_LIMITS["maxDepth"]: return False
    names = list(condition)
    if len(names) == 1 and names[0] in ("all", "any"):
        items = condition[names[0]]
        return isinstance(items, list) and 1 <= len(items) <= AUDIENCE_LIMITS["maxGroupItems"] and all(_valid_condition(item, depth + 1, leaves) for item in items)
    if names == ["not"]: return _valid_condition(condition["not"], depth + 1, leaves)
    if len(names) != 2 or not valid_audience_key(condition.get("key")): return False
    leaves[0] += 1
    if "is" in condition: return _audience_string(condition["is"], 256)
    if "contains" in condition: return _audience_string(condition["contains"], 256) and len(condition["contains"]) > 0
    if "in" in condition:
        values = condition["in"]
        return isinstance(values, list) and 1 <= len(values) <= AUDIENCE_LIMITS["maxInValues"] and all(_audience_string(value, 256) for value in values) and len(set(values)) == len(values)
    bounds = condition.get("range")
    if not isinstance(bounds, Mapping) or not 1 <= len(bounds) <= 2 or not set(bounds) <= {"gte", "lt"}: return False
    return all(_safe_integer(bound) for bound in bounds.values())

def valid_audience_selector(value: Any) -> bool:
    if not isinstance(value, Mapping): return False
    if value.get("mode") == "all": return set(value) == {"mode"}
    if value.get("mode") != "when" or not set(value) <= {"mode", "when"}: return False
    leaves = [0]
    return _valid_condition(value.get("when"), 1, leaves) and leaves[0] <= AUDIENCE_LIMITS["maxLeaves"]

def _condition_matches(condition: Mapping[str, Any], tags: Mapping[str, str]) -> bool:
    if "all" in condition: return all(_condition_matches(item, tags) for item in condition["all"])
    if "any" in condition: return any(_condition_matches(item, tags) for item in condition["any"])
    if "not" in condition: return not _condition_matches(condition["not"], tags)
    # A missing key is false for every leaf.
    key = condition["key"]
    if key not in tags or not _audience_string(tags[key], 256): return False
    value = tags[key]
    if "is" in condition: return value == condition["is"]
    if "contains" in condition: return condition["contains"] in value
    if "in" in condition: return value in condition["in"]
    if not _AUDIENCE_DECIMAL.fullmatch(value): return False
    number = float(value)
    bounds = condition["range"]
    return math.isfinite(number) and ("gte" not in bounds or number >= float(bounds["gte"])) and ("lt" not in bounds or number < float(bounds["lt"]))

def matches_audience(selector: Mapping[str, Any], tags: Mapping[str, str]) -> bool:
    """Invalid/missing values never broaden targeting. Exact means no Unicode normalization or trimming."""
    if not valid_audience_selector(selector): return False
    return selector["mode"] == "all" or _condition_matches(selector["when"], tags)

def copy_audience_tags(tags: Mapping[str, str]) -> Mapping[str, str]:
    from types import MappingProxyType
    if not isinstance(tags, Mapping) or len(tags) > 64 or any(not valid_audience_key(k) or not _audience_string(v, 256) for k,v in tags.items()): raise ValueError("audience_tags_invalid")
    return MappingProxyType(dict(tags))

def _capabilities_met(entry: Mapping[str, Any]) -> bool:
    if "requires" not in entry: return True
    names = entry["requires"]
    return isinstance(names, list) and all(isinstance(name, str) and name in SUPPORTED_CAPABILITIES for name in names)

def servable_slots(payload: Mapping[str, Any]) -> list[Any]:
    """A slot whose ``requires`` this SDK does not fully implement is absent: skipped, not validated, its payload not
    fetched (``protocol/trust-chain.md`` › Slots a reader cannot serve). Every read of ``slots`` for serving goes through this."""
    slots = payload.get("slots")
    return [slot for slot in slots if isinstance(slot, Mapping) and _capabilities_met(slot)] if isinstance(slots, list) else []

def servable_overrides(arm: Any) -> list[Any]:
    """An arm's overrides this SDK can serve. An unmet override of another tag goes alone; one of the experiment's own tag takes the experiment with it (``servable_experiments``)."""
    overrides = arm.get("overrides") if isinstance(arm, Mapping) else None
    return [override for override in overrides if isinstance(override, Mapping) and _capabilities_met(override)] if isinstance(overrides, list) else []

def _sits_out(experiment: Mapping[str, Any]) -> bool:
    """An arm that loses the override of the experiment's own tag has nothing to serve. Relabelling its share as control,
    or keeping the candidate label over base text, would skew gate and SRM evidence on a mixed fleet, so the host sits
    the experiment out: base text, arm none, bucket null, never evidence. A subject key it does not know does the same:
    it must not guess, and it must never hash by run."""
    if experiment.get("subjectKey") not in ("request", "instance"):
        return True
    arms = experiment.get("arms")
    return isinstance(arms, list) and any(isinstance(override, Mapping) and override.get("tag") == experiment["tag"] and not _capabilities_met(override) for arm in arms if isinstance(arm, Mapping) and isinstance(arm.get("overrides"), list) for override in arm["overrides"])

def frozen_experiment(payload: Mapping[str, Any], arms_off: Callable[[Any], "set[str]"], tag: str, tags: Mapping[str, str]) -> bool:
    """Every arm of the experiment naming this tag is disabled and this run is in its audience. Read from the raw list, so
    a freeze stops a host that sits the experiment out too. An audience this reader cannot read matches nothing."""
    listed = payload.get("experiments")
    raw = next((experiment for experiment in (listed if isinstance(listed, list) else []) if isinstance(experiment, Mapping) and experiment.get("tag") == tag), None)
    if raw is None or not isinstance(raw.get("arms"), list) or len(raw["arms"]) == 0:
        return False
    off = arms_off(raw.get("experimentId"))
    if not all(isinstance(arm, Mapping) and arm.get("arm") in off for arm in raw["arms"]):
        return False
    if "audience" not in raw:
        return True
    audience = raw["audience"]
    return matches_audience(audience.get("selector") if isinstance(audience, Mapping) else None, tags)


def servable_experiments(payload: Mapping[str, Any]) -> list[Any]:
    """The experiments this SDK acts on: those naming a servable slot it does not sit out, each arm holding its servable overrides."""
    tags = {slot.get("tag") for slot in servable_slots(payload) if isinstance(slot.get("tag"), str)}
    experiments = payload.get("experiments")
    kept = [experiment for experiment in experiments if isinstance(experiment, Mapping) and isinstance(experiment.get("tag"), str) and experiment["tag"] in tags and not _sits_out(experiment)] if isinstance(experiments, list) else []
    return [{**experiment, "arms": [{**arm, "overrides": servable_overrides(arm)} if isinstance(arm, Mapping) else arm for arm in experiment["arms"]]} if isinstance(experiment.get("arms"), list) else experiment for experiment in kept]

def capabilities_implemented(payload: Mapping[str, Any]) -> bool:
    """Every capability a manifest asks for is one this SDK implements (``capabilities.md``)."""
    return all(isinstance(name, str) and name in SUPPORTED_CAPABILITIES for name in payload.get("requiredCapabilities") or [])

def _tag_of(slot: Any) -> Any:
    return slot.get("tag") if isinstance(slot, Mapping) else None

def _selector_fingerprint(selector: Any) -> str:
    return json.dumps(selector, separators=(",", ":"), ensure_ascii=False)

def _valid_arms(e: Mapping[str, Any], p: Mapping[str, Any]) -> bool:
    """The arms as this SDK will assign over them: well-formed weights, one control first, one override at most."""
    arms = e.get("arms")
    if not isinstance(arms, list) or any(not isinstance(arm, Mapping) or type(arm.get("weightBps")) is not int or not 0 <= arm["weightBps"] <= 10000 or not isinstance(arm.get("arm"), str) or not _ARM_NAME.fullmatch(arm["arm"]) or len(arm["arm"]) > 32 or not isinstance(arm.get("overrides"), list) for arm in arms): return False
    if not 2 <= len(arms) <= 8 or sum(arm["weightBps"] for arm in arms) != 10000 or len({arm["arm"] for arm in arms}) != len(arms): return False
    return arms[0].get("releaseDigest") == p.get("releaseDigest") and len(arms[0]["overrides"]) == 0 and all(len(arm["overrides"]) <= 1 for arm in arms)

def _valid_audience(e: Mapping[str, Any], observations: list[Any]) -> bool:
    a = e["audience"]
    if not isinstance(a, Mapping): return False
    o = next((o for o in observations if o["audienceId"] == a.get("audienceId") and o["tag"] == e.get("tag")), None)
    return o is not None and _selector_fingerprint(o.get("selector")) == _selector_fingerprint(a.get("selector"))

def valid_audience_manifest(p: Mapping[str, Any]) -> bool:
    """The envelope: well-formed audiences and arms on the slots this SDK can serve. A manifest asking for a capability it lacks is refused after the signature instead."""
    if not isinstance(p, Mapping): return False
    if "experiments" in p:
        listed = p["experiments"]
        if not isinstance(listed, list) or len(listed) > 32 or any(not isinstance(e, Mapping) for e in listed): return False
    slots = p.get("slots")
    if not isinstance(slots, list): return False
    if "observations" in p:
        listed = p["observations"]
        if not isinstance(listed, list) or not 1 <= len(listed) <= 8: return False
    served = [_tag_of(slot) for slot in servable_slots(p)]
    # An observation on a skipped slot is skipped with it; one naming no slot at all is refused below.
    named = [_tag_of(slot) for slot in slots]
    observations = [o for o in p.get("observations", []) if not isinstance(o, Mapping) or o.get("tag") in served or o.get("tag") not in named]
    ids: set[str] = set()
    for o in observations:
        if not isinstance(o, Mapping) or not valid_audience_ids([o.get("audienceId")]) or o["audienceId"] in ids or o.get("tag") is None or o.get("tag") not in served or not valid_audience_instant(o.get("observeFrom")): return False
        ids.add(o["audienceId"])
    # A selector this reader cannot read loads and matches nothing (``matches_audience``): unknown is not malformed. The id and the fingerprint stay integrity checks.
    return all(_valid_arms(e, p) and ("audience" not in e or _valid_audience(e, observations)) for e in servable_experiments(p))

def captured_audience_ids(observations: Sequence[Mapping[str, Any]], tag: str, tags: Mapping[str,str], now_ms: float) -> tuple[str, ...]:
    return tuple(sorted(o["audienceId"] for o in observations if o["tag"] == tag and instant(o["observeFrom"]) <= now_ms and matches_audience(o["selector"], tags)))
