// The Vercel AI SDK driver (TypeScript): a real `wrapLanguageModel` with
// `airprompterMiddleware(ap, { slot, modelFor, now })` over the AI SDK's own
// mock language model (`ai/test`), whose answers are the fixture's turns.
// `generateText` / `streamText` run the tool loop themselves (`stopWhen`), as
// a developer's agent does. The mock records what each model received; a
// baseline run on the bare model proves a passthrough left its params alone.
//
//   const { calls, runRefs } = await driveRun({ ap, fixture, clock, load });

import { feedbackOf, modelForOf, runProgram, seenWithBaseline } from "./program.mjs";
import { toolCallsOf } from "./recorded.mjs";

const pick = (body, keys) => Object.fromEntries(keys.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));

/** Mock models by id over one sequence of turns; each call is kept as the provider saw it. */
function mockProvider(mocks, turns, clock) {
  const Mock = mocks.MockLanguageModelV4 ?? mocks.MockLanguageModelV3 ?? mocks.MockLanguageModelV2;
  const objectShapes = Boolean(mocks.MockLanguageModelV4 ?? mocks.MockLanguageModelV3);
  const usageOf = (turn) => {
    const input = turn.usage?.input ?? 3;
    const output = turn.usage?.output ?? 2;
    const cached = turn.usage?.cachedInput ?? 0;
    return objectShapes ? { inputTokens: { total: input, noCache: input - cached, cacheRead: cached, cacheWrite: 0 }, outputTokens: { total: output, text: output, reasoning: 0 } } : { inputTokens: input, outputTokens: output, totalTokens: input + output, cachedInputTokens: cached };
  };
  const finish = (unified) => (objectShapes ? { unified, raw: unified } : unified);
  const calls = [];
  let next = 0;
  const take = (modelId, params, stream) => {
    calls.push({ raw: JSON.stringify(params), request: JSON.stringify({ modelId, params }), model: modelId, system: (params.prompt ?? []).filter((m) => m.role === "system").map((m) => m.content), settings: pick(params, ["temperature", "topP", "topK", "maxOutputTokens", "stopSequences"]), stream });
    const turn = turns[Math.min(next, turns.length - 1)];
    next += 1;
    if (clock) clock.ms += turn.latencyMs ?? 100;
    const tools = toolCallsOf(turn).map((call, index) => ({ type: "tool-call", toolCallId: `call_${next}_${index}`, toolName: call.name, input: call.arguments }));
    return { turn, tools, reason: turn.finish ?? (tools.length ? "tool-calls" : "stop") };
  };
  const models = new Map();
  const model = (modelId) => {
    if (!models.has(modelId)) {
      models.set(modelId, new Mock({
        modelId,
        doGenerate: async (params) => {
          const { turn, tools, reason } = take(modelId, params, false);
          return { content: [...(turn.content ? [{ type: "text", text: turn.content }] : []), ...tools], finishReason: finish(reason), usage: usageOf(turn), warnings: [] };
        },
        doStream: async (params) => {
          const { turn, tools, reason } = take(modelId, params, true);
          const chunks = [{ type: "stream-start", warnings: [] }];
          if (turn.content) chunks.push({ type: "text-start", id: "t" }, ...(turn.content.match(/.{1,6}/gs) ?? []).map((delta) => ({ type: "text-delta", id: "t", delta })), { type: "text-end", id: "t" });
          chunks.push(...tools, { type: "finish", finishReason: finish(reason), usage: usageOf(turn) });
          return { stream: mocks.simulateReadableStream({ chunks }) };
        },
      }));
    }
    return models.get(modelId);
  };
  const seen = () => calls.map(({ model: m, system, settings, stream }) => ({ model: m, system, settings, stream }));
  return { model, calls, seen };
}

export async function driveRun({ ap, fixture, clock, load }) {
  const ai = await load("ai");
  const mocks = await load("ai/test");
  const { z } = await load("zod");
  const { airprompterMiddleware } = await load("@airprompter/agent-sdk/frameworks/ai-sdk");
  const provider = mockProvider(mocks, fixture.recorded.turns, clock);
  const tools = (names) => Object.fromEntries((names ?? []).map((name) => [name, ai.tool({ description: `the ${name} tool`, inputSchema: z.object({}), execute: async () => "found it" })]));
  const middlewares = fixture.agent.clients.map((spec) => airprompterMiddleware(ap, { ...(spec.slot ? { slot: spec.slot } : {}), ...(spec.modelFor ? { modelFor: (id) => (modelForOf(spec.modelFor)(id) === undefined ? undefined : provider.model(spec.modelFor[id])) } : {}), now: () => clock.ms }));
  const generate = async (model, step) => {
    const request = { model, ...(step.system !== undefined ? { system: step.system } : {}), prompt: step.user ?? "hi", ...(step.tools ? { tools: tools(step.tools), stopWhen: ai.stepCountIs(12) } : {}), ...(step.params ?? {}) };
    if (step.stream) {
      const result = ai.streamText(request);
      for await (const part of result.textStream) void part;
      await result.response;
    } else await ai.generateText(request);
    return [];
  };
  const runRefs = await runProgram({ ap, fixture, call: (step) => generate(ai.wrapLanguageModel({ model: provider.model(step.model), middleware: middlewares[step.client ?? 0] }), step) });
  const results = feedbackOf(ap, fixture, runRefs);
  let baseline;
  if (fixture.agent.baseline) {
    baseline = mockProvider(mocks, fixture.recorded.turns);
    await runProgram({ ap, fixture: { ...fixture, agent: { ...fixture.agent, scope: "none" } }, call: (step) => generate(baseline.model(step.model), step) });
  }
  return { calls: seenWithBaseline(provider, baseline), runRefs, ...(results ? { results } : {}) };
}
