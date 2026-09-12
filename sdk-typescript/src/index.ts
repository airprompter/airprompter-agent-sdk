export { AirPrompterAgent, AgentStartError, RenderRefusedError, SDK_NAME, SDK_VERSION } from "./agent.js";
export type { AgentStatus, Rendered, StartOptions, SyncMode, ReleaseSource, ReleaseChange } from "./agent.js";
export { DaemonClient, DaemonError, daemonSocketPath, DAEMON_MAX_LINE_BYTES } from "./sync/daemon.js";
export type { DaemonHello, DaemonSlotResponse, DaemonGenerationEvent } from "./sync/daemon.js";

export { canonicalJson, canonicalBytes, sha256Prefixed, CanonicalJsonError } from "./protocol/canonicalJson.js";
export { assignArm, subjectHash, bucketFromHash, armForBucket, validateArms, orderedSteps, AssignmentError, StepError, ASSIGNMENT_MODULUS } from "./protocol/assignment.js";
export { keyThumbprint, publicJwkOf, signBytes, verifyBytes, trustedRootFromPinnedKey, verifyRootMetadata, verifyManifest, referencedPayloads, releaseDigest, releaseDigestInput, instant } from "./protocol/trust.js";
export type { Verdict, VerifyManifestInput } from "./protocol/trust.js";
export type * from "./protocol/types.js";

export { SlotStore, StoreError } from "./store/slotStore.js";
export type { LoadedSlot, SlotName, StoreFile, StoreHooks } from "./store/slotStore.js";
export { fileKey, customKeyProvider, wrapWithRawKey, unwrapWithRawKey } from "./store/keyProvider.js";
export type { KeyProvider, StorageProtection } from "./store/keyProvider.js";
export { encryptPayload, decryptPayload, payloadAad, PayloadDecryptError } from "./store/payloadCrypto.js";

export { createPlaintextBundle, createEncryptedBundle, openBundle, bundlePayloadBytes, distributionKeyId, BundleError, APBUNDLE_INFO } from "./bundle/apbundle.js";
export type { DistributionKey } from "./bundle/apbundle.js";
export { generateX25519KeyPair, x25519PrivateKeyFromRaw, x25519PublicKeyFromRaw } from "./bundle/hpke.js";

export { renderTemplate, xmlDelimiters, MissingVariableError, UnknownVariableError } from "./render/template.js";
export type { Delimiters, RenderInput } from "./render/template.js";
export { mintRunRef, parseRunRef } from "./render/runRef.js";
export type { RunRefFacts } from "./render/runRef.js";

export { SpoolWriter, DirectorySink, MemorySink, latencyBucketIndex, minuteOf, epochMinute, segmentName, LATENCY_BUCKET_EDGES_MS, SEGMENT_MAX_BYTES } from "./spool/writer.js";
export type { Observation, WindowRow, RefusalRow, SpoolRow, SpoolSink, ErrorClass } from "./spool/writer.js";

export { SyncClient } from "./sync/client.js";
export type { FetchLike, ManifestFetch, SyncClientOptions } from "./sync/client.js";
export { syncOnce, jitteredDelayMs } from "./sync/loop.js";
export type { SyncPassInput, SyncPassOutput, SyncPassResult, ApplyPolicyDecision } from "./sync/loop.js";
export { normalizeFeedback, type NormalizedFeedback, type FeedbackRejection } from "./spool/feedback.js";

export { ManagedAgent, ManagedRunError, parseSse, MANAGED_SDK_USER_AGENT } from "./managed/client.js";
export type { ManagedStartOptions, ManagedRunOptions, ManagedRunResult, ManagedRunStream, ManagedCatalogue, ManagedSlot, ManagedRefusalCode, ManagedFetchLike, ManagedTarget } from "./managed/client.js";
export { classifyError, classifyResult, normalizeUsage, observeCall, type ObserveOptions, type ObserveTarget, type UsageNormalized } from "./telemetry/observe.js";
export { HOST_SPOOL_BUDGET_BYTES, SERVERLESS_BUFFER_BYTES, type DroppedRow } from "./spool/writer.js";
export { SpoolUploader, validateSpoolRow, inspectSegment, postSegment, multipartBody, backoffDelayMs, UPLOAD_BACKOFF_BASE_MS, UPLOAD_BACKOFF_CAP_MS, GRANT_REFRESH_MARGIN_MS } from "./telemetry/uploader.js";
export type { UploadGrant, GrantDecision, UploaderOptions, UploaderStatus, PassResult, PostOutcome, RowVerdict, SegmentInspection } from "./telemetry/uploader.js";
export type { SpoolReport, HeartbeatSdkName } from "./agent.js";
