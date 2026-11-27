/**
 * The run session: what one request is. See `types.ts` for the shape an
 * adapter sees, `session.ts` for the rules, and `pin.ts` for what a reduction
 * does to a pinned slot. Nothing here imports the telemetry or sync code: rows
 * leave through `RunRecorder`.
 *
 * @example
 * ```ts
 * import { RunRegistry, type RunSession } from "../index.js"; // the runtime barrel; the registry is internal, `RunSession` is on `/runtime`
 * ```
 */

export { RunRegistry, DEFAULT_RUN_IDLE_TIMEOUT_MS, MAX_OPEN_RUNS } from "./registry.js";
export { pinVerdict, type PinVerdict } from "./pin.js";
export type { RunHost, RunRecorder } from "./ports.js";
export type { AgentRuntime, ModelCallRecord, ModelResolver, Placement, RunInput, RunSession, TokenUsage, ToolCallRecord, UnavailableReason } from "./types.js";
