/**
 * A provider-neutral proxy over a client's public method surface, and the
 * taps that watch what a call returns: a promise-like (`APIPromise` keeps
 * `withResponse()` and `asResponse()`), an async-iterable stream, or a
 * `.stream()` helper with a `final…()` method. Which methods are intercepted,
 * and how a stream's chunks fold into one provider-shaped result, are passed
 * in by the adapter (`frameworks/openai`, `frameworks/anthropic`). No provider
 * package is imported and no internal is patched.
 *
 * A tap never fails the customer's call: a chunk it cannot read passes
 * through, and a consumer that stops early settles with what was seen.
 *
 * @example
 * ```ts
 * const client = proxyClient(new OpenAI(), [{ path: ["chat", "completions", "create"], kind: "chat", accumulate: chatAccumulator }], (method, original, args) => {
 *   const pending = { settle: (result: unknown) => console.log(method.kind, result), fail: (error: unknown) => console.error(error) };
 *   return tapResult(original(...args), method, pending); // the same object back, watched
 * });
 * ```
 */

import type { RequestKind } from "./inference.js";

/** Folds a stream's chunks into one result the observe path reads (usage, finish reason, output text). */
export interface StreamAccumulator {
  push(chunk: unknown): void;
  final(): unknown;
}

/** A measurement whose clock started at the call: it settles once, with the folded result or the error. */
export interface Pending {
  settle(result: unknown): void;
  fail(error: unknown): void;
}

/** One intercepted method: its path on the client, the request shape it takes, and how its stream folds. */
export interface ClientMethod {
  path: readonly string[];
  /** The request shape, for the settings table (`inference.ts`). */
  kind: RequestKind;
  accumulate: () => StreamAccumulator;
  /** A `.stream()` helper: it answers a stream object synchronously, so nothing can be awaited before it. */
  helper?: boolean;
}

export type ClientMethods = readonly ClientMethod[];

/** Called for every intercepted method instead of the original. `original` is bound to its owner. */
export type Intercept = (method: ClientMethod, original: (...args: unknown[]) => unknown, args: unknown[], name: string) => unknown;

/** A `Pending` that is also a promise of its outcome, for code that awaits it (`ap.observe`). Settles once. */
export interface Deferred extends Pending {
  promise: Promise<unknown>;
}

export function deferred(): Deferred {
  let settled = false;
  const d = {} as Deferred;
  d.promise = new Promise<unknown>((resolve, reject) => {
    d.settle = (value) => {
      if (!settled) (settled = true), resolve(value);
    };
    d.fail = (error) => {
      if (!settled) (settled = true), reject(error);
    };
  });
  return d;
}

const obj = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null);
const isThenable = (value: unknown): value is PromiseLike<unknown> => typeof (obj(value) as { then?: unknown } | null)?.then === "function" || (typeof value === "function" && typeof (value as { then?: unknown }).then === "function");
const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> => obj(value) !== null && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";

const PROXIED = Symbol.for("airprompter.agent-sdk.instrumented");

/** `client` with each method in `methods` routed through `intercept`; everything else is the client's own. Proxying twice is once. */
export function proxyClient<T extends object>(client: T, methods: ClientMethods, intercept: Intercept): T {
  if ((client as { [PROXIED]?: boolean })[PROXIED]) return client;
  return proxyAt(client, [], methods, intercept) as T;
}

function proxyAt(target: object, path: readonly string[], methods: ClientMethods, intercept: Intercept): object {
  const isPrefix = (candidate: readonly string[]) => methods.some((entry) => entry.path.length > candidate.length && candidate.every((segment, i) => entry.path[i] === segment));
  const leafOf = (candidate: readonly string[]) => methods.find((entry) => entry.path.length === candidate.length && candidate.every((segment, i) => entry.path[i] === segment));
  return new Proxy(target, {
    get(t, prop) {
      if (prop === PROXIED) return true;
      const value = Reflect.get(t, prop, t);
      if (typeof prop !== "string") return value;
      const next = [...path, prop];
      const leaf = leafOf(next);
      if (leaf && typeof value === "function") {
        const original = (value as (...args: unknown[]) => unknown).bind(t);
        return (...args: unknown[]) => intercept(leaf, original, args, next.join("."));
      }
      if (typeof value === "function") return (value as (...args: unknown[]) => unknown).bind(t);
      if (typeof value === "object" && value !== null && isPrefix(next)) return proxyAt(value, next, methods, intercept);
      return value;
    },
  });
}

