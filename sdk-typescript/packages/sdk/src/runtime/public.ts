/**
 * `@airprompter/agent-sdk/runtime`, the names 1.0 promises: serving a release the application already holds. Which
 * slot a subject gets under which arm, the rendered text and its reference, the slot's sealed settings applied to a
 * request, the run's types, `observeCall`, the `ap.attribute` scope, and the variable sources a render reads.
 *
 * This file is the subpath; `./index.ts` is the layer's barrel, what the agent and `frameworks/contract` import, and
 * nothing a customer can reach. The run registry and what the adapters share (`./adapter/`) are internal.
 * `test/publicSurface.test.ts` pins this list; `docs/stability.md` says what the promise covers.
 *
 * @example
 * ```ts
 * import { ReleaseResolver } from "@airprompter/agent-sdk/runtime";
 *
 * const runtime = new ReleaseResolver({ release, runRefKey, agentId, target: "prod", instanceId, nowMs: Date.now });
 * const slot = runtime.resolve("support.triage", userId); // { ok: true, slot, arm, bucket } or why not
 * ```
 */

// Assignment and rendering over a held release.
export { ReleaseResolver, newSubject } from "./index.js";
export type { Disabled, Rendered, ResolveOutcome, ResolverInput } from "./index.js";
export { applyInference } from "./index.js";
export type { AppliedInference, InferenceUnsupportedReason, RequestKind } from "./index.js";

// The run: what `ap.run` hands the application and an adapter.
export type { AgentRuntime, ModelCallRecord, ModelResolver, Placement, RunInput, RunSession, TokenUsage, ToolCallRecord, UnavailableReason } from "./index.js";

// Measuring a call the application placed itself, and the `ap.attribute` scope.
export { normalizeUsage, observeCall } from "./index.js";
export type { ObserveOptions, ObserveTarget, UsageNormalized } from "./index.js";
export { currentAttribution, withAttribution } from "./index.js";
export type { Attribution } from "./index.js";

// Variable sources (`docs/variables.md`).
export { VariableSourceError, VariableSourceRequiredError, isVariableSourceError, isVariableSourceRequiredError } from "./index.js";
export type { RegisteredSource, RenderValues, VariableSource, VariableSourceContext, VariableSourceInput, VariableSourceRegistry } from "./index.js";
