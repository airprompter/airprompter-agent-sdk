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
 * | no `slot`, inside `ap.attribute`  | the scope's settings, on the release's model     | `ap.observe` (not on another)   |
 * | no `slot`, no scope               | untouched                                        | not observed; one log           |
 * | placement is `passthrough`        | untouched                                        | not measured                    |
 *
 * The release's model wins or nothing is applied: a call naming another
 * model with no `modelFor` declines the slot (slot mode) or goes out as
 * written and unobserved (scope mode), with one `model_unresolved` log. A
 * slot-bound call is measured when the caller awaits it: one nobody awaits
 * settles with the run's idle sweep. A failure
 * here never fails the customer's call: the request goes out as the caller
 * wrote it.
 *
 * @example
 * ```ts
 * const openai = instrumentClient(new OpenAI(), ap, { adapter: "openai", methods: OPENAI_METHODS, slot: "support.reply", apply: applyPlacement });
 * await ap.run({ subject: userId }, () => openai.chat.completions.create({ model: "gpt-5", messages })); // the approved text, model and settings
 * ```
 */

import type { ObserveOptions, ObserveTarget } from "../observe.js";
import type { AgentRuntime, ModelResolver, Placement, RunSession } from "../run/index.js";
import { acquireRun, beginMeasure, chooseModel } from "./adapt.js";
import type { Attribution } from "./attribution.js";
import { ADAPTER_EVENTS } from "./events.js";
import { applyInference } from "./inference.js";
import { deferred, proxyClient, settleValue, settleWithResponse, tapResult, type ClientMethod, type ClientMethods, type Pending } from "./proxy.js";

/** What a direct client needs from the agent: the run, the `ap.attribute` scope, and `ap.observe`. */
export interface InstrumentRuntime extends AgentRuntime {
  currentAttribution(): Attribution | undefined;
  observe<T>(rendered: ObserveTarget, call: () => Promise<T> | T, options?: ObserveOptions): Promise<T>;
}

export type ApprovedPlacement = Extract<Placement, { kind: "approved" }>;

/** The adapter's placement: instructions in the system position, the model and the settings, on a copy. */
export type ApplyPlacement = (params: Record<string, unknown>, placement: ApprovedPlacement, kind: ClientMethod["kind"]) => Record<string, unknown>;

export interface InstrumentClientOptions {
  /** The adapter's name, as its subpath has it (`openai`), on every log event. */
  adapter: string;
  methods: ClientMethods;
  slot?: string;
  /** Maps the release's model id onto the one the client sends (an Azure deployment, a gateway alias). Undefined declines. */
  modelFor?: ModelResolver<string | undefined>;
  apply: ApplyPlacement;
  /** The agent's clock for latencies. Defaults to `Date.now`. */
  now?: () => number;
}

const noop = () => {};
const obj = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null);
const modelOf = (params: Record<string, unknown> | null): string | undefined => (typeof params?.model === "string" ? params.model : undefined);

