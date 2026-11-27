/**
 * A LangChain support agent on an approved prompt: `createAgent` with one tool, `lookup_order`, and AirPrompter's
 * middleware on the slot `support.reply`. The middleware puts the release's system text and model on every model
 * call, and counts the whole request, every model call and tool in it, as one run.
 *
 * As written it runs against the local registry `airprompter dev ../prompts` serves, with no AirPrompter account
 * (`AIRPROMPTER_BASE_URL` names it when it is not on port 4180). README.md › "Make it your agent" says which lines
 * change for a real one.
 *
 * @example
 * ```sh
 * airprompter dev ../prompts      # in another terminal
 * npm install
 * OPENAI_API_KEY=sk-… AIRPROMPTER_AGENT_KEY=apa_dev_local npm start
 * ```
 */

import { readFileSync } from "node:fs";

import { AirPrompterAgent } from "@airprompter/agent-sdk";
import { airprompter } from "@airprompter/agent-sdk/frameworks/langchain";
import { createAgent, tool } from "langchain";
import { z } from "zod";

const registry = process.env.AIRPROMPTER_BASE_URL ?? "http://127.0.0.1:4180";
const ap = await AirPrompterAgent.start({
  organizationId: "org_dev",
  agentId: "agt_dev",
  target: "dev",
  apiKey: process.env.AIRPROMPTER_AGENT_KEY,
  baseUrl: registry,
  // The local registry's own root, scoped to the environment `airprompter dev` serves (`dev`), and the document
  // where that root lists the keys that sign each release.
  root: { pinned: JSON.parse(readFileSync(new URL("../prompts/.airprompter-dev/root.pub.json", import.meta.url), "utf8")), hostedEnvironment: "dev" },
  sync: { rootUrl: `${registry}/roots/dev/root.json` },
});
// A script that serves one request takes the newest approved version first. A long-running server polls on its own.
await ap.syncNow();

const lookupOrder = tool(async ({ order_id }) => JSON.stringify({ order_id, status: "shipped", arrives: "2026-12-02" }), {
  name: "lookup_order",
  description: "Look up an order's status and delivery date by its id.",
  schema: z.object({ order_id: z.string() }),
});

const agent = createAgent({
  model: "openai:gpt-5-nano", // the release's model replaces this one; your key and base URL stay
  tools: [lookupOrder],
  systemPrompt: "You are a helpful assistant.", // runs only while AirPrompter has nothing approved to serve
  middleware: [airprompter(ap, { slots: "support.reply" })], // the one line that adds AirPrompter; keep it last
});

const result = await agent.invoke(
  { messages: [{ role: "user", content: "Where is my order A-1001?" }] },
  { context: { airprompter: { subject: "customer-42" } } }, // your user's id: each user stays on one version
);
console.log(result.messages.at(-1)?.text);

await ap.stop(); // writes this run's telemetry to the spool before the process exits
