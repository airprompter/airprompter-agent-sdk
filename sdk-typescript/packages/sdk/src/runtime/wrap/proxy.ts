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
 *   const final = deferred();
 *   void final.promise.then((result) => console.log(method.kind, result));
 *   return tapResult(original(...args), method, final); // the same object back, watched
 * });
 * ```
 */

/** Folds a stream's chunks into one result the observe path reads (usage, finish reason, output text). */
export interface StreamAccumulator {
  push(chunk: unknown): void;
  final(): unknown;
}

/** One intercepted method: its path on the client, the request shape it takes, and how its stream folds. */
export interface ClientMethod {
  path: readonly string[];
  /** The request shape, for the settings table (`inference.ts`): `chat`, `responses` or `messages`. */
  kind: "chat" | "responses" | "messages";
  accumulate: () => StreamAccumulator;
  /** A `.stream()` helper: it answers a stream object synchronously, so nothing can be awaited before it. */
  helper?: boolean;
}

export type ClientMethods = readonly ClientMethod[];

/** Called for every intercepted method instead of the original. `original` is bound to its owner. */
export type Intercept = (method: ClientMethod, original: (...args: unknown[]) => unknown, args: unknown[], name: string) => unknown;

export interface Deferred {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export function deferred(): Deferred {
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

const noop = () => {};
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
export function tapResult(out: unknown, method: ClientMethod, final: Deferred): unknown {
  if (isThenable(out)) return tapThenable(out, method, final);
  const helper = finalMethodOf(out);
  if (helper) {
    // The helper consumes on its own and exposes the accumulated result; waiting on it changes nothing the customer sees.
    try {
      helper().then((value) => final.resolve(value), (error) => final.reject(error));
    } catch (error) {
      final.reject(error);
    }
    return out;
  }
  if (isAsyncIterable(out)) return tapStream(out, method, final);
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

/** What a resolved value becomes: a stream comes back tapped, anything else settles `final`. */
export function settleValue(value: unknown, method: ClientMethod, final: Deferred): unknown {
  if (isAsyncIterable(value)) return tapStream(value, method, final);
  final.resolve(value);
  return value;
}

/** `withResponse()` resolves `{ data, response }`: the data is what is watched. */
export function settleWithResponse(result: unknown, method: ClientMethod, final: Deferred): unknown {
  const record = obj(result);
  if (!record) return settleValue(result, method, final);
  return { ...record, data: settleValue(record.data, method, final) };
}

/** An `APIPromise` keeps its own surface; only what resolves through `then` and `withResponse` is looked at. */
function tapThenable(promise: PromiseLike<unknown>, method: ClientMethod, final: Deferred): unknown {
  const onError = (error: unknown): never => {
    final.reject(error);
    throw error;
  };
  const tapped = Promise.resolve(promise).then((value) => settleValue(value, method, final), onError);
  tapped.catch(noop); // the customer's own handlers still see the rejection; this one only keeps it from going unhandled
  return new Proxy(promise as object, {
    get(target, prop) {
      if (prop === "then") return tapped.then.bind(tapped);
      if (prop === "catch") return tapped.catch.bind(tapped);
      if (prop === "finally") return tapped.finally.bind(tapped);
      const value = Reflect.get(target, prop, target);
      if (prop === "withResponse" && typeof value === "function") {
        return () => (value as () => Promise<unknown>).call(target).then((result) => settleWithResponse(result, method, final), onError);
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** The same stream object with its iteration observed: every chunk passes through; the folded result settles at the end. */
export function tapStream(stream: AsyncIterable<unknown>, method: ClientMethod, final: Deferred): unknown {
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