/** The response, a stream, or a stream helper, handed back watched: `final` settles with a provider-shaped result. */
export function tapResult(out: unknown, method: ClientMethod, final: Pending): unknown {
  if (isThenable(out)) return tapThenable(out, method, final);
  const helper = finalMethodOf(out);
  if (helper) {
    // The helper consumes on its own and exposes the accumulated result; waiting on it changes nothing the customer sees.
    try {
      helper().then((value) => final.settle(value), (error) => final.fail(error));
    } catch (error) {
      final.fail(error);
    }
    return out;
  }
  if (isAsyncIterable(out)) return tapStream(out, method, final);
  final.settle(out);
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

/** What a resolved value becomes: a stream comes back tapped, anything else settles `final`. */
export function settleValue(value: unknown, method: ClientMethod, final: Pending): unknown {
  if (isAsyncIterable(value)) return tapStream(value, method, final);
  final.settle(value);
  return value;
}

/** `withResponse()` resolves `{ data, response }`: the data is what is watched. */
export function settleWithResponse(result: unknown, method: ClientMethod, final: Pending): unknown {
  const record = obj(result);
  if (!record) return settleValue(result, method, final);
  return { ...record, data: settleValue(record.data, method, final) };
}

/**
 * An `APIPromise` keeps its own surface. Only what resolves through `then` and `withResponse` is looked at, and only
 * once the caller asks for it: parsing the body eagerly would leave `asResponse()` a response already read.
 */
function tapThenable(promise: PromiseLike<unknown>, method: ClientMethod, final: Pending): unknown {
  const onError = (error: unknown): never => {
    final.fail(error);
    throw error;
  };
  let tapped: Promise<unknown> | undefined;
  const value = () => (tapped ??= Promise.resolve(promise).then((resolved) => settleValue(resolved, method, final), onError));
  return new Proxy(promise as object, {
    get(target, prop) {
      if (prop === "then") return (...args: Parameters<Promise<unknown>["then"]>) => value().then(...args);
      if (prop === "catch") return (...args: Parameters<Promise<unknown>["catch"]>) => value().catch(...args);
      if (prop === "finally") return (...args: Parameters<Promise<unknown>["finally"]>) => value().finally(...args);
      const member = Reflect.get(target, prop, target);
      if (prop === "withResponse" && typeof member === "function") {
        return () => (member as () => Promise<unknown>).call(target).then((result) => settleWithResponse(result, method, final), onError);
      }
      if (prop === "asResponse" && typeof member === "function") {
        // The raw response: its body is the caller's to read, so only the latency is measured.
        return () => (member as () => Promise<unknown>).call(target).then((response) => (final.settle(undefined), response), onError);
      }
      return typeof member === "function" ? (member as (...args: unknown[]) => unknown).bind(target) : member;
    },
  });
}

/** The same stream object with its iteration observed: every chunk passes through; the folded result settles at the end. */
export function tapStream(stream: AsyncIterable<unknown>, method: ClientMethod, final: Pending): unknown {
  const accumulator = method.accumulate();
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
      final.settle(accumulator.final());
    } catch (error) {
      final.fail(error);
      throw error;
    } finally {
      // A consumer that stopped early: report what was seen (usually no usage, so `unavailable`).
      final.settle(accumulator.final());
    }
  }
  return new Proxy(stream as object, {
    get(target, prop) {
      if (prop === Symbol.asyncIterator) return () => iterate();
      const value = Reflect.get(target, prop, target);
      // The provider streams' own `tee()` and `toReadableStream()` iterate the real object, past this tap: both are
      // rebuilt on the tapped iteration. Each `tee()` branch is tapped; the first to finish settles.
      if (prop === "tee" && typeof value === "function") {
        return () => ((value as () => unknown[]).call(target) as AsyncIterable<unknown>[]).map((branch) => tapStream(branch, method, final));
      }
      if (prop === "toReadableStream" && typeof value === "function") return () => readableOf(iterate(), target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** What the provider streams' `toReadableStream()` produces: one JSON line per chunk, as bytes. */
function readableOf(iterator: AsyncGenerator<unknown>, stream: object): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const step = await iterator.next();
        if (step.done) controller.close();
        else controller.enqueue(encoder.encode(`${JSON.stringify(step.value)}\n`));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      // As the provider's own does: a client that went away aborts the request now, not at the next chunk.
      (stream as { controller?: { abort?: () => void } }).controller?.abort?.();
      await iterator.return(undefined);
    },
  });
}
