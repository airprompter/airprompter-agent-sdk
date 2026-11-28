"""The one distribution and what sits beside it, Python mirror of ``sdk-typescript/test/packageShape.test.ts``.

1. The direction is core → sync, runtime, telemetry → agent, and a layer is reached only through its package; the edge
   set is pinned; a planted sideways or deep import fails the lint.
2. ``airprompter_agent.runtime`` renders and assigns over a bundle the customer loads, verified like OTA: no store, no
   daemon, no network; a relabelled, stranger-signed or tampered bundle is refused.
3. The runtime walks the protocol's ramp vectors over a bundle release with no agent.
4. The distributions carry one version with ``airprompter-agent`` exact-pinned, the lockstep check says so, and
   ``SDK_VERSION`` is that version. No removed distribution or module name is left under ``sdk-python/``.
5. Every promised module's ``__all__`` is exactly what is pinned here (``docs/stability.md``), one name per line, so a name
   reaches the promise on purpose; the root is lazy, so a layer never loads the agent.
6. Framework adapters (AIR-2231): an adapter imports only the contract, its own folder and its framework; the layers
   below import no framework; only the contract reaches ``runtime.adapter``; ``agent.py`` is pinned at its line count and
   no adapter passes 300 lines.
"""

from __future__ import annotations

