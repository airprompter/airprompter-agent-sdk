"""One wire: with ``test_protocol_vectors.py`` (every vector passes), this proves the SDK speaks exactly protocol 3.x.
Parity with ``sdk-typescript/test/protocolSingleWire.test.ts``. Older majors are refused, any 3.x loads, the capability
registry has one source, the older shapes fail the schema, and every refused example is refused for the code it names.
Older literals are built here, so the repository's search for them stays clean.
"""

from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

from airprompter_agent_core import PROTOCOL_VERSION
from airprompter_agent_core.protocol.assignment import matches_audience, servable_experiments, servable_overrides, servable_slots, valid_audience_instant, valid_audience_manifest, valid_audience_minute, valid_audience_selector
from airprompter_agent_core.protocol.canonical_json import canonical_bytes
from airprompter_agent_core.protocol.capabilities import SUPPORTED_CAPABILITIES
from airprompter_agent_core.protocol.trust import SUPPORTED_PROTOCOL_MAJORS, experiment_conflict, key_thumbprint, sign_bytes, trusted_root_from_pinned_key, verify_manifest
from airprompter_agent_runtime.release.resolver import disabled_from
from airprompter_agent_core._util import iso_ms, now_ms

from airprompter_agent_core.ports import OS_FS
from airprompter_agent_telemetry.spool.manifest import write_segment_manifest

from .control_plane import FakeControlPlane

PROTOCOL = Path(__file__).resolve().parents[2] / "protocol"
SCOPE = {"organizationId": "org_1", "agentId": "agt_wire", "target": "prod"}
OLDER_FIELD = "".join(["onLease", "Expiry"])
VALIDATORS = {"manifest": "manifest", "key-set": "key-set", "bundle": "bundle", "heartbeat-request": "heartbeat#/$defs/request", "heartbeat-response": "heartbeat#/$defs/response", "edge-pointer": "edge-pointer", "store": "store", "daemon": "daemon", "spool-manifest": "spool-manifest"}


def promoted(**patch):
    plane = FakeControlPlane(SCOPE)
    base = plane.promote([plane.slot(tag="support.reply", text="Reply")])
    payload = {**base["payload"], **patch}
    return plane, {"payload": payload, "signatures": [{"keyId": key_thumbprint(plane.signing_key), "alg": "ES256", "sig": sign_bytes(canonical_bytes(payload), plane.signing_key)}]}


def verdict(made):
    plane, manifest = made
    return verify_manifest(manifest=manifest, root=plane.root, now=iso_ms(now_ms()), scope=SCOPE, stored_generation=0, payloads=None)


def schemas():
    documents = {path.name.replace(".schema.json", ""): json.loads(path.read_text(encoding="utf-8")) for path in (PROTOCOL / "schemas").glob("*.schema.json")}
    registry = Registry().with_resources((document["$id"], Resource.from_contents(document, default_specification=DRAFT202012)) for document in documents.values())

    def schema(name: str) -> Draft202012Validator:
        base, _, fragment = name.partition("#")
        document = {"$ref": f"{documents[base]['$id']}#{fragment}"} if fragment else documents[base]
        return Draft202012Validator(document, registry=registry, format_checker=Draft202012Validator.FORMAT_CHECKER)

    return schema


def example(path: str):
    return json.loads((PROTOCOL / "examples" / path).read_text(encoding="utf-8"))


def pointers(error) -> list[str]:
    """Every instance path an error and its branches name, as JSON pointers (what ajv reports with allErrors)."""
    own = "".join(f"/{part}" for part in error.absolute_path)
    return [own, *[pointer for child in error.context or [] for pointer in pointers(child)]]


def test_protocol_version_is_the_file_and_the_only_major_this_sdk_reads_is_3():
    assert PROTOCOL_VERSION == (PROTOCOL / "VERSION").read_text(encoding="utf-8").strip()
    assert list(SUPPORTED_PROTOCOL_MAJORS) == [3]


def test_older_majors_get_the_unsupported_major_refusal():
    for protocol in (".".join(["0", "3", "5"]), "2.0.0", "4.0.0", "3.0", "03.0.0", "3.0.0-rc.1", "3.0.0\n", "٣.0.0", "1" * 5000 + ".0.0"):
        result = verdict(promoted(protocol=protocol))
        assert (result.ok, result.reason) == (False, "protocol_unsupported"), protocol


