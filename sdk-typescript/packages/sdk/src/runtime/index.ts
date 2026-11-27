/**
 * The runtime layer's barrel, what the layers above import (the subpath `@airprompter/agent-sdk/runtime` is the curated `./public.ts`): serving a verified release: which slot a
 * subject gets under which arm (the ramp walked on this host's clock, a
 * retreat honoured), the rendered text with its run reference, the run
 * session, and the `ap.attribute` scope. What the framework adapters share
 * lives in `runtime/adapter/`, reached only through `frameworks/contract`.
 * Consumes a
 * `LoadedRelease` from `@airprompter/agent-sdk/core` — the slot store or a
 * bundle the customer loaded — and never imports the sync or the
 * telemetry layer. `variables/` is how the application fills a
 * prompt's variables from its own system at render time.
 *
 * @example
 * ```ts
 * import { ReleaseResolver, observeCall } from "@airprompter/agent-sdk/runtime";
 *
 * const runtime = new ReleaseResolver({ release, runRefKey, agentId, target: "prod", instanceId, nowMs: Date.now });
 * const slot = runtime.resolve("support.triage", userId); // { ok: true, slot, arm, bucket } or why not
 * if (slot.ok) {
 *   const r = runtime.render(slot, { team: "Billing", ticket: userMessage }); // { text, model, versionId, arm, generation, runRef, tag }
 *   await observeCall(r, () => openai.chat.completions.create({ model: r.model, messages: [{ role: "user", content: r.text }] }), record);
 * }
 * ```
 */

export { ReleaseResolver, disabledFrom, newSubject } from "./release/resolver.js";
export { RunRegistry, DEFAULT_RUN_IDLE_TIMEOUT_MS } from "./run/index.js";
export { MAX_OPEN_RUNS, pinVerdict, type PinVerdict } from "./run/index.js";
export type { AgentRuntime, ModelCallRecord, ModelResolver, Placement, RunHost, RunInput, RunRecorder, RunSession, TokenUsage, ToolCallRecord, UnavailableReason } from "./run/index.js";
export { VariableSourceRegistry, VariableSourceError, VariableSourceRequiredError, isVariableSourceError, isVariableSourceRequiredError, DEFAULT_SOURCE_TIMEOUT_MS, DEFAULT_SOURCE_MAX_BYTES } from "./variables/sources.js";
export type { VariableSource, VariableSourceInput, VariableSourceContext, RegisteredSource } from "./variables/sources.js";
export { planFill, fillSync, fillAsync, unsourced, supplied } from "./variables/fill.js";
export type { FillPlan, FilledRender, RenderValues } from "./variables/fill.js";
export type { Rendered, Disabled, ResolverInput, ResolveOutcome } from "./release/resolver.js";
export { applyInference, temperatureOf, topPOf, INFERENCE_KEYS } from "./wrap/inference.js";
export type { AppliedInference, InferenceUnsupportedReason, RequestKind } from "./wrap/inference.js";

export { classifyError, classifyResult, normalizeUsage, observeCall, type ObserveOptions, type ObserveTarget, type UsageNormalized } from "./observe.js";
export { withAttribution, currentAttribution } from "./wrap/attribution.js";
export type { Attribution } from "./wrap/attribution.js";

