/**
 * The Anthropic client as an adapter. `instrument(client, ap, { slot })` puts
 * the approved instructions in `system`, the release's model and its sealed
 * settings on every Messages call, and measures the call into the run.
 * Without a slot the client only measures, inside `ap.attribute(rendered, fn)`
 * where the caller placed the text; outside any scope a call passes through
 * unobserved. The `@anthropic-ai/sdk` package is never imported: the shapes
 * read here are its documented response and stream-event shapes.
 *
 * With a slot, use `create({ stream: true })` to stream: `messages.stream()`
 * answers synchronously, so it cannot wait for the placement and passes
 * through unmeasured, with one log.
 *
 * @example
 * ```ts
 * import Anthropic from "@anthropic-ai/sdk";
 * import { instrument } from "@airprompter/agent-sdk/frameworks/anthropic";
 *
 * const anthropic = instrument(new Anthropic(), ap, { slot: "support.reply" });
 * const reply = await ap.run({ subject: userId }, () =>
 *   anthropic.messages.create({ model: "claude-haiku-4-5", max_tokens: 1024, messages: [{ role: "user", content: question }] }),
 * ); // `system` is the approved text; one run row
 * ```
 */

import { applySettings, instrumentClient, type ApprovedPlacement, type ClientMethods, type InstrumentRuntime, type ModelResolver, type StreamAccumulator } from "./contract.js";

const obj = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const count = (value: unknown): number | null => (typeof value === "number" ? value : null);

/** Messages events folded into one message: usage from `message_start` and `message_delta`, text deltas, the stop reason. */
function messagesAccumulator(): StreamAccumulator {
  let text = "";
  let stop: string | null = null;
  let inputTokens: number | null = null;
  let cached: number | null = null;
  let outputTokens: number | null = null;
  const readUsage = (usage: Record<string, unknown> | null) => {
    inputTokens = count(usage?.input_tokens) ?? inputTokens;
    cached = count(usage?.cache_read_input_tokens) ?? cached;
    outputTokens = count(usage?.output_tokens) ?? outputTokens;
  };
  return {
    push(chunk) {
      const record = obj(chunk);
      const type = str(record?.type) ?? "";
      if (type === "message_start") readUsage(obj(obj(record?.message)?.usage));
      else if (type === "content_block_delta") {
        const delta = obj(record?.delta);
        if (str(delta?.type) === "text_delta") text += str(delta?.text) ?? "";
      } else if (type === "message_delta") {
        readUsage(obj(record?.usage));
        const reason = str(obj(record?.delta)?.stop_reason);
        if (reason !== null) stop = reason;
      }
    },
    final: () => ({
      stop_reason: stop ?? "end_turn",
      content: [{ type: "text", text }],
      ...(inputTokens !== null || outputTokens !== null ? { usage: { input_tokens: inputTokens ?? 0, output_tokens: outputTokens ?? 0, ...(cached !== null ? { cache_read_input_tokens: cached } : {}) } } : {}),
    }),
  };
}

/** The Anthropic client's model-call methods. Anything else on the client is its own. */
const ANTHROPIC_METHODS: ClientMethods = [
  { path: ["messages", "create"], kind: "messages", accumulate: messagesAccumulator },
  { path: ["messages", "stream"], kind: "messages", accumulate: messagesAccumulator, helper: true },
  { path: ["beta", "messages", "create"], kind: "messages", accumulate: messagesAccumulator },
  { path: ["beta", "messages", "stream"], kind: "messages", accumulate: messagesAccumulator, helper: true },
];

/**
 * A copy of `params` with the approved instructions as `system`, the placement's model and its sealed settings. A
 * caller's own `system` blocks, with any `cache_control`, are replaced whole. `params` is never mutated.
 */
export function applyPlacement(params: Record<string, unknown>, placement: ApprovedPlacement): Record<string, unknown> {
  return applySettings("messages", { ...params, model: placement.model, system: placement.instructions }, placement.settings).params;
}

export interface InstrumentOptions {
  /** The slot this client's calls run on. Without it the client only measures, inside `ap.attribute`. */
  slot?: string;
  /** Maps the release's model id onto the one this client sends (a Bedrock or Vertex id, a gateway alias). Undefined declines. */
  modelFor?: ModelResolver<string | undefined>;
  /** The agent's clock for latencies, so a recorded run replays the same. Defaults to `Date.now`. */
  now?: () => number;
}

/** `client` with its model calls placed and measured. Instrumenting twice is once: the first slot stays. */
export function instrument<T extends object>(client: T, ap: InstrumentRuntime, options: InstrumentOptions = {}): T {
  return instrumentClient(client, ap, { adapter: "anthropic", methods: ANTHROPIC_METHODS, apply: (params, placement) => applyPlacement(params, placement), ...(options.slot !== undefined ? { slot: options.slot } : {}), ...(options.modelFor ? { modelFor: options.modelFor } : {}), ...(options.now ? { now: options.now } : {}) });
}
