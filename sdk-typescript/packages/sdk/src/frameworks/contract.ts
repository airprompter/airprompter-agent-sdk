/**
 * `@airprompter/agent-sdk/frameworks/contract`: the one contract every
 * framework adapter follows. An adapter asks the run for the approved prompt,
 * model and settings, puts them into the framework's call, and reports what
 * the call cost. It imports this file and its framework, nothing else
 * (`scripts/lint-imports.mjs` enforces it).
 *
 * Stability: this subpath is public so third-party adapters can read it, but
 * it is outside the 1.0 promise. A minor release may change it while the
 * LangChain and OpenAI Agents adapters prove its shapes.
 *
 * Rules for every adapter:
 *
 * 1. Read `run.runRef` late and store the latest value in framework state. It
 *    grows as slots pin. Never cache it.
 * 2. The run owns text, version and rows. An adapter never mints a run
 *    reference, never writes a row, never reads a release.
 * 3. Finding the run: `acquireRun(ap, { ...input, resume: ref })` —
 *    `ap.currentRun()`, else, with no scope across hooks, `ap.openRun`, which is
 *    get-or-create and safe on every hook. End only a run it says you `owned`.
 * 4. A stream returned out of `ap.run` is the caller's to consume inside it.
 *    Records that arrive after the run ended are dropped with one log.
 *
 * Check `placed.kind === "approved"` and treat anything else as a passthrough,
 * which always leaves the framework's request untouched: its own prompt and
 * model run. The release's model wins or the slot declines
 * (`run.decline(slot, "model_unresolved")`): approved text never runs on a
 * model the release did not pin.
 *
 * Measure with the release's model id (`placed.model`) whatever id the
 * framework sent, through `measureCall` or, for a start and end in different
 * hooks or a stream, `beginMeasure`. Pass the agent's clock as `now` so a
 * recorded run replays the same. Log with `ADAPTER_EVENTS`, each event
 * carrying `adapter`, `slot` and `method`.
 *
 * Not to be confused with the repository's `integrations/` folder (the Zapier
 * and n8n platforms), which reaches the SDK only through `frameworks/steps`.
 *
 * @example
 * ```ts
 * import { acquireRun, chooseModel, measureCall, settingsFor, type AgentRuntime } from "@airprompter/agent-sdk/frameworks/contract";
 *
 * async function onModelCall(ap: AgentRuntime, request: MyRequest) {
 *   const { run } = acquireRun(ap, { resume: request.state.runRef });
 *   const placed = await run.place("support.reply");
 *   if (placed.kind !== "approved") return request.next();
 *   // A string would be an id to build a model from; this framework cannot, so only its own model object will do.
 *   const model = chooseModel({ releaseModelId: placed.model, callerModel: request.model, callerModelId: request.model.id });
 *   if (model === undefined || typeof model === "string") return (run.decline("support.reply", "model_unresolved"), request.next());
 *   const { values } = settingsFor(placed.settings, { temperatureMilli: "temperature", maxOutputTokens: "maxTokens" });
 *   request.state.runRef = run.runRef; // rule 1: the latest value, read late
 *   return measureCall(run, "support.reply", () => request.next({ system: placed.instructions, model, ...values }), { model: placed.model });
 * }
 * ```
 */

export type { AgentRuntime, ModelCallRecord, ModelResolver, Placement, RunInput, RunSession, TokenUsage, ToolCallRecord, UnavailableReason } from "../runtime/index.js";
export type { AppliedInference, Attribution, ObserveOptions, ObserveTarget, RequestKind } from "../runtime/index.js";
export { classifyError, classifyResult, normalizeUsage } from "../runtime/index.js";
export { ADAPTER_EVENTS, acquireRun, applySettings, beginMeasure, chooseModel, instrumentClient, measureCall, settingsFor } from "../runtime/adapter/index.js";
export type { AdapterEvent, ApplyPlacement, ApprovedPlacement, ChooseModelInput, ClientMethod, ClientMethods, InstrumentClientOptions, InstrumentRuntime, MappedSettings, MeasureOptions, Measurement, Pending, SettingsKeys, StreamAccumulator } from "../runtime/adapter/index.js";
export type { SlotInference } from "../core/index.js";
