/**
 * The Vercel AI SDK as an adapter: a language-model middleware that puts the
 * approved instructions, the release's model and its sealed settings on every
 * call, and measures the call into the run. One middleware covers every
 * provider the AI SDK does. The `ai` package is never imported: the
 * middleware is typed structurally, and reads every usage and finish-reason
 * shape AI SDK 4 to 7 produce.
 *
 * Placement is in `transformParams`, measurement in `wrapGenerate` and
 * `wrapStream`: `transformParams` returns before the call, so it cannot hold
 * a scope open. Inside `ap.run`, consume a `streamText` stream inside the
 * function. With no run open, each call is a one-call run that ends when the
 * response or the stream settles.
 *
 * @example
 * ```ts
 * import { generateText, wrapLanguageModel } from "ai";
 * import { openai } from "@ai-sdk/openai";
 * import { airprompterMiddleware } from "@airprompter/agent-sdk/frameworks/ai-sdk";
 *
 * const model = wrapLanguageModel({ model: openai("gpt-5"), middleware: airprompterMiddleware(ap, { slot: "support.reply" }) });
 * const { text } = await ap.run({ subject: userId }, () => generateText({ model, prompt: question })); // one run row
 * ```
 */

import { chooseModel, deferred, measureCall, settingsFor, type AgentRuntime, type Deferred, type ModelResolver, type RunSession, type SettingsKeys } from "./contract.js";

/** The AI SDK's language model, structurally: enough to call it and name it. */
export interface LanguageModelLike {
  modelId?: string;
  doGenerate?(params: unknown): PromiseLike<unknown>;
  doStream?(params: unknown): PromiseLike<unknown>;
}

/** The AI SDK's middleware contract, structurally: enough of it to type-check without the `ai` package. */
export interface AiSdkMiddleware {
  middlewareVersion?: "v1" | "v2";
  specificationVersion?: "v3" | "v4";
  transformParams(options: { type: "generate" | "stream"; params: unknown; model?: LanguageModelLike }): Promise<unknown>;
  wrapGenerate(options: { doGenerate: () => PromiseLike<unknown>; params: unknown; model: LanguageModelLike }): Promise<unknown>;
  wrapStream(options: { doStream: () => PromiseLike<unknown>; params: unknown; model: LanguageModelLike }): Promise<unknown>;
}

export interface AirPrompterMiddlewareOptions {
  /** The slot this model's calls run on. */
  slot: string;
  /** Builds the release's model when its id is not the wrapped model's. The manifest names no provider, so nothing else can. */
  modelFor?: ModelResolver<LanguageModelLike>;
  /** One version stamp: `"v1"` / `"v2"` (AI SDK 4 / 5) or `"v3"` / `"v4"` (AI SDK 6 / 7). Unset carries `v2` and `v4`, which every release accepts. */
  version?: "v1" | "v2" | "v3" | "v4";
}

const obj = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** AI SDK finish reasons (a string, or `{ unified }` from AI SDK 6+) as the OpenAI finish-reason words the run reads. */
const finishReasonOf = (reason: unknown): string => {
  const unified = typeof reason === "string" ? reason : obj(reason)?.unified;
  return unified === "length" ? "length" : unified === "content-filter" ? "content_filter" : unified === "error" ? "error" : "stop";
};

/** AI SDK 4 `promptTokens`, 5 `inputTokens` / `cachedInputTokens`, 6+ `inputTokens: { total, noCache, cacheRead }`, as the OpenAI usage shape. */
function usageOf(usage: unknown): Record<string, unknown> | undefined {
  const record = obj(usage);
  if (!record) return undefined;
  const inputObject = obj(record.inputTokens);
  const outputObject = obj(record.outputTokens);
  const input = inputObject ? (num(inputObject.total) ?? (num(inputObject.noCache) !== undefined || num(inputObject.cacheRead) !== undefined ? (num(inputObject.noCache) ?? 0) + (num(inputObject.cacheRead) ?? 0) : undefined)) : (num(record.inputTokens) ?? num(record.promptTokens));
  const output = outputObject ? num(outputObject.total) : (num(record.outputTokens) ?? num(record.completionTokens));
  if (input === undefined && output === undefined) return undefined;
  const cached = inputObject ? num(inputObject.cacheRead) : num(record.cachedInputTokens);
  return { prompt_tokens: input ?? 0, completion_tokens: output ?? 0, ...(cached !== undefined ? { prompt_tokens_details: { cached_tokens: cached } } : {}) };
}

const shape = (finish: unknown, text: string, usage: unknown) => {
  const read = usageOf(usage);
  return { choices: [{ finish_reason: finishReasonOf(finish), message: { role: "assistant", content: text } }], ...(read ? { usage: read } : {}) };
};

/** A `doGenerate` result (v5+ `content` parts, v4 `text`) in the OpenAI chat shape the run reads. */
export function generateResultShape(result: unknown): unknown {
  const record = obj(result);
  const parts = Array.isArray(record?.content) ? (record!.content as unknown[]) : [];
  const text = typeof record?.text === "string" ? record.text : parts.map((part) => (obj(part)?.type === "text" && typeof obj(part)?.text === "string" ? (obj(part)!.text as string) : "")).join("");
  return shape(record?.finishReason, text, record?.usage);
}

/** The AI SDK's call-option names. A reasoning effort is a provider option the SDK cannot name for every provider. */
const KEYS: SettingsKeys = { temperatureMilli: "temperature", topPBps: "topP", maxOutputTokens: "maxOutputTokens", stopSequences: "stopSequences" };
const V1_KEYS: SettingsKeys = { ...KEYS, maxOutputTokens: "maxTokens" };

