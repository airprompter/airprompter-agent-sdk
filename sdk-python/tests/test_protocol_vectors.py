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
from pathlib import Path
import subprocess
import sys

from jsonschema import Draft202012Validator
import pytest
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

from airprompter_agent.core._util import b64url_decode
from airprompter_agent.core.protocol import (
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
from airprompter_agent.core.protocol.assignment import frozen_experiment, servable_experiments, servable_slots
from airprompter_agent.core.protocol.trust import carried_payloads, optional_payloads, referenced_payloads
from airprompter_agent.core.render.run_ref import RUN_REF_MAX_ENTRIES, RUN_REF_MAX_TOKEN_LENGTH, RUN_REF_READ_MAX_ENTRIES, RUN_REF_READ_MAX_TOKEN_LENGTH, RunRefFacts, mint_run_ref, parse_run_ref, run_ref_key_from
from airprompter_agent.runtime.release.resolver import disabled_from

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
        payloads = {p["contentHash"]: b64url_decode(p["bytes"]) for p in c["payloads"]} if c.get("payloads") is not None else None
        result = verify_manifest(
            manifest=c["manifest"], root=c["root"], now=c["now"], scope=c["scope"], stored_generation=c["storedGeneration"], payloads=payloads, countersign_root=c.get("countersignRoot"), require_countersign=c.get("requireCountersign", False), carrying=c.get("carrying") is True, absent_requires=c.get("absentRequires") is True
        )
        assert result.ok == c["expected"]["ok"], f"{c['name']}: {result}"
        if result.ok:
            assert result.signing_key_id == c["expected"]["signingKeyId"], c["name"]
            assert result.generation == c["expected"]["generation"], c["name"]
            # Cross-language: the TypeScript generator sealed this manifest; its digest must reproduce from the pins here.
            # A slot this SDK cannot read is never recomputed: the signature is what covers it.
            payload = c["manifest"]["payload"]
            if servable_slots(payload) != payload["slots"] or "requiredCapabilities" in payload or c.get("carrying"):
                continue
            assert release_digest(payload["slots"]) == payload["releaseDigest"], f"{c['name']}: release digest differs across languages"
            for experiment in payload.get("experiments") or []:
                for arm in experiment["arms"]:
                    if not arm["overrides"]:
                        assert arm["releaseDigest"] == payload["releaseDigest"], f"{c['name']}: arm {arm['arm']} is the release"
            digests_checked += 1
        else:
            assert result.reason == c["expected"]["reason"], c["name"]
            assert result.directives_stand is (c["expected"].get("directivesStand") is True), f"{c['name']}: directives stand"
    assert digests_checked >= 5, "the valid cases carry JS-sealed digests this SDK must reproduce"
    assert len(file["digests"]) >= 3 and len(file["carriers"]) >= 4
    for c in file["digests"]:
        assert release_digest(c["slots"]) == c["releaseDigest"], c["name"]
    for c in file["carriers"]:
        assert sorted([content_hash, byte_length] for content_hash, byte_length in carried_payloads(c["payload"]).items()) == c["carried"], c["name"]
        assert sorted(optional_payloads(c["payload"])) == c["optional"], c["name"]
    for c in (entry for entry in file["manifests"] if "frozenTags" in entry):
        payload = c["manifest"]["payload"]
        arms_off = disabled_from(payload["directives"]).arms_for
        assert [experiment["tag"] for experiment in payload["experiments"] if frozen_experiment(payload, arms_off, experiment["tag"], {})] == c["frozenTags"], c["name"]
    runs = [entry for entry in file["manifests"] if "frozenRuns" in entry]
    assert len(runs) >= 3, "the vector carries the audience cases"
    for c in runs:
        payload = c["manifest"]["payload"]
        arms_off = disabled_from(payload["directives"]).arms_for
        for run in c["frozenRuns"]:
            assert [experiment["tag"] for experiment in payload["experiments"] if frozen_experiment(payload, arms_off, experiment["tag"], run["tags"])] == run["frozenTags"], f"{c['name']}: {run['name']}"


def test_manifest_verify_vectors_an_override_with_an_unmet_requires_goes_alone():
    cases = [c for c in vector("manifest-verify.json")["manifests"] if "servableOverrides" in c]
    assert len(cases) >= 2, "the vector carries the cases"
    for c in cases:
        overrides = {experiment["experimentId"]: {arm["arm"]: [override["tag"] for override in arm["overrides"]] for arm in experiment["arms"]} for experiment in servable_experiments(c["manifest"]["payload"])}
        assert overrides == c["servableOverrides"], c["name"]


def test_manifest_verify_vectors_a_slot_with_an_unmet_requires_is_absent_and_everything_else_loads():
    cases = [c for c in vector("manifest-verify.json")["manifests"] if "servableTags" in c]
    assert len(cases) >= 1, "the vector carries the case"
    for c in cases:
        payload = c["manifest"]["payload"]
        assert [slot["tag"] for slot in servable_slots(payload)] == c["servableTags"], c["name"]
        assert not any(experiment["tag"] in c["skippedTags"] for experiment in servable_experiments(payload)), f"{c['name']}: its experiment is ignored"
        skipped_hashes = {slot["contentHash"] for slot in payload["slots"] if slot["tag"] in c["skippedTags"]}
        assert not skipped_hashes & set(referenced_payloads(payload)), f"{c['name']}: its payload is not required"
        assert disabled_from(payload["directives"]).slots == c["disabledSlots"], f"{c['name']}: a disable still applies"


def test_heartbeat_reader_vectors_each_document_gets_the_writer_schema_verdict_the_vector_names():
    documents = [json.loads(path.read_text(encoding="utf-8")) for path in (Path(VECTORS).parent / "schemas").glob("*.schema.json")]
    registry = Registry().with_resources((document["$id"], Resource.from_contents(document, default_specification=DRAFT202012)) for document in documents)
    writer = Draft202012Validator({"$ref": "https://airprompter.com/protocol/3/heartbeat.schema.json#/$defs/request"}, registry=registry, format_checker=Draft202012Validator.FORMAT_CHECKER)
    cases = vector("heartbeat-readers.json")["cases"]
    assert len(cases) >= 3, "the vector carries the cases"
    assert {c["writerSchema"] for c in cases} == {True, False}, "a verdict each way"
    for c in cases:
        assert writer.is_valid(c["document"]) is c["writerSchema"], c["name"]
        assert c["reader"] == "accepted", c["name"]


def test_feedback_vectors_the_one_run_reference_form_the_same_in_every_language():
    rr = vector("feedback.json")["runRef"]
    assert [RUN_REF_MAX_ENTRIES, RUN_REF_MAX_TOKEN_LENGTH, RUN_REF_READ_MAX_ENTRIES, RUN_REF_READ_MAX_TOKEN_LENGTH] == [rr["bounds"]["maxEntries"], rr["bounds"]["maxTokenLength"], rr["bounds"]["readMaxEntries"], rr["bounds"]["readMaxTokenLength"]]
    for c in rr["keys"]:
        assert run_ref_key_from(c["secret"], c["agentId"], c["target"]).hex() == c["keyHex"], c["name"]
    key = bytes.fromhex(rr["keyHex"])
    assert len(rr["tokens"]) >= 5
    for c in rr["tokens"]:
        facts = RunRefFacts.from_wire(c["facts"])
        assert parse_run_ref(c["token"], key).to_wire() == c["facts"], f"parse: {c['name']}"
        if c.get("mintRefused"):
            with pytest.raises(ValueError, match="run_ref_facts_invalid"):
                mint_run_ref(facts, key)
        else:
            assert mint_run_ref(facts, key) == c["token"], f"mint: {c['name']}"
            assert len(c["token"]) <= RUN_REF_MAX_TOKEN_LENGTH, c["name"]
            # What this SDK did not write survives a re-mint: a host grows a ref a later SDK wrote.
            assert parse_run_ref(mint_run_ref(parse_run_ref(c["token"], key), key), key).to_wire() == c["facts"], f"re-mint: {c['name']}"
    for c in rr["mintRefused"]:
        with pytest.raises(ValueError, match="run_ref_facts_invalid"):
            mint_run_ref(RunRefFacts.from_wire(c["facts"]), key)
    previous = bytes.fromhex(rr["rotation"]["previousKeyHex"])
    assert parse_run_ref(rr["rotation"]["token"], [bytes.fromhex(rr["rotation"]["currentKeyHex"]), previous]).to_wire() == rr["rotation"]["facts"], rr["rotation"]["name"]
    assert parse_run_ref(rr["rotation"]["token"], key) is None, "without the previous key it does not parse"
    for c in rr["refused"]:
        assert parse_run_ref(c["token"], key) is None, c["name"]


def test_examples_digest_reproduces():
    """The committed example manifest (generated by protocol/tools, checked by the conformance runner in JavaScript) hashes the same here."""
    with open(os.path.join(VECTORS, "..", "examples", "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    assert release_digest(manifest["payload"]["slots"]) == manifest["payload"]["releaseDigest"]


def test_variable_default_and_source_are_digest_bound_only_when_present():
    """Parity with the reference and TypeScript — a null is unset; a default or a source changes the digest."""
    from airprompter_agent.core.protocol.trust import release_digest

    slot = {"tag": "a", "kind": "prompt", "artifactId": "prm_1", "versionId": "v1", "versionOrdinal": 1, "contentHash": "sha256:" + "a" * 64, "byteLength": 1, "model": "gpt-5", "variables": [{"name": "tone", "required": False, "trust": "operator"}]}
    plain = release_digest([slot])
    assert release_digest([{**slot, "variables": [{**slot["variables"][0], "default": None, "source": None}]}]) == plain
    assert release_digest([{**slot, "variables": [{**slot["variables"][0], "default": "warm"}]}]) != plain
    assert release_digest([{**slot, "variables": [{**slot["variables"][0], "source": "runtime"}]}]) != plain


def test_a_slots_requires_is_in_the_release_digest_when_present():
    slot = {"tag": "a", "kind": "prompt", "artifactId": "prm_1", "versionId": "v1", "versionOrdinal": 1, "contentHash": "sha256:" + "a" * 64, "byteLength": 1, "model": "gpt-5", "variables": []}
    assert release_digest([{**slot, "requires": ["rubric_slots"]}]) != release_digest([slot])
    assert release_digest([{**slot, "requires": None}]) == release_digest([slot]), "a null is unset"


def test_audience_vectors():
    from airprompter_agent.core import matches_audience, valid_audience_selector
    from airprompter_agent.core.protocol.assignment import valid_audience_instant, valid_audience_key, valid_audience_label
    for case in vector("audiences.json")["cases"]:
        assert valid_audience_selector(case["selector"]) == case["valid"], case["name"]
        assert matches_audience(case["selector"], case["tags"]) == case["matches"], case["name"]
    for case in vector("audiences.json")["validators"]:
        actual = {"key":valid_audience_key, "label":valid_audience_label, "instant":valid_audience_instant}[case["kind"]](case["value"])
        assert actual == case["valid"], case["name"]


def test_python_conformance_adapter_audience_validator_json_lines():
    repo_root = Path(__file__).resolve().parents[2]
    adapter = repo_root / "examples" / "conformance-adapter" / "python" / "adapter.py"
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join(str(path) for path in (repo_root / "sdk-python" / "packages").glob("*/src"))
    messages = [
        {"id": "capabilities", "fn": "capabilities"},
        {"id": "unknown", "fn": "audienceValidator", "args": {"kind": "unknown", "value": "2026-08-01T00:00:00Z"}},
        {"id": "instant", "fn": "audienceValidator", "args": {"kind": "instant", "value": "2026-08-01T00:00:00Z"}},
    ]
    result = subprocess.run(
        [sys.executable, str(adapter)],
        input="\n".join(json.dumps(message) for message in messages) + "\n",
        text=True,
        capture_output=True,
        check=True,
        env=env,
    )
    responses = [json.loads(line) for line in result.stdout.splitlines()]
    assert len(responses) == 3
    assert "audiencePredicate" in responses[0]["result"]["ops"]
    assert "audienceValidator" in responses[0]["result"]["ops"]
    assert responses[1] == {"id": "unknown", "result": {"valid": False}}
    assert responses[2] == {"id": "instant", "result": {"valid": True}}


def test_signed_audience_vectors():
    for case in vector("audiences.json")["manifests"]:
        verdict=verify_manifest(manifest=case["manifest"],root=case["root"],now=case["now"],scope=case["scope"],stored_generation=case["storedGeneration"])
        assert verdict.ok == case["expected"]["ok"], case["name"]
        if not verdict.ok: assert verdict.reason == case["expected"]["reason"], case["name"]
        if "disabledSlots" in case: assert disabled_from(case["manifest"]["payload"]["directives"]).slots == case["disabledSlots"], case["name"]