def test_any_3x_loads_a_reader_checks_the_major_and_the_capabilities_never_the_minor():
    assert verdict(promoted(protocol="3.7.0")).ok is True
    assert verdict(promoted(protocol="3.0.0")).ok is True


def test_a_manifest_naming_a_capability_this_sdk_does_not_implement_is_refused_whole():
    result = verdict(promoted(requiredCapabilities=["guardrail_slots"]))
    assert (result.ok, result.reason, result.directives_stand) == (False, "protocol_unsupported", True)
    unhashable = verdict(promoted(requiredCapabilities=[["guardrail_slots"]]))
    assert (unhashable.ok, unhashable.reason) == (False, "protocol_unsupported"), "a refusal, never a TypeError"
    not_a_list = verdict(promoted(requiredCapabilities="guardrail_slots"))
    assert (not_a_list.ok, not_a_list.reason, not_a_list.directives_stand) == (False, "protocol_unsupported", False), "the shape is the envelope's"
    assert verdict(promoted(requiredCapabilities=[])).ok is True, "asking for nothing asks for nothing"


def test_a_manifest_without_observations_loads():
    made = promoted()
    assert "observations" not in made[1]["payload"]
    assert verdict(made).ok is True


def test_requires_must_be_a_list_of_implemented_capabilities_to_count_as_met():
    payload = {"slots": [None, "not a slot", {"tag": "unset"}, {"tag": "empty", "requires": []}, {"tag": "null", "requires": None}, {"tag": "text", "requires": "rubric_slots"}, {"tag": "blank", "requires": ""}, {"tag": "unknown", "requires": ["rubric_slots"]}, {"tag": "nested", "requires": [["rubric_slots"]]}]}
    assert [slot["tag"] for slot in servable_slots(payload)] == ["unset", "empty"]
    assert servable_slots({}) == [] and servable_slots({"slots": "abc"}) == []
    experiments = [{"experimentId": "a", "tag": "empty", "subjectKey": "request"}, {"experimentId": "b", "tag": "unknown", "subjectKey": "request"}, {"experimentId": "c", "tag": ["empty"]}, "not an experiment"]
    assert [experiment["experimentId"] for experiment in servable_experiments({**payload, "experiments": experiments})] == ["a"]


def test_an_override_with_an_unmet_requires_goes_alone():
    kept = {"tag": "a.b"}
    unmet = {"tag": "x.y", "requires": ["rubric_slots"]}
    payload = {"slots": [{"tag": "a.b"}], "experiments": [{"experimentId": "e", "tag": "a.b", "subjectKey": "request", "arms": [{"arm": "control", "overrides": []}, {"arm": "candidate", "overrides": [unmet, kept]}, "not an arm"]}]}
    [experiment] = servable_experiments(payload)
    assert experiment["arms"][1]["overrides"] == [kept], "only the unmet entry goes"
    assert servable_overrides({"overrides": "nope"}) == [] and servable_overrides(None) == []
    assert payload["experiments"][0]["arms"][1]["overrides"] == [unmet, kept], "the signed payload is left as it came"
    directives = {"directives": []}
    assert experiment_conflict({**payload, **directives}) is None, "an override of another tag this SDK cannot serve refuses nothing"
    wrong = {**payload, "experiments": [{**payload["experiments"][0], "arms": [{"arm": "candidate", "overrides": [{"tag": "x.y"}]}]}]}
    assert experiment_conflict({**wrong, **directives}) == "experiment_conflict", "the rule still holds for one it can"


def test_an_arm_disable_names_its_experiment_even_with_no_experiments():
    disable = {"kind": "disable", "scope": "arm", "arm": "candidate", "issuedAt": "2026-09-12T10:00:00Z"}
    assert experiment_conflict({"slots": [], "directives": [disable]}) == "experiment_conflict"
    assert experiment_conflict({"slots": [], "directives": [{**disable, "experimentId": 7}]}) == "experiment_conflict", "an id is a string, never coerced to one"
    assert experiment_conflict({"slots": [], "directives": [{**disable, "experimentId": "exp_gone"}]}) is None, "with no list there is nothing to name"
    assert experiment_conflict({"slots": [{"tag": "a.b"}], "experiments": [{"experimentId": "7", "tag": "a.b"}], "directives": [{**disable, "experimentId": 7}]}) == "experiment_conflict"
    disabled = disabled_from([{**disable, "experimentId": "e"}, disable])
    assert not hasattr(disabled, "arms"), "an arm always belongs to its experiment"
    assert (disabled.arms_for("e"), disabled.arms_for("other"), disabled.as_dict()["arms"]) == ({"candidate"}, set(), ["candidate"]), "the flat view stays for the heartbeat"


