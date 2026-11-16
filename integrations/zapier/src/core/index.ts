/**
 * The platform-agnostic core of the AirPrompter automation integrations (Zapier today, n8n beside it): the client,
 * its contract, and the pieces a platform layer needs. Nothing here imports a platform package; a platform supplies a
 * `ReleaseDatastore` over its own storage and maps `AutomationError` to its own error kinds.
 *
 * @example
 * ```ts
 * import { createAutomationClient, isAutomationError } from "./core/index.js";
 * const client = createAutomationClient({ agentId, updateKey, baseUrl, datastore });
 * const check = await client.testConnection(); // { ok: true, agentId, environment } | { ok: false, reason }
 * ```
 */

export { createAutomationClient } from "./client.js";
export { AutomationError, isAutomationError } from "./types.js";
export type { AutomationClient, AutomationClientOptions, AutomationDatastore, AutomationErrorCode, GetPromptResult, InferenceSettings, ReportRunInput, RolloutCursor, RolloutEvent, RolloutState, SlotInfo, VariableInfo } from "./types.js";
export { HOSTED_ROOTS, connectionLabel, distributionKeyFor, pinnedRootFor, timedFetch } from "./trust.js";
export { rolloutChanges, slotsOf, variablesOf } from "./rollout.js";
export { attachUsage, errorClassOf } from "./usage.js";
