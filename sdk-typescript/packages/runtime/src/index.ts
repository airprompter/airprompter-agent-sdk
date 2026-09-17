/**
 * `@airprompter/agent-runtime` — serving a verified release: which slot a
 * subject gets under which arm (the ramp walked on this host's clock, a
 * retreat honoured), the rendered text with its run reference, the
 * provider wrappers that attribute a model call to a render and classify
 * what came back, and the hosted-execution client. Consumes a
 * `LoadedRelease` from `@airprompter/agent-core` — the slot store, a daemon
 * or a bundle the customer loaded — and never imports the sync or the
 * telemetry package (S10). `variables/` is how the application fills a
 * prompt's variables from its own system at render time.
 *
 * @example
 * ```ts
 * import { ReleaseResolver, observeCall } from "@airprompter/agent-runtime";
 *
 * const runtime = new ReleaseResolver({ release, runRefKey, agentId, target: "prod", instanceId, nowMs: Date.now });
 * const slot = runtime.resolve("support.triage", userId); // { ok: true, slot, arm, bucket } or why not
 * if (slot.ok) {
 *   const r = runtime.render(slot, { team: "Billing", ticket: userMessage }); // { text, model, versionId, arm, generation, runRef, tag }
 *   await observeCall(r, () => openai.chat.completions.create({ model: r.model, messages: [{ role: "user", content: r.text }] }), record);
 * }
 * ```
 */

export { ReleaseResolver, disabledFrom } from "./release/resolver.js";
export { VariableSourceRegistry, VariableSourceError, VariableSourceRequiredError, isVariableSourceError, isVariableSourceRequiredError, DEFAULT_SOURCE_TIMEOUT_MS, DEFAULT_SOURCE_MAX_BYTES } from "./variables/sources.js";
export type { VariableSource, VariableSourceInput, VariableSourceContext, RegisteredSource } from "./variables/sources.js";
export { planFill, fillSync, fillAsync, unsourced, stricterSources, supplied } from "./variables/fill.js";
export type { FillPlan, FilledRender, RenderValues } from "./variables/fill.js";
export type { Rendered, Disabled, ResolverInput, ResolveOutcome } from "./release/resolver.js";
export { applyInference, temperatureOf, topPOf, INFERENCE_KEYS } from "./wrap/inference.js";
export type { AppliedInference, ApplyInferenceOptions, InferenceUnsupportedReason } from "./wrap/inference.js";

export { classifyError, classifyResult, normalizeUsage, observeCall, type ObserveOptions, type ObserveTarget, type UsageNormalized } from "./observe.js";
export { wrapClient, accumulatorFor, WRAPPED_METHODS } from "./wrap/client.js";
export type { WrapHooks, StreamKind } from "./wrap/client.js";
export { RenderRegistry, requestTexts, hashText, withAttribution, currentAttribution } from "./wrap/attribution.js";
export type { Attribution } from "./wrap/attribution.js";
export { aiSdkMiddleware, generateResultShape } from "./wrap/aiSdk.js";
export type { AiSdkMiddleware, AiSdkMiddlewareOptions, AiSdkMiddlewareHooks } from "./wrap/aiSdk.js";

export { ManagedAgent, ManagedRunError, isManagedRunError, parseSse, MANAGED_SDK_USER_AGENT } from "./managed/client.js";
export type { ManagedStartOptions, ManagedRunOptions, ManagedRunResult, ManagedRunStream, ManagedCatalogue, ManagedSlot, ManagedRefusalCode, ManagedFetchLike, ManagedTarget } from "./managed/client.js";
