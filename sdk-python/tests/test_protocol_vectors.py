"""Every protocol vector, through the SDK's own implementations — and the
cross-language equalities the ticket asks for: the manifests in
``manifest-verify.json`` were sealed by the TypeScript generator, so a
release digest this SDK recomputes from their pins must equal the one the
other language wrote, and every assignment vector must land on the same
bucket the Python and TypeScript references landed on.
"""

from __future__ import annotations

import datetime as dt
import json
import os

import pytest

from airprompter_agent_core._util import b64url_decode
from airprompter_agent_core.protocol import (
    UNDEFINED,
    AssignmentError,
    CanonicalJsonError,
    StepError,
    assign_arm,
    canonical_json,
    ordered_steps,
    release_digest,
    sha256_prefixed,
    trusted_root_from_pinned_key,
    verify_manifest,
    verify_root_metadata,
)

VECTORS = os.path.join(os.path.dirname(__file__), "..", "..", "protocol", "vectors")


def vector(name: str):
    with open(os.path.join(VECTORS, name), encoding="utf-8") as f:
        return json.load(f)


def test_canonical_json_vectors():
    file = vector("canonical-json.json")
    assert len(file["vectors"]) >= 10
    for v in file["vectors"]:
        text = canonical_json(v["input"])
        assert text == v["canonical"], v["name"]
        assert sha256_prefixed(text.encode("utf-8")) == v["sha256"], v["name"]
    refused_inputs = {
        "undefined_value": {"a": UNDEFINED},
        "non_integer_number": {"n": 1.5},
        "non_finite_number": {"n": float("inf")},
        "unsafe_integer": {"n": 2**53 + 1},
        "unsupported_type": {"d": dt.datetime(1970, 1, 1)},
    }
    cycle: dict = {}
    cycle["self"] = cycle
    refused_inputs["cycle"] = cycle
    for r in file["refused"]:
        value = r["input"] if "input" in r else refused_inputs[r["reason"]]
        with pytest.raises(CanonicalJsonError) as raised:
            canonical_json(value)
        assert raised.value.reason == r["reason"], r["name"]


def test_canonical_json_python_specifics():
    # JavaScript has one number type: an integral float is an integer; NaN and a set are refused; a lone surrogate is escaped, never a UnicodeEncodeError.
    assert canonical_json({"n": 2.0}) == '{"n":2}'
    with pytest.raises(CanonicalJsonError) as nan:
        canonical_json({"n": float("nan")})
    assert nan.value.reason == "non_finite_number"
    with pytest.raises(CanonicalJsonError) as unsupported:
        canonical_json({"s": {1, 2}})
    assert unsupported.value.reason == "unsupported_type"
    with pytest.raises(CanonicalJsonError) as key:
        canonical_json({1: "x"})
    assert key.value.reason == "unsupported_type"
    assert canonical_json({"s": "\ud800"}) == '{"s":"\\ud800"}'
    assert canonical_json({"t": (1, 2)}) == '{"t":[1,2]}'
    assert canonical_json(True) == "true" and canonical_json(None) == "null"


def test_workflow_steps_vectors():
    for v in vector("workflow-steps.json")["vectors"]:
        if v.get("refuse"):
            with pytest.raises(StepError) as raised:
                ordered_steps(v["slotTag"], v["steps"])
            assert raised.value.reason == v["refuse"], v["name"]
        else:
            assert [s["stepId"] for s in ordered_steps(v["slotTag"], v["steps"])] == v["expectedOrder"], v["name"]


def test_assignment_vectors():
    file = vector("assignment.json")
    assert len(file["cases"]) >= 30
    for c in file["cases"]:
        result = assign_arm(salt=c["salt"], subject=c["subject"], arms=c["arms"])
        assert {"subjectHash": result.subject_hash, "bucket": result.bucket, "arm": result.arm["arm"]} == c["expected"], c["name"]
    for r in file["refused"]:
        with pytest.raises(AssignmentError) as raised:
            assign_arm(salt=r["salt"], subject="user-1", arms=r["arms"])
        assert raised.value.reason == r["reason"], r["name"]


def test_manifest_verify_vectors_and_cross_language_digests():
    file = vector("manifest-verify.json")
    assert len(file["rootMetadata"]) >= 10 and len(file["manifests"]) >= 30
    for c in file["rootMetadata"]:
        trusted = c.get("trustedRoot") or trusted_root_from_pinned_key(purpose=c["purpose"], environment=c["environment"], pinned_root=c["pinnedRoot"])
        result = verify_root_metadata(candidate=c["candidate"], trusted=trusted, now=c["now"])
        assert result.ok == c["expected"]["ok"], c["name"]
        if not result.ok:
            assert result.reason == c["expected"]["reason"], c["name"]
    digests_checked = 0
    for c in file["manifests"]:
        payloads = {p["contentHash"]: b64url_decode(p["bytes"]) for p in c["payloads"]} if c.get("payloads") else None
        result = verify_manifest(
            manifest=c["manifest"], root=c["root"], now=c["now"], scope=c["scope"], stored_generation=c["storedGeneration"], payloads=payloads, countersign_root=c.get("countersignRoot"), require_countersign=c.get("requireCountersign", False)
        )
        assert result.ok == c["expected"]["ok"], f"{c['name']}: {result}"
        if result.ok:
            assert result.signing_key_id == c["expected"]["signingKeyId"], c["name"]
            assert result.generation == c["expected"]["generation"], c["name"]
            # Cross-language: the TypeScript generator sealed this manifest; its digest must reproduce from the pins here.
            payload = c["manifest"]["payload"]
            assert release_digest(payload["slots"]) == payload["releaseDigest"], f"{c['name']}: release digest differs across languages"
            for arm in (payload.get("experiment") or {}).get("arms", []):
                overrides = {o["tag"]: o for o in arm["overrides"]}
                effective = [overrides.get(s["tag"], s) for s in payload["slots"]]
                assert release_digest(effective) == arm["releaseDigest"], f"{c['name']}: arm {arm['arm']} digest differs across languages"
            digests_checked += 1
        else:
            assert result.reason == c["expected"]["reason"], c["name"]
    assert digests_checked >= 5, "the valid cases carry JS-sealed digests this SDK must reproduce"


def test_examples_digest_reproduces():
    """The committed example manifest (generated by protocol/tools, checked by the conformance runner in JavaScript) hashes the same here."""
    with open(os.path.join(VECTORS, "..", "examples", "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    assert release_digest(manifest["payload"]["slots"]) == manifest["payload"]["releaseDigest"]


def test_variable_default_and_source_are_digest_bound_only_when_present():
    """0.3.4: parity with the reference and TypeScript — a null is unset; a default or a source changes the digest."""
    from airprompter_agent_core.protocol.trust import release_digest

    slot = {"tag": "a", "kind": "prompt", "artifactId": "prm_1", "versionId": "v1", "versionOrdinal": 1, "contentHash": "sha256:" + "a" * 64, "byteLength": 1, "model": "gpt-5", "variables": [{"name": "tone", "required": False, "trust": "operator"}]}
    plain = release_digest([slot])
    assert release_digest([{**slot, "variables": [{**slot["variables"][0], "default": None, "source": None}]}]) == plain
    assert release_digest([{**slot, "variables": [{**slot["variables"][0], "default": "warm"}]}]) != plain
    assert release_digest([{**slot, "variables": [{**slot["variables"][0], "source": "runtime"}]}]) != plain
