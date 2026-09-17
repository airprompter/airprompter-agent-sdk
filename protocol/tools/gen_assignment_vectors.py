"""Independent generator for protocol/vectors/assignment.json.

Deliberately written from the prose in assignment-hash.md, not from any
TypeScript; the point of the vectors is that two implementations agree.
CI regenerates the file and diffs it against the committed one. Usage::

    python3 protocol/tools/gen_assignment_vectors.py protocol/vectors/assignment.json
"""
import base64
import hashlib
import json
import os
import sys

PROTOCOL = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "VERSION"), encoding="utf-8").read().strip()

def b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)

def assign(salt: str, subject: str, weights: list[int]):
    h = hashlib.sha256(b64url_decode(salt) + subject.encode("utf-8")).digest()
    bucket = int.from_bytes(h[:8], "big") % 10000
    cumulative = 0
    for index, weight in enumerate(weights):
        cumulative += weight
        if bucket < cumulative:
            return h.hex(), bucket, index
    raise AssertionError("weights must sum to 10000")

SALT_A = base64.urlsafe_b64encode(bytes(range(16))).decode().rstrip("=")          # AAECAwQFBgcICQoLDA0ODw
SALT_B = base64.urlsafe_b64encode(bytes([0xff] * 16)).decode().rstrip("=")        # ____________________8
SALT_C = base64.urlsafe_b64encode(hashlib.sha256(b"experiment-c").digest()).decode().rstrip("=")  # 32-byte salt

cases = []
def add(name, salt, subject, arms, note=None):
    weights = [a["weightBps"] for a in arms]
    subject_hash, bucket, index = assign(salt, subject, weights)
    case = {
        "name": name,
        "salt": salt,
        "subject": subject,
        "arms": arms,
        "expected": {"subjectHash": subject_hash, "bucket": bucket, "arm": arms[index]["arm"]},
    }
    if note:
        case["note"] = note
    cases.append(case)

two = [{"arm": "control", "weightBps": 9000}, {"arm": "candidate", "weightBps": 1000}]
half = [{"arm": "control", "weightBps": 5000}, {"arm": "candidate", "weightBps": 5000}]
three = [{"arm": "control", "weightBps": 8000}, {"arm": "candidate", "weightBps": 1500}, {"arm": "shadow", "weightBps": 500}]
zero_first = [{"arm": "control", "weightBps": 0}, {"arm": "candidate", "weightBps": 10000}]
all_control = [{"arm": "control", "weightBps": 10000}, {"arm": "candidate", "weightBps": 0}]

add("empty subject", SALT_A, "", two, "the salt alone is hashed; an empty subject is still deterministic")
add("ascii user id", SALT_A, "user-42", two)
add("ascii user id, even split", SALT_A, "user-42", half, "same hash, different cut — only the weights moved")
add("ascii user id, three arms", SALT_A, "user-42", three)
add("different salt, same subject", SALT_B, "user-42", two, "a new experiment gets a new salt, so assignment does not carry over")
add("32-byte salt", SALT_C, "user-42", two)
add("instance id fallback", SALT_A, "inst_5f3c9a2b7e1d4c08", two, "when no subject is passed the instance id is the subject")
add("unicode subject", SALT_A, "ünïcödé-用户-🙂", three, "UTF-8 bytes, no normalisation")
add("subject with whitespace", SALT_A, "  user-42  ", two, "no trimming: this is a different subject from user-42")
add("email-shaped subject", SALT_B, "someone@example.com", half)
add("numeric string subject", SALT_C, "1234567890", three)
add("zero-weight first arm", SALT_A, "user-7", zero_first, "an arm with weight 0 is never chosen")
add("all traffic on control", SALT_B, "user-7", all_control)
for n in range(1, 21):
    add(f"sweep user-{n}", SALT_C, f"user-{n}", three)