def test_malformed_input_is_refused_before_the_signature_and_never_raises():
    for patch in ({"experiments": [None]}, {"experiments": "x"}, {"slots": None}, {"protocol": 3}, {"protocol": None}, {"requiredCapabilities": None}):
        result = verdict(promoted(**patch))
        assert (result.ok, result.reason) == (False, "protocol_unsupported"), patch
    assert verdict(promoted(slots=[None, "x", 5])).ok is True, "an entry that is no slot is no slot"
    garbage = verdict(promoted(slots=[None, {"tag": "a.b", "requires": ["future_slots"]}], requiredCapabilities=["future_slots"]))
    assert (garbage.ok, garbage.directives_stand) == (False, True), "what it cannot read stands behind its capability"
    plane, manifest = promoted()
    forged = {**manifest, "signatures": [None, "x", *manifest["signatures"]]}
    assert verdict((plane, forged)).ok is True, "a junk signature entry is no signature"


def test_a_ramp_of_null_is_refused_and_an_absent_one_is_not():
    arms = [{"arm": "control", "weightBps": 10000, "overrides": []}, {"arm": "b", "weightBps": 0, "overrides": []}]
    plane = FakeControlPlane(SCOPE)
    slot = plane.slot(tag="support.reply", text="Reply")
    digest = plane.promote([slot])["payload"]["releaseDigest"]
    experiment = {"experimentId": "e", "tag": "support.reply", "salt": "AAECAwQFBgcICQoLDA0ODw", "subjectKey": "request", "arms": [{**arm, "releaseDigest": digest} for arm in arms]}

    def checked(entry):
        manifest = plane.promote([slot], experiments=[entry])
        return verify_manifest(manifest=manifest, root=plane.root, now=iso_ms(now_ms()), scope=SCOPE, stored_generation=0, payloads=None)

    assert checked(experiment).ok is True
    refused = checked({**experiment, "ramp": None})
    assert (refused.ok, refused.reason) == (False, "ramp_invalid")


def _manifest_payload(**patch):
    slot = {"tag": "a.b"}
    return {"protocol": "3.0.0", "releaseDigest": "sha256:" + "a" * 64, "slots": [slot, {"tag": "c.d", "requires": ["rubric_slots"]}], **patch}


OBSERVATION = {"audienceId": "aud_AAAAAAAAAAAAAAAAAAAAAA", "selector": {"mode": "all"}, "tag": "a.b", "observeFrom": "2026-09-12T14:00:00Z"}


