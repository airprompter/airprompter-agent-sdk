/**
 * The slot's inference settings (protocol 0.3.1, `slots[].inference`),
 * applied to a wrapped provider call. The release owns them: a version's
 * temperature, top-p, output cap, stop sequences and reasoning effort are
 * reviewed and sealed with the prompt text, so the call goes out with those
 * values whatever the call site wrote — and a call site that wrote a
 * different value is told once, in the log, never failed. The wire carries
 * integers (canonical-json.md); the providers take floats, converted here.
 */
import type { SlotInference } from "@airprompter/agent-core";
import type { StreamKind } from "./client.js";

export const temperatureOf = (inference: SlotInference): number | undefined => (inference.temperatureMilli === undefined ? undefined : inference.temperatureMilli / 1000);
export const topPOf = (inference: SlotInference): number | undefined => (inference.topPBps === undefined ? undefined : inference.topPBps / 10000);

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
    case "maxOutputTokens": return inference.maxOutputTokens;
    case "stopSequences": return inference.stopSequences ? [...inference.stopSequences] : undefined;
    case "reasoningEffort": return kind === "responses" && inference.reasoningEffort ? { effort: inference.reasoningEffort } : inference.reasoningEffort;
  }
}

export interface AppliedInference {
  params: Record<string, unknown>;
  /** Parameters the call site had set to something else: the release's value replaced them. */
  overridden: string[];
  /** Settings this request shape cannot carry (a stop sequence on Responses, a reasoning effort on Messages). */
  unsupported: (keyof SlotInference)[];
}

/** A copy of `params` with the slot's settings applied; the original object is never mutated. */
export function applyInference(kind: StreamKind, params: Record<string, unknown>, inference: SlotInference): AppliedInference {
  const out: Record<string, unknown> = { ...params };
  const overridden: string[] = [];
  const unsupported: (keyof SlotInference)[] = [];
  for (const key of Object.keys(inference) as (keyof SlotInference)[]) {
    const value = valueFor(key, inference, kind);
    if (value === undefined) continue;
    const parameter = PARAMETER[kind][key];
    if (parameter === null) { unsupported.push(key); continue; }
    if (parameter in out && JSON.stringify(out[parameter]) !== JSON.stringify(value)) overridden.push(parameter);
    out[parameter] = value;
    // OpenAI chat: the legacy cap is the same lever; a call site still writing it would otherwise send both.
    if (kind === "chat" && parameter === "max_completion_tokens" && "max_tokens" in out) { delete out.max_tokens; if (!overridden.includes("max_tokens")) overridden.push("max_tokens"); }
  }
  return { params: out, overridden, unsupported };
}