# A subject whose bucket lands exactly on the first boundary is worth having if we can find one quickly.
found = None
for n in range(1, 200000):
    subject = f"boundary-{n}"
    _, bucket, _ = assign(SALT_A, subject, [9000, 1000])
    if bucket == 9000:
        found = subject
        break
if found:
    add("bucket exactly at the boundary", SALT_A, found, two, "bucket 9000 is the first candidate bucket: the comparison is strict less-than")
found = None
for n in range(1, 200000):
    subject = f"edge-{n}"
    _, bucket, _ = assign(SALT_A, subject, [9000, 1000])
    if bucket == 8999:
        found = subject
        break
if found:
    add("bucket one below the boundary", SALT_A, found, two)

# S16: per-prompt experiments. One subject, two experiments with their own salts: the arm for a tag is the arm of the
# experiment that names that tag, hashed with that experiment's salt; a tag no experiment names gets "none".
per_tag = []
for subject in ("user-42", "user-7", "someone@example.com"):
    experiments = [
        {"experimentId": "exp_triage", "tag": "support.triage", "salt": SALT_A, "arms": two},
        {"experimentId": "exp_reply", "tag": "support.reply", "salt": SALT_B, "arms": half},
    ]
    expected = {}
    for e in experiments:
        _, bucket, index = assign(e["salt"], subject, [a["weightBps"] for a in e["arms"]])
        expected[e["tag"]] = {"experimentId": e["experimentId"], "bucket": bucket, "arm": e["arms"][index]["arm"]}
    expected["docs.summarise"] = {"experimentId": None, "bucket": None, "arm": "none"}
    per_tag.append({"name": f"two splits, one subject: {subject}", "subject": subject, "experiments": experiments, "tags": ["support.triage", "support.reply", "docs.summarise"], "expected": expected})

doc = {
    "$comment": "Generated by an independent Python implementation of assignment-hash.md. Do not edit by hand; regenerate and review the diff.",
    "protocol": PROTOCOL,
    "modulus": 10000,
    "cases": cases,
    "perTag": {
        "$comment": "S16 (assignment-hash.md › Per-prompt experiments): each experiment assigns on its own salt; a tag outside every experiment is arm none.",
        "cases": per_tag,
        "refused": [
            {"name": "a tag in two experiments", "experiments": [{"experimentId": "exp_a", "tag": "support.triage", "salt": SALT_A, "arms": two}, {"experimentId": "exp_b", "tag": "support.triage", "salt": SALT_B, "arms": half}], "reason": "experiment_conflict"},
            {"name": "an override naming another experiment's tag", "experiments": [{"experimentId": "exp_a", "tag": "support.triage", "salt": SALT_A, "arms": two, "overrideTags": {"candidate": ["support.reply"]}}], "reason": "experiment_conflict"},
            {"name": "experiment beside experiments[]", "experiment": {"experimentId": "exp_legacy", "salt": SALT_A, "arms": two}, "experiments": [{"experimentId": "exp_a", "tag": "support.triage", "salt": SALT_B, "arms": half}], "reason": "experiment_conflict"},
        ],
    },
    "refused": [
        {"name": "weights below 10000", "salt": SALT_A, "arms": [{"arm": "control", "weightBps": 9000}, {"arm": "candidate", "weightBps": 500}], "reason": "weights_not_10000"},
        {"name": "weights above 10000", "salt": SALT_A, "arms": [{"arm": "control", "weightBps": 9000}, {"arm": "candidate", "weightBps": 1500}], "reason": "weights_not_10000"},
        {"name": "single arm", "salt": SALT_A, "arms": [{"arm": "control", "weightBps": 10000}], "reason": "too_few_arms"},
        {"name": "salt is not base64url", "salt": "not+base64/url=", "arms": two, "reason": "salt_invalid"},
        {"name": "salt too short", "salt": "AAEC", "arms": two, "reason": "salt_invalid"},
    ],
}
out = sys.argv[1]
with open(out, "w", encoding="utf-8") as f:
    json.dump(doc, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(f"{len(cases)} cases -> {out}")
