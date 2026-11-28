// The OpenAI driver (TypeScript): the real `openai` client over a recorded
// fetch, instrumented with `instrument(client, ap, { slot, modelFor, now })`
// as a developer would, running the fixture's program (program.mjs): Chat
// Completions calls, plain or streamed, with the application's own tool loop.
// A fixture with `baseline` also runs the program on a bare client, so a
// passthrough proves its request left byte for byte as the caller wrote it.
//
//   const { calls, runRefs } = await driveRun({ ap, fixture, clock, load });

import { feedbackOf, modelForOf, runProgram, seenWithBaseline } from "./program.mjs";
import { openAIChat, openAIResponses } from "./recorded.mjs";

const toolSpec = (name) => ({ type: "function", function: { name, description: `the ${name} tool`, parameters: { type: "object", properties: {} } } });

/** One step's next Chat Completions call; answers the tools the model asked for, having run them. */
async function chatTurn(client, step, history) {
  if (history.length === 0) {
    if (step.system !== undefined) history.push({ role: "system", content: step.system });
    history.push({ role: "user", content: step.user ?? "hi" });
  }
  const request = { model: step.model, messages: [...history], ...(step.tools ? { tools: step.tools.map(toolSpec) } : {}), ...(step.params ?? {}) };
  let message;
  if (step.stream) {
    // `includeUsage: false`: the caller's plain `stream: true`, as most code writes it.
    const stream = await client.chat.completions.create({ ...request, stream: true, ...(step.includeUsage === false ? {} : { stream_options: { include_usage: true } }) });
    message = { role: "assistant", content: "", tool_calls: [] };
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta ?? {};
      if (delta.content) message.content += delta.content;
      for (const call of delta.tool_calls ?? []) message.tool_calls[call.index] = { id: call.id, type: "function", function: { name: call.function?.name, arguments: call.function?.arguments ?? "{}" } };
    }
  } else {
    message = (await client.chat.completions.create(request)).choices[0].message;
  }
  const calls = message.tool_calls ?? [];
  if (!calls.length) return [];
  history.push({ role: "assistant", content: message.content ?? "", tool_calls: calls });
  for (const call of calls) history.push({ role: "tool", tool_call_id: call.id, content: "found it" });
  return calls.map((call) => call.function.name);
}

/** One step's next Responses call (`api: "responses"`): instructions, input items, function calls and their outputs. */
async function responsesTurn(client, step, history) {
  if (history.length === 0) history.push({ role: "user", content: step.user ?? "hi" });
  const response = await client.responses.create({ model: step.model, input: [...history], ...(step.system !== undefined ? { instructions: step.system } : {}), ...(step.tools ? { tools: step.tools.map((name) => ({ type: "function", name, description: `the ${name} tool`, parameters: { type: "object", properties: {} } })) } : {}), ...(step.params ?? {}) });
  const calls = (response.output ?? []).filter((item) => item.type === "function_call");
  if (!calls.length) return [];
  for (const call of calls) history.push({ type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments }, { type: "function_call_output", call_id: call.call_id, output: "found it" });
  return calls.map((call) => call.name);
}

const turnOf = (client, step, history) => (step.api === "responses" ? responsesTurn(client, step, history) : chatTurn(client, step, history));

export async function driveRun({ ap, fixture, clock, load }) {
  const { default: OpenAI } = await load("openai");
  const { instrument } = await load("@airprompter/agent-sdk/frameworks/openai");
  const record = fixture.agent.steps.some((step) => step.api === "responses") ? openAIResponses : openAIChat;
  const provider = record(fixture.recorded.turns, { clock });
  const clients = fixture.agent.clients.map((spec) => instrument(new OpenAI({ apiKey: "test-only", fetch: provider.fetch, maxRetries: 0 }), ap, { ...(spec.slot ? { slot: spec.slot } : {}), ...(spec.modelFor ? { modelFor: modelForOf(spec.modelFor) } : {}), now: () => clock.ms }));
  const runRefs = await runProgram({ ap, fixture, call: (step, history) => turnOf(clients[step.client ?? 0], step, history) });
  const results = feedbackOf(ap, fixture, runRefs);
  let baseline;
  if (fixture.agent.baseline) {
    baseline = record(fixture.recorded.turns);
    const bare = new OpenAI({ apiKey: "test-only", fetch: baseline.fetch, maxRetries: 0 });
    await runProgram({ ap, fixture: { ...fixture, agent: { ...fixture.agent, scope: "none" } }, call: (step, history) => turnOf(bare, step, history) });
  }
  return { calls: seenWithBaseline(provider, baseline), runRefs, ...(results ? { results } : {}) };
}
