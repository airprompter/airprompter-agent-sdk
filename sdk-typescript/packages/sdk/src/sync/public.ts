/**
 * `@airprompter/agent-sdk/sync`, the names 1.0 promises: pulling and holding releases. The encrypted restart-safe
 * slot store and its key providers, the sync pass, the pointer-first pull, the apply windows, and the customer's
 * datastore (the `KvStore` a datastore package implements, and the release rows over it).
 *
 * This file is the subpath; `./index.ts` is the layer's barrel, what the agent imports, and nothing a customer can
 * reach. `test/publicSurface.test.ts` pins this list; `docs/stability.md` says what the promise covers.
 *
 * @example
 * ```ts
 * import { SlotStore, fileKey } from "@airprompter/agent-sdk/sync";
 *
 * const store = await SlotStore.open({ stateDir, agentId, target: "prod", keyProvider: fileKey(join(stateDir, "store.key")) });
 * ```
 */

// The slot store and its key.
export { SlotStore, StoreError, isStoreError } from "./index.js";
export type { ApplyPolicyPin, LoadedSlot, OpenStoreInput, SlotName, StoreErrorCode, StoreHooks } from "./index.js";
export { customKeyProvider, fileKey } from "./index.js";
export type { KeyProvider, StorageProtection } from "./index.js";
export { PayloadDecryptError, isPayloadDecryptError } from "./index.js";

// The sync pass, and the pointer-first pull.
export { syncOnce } from "./index.js";
export type { ApplyPolicyDecision, SyncPassInput, SyncPassOutput, SyncPassResult } from "./index.js";
export { nextPullDelayMs, pullBundle } from "./index.js";
export type { PullBundleInput, PullBundleResult, PullEdgeState } from "./index.js";

// The apply windows.
export { isKnownTimeZone, parseWindow, validateWindow, windowState } from "./index.js";
export type { UpdateWindow, WindowDay, WindowState } from "./index.js";

// The customer's datastore: a `KvStore` (what `@airprompter/datastore-*` implement), and the release rows over it.
export { MemoryKvStore, checkKvStore, fsKvStore } from "./index.js";
export type { KvEntry, KvPutCondition, KvStore, KvStoreReport } from "./index.js";
export { MemoryReleaseDatastore, clearDatastoreRollback, kvReleaseDatastore, pruneDatastore, pullToDatastore, rollbackDatastore } from "./index.js";
export type { DatastoreRollbackResult, KvReleaseDatastore, PullToDatastoreInput, PullToDatastoreResult, ReleaseControl, ReleaseDatastore, ReleaseKey, ReleaseRollout, RolloutExperiment, StoredReleaseRow } from "./index.js";
