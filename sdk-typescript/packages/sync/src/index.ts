/**
 * `@airprompter/agent-sync` — pulling and holding releases: the encrypted
 * restart-safe slot store, the key providers, the sync pass and its loop,
 * the apply policy and its windows, and the customer's datastore. What the
 * store loads is a `LoadedRelease` (`@airprompter/agent-core`) for
 * `@airprompter/agent-runtime` to serve; this package never imports the
 * runtime or the telemetry package (S10).
 *
 * @example
 * ```ts
 * import { SlotStore, fileKey, syncOnce } from "@airprompter/agent-sync";
 *
 * const store = await SlotStore.open({ stateDir, agentId, target: "prod", keyProvider: fileKey(join(stateDir, "store.key")) });
 * const pass = await syncOnce({ store, client, now, scope, trustedRoot, active: null, etag: null, applyPolicy: () => "activated" });
 * // pass.outcome: "activated" | "staged" | "unchanged" | "refused" | "unavailable" | … — never a throw past here
 * // The fleet over the customer's own datastore: the puller writes through a DAO, runtimes hydrate from it.
 * await pullToDatastore({ datastore, region: "eu-west-1", client, scope, trustedRoot, fetchRoot, now, distributionPublicKey });
 * ```
 */

export { SlotStore, StoreError, isStoreError, STORE_FORMAT_VERSION, STORE_FORMATS_READ } from "./store/slotStore.js";
export type { ApplyPolicyPin, LoadedSlot, SlotName, StoreFile, StoreHooks, StoreErrorCode, OpenStoreInput } from "./store/slotStore.js";
export { fileKey, customKeyProvider, wrapWithRawKey, unwrapWithRawKey } from "./store/keyProvider.js";
export type { KeyProvider, StorageProtection } from "./store/keyProvider.js";
export { encryptPayload, decryptPayload, payloadAad, PayloadDecryptError, isPayloadDecryptError } from "./store/payloadCrypto.js";

export { syncOnce, jitteredDelayMs, requiredModelsMissing } from "./sync/loop.js";
export { pullBundle, nextPullDelayMs, DEFAULT_MAX_POINTER_AGE_MS } from "./sync/pullBundle.js";
export type { PullBundleInput, PullBundleResult, PullEdgeState } from "./sync/pullBundle.js";
export { pullToDatastore } from "./sync/pullToDatastore.js";
export type { PullToDatastoreInput, PullToDatastoreResult } from "./sync/pullToDatastore.js";
export { MemoryReleaseDatastore, KvReleaseDatastore, kvReleaseDatastore, resolveHydration, rollbackDatastore, clearDatastoreRollback, pruneDatastore, rolloutOf, globalKeyOf } from "./store/releaseDatastore.js";
export { MemoryKvStore, fsKvStore, checkKvStore } from "./store/kvStore.js";
export type { KvStore, KvEntry, KvPutCondition, KvStoreReport } from "./store/kvStore.js";
export { DATASTORE_FORMAT, DatastoreRecordError, isDatastoreRecordError, datastoreKeys, encodeKeySegment, encodeDatastoreRecord, decodeDatastoreRecord, generationOfReleaseKey } from "./store/datastoreRecords.js";
export type { DatastoreKeys, DatastoreRecord, DatastoreRecordErrorCode } from "./store/datastoreRecords.js";
export type { ReleaseDatastore, ReleaseKey, StoredReleaseRow, ReleaseControl, ReleaseRollout, RolloutExperiment, HydrationPlan, DatastoreRollbackResult } from "./store/releaseDatastore.js";
export type { SyncPassInput, SyncPassOutput, SyncPassResult, ApplyPolicyDecision } from "./sync/loop.js";

export { parseWindow, validateWindow, isKnownTimeZone, windowState } from "./apply/window.js";
export type { UpdateWindow, WindowDay, WindowState } from "./apply/window.js";
