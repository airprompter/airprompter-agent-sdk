// The Anthropic driver (TypeScript): the real `@anthropic-ai/sdk` client over a
// recorded fetch, instrumented with `instrument(client, ap, { slot, modelFor,
// now })`, running the fixture's program (program.mjs): Messages calls, plain
// or streamed, with the application's own tool loop, and a bare-client
// baseline when the fixture asks for one.
//
//   const { calls, runRefs } = await driveRun({ ap, fixture, clock, load });

import { feedbackOf, modelForOf, runProgram, seenWithBaseline } from "./program.mjs";
import { anthropicMessages } from "./recorded.mjs";

const toolSpec = (name) => ({ name, description: `the ${name} tool`, input_schema: { type: "object", properties: {} } });

async function messagesTurn(client, step, history) {
  if (history.length === 0) history.push({ role: "user", content: step.user ?? "hi" });
  const request = { model: step.model, max_tokens: 1024, messages: [...history], ...(step.system !== undefined ? { system: step.system } : {}), ...(step.tools ? { tools: step.tools.map(toolSpec) } : {}), ...(step.params ?? {}) };
  let content = [];
  if (step.stream) {
    const blocks = [];
    for await (const event of await client.messages.create({ ...request, stream: true })) {
      if (event.type === "content_block_start") blocks[event.index] = { ...event.content_block };
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") blocks[event.index].text = (blocks[event.index].text ?? "") + event.delta.text;
    }
    content = blocks.filter(Boolean);
  } else {
    content = (await client.messages.create(request)).content;
  }
  const uses = content.filter((block) => block.type === "tool_use");
  if (!uses.length) return [];
  history.push({ role: "assistant", content: content.map((block) => (block.type === "tool_use" ? { type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} } : { type: "text", text: block.text ?? "" })) });
  history.push({ role: "user", content: uses.map((use) => ({ type: "tool_result", tool_use_id: use.id, content: "found it" })) });
  return uses.map((use) => use.name);
}

export async function driveRun({ ap, fixture, clock, load }) {
  const { default: Anthropic } = await load("@anthropic-ai/sdk");
  const { instrument } = await load("@airprompter/agent-sdk/frameworks/anthropic");
  const provider = anthropicMessages(fixture.recorded.turns, { clock });
  const clients = fixture.agent.clients.map((spec) => instrument(new Anthropic({ apiKey: "test-only", fetch: provider.fetch, maxRetries: 0 }), ap, { ...(spec.slot ? { slot: spec.slot } : {}), ...(spec.modelFor ? { modelFor: modelForOf(spec.modelFor) } : {}), now: () => clock.ms }));
  const runRefs = await runProgram({ ap, fixture, call: (step, history) => messagesTurn(clients[step.client ?? 0], step, history) });
  const results = feedbackOf(ap, fixture, runRefs);
  let baseline;
  if (fixture.agent.baseline) {
    baseline = anthropicMessages(fixture.recorded.turns);
    const bare = new Anthropic({ apiKey: "test-only", fetch: baseline.fetch, maxRetries: 0 });
    await runProgram({ ap, fixture: { ...fixture, agent: { ...fixture.agent, scope: "none" } }, call: (step, history) => messagesTurn(bare, step, history) });
  }
  return { calls: seenWithBaseline(provider, baseline), runRefs, ...(results ? { results } : {}) };
}
