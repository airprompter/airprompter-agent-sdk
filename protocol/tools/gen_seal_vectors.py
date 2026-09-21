"""Independent generator for protocol/vectors/seal.json (pins.md, 0.3.5).

`canonical`, `sha256_prefixed` and `release_digest` are copied verbatim from
`gen_examples.py` (that module writes files as a side effect of import, so
it cannot be imported here) — independence from the JavaScript reference
(`conformance/reference.mjs`'s `verifySeal`) is the point: two
implementations must agree on the recomputation, including its per-tag
attribution rule (pins.md). CI regenerates the file and diffs it against
the committed one. Usage::

    python3 protocol/tools/gen_seal_vectors.py protocol/vectors/seal.json
"""
import hashlib
import json
import os
import sys

PROTOCOL = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "VERSION"), encoding="utf-8").read().strip()

# --- copied from gen_examples.py (see module docstring) --------------------
def canonical(v) -> str:
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

def sha256_prefixed(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()

def inference_input(inference):
    return {k: inference[k] for k in ("maxOutputTokens", "reasoningEffort", "stopSequences", "temperatureMilli", "topPBps") if inference.get(k) is not None}

def step_digest_input(st):
    return {
        **{k: st[k] for k in ("stepId", "ordinal", "promptArtifactId", "promptVersionId", "contentHash", "byteLength")},
        **({"inference": inference_input(st["inference"])} if st.get("inference") is not None else {}),
    }

def digest_input(slots):
    out = []
    for s in sorted(slots, key=lambda s: s["tag"]):
        p = {k: s[k] for k in ("tag", "kind", "artifactId", "versionId", "versionOrdinal", "contentHash", "byteLength", "model")}
        p["variables"] = [{"name": v["name"], "required": v["required"], "trust": v["trust"], **({"default": v["default"]} if v.get("default") is not None else {}), **({"source": v["source"]} if v.get("source") is not None else {})} for v in s["variables"]]
        if "steps" in s:
            p["steps"] = [step_digest_input(st) for st in s["steps"]]
        if s.get("inference") is not None:
            p["inference"] = inference_input(s["inference"])
        out.append(p)
    return out

def release_digest(slots):
    return sha256_prefixed(canonical(digest_input(slots)).encode("utf-8"))
# --- end copy ----------------------------------------------------------

def pin_projection(pin):
    """A single pin's full digest projection (canonical-json.md), as `digest_input([pin])[0]` builds it."""
    return canonical(digest_input([pin])[0])

def without_steps(pin):
    p = dict(pin)
    p.pop("steps", None)
    return p

def verify_seal(seal_id, sealed_pins, pins, texts):
    """Independent Python recomputation of pins.md's rule — see conformance/reference.mjs's verifySeal
    for the JavaScript twin this must agree with."""
    changed = set()

    def rehash(content_hash, tag):
        encoded = texts.get(content_hash)
        if encoded is None:
            changed.add(tag)
            return content_hash
        import base64
        # base64url, restoring the padding json.dumps/b64 stripped.
        padded = encoded + "=" * (-len(encoded) % 4)
        data = base64.urlsafe_b64decode(padded)
        rehashed = sha256_prefixed(data)
        if rehashed != content_hash:
            changed.add(tag)
            return rehashed
        return content_hash

    # (a) text missing or rehashes differently.
    observed_pins = []
    for pin in pins:
        content_hash = rehash(pin["contentHash"], pin["tag"])
        p = {**pin, "contentHash": content_hash}
        if "steps" in pin:
            p["steps"] = [{**step, "contentHash": rehash(step["contentHash"], step["stepId"])} for step in pin["steps"]]
        observed_pins.append(p)
    observed_digest = release_digest(observed_pins)

    sealed_by_tag = {p["tag"]: p for p in sealed_pins}
    observed_by_tag = {p["tag"]: p for p in observed_pins}
    all_tags = set(sealed_by_tag) | set(observed_by_tag)
    for tag in all_tags:
        sealed_pin = sealed_by_tag.get(tag)
        observed_pin = observed_by_tag.get(tag)
        # (d) a tag present on only one side.
        if sealed_pin is None or observed_pin is None:
            changed.add(tag)
            continue
        is_workflow = "steps" in sealed_pin or "steps" in observed_pin
        if not is_workflow:
            # (b) a prompt pin: compare its full digest projection.
            if pin_projection(sealed_pin) != pin_projection(observed_pin):
                changed.add(tag)
            continue
        # (c) a workflow pin: compare with steps removed, then each step by stepId.
        if pin_projection(without_steps(sealed_pin)) != pin_projection(without_steps(observed_pin)):
            changed.add(tag)
        sealed_steps = {s["stepId"]: s for s in sealed_pin.get("steps", [])}
        observed_steps = {s["stepId"]: s for s in observed_pin.get("steps", [])}
        for step_id in set(sealed_steps) | set(observed_steps):
            sealed_step = sealed_steps.get(step_id)
            observed_step = observed_steps.get(step_id)
            if sealed_step is None or observed_step is None:
                changed.add(step_id)
                continue
            if canonical(step_digest_input(sealed_step)) != canonical(step_digest_input(observed_step)):
                changed.add(step_id)

    changed_tags = sorted(changed)
    short_id_matches = observed_digest[len("sha256:"):][:12] == seal_id
    intact = len(changed_tags) == 0 and observed_digest == release_digest(sealed_pins) and short_id_matches
    return {"observedDigest": observed_digest, "intact": intact, "changedTags": changed_tags}

triage_text = b"Classify the support ticket below.\n<ticket>{{ticket_body}}</ticket>\n"
summary_text = b"Summarise the thread for a handoff.\n"
workflow_text = b"welcome -> confirm\n"
step1_text = b"Welcome the user and ask what they need.\n"
step2_text = b"Confirm the plan back to the user.\n"

# One byte changed from triage_text, to model a text edited on disk without updating its pin.
triage_text_tampered = b"Classify the support ticket below!\n<ticket>{{ticket_body}}</ticket>\n"
# One byte changed from step2_text.
step2_text_tampered = b"Confirm the plan back to the user!\n"

base_slots = [
    {
        "tag": "support.triage",
        "kind": "prompt",
        "artifactId": "prm_seal_triage",
        "versionId": "ver_seal_triage_1",
        "versionOrdinal": 1,
        "contentHash": sha256_prefixed(triage_text),
        "byteLength": len(triage_text),
        "model": "claude-sonnet-5",
        "variables": [{"name": "ticket_body", "required": True, "trust": "end_user"}],
        # A slot's inference block is digest-bound when present (canonical-json.md).
        "inference": {"temperatureMilli": 200, "maxOutputTokens": 800},
    },
    {
        "tag": "support.summary",
        "kind": "prompt",
        "artifactId": "prm_seal_summary",
        "versionId": "ver_seal_summary_1",
        "versionOrdinal": 1,
        "contentHash": sha256_prefixed(summary_text),
        "byteLength": len(summary_text),
        "model": "claude-sonnet-5",
        "variables": [],
    },
    {
        "tag": "onboarding.flow",
        "kind": "workflow",
        "artifactId": "wfl_seal_onboarding",
        "versionId": "ver_seal_onboarding_1",
        "versionOrdinal": 1,
        "contentHash": sha256_prefixed(workflow_text),
        "byteLength": len(workflow_text),
        "model": "claude-sonnet-5",
        "variables": [{"name": "plan_name", "required": True, "trust": "operator"}],
        "steps": [
            {"stepId": "onboarding.flow#1", "ordinal": 1, "promptArtifactId": "prm_seal_step1", "promptVersionId": "ver_seal_step1_1", "contentHash": sha256_prefixed(step1_text), "byteLength": len(step1_text)},
            {"stepId": "onboarding.flow#2", "ordinal": 2, "promptArtifactId": "prm_seal_step2", "promptVersionId": "ver_seal_step2_1", "contentHash": sha256_prefixed(step2_text), "byteLength": len(step2_text), "inference": {"topPBps": 9000}},
        ],
    },
]
base_slots.sort(key=lambda s: s["tag"])
release_digest_value = release_digest(base_slots)
seal_id = release_digest_value[len("sha256:"):][:12]

base_texts = {
    sha256_prefixed(triage_text): triage_text,
    sha256_prefixed(summary_text): summary_text,
    sha256_prefixed(workflow_text): workflow_text,
    sha256_prefixed(step1_text): step1_text,
    sha256_prefixed(step2_text): step2_text,
}

def b64(data: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(data).decode().rstrip("=")

def texts_map(overrides):
    """base_texts, keyed by contentHash, with some values replaced by tampered bytes."""
    m = dict(base_texts)
    m.update(overrides)
    return {h: b64(b) for h, b in m.items()}

def with_summary_inference(slots):
    return [{**s, "inference": {"temperatureMilli": 100}} if s["tag"] == "support.summary" else s for s in slots]

def without_slot(slots, tag):
    return [s for s in slots if s["tag"] != tag]

def build_case(name, sealed_pins, pins, texts):
    expected = verify_seal(seal_id, sealed_pins, pins, texts)
    return {
        "name": name,
        "sealId": seal_id,
        "releaseDigest": release_digest_value,
        "sealedPins": sealed_pins,
        "pins": pins,
        "texts": texts,
        "expected": expected,
    }

cases = [
    build_case("intact", base_slots, base_slots, texts_map({})),
    # support.triage's stored bytes no longer hash to the pin's contentHash: the tag is flagged, and
    # observedDigest is recomputed with the rehashed (mismatching) contentHash substituted in a copy.
    build_case("text tampered", base_slots, base_slots, texts_map({sha256_prefixed(triage_text): triage_text_tampered})),
    # support.summary's text is untouched — this is not a text tamper. Its inference block changed instead
    # in the customer's own copy (sealed differently than what the release actually sealed). A pure text-hash
    # check cannot see this, but the per-tag digest-projection comparison (pins.md) can: it diffs the sealed
    # pin against the observed pin member-by-member and names the tag directly.
    build_case("settings changed", base_slots, with_summary_inference(base_slots), texts_map({})),
    build_case("step text tampered", base_slots, base_slots, texts_map({sha256_prefixed(step2_text): step2_text_tampered})),
    # support.summary is missing from the customer's own copy entirely — dropped, not tampered. The tag is
    # present in sealedPins but absent from pins/observedPins, so it is named directly.
    build_case("a slot missing from the customer's copy", base_slots, without_slot(base_slots, "support.summary"), texts_map({})),
]

doc = {
    "$comment": "Generated by an independent Python implementation of pins.md. Do not edit by hand; regenerate and review the diff.",
    "protocol": PROTOCOL,
    "description": "Customer-store seal recomputation (pins.md): re-hash held texts against their pins' contentHash, then diff each pin's (and workflow step's) full canonical-JSON digest projection between the release's pins as sealed and the customer's own copy — canonical-json.md's projection, exactly as releaseDigestInput builds it. changedTags is the sorted, deduped union of every source: a text tamper, a settings-only drift, a workflow step tamper, and a slot present on only one side.",
    "cases": cases,
}

out = sys.argv[1]
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
with open(out, "w", encoding="utf-8") as f:
    json.dump(doc, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(len(cases), "cases ->", out)
print("sealId", seal_id)
print("releaseDigest", release_digest_value)
