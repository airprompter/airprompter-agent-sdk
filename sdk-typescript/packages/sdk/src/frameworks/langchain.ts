/**
 * LangChain middleware: one line in `createAgent`, and the agent runs on the
 * approved prompt and model, with one request counted as one run however many
 * model calls it makes. This file translates hooks to run calls. It renders
 * nothing, assigns nothing, and reads no manifest.
 *
 * Middleware has no scope that spans its hooks, so each hook finds its run by
 * the id kept in graph state. Only that id and the run reference enter state,
 * never prompt text.
 *
 * Put `airprompter(...)` last in `middleware`. The list runs outermost first,
 * so anything listed after it would see the approved text and could send it
 * to a model the release did not pin.
 *
 * @example
 * ```ts
 * import { airprompter } from "@airprompter/agent-sdk/frameworks/langchain";
 *
 * const agent = createAgent({ model: "openai:gpt-5", tools, middleware: [airprompter(ap, { slots: "support-reply" })] });
 * await agent.invoke({ messages }, { context: { airprompter: { subject: userId } } }); // the subject decides the arm
 * ```
 */

import { ToolInvocationError, SystemMessage, createMiddleware, initChatModel } from "langchain";
import { MODEL_PROVIDER_CONFIG, _inferModelProvider } from "langchain/chat_models/universal";
import type { AgentMiddleware } from "langchain";
import { z } from "zod";
import { classifyError, classifyResult, normalizeUsage, temperatureOf, topPOf } from "../runtime/index.js";
import type { AgentRuntime, Placement, RunInput, RunSession } from "../runtime/index.js";
import type { SlotInference } from "../core/index.js";

export interface AirPrompterMiddlewareOptions {
  /** The slot this agent runs on. */
  slots: string;
  /** Builds the run's input from the agent's context. By default it reads `context.airprompter`. */
  input?: (context: unknown) => RunInput;
  /** LangChain hands a middleware only the context keys it declares, so `input` sees only the keys listed here. */
  contextSchema?: { shape: z.ZodRawShape };
}

type Approved = Extract<Placement, { kind: "approved" }>;
type RuntimeLike = { context?: unknown; configurable?: { thread_id?: unknown } };
type StateLike = { airprompter_run_id?: string };
type ModelLike = { model?: string; modelName?: string; lc_kwargs?: Record<string, unknown>; _defaultConfig?: Record<string, unknown>; _llmType?: () => string; constructor: new (fields: Record<string, unknown>) => unknown };

/** The sealed settings a chat model reads only from its constructor. Passed as `modelSettings`, they never reach the wire. */
function constructorFields(settings: SlotInference): Record<string, unknown> {
  const temperature = temperatureOf(settings);
  const topP = topPOf(settings);
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(settings.maxOutputTokens === undefined ? {} : { maxTokens: settings.maxOutputTokens }),
  };
}

function callSettings(settings: SlotInference): Record<string, unknown> {
  return {
    ...(settings.stopSequences === undefined ? {} : { stop: [...settings.stopSequences] }),
    ...(settings.reasoningEffort === undefined ? {} : { reasoningEffort: settings.reasoningEffort }),
  };
}

function withoutModel(config: Record<string, unknown>): Record<string, unknown> {
  const { model: _model, ...defaults } = config;
  return defaults;
}

/** A release id may name its provider, as `initChatModel` reads it. Worked out without building a model, which needs a key. */
function parseModelId(id: string): { provider: string | undefined; id: string } {
  const separator = id.indexOf(":");
  const prefix = id.slice(0, Math.max(separator, 0));
  if (prefix in MODEL_PROVIDER_CONFIG) return { provider: prefix, id: id.slice(separator + 1) };
  return { provider: _inferModelProvider(id), id };
}

function providerOf(model: ModelLike): string | undefined {
  const configured = model._defaultConfig;
  if (!configured) return model._llmType?.();
  return (configured.modelProvider as string | undefined) ?? _inferModelProvider(configured.model as string);
}

/** Whether the caller set its own endpoint, as a gateway does. An id no provider claims can only run there. */
function hasOwnEndpoint(model: ModelLike): boolean {
  const fields = (model._defaultConfig ?? model.lc_kwargs ?? {}) as { baseURL?: unknown; baseUrl?: unknown; anthropicApiUrl?: unknown; configuration?: { baseURL?: unknown }; clientOptions?: { baseURL?: unknown } };
  return Boolean(fields.baseURL ?? fields.baseUrl ?? fields.anthropicApiUrl ?? fields.configuration?.baseURL ?? fields.clientOptions?.baseURL);
}