def test_observations_are_optional_bounded_and_named_against_the_release():
    assert valid_audience_manifest(_manifest_payload()) is True
    assert valid_audience_manifest(_manifest_payload(observations=[OBSERVATION])) is True
    assert valid_audience_manifest(_manifest_payload(observations=[])) is False, "1..8 when present"
    assert valid_audience_manifest(_manifest_payload(observations=[{**OBSERVATION, "audienceId": f"aud_{chr(65 + i) * 22}"} for i in range(9)])) is False, "1..8 when present"
    assert valid_audience_manifest(_manifest_payload(observations=None)) is False
    assert valid_audience_manifest(_manifest_payload(observations=[{**OBSERVATION, "tag": "x.y"}])) is False, "one naming no slot at all is refused"
    assert valid_audience_manifest(_manifest_payload(observations=[{"tag": "c.d", "selector": "never read"}])) is True, "one on a skipped slot is skipped with it"
    assert valid_audience_manifest(_manifest_payload(observations=["not an observation"])) is False
    assert valid_audience_manifest(_manifest_payload(experiments=[{"tag": "c.d", "audience": "never read"}])) is True, "an experiment on a skipped slot is skipped"
    arms = [{"arm": "control", "weightBps": 5000, "releaseDigest": "sha256:" + "a" * 64, "overrides": []}, {"arm": "candidate", "weightBps": 5000, "releaseDigest": "sha256:" + "b" * 64, "overrides": []}]
    assert valid_audience_manifest(_manifest_payload(experiments=[{"tag": "a.b", "subjectKey": "request", "arms": arms}])) is True, "no audience: a fleet-wide experiment"
    for bad in ([{**arms[0], "weightBps": 6000}, arms[1]], [arms[0]], [{**arms[0], "releaseDigest": "sha256:" + "c" * 64}, arms[1]], [{**arms[0], "overrides": [{"tag": "a.b"}]}, arms[1]], [arms[0], {**arms[1], "overrides": [{"tag": "a.b"}, {"tag": "a.b"}]}], [arms[0], {**arms[1], "arm": "control"}], [arms[0], {**arms[1], "arm": "Not A Name"}]):
        assert valid_audience_manifest(_manifest_payload(experiments=[{"tag": "a.b", "subjectKey": "request", "arms": bad}])) is False, f"arm checks run with no audience too: {bad}"
    assert valid_audience_manifest(_manifest_payload(experiments=[{"tag": "a.b", "subjectKey": "request", "arms": [arms[0], {**arms[1], "overrides": [{"tag": "a.b"}, {"tag": "x.y", "requires": ["rubric_slots"]}]}]}])) is True, "on the overrides it can serve"
    targeted = {"tag": "a.b", "subjectKey": "request", "arms": arms, "audience": {"audienceId": OBSERVATION["audienceId"], "selector": OBSERVATION["selector"]}}
    assert valid_audience_manifest(_manifest_payload(observations=[OBSERVATION], experiments=[targeted])) is True
    assert valid_audience_manifest(_manifest_payload(experiments=[targeted])) is False, "an audience must match an observation"
    other = {**targeted, "audience": {**targeted["audience"], "selector": {"mode": "when", "when": {"key": "a", "is": "b"}}}}
    assert valid_audience_manifest(_manifest_payload(observations=[OBSERVATION], experiments=[other])) is False, "the same selector on both"


def test_instants_and_minutes_are_ascii_digits_as_javascript_reads_them():
    assert valid_audience_instant("2026-09-12T14:00:00Z") is True
    assert valid_audience_minute("2026-09-12T14:00:00Z") is True
    assert valid_audience_instant("٢٠٢٦-09-12T14:00:00Z") is False
    assert valid_audience_minute("٢٠٢٦-09-12T14:00:00Z") is False


def test_a_condition_is_held_to_the_same_rules_as_javascript_reads_them():
    when = lambda condition: {"mode": "when", "when": condition}  # noqa: E731
    assert valid_audience_selector(when({"key": "😀" * 64, "is": "😀" * 256})) is True, "length counts code points"
    assert valid_audience_selector(when({"key": "😀" * 65, "is": "x"})) is False
    for bad in ({"key": "a\ud800", "is": "x"}, {"key": "a", "is": "\ud800"}, {"key": "a", "contains": ""}, {"key": "a", "in": [["x"]]}, {"key": "a", "in": ["x", "x"]}, {"key": "a", "in": []}, {"key": "a", "range": {}}, {"key": "a", "range": {"gte": True}}, {"key": "a", "range": {"gte": 1.5}}, {"key": "a", "range": {"lt": 2**53}}, {"key": "a", "range": {"gte": 10**400}}, {"key": "a", "range": {"lt": float("inf")}}, {"key": "a", "range": {"gt": 1}}, {"key": "a", "is": "x", "contains": "x"}):
        assert valid_audience_selector(when(bad)) is False, repr(bad)
    deep = {"key": "a", "is": "x"}
    for _ in range(3):
        deep = {"not": deep}
    assert valid_audience_selector(when(deep)) is True, "a leaf is depth 1; depth 4 is the limit"
    assert valid_audience_selector(when({"not": deep})) is False
    leaves = {"all": [{"any": [{"key": "a", "is": str(i * 16 + j)} for j in range(16)]} for i in range(2)]}
    assert valid_audience_selector(when(leaves)) is True, "32 leaves"
    assert valid_audience_selector(when({"all": [*leaves["all"], {"key": "a", "is": "x"}]})) is False, "33 leaves"
    assert valid_audience_selector(when({"key": "a", "range": {"gte": 2.0, "lt": 2**53 - 1}})) is True, "an integer, however JSON spelled it"
    at_least = when({"key": "n", "range": {"gte": 2, "lt": 3}})
    assert matches_audience(at_least, {"n": "2"}) and matches_audience(at_least, {"n": "2.5"}) and matches_audience(at_least, {"n": "-0"}) is False
    for value in ("3", "١", "٢", "2e0", "0x2", " 2", "2.", ".5", "+2", "Infinity", "1" * 256):
        assert matches_audience(at_least, {"n": value}) is False, value
    assert matches_audience(when({"not": {"key": "n", "is": "x"}}), {}) is True, "a missing key is false for every leaf, so its negation holds"


