/**
 * The OpenAI client as an adapter. `instrument(client, ap, { slot })` puts the
 * approved instructions, the release's model and its sealed settings on every
 * Chat Completions and Responses call, and measures the call into the run.
 * Without a slot the client only measures, inside `ap.attribute(rendered, fn)`
 * where the caller placed the text; outside any scope a call passes through
 * unobserved. The `openai` package is never imported: the shapes read here are
 * its documented request, response and stream-event shapes.
 *
 * With a slot, use `create({ stream: true })` to stream: a `.stream()` helper
 * answers synchronously, so it cannot wait for the placement and passes
 * through unmeasured, with one log.
 *
 * @example
 * ```ts
 * import OpenAI from "openai";
 * import { instrument } from "@airprompter/agent-sdk/frameworks/openai";
 *
 * const openai = instrument(new OpenAI(), ap, { slot: "support.reply" });
 * const reply = await ap.run({ subject: userId }, () =>
 *   openai.chat.completions.create({ model: "gpt-5", messages: [{ role: "user", content: question }] }),
 * ); // the system message is the approved text; one run row
 * ```
 */

import { applySettings, instrumentClient, type ClientMethods, type InstrumentRuntime, type ModelResolver, type Placement, type StreamAccumulator } from "./contract.js";

type Approved = Extract<Placement, { kind: "approved" }>;

const obj = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Chat Completions chunks folded into one completion: text deltas, the finish reason, and the last chunk's usage. */
function chatAccumulator(): StreamAccumulator {
  let text = "";
  let finish: string | null = null;
  let usage: unknown;
  return {
    push(chunk) {
      const record = obj(chunk);
      const choice = obj(Array.isArray(record?.choices) ? record!.choices[0] : null);
      const delta = str(obj(choice?.delta)?.content);
      if (delta !== null) text += delta;
      if (str(choice?.finish_reason) !== null) finish = str(choice?.finish_reason);
      if (obj(record?.usage)) usage = record!.usage;
    },
    final: () => ({ choices: [{ finish_reason: finish ?? "stop", message: { role: "assistant", content: text } }], ...(usage ? { usage } : {}) }),
  };
}

/** Responses events folded into the final response: the terminal event's response, or the text deltas seen. */
function responsesAccumulator(): StreamAccumulator {
  let text = "";
  let response: Record<string, unknown> | null = null;
  return {
    push(chunk) {
      const record = obj(chunk);
      const type = str(record?.type) ?? "";
      if (type === "response.output_text.delta") text += str(record?.delta) ?? "";
      if ((type === "response.completed" || type === "response.incomplete" || type === "response.failed") && obj(record?.response)) response = obj(record?.response);
    },
    final: () => (response ? { ...response, ...(typeof response.output_text === "string" ? {} : { output_text: text }) } : { output_text: text }),
  };
}

/** The OpenAI client's model-call methods. Anything else on the client is its own. */
export const OPENAI_METHODS: ClientMethods = [
  { path: ["chat", "completions", "create"], kind: "chat", accumulate: chatAccumulator },
  { path: ["chat", "completions", "parse"], kind: "chat", accumulate: chatAccumulator },
  { path: ["chat", "completions", "stream"], kind: "chat", accumulate: chatAccumulator, helper: true },
  { path: ["beta", "chat", "completions", "parse"], kind: "chat", accumulate: chatAccumulator },
  { path: ["responses", "create"], kind: "responses", accumulate: responsesAccumulator },
  { path: ["responses", "parse"], kind: "responses", accumulate: responsesAccumulator },
  { path: ["responses", "stream"], kind: "responses", accumulate: responsesAccumulator, helper: true },
];

const SYSTEM_ROLES = new Set(["system", "developer"]);

/**
 * A copy of `params` with the approved instructions in the system position, the placement's model and its sealed
 * settings. Chat Completions replaces a leading `system` or `developer` message or prepends one; Responses sets
 * `instructions`. `params` is never mutated.
 */
export function applyPlacement(params: Record<string, unknown>, placement: Approved, kind: "chat" | "responses" | "messages" = "chat"): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params, model: placement.model };
  if (kind === "responses") {
    out.instructions = placement.instructions;
    return applySettings("responses", out, placement.settings).params;
  }
  const messages = Array.isArray(params.messages) ? [...(params.messages as unknown[])] : [];
  const first = obj(messages[0]);
  const role = str(first?.role) ?? "";
  // A leading developer message keeps its role: reasoning models read it as the system position.
  const system = { role: SYSTEM_ROLES.has(role) ? role : "system", content: placement.instructions };
  if (SYSTEM_ROLES.has(role)) messages[0] = system;
  else messages.unshift(system);
  out.messages = messages;
  return applySettings("chat", out, placement.settings).params;
}

export interface InstrumentOptions {
  /** The slot this client's calls run on. Without it the client only measures, inside `ap.attribute`. */
  slot?: string;
  /** Maps the release's model id onto the one this client sends (an Azure deployment, a gateway alias). Undefined declines. */
  modelFor?: ModelResolver<string | undefined>;
}

/** `client` with its model calls placed and measured. Instrumenting twice is once. */
export function instrument<T extends object>(client: T, ap: InstrumentRuntime, options: InstrumentOptions = {}): T {
  return instrumentClient(client, ap, { methods: OPENAI_METHODS, apply: applyPlacement, ...(options.slot !== undefined ? { slot: options.slot } : {}), ...(options.modelFor ? { modelFor: options.modelFor } : {}) });
}
