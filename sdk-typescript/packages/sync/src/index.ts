/**
 * `@airprompter/agent-sync` — pulling and holding releases: the encrypted
 * restart-safe slot store, the key providers, the sync pass and its loop,
 * the apply policy and its windows, and the daemon client. What the store
 * or the daemon loads is a `LoadedRelease` (`@airprompter/agent-core`) for
 * `@airprompter/agent-runtime` to serve; this package never imports the
 * runtime or the telemetry package (S10).
 */

export { SlotStore, StoreError, isStoreError, STORE_FORMAT_VERSION, STORE_FORMATS_READ } from "./store/slotStore.js";
export type { ApplyPolicyPin, LoadedSlot, SlotName, StoreFile, StoreHooks, StoreErrorCode, OpenStoreInput } from "./store/slotStore.js";
export { fileKey, customKeyProvider, wrapWithRawKey, unwrapWithRawKey } from "./store/keyProvider.js";
export type { KeyProvider, StorageProtection } from "./store/keyProvider.js";
export { encryptPayload, decryptPayload, payloadAad, PayloadDecryptError, isPayloadDecryptError } from "./store/payloadCrypto.js";

export { syncOnce, jitteredDelayMs, requiredModelsMissing } from "./sync/loop.js";
export { pullBundle, nextPullDelayMs } from "./sync/pullBundle.js";
export type { PullBundleInput, PullBundleResult, PullEdgeState } from "./sync/pullBundle.js";
export type { SyncPassInput, SyncPassOutput, SyncPassResult, ApplyPolicyDecision } from "./sync/loop.js";
export { DaemonClient, DaemonError, isDaemonError, daemonSocketPath, DAEMON_MAX_LINE_BYTES, UNIX_SOCKET_PATH_MAX } from "./sync/daemon.js";
export type { DaemonHello, DaemonSlotResponse, DaemonGenerationEvent, DaemonApplyPolicy, DaemonPolicyEvent, DaemonLeaseEvent, DaemonErrorCode } from "./sync/daemon.js";

export { parseWindow, validateWindow, isKnownTimeZone, windowState } from "./apply/window.js";
export type { UpdateWindow, WindowDay, WindowState } from "./apply/window.js";