def test_the_capability_registry_has_one_source_capabilities_md_equals_supported_capabilities():
    table = (PROTOCOL / "capabilities.md").read_text(encoding="utf-8").split("## Registry")[1]
    rows = [line for line in table.split("\n") if line.startswith("|")][2:]
    names = [row.split("|")[1].strip().replace("`", "") for row in rows]
    assert sorted(names) == sorted(SUPPORTED_CAPABILITIES)
    assert len(SUPPORTED_CAPABILITIES) == 0, "3.0.0 ships the registry empty"


def test_the_older_shapes_fail_the_manifest_schema_and_a_heartbeat_with_no_capabilities_validates():
    schema = schemas()
    manifest = schema("manifest")
    good = example("manifest.json")
    assert manifest.is_valid(good), "the example validates"
    assert not manifest.is_valid({**good, "payload": {**good["payload"], OLDER_FIELD: "degrade"}}), "the lease setting is gone"
    assert not manifest.is_valid({**good, "payload": {**good["payload"], "experiment": good["payload"]["experiments"][0]}}), "the single experiment is gone"
    without_audience = {key: value for key, value in good["payload"].items() if key != "observations"}
    without_audience["experiments"] = [{key: value for key, value in experiment.items() if key != "audience"} for experiment in good["payload"]["experiments"]]
    assert manifest.is_valid({**good, "payload": without_audience}), "observations are optional"
    assert manifest.is_valid({**good, "payload": {**good["payload"], "protocol": "3.7.0"}}), "any 3.x"
    heartbeat = schema("heartbeat#/$defs/request")
    request = example("heartbeat.request.json")
    assert request["capabilities"] == []
    assert heartbeat.is_valid(request)
    assert heartbeat.is_valid({**request, "runCounters": {"passthrough": {"no_slot": 3, "slot_disabled": 1}}}), "an open map"
    assert not heartbeat.is_valid({**request, "runCounters": {"passthrough": {"Not A Key": 1}}})
    assert not heartbeat.is_valid({**request, "capabilities": ["Not_A_Name"]})
    assert not heartbeat.is_valid({**request, "capabilities": [f"cap_{i}" for i in range(33)]}), "at most 32"


def test_a_heartbeat_this_sdk_builds_validates(tmp_path):
    from airprompter_agent import AirPrompterAgent
    from airprompter_agent.agent import SyncOptions
    from airprompter_agent_core.protocol.trust import public_jwk_of

    plane = FakeControlPlane(SCOPE)
    plane.promote([plane.slot(tag="support.reply", text="Reply")])
    ap = AirPrompterAgent.start(organization_id="org_1", agent_id="agt_wire", target="prod", api_key=plane.api_key, base_url="https://api.test", state_dir=str(tmp_path), root={"pinned": public_jwk_of(plane.root_key)}, sync=SyncOptions(mode="on_invoke", root_url="https://edge.test/roots/prod/root.json"), transport=plane.transport(), telemetry={"sink": "memory"}, tags={"plan": "team"})
    try:
        ap.prompt("support.reply", display_name="Support reply").render()
        body = ap.heartbeat_body()
        assert [error.message for error in schemas()("heartbeat#/$defs/request").iter_errors(body)] == []
        assert (body["capabilities"], body["runCounters"]) == ([], {"passthrough": {}})
        assert body["registration"]["tagKeys"] == ["plan"] and body["catalog"]["variables"] == []
        (tmp_path / "seg-i-writerAAAAAAAA-1-0.ndjson").write_bytes(b"{}\n")
        manifest_doc = write_segment_manifest(OS_FS, str(tmp_path), "seg-i-writerAAAAAAAA-1-0.ndjson", organization_id=SCOPE["organizationId"], agent_id=SCOPE["agentId"], target=SCOPE["target"], report=body, closed_at_ms=now_ms())
        assert [error.message for error in schemas()("spool-manifest").iter_errors(manifest_doc)] == [], "a closed segment's report holds what the heartbeat requires, less the spool"
    finally:
        ap.stop()


