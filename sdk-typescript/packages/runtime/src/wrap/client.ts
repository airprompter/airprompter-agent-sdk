/**
 * `ap.wrap(client)` (T33, D65): the OpenAI and Anthropic clients observed
 * without a change at the call site. The wrapper is a proxy over the
 * client's *public* method surface — `chat.completions.create`,
 * `responses.create`, `messages.create` and the `.stream()` helpers — that
 * attributes each call to a rendered prompt (`attribution.ts`), times it,
 * reads `usage` and the finish reason off the response (or off the stream
 * as it goes by), runs the slot's declared output checks on the text, and
 * files one content-free observation. No provider code is vendored, no
 * internal is patched, no peer dependency is imported: the shapes read
 * here are the documented response and stream-event shapes.
 *
 * A wrapper failure never fails the customer's call: attribution and
 * tapping are guarded, an unattributed call passes straight through, and
 * a stream left unfinished reports what was seen.
 */

import type { ObserveOptions, ObserveTarget } from "../observe.js";
import type { Attribution } from "./attribution.js";
import { applyInference } from "./inference.js";

export interface WrapHooks {
  /** The rendered prompt a call belongs to, from its parameters; undefined passes the call through unobserved. */
  attribute(params: unknown): Attribution | undefined;
  /** `ap.observe`: times `call`, records, returns its result. */
  observe<T>(target: ObserveTarget, call: () => Promise<T>, options?: ObserveOptions): Promise<T>;
  log(event: Record<string, unknown>): void;
}

/** Which accumulator reads a stream: OpenAI chat chunks, OpenAI Responses events, Anthropic Messages events. */
export type StreamKind = "chat" | "responses" | "messages";

/** The public methods a wrapped client observes; anything else is forwarded untouched. */
export const WRAPPED_METHODS: ReadonlyArray<{ path: readonly string[]; kind: StreamKind }> = [
  { path: ["chat", "completions", "create"], kind: "chat" },
  { path: ["chat", "completions", "stream"], kind: "chat" },
  { path: ["chat", "completions", "parse"], kind: "chat" },
  { path: ["responses", "create"], kind: "responses" },
  { path: ["responses", "stream"], kind: "responses" },
  { path: ["responses", "parse"], kind: "responses" },
  { path: ["messages", "create"], kind: "messages" },
  { path: ["messages", "stream"], kind: "messages" },
  { path: ["beta", "messages", "create"], kind: "messages" },
  { path: ["beta", "messages", "stream"], kind: "messages" },
  { path: ["beta", "chat", "completions", "parse"], kind: "chat" },
];

const isPrefix = (candidate: readonly string[]) => WRAPPED_METHODS.some((entry) => entry.path.length > candidate.length && candidate.every((segment, i) => entry.path[i] === segment));
const leafOf = (candidate: readonly string[]) => WRAPPED_METHODS.find((entry) => entry.path.length === candidate.length && candidate.every((segment, i) => entry.path[i] === segment));
const noop = () => {};

interface Deferred {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

function deferred(): Deferred {
  const d = { settled: false } as Deferred;
  d.promise = new Promise<unknown>((resolve, reject) => {
    d.resolve = (value) => {
      if (d.settled) return;
      d.settled = true;
      resolve(value);
    };
    d.reject = (error) => {
      if (d.settled) return;
      d.settled = true;
      reject(error);
    };
  });
  return d;
}

const obj = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null);
const isThenable = (value: unknown): value is PromiseLike<unknown> => typeof (obj(value) as { then?: unknown } | null)?.then === "function" || (typeof value === "function" && typeof (value as { then?: unknown }).then === "function");
const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> => obj(value) !== null && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";

const WRAPPED = Symbol.for("airprompter.agent-sdk.wrapped");

/** Wrap `client` so its observed methods report to `hooks`; everything else is the client's own. Wrapping twice is once. */
export function wrapClient<T extends object>(client: T, hooks: WrapHooks): T {
  if ((client as { [WRAPPED]?: boolean })[WRAPPED]) return client;
  return proxyAt(client, [], hooks) as T;
}

