/**
 * A direct provider client (OpenAI, Anthropic) as an adapter: the proxy over
 * its methods, placement from the run, and measurement into the run. Each
 * provider adapter passes its method table and its `applyPlacement`; this
 * file holds what they share.
 *
 * | Situation                         | Placement                                        | Measure                         |
 * | --------------------------------- | ------------------------------------------------ | ------------------------------- |
 * | `slot`, run open                  | `await run.place(slot)`, applied to a copy       | `run.recordModelCall(slot, …)`  |
 * | `slot`, no run                    | `ap.openRun()`, ended when the call settles      | same                            |
 * | `slot`, a `.stream()` helper      | untouched: it cannot await                       | not measured; one log           |
 * | no `slot`, inside `ap.attribute`  | the scope's model and settings                   | `ap.observe`                    |
 * | no `slot`, no scope               | untouched                                        | not observed; one log           |
 * | placement is `passthrough`        | untouched                                        | not measured                    |
 *
 * A failure here never fails the customer's call: the request goes out as the
 * caller wrote it.
 *
 * @example
 * ```ts
 * const openai = instrumentClient(new OpenAI(), ap, { methods: OPENAI_METHODS, slot: "support.reply", apply: applyPlacement });
 * await ap.run({ subject: userId }, () => openai.chat.completions.create({ model: "gpt-5", messages })); // the approved text, model and settings
 * ```
 */

import type { ObserveOptions, ObserveTarget } from "../observe.js";
import type { AgentRuntime, ModelResolver, Placement, RunSession } from "../run/index.js";
import { chooseModel, measureCall } from "./adapt.js";
import type { Attribution } from "./attribution.js";
import { applyInference } from "./inference.js";
import { deferred, proxyClient, settleValue, settleWithResponse, tapResult, type ClientMethod, type ClientMethods, type Deferred } from "./proxy.js";

/** What a direct client needs from the agent: the run, the `ap.attribute` scope, and `ap.observe`. */
export interface InstrumentRuntime extends AgentRuntime {
  currentAttribution(): Attribution | undefined;
  observe<T>(rendered: ObserveTarget, call: () => Promise<T> | T, options?: ObserveOptions): Promise<T>;
}

export type Approved = Extract<Placement, { kind: "approved" }>;

/** The adapter's placement: instructions in the system position, the model and the settings, on a copy. */
export type ApplyPlacement = (params: Record<string, unknown>, placement: Approved, kind: ClientMethod["kind"]) => Record<string, unknown>;

export interface InstrumentClientOptions {
  methods: ClientMethods;
  slot?: string;
  /** Maps the release's model id onto the provider's (an Azure deployment, a gateway alias). Undefined declines. */
  modelFor?: ModelResolver<string | undefined>;
  apply: ApplyPlacement;
}

const noop = () => {};
const obj = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null);
const modelOf = (params: Record<string, unknown> | null): string | undefined => (typeof params?.model === "string" ? params.model : undefined);

