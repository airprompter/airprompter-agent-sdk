/**
 * A Vercel AI SDK language-model middleware (T33, D65):
 *
 *   const model = wrapLanguageModel({ model: openai("gpt-5"), middleware: ap.aiSdkMiddleware() });
 *
 * One adapter covers every provider the AI SDK does (OpenAI, Anthropic,
 * xAI, Bedrock, …): `wrapGenerate` times `doGenerate` and reads its usage,
 * finish reason and text; `wrapStream` passes every part through and reads
 * the `finish` part. Attribution is the same as `ap.wrap()`: an enclosing
 * `ap.attribute()` scope, else a `prompt` message whose text is a recent
 * render. The middleware is structurally typed against the AI SDK's
 * middleware contract and imports nothing from `ai`: by default it carries
 * both version stamps (`middlewareVersion: "v2"` for AI SDK 5 and
 * `specificationVersion: "v4"` for AI SDK 6+), and reads every usage /
 * finish-reason shape those versions produce (flat `inputTokens` numbers,
 * or `{ total, noCache, cacheRead }` objects; a finish reason string, or
 * `{ unified }`). Pass `{ version }` to stamp exactly one.
 */

import type { ObserveOptions, ObserveTarget } from "../telemetry/observe.js";
import type { Attribution } from "./attribution.js";

export interface AiSdkMiddlewareHooks {
  attribute(params: unknown): Attribution | undefined;
  observe<T>(target: ObserveTarget, call: () => Promise<T>, options?: ObserveOptions): Promise<T>;
  log(event: Record<string, unknown>): void;
}

export interface AiSdkMiddlewareOptions {
  /**
   * Which version stamp to carry: `"v1"` / `"v2"` set `middlewareVersion` (AI SDK 4 / 5); `"v3"` / `"v4"` set
   * `specificationVersion` (AI SDK 6 / 7). Unset carries both `middlewareVersion: "v2"` and `specificationVersion: "v4"`,
   * which every release accepts. The shapes read are the same either way.
   */
  version?: "v1" | "v2" | "v3" | "v4";
}

/** The AI SDK's middleware contract, structurally: enough of it to type-check without the `ai` package. */
export interface AiSdkMiddleware {
  middlewareVersion?: "v1" | "v2";
  specificationVersion?: "v3" | "v4";
  wrapGenerate(options: { doGenerate: () => PromiseLike<unknown>; params: unknown; model: { modelId?: string } }): Promise<unknown>;
  wrapStream(options: { doStream: () => PromiseLike<unknown>; params: unknown; model: { modelId?: string } }): Promise<unknown>;
}

const noop = () => {};
const obj = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null);

interface Deferred {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}
function deferred(): Deferred {
  let settled = false;
  const d = {} as Deferred;
  d.promise = new Promise<unknown>((resolve, reject) => {
    d.resolve = (value) => {
      if (!settled) (settled = true), resolve(value);
    };
    d.reject = (error) => {
      if (!settled) (settled = true), reject(error);
    };
  });
  return d;
}

/** AI SDK finish reasons (a string, or `{ unified }` from AI SDK 6+) into the OpenAI finish-reason words `classifyResult` reads. */
const finishReasonOf = (reason: unknown): string => {
  const unified = typeof reason === "string" ? reason : obj(reason)?.unified;
  return unified === "length" ? "length" : unified === "content-filter" ? "content_filter" : unified === "error" ? "error" : "stop";
};

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/**
 * AI SDK usage into the OpenAI usage shape (cached tokens inside the input count): AI SDK 4 `promptTokens` /
 * `completionTokens`; AI SDK 5 `inputTokens` / `outputTokens` / `cachedInputTokens`; AI SDK 6+ `inputTokens: { total,
 * noCache, cacheRead }` / `outputTokens: { total }`.
 */
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

/** A `doGenerate` result (v5 `content` parts / v4 `text`) as the OpenAI chat shape the observe path reads. */
export function generateResultShape(result: unknown): unknown {
  const record = obj(result);
  const parts = Array.isArray(record?.content) ? (record!.content as unknown[]) : [];
  const text = typeof record?.text === "string" ? record.text : parts.map((part) => (obj(part)?.type === "text" && typeof obj(part)?.text === "string" ? (obj(part)!.text as string) : "")).join("");
  const usage = usageOf(record?.usage);
  return { choices: [{ finish_reason: finishReasonOf(record?.finishReason), message: { role: "assistant", content: text } }], ...(usage ? { usage } : {}) };
}

export function aiSdkMiddleware(hooks: AiSdkMiddlewareHooks, options: AiSdkMiddlewareOptions = {}): AiSdkMiddleware {
  const begin = (params: unknown, model: { modelId?: string }): Deferred | null => {
    let attribution: Attribution | undefined;
    try {
      attribution = hooks.attribute(params);
    } catch (error) {
      hooks.log({ event: "wrap_attribution_failed", method: "ai-sdk", reason: (error as Error).message });
    }
    if (!attribution) {
      hooks.log({ event: "wrap_unattributed", method: "ai-sdk" });
      return null;
    }
    const final = deferred();
    void hooks.observe(attribution, () => final.promise, { model: typeof model.modelId === "string" ? model.modelId : attribution.model }).catch(noop);
    return final;
  };

  const stamps: Pick<AiSdkMiddleware, "middlewareVersion" | "specificationVersion"> =
    options.version === "v1" || options.version === "v2" ? { middlewareVersion: options.version } : options.version === "v3" || options.version === "v4" ? { specificationVersion: options.version } : { middlewareVersion: "v2", specificationVersion: "v4" };
  return {
    ...stamps,
    async wrapGenerate({ doGenerate, params, model }) {
      const final = begin(params, model);
      if (!final) return doGenerate();
      try {
        const result = await doGenerate();
        try {
          final.resolve(generateResultShape(result));
        } catch {
          final.resolve(undefined);
        }
        return result;
      } catch (error) {
        final.reject(error);
        throw error;
      }
    },
    async wrapStream({ doStream, params, model }) {
      const final = begin(params, model);
      if (!final) return doStream();
      let result: unknown;
      try {
        result = await doStream();
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

/** Every part passes through; the `finish` part's reason and usage (and the text deltas) settle the observation. */
function tapReadable(source: ReadableStream<unknown>, final: Deferred): ReadableStream<unknown> {
  const reader = source.getReader();
  let text = "";
  let finish: unknown;
  let usage: unknown;
  let errored: unknown;
  const shape = () => ({ choices: [{ finish_reason: finishReasonOf(finish), message: { role: "assistant", content: text } }], ...(usageOf(usage) ? { usage: usageOf(usage) } : {}) });
  const settle = () => {
    if (errored !== undefined) final.reject(errored);
    else if (finish === "error") final.reject(new Error("stream finished with an error"));
    else final.resolve(shape());
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
        settle();
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
      settle();
      return reader.cancel(reason);
    },
  });
}
