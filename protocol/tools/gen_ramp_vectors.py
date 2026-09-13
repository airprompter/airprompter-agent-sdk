#!/usr/bin/env python3
"""Generate protocol/vectors/ramp.json — the signed ramp plan's walk (S9), from an
independent implementation: the assignment hash from hashlib, the walk from the
rule in assignment-hash.md › The ramp plan. Usage: gen_ramp_vectors.py <out>.
"""
import base64
import hashlib
import json
import sys
from datetime import datetime, timezone

MODULUS = 10000
SALT = "AAECAwQFBgcICQoLDA0ODw"
ARMS = ["control", "candidate"]


def instant(text: str) -> int:
    return int(datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp() * 1000)


def bucket(salt: str, subject: str) -> int:
    raw = base64.urlsafe_b64decode(salt + "=" * (-len(salt) % 4))
    h = hashlib.sha256(raw + subject.encode("utf-8")).digest()
    return int.from_bytes(h[:8], "big") % MODULUS


def effective_weights(arms_weights, ramp, now_ms):
    weights = list(arms_weights)
    for step in ramp:
        if instant(step["notBefore"]) <= now_ms:
            weights = list(step["weightBps"])
    return weights


def arm_for(bucket_value, names, weights, disabled):
    # A disabled arm's share goes to the first arm in manifest order that is not disabled; all disabled → None (agent-level refusal).
    if all(n in disabled for n in names):
        return None
    first_live = next(n for n in names if n not in disabled)
    effective = []
    for name, w in zip(names, weights):
        effective.append(0 if name in disabled else w)
    reassigned = sum(w for name, w in zip(names, weights) if name in disabled)
    effective[names.index(first_live)] += reassigned
    cumulative = 0
    for name, w in zip(names, effective):
        cumulative += w
        if bucket_value < cumulative:
            return name
    return names[-1]


ramp = [
    {"notBefore": "2026-09-14T02:00:00Z", "weightBps": [9500, 500]},
    {"notBefore": "2026-09-14T03:00:00Z", "weightBps": [7500, 2500]},
    {"notBefore": "2026-09-14T05:00:00Z", "weightBps": [5000, 5000]},
    {"notBefore": "2026-09-14T09:00:00Z", "weightBps": [0, 10000]},
]
arms_weights = [10000, 0]
subjects = [f"user-{i}" for i in range(1, 41)]

cases = []
for name, now, note in [
    ("before the first step: the arms' own weights", "2026-09-14T01:59:59Z", "nothing has started; the candidate has no share"),
    ("exactly at a step's notBefore: that step is in force", "2026-09-14T02:00:00Z", "notBefore is inclusive"),
    ("between steps: the last step that started", "2026-09-14T04:30:00Z", "the 03:00 step, not the 05:00 one"),
    ("after the last step: the plan's end", "2026-09-15T00:00:00Z", "100 % candidate, and it stays there"),
]:
    now_ms = instant(now)
    weights = effective_weights(arms_weights, ramp, now_ms)
    cases.append({
        "name": name,
        "now": now,
        "salt": SALT,
        "arms": [{"arm": a, "weightBps": w} for a, w in zip(ARMS, arms_weights)],
        "ramp": ramp,
        "directives": [],
        "expected": {"weightBps": weights, "assignments": [{"subject": s, "bucket": bucket(SALT, s), "arm": arm_for(bucket(SALT, s), ARMS, weights, set())} for s in subjects[:8]]},
        "note": note,
    })

# Two skewed hosts around the 03:00 step: A's clock is 30 s early, B's 30 s late. Subjects in the range the step moved differ for
# those 60 s and nobody moves from candidate back to control.
a_now, b_now = "2026-09-14T02:59:30Z", "2026-09-14T03:00:30Z"
wa = effective_weights(arms_weights, ramp, instant(a_now))
wb = effective_weights(arms_weights, ramp, instant(b_now))
skew = []
for s in subjects:
    b = bucket(SALT, s)
    skew.append({"subject": s, "bucket": b, "hostA": arm_for(b, ARMS, wa, set()), "hostB": arm_for(b, ARMS, wb, set())})
assert any(x["hostA"] != x["hostB"] for x in skew), "the vector must show a disagreement"
assert not any(x["hostA"] == "candidate" and x["hostB"] == "control" for x in skew), "monotone: nobody moves back"
cases.append({
    "name": "two skewed hosts across a step: they disagree only for subjects in the range the step moved, and nobody moves from candidate back to control",
    "salt": SALT,
    "arms": [{"arm": a, "weightBps": w} for a, w in zip(ARMS, arms_weights)],
    "ramp": ramp,
    "directives": [],
    "hosts": {"hostA": {"now": a_now, "weightBps": wa}, "hostB": {"now": b_now, "weightBps": wb}},
    "expected": {"assignments": skew, "disagreements": sum(1 for x in skew if x["hostA"] != x["hostB"])},
    "note": "a step is a clock instant; hosts with skewed clocks straddle it for the skew and no longer; the sticky bucket keeps the flip one-way",
})