/** The model that runs this placement. The release's model wins, and approved text never runs on another. */
async function buildModel(model: ModelLike, placed: Approved): Promise<unknown> {
  const fields = constructorFields(placed.settings);
  const released = parseModelId(placed.model);
  const configured = model._defaultConfig;
  const caller = providerOf(model);
  const sameId = (model.model ?? model.modelName ?? configured?.model) === released.id;
  if (sameId && Object.keys(fields).length === 0) return model;
  const keepRoute = () => {
    // A string-built model keeps its fields in `_defaultConfig`, so rebuilding from `lc_kwargs` would silently drop them.
    if (configured) return initChatModel(released.id, { ...withoutModel(configured), ...(caller ? { modelProvider: caller } : {}), ...fields } as never);
    return new model.constructor({ ...model.lc_kwargs, model: released.id, ...fields });
  };
  if (sameId) return keepRoute();
  // An Azure deployment is a private route, and it serves only its own model. Moving off it would send the customer's messages to the public endpoint.
  if (caller === "azure_openai") throw new Error("model_unresolved");
  // The caller's key and base URL stay on its own provider, so a gateway is not bypassed.
  if (released.provider === caller) return keepRoute();
  if (released.provider === undefined) {
    if (hasOwnEndpoint(model)) return keepRoute();
    throw new Error("model_unresolved");
  }
  // Another provider takes nothing of the caller's: `_defaultConfig` holds `modelProvider`, and keeping it sent a Claude id down the OpenAI path.
  return initChatModel(released.id, { modelProvider: released.provider, ...fields } as never);
}

/** An interrupt or a parent command is control flow on its way up, not a failure. */
function isBubbleUp(error: unknown): boolean {
  return (error as { is_bubble_up?: unknown } | null)?.is_bubble_up === true;
}

function usageOf(message: { usage_metadata?: Record<string, unknown> & { input_token_details?: { cache_read?: unknown } } }) {
  const usage = message.usage_metadata;
  if (!usage) return normalizeUsage(undefined);
  // LangChain counts cached tokens inside input_tokens, as OpenAI does.
  return normalizeUsage({ usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, input_tokens_details: { cached_tokens: usage.input_token_details?.cache_read } } });
}

function finishErrorOf(message: { response_metadata?: { finish_reason?: unknown; stop_reason?: unknown } }) {
  const metadata = message.response_metadata;
  return classifyResult({ stop_reason: metadata?.finish_reason ?? metadata?.stop_reason });
}

// The field is unknown, because a schema here would reject the caller's request over a bad subject. `softInput` reads it.
const contextSchema = z.object({ airprompter: z.unknown().optional() });

/** What is usable from `context.airprompter`. A bad field is dropped, and bad tags end at the session's own check. */
function softInput(value: unknown): RunInput {
  const input = (typeof value === "object" && value !== null ? value : {}) as { subject?: unknown; tags?: unknown; variables?: unknown };
  const isRecord = (field: unknown): field is Record<string, never> => typeof field === "object" && field !== null;
  const isValue = ([, field]: [string, unknown]) => field === null || ["string", "number", "boolean"].includes(typeof field);
  return {
    ...(typeof input.subject === "string" ? { subject: input.subject } : {}),
    ...(isRecord(input.tags) ? { tags: input.tags } : {}),
    ...(isRecord(input.variables) ? { variables: Object.fromEntries(Object.entries(input.variables).filter(isValue)) } : {}),
  };
}

const stateSchema = z.object({
  airprompter_run_id: z.string().optional(),
  airprompter_run_ref: z.string().optional(),
});

