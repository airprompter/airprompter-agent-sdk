/**
 * The slot's inference settings (protocol 0.3.1, `slots[].inference`;
 * 0.3.2 on a workflow step), applied to a wrapped provider call. The
 * release owns them: a version's temperature, top-p, output cap, stop
 * sequences and reasoning effort are reviewed and sealed with the prompt
 * text, so the call goes out with those values whatever the call site wrote
 * — and a call site that wrote a different value is told once, in the log,
 * never failed. The wire carries integers (canonical-json.md); the providers
 * take floats, converted here.
 *
 * Settings sealed for one model are refused by another (Anthropic Messages
 * takes one of `temperature` / `top_p`, and none beside `thinking`; an
 * OpenAI reasoning model takes neither), so they go only on a call to the
 * release's model: a call site that names another model keeps its own
 * parameters and is told why.
 */
import type { SlotInference } from "@airprompter/agent-core";
import type { StreamKind } from "./client.js";

/** The settings in one order, so every log line and every SDK names them alike. */
export const INFERENCE_KEYS = ["temperatureMilli", "topPBps", "maxOutputTokens", "stopSequences", "reasoningEffort"] as const satisfies readonly (keyof SlotInference)[];

/** A JSON `null` in the block is unset (the schema forbids it; a lenient reader treats it as absent). */
const unset = (value: unknown): value is null | undefined => value === undefined || value === null;

export const temperatureOf = (inference: SlotInference): number | undefined => (unset(inference.temperatureMilli) ? undefined : inference.temperatureMilli / 1000);
export const topPOf = (inference: SlotInference): number | undefined => (unset(inference.topPBps) ? undefined : inference.topPBps / 10000);

/** The provider parameter each setting lands on, per request shape; `null` when the shape has no such parameter. */
const PARAMETER: Record<StreamKind, Record<keyof SlotInference, string | null>> = {
  chat: { temperatureMilli: "temperature", topPBps: "top_p", maxOutputTokens: "max_completion_tokens", stopSequences: "stop", reasoningEffort: "reasoning_effort" },
  responses: { temperatureMilli: "temperature", topPBps: "top_p", maxOutputTokens: "max_output_tokens", stopSequences: null, reasoningEffort: "reasoning" },
  messages: { temperatureMilli: "temperature", topPBps: "top_p", maxOutputTokens: "max_tokens", stopSequences: "stop_sequences", reasoningEffort: null },
};

function valueFor(key: keyof SlotInference, inference: SlotInference, kind: StreamKind): unknown {
  switch (key) {
    case "temperatureMilli": return temperatureOf(inference);
    case "topPBps": return topPOf(inference);
    case "maxOutputTokens": return unset(inference.maxOutputTokens) ? undefined : inference.maxOutputTokens;
    case "stopSequences": return unset(inference.stopSequences) ? undefined : [...inference.stopSequences];
    case "reasoningEffort": return unset(inference.reasoningEffort) ? undefined : inference.reasoningEffort;
  }
}

/** Why a setting was not applied. */
export type InferenceUnsupportedReason =
  /** The request shape has no such parameter (a stop sequence on Responses, a reasoning effort on Messages). */
  | "shape"
  /** Anthropic Messages takes one of `temperature` / `top_p`; the slot carries both, and temperature goes. */
  | "one_sampling_parameter"
  /** Anthropic Messages takes no sampling parameter beside a `thinking` block the call site set. */
  | "thinking";

export interface AppliedInference {
  params: Record<string, unknown>;
  /** Parameters the call site had set to something else: the release's value replaced them. */
  overridden: string[];
  /** Settings that were not applied, each with why. */
  unsupported: Array<{ setting: keyof SlotInference; reason: InferenceUnsupportedReason }>;
  /** Set when nothing was applied because the call names a model other than the release's. */
  skipped?: "model_mismatch";
}

export interface ApplyInferenceOptions {
  /** The release's model for the slot; when the call names another model the settings stay off it. */
  model?: string;
}

const same = (left: unknown, right: unknown): boolean => {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
};

/** A copy of `params` with the slot's settings applied; the original object is never mutated. */
export function applyInference(kind: StreamKind, params: Record<string, unknown>, inference: SlotInference, options: ApplyInferenceOptions = {}): AppliedInference {
  const out: Record<string, unknown> = { ...params };
  if (options.model !== undefined && typeof params.model === "string" && params.model !== options.model) {
    return { params: out, overridden: [], unsupported: [], skipped: "model_mismatch" };
  }
  const overridden: string[] = [];
  const unsupported: AppliedInference["unsupported"] = [];
  const thinking = kind === "messages" && !unset(out.thinking);
  const bothSampling = kind === "messages" && !unset(inference.temperatureMilli) && !unset(inference.topPBps);
  for (const key of INFERENCE_KEYS) {
    const value = valueFor(key, inference, kind);
    if (value === undefined) continue;
    const parameter = PARAMETER[kind][key];
    if (parameter === null) { unsupported.push({ setting: key, reason: "shape" }); continue; }
    if (thinking && (key === "temperatureMilli" || key === "topPBps")) { unsupported.push({ setting: key, reason: "thinking" }); continue; }
    if (bothSampling && key === "topPBps") { unsupported.push({ setting: key, reason: "one_sampling_parameter" }); continue; }
    if (key === "reasoningEffort" && kind === "responses") {
      // The Responses `reasoning` object has other members (`summary`): the effort is set, the rest kept.
      const existing = typeof out.reasoning === "object" && out.reasoning !== null ? (out.reasoning as Record<string, unknown>) : {};
      if (!unset(existing.effort) && existing.effort !== value) overridden.push("reasoning.effort");
      out.reasoning = { ...existing, effort: value };
      continue;
    }
    if (!unset(out[parameter]) && !same(out[parameter], value)) overridden.push(parameter);
    out[parameter] = value;
    // OpenAI chat: the legacy cap is the same lever; a call site still writing it would otherwise send both.
    if (kind === "chat" && parameter === "max_completion_tokens" && !unset(out.max_tokens)) { delete out.max_tokens; if (!overridden.includes("max_tokens")) overridden.push("max_tokens"); }
  }
  return { params: out, overridden, unsupported };
}