import ast
import importlib
import importlib.util
import json
import os
import re
import shutil
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
#: Rule 4 of section 3.2: the facade's line count after AIR-2231's deletions. A change that grows it moves this on purpose.
AGENT_PY_LINES = 2578
#: Modules that import but promise nothing (docs/stability.md, "Outside the promise").
OUTSIDE = {"airprompter_agent.frameworks.contract"}
#: The 1.0 promise, module by module (docs/stability.md): each ``__all__``, sorted, one name per line. A name added here is
#: a promise made on purpose, in a minor release; a name removed is a major release.
PROMISE = {
    "airprompter_agent": [
        "AgentRuntime",
        "AgentStartError",
        "AgentStatus",
        "AirPrompterAgent",
        "ApplyOptions",
        "Approved",
        "DatastoreOptions",
        "GoldenOptions",
        "ModelResolver",
        "PROTOCOL_VERSION",
        "Passthrough",
        "Placement",
        "PromptHandle",
        "ReleaseChange",
        "RenderRefusedError",
        "Rendered",
        "RunInput",
        "RunSession",
        "SDK_NAME",
        "SDK_VERSION",
        "StagedRelease",
        "SyncOptions",
        "TelemetryOptions",
        "VENDORED_BUNDLE_EXPIRY_WARNING_DAYS",
        "VendoredBundle",
        "Workflow",
        "WorkflowHandle",
        "WorkflowStep",
        "healthz_of",
        "healthz_response",
    ],
    "airprompter_agent.core": [
        "ASSIGNMENT_MODULUS",
        "AssignmentError",
        "BundleError",
        "BundleRelease",
        "BundleReleaseRefused",
        "CanonicalJsonError",
        "ClockPort",
        "Delimiters",
        "DistributionKey",
        "ERROR_CLASSES",
        "FsPort",
        "GOLDEN_SET_FORMAT",
        "GOLDEN_SET_VERSION",
        "GoldenCaseResult",
        "GoldenInvocation",
        "GoldenInvoke",
        "GoldenReport",
        "GoldenSetError",
        "JudgeResult",
        "JudgeRubric",
        "LATENCY_BUCKET_EDGES_MS",
        "LoadedRelease",
        "MissingVariableError",
        "NormalizedFeedback",
        "OS_FS",
        "Observation",
        "OsFs",
        "PROTOCOL_VERSION",
        "ReleaseReader",
        "ReleaseSlot",
        "RunDimensions",
        "RunTotals",
        "SDK_VERSION",
        "STEP_BOUNDS",
        "SUPPORTED_CAPABILITIES",
        "SYSTEM_CLOCK",
        "SpoolRow",
        "StepTotals",
        "SyncClient",
        "SystemClock",
        "USAGE_SOURCES",
        "UnknownVariableError",
        "UploadOutcome",
        "UploadSegment",
        "UploadSink",
        "Verdict",
        "X25519KeyPair",
        "arm_for_bucket",
        "assign_arm",
        "bucket_from_hash",
        "canonical_bytes",
        "canonical_json",
        "create_encrypted_bundle",
        "create_plaintext_bundle",
        "distribution_key_id",
        "effective_arms",
        "epoch_minute",
        "evaluate_checks",
        "generate_x25519_key_pair",
        "golden_reports_meet",
        "key_thumbprint",
        "latency_bucket_index",
        "minute_of",
        "normalize_feedback",
        "open_bundle",
        "parse_golden_set",
        "placeholders_of",
        "public_jwk_of",
        "ramp_weights_at",
        "release_digest",
        "render_template",
        "run_golden_set",
        "sha256_prefixed",
        "subject_hash",
        "trusted_root_from_pinned_key",
        "validate_arms",
        "validate_ramp",
        "verify_manifest",
        "verify_root_metadata",
        "x25519_private_key_from_raw",
        "x25519_public_key_from_raw",
        "xml_delimiters",
    ],
    "airprompter_agent.sync": [
        "DatastoreRollbackResult",
        "FileKvStore",
        "KeyProvider",
        "KvEntry",
        "KvReleaseDatastore",
        "KvStore",
        "KvStoreReport",
        "LoadedSlot",
        "MemoryKvStore",
        "MemoryReleaseDatastore",
        "PayloadDecryptError",
        "PullBundleResult",
        "PullEdgeState",
        "PullToDatastoreResult",
        "ReleaseControl",
        "ReleaseDatastore",
        "ReleaseKey",
        "SlotStore",
        "StoreError",
        "StoreHooks",
        "StoredReleaseRow",
        "SyncPassOutput",
        "UpdateWindow",
        "WindowState",
        "check_kv_store",
        "clear_datastore_rollback",
        "custom_key_provider",
        "file_key",
        "is_known_time_zone",
        "kms",
        "kv_release_datastore",
        "next_pull_delay_ms",
        "os_keystore",
        "parse_window",
        "prune_datastore",
        "pull_bundle",
        "pull_to_datastore",
        "rollback_datastore",
        "sync_once",
        "validate_window",
        "vault",
        "window_state",
    ],
    "airprompter_agent.runtime": [
        "AgentRuntime",
        "AppliedInference",
        "Approved",
        "Attribution",
        "Disabled",
        "ModelResolver",
        "ObserveTarget",
        "Passthrough",
        "Placement",
        "RegisteredSource",
        "ReleaseResolver",
        "RenderValues",
        "Rendered",
        "ResolveOutcome",
        "RunInput",
        "RunSession",
        "UsageNormalized",
        "VariableSource",
        "VariableSourceContext",
        "VariableSourceError",
        "VariableSourceInput",
        "VariableSourceRegistry",
        "VariableSourceRequiredError",
        "apply_inference",
        "attribution_scope",
        "current_attribution",
        "is_variable_source_error",
        "is_variable_source_required_error",
        "new_subject",
        "normalize_usage",
        "observe_call",
        "observe_call_async",
    ],
    "airprompter_agent.telemetry": [
        "AirPrompterUploadSink",
        "DirectorySink",
        "GrantDecision",
        "HOST_SPOOL_BUDGET_BYTES",
        "MemorySink",
        "PassResult",
        "SEGMENT_MAX_BYTES",
        "SERVERLESS_BUFFER_BYTES",
        "SpoolSink",
        "SpoolUploader",
        "SpoolWriter",
        "UploadGrant",
        "WriterIdentity",
        "inspect_segment",
    ],
    "airprompter_agent.testing": [
        "FakeClock",
        "MemoryFs",
    ],
    "airprompter_agent.frameworks.openai": [
        "apply_placement",
        "instrument",
    ],
    "airprompter_agent.frameworks.anthropic": [
        "apply_placement",
        "instrument",
    ],
    "airprompter_agent.frameworks.litellm": [
        "AirPrompterLiteLLMCallback",
        "LiteLLMRuntime",
        "METADATA_KEY",
        "litellm_metadata",
        "litellm_params",
    ],
    "airprompter_agent_otel.exporter": [
        "ExportResult",
        "Exporter",
        "OTLP_SCOPE_NAME",
        "OtlpUploadSink",
        "http_json_exporter",
        "otlp_attribute",
        "spool_rows_to_otlp",
    ],
    "airprompter_datastore_s3": [
        "S3KvStore",
        "s3_kv_store",
    ],
    "airprompter_datastore_postgres": [
        "PostgresKvStore",
        "postgres_kv_schema",
        "postgres_kv_store",
    ],
    "airprompter_datastore_redis": [
        "RedisKvStore",
        "redis_kv_store",
    ],
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
    assert edges == ["agent-otel→core", "agent→core", "agent→runtime", "agent→sync", "agent→telemetry", "datastore-postgres→sync", "datastore-redis→sync", "datastore-s3→sync", "frameworks→core", "frameworks→runtime", "runtime→core", "sync→core", "telemetry→core"]
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
    otel = os.path.join(SDK_PY, "packages", "agent-otel", "src", "airprompter_agent_otel", "_lint_probe.py")
    util = planted(otel, "from airprompter_agent.core._util import iso_ms\nPROBE = iso_ms\n")
    assert util.returncode == 1, "core._util is the distribution's own: a satellite that names it breaks on a private tidy"
    internal = planted(otel, "from airprompter_agent.sync import resolve_hydration\nPROBE = resolve_hydration\n")
    assert internal.returncode == 1 and "resolve_hydration is not in airprompter_agent.sync.__all__" in internal.stderr, "a satellite imports only what 1.0 promises"
    assert planted(otel, "from airprompter_agent.core import SDK_VERSION\nPROBE = SDK_VERSION\n").returncode == 0, "a promised name is fine"
    whole = planted(otel, "import airprompter_agent.sync as s\nPROBE = s.resolve_hydration\n")
    assert whole.returncode == 1 and "never the module whole" in whole.stderr, "a layer bound whole would hide which names a satellite uses"
    layer = planted(otel, "from airprompter_agent import sync\nPROBE = sync.resolve_hydration\n")
    assert layer.returncode == 1 and "never the layer itself" in layer.stderr
    dynamic = planted(otel, "import importlib\nPROBE = importlib.import_module(\"airprompter_agent.sync\").resolve_hydration\n")
    assert dynamic.returncode == 1 and "never the module whole (here through import_module)" in dynamic.stderr
    module = planted(os.path.join(SRC, "sync", "_lint_probe.py"), "from airprompter_agent.core import protocol\nPROBE = protocol\n")
    assert module.returncode == 1 and "reaches into core by path (airprompter_agent.core.protocol)" in module.stderr, "a module is not reached through its layer's package"


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


def all_of(path: str) -> list[str]:
    """A module's ``__all__`` as written: one list literal, each name on its own line."""
    with open(path, encoding="utf-8") as f:
        source = f.read()
    lists = [node for node in ast.parse(source).body if isinstance(node, (ast.Assign, ast.AugAssign, ast.AnnAssign)) and "__all__" in {getattr(t, "id", None) for t in (node.targets if isinstance(node, ast.Assign) else [node.target])}]
    assert len(lists) == 1 and isinstance(lists[0], ast.Assign), f"{path}: one `__all__ = [...]`, never extended"
    names = [element.value for element in lists[0].value.elts]
    lines = [element.lineno for element in lists[0].value.elts]
    assert len(set(lines)) == len(lines), f"{path}: one name per line in `__all__`"
    return names


def source_of(module: str) -> str:
    spec = importlib.util.find_spec(module)
    assert spec and spec.origin, module
    return spec.origin


def test_each_promised_module_lists_exactly_its_pinned_names_one_per_line():
    for name, expected in PROMISE.items():
        assert expected == sorted(expected), f"{name}: the pin is sorted"
        listed = all_of(source_of(name))
        assert listed == sorted(listed), f"{name}.__all__ is sorted"
        assert listed == expected, f"{name}.__all__ moved: a public name is a promise, so change PROMISE on purpose"
        module = importlib.import_module(name)
        assert list(module.__all__) == expected, f"{name}.__all__ at run time is the list as written (nothing appends to it)"
        assert not [n for n in expected if not hasattr(module, n)], f"{name} lists a name it does not have"
    # Small helpers stay internal: `core._util` is the distribution's own, and no satellite names it.
    helpers = {"b64url_decode", "b64url_encode", "fsync_dir", "iso_ms", "iso_seconds", "now_ms", "random_id", "check_condition"}
    for name in PROMISE:
        assert not helpers & set(importlib.import_module(name).__all__), f"{name} lists an internal helper"


def test_the_stability_page_promises_each_pinned_module_and_puts_the_contract_outside():
    with open(os.path.join(SDK_PY, "..", "docs", "stability.md"), encoding="utf-8") as f:
        page = f.read()
    inside = page[page.index("\n## What 1.0 promises\n") : page.index("\n## Outside the promise\n")]
    outside = page[page.index("\n## Outside the promise\n") :]
    for name in PROMISE:
        assert f"| `{name}` |" in inside, f"docs/stability.md promises {name}"
    # An adapter is a module or a folder (the lint's rule 1); each is inside the promise or in OUTSIDE, on purpose.
    frameworks = os.path.join(SRC, "frameworks")
    modules = {f"airprompter_agent.frameworks.{path[:-3] if path.endswith('.py') else path}" for path in os.listdir(frameworks) if (path.endswith(".py") and path != "__init__.py") or os.path.isfile(os.path.join(frameworks, path, "__init__.py"))}
    assert modules - set(PROMISE) == OUTSIDE, "a new adapter is placed inside the promise or in OUTSIDE, on purpose"
    for name in OUTSIDE:
        assert f"`{name}`" in outside and name not in inside, f"docs/stability.md puts {name} outside the promise"


def test_a_layer_names_every_other_import_as_internal_and_never_as_both():
    # A layer's barrel imports more than it promises: the layers above use those names. Each one is named once in
    # `_FOR_THE_LAYERS_ABOVE`, so a reader (and pyflakes) sees it is on purpose, and none of them is in `__all__`.
    for layer in ("core", "sync", "runtime", "telemetry"):
        module = importlib.import_module(f"airprompter_agent.{layer}")
        with open(module.__file__, encoding="utf-8") as f:
            tree = ast.parse(f.read())
        imported = {alias.asname or alias.name for node in tree.body if isinstance(node, ast.ImportFrom) and node.level for alias in node.names}
        internal = {element.id for node in tree.body if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", None) == "_FOR_THE_LAYERS_ABOVE" for element in node.value.elts}
        assert not internal & set(module.__all__), f"{layer}: a name is both promised and internal"
        assert imported - set(module.__all__) == internal, f"{layer}: every import is promised or named internal: {sorted(imported - set(module.__all__) ^ internal)}"


def test_the_root_is_lazy_so_a_layer_or_a_datastore_never_loads_the_agent():
    code = "import sys, airprompter_agent.core, airprompter_agent.sync, airprompter_datastore_s3; loaded = [m for m in ('airprompter_agent.agent', 'airprompter_agent.runtime', 'airprompter_agent.telemetry') if m in sys.modules]; assert not loaded, loaded"
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    code = "import airprompter_agent as ap; from airprompter_agent import *; assert AirPrompterAgent is ap.AirPrompterAgent and RunSession is ap.RunSession; assert ap.__version__ == ap.SDK_VERSION; assert 'AirPrompterAgent' in dir(ap)"
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    result = subprocess.run([sys.executable, "-c", "import airprompter_agent; airprompter_agent.SlotStore"], capture_output=True, text=True)
    assert result.returncode != 0 and "has no attribute 'SlotStore'" in result.stderr, "a layer's name has one home, and it is not the root"
    # A layer is an attribute whatever was imported first, as it was when the root loaded everything.
    result = subprocess.run([sys.executable, "-c", "import airprompter_agent as ap; assert ap.core.SDK_VERSION and ap.sync.SlotStore and ap.testing.MemoryFs; assert 'sync' in dir(ap)"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    # The root's names live in three places, which must agree: the lazy map, `__all__`, and what type checkers read.
    import airprompter_agent

    with open(source_of("airprompter_agent"), encoding="utf-8") as f:
        tree = ast.parse(f.read())
    checked = {alias.asname or alias.name for node in tree.body if isinstance(node, ast.If) and getattr(node.test, "id", "") == "TYPE_CHECKING" for statement in node.body if isinstance(statement, ast.ImportFrom) for alias in statement.names}
    assert checked == set(airprompter_agent._HOME) == set(airprompter_agent.__all__), "TYPE_CHECKING imports, _HOME and __all__ name the same root"


def test_each_distribution_ships_py_typed():
    # The annotations are part of the promise only if type checkers read them (PEP 561).
    for name, top_level in (("agent", "airprompter_agent"), ("agent-otel", "airprompter_agent_otel"), ("datastore-s3", "airprompter_datastore_s3"), ("datastore-postgres", "airprompter_datastore_postgres"), ("datastore-redis", "airprompter_datastore_redis")):
        assert os.path.isfile(os.path.join(SDK_PY, "packages", name, "src", top_level, "py.typed")), f"{name} ships py.typed"


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
    removed = re.compile("|".join(["airprompter_agent_(core|sync|runtime|telemetry)", "airprompter-agent-(core|sync|runtime|telemetry)", "otel" + "_bridge", "otel" + "-bridge", r"airprompter_agent\.core\." + "testing"]))
    offenders = []
    for folder, dirs, files in os.walk(SDK_PY):
        dirs[:] = [d for d in dirs if d not in (".venv", "__pycache__", "dist", ".pytest_cache")]
        for name in files:
            if name.endswith((".py", ".mts", ".md", ".toml")):
                with open(os.path.join(folder, name), encoding="utf-8") as f:
                    if removed.search(f.read()):
                        offenders.append(os.path.relpath(os.path.join(folder, name), SDK_PY))
    assert offenders == []


def test_adapters_import_only_the_contract_and_their_framework_and_nothing_below_imports_a_framework():
    frameworks = os.path.join(SRC, "frameworks")
    unlisted = planted(os.path.join(frameworks, "_lint_probe.py"), "from .contract import choose_model\nPROBE = choose_model\n")
    assert unlisted.returncode == 1 and "frameworks/_lint_probe has no entry in ADAPTERS" in unlisted.stderr
    # Only new files are planted, never an edit to a real one: the probe sits in a folder named after a listed adapter,
    # which the lint reads as that adapter's own files.
    folder = os.path.join(frameworks, "openai")
    existed = os.path.isdir(folder)
    os.makedirs(folder, exist_ok=True)
    try:
        probe = os.path.join(frameworks, "openai", "_lint_probe.py")
        for source, message in [
            ("from airprompter_agent.runtime import normalize_usage\nPROBE = normalize_usage\n", "an adapter imports only the contract, its own folder and its framework, not airprompter_agent.runtime"),
            ("from ..anthropic import instrument\nPROBE = instrument\n", "not airprompter_agent.frameworks.anthropic"),
            ("import anthropic\nPROBE = anthropic\n", "anthropic is not in frameworks/openai's allowlist"),
            ("from airprompter_agent.runtime.adapter import acquire_run\nPROBE = acquire_run\n", "runtime.adapter is the adapters' internal module"),
            ("import importlib\nPROBE = importlib.import_module('airprompter_agent.runtime')\n", "not airprompter_agent.runtime"),
            ("PROBE = __import__('anthropic')\n", "anthropic is not in frameworks/openai's allowlist"),
            ("import importlib\nNAME = 'x'\nPROBE = importlib.import_module(NAME)\n", "a dynamic import of a computed name cannot be checked"),
        ]:
            result = planted(probe, source)
            assert result.returncode == 1, source
            assert message in result.stderr, result.stderr
        ok = planted(probe, "import typing\nimport openai\nfrom ..contract import choose_model\nPROBE = (typing, openai, choose_model)\n")
        assert ok.returncode == 0, ok.stderr
    finally:
        if existed:
            os.unlink(probe) if os.path.exists(probe) else None
        else:
            shutil.rmtree(folder, ignore_errors=True)
    sub = planted(os.path.join(SRC, "_lint_probe.py"), "from airprompter_agent.runtime import adapter\nPROBE = adapter\n")
    assert "airprompter_agent.runtime.adapter is the adapters' internal module" in sub.stderr, "a submodule named in from-import is seen"
    # frameworks/__init__ is a real file: the probe edits a copy of the tree, never the source.
    import tempfile

    copy = tempfile.mkdtemp(prefix="ap-lint-")
    try:
        packages = os.path.join(copy, "packages")
        shutil.copytree(os.path.join(SDK_PY, "packages"), packages, ignore=shutil.ignore_patterns("__pycache__", "*.egg-info", "dist", "build"))
        with open(os.path.join(packages, "agent", "src", "airprompter_agent", "frameworks", "__init__.py"), "a", encoding="utf-8") as f:
            f.write("\nfrom . import openai  # noqa\n")
        copied = subprocess.run([sys.executable, os.path.join(SDK_PY, "tools", "lint_imports.py")], capture_output=True, text=True, env={**os.environ, "AIRPROMPTER_LINT_PACKAGES": packages})
        assert "frameworks/__init__ imports the standard library only" in copied.stderr, copied.stderr
    finally:
        shutil.rmtree(copy, ignore_errors=True)
    runtime_framework = planted(os.path.join(SRC, "runtime", "_lint_probe.py"), "import openai\nPROBE = openai\n")
    assert runtime_framework.returncode == 1 and "runtime imports the framework package openai" in runtime_framework.stderr
    agent_framework = planted(os.path.join(SRC, "_lint_probe.py"), "from langchain_core.messages import SystemMessage\nPROBE = SystemMessage\n")
    assert "agent imports the framework package langchain_core.messages" in agent_framework.stderr
    run_telemetry = planted(os.path.join(SRC, "runtime", "run", "_lint_probe.py"), "from airprompter_agent.telemetry import SpoolWriter\nPROBE = SpoolWriter\n")
    assert "runtime (layer 1) may not import telemetry (layer 1)" in run_telemetry.stderr, "runtime/run imports neither telemetry nor sync"
    contract_folder = os.path.join(frameworks, "contract")
    os.makedirs(contract_folder, exist_ok=False)
    try:
        bad = planted(os.path.join(contract_folder, "_lint_probe.py"), "from airprompter_agent.telemetry import SpoolWriter\nPROBE = SpoolWriter\n")
        assert "frameworks/contract imports only the core and runtime packages" in bad.stderr
    finally:
        shutil.rmtree(contract_folder, ignore_errors=True)


def test_agent_py_is_pinned_and_no_adapter_passes_300_lines():
    with open(os.path.join(SRC, "agent.py"), encoding="utf-8") as f:
        assert len(f.read().rstrip().split("\n")) == AGENT_PY_LINES, "agent.py grew or shrank: move AGENT_PY_LINES on purpose"
    frameworks = os.path.join(SRC, "frameworks")
    for entry in sorted(os.listdir(frameworks)):
        path = os.path.join(frameworks, entry)
        files = [os.path.join(dirpath, name) for dirpath, _, names in os.walk(path) for name in names if name.endswith(".py")] if os.path.isdir(path) else ([path] if entry.endswith(".py") else [])
        lines = 0
        for file in files:
            with open(file, encoding="utf-8") as f:
                lines += len(f.read().rstrip().split("\n"))
        assert lines <= 300, f"frameworks/{entry}: {lines} lines, over 300"
