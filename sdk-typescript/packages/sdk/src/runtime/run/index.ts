/**
 * The run session: what one request is. See `types.ts` for the shape an
 * adapter sees, and `session.ts` for the rules.
 *
 * @example
 * ```ts
 * import { RunRegistry, type RunSession } from "@airprompter/agent-sdk/runtime";
 * ```
 */

export { RunRegistry, DEFAULT_RUN_IDLE_TIMEOUT_MS } from "./registry.js";
export type { RunHost } from "./ports.js";
export type { AgentRuntime, ModelCallRecord, Placement, RunInput, RunSession, ToolCallRecord, UnavailableReason } from "./types.js";
