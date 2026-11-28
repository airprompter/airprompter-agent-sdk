"""``airprompter_agent.core``: the pure half of the AirPrompter agent SDK: the protocol (types, trust chain,
canonical JSON, arm assignment and the ramp walk), rendering, output checks, golden sets, the judge, bundle reading,
the telemetry row schemas, the control-plane HTTP client, the port protocols and their OS adapters. Nothing here opens
a socket or a thread at import time, the one file it reads is the distribution's metadata for ``SDK_VERSION``, and
nothing here imports another layer: ``airprompter_agent.sync``, ``airprompter_agent.runtime`` and
``airprompter_agent.telemetry`` all build on this one and never on each other (``tools/lint_imports.py`` pins the
direction).

Example::

    from airprompter_agent.core import BundleRelease, PROTOCOL_VERSION

    reader = BundleRelease.load(bundle=bundle, root=pinned_root, scope=scope, now="2026-09-17T00:00:00Z")   # refuses before it holds a byte
    reader.current().generation                    # the verified release a runtime serves
    heartbeat = {"protocol": PROTOCOL_VERSION}     # the one wire this SDK speaks
"""

from importlib.metadata import version as _distribution_version

from .bundle.apbundle import (
    BundleError,
    DistributionKey,
    bundle_payload_bytes,
    create_encrypted_bundle,
    create_plaintext_bundle,
    distribution_key_id,
    open_bundle,
)
from .bundle.hpke import X25519KeyPair, generate_x25519_key_pair, x25519_private_key_from_raw, x25519_public_key_from_raw
from .checks import evaluate_checks, output_text_of
from .control.client import SyncClient
from .http import HttpRequest, HttpResponse, Transport, default_transport, require_transport, send_once
from .golden import GOLDEN_SET_FORMAT, GOLDEN_SET_VERSION, GoldenCaseResult, GoldenInvocation, GoldenInvoke, GoldenReport, GoldenSetError, golden_reports_meet, manifest_has_golden, parse_golden_set, pass_bps_of, run_golden_set
from .judge import (
    JUDGE_RUBRICS,
    JudgeResult,
    JudgeRubric,
    judge_prompt,
    judge_signals_of,
    parse_judge_reply,
    rubric_from_prompt,
)
from .ports import OS_FS, SYSTEM_CLOCK, ClockPort, FsPort, OsFs, SystemClock, fs_failure_code, fs_or_default
from .protocol import (
    HOSTED_ROOTS,
    hosted_environment_of_root,
    AGENT_ID,
    ASSIGNMENT_MODULUS,
    PROTOCOL_VERSION,
    SUPPORTED_CAPABILITIES,
    TARGET_SLUG,
    AssignmentError,
    CanonicalJsonError,
    Verdict,
    arm_for_bucket,
    assign_arm,
    bucket_from_hash,
    canonical_bytes,
    canonical_json,
    carried_payloads,
    effective_arms,
    key_thumbprint,
    ordered_steps,
    public_jwk_of,
    ramp_weights_at,
    referenced_payloads,
    release_digest,
    optional_payloads,
    slot_hashes,
    servable_experiments,
    frozen_experiment,
    servable_slots,
    sha256_prefixed,
    subject_hash,
    trusted_root_from_pinned_key,
    validate_arms,
    validate_ramp,
    verify_manifest,
    verify_root_metadata,
)
from .release.bundle_release import BundleRelease, BundleReleaseRefused
from .release.reader import LoadedRelease, ReleaseReader, ReleaseSlot
from .render.run_ref import RUN_REF_MAX_ENTRIES, RunRefFacts, mint_run_ref, new_run_id, parse_run_ref, run_ref_key_from
from .render.template import (
    Delimiters,
    MissingVariableError,
    UnknownVariableError,
    placeholders_of,
    render_template,
    xml_delimiters,
)
from .telemetry.feedback import NormalizedFeedback, normalize_feedback
from .telemetry.rows import ERROR_CLASSES, LATENCY_BUCKET_EDGES_MS, SLOT_TAG, STEP_BOUNDS, STEP_STATUSES, USAGE_SOURCES, WINDOW_STATUSES, Observation, RunDimensions, RunTotals, SpoolRow, StepTotals, count_of, epoch_minute, latency_bucket_index, minute_of, step_name, utf16_length, valid_step_name
from .telemetry.upload_sink import UploadOutcome, UploadSegment, UploadSink, sink_status

try:
    # One source: the installed distribution's metadata, which `tools/version_lockstep.py` keeps in step. A dist-info
    # with no METADATA file answers None.
    SDK_VERSION = _distribution_version("airprompter-agent") or "0+unknown"
except Exception:
    # Copied source with no metadata beside it (a frozen build, a bare PYTHONPATH), or metadata that cannot be read. A
    # version on the heartbeat must not stop the SDK importing.
    SDK_VERSION = "0+unknown"


from .protocol.assignment import matches_audience, captured_audience_ids, valid_audience_selector, copy_audience_tags
from ._util import instant
from .protocol.assignment import valid_audience_ids, valid_audience_label, valid_audience_minute

# The names 1.0 promises (docs/stability.md), one per line: tests/test_package_shape.py pins them. Every other name
# imported above is the layer's own, for the layers above it, and not public.
__all__ = [
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
    "HttpRequest",
    "HttpResponse",
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
    "Transport",
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
    "default_transport",
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
]

# Imported for the layers above and never public: named here so each import is used on purpose, and so no one
# reads one as a promise. tests/test_package_shape.py checks this and ``__all__`` cover every import, apart.
_FOR_THE_LAYERS_ABOVE = (
    HOSTED_ROOTS,
    hosted_environment_of_root,
    require_transport,
    send_once,
    AGENT_ID,
    JUDGE_RUBRICS,
    RUN_REF_MAX_ENTRIES,
    RunRefFacts,
    SLOT_TAG,
    STEP_STATUSES,
    TARGET_SLUG,
    WINDOW_STATUSES,
    bundle_payload_bytes,
    captured_audience_ids,
    carried_payloads,
    copy_audience_tags,
    count_of,
    frozen_experiment,
    fs_failure_code,
    fs_or_default,
    instant,
    judge_prompt,
    judge_signals_of,
    manifest_has_golden,
    matches_audience,
    mint_run_ref,
    new_run_id,
    optional_payloads,
    ordered_steps,
    output_text_of,
    parse_judge_reply,
    parse_run_ref,
    pass_bps_of,
    referenced_payloads,
    rubric_from_prompt,
    run_ref_key_from,
    servable_experiments,
    servable_slots,
    sink_status,
    slot_hashes,
    step_name,
    utf16_length,
    valid_audience_ids,
    valid_audience_label,
    valid_audience_minute,
    valid_audience_selector,
    valid_step_name,
)