interface Placed {
  run: RunSession;
  owned: boolean;
  caller: LanguageModelLike | undefined;
  chosen: LanguageModelLike;
  model: string;
}

export function airprompterMiddleware(ap: AgentRuntime, options: AirPrompterMiddlewareOptions): AiSdkMiddleware {
  const { slot } = options;
  // `ai` hands the object `transformParams` returned to `wrapGenerate` and `wrapStream` as `params` (a test pins it).
  const placements = new WeakMap<object, Placed>();
  const unresolved = new Set<string>();
  const stamps: Pick<AiSdkMiddleware, "middlewareVersion" | "specificationVersion"> =
    options.version === "v1" || options.version === "v2" ? { middlewareVersion: options.version } : options.version === "v3" || options.version === "v4" ? { specificationVersion: options.version } : { middlewareVersion: "v2", specificationVersion: "v4" };

  const settle = (placed: Placed, measured: Promise<unknown>) => void measured.catch(() => {}).finally(() => placed.owned && placed.run.end());

  return {
    ...stamps,
    async transformParams({ params, model }) {
      const record = obj(params);
      if (!record) return params;
      const current = ap.currentRun();
      const run = current ?? ap.openRun();
      const owned = current === undefined;
      const passthrough = () => (owned && run.end(), params);
      try {
        const placed = await run.place(slot);
        if (placed.kind === "passthrough") return passthrough();
        const chosen = chooseModel<LanguageModelLike | undefined>({ releaseModelId: placed.model, callerModel: model, callerModelId: model?.modelId, ...(options.modelFor ? { modelFor: options.modelFor as ModelResolver<LanguageModelLike | undefined> } : {}) });
        if (typeof chosen !== "object" || chosen === null) {
          if (!unresolved.has(placed.model)) (unresolved.add(placed.model), ap.log({ event: "model_unresolved", slot, model: placed.model }));
          run.decline(slot, "model_unresolved");
          return passthrough();
        }
        // AI SDK 4's call options carry `mode` and `inputFormat`; later contracts carry neither.
        const v1 = options.version === "v1" || (options.version === undefined && ("mode" in record || "inputFormat" in record));
        const { values, unsupported } = settingsFor(placed.settings, v1 ? V1_KEYS : KEYS);
        if (unsupported.length > 0) ap.log({ event: "wrap_inference_unsupported", method: "ai-sdk", tag: slot, settings: unsupported });
        const overridden = Object.keys(values).filter((key) => record[key] !== undefined && record[key] !== null && JSON.stringify(record[key]) !== JSON.stringify(values[key]));
        if (overridden.length > 0) ap.log({ event: "wrap_inference_overridden", method: "ai-sdk", tag: slot, parameters: overridden });
        const prompt = Array.isArray(record.prompt) ? [...(record.prompt as unknown[])] : [];
        const system = { role: "system", content: placed.instructions };
        if (obj(prompt[0])?.role === "system") prompt[0] = system;
        else prompt.unshift(system);
        const out = { ...record, ...values, prompt };
        placements.set(out, { run, owned, caller: model, chosen, model: placed.model });
        return out;
      } catch (error) {
        ap.log({ event: "wrap_placement_failed", method: "ai-sdk", reason: (error as Error).message });
        return passthrough();
      }
    },
    async wrapGenerate({ doGenerate, params }) {
      const placed = obj(params) ? placements.get(params as object) : undefined;
      if (!placed) return doGenerate();
      const call = () => (placed.chosen === placed.caller ? doGenerate() : placed.chosen.doGenerate!(params));
      const measured = measureCall(placed.run, slot, call, { model: placed.model, read: generateResultShape });
      settle(placed, measured);
      return measured;
    },
    async wrapStream({ doStream, params }) {
      const placed = obj(params) ? placements.get(params as object) : undefined;
      if (!placed) return doStream();
      const final = deferred();
      settle(placed, measureCall(placed.run, slot, () => final.promise, { model: placed.model }));
      let result: unknown;
      try {
        result = await (placed.chosen === placed.caller ? doStream() : placed.chosen.doStream!(params));
      } catch (error) {
        final.reject(error);
        throw error;
      }
      const record = obj(result);
      const source = record?.stream;
      if (!(source instanceof ReadableStream)) {
        final.resolve(undefined);
        return result;
      }
      return { ...record, stream: tapReadable(source, final) };
    },
  };
}

/** Every part passes through; the `finish` part's reason and usage, and the text deltas, settle the measurement. */
function tapReadable(source: ReadableStream<unknown>, final: Deferred): ReadableStream<unknown> {
  const reader = source.getReader();
  let text = "";
  let finish: unknown;
  let usage: unknown;
  let errored: unknown;
  const done = () => {
    if (errored !== undefined) final.reject(errored);
    else if (finish === "error" || obj(finish)?.unified === "error") final.reject(new Error("stream finished with an error"));
    else final.resolve(shape(finish, text, usage));
  };
  return new ReadableStream<unknown>({
    async pull(controller) {
      let step: Awaited<ReturnType<typeof reader.read>>;
      try {
        step = await reader.read();
      } catch (error) {
        final.reject(error);
        controller.error(error);
        return;
      }
      if (step.done) {
        done();
        controller.close();
        return;
      }
      const part = obj(step.value);
      const type = part?.type;
      if (type === "text-delta") text += typeof part?.delta === "string" ? part.delta : typeof part?.textDelta === "string" ? part.textDelta : "";
      else if (type === "finish") (finish = part?.finishReason), (usage = part?.usage);
      else if (type === "error") errored = part?.error ?? new Error("stream error");
      controller.enqueue(step.value);
    },
    cancel(reason) {
      done();
      return reader.cancel(reason);
    },
  });
}
