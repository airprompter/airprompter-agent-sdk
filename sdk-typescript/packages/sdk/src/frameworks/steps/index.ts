/**
 * `@airprompter/agent-sdk/frameworks/steps`: AirPrompter Agents for a no-code automation step — the one
 * platform-agnostic core the Zapier app and the n8n nodes build on (AIR-2405). A platform package keeps only what
 * differs: its storage (a `KvStore` or a `ReleaseDatastore`), its credential fields, its field schemas, where it keeps
 * the poll cursor, and how it maps `AutomationError` to its own error kinds. Nothing here imports a platform package.
 *
 * Outside the 1.0 promise for now; TypeScript only (Python follows in AIR-2406). A platform package imports the SDK
 * only through this subpath (`scripts/lint-imports.mjs` enforces it for `integrations/*`), so the storage pieces it
 * needs from `/sync` and `/core` are re-exported here.
 *
 * @example
 * ```ts
 * import { MemoryKvStore, createAutomationClient, kvAutomationDatastore } from "@airprompter/agent-sdk/frameworks/steps";
 * const client = createAutomationClient({ agentId, updateKey, baseUrl, datastore: kvAutomationDatastore(new MemoryKvStore()) });
 * const served = await client.getPrompt({ slot: "support.triage", variables: { ticket }, subject: customerId });
 * await client.reportRun({ runRef: served.runRef, inputTokens: 812, outputTokens: 96 }); // the run's one count
 * ```
 */

export { createAutomationClient } from "./client.js";
export { AutomationError, isAutomationError } from "./types.js";
export type { AutomationClient, AutomationClientOptions, AutomationDatastore, AutomationErrorCode, GetPromptResult, InferenceSettings, ReportRunInput, RolloutCursor, RolloutEvent, RolloutState, SlotInfo, VariableInfo } from "./types.js";
export { HOSTED_ROOTS, connectionLabel, distributionKeyFor, pinnedRootFor, timedFetch } from "./trust.js";
export { rolloutChanges, slotsOf, variablesOf } from "./rollout.js";
export { errorClassOf, runReportOf } from "./usage.js";
export type { UsageInput } from "./usage.js";
export { usageFrom } from "./usageShapes.js";
export { kvAutomationDatastore, seedDatastoreFromBundle } from "./datastore.js";

// What a platform's storage and credential code needs from the layers below, so it never imports them itself.
export { MemoryKvStore, fsKvStore, kvReleaseDatastore } from "../../sync/index.js";
export type { KvEntry, KvPutCondition, KvStore, ReleaseDatastore } from "../../sync/index.js";
export type { Bundle, FetchLike, HostedEnvironment, P256PublicJwk } from "../../core/index.js";