/** `client` with its model calls placed and measured per the table above. Instrumenting twice is once. */
export function instrumentClient<T extends object>(client: T, ap: InstrumentRuntime, options: InstrumentClientOptions): T {
  const said = new Set<string>();
  const once = (event: string, method: string, extra: Record<string, unknown> = {}) => {
    const key = `${event}\u0000${method}`;
    if (said.has(key)) return;
    said.add(key);
    ap.log({ event, method, ...extra });
  };
  const { slot } = options;
  return proxyClient(client, options.methods, (method, original, args, name) => {
    if (slot !== undefined) {
      if (method.helper) {
        once("wrap_stream_helper_unmeasured", name, { slot });
        return original(...args);
      }
      return slotCall(slot, method, original, args, name);
    }
    return scopeCall(method, original, args, name);
  });

  function slotCall(slotName: string, method: ClientMethod, original: (...args: unknown[]) => unknown, args: unknown[], name: string): unknown {
    // Read now, in the caller's async context: an open run here is this call's run.
    const current = ap.currentRun();
    const run: RunSession = current ?? ap.openRun();
    const owned = current === undefined;
    const final = deferred();
    // Boxed: an async function would adopt the `APIPromise` and lose `withResponse()`.
    const issued = (async (): Promise<{ out: unknown }> => {
      const callArgs = await placed(run, slotName, method, args, name);
      if (!callArgs) {
        if (owned) final.promise.then(() => run.end(), () => run.end());
        return { out: original(...args) };
      }
      const measured = measureCall(run, slotName, () => final.promise, { model: modelOf(obj(callArgs[0])) ?? "" });
      void measured.catch(noop).finally(() => owned && run.end());
      try {
        return { out: original(...callArgs) };
      } catch (error) {
        final.reject(error);
        throw error;
      }
    })();
    return slotThenable(issued, method, final);
  }

  /** The arguments to send with the approved placement, or undefined to send the caller's untouched. Never throws. */
  async function placed(run: RunSession, slotName: string, method: ClientMethod, args: unknown[], name: string): Promise<unknown[] | undefined> {
    const params = obj(args[0]);
    if (!params) return undefined;
    try {
      const placement = await run.place(slotName);
      if (placement.kind === "passthrough") return undefined;
      const callerModelId = modelOf(params);
      const chosen = chooseModel<string | undefined>({ releaseModelId: placement.model, callerModel: callerModelId, callerModelId, ...(options.modelFor ? { modelFor: options.modelFor } : {}), ...(callerModelId === undefined ? { resolve: (id: string) => id } : {}) });
      if (typeof chosen !== "string") {
        once("model_unresolved", name, { slot: slotName, model: placement.model });
        run.decline(slotName, "model_unresolved");
        return undefined;
      }
      return [options.apply(params, { ...placement, model: chosen }, method.kind), ...args.slice(1)];
    } catch (error) {
      ap.log({ event: "wrap_placement_failed", method: name, reason: (error as Error).message });
      return undefined;
    }
  }

  function scopeCall(method: ClientMethod, original: (...args: unknown[]) => unknown, args: unknown[], name: string): unknown {
    let attribution: Attribution | undefined;
    try {
      attribution = ap.currentAttribution();
    } catch (error) {
      ap.log({ event: "wrap_attribution_failed", method: name, reason: (error as Error).message });
    }
    if (!attribution) {
      once("wrap_unattributed", name);
      return original(...args);
    }
    let params = obj(args[0]);
    if (params) {
      try {
        // The caller placed the text; the release's model and sealed settings go on the call.
        const callerModelId = modelOf(params);
        const chosen = chooseModel<string | undefined>({ releaseModelId: attribution.model, callerModel: callerModelId, callerModelId, ...(options.modelFor ? { modelFor: options.modelFor } : {}), resolve: (id: string) => id });
        if (typeof chosen === "string") {
          if (callerModelId !== undefined && callerModelId !== chosen) ap.log({ event: "wrap_model_overridden", method: name, tag: attribution.tag, releaseModel: attribution.model, model: callerModelId });
          const applied = applyInference(method.kind, { ...params, model: chosen }, attribution.inference ?? {});
          if (applied.overridden.length > 0) ap.log({ event: "wrap_inference_overridden", method: name, tag: attribution.tag, parameters: applied.overridden });
          if (applied.unsupported.length > 0) ap.log({ event: "wrap_inference_unsupported", method: name, tag: attribution.tag, settings: applied.unsupported });
          params = applied.params;
          args = [params, ...args.slice(1)];
        } else {
          once("model_unresolved", name, { tag: attribution.tag, model: attribution.model });
        }
      } catch (error) {
        ap.log({ event: "wrap_inference_failed", method: name, reason: (error as Error).message });
      }
    }
    // The clock starts now; the observation settles when the response (or the whole stream) has gone by.
    const final = deferred();
    void ap.observe(attribution, () => final.promise, { model: modelOf(params) ?? attribution.model }).catch(noop);
    let out: unknown;
    try {
      out = original(...args);
    } catch (error) {
      final.reject(error);
      throw error;
    }
    try {
      return tapResult(out, method, final);
    } catch (error) {
      ap.log({ event: "wrap_tap_failed", method: name, reason: (error as Error).message });
      final.resolve(undefined);
      return out;
    }
  }
}

/**
 * A slot-bound call awaits its placement first, so it answers a thenable chained on the awaited call that keeps the
 * `APIPromise` surface: `then`, `catch`, `finally`, `withResponse()` and `asResponse()`.
 */
function slotThenable(issued: Promise<{ out: unknown }>, method: ClientMethod, final: Deferred): PromiseLike<unknown> & Record<string, unknown> {
  const fail = (error: unknown): never => {
    final.reject(error);
    throw error;
  };
  const value = issued.then(({ out }) => Promise.resolve(out).then((resolved) => settleValue(resolved, method, final), fail), fail);
  value.catch(noop);
  const call = <R>(name: string, settle: (result: unknown) => R) =>
    () =>
      issued.then(({ out }) => {
        const fn = obj(out)?.[name];
        if (typeof fn !== "function") return Promise.resolve(out).then(settle);
        return (fn as () => Promise<unknown>).call(out).then(settle, fail);
      }, fail);
  return {
    then: value.then.bind(value),
    catch: value.catch.bind(value),
    finally: value.finally.bind(value),
    withResponse: call("withResponse", (result) => settleWithResponse(result, method, final)),
    // The raw response: its body is the caller's to read, so only the latency is measured.
    asResponse: call("asResponse", (result) => {
      final.resolve(undefined);
      return result;
    }),
  } as PromiseLike<unknown> & Record<string, unknown>;
}
