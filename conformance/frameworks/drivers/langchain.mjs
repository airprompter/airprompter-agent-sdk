// The LangChain driver (TypeScript): `createAgent` with the AirPrompter
// middleware, over the real `ChatOpenAI` and a recorded fetch, as a developer
// would write it. The run input rides on the invocation's context. S0's
// middleware; AIR-2234 moves it onto the contract and adds the other kinds.
//
//   const { calls, runRefs } = await driveRun({ ap, fixture, clock, load });
//
// Imports only what a developer's code imports, through `load`: the SDK's
// framework subpath and the framework's own packages.

import { openAIChat } from "./recorded.mjs";

export async function driveRun({ ap, fixture, load }) {
  const { createAgent, HumanMessage, tool } = await load("langchain");
  const { ChatOpenAI } = await load("@langchain/openai");
  const { z } = await load("zod");
  const { airprompter } = await load("@airprompter/agent-sdk/frameworks/langchain");
  const provider = openAIChat(fixture.recorded.turns);
  const tools = (fixture.agent.tools ?? []).map((name) => tool(async () => "found it", { name, description: `the ${name} tool`, schema: z.object({}) }));
  const model = new ChatOpenAI({ model: fixture.agent.model, apiKey: "test-only", maxRetries: 0, configuration: { fetch: provider.fetch } });
  const agent = createAgent({ model, tools, systemPrompt: fixture.agent.systemPrompt, middleware: [airprompter(ap, { slots: fixture.agent.slots })] });
  const result = await agent.invoke({ messages: [new HumanMessage("hi")] }, { context: { airprompter: fixture.input } });
  return { calls: provider.seen(), runRefs: typeof result.airprompter_run_ref === "string" ? [result.airprompter_run_ref] : [] };
}