function proxyAt(target: object, path: readonly string[], hooks: WrapHooks): object {
  return new Proxy(target, {
    get(t, prop, _receiver) {
      if (prop === WRAPPED) return true;
      const value = Reflect.get(t, prop, t);
      if (typeof prop !== "string") return value;
      const next = [...path, prop];
      const leaf = leafOf(next);
      if (leaf && typeof value === "function") return wrapMethod((value as (...args: unknown[]) => unknown).bind(t), leaf.kind, next.join("."), hooks);
      if (typeof value === "function") return (value as (...args: unknown[]) => unknown).bind(t);
      if (typeof value === "object" && value !== null && isPrefix(next)) return proxyAt(value, next, hooks);
      return value;
    },
  });
}

function wrapMethod(original: (...args: unknown[]) => unknown, kind: StreamKind, method: string, hooks: WrapHooks) {
  return (...args: unknown[]): unknown => {
    let attribution: Attribution | undefined;
    try {
      attribution = hooks.attribute(args[0]);
    } catch (error) {
      hooks.log({ event: "wrap_attribution_failed", method, reason: (error as Error).message });
    }
    if (!attribution) {
      hooks.log({ event: "wrap_unattributed", method });
      return original(...args);
    }
    let params = obj(args[0]);
    // 0.3.1: the release owns the inference settings — applied here, the call site told once when it disagreed.
    if (attribution.inference && params) {
      try {
        const applied = applyInference(kind, params, attribution.inference);
        if (applied.overridden.length > 0) hooks.log({ event: "wrap_inference_overridden", method, tag: attribution.tag, parameters: applied.overridden });
        if (applied.unsupported.length > 0) hooks.log({ event: "wrap_inference_unsupported", method, tag: attribution.tag, settings: applied.unsupported });
        args = [applied.params, ...args.slice(1)];
        params = applied.params;
      } catch (error) {
        hooks.log({ event: "wrap_inference_failed", method, reason: (error as Error).message });
      }
    }
    const model = typeof params?.model === "string" ? params.model : attribution.model;
    // The clock starts now; the observation settles when the response (or the whole stream) has gone by.
    const final = deferred();
    void hooks.observe(attribution, () => final.promise, { model }).catch(noop);
    let out: unknown;
    try {
      out = original(...args);
    } catch (error) {
      final.reject(error);
      throw error;
    }
    try {
      return tap(out, kind, final);
    } catch (error) {
      hooks.log({ event: "wrap_tap_failed", method, reason: (error as Error).message });
      final.resolve(undefined);
      return out;
    }
  };
}

/** The response, a stream, or a stream helper: settle `final` with a provider-shaped result when it is known. */
function tap(out: unknown, kind: StreamKind, final: Deferred): unknown {
  if (isThenable(out)) return tapThenable(out, kind, final);
  const helper = finalMethodOf(out);
  if (helper) {
    // `messages.stream()` / `chat.completions.stream()` / `responses.stream()`: the helper consumes on its own and
    // exposes the accumulated result; waiting on it consumes nothing and changes nothing the customer sees.
    try {
      helper().then((value) => final.resolve(value), (error) => final.reject(error));
    } catch (error) {
      final.reject(error);
    }
    return out;
  }
  if (isAsyncIterable(out)) return tapStream(out, kind, final);
  final.resolve(out);
  return out;
}

function finalMethodOf(value: unknown): (() => Promise<unknown>) | null {
  const record = obj(value);
  if (!record) return null;
  // OpenAI's ChatCompletionStream carries a `finalMessage()` too (the message alone): the completion comes first.
  for (const name of ["finalChatCompletion", "finalResponse", "finalMessage"]) {
    const fn = record[name];
    if (typeof fn === "function") return () => (fn as () => Promise<unknown>).call(value);
  }
  return null;
}

/**
 * An `APIPromise` keeps its own surface (`withResponse()`, `asResponse()`, …); only what resolves through `then` /
 * `withResponse` is looked at, and a resolved stream is handed back tapped.
 */
