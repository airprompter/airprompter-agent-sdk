/**
 * `@airprompter/agent-sdk/core`, the names 1.0 promises: the protocol with no I/O. Verify a root and a manifest,
 * canonical JSON, arm assignment and the ramp walk, render a template, run output checks or a golden set, write and
 * open a bundle and hold it as a release, the telemetry row schemas, the control-plane client and the port interfaces.
 *
 * This file is the subpath; `./index.ts` is the layer's barrel, what `sync`, `runtime`, `telemetry` and the agent
 * import, and nothing a customer can reach. A name moves here on purpose, in a minor release, and never leaves before
 * a major one. `test/publicSurface.test.ts` pins this list; `docs/stability.md` says what the promise covers.
 *
 * @example
 * ```ts
 * import { BundleRelease, trustedRootFromPinnedKey } from "@airprompter/agent-sdk/core";
 *
 * const root = trustedRootFromPinnedKey({ purpose: "platform", environment: "prod", pinnedRoot: PINNED_ROOT_JWK });
 * const loaded = BundleRelease.load({ bundle, root, scope, now: new Date().toISOString() }); // { ok: true, release } or why not
 * ```
 */

// The versions this build speaks.
export { PROTOCOL_VERSION, SDK_VERSION, SUPPORTED_CAPABILITIES } from "./index.js";

// The wire types: what the protocol's JSON Schemas describe (`protocol/schemas/`).
export type {
  ApplyPolicy,
  Bundle,
  BundleContents,
  Countersignature,
  Directive,
  EdgePointer,
  Experiment,
  ExperimentArm,
  GoldenSetRef,
  HostedEnvironment,
  Manifest,
  ManifestPayload,
  ManifestSlot,
  OutputCheck,
  P256PrivateJwk,
  P256PublicJwk,
  RampStep,
  RefusalCode,
  RootKeyEntry,
  RootMetadata,
  RootMetadataSigned,
  RootRole,
  Sha256,
  Signature,
  SlotInference,
  SlotStep,
  SlotVariable,
  Target,
} from "./index.js";
export type { AudienceCondition, AudienceObservation, AudienceSelector, AudienceSnapshot } from "./index.js";

// Error identity is data: a name and a shape, never the class (two copies of the SDK in one process agree).
export { errorNamed } from "./index.js";

// The trust chain.
export { keyThumbprint, publicJwkOf, releaseDigest, trustedRootFromPinnedKey, verifyManifest, verifyRootMetadata } from "./index.js";
export type { Verdict, VerifyManifestInput } from "./index.js";

// Canonical JSON.
export { CanonicalJsonError, canonicalBytes, canonicalJson, sha256Prefixed } from "./index.js";
export type { CanonicalJsonRefusal } from "./index.js";

// Arm assignment and the ramp walk (`protocol/assignment-hash.md`).
export type { AssignmentRefusal } from "./index.js";
export { ASSIGNMENT_MODULUS, AssignmentError, armForBucket, assignArm, bucketFromHash, effectiveArms, isAssignmentError, rampWeightsAt, subjectHash, validateArms, validateRamp } from "./index.js";

// Rendering a template, and the reference a rendered prompt carries.
export { MissingVariableError, UnknownVariableError, placeholdersOf, renderTemplate, xmlDelimiters } from "./index.js";
export type { Delimiters, RenderInput, RunRefEntry } from "./index.js";

// Declared output checks and golden sets.
export { evaluateChecks } from "./index.js";
export type { CheckOutcome, CheckResult, DeclaredCheck } from "./index.js";
export { GOLDEN_SET_FORMAT, GOLDEN_SET_VERSION, GoldenSetError, goldenReportsMeet, parseGoldenSet, runGoldenSet } from "./index.js";
export type { GoldenCase, GoldenCaseResult, GoldenInvocation, GoldenInvoke, GoldenReport, GoldenSet } from "./index.js";
// The rubric `ap.judge` takes and the result it returns.
export type { JudgeResult, JudgeRubric } from "./index.js";

// Bundles (`.apbundle` v1) and the release a bundle becomes.
export { BundleError, createEncryptedBundle, createPlaintextBundle, distributionKeyId, generateX25519KeyPair, openBundle, x25519PrivateKeyFromRaw, x25519PublicKeyFromRaw } from "./index.js";
export type { DistributionKey } from "./index.js";
export { BundleRelease } from "./index.js";
export type { BundleReleaseInput, BundleReleaseRefusal, LoadedRelease, ReleaseReader, ReleaseSlot } from "./index.js";

// The control-plane client.
export { SyncClient } from "./index.js";
export type { ControlPlaneRefusal, FetchLike, ManifestFetch, SyncClientOptions } from "./index.js";

// The telemetry rows (`protocol/spool-format.md`) and where they are sent.
export { ERROR_CLASSES, LATENCY_BUCKET_EDGES_MS, STEP_BOUNDS, USAGE_SOURCES, epochMinute, latencyBucketIndex, minuteOf } from "./index.js";
export type { DroppedRow, ErrorClass, Observation, RefusalRow, RunDimensions, RunTotals, SpoolRow, StepRow, StepTotals, TokenMoments, TokenTotals, UsageSource, WindowRow } from "./index.js";
export type { UploadOutcome, UploadSegment, UploadSink } from "./index.js";
export { normalizeFeedback } from "./index.js";
export type { FeedbackRejection, NormalizedFeedback } from "./index.js";

// The ports, and the Node implementations of them.
export { nodeFs, systemClock } from "./index.js";
export type { ClockPort, FetchPort, FsFailure, FsOpenFlags, FsPort } from "./index.js";
