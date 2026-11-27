/**
 * The three pure helpers every framework adapter uses, re-exported by
 * `@airprompter/agent-sdk/frameworks/contract`: which model a placement runs
 * on, the sealed settings under a framework's own key names, and one model
 * call timed into a run. They decide nothing about versions or rows: the run
 * session owns those.
 *
 * @example
 * ```ts
 * const placed = await run.place("support.reply");
 * if (placed.kind === "approved") {
 *   const model = chooseModel({ releaseModelId: placed.model, callerModel: params.model, callerModelId: params.model, resolve: (id) => id });
 *   if (model === undefined) run.decline("support.reply", "model_unresolved");
 *   const { values } = settingsFor(placed.settings, { temperatureMilli: "temperature", maxOutputTokens: "maxTokens" }); // { temperature: 0.2, maxTokens: 800 }
 *   await measureCall(run, "support.reply", () => client.call({ ...params, ...values, model }), { model: String(model) });
 * }
 * ```
 */

import { outputTextOf, type SlotInference } from "../../core/index.js";
import { classifyError, classifyResult, normalizeUsage } from "../observe.js";
import type { ModelResolver, RunSession } from "../run/index.js";
import { INFERENCE_KEYS, applyInference, temperatureOf, topPOf, type AppliedInference } from "./inference.js";

export interface ChooseModelInput<TModel> {
  releaseModelId: string;
  callerModel: TModel;
  callerModelId: string | undefined;
  modelFor?: ModelResolver<TModel>;
  /** The adapter's own way to build the release's model. A string result is for the adapter to build. */
  resolve?: (releaseModelId: string) => TModel | string | undefined;
}

/**
 * In order: `modelFor` when given; else the caller's model when its id equals the release's; else the adapter's own
 * resolver; else undefined, and the adapter calls `run.decline(slot, "model_unresolved")`. Approved text never runs on
 * a model the release did not pin.
 */
export function chooseModel<TModel>(input: ChooseModelInput<TModel>): TModel | string | undefined {
  if (input.modelFor) return input.modelFor(input.releaseModelId, input.callerModel);
  if (input.callerModelId !== undefined && input.callerModelId === input.releaseModelId) return input.callerModel;
  if (input.resolve) return input.resolve(input.releaseModelId);
  return undefined;
}

/** A framework's key name per sealed setting. A setting with no key is reported as unsupported. */
export type SettingsKeys = Partial<Record<keyof SlotInference, string>>;

const unset = (value: unknown): value is null | undefined => value === undefined || value === null;

function valueOf(key: keyof SlotInference, settings: Readonly<SlotInference>): unknown {
  switch (key) {
    case "temperatureMilli": return temperatureOf(settings);
    case "topPBps": return topPOf(settings);
    case "maxOutputTokens": return unset(settings.maxOutputTokens) ? undefined : settings.maxOutputTokens;
    case "stopSequences": return unset(settings.stopSequences) ? undefined : [...settings.stopSequences];
    case "reasoningEffort": return unset(settings.reasoningEffort) ? undefined : settings.reasoningEffort;
  }
}

/** Sealed settings under a framework's own key names, floats where the wire holds integers. Unmapped keys are returned for logging. */
export function settingsFor(settings: Readonly<SlotInference>, keys: SettingsKeys): { values: Record<string, unknown>; unsupported: Array<keyof SlotInference> } {
  const values: Record<string, unknown> = {};
  const unsupported: Array<keyof SlotInference> = [];
  for (const key of INFERENCE_KEYS) {
    const value = valueOf(key, settings);
    if (value === undefined) continue;
    const name = keys[key];
    if (name === undefined) unsupported.push(key);
    else values[name] = value;
  }
  return { values, unsupported };
}

/** The sealed settings on a direct client's request: a copy, the release's values over the call site's. */
export function applySettings(kind: "chat" | "responses" | "messages", params: Record<string, unknown>, settings: Readonly<SlotInference>): AppliedInference {
  return applyInference(kind, params, settings);
}

export interface MeasureOptions {
  /** The model the call ran on, as the row names it. */
  model: string;
  step?: string;
  now?: () => number;
  /** The result in a shape `normalizeUsage`, `classifyResult` and `outputTextOf` read, when the framework's is not. */
  read?: (result: unknown) => unknown;
  /** The caller sees every tool call this slot's requests make (`ModelCallRecord.toolsObserved`). */
  toolsObserved?: boolean;
}

/** Times one model call into a session: usage, finish reason, error class, output text for declared checks. Rethrows. */
export async function measureCall<T>(run: RunSession, slot: string, call: () => Promise<T> | T, options: MeasureOptions): Promise<T> {
  const now = options.now ?? Date.now;
  const started = now();
  const base = { model: options.model, ...(options.step !== undefined ? { step: options.step } : {}), ...(options.toolsObserved !== undefined ? { toolsObserved: options.toolsObserved } : {}) };
  let result: T;
  try {
    result = await call();
  } catch (error) {
    run.recordModelCall(slot, { ...base, latencyMs: Math.max(0, now() - started), errorClass: classifyError(error) });
    throw error;
  }
  try {
    const shaped = options.read ? options.read(result) : result;
    const errorClass = classifyResult(shaped);
    const text = outputTextOf(shaped);
    run.recordModelCall(slot, { ...base, latencyMs: Math.max(0, now() - started), usage: normalizeUsage(shaped), ...(errorClass ? { errorClass } : {}), ...(text !== null ? { outputText: text } : {}) });
  } catch {
    // An unreadable result still counts as a call, with no usage.
    run.recordModelCall(slot, { ...base, latencyMs: Math.max(0, now() - started) });
  }
  return result;
}