function tapThenable(promise: PromiseLike<unknown>, kind: StreamKind, final: Deferred): unknown {
  const onValue = (value: unknown): unknown => {
    if (isAsyncIterable(value)) return tapStream(value, kind, final);
    final.resolve(value);
    return value;
  };
  const onError = (error: unknown): never => {
    final.reject(error);
    throw error;
  };
  const tapped = Promise.resolve(promise).then(onValue, onError);
  tapped.catch(noop); // the customer's own handlers still see the rejection; this one only keeps it from going unhandled
  return new Proxy(promise as object, {
    get(target, prop) {
      if (prop === "then") return tapped.then.bind(tapped);
      if (prop === "catch") return tapped.catch.bind(tapped);
      if (prop === "finally") return tapped.finally.bind(tapped);
      const value = Reflect.get(target, prop, target);
      if (prop === "withResponse" && typeof value === "function") {
        return () =>
          (value as () => Promise<Record<string, unknown>>).call(target).then(
            (result) => ({ ...result, data: onValue(result.data) }),
            onError,
          );
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** The same stream object with its iteration observed: every chunk passes through; the final shape settles at the end. */
function tapStream(stream: AsyncIterable<unknown>, kind: StreamKind, final: Deferred): unknown {
  const accumulator = accumulatorFor(kind);
  async function* iterate(): AsyncGenerator<unknown> {
    try {
      for await (const chunk of stream) {
        try {
          accumulator.push(chunk);
        } catch {
          // an unexpected chunk shape never interrupts the customer's stream
        }
        yield chunk;
      }
      final.resolve(accumulator.final());
    } catch (error) {
      final.reject(error);
      throw error;
    } finally {
      // A consumer that stopped early: report what was seen (usually no usage, so `unavailable`).
      final.resolve(accumulator.final());
    }
  }
  return new Proxy(stream as object, {
    get(target, prop) {
      if (prop === Symbol.asyncIterator) return () => iterate();
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

interface Accumulator {
  push(chunk: unknown): void;
  /** A provider-shaped result the observe path already understands (usage, finish reason, output text). */
  final(): unknown;
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

export function accumulatorFor(kind: StreamKind): Accumulator {
  if (kind === "chat") {
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
  if (kind === "responses") {
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
  let text = "";
  let stop: string | null = null;
  let inputTokens: number | null = null;
  let cached: number | null = null;
  let outputTokens: number | null = null;
  return {
    push(chunk) {
      const record = obj(chunk);
      const type = str(record?.type) ?? "";
      if (type === "message_start") {
        const usage = obj(obj(record?.message)?.usage);
        if (typeof usage?.input_tokens === "number") inputTokens = usage.input_tokens;
        if (typeof usage?.cache_read_input_tokens === "number") cached = usage.cache_read_input_tokens;
        if (typeof usage?.output_tokens === "number") outputTokens = usage.output_tokens;
      } else if (type === "content_block_delta") {
        const delta = obj(record?.delta);
        if (str(delta?.type) === "text_delta") text += str(delta?.text) ?? "";
      } else if (type === "message_delta") {
        const usage = obj(record?.usage);
        if (typeof usage?.output_tokens === "number") outputTokens = usage.output_tokens;
        if (typeof usage?.input_tokens === "number") inputTokens = usage.input_tokens;
        if (typeof usage?.cache_read_input_tokens === "number") cached = usage.cache_read_input_tokens;
        const delta = obj(record?.delta);
        if (str(delta?.stop_reason) !== null) stop = str(delta?.stop_reason);
      }
    },
    final: () => ({
      stop_reason: stop ?? "end_turn",
      content: [{ type: "text", text }],
      ...(inputTokens !== null || outputTokens !== null ? { usage: { input_tokens: inputTokens ?? 0, output_tokens: outputTokens ?? 0, ...(cached !== null ? { cache_read_input_tokens: cached } : {}) } } : {}),
    }),
  };
}
