/**
 * The helpers every framework adapter uses, re-exported by
 * `@airprompter/agent-sdk/frameworks/contract`: finding the run, which model a
 * placement runs on, the sealed settings under a framework's own key names,
 * and one model call timed into a run. They decide nothing about versions or
 * rows: the run session owns those.
 *
 * @example
 * ```ts
 * const { run, owned } = acquireRun(ap);
 * const placed = await run.place("support.reply");
 * if (placed.kind === "approved") {
 *   const model = chooseModel({ releaseModelId: placed.model, callerModel: params.model, callerModelId: params.model, resolve: (id) => id });
 *   if (model === undefined) run.decline("support.reply", "model_unresolved");
 *   const { values } = settingsFor(placed.settings, { temperatureMilli: "temperature", maxOutputTokens: "maxTokens" }); // { temperature: 0.2, maxTokens: 800 }
 *   await measureCall(run, "support.reply", () => client.call({ ...params, ...values, model }), { model: placed.model });
 * }
 * if (owned) run.end();
 * ```
 */

import { outputTextOf, type SlotInference } from "../../core/index.js";
import { classifyError, classifyResult, normalizeUsage } from "../observe.js";
import type { AgentRuntime, ModelResolver, RunInput, RunSession } from "../run/index.js";
import { INFERENCE_KEYS, applyInference, temperatureOf, topPOf, type AppliedInference, type RequestKind } from "./inference.js";
import type { Pending } from "./proxy.js";

/** Rule 3 of the contract: the run this hook is inside, else one opened (get-or-create with `resume`). End it only if `owned`. */
export function acquireRun(ap: AgentRuntime, input: RunInput = {}): { run: RunSession; owned: boolean } {
  const current = ap.currentRun();
  if (current) return { run: current, owned: false };
  return { run: ap.openRun(input), owned: true };
}

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
 * a model the release did not pin. A string result is a model id for the adapter to build (or, for a client whose
 * models are ids, the model itself); an adapter that cannot build one declines.
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
const same = (left: unknown, right: unknown): boolean => {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
};

function valueOf(key: keyof SlotInference, settings: Readonly<SlotInference>): unknown {
  switch (key) {
    case "temperatureMilli": return temperatureOf(settings);
    case "topPBps": return topPOf(settings);
    case "maxOutputTokens": return unset(settings.maxOutputTokens) ? undefined : settings.maxOutputTokens;
    case "stopSequences": return unset(settings.stopSequences) ? undefined : [...settings.stopSequences];
    case "reasoningEffort": return unset(settings.reasoningEffort) ? undefined : settings.reasoningEffort;
  }
}

export interface MappedSettings {
  /** The settings under the framework's names, floats where the wire holds integers. */
  values: Record<string, unknown>;
  /** Settings this framework has no name for: not sent. Log them as `{ setting, reason: "shape" }`, as `applySettings` reports. */
  unsupported: Array<keyof SlotInference>;
  /** Names the caller had set to another value: the release's replaced them. Empty without `caller`. */
  overridden: string[];
}

/** Sealed settings under a framework's own key names. With `caller` (the call's own options), what they replace is reported. */
export function settingsFor(settings: Readonly<SlotInference>, keys: SettingsKeys, caller?: Readonly<Record<string, unknown>>): MappedSettings {
  const values: Record<string, unknown> = {};
  const unsupported: Array<keyof SlotInference> = [];
  const overridden: string[] = [];
  for (const key of INFERENCE_KEYS) {
    const value = valueOf(key, settings);
    if (value === undefined) continue;
    const name = keys[key];
    if (name === undefined) {
      unsupported.push(key);
      continue;
    }
    values[name] = value;
    if (caller && !unset(caller[name]) && !same(caller[name], value)) overridden.push(name);
  }
  return { values, unsupported, overridden };
}

/** The sealed settings on a direct client's request: a copy, the release's values over the call site's. */
export function applySettings(kind: RequestKind, params: Record<string, unknown>, settings: Readonly<SlotInference>): AppliedInference {
  return applyInference(kind, params, settings);
}

export interface MeasureOptions {
  /** The model the row names: the release's id (`placement.model`), whatever id the framework sent it under. */
  model: string;
  step?: string;
  /** The agent's clock, so a recorded run replays with the same latencies. Defaults to `Date.now`. */
  now?: () => number;
  /** The result in a shape `normalizeUsage`, `classifyResult` and `outputTextOf` read, when the framework's is not. */
  read?: (result: unknown) => unknown;
  /** The caller sees every tool call this slot's requests make (`ModelCallRecord.toolsObserved`). */
  toolsObserved?: boolean;
  /** Runs once after the record, as an owned run's `end`. */
  onSettled?: () => void;
}

/** One model call whose clock starts now, settling once: `settle(result)` or `fail(error)`. Never throws. */
export interface Measurement extends Pending {
  readonly settled: boolean;
}

/** Start the clock for one model call that settles later, as a stream or a start/end hook pair does. */
export function beginMeasure(run: RunSession, slot: string, options: MeasureOptions): Measurement {
  const now = options.now ?? Date.now;
  const started = now();
  const base = { model: options.model, ...(options.step !== undefined ? { step: options.step } : {}), ...(options.toolsObserved !== undefined ? { toolsObserved: options.toolsObserved } : {}) };
  let settled = false;
  const finish = (record: () => void) => {
    if (settled) return;
    settled = true;
    try {
      record();
    } catch {
      // measuring never fails the customer's call
    }
    try {
      options.onSettled?.();
    } catch {
      // nor does ending the run
    }
  };
  return {
    get settled() {
      return settled;
    },
    settle(result) {
      finish(() => {
        const latencyMs = Math.max(0, now() - started);
        try {
          const shaped = options.read ? options.read(result) : result;
          const errorClass = classifyResult(shaped);
          const text = outputTextOf(shaped);
          run.recordModelCall(slot, { ...base, latencyMs, usage: normalizeUsage(shaped), ...(errorClass ? { errorClass } : {}), ...(text !== null ? { outputText: text } : {}) });
        } catch {
          // An unreadable result still counts as a call, with no usage.
          run.recordModelCall(slot, { ...base, latencyMs });
        }
      });
    },
    fail(error) {
      finish(() => run.recordModelCall(slot, { ...base, latencyMs: Math.max(0, now() - started), errorClass: classifyError(error) }));
    },
  };
}

/** Times one model call into a session: usage, finish reason, error class, output text for declared checks. Rethrows. */
export async function measureCall<T>(run: RunSession, slot: string, call: () => Promise<T> | T, options: MeasureOptions): Promise<T> {
  const measurement = beginMeasure(run, slot, options);
  let result: T;
  try {
    result = await call();
  } catch (error) {
    measurement.fail(error);
    throw error;
  }
  measurement.settle(result);
  return result;
}