export function airprompter(ap: AgentRuntime, options: AirPrompterMiddlewareOptions): AgentMiddleware {
  const { slots: slot } = options;
  const built = new WeakMap<object, Map<string, Promise<unknown>>>();
  const unresolved = new Set<string>();

  const inputOf = (runtime: RuntimeLike | undefined): RunInput => {
    const threadId = runtime?.configurable?.thread_id;
    const conversation = typeof threadId === "string" ? { conversationId: threadId } : {};
    if (options.input) return { ...conversation, ...options.input(runtime?.context) };
    return { ...conversation, ...softInput((runtime?.context as { airprompter?: unknown } | undefined)?.airprompter) };
  };

  const findRun = (state: StateLike, runtime: RuntimeLike | undefined): RunSession => {
    const current = ap.currentRun();
    if (current) return current;
    const { airprompter_run_id: resume } = state;
    return ap.openRun({ ...inputOf(runtime), ...(resume ? { resume } : {}) });
  };

  const modelFor = async (model: ModelLike, placed: Approved): Promise<unknown> => {
    let perPlacement = built.get(model);
    if (!perPlacement) built.set(model, (perPlacement = new Map()));
    const key = JSON.stringify([placed.model, placed.settings]);
    let building = perPlacement.get(key);
    if (!building) perPlacement.set(key, (building = buildModel(model, placed)));
    try {
      return await building;
    } catch (error) {
      perPlacement.delete(key);
      if (!unresolved.has(placed.model)) {
        unresolved.add(placed.model);
        ap.log({ event: "run_passthrough", slot, reason: "model_unresolved", model: placed.model, error: (error as Error).name });
      }
      return null;
    }
  };

  return createMiddleware({
    name: "AirPrompter",
    contextSchema: options.contextSchema ? contextSchema.extend(options.contextSchema.shape) : contextSchema,
    stateSchema,
    beforeAgent: (_state: unknown, runtime: unknown) => {
      const run = ap.currentRun() ?? ap.openRun(inputOf(runtime as RuntimeLike));
      return { airprompter_run_id: run.id };
    },
    wrapModelCall: async (request: never, handler: (request: never) => Promise<never>) => {
      const { state, runtime, model, modelSettings } = request as unknown as { state: StateLike; runtime?: RuntimeLike; model: ModelLike; modelSettings?: Record<string, unknown> };
      const run = findRun(state, runtime);
      const placed = await run.place(slot);
      if (placed.kind === "passthrough") return ap.withRun(run, () => handler(request));
      const approvedModel = await modelFor(model, placed);
      if (!approvedModel) return ap.withRun(run, () => handler(request));
      const override = { ...(request as object), model: approvedModel, systemMessage: new SystemMessage(placed.instructions), modelSettings: { ...modelSettings, ...callSettings(placed.settings) } };
      const started = Date.now();
      const latency = () => Math.max(0, Date.now() - started);
      try {
        const result = await ap.withRun(run, () => handler(override as never));
        // With `responseFormat` the handler answers { structuredResponse, messages }.
        const message = ((result as { messages?: unknown[] }).messages?.[0] ?? result) as Parameters<typeof usageOf>[0] & Parameters<typeof finishErrorOf>[0];
        const errorClass = finishErrorOf(message);
        run.recordModelCall(slot, { model: placed.model, latencyMs: latency(), usage: usageOf(message), ...(errorClass ? { errorClass } : {}) });
        return result;
      } catch (error) {
        // No `end` here: an outer retry middleware calls this hook again. A failed run reaches the console through the sweep.
        if (!isBubbleUp(error)) run.recordModelCall(slot, { model: placed.model, latencyMs: latency(), errorClass: classifyError(error) });
        throw error;
      }
    },
    wrapToolCall: async (request: never, handler: (request: never) => Promise<never>) => {
      const { state, runtime, toolCall } = request as unknown as { state: StateLike; runtime?: RuntimeLike; toolCall: ConstructorParameters<typeof ToolInvocationError>[1] };
      const run = findRun(state, runtime);
      try {
        const result = await ap.withRun(run, () => handler(request));
        run.recordToolCall(slot, { ok: (result as { status?: unknown }).status !== "error" });
        return result;
      } catch (error) {
        // A GraphInterrupt tool re-runs on resume, so it is not counted.
        if (isBubbleUp(error)) throw error;
        run.recordToolCall(slot, { ok: false });
        if (ToolInvocationError.isInstance(error)) throw error;
        // A plain rethrow here would turn a recoverable tool error fatal. The model sees LangChain's own text.
        const wrapped = new ToolInvocationError(error, toolCall);
        wrapped.message = `${error}\n Please fix your mistakes.`;
        throw wrapped;
      }
    },
    afterAgent: (state: StateLike, runtime: unknown) => {
      const run = findRun(state, runtime as RuntimeLike);
      // Inside a scope this agent is nested, and the run belongs to its parent, or to `ap.run`.
      if (!ap.currentRun()) run.end();
      return { airprompter_run_ref: run.runRef };
    },
  } as never) as unknown as AgentMiddleware;
}