/** `client` with its model calls placed and measured per the table above. Instrumenting twice is once: the first slot stays. */
export function instrumentClient<T extends object>(client: T, ap: InstrumentRuntime, options: InstrumentClientOptions): T {
  const said = new Set<string>();
  const { slot, adapter } = options;
  // A customer logger that throws never reaches the call.
  const log = (event: string, fields: Record<string, unknown>) => {
    try {
      ap.log({ event, adapter, ...fields });
    } catch {
      // nothing to do: the log is the customer's
    }
  };
  const once = (event: string, fields: Record<string, unknown>) => {
    const key = JSON.stringify([event, fields.method, fields.model]);
    if (said.has(key)) return;
    said.add(key);
    log(event, fields);
  };
  /** The release's model for this call, or undefined when it runs elsewhere and nothing maps it. */
  const modelFrom = (releaseModelId: string, params: Record<string, unknown>): string | undefined => {
    const callerModelId = modelOf(params);
    const chosen = chooseModel<string | undefined>({ releaseModelId, callerModel: callerModelId, callerModelId, ...(options.modelFor ? { modelFor: options.modelFor } : {}), ...(callerModelId === undefined ? { resolve: (id: string) => id } : {}) });
    return typeof chosen === "string" ? chosen : undefined;
  };

  return proxyClient(client, options.methods, (method, original, args, name) => {
    if (slot === undefined) return scopeCall(method, original, args, name);
    if (method.helper) {
      once(ADAPTER_EVENTS.streamHelperUnmeasured, { slot, method: name });
      return original(...args);
    }
    let acquired: { run: RunSession; owned: boolean };
    try {
      acquired = acquireRun(ap);
    } catch (error) {
      log(ADAPTER_EVENTS.placementFailed, { slot, method: name, reason: (error as Error).message });
      return original(...args);
    }
    return slotCall(slot, acquired.run, acquired.owned, method, original, args, name);
  });

  function slotCall(slotName: string, run: RunSession, owned: boolean, method: ClientMethod, original: (...args: unknown[]) => unknown, args: unknown[], name: string): unknown {
    const end = () => owned && run.end();
    // Boxed: an async function would adopt the `APIPromise` and lose `withResponse()` and `asResponse()`.
    const issued = (async (): Promise<{ out: unknown; pending: Pending }> => {
      const placed = await placement(run, slotName, method, args, name);
      if (!placed) {
        try {
          return { out: original(...args), pending: { settle: end, fail: end } };
        } catch (error) {
          end();
          throw error;
        }
      }
      const pending = beginMeasure(run, slotName, { model: placed.model, onSettled: end, ...(options.now ? { now: options.now } : {}) });
      try {
        return { out: original(...placed.args), pending };
      } catch (error) {
        pending.fail(error);
        throw error;
      }
    })();
    return slotThenable(issued, method);
  }

  /** The arguments to send with the approved placement and the release's model id, or undefined to send the caller's untouched. Never throws. */
  async function placement(run: RunSession, slotName: string, method: ClientMethod, args: unknown[], name: string): Promise<{ args: unknown[]; model: string } | undefined> {
    const params = obj(args[0]);
    if (!params) return undefined;
    let pinned = false;
    try {
      const placed = await run.place(slotName);
      if (placed.kind !== "approved") return undefined;
      pinned = true;
      const model = modelFrom(placed.model, params);
      if (model === undefined) {
        once(ADAPTER_EVENTS.modelUnresolved, { slot: slotName, method: name, model: placed.model });
        run.decline(slotName, "model_unresolved");
        return undefined;
      }
      return { args: [options.apply(params, { ...placed, model }, method.kind), ...args.slice(1)], model: placed.model };
    } catch (error) {
      log(ADAPTER_EVENTS.placementFailed, { slot: slotName, method: name, reason: (error as Error).message });
      // The slot pinned a version this call will not serve: decline it, so no row or feedback names that version.
      if (pinned) {
        try {
          run.decline(slotName, "model_unresolved");
        } catch {
          // the call still goes out as written
        }
      }
      return undefined;
    }
  }

  function scopeCall(method: ClientMethod, original: (...args: unknown[]) => unknown, args: unknown[], name: string): unknown {
    let attribution: Attribution | undefined;
    try {
      attribution = ap.currentAttribution();
    } catch (error) {
      log(ADAPTER_EVENTS.attributionFailed, { method: name, reason: (error as Error).message });
    }
    if (!attribution) {
      once(ADAPTER_EVENTS.unattributed, { method: name });
      return original(...args);
    }
    const params = obj(args[0]);
    let unresolved = false;
    if (params) {
      try {
        // The caller placed the text. The release's model and sealed settings go on, or nothing does.
        const model = modelFrom(attribution.model, params);
        if (model === undefined) {
          unresolved = true;
          once(ADAPTER_EVENTS.modelUnresolved, { slot: attribution.tag, method: name, model: attribution.model });
        } else {
          const applied = applyInference(method.kind, { ...params, model }, attribution.inference ?? {});
          if (applied.overridden.length > 0) log(ADAPTER_EVENTS.inferenceOverridden, { slot: attribution.tag, method: name, parameters: applied.overridden });
          if (applied.unsupported.length > 0) log(ADAPTER_EVENTS.inferenceUnsupported, { slot: attribution.tag, method: name, settings: applied.unsupported });
          args = [applied.params, ...args.slice(1)];
        }
      } catch (error) {
        log(ADAPTER_EVENTS.placementFailed, { slot: attribution.tag, method: name, reason: (error as Error).message });
      }
    }
    // Another model's numbers must not count against this version: the call goes out as written, unobserved.
    if (unresolved) return original(...args);
    // The clock starts now; the observation settles when the response (or the whole stream) has gone by.
    const final = deferred();
    void ap.observe(attribution, () => final.promise, { model: modelOf(obj(args[0])) ?? attribution.model }).catch(noop);
    let out: unknown;
    try {
      out = original(...args);
    } catch (error) {
      final.fail(error);
      throw error;
    }
    try {
      return tapResult(out, method, final);
    } catch (error) {
      log(ADAPTER_EVENTS.tapFailed, { slot: attribution.tag, method: name, reason: (error as Error).message });
      final.settle(undefined);
      return out;
    }
  }
}

/**
 * A slot-bound call awaits its placement first, so it answers a thenable chained on the awaited call that keeps the
 * `APIPromise` surface: `then`, `catch`, `finally`, `withResponse()` and `asResponse()`. The body is parsed only when
 * the caller asks for it through `then`, so `asResponse()` hands back a response nobody has read.
 */
function slotThenable(issued: Promise<{ out: unknown; pending: Pending }>, method: ClientMethod): PromiseLike<unknown> & Record<string, unknown> {
  issued.catch(noop); // the caller's own handlers see a rejection; this one only keeps it from going unhandled
  const failed = (pending: Pending) => (error: unknown): never => {
    pending.fail(error);
    throw error;
  };
  let parsed: Promise<unknown> | undefined;
  const value = () => (parsed ??= issued.then(({ out, pending }) => Promise.resolve(out).then((resolved) => settleValue(resolved, method, pending), failed(pending))));
  const member = <R>(name: string, settle: (result: unknown, pending: Pending) => R) => () =>
    issued.then(({ out, pending }) => {
      const fn = obj(out)?.[name];
      if (typeof fn !== "function") return Promise.resolve(out).then((resolved) => settle(resolved, pending), failed(pending));
      return (fn as () => Promise<unknown>).call(out).then((result) => settle(result, pending), failed(pending));
    });
  return {
    then: (...args: Parameters<Promise<unknown>["then"]>) => value().then(...args),
    catch: (...args: Parameters<Promise<unknown>["catch"]>) => value().catch(...args),
    finally: (...args: Parameters<Promise<unknown>["finally"]>) => value().finally(...args),
    withResponse: member("withResponse", (result, pending) => settleWithResponse(result, method, pending)),
    // The raw response: its body is the caller's to read, so only the latency is measured.
    asResponse: member("asResponse", (result, pending) => (pending.settle(undefined), result)),
  } as PromiseLike<unknown> & Record<string, unknown>;
}