def test_a_target_is_a_slug_in_every_schema_that_names_one_and_a_deployment_stays_one_of_three():
    schema = schemas()
    manifest = schema("manifest")
    good = example("manifest.json")
    assert manifest.is_valid({**good, "payload": {**good["payload"], "target": "qa"}})
    for target in ("Prod", "1st", "", "a" * 33, "with_underscore"):
        assert not manifest.is_valid({**good, "payload": {**good["payload"], "target": target}}), target
    keys = example("key-set.json")
    key_set = schema("key-set")
    assert key_set.is_valid(keys)
    assert keys["signed"]["purpose"] == "platform"
    assert not key_set.is_valid({**keys, "signed": {**keys["signed"], "environment": "qa"}}), "a platform root names a deployment, never a stage"
    countersign = {**keys, "signed": {**keys["signed"], "purpose": "countersign"}}
    assert key_set.is_valid({**countersign, "signed": {**countersign["signed"], "environment": "qa"}}), "a countersign root may name any stage"
    assert key_set.is_valid({**countersign, "signed": {**countersign["signed"], "environment": "prod"}})
    assert not key_set.is_valid({**countersign, "signed": {**countersign["signed"], "environment": "Not A Slug"}}), "a slug, still"
    for purpose, environment in (("platform", "prod"), ("countersign", "qa")):
        pinned = trusted_root_from_pinned_key(purpose=purpose, environment=environment, pinned_root=FakeControlPlane(SCOPE).root_key)["signed"]
        assert (pinned["purpose"], pinned["environment"]) == (purpose, environment)
    assert schema("store").is_valid({**example("store.v2.json"), "target": "qa"})
    assert schema("daemon").is_valid({**example("daemon.json"), "target": "qa"})
    assert schema("spool-manifest").is_valid({**example("spool-manifest.json"), "target": "qa"})


def test_every_refused_example_is_refused_for_the_code_it_names():
    schema = schemas()
    plane = FakeControlPlane(SCOPE)
    files = sorted((PROTOCOL / "examples" / "refused").glob("*.json"))
    assert len(files) >= 30
    for file in files:
        entry = json.loads(file.read_text(encoding="utf-8"))
        errors = list(schema(VALIDATORS[entry["schema"]]).iter_errors(entry["document"]))
        assert errors, f"{file.name}: accepted"
        assert any(pointer.startswith(entry["at"]) for error in errors for pointer in pointers(error)), f"{file.name}: refused elsewhere than {entry['at']}"
        if entry["code"] == "schema_invalid":
            continue
        # A code an SDK answers with: sign the document so the check under test, not the placeholder signature, decides.
        payload = {**entry["document"]["payload"], "organizationId": SCOPE["organizationId"], "agentId": SCOPE["agentId"], "target": SCOPE["target"]}
        manifest = {"payload": payload, "signatures": [{"keyId": key_thumbprint(plane.signing_key), "alg": "ES256", "sig": sign_bytes(canonical_bytes(payload), plane.signing_key)}]}
        result = verify_manifest(manifest=manifest, root=plane.root, now="2026-09-12T12:00:00Z", scope=SCOPE, stored_generation=0, payloads=None)
        assert (result.ok, result.reason) == (False, entry["code"]), file.name


def test_run_counters_passthrough_stays_flat_a_new_family_takes_identifiers_and_free_text_never_validates():
    request = schemas()("heartbeat#/$defs/request")
    good = example("heartbeat.request.json")
    counters = lambda run_counters: request.is_valid({**good, "runCounters": run_counters})  # noqa: E731
    assert counters({"passthrough": {"no_slot": 1}})
    assert not counters({"passthrough": {"no-slot": 1}}), "passthrough keeps its key pattern"
    assert not counters({"passthrough": {"no_slot": {"nested": 1}}}), "passthrough is flat"
    assert counters({"passthrough": {}, "experiments": {"exp-rollout-1": 3, "nested": {"a.b:c": 1}}}), "a family takes the identifier pattern"
    assert not counters({"passthrough": {}, "experiments": {"name": "free text"}}), "free text never validates"
    assert not counters({"passthrough": {}, "not an id": 1})
    assert not counters({"passthrough": {f"reason_{i}": 1 for i in range(65)}}), "a bound on passthrough"
    assert not counters({"passthrough": {}, "experiments": {f"e{i}": 1 for i in range(257)}}), "a bound on a family"
