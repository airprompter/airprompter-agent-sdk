"""The one distribution and what sits beside it, Python mirror of ``sdk-typescript/test/packageShape.test.ts``.

1. The direction is core → sync, runtime, telemetry → agent, and a layer is reached only through its package; the edge
   set is pinned; a planted sideways or deep import fails the lint.
2. ``airprompter_agent.runtime`` renders and assigns over a bundle the customer loads, verified like OTA: no store, no
   daemon, no network; a relabelled, stranger-signed or tampered bundle is refused.
3. The runtime walks the protocol's ramp vectors over a bundle release with no agent.
4. The distributions carry one version with ``airprompter-agent`` exact-pinned, the lockstep check says so, and
   ``SDK_VERSION`` is that version. No removed distribution or module name is left under ``sdk-python/``.
5. Each layer's ``__all__`` is exactly what is pinned here, so a name reaches a layer's public list on purpose.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import os
import re
import subprocess
import sys

import pytest

from airprompter_agent.core._util import b64url_encode, instant, iso_ms
from airprompter_agent.core.bundle.apbundle import create_plaintext_bundle
from airprompter_agent.core.protocol.trust import public_jwk_of, trusted_root_from_pinned_key, release_digest
from airprompter_agent.core.release.bundle_release import BundleRelease, BundleReleaseRefused
from airprompter_agent.runtime.release.resolver import ReleaseResolver

from .control_plane import FakeControlPlane

HERE = os.path.dirname(__file__)
SDK_PY = os.path.abspath(os.path.join(HERE, ".."))
SCOPE = {"organizationId": "org_1", "agentId": "agt_split", "target": "prod"}
NOW = "2026-09-13T00:00:00Z"
SATELLITES = ["agent-otel", "datastore-s3", "datastore-postgres", "datastore-redis"]
PACKAGES = ["agent", *SATELLITES]
SRC = os.path.join(SDK_PY, "packages", "agent", "src", "airprompter_agent")
#: Each layer's public list, sorted. A public name is a promise: change this on purpose.
LAYER_ALL = {
    "core": ["AGENT_ID", "APBUNDLE_INFO", "ASSIGNMENT_MODULUS", "AUDIENCE_LIMITS", "Assignment", "AssignmentError", "BundleError", "BundleRelease", "BundleReleaseRefused", "CHECK_BOUNDS", "CanonicalJsonError", "ClockPort", "Delimiters", "DistributionKey", "ERROR_CLASSES", "FsPort", "GOLDEN_SET_FORMAT", "GOLDEN_SET_VERSION", "GoldenCaseResult", "GoldenInvocation", "GoldenInvoke", "GoldenReport", "GoldenSetError", "JUDGE_RUBRICS", "JudgeResult", "JudgeRubric", "LATENCY_BUCKET_EDGES_MS", "LoadedRelease", "MissingVariableError", "NormalizedFeedback", "OS_FS", "Observation", "OsFs", "PROTECTION_CRITERIA", "PROTOCOL_VERSION", "RAMP_MAX_STEPS", "RAMP_MIN_STEP_MS", "RUN_REF_MAX_ENTRIES", "RUN_REF_MAX_TOKEN_LENGTH", "RUN_REF_READ_MAX_ENTRIES", "RUN_REF_READ_MAX_TOKEN_LENGTH", "ReleaseReader", "ReleaseSlot", "RunDimensions", "RunRefFacts", "RunTotals", "SDK_VERSION", "SLOT_TAG", "STEP_BOUNDS", "STEP_STATUSES", "SUPPORTED_CAPABILITIES", "SUPPORTED_PROTOCOL_MAJORS", "SYSTEM_CLOCK", "SpoolRow", "StepError", "StepTotals", "SyncClient", "SystemClock", "TARGET_SLUG", "UNDEFINED", "USAGE_SOURCES", "UnknownVariableError", "UploadOutcome", "UploadSegment", "UploadSink", "Verdict", "WINDOW_STATUSES", "X25519KeyPair", "arm_for_bucket", "assign_arm", "bucket_from_hash", "bundle_payload_bytes", "canonical_bytes", "canonical_json", "capabilities_implemented", "captured_audience_ids", "carried_payloads", "check_refusal", "checks_refusals", "copy_audience_tags", "count_of", "create_encrypted_bundle", "create_plaintext_bundle", "default_of", "distribution_key_id", "effective_arms", "epoch_minute", "estimate_tokens", "evaluate_check", "evaluate_checks", "frozen_experiment", "fs_failure_code", "fs_or_default", "generate_p256_jwk", "generate_x25519_key_pair", "golden_reports_meet", "instant", "judge_prompt", "judge_signals_of", "key_thumbprint", "latency_bucket_index", "manifest_has_golden", "matches_audience", "mint_run_ref", "minute_of", "new_run_id", "normalize_feedback", "open_bundle", "optional_payloads", "ordered_steps", "output_text_of", "parse_golden_set", "parse_judge_reply", "parse_run_ref", "pass_bps_of", "pattern_refusal", "placeholders_of", "project_checks", "public_jwk_of", "ramp_weights_at", "referenced_payloads", "release_digest", "release_digest_input", "render_template", "rubric_from_prompt", "run_golden_set", "run_ref_key_from", "servable_experiments", "servable_overrides", "servable_slots", "sha256_prefixed", "sign_bytes", "sink_status", "slot_hashes", "step_name", "subject_hash", "trusted_root_from_pinned_key", "utf16_length", "valid_audience_ids", "valid_audience_label", "valid_audience_manifest", "valid_audience_minute", "valid_audience_selector", "valid_step_name", "validate_arms", "validate_json_schema", "validate_ramp", "value_at_path", "verify_bytes", "verify_manifest", "verify_root_metadata", "x25519_private_key_from_raw", "x25519_public_key_from_raw", "xml_delimiters"],
    "sync": ["DATASTORE_FORMAT", "DEFAULT_MAX_POINTER_AGE_MS", "DatastoreKeys", "DatastoreRecordError", "DatastoreRollbackResult", "FileKvStore", "HydrationPlan", "KeyProvider", "KvEntry", "KvReleaseDatastore", "KvStore", "KvStoreReport", "LoadedSlot", "MemoryKvStore", "MemoryReleaseDatastore", "PayloadDecryptError", "PullBundleResult", "PullEdgeState", "PullToDatastoreResult", "ReleaseControl", "ReleaseDatastore", "ReleaseKey", "SlotStore", "StoreError", "StoreHooks", "StoredReleaseRow", "SyncPassOutput", "UpdateWindow", "WindowState", "check_kv_store", "clear_datastore_rollback", "custom_key_provider", "datastore_keys", "decode_datastore_record", "decrypt_payload", "encode_datastore_record", "encode_key_segment", "encrypt_payload", "file_key", "generation_of_release_key", "is_known_time_zone", "jittered_delay_ms", "kms", "kv_release_datastore", "next_pull_delay_ms", "os_keystore", "parse_window", "payload_aad", "prune_datastore", "pull_bundle", "pull_to_datastore", "required_models_missing", "resolve_hydration", "rollback_datastore", "rollout_of", "sync_once", "unwrap_with_raw_key", "validate_window", "vault", "window_state", "wrap_with_raw_key"],
    "runtime": ["AppliedInference", "Attribution", "DEFAULT_SOURCE_MAX_BYTES", "DEFAULT_SOURCE_TIMEOUT_SECONDS", "Disabled", "FillPlan", "Filled", "FilledRender", "INFERENCE_KEYS", "MANAGED_REFUSAL_CODES", "MANAGED_SDK_USER_AGENT", "ManagedAgent", "ManagedRunError", "ManagedRunResult", "ManagedRunStream", "ManagedWorkflow", "ObserveTarget", "PendingObservation", "RegisteredSource", "ReleaseResolver", "RenderRegistry", "RenderValues", "Rendered", "ResolveOutcome", "UsageNormalized", "VariableSource", "VariableSourceContext", "VariableSourceError", "VariableSourceInput", "VariableSourceRegistry", "VariableSourceRequiredError", "WRAPPED_METHODS", "Workflow", "WorkflowStep", "WrapHooks", "apply_inference", "attribution_scope", "classify_error", "classify_result", "copy_inference", "current_attribution", "disabled_from", "fill_async", "fill_sync", "is_variable_source_error", "is_variable_source_required_error", "normalize_usage", "observe_call", "observe_call_async", "parse_sse", "plan_fill", "request_texts", "stricter_sources", "supplied", "temperature_of", "top_p_of", "unsourced", "wrap_client"],
    "telemetry": ["AirPrompterUploadSink", "DAEMON_DISCOVERY_FILE", "DAEMON_DISCOVERY_FORMAT", "DAEMON_DISCOVERY_MAX_AGE_MS", "DAEMON_DISCOVERY_REFRESH_MS", "DirectorySink", "ERROR_CLASSES", "GrantDecision", "HOST_SPOOL_BUDGET_BYTES", "LATENCY_BUCKET_EDGES_MS", "MANIFEST_GRACE_MS", "MANIFEST_NAME", "MANIFEST_SUFFIX", "MemorySink", "Observation", "PassResult", "RunDimensions", "RunTotals", "SEGMENT_MAX_BYTES", "SERVERLESS_BUFFER_BYTES", "SPOOL_MANIFEST_FORMAT", "SegmentPlanner", "SpoolRow", "SpoolSink", "SpoolUploader", "SpoolWriter", "StepTotals", "UploadGrant", "WriterIdentity", "backoff_delay_ms", "daemon_discovery_path", "epoch_minute", "inspect_segment", "latency_bucket_index", "manifest_name_of", "minute_of", "post_segment", "read_daemon_discovery", "read_segment_manifest", "remove_daemon_discovery", "segment_name", "segment_name_of_manifest", "sha256_hex", "validate_spool_row", "write_daemon_discovery", "write_segment_manifest"],
}


def bundle_of(plane: FakeControlPlane, not_after: str = "2027-01-01T00:00:00Z") -> dict:
    return create_plaintext_bundle({"createdAt": iso_ms(instant(NOW)), "notAfter": not_after, "manifest": plane.manifest, "keySet": plane.root, "payloads": [{"contentHash": h, "byteLength": len(b), "bytes": b64url_encode(b)} for h, b in plane.payloads.items()]})


def pinned(plane: FakeControlPlane) -> dict:
    return trusted_root_from_pinned_key(purpose="platform", environment="prod", pinned_root=public_jwk_of(plane.root_key))


def lint(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, os.path.join(SDK_PY, "tools", "lint_imports.py"), *args], capture_output=True, text=True)


def planted(path: str, source: str) -> subprocess.CompletedProcess:
    with open(path, "w", encoding="utf-8") as f:
        f.write(source)
    try:
        return lint()
    finally:
        os.unlink(path)


def test_direction_is_pinned_and_a_planted_upward_or_deep_import_fails_the_lint():
    clean = lint("--json")
    assert clean.returncode == 0, clean.stderr
    edges = json.loads(clean.stdout[: clean.stdout.rindex("}") + 1])["edges"]
    assert edges == ["agent-otel→core", "agent→core", "agent→runtime", "agent→sync", "agent→telemetry", "datastore-postgres→core", "datastore-postgres→sync", "datastore-redis→core", "datastore-redis→sync", "datastore-s3→core", "datastore-s3→sync", "runtime→core", "sync→core", "telemetry→core"]
    upward = planted(os.path.join(SRC, "telemetry", "_lint_probe.py"), "from airprompter_agent.sync import SlotStore\nPROBE = SlotStore\n")
    assert upward.returncode == 1
    assert "telemetry (layer 1) may not import sync (layer 1)" in upward.stderr
    deep = planted(os.path.join(SRC, "sync", "_lint_probe.py"), "from airprompter_agent.core.protocol.trust import verify_manifest\nPROBE = verify_manifest\n")
    assert deep.returncode == 1, "a path past the layer's package is refused even when the direction is right"
    assert "reaches into core by path" in deep.stderr
    relative = planted(os.path.join(SRC, "sync", "_lint_probe.py"), "from ..core.protocol.trust import verify_manifest\nPROBE = verify_manifest\n")
    assert relative.returncode == 1, "a relative import is held to the same rule"
    assert "reaches into core by path" in relative.stderr
    agent = planted(os.path.join(SRC, "runtime", "_lint_probe.py"), "from airprompter_agent import AirPrompterAgent\nPROBE = AirPrompterAgent\n")
    assert agent.returncode == 1, "a layer never imports the agent"
    satellite = planted(os.path.join(SDK_PY, "packages", "agent-otel", "src", "airprompter_agent_otel", "_lint_probe.py"), "from airprompter_agent.telemetry.uploader import SpoolUploader\nPROBE = SpoolUploader\n")
    assert satellite.returncode == 1, "a satellite imports a layer's package, never a module inside it"


def test_runtime_renders_and_assigns_over_a_bundle_and_refuses_what_the_chain_refuses():
    plane = FakeControlPlane(SCOPE)
    control = plane.slot(tag="support.reply", text="Reply A to {{name}}", version_id="v1", variables=[{"name": "name", "required": True, "trust": "operator"}])
    candidate = plane.slot(tag="support.reply", text="Reply B to {{name}}", version_id="v2", variables=[{"name": "name", "required": True, "trust": "operator"}])
    plane.promote([control], experiments=[{"tag": control["tag"], "experimentId": "exp_1", "salt": "c2FsdHNhbHRzYWx0c2FsdHNhbHQ", "subjectKey": "request", "arms": [{"arm": "control", "weightBps": 5000, "releaseDigest": release_digest([control]), "overrides": []}, {"arm": "candidate", "weightBps": 5000, "releaseDigest": "sha256:" + "1" * 64, "overrides": [candidate]}]}])
    bundle = bundle_of(plane)
    loaded = BundleRelease.load(bundle=bundle, root=pinned(plane), scope=SCOPE, now=NOW)
    assert loaded.kind == "bundle"
    resolver = ReleaseResolver(release=loaded.current(), run_ref_key=b"\x07" * 32, agent_id=SCOPE["agentId"], target="prod", instance_id="host-1", now_ms=lambda: instant(NOW))
    seen = set()
    for i in range(100):
        outcome = resolver.resolve("support.reply", f"user-{i}")
        assert outcome.ok and outcome.slot is not None
        rendered = resolver.render(outcome.slot, {"name": "Ada"})
        assert rendered.text in ("Reply A to Ada", "Reply B to Ada")
        assert (rendered.arm == "candidate") == rendered.text.startswith("Reply B"), "the arm's override is the text"
        seen.add(rendered.arm)
    assert seen == {"candidate", "control"}, "a 50/50 split lands on both arms"
    missing = resolver.resolve("nope")
    assert (missing.ok, missing.reason, missing.tag) == (False, "no_slot", "nope")
    # The chain still stands: another agent's bundle, a stranger's root, a tampered payload.
    with pytest.raises(BundleReleaseRefused) as relabelled:
        BundleRelease.load(bundle=bundle, root=pinned(plane), scope={**SCOPE, "agentId": "agt_other"}, now=NOW)
    assert relabelled.value.reason == "bundle_relabelled"
    with pytest.raises(BundleReleaseRefused) as stranger:
        BundleRelease.load(bundle=bundle, root=pinned(FakeControlPlane(SCOPE)), scope=SCOPE, now=NOW)
    assert stranger.value.reason == "unknown_signing_key"
    tampered = json.loads(json.dumps(bundle))
    tampered["encryption"]["contents"]["payloads"][0]["bytes"] = b64url_encode(b"Reply Z to {{name}}")
    with pytest.raises(BundleReleaseRefused) as bad:
        BundleRelease.load(bundle=tampered, root=pinned(plane), scope=SCOPE, now=NOW)
    assert bad.value.reason == "payload_hash_mismatch"


def test_runtime_walks_the_ramp_vectors_over_a_bundle_release_with_no_agent():
    with open(os.path.join(HERE, "..", "..", "protocol", "vectors", "ramp.json"), encoding="utf-8") as f:
        vectors = json.load(f)
    for case in vectors["cases"]:
        plane = FakeControlPlane(SCOPE)
        control = plane.slot(tag="support.reply", text="A", version_id="v1", variables=[])
        candidate = plane.slot(tag="support.reply", text="B", version_id="v2", variables=[])
        arms = [{"arm": a["arm"], "weightBps": a["weightBps"], "releaseDigest": release_digest([control]), "overrides": [candidate] if a["arm"] == "candidate" else []} for a in case["arms"]]
        plane.promote([control], experiments=[{"tag": control["tag"], "experimentId": "exp_ramp", "salt": case["salt"], "subjectKey": "request", "arms": arms, "ramp": case["ramp"]}], directives=[{**d, "issuedAt": d.get("issuedAt", "2026-09-14T00:00:00Z")} for d in case["directives"]])
        loaded = BundleRelease.load(bundle=bundle_of(plane), root=pinned(plane), scope=SCOPE, now=NOW)

        def at(now: str, field: str) -> None:
            resolver = ReleaseResolver(release=loaded.current(), run_ref_key=b"\x01" * 32, agent_id=SCOPE["agentId"], target="prod", instance_id="host", now_ms=lambda: instant(now))
            for entry in case["expected"]["assignments"]:
                outcome = resolver.resolve("support.reply", entry["subject"])
                assert outcome.ok and outcome.slot is not None, f"{case['name']}: {entry['subject']}"
                assert (outcome.slot.bucket, outcome.slot.arm) == (entry["bucket"], entry[field]), f"{case['name']}: {entry['subject']} at {now}"

        if case.get("hosts"):
            at(case["hosts"]["hostA"]["now"], "hostA")
            at(case["hosts"]["hostB"]["now"], "hostB")
        else:
            at(case["now"], "arm")


def pyproject(name: str) -> str:
    with open(os.path.join(SDK_PY, "packages", name, "pyproject.toml"), encoding="utf-8") as f:
        return f.read()


def declared_version(text: str) -> str:
    return text.split('version = "', 1)[1].split('"', 1)[0]


def test_one_version_and_sdk_version_is_it_and_satellites_pin_the_agent_exactly():
    result = subprocess.run([sys.executable, os.path.join(SDK_PY, "tools", "version_lockstep.py")], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    versions = {declared_version(pyproject(name)) for name in PACKAGES}
    assert len(versions) == 1
    version = next(iter(versions))
    # The version the heartbeat and store.json report is the version that shipped: read from metadata, equal to pyproject.
    from airprompter_agent.agent import SDK_VERSION as agent_version
    from airprompter_agent.core import SDK_VERSION as core_version

    assert {core_version, agent_version} == versions, "SDK_VERSION is the installed distribution's version, which is pyproject's"
    # BSD-3-Clause travels with every redistribution: each distribution carries the licence text (hatchling packs LICENSE*).
    with open(os.path.join(SDK_PY, "..", "LICENSE"), encoding="utf-8") as f:
        licence = f.read()
    for name in PACKAGES:
        with open(os.path.join(SDK_PY, "packages", name, "LICENSE"), encoding="utf-8") as f:
            assert f.read() == licence, f"packages/{name}/LICENSE is the repository's LICENSE"
    agent = pyproject("agent")
    deps = agent.split("dependencies = [", 1)[1].split("]", 1)[0]
    assert sorted(line.strip().strip('",').split(">")[0] for line in deps.splitlines() if line.strip()) == ["cryptography", "httpx"], "no third-party dependency beyond httpx and cryptography"
    # httpx's 1.0 prereleases drop `timeout` from Client, and start() needs it: `--pre` must not reach them.
    for name in ("agent", "agent-otel"):
        assert '"httpx>=0.27,<1"' in pyproject(name), f"{name} bounds httpx below 1.0"
    for extra in ("kms", "vault", "keyring", "openai", "anthropic", "litellm"):
        assert f"\n{extra} = [" in agent, f"the {extra} extra lives on the one distribution"
    for name in SATELLITES:
        text = pyproject(name)
        assert f'name = "airprompter-{name}"' in text
        deps = text.split("dependencies = [", 1)[1].split("]", 1)[0]
        ours = [line.strip().strip('",') for line in deps.splitlines() if "airprompter" in line]
        assert ours == [f"airprompter-agent=={version}"], f"{name} pins the agent exactly, so one copy resolves"
    # The datastore adapters never require a database client.
    for name in ("datastore-s3", "datastore-postgres", "datastore-redis"):
        deps = pyproject(name).split("dependencies = [", 1)[1].split("]", 1)[0]
        assert [line.strip().strip('",') for line in deps.splitlines() if line.strip()] == [f"airprompter-agent=={version}"], f"{name} depends on the agent alone"


@pytest.mark.parametrize("answer", ["raise m.PackageNotFoundError('airprompter-agent')", "return None", "raise OSError('unreadable')"], ids=["no-metadata", "dist-info-with-no-METADATA", "unreadable"])
def test_a_build_with_no_usable_metadata_still_imports(answer):
    # Copied source (a frozen build, a bare PYTHONPATH) has no dist-info, and a dist-info with no METADATA answers None. A
    # version must not stop the SDK importing, or put None on the heartbeat.
    code = f"import importlib.metadata as m\ndef missing(_):\n    {answer}\nm.version = missing\nimport airprompter_agent.core as c\nprint(c.SDK_VERSION)"
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "0+unknown"


def test_each_distribution_ships_one_top_level_package():
    spec = importlib.util.spec_from_file_location("build_all", os.path.join(SDK_PY, "tools", "build_all.py"))
    build_all = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build_all)
    assert build_all.WHEEL_TOP_LEVEL == {"agent": "airprompter_agent", "agent-otel": "airprompter_agent_otel", "datastore-s3": "airprompter_datastore_s3", "datastore-postgres": "airprompter_datastore_postgres", "datastore-redis": "airprompter_datastore_redis"}
    assert set(build_all.WHEEL_TOP_LEVEL) == set(PACKAGES), "build_all checks every distribution's wheel"
    for name, top_level in build_all.WHEEL_TOP_LEVEL.items():
        assert f'packages = ["src/{top_level}"]' in pyproject(name), f"{name} ships {top_level} and nothing else"


def test_each_layer_public_list_is_pinned():
    for layer, expected in LAYER_ALL.items():
        module = importlib.import_module(f"airprompter_agent.{layer}")
        assert sorted(module.__all__) == expected, f"airprompter_agent.{layer}.__all__ moved: a public name is a promise, so change this list on purpose"
        assert not [name for name in expected if not hasattr(module, name)], f"{layer} lists a name it does not have"
    # Small helpers stay internal: `core._util` is the one module the lint lets another layer name.
    helpers = {"b64url_decode", "b64url_encode", "fsync_dir", "iso_ms", "iso_seconds", "now_ms", "random_id", "check_condition"}
    import airprompter_agent

    for module in [airprompter_agent, *(importlib.import_module(f"airprompter_agent.{layer}") for layer in LAYER_ALL)]:
        assert not helpers & set(module.__all__), f"{module.__name__} lists an internal helper"
    # `from airprompter_agent import *` raises AttributeError on a listed name that is not there.
    assert not [name for name in airprompter_agent.__all__ if not hasattr(airprompter_agent, name)], "the root lists a name it does not have"


def test_each_layer_imports_and_the_exporter_stays_out_of_the_agent():
    for module, name in (("airprompter_agent.core", "verify_manifest"), ("airprompter_agent.sync", "SlotStore"), ("airprompter_agent.runtime", "ReleaseResolver"), ("airprompter_agent.telemetry", "SpoolWriter"), ("airprompter_agent_otel.exporter", "OtlpUploadSink")):
        result = subprocess.run([sys.executable, "-c", f"from {module} import {name}; assert callable({name})"], capture_output=True, text=True)
        assert result.returncode == 0, f"{module}: {result.stderr}"
    # The main package never loads the exporter: OpenTelemetry is a footprint it does not carry.
    result = subprocess.run([sys.executable, "-c", "import sys, airprompter_agent; assert 'airprompter_agent_otel' not in sys.modules"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert not os.path.exists(os.path.join(SRC, "telemetry", "otel.py"))


def test_every_install_line_in_the_readme_pins_the_current_version():
    # A version bump fails here until the docs follow: an unpinned line installs the old release.
    version = declared_version(pyproject("agent"))
    with open(os.path.join(SDK_PY, "README.md"), encoding="utf-8") as f:
        lines = [line for line in f.read().splitlines() if "pip install" in line and "airprompter-" in line]
    assert any(f'"airprompter-agent=={version}"' in line for line in lines), f"the README installs airprompter-agent=={version}"
    for line in lines:
        for name, pin in re.findall(r"(airprompter-[a-z0-9-]+(?:\[[a-z,]+\])?)(==[^\"\s`]+)?", line):
            assert pin == f"=={version}", f"{name} is not pinned to {version}: {line}"


def test_no_removed_name_is_left_under_sdk_python():
    # Assembled here so this file does not match itself.
    removed = re.compile("|".join(["airprompter_agent_(core|sync|runtime|telemetry)", "airprompter-agent-(core|sync|runtime|telemetry)", "otel" + "_bridge", "otel" + "-bridge"]))
    offenders = []
    for folder, dirs, files in os.walk(SDK_PY):
        dirs[:] = [d for d in dirs if d not in (".venv", "__pycache__", "dist", ".pytest_cache")]
        for name in files:
            if name.endswith((".py", ".mts", ".md", ".toml")):
                with open(os.path.join(folder, name), encoding="utf-8") as f:
                    if removed.search(f.read()):
                        offenders.append(os.path.relpath(os.path.join(folder, name), SDK_PY))
    assert offenders == []
