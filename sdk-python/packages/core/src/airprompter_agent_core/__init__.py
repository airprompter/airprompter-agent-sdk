"""``airprompter_agent_core`` — the pure half of the AirPrompter agent SDK: the protocol (types, trust chain,
canonical JSON, arm assignment and the ramp walk), rendering, output checks, golden sets, the judge, bundle reading,
the telemetry row schemas, the control-plane HTTP client, the port protocols and their OS adapters. Nothing here opens
a file, a socket or a thread at import time, and nothing here imports a sibling package: ``airprompter_agent_sync``,
``airprompter_agent_runtime`` and ``airprompter_agent_telemetry`` all build on this one and never on each other (S10;
``tools/lint_imports.py`` pins the direction)."""

from .bundle.apbundle import APBUNDLE_INFO, BundleError, DistributionKey, bundle_payload_bytes, create_encrypted_bundle, create_plaintext_bundle, distribution_key_id, open_bundle
from .bundle.hpke import X25519KeyPair, generate_x25519_key_pair, x25519_private_key_from_raw, x25519_public_key_from_raw
from .checks import CHECK_BOUNDS, check_refusal, checks_refusals, estimate_tokens, evaluate_check, evaluate_checks, output_text_of, pattern_refusal, project_checks, validate_json_schema, value_at_path
from .control.client import SyncClient
from .golden import GOLDEN_SET_FORMAT, GOLDEN_SET_VERSION, GoldenCaseResult, GoldenInvocation, GoldenInvoke, GoldenReport, GoldenSetError, golden_reports_meet, manifest_has_golden, parse_golden_set, pass_bps_of, run_golden_set
from .judge import JUDGE_RUBRICS, PROTECTION_CRITERIA, JudgeResult, JudgeRubric, judge_prompt, judge_signals_of, parse_judge_reply, rubric_from_prompt
from .ports import OS_FS, SYSTEM_CLOCK, ClockPort, FsPort, OsFs, SystemClock, fs_failure_code, fs_or_default
from .protocol import (
    ASSIGNMENT_MODULUS,
    RAMP_MAX_STEPS,
    RAMP_MIN_STEP_MS,
    SUPPORTED_PROTOCOL_MAJORS,
    UNDEFINED,
    Assignment,
    AssignmentError,
    CanonicalJsonError,
    StepError,
    Verdict,
    arm_for_bucket,
    assign_arm,
    bucket_from_hash,
    canonical_bytes,
    canonical_json,
    effective_arms,
    generate_p256_jwk,
    key_thumbprint,
    ordered_steps,
    public_jwk_of,
    ramp_weights_at,
    referenced_payloads,
    release_digest,
    release_digest_input,
    sha256_prefixed,
    sign_bytes,
    subject_hash,
    trusted_root_from_pinned_key,
    validate_arms,
    validate_ramp,
    verify_bytes,
    verify_manifest,
    verify_root_metadata,
)
from .release.bundle_release import BundleRelease, BundleReleaseRefused
from .release.reader import LoadedRelease, ReleaseReader, ReleaseSlot
from .render.run_ref import RunRefFacts, mint_run_ref, parse_run_ref
from .render.template import Delimiters, MissingVariableError, UnknownVariableError, default_of, placeholders_of, render_template, xml_delimiters
from .telemetry.feedback import NormalizedFeedback, normalize_feedback
from .telemetry.rows import ERROR_CLASSES, LATENCY_BUCKET_EDGES_MS, Observation, SpoolRow, epoch_minute, latency_bucket_index, minute_of
from .telemetry.upload_sink import UploadOutcome, UploadSegment, UploadSink, sink_status

PROTOCOL_VERSION = "0.3.4"


def protocol_at_least(version: str, floor: str) -> bool:
    """Whether a protocol version string is at least another (``major.minor.patch``, numerically). The manifest a
    control plane sealed names the protocol it speaks; a runtime that must send a newer optional member reads that
    before sending it, so a 0.3.4 SDK talking to a 0.3.3 service never trips its strict schemas."""
    try:
        a = [int(part) for part in version.split(".")]
        b = [int(part) for part in floor.split(".")]
    except (ValueError, AttributeError):
        return False
    if len(a) != 3 or len(b) != 3:
        return False
    return a >= b
SDK_VERSION = "0.2.12"

__all__ = [
    "APBUNDLE_INFO",
    "ASSIGNMENT_MODULUS",
    "Assignment",
    "AssignmentError",
    "BundleError",
    "BundleRelease",
    "BundleReleaseRefused",
    "CHECK_BOUNDS",
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
    "JUDGE_RUBRICS",
    "JudgeResult",
    "JudgeRubric",
    "LATENCY_BUCKET_EDGES_MS",
    "LoadedRelease",
    "MissingVariableError",
    "NormalizedFeedback",
    "OS_FS",
    "Observation",
    "OsFs",
    "PROTECTION_CRITERIA",
    "PROTOCOL_VERSION",
    "protocol_at_least",
    "RAMP_MAX_STEPS",
    "RAMP_MIN_STEP_MS",
    "ReleaseReader",
    "ReleaseSlot",
    "RunRefFacts",
    "SDK_VERSION",
    "SUPPORTED_PROTOCOL_MAJORS",
    "SYSTEM_CLOCK",
    "SpoolRow",
    "StepError",
    "SyncClient",
    "SystemClock",
    "UNDEFINED",
    "UnknownVariableError",
    "UploadOutcome",
    "UploadSegment",
    "UploadSink",
    "Verdict",
    "X25519KeyPair",
    "arm_for_bucket",
    "assign_arm",
    "bucket_from_hash",
    "bundle_payload_bytes",
    "canonical_bytes",
    "canonical_json",
    "check_refusal",
    "checks_refusals",
    "create_encrypted_bundle",
    "create_plaintext_bundle",
    "distribution_key_id",
    "effective_arms",
    "epoch_minute",
    "estimate_tokens",
    "evaluate_check",
    "evaluate_checks",
    "fs_failure_code",
    "fs_or_default",
    "generate_p256_jwk",
    "generate_x25519_key_pair",
    "golden_reports_meet",
    "judge_prompt",
    "judge_signals_of",
    "key_thumbprint",
    "latency_bucket_index",
    "manifest_has_golden",
    "mint_run_ref",
    "minute_of",
    "normalize_feedback",
    "open_bundle",
    "ordered_steps",
    "output_text_of",
    "parse_golden_set",
    "parse_judge_reply",
    "parse_run_ref",
    "pass_bps_of",
    "pattern_refusal",
    "project_checks",
    "public_jwk_of",
    "ramp_weights_at",
    "referenced_payloads",
    "release_digest",
    "release_digest_input",
    "default_of",
    "placeholders_of",
    "render_template",
    "rubric_from_prompt",
    "run_golden_set",
    "sha256_prefixed",
    "sign_bytes",
    "sink_status",
    "subject_hash",
    "trusted_root_from_pinned_key",
    "validate_arms",
    "validate_json_schema",
    "validate_ramp",
    "value_at_path",
    "verify_bytes",
    "verify_manifest",
    "verify_root_metadata",
    "x25519_private_key_from_raw",
    "x25519_public_key_from_raw",
    "xml_delimiters",
]
