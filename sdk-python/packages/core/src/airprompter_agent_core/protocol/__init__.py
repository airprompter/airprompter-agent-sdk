"""The protocol's pure functions: canonical JSON, sticky assignment, step ordering, the trust chain.

Example::

    from airprompter_agent_core.protocol import assign_arm, canonical_bytes, sha256_prefixed, verify_manifest

    sha256_prefixed(canonical_bytes({"b": 1, "a": 2}))   # "sha256:…" over the one byte form both SDKs write
    assignment = assign_arm(salt=experiment["salt"], subject="user-42", arms=experiment["arms"])   # sticky: the same arm on every host
    verdict = verify_manifest(manifest=manifest, root=root, now=now_iso, scope=scope, stored_generation=held_generation)   # verdict.ok, or verdict.reason
"""

from .assignment import ASSIGNMENT_MODULUS, RAMP_MAX_STEPS, RAMP_MIN_STEP_MS, Assignment, AssignmentError, StepError, arm_for_bucket, assign_arm, bucket_from_hash, effective_arms, ordered_steps, ramp_weights_at, subject_hash, validate_arms, validate_ramp
from .canonical_json import UNDEFINED, CanonicalJsonError, canonical_bytes, canonical_json, sha256_prefixed
from .trust import (
    SUPPORTED_PROTOCOL_MAJORS,
    Verdict,
    generate_p256_jwk,
    key_thumbprint,
    public_jwk_of,
    referenced_payloads,
    release_digest,
    release_digest_input,
    sign_bytes,
    trusted_root_from_pinned_key,
    verify_bytes,
    verify_manifest,
    verify_root_metadata,
)

__all__ = [
    "ASSIGNMENT_MODULUS",
    "Assignment",
    "AssignmentError",
    "StepError",
    "arm_for_bucket",
    "assign_arm",
    "effective_arms",
    "ramp_weights_at",
    "validate_ramp",
    "RAMP_MAX_STEPS",
    "RAMP_MIN_STEP_MS",
    "bucket_from_hash",
    "ordered_steps",
    "subject_hash",
    "validate_arms",
    "UNDEFINED",
    "CanonicalJsonError",
    "canonical_bytes",
    "canonical_json",
    "sha256_prefixed",
    "SUPPORTED_PROTOCOL_MAJORS",
    "Verdict",
    "generate_p256_jwk",
    "key_thumbprint",
    "public_jwk_of",
    "referenced_payloads",
    "release_digest",
    "release_digest_input",
    "sign_bytes",
    "trusted_root_from_pinned_key",
    "verify_bytes",
    "verify_manifest",
    "verify_root_metadata",
]
