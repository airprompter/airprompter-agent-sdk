/**
 * `@airprompter/agent-runtime` — serving a verified release: which slot a
 * subject gets under which arm (the ramp walked on this host's clock, a
 * retreat honoured), the rendered text with its run reference, the
 * provider wrappers that attribute a model call to a render and classify
 * what came back, and the hosted-execution client. Consumes a
 * `LoadedRelease` from `@airprompter/agent-core` — the slot store, a daemon
 * or a bundle the customer loaded — and never imports the sync or the
 * telemetry package (S10).
 */

export { ReleaseResolver, disabledFrom } from "./release/resolver.js";
export type { Rendered, Disabled, ResolverInput, ResolveOutcome } from "./release/resolver.js";
export { applyInference, temperatureOf, topPOf } from "./wrap/inference.js";
export type { AppliedInference } from "./wrap/inference.js";

export { classifyError, classifyResult, normalizeUsage, observeCall, type ObserveOptions, type ObserveTarget, type UsageNormalized } from "./observe.js";
export { wrapClient, accumulatorFor, WRAPPED_METHODS } from "./wrap/client.js";
export type { WrapHooks, StreamKind } from "./wrap/client.js";
export { RenderRegistry, requestTexts, hashText, withAttribution, currentAttribution } from "./wrap/attribution.js";
export type { Attribution } from "./wrap/attribution.js";
export { aiSdkMiddleware, generateResultShape } from "./wrap/aiSdk.js";
export type { AiSdkMiddleware, AiSdkMiddlewareOptions, AiSdkMiddlewareHooks } from "./wrap/aiSdk.js";

export { ManagedAgent, ManagedRunError, isManagedRunError, parseSse, MANAGED_SDK_USER_AGENT } from "./managed/client.js";
export type { ManagedStartOptions, ManagedRunOptions, ManagedRunResult, ManagedRunStream, ManagedCatalogue, ManagedSlot, ManagedRefusalCode, ManagedFetchLike, ManagedTarget } from "./managed/client.js";
