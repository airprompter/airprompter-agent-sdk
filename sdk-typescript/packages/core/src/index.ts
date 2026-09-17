/**
 * `@airprompter/agent-core` — the pure half of the SDK: the protocol
 * (types, trust chain, canonical JSON, arm assignment and the ramp walk),
 * rendering, output checks, golden sets, the judge, bundle reading, the
 * telemetry row schemas, the control-plane HTTP client, the port
 * interfaces and their Node adapters. No module here opens a file, a
 * socket or a timer at import time, and nothing here depends on a sibling
 * package: `agent-sync`, `agent-runtime` and `agent-telemetry` all build on
 * this one and never on each other (S10; `scripts/lint-imports.mjs` pins
 * the direction).
 */

export { PROTOCOL_VERSION, SDK_VERSION, protocolAtLeast } from "./protocol/version.js";
export type * from "./protocol/types.js";
export { DIRECTIVE_KINDS, experimentConflict, experimentForTag, experimentsOf } from "./protocol/types.js";
export { errorNamed } from "./protocol/errors.js";
export type { FsPort, FsFailure, FsOpenFlags, ClockPort, FetchPort } from "./protocol/ports.js";
export { fsFailureCode } from "./protocol/ports.js";
export { nodeFs, systemClock } from "./ports/node.js";
export { canonicalJson, canonicalBytes, sha256Prefixed, CanonicalJsonError } from "./protocol/canonicalJson.js";
export { assignArm, subjectHash, bucketFromHash, armForBucket, validateArms, validateRamp, rampWeightsAt, effectiveArms, isAssignmentError, orderedSteps, AssignmentError, StepError, ASSIGNMENT_MODULUS, RAMP_MIN_STEP_MS, RAMP_MAX_STEPS } from "./protocol/assignment.js";
export { keyThumbprint, publicJwkOf, signBytes, verifyBytes, trustedRootFromPinnedKey, verifyRootMetadata, verifyManifest, referencedPayloads, releaseDigest, releaseDigestInput, instant } from "./protocol/trust.js";
export type { Verdict, VerifyManifestInput } from "./protocol/trust.js";

export { renderTemplate, placeholdersOf, defaultOf, xmlDelimiters, MissingVariableError, UnknownVariableError } from "./render/template.js";
export type { Delimiters, RenderInput } from "./render/template.js";
export { mintRunRef, parseRunRef } from "./render/runRef.js";
export type { RunRefFacts } from "./render/runRef.js";

export { CHECK_BOUNDS, checkRefusal, checksRefusals, patternRefusal, validateJsonSchema, valueAtPath, evaluateCheck, evaluateChecks, projectChecks, outputTextOf, estimateTokens, type DeclaredCheck, type CheckResult, type CheckOutcome } from "./checks/index.js";
export { parseGoldenSet, runGoldenSet, goldenReportsMeet, passBpsOf, GoldenSetError, GOLDEN_SET_FORMAT, GOLDEN_SET_VERSION, type GoldenSet, type GoldenCase, type GoldenInvoke, type GoldenInvocation, type GoldenReport, type GoldenCaseResult } from "./golden/index.js";
export { JUDGE_RUBRICS, PROTECTION_CRITERIA, judgePrompt, parseJudgeReply, rubricFromPrompt, judgeSignalsOf, type JudgeRubric, type JudgeResult } from "./judge/index.js";

export { createPlaintextBundle, createEncryptedBundle, openBundle, bundlePayloadBytes, distributionKeyId, BundleError, APBUNDLE_INFO } from "./bundle/apbundle.js";
export type { DistributionKey } from "./bundle/apbundle.js";
export { generateX25519KeyPair, x25519PrivateKeyFromRaw, x25519PublicKeyFromRaw } from "./bundle/hpke.js";
export { BundleRelease } from "./release/bundleRelease.js";
export type { ReleaseReader, ReleaseSlot, LoadedRelease } from "./release/reader.js";
export type { BundleReleaseInput, BundleReleaseRefusal } from "./release/bundleRelease.js";

export { SyncClient } from "./control/client.js";
export type { ControlPlaneRefusal, FetchLike, ManifestFetch, SyncClientOptions } from "./control/client.js";

export { LATENCY_BUCKET_EDGES_MS, latencyBucketIndex, minuteOf, epochMinute } from "./telemetry/rows.js";
export type { Observation, WindowRow, RefusalRow, DroppedRow, SpoolRow, ErrorClass } from "./telemetry/rows.js";
export type { UploadSink, UploadSegment, UploadOutcome } from "./telemetry/uploadSink.js";
export { normalizeFeedback, BOOLEAN_SIGNALS, UNIT_SIGNALS, COUNT_SIGNALS, RUNTIME_SIGNALS, CATALOGUE, OUTCOME_NAME, type NormalizedFeedback, type FeedbackRejection } from "./telemetry/feedback.js";