# The retreat: disable scope:"arm" on the candidate — every subject goes to control, whatever the plan says now.
now = "2026-09-14T06:00:00Z"
weights = effective_weights(arms_weights, ramp, instant(now))
cases.append({
    "name": "disable scope arm: the candidate's share goes to the control, whatever the plan says now",
    "now": now,
    "salt": SALT,
    "arms": [{"arm": a, "weightBps": w} for a, w in zip(ARMS, arms_weights)],
    "ramp": ramp,
    "directives": [{"kind": "disable", "scope": "arm", "arm": "candidate", "issuedAt": "2026-09-14T05:30:00Z", "reason": "p95 regressed"}],
    "expected": {"weightBps": weights, "assignments": [{"subject": s, "bucket": bucket(SALT, s), "arm": arm_for(bucket(SALT, s), ARMS, weights, {"candidate"})} for s in subjects[:8]]},
    "note": "a reduction: it lands without an unlock (S4's pushable set) and needs no new plan",
})
cases.append({
    "name": "disable scope arm naming an arm the manifest does not have changes nothing",
    "now": now,
    "salt": SALT,
    "arms": [{"arm": a, "weightBps": w} for a, w in zip(ARMS, arms_weights)],
    "ramp": ramp,
    "directives": [{"kind": "disable", "scope": "arm", "arm": "shadow", "issuedAt": "2026-09-14T05:30:00Z"}],
    "expected": {"weightBps": weights, "assignments": [{"subject": s, "bucket": bucket(SALT, s), "arm": arm_for(bucket(SALT, s), ARMS, weights, set())} for s in subjects[:4]]},
    "note": "an unknown arm is not an unknown directive kind: the manifest verifies and the directive is ignored",
})

refused = [
    {"name": "steps must be strictly increasing", "arms": [{"arm": "control", "weightBps": 10000}, {"arm": "candidate", "weightBps": 0}], "ramp": [{"notBefore": "2026-09-14T03:00:00Z", "weightBps": [9500, 500]}, {"notBefore": "2026-09-14T02:00:00Z", "weightBps": [7500, 2500]}], "reason": "ramp_invalid"},
    {"name": "steps are at least an hour apart", "arms": [{"arm": "control", "weightBps": 10000}, {"arm": "candidate", "weightBps": 0}], "ramp": [{"notBefore": "2026-09-14T02:00:00Z", "weightBps": [9500, 500]}, {"notBefore": "2026-09-14T02:30:00Z", "weightBps": [7500, 2500]}], "reason": "ramp_invalid"},
    {"name": "a step names a weight per arm", "arms": [{"arm": "control", "weightBps": 10000}, {"arm": "candidate", "weightBps": 0}], "ramp": [{"notBefore": "2026-09-14T02:00:00Z", "weightBps": [10000]}], "reason": "ramp_invalid"},
    {"name": "a step's weights sum to 10000", "arms": [{"arm": "control", "weightBps": 10000}, {"arm": "candidate", "weightBps": 0}], "ramp": [{"notBefore": "2026-09-14T02:00:00Z", "weightBps": [9000, 500]}], "reason": "ramp_invalid"},
    {"name": "at most eight steps", "arms": [{"arm": "control", "weightBps": 10000}, {"arm": "candidate", "weightBps": 0}], "ramp": [{"notBefore": f"2026-09-{14 + i // 24:02d}T{i % 24:02d}:00:00Z", "weightBps": [10000 - 1000 * (i + 1), 1000 * (i + 1)]} for i in range(9)], "reason": "ramp_invalid"},
    {"name": "an empty plan is not a plan", "arms": [{"arm": "control", "weightBps": 10000}, {"arm": "candidate", "weightBps": 0}], "ramp": [], "reason": "ramp_invalid"},
]

doc = {
    "$comment": "Generated by protocol/tools/gen_ramp_vectors.py from an independent implementation (hashlib; the walk as assignment-hash.md states it). See assignment-hash.md › The ramp plan.",
    "protocol": "0.2.5",
    "modulus": MODULUS,
    "cases": cases,
    "refused": refused,
}
with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
print(f"{len(cases)} cases, {len(refused)} refused -> {sys.argv[1]}")
