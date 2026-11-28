#!/usr/bin/env node
/**
 * A local model provider for the examples: it plays one recorded tool loop in the OpenAI wire format, so an example
 * runs unchanged with no provider key and no network. Point the framework at it with `OPENAI_BASE_URL`.
 *
 * The turns are the LangChain conformance fixture's (`conformance/frameworks/fixtures/langchain/tool-loop-ts.json`):
 * four tool calls, then an answer, with the usage each turn reports. The fixture's tool is a stand-in, so each tool
 * call here names the examples' shared tool, `lookup_order`, with recorded arguments. The turn is read from the
 * request (how many tool calls the conversation already holds), so each conversation replays the loop from its
 * first turn and the server keeps no state between runs. Every request is kept, so a check can read what the
 * provider received: the wire API, the system text, the model, the tools it was offered.
 *
 * Two OpenAI calls are answered, both without streaming: Chat Completions (`POST …/chat/completions`) and the
 * Responses API (`POST …/responses`, which LangChain's `createAgent` uses for an `"openai:…"` model). Anything else,
 * a stream, or a Responses call that leans on server state (`previous_response_id`), is answered with an error and
 * kept in `unexpected`, so a framework that changes its wire call fails the check rather than passing by accident.
 *
 * @example
 * ```sh
 * $ node examples/ci/fake-provider.mjs --port 4181      # then, in the example: OPENAI_BASE_URL=http://127.0.0.1:4181/v1
 * ```
 *
 * ```js
 * import { startFakeProvider } from "./fake-provider.mjs";
 * const provider = await startFakeProvider();
 * // … run the example with OPENAI_BASE_URL=`${provider.url}/v1` …
 * provider.requests[0].system; // ["You answer support tickets for Acme. …"]
 * await provider.close();
 * ```
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const FIXTURE = new URL("../../conformance/frameworks/fixtures/langchain/tool-loop-ts.json", import.meta.url);

/** The examples' one tool, as every example declares it, and the arguments the recording calls it with. */
export const TOOL = { name: "lookup_order", arguments: { order_id: "A-1001" } };

/** The recorded turns, and what the run they make should add up to. */
export function recording() {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const turns = fixture.recorded.turns;
  return {
    turns,
    answer: turns.at(-1).content,
    toolCalls: turns.reduce((sum, turn) => sum + (turn.toolCalls?.length ?? 0), 0),
    tokens: fixture.expect.rows[0].tokens,
  };
}

const textOf = (content) => (Array.isArray(content) ? content.map((block) => block.text ?? "").join("") : String(content ?? ""));
const isSystem = (item) => item.role === "system" || item.role === "developer";

/** The turn a conversation is on: the recorded turns whose tool calls it already holds. */
function turnAfter(turns, toolCallsSoFar) {
  let index = 0;
  let left = toolCallsSoFar;
  while (index < turns.length && turns[index].toolCalls?.length && left >= turns[index].toolCalls.length) {
    left -= turns[index].toolCalls.length;
    index += 1;
  }
  return index;
}

/** Each wire call: how to read a request, and how to answer one recorded turn in its shape. */
const WIRES = {
  chat: {
    matches: (path) => path.endsWith("/chat/completions"),
    read: (body) => ({
      system: (body.messages ?? []).filter(isSystem).map((m) => textOf(m.content)),
      tools: (body.tools ?? []).map((t) => t.function?.name),
      toolCallsSoFar: (body.messages ?? []).reduce((sum, m) => sum + (m.role === "assistant" ? (m.tool_calls?.length ?? 0) : 0), 0),
    }),
    answer: (body, turn, n) => {
      const tool_calls = (turn.toolCalls ?? []).map((_, i) => ({ id: `call_${n}_${i}`, type: "function", function: { name: TOOL.name, arguments: JSON.stringify(TOOL.arguments) } }));
      return {
        id: `chatcmpl-fake-${n}`,
        object: "chat.completion",
        created: 1_789_300_800,
        model: body.model,
        choices: [{ index: 0, finish_reason: tool_calls.length ? "tool_calls" : "stop", message: { role: "assistant", content: turn.content ?? "", ...(tool_calls.length ? { tool_calls } : {}) } }],
        usage: { ...turn.usage, total_tokens: turn.usage.prompt_tokens + turn.usage.completion_tokens },
      };
    },
  },
  responses: {
    matches: (path) => path.endsWith("/responses"),
    read: (body) => {
      const input = typeof body.input === "string" ? [{ role: "user", content: body.input }] : (body.input ?? []);
      return {
        system: [...(body.instructions ? [body.instructions] : []), ...input.filter(isSystem).map((item) => textOf(item.content))],
        tools: (body.tools ?? []).map((t) => t.name ?? t.function?.name),
        toolCallsSoFar: input.filter((item) => item.type === "function_call").length,
      };
    },
    answer: (body, turn, n) => {
      const calls = (turn.toolCalls ?? []).map((_, i) => ({ type: "function_call", id: `fc_${n}_${i}`, call_id: `call_${n}_${i}`, name: TOOL.name, arguments: JSON.stringify(TOOL.arguments), status: "completed" }));
      const message = { type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: turn.content ?? "", annotations: [] }] };
      return {
        id: `resp_fake_${n}`,
        object: "response",
        created_at: 1_789_300_800,
        status: "completed",
        model: body.model,
        output: calls.length ? calls : [message],
        error: null,
        incomplete_details: null,
        usage: {
          input_tokens: turn.usage.prompt_tokens,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: turn.usage.completion_tokens,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: turn.usage.prompt_tokens + turn.usage.completion_tokens,
        },
      };
    },
  },
};

export async function startFakeProvider({ port = 0, host = "127.0.0.1" } = {}) {
  const { turns } = recording();
  const requests = [];
  const unexpected = [];
  const reply = (response, status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const path = new URL(request.url ?? "/", "http://fake").pathname;
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        // kept as unexpected below
      }
      const [api, wire] = Object.entries(WIRES).find(([, w]) => w.matches(path)) ?? [];
      const refusal = request.method !== "POST" || !wire || !body ? `${request.method} ${path}` : body.stream ? `${path} with stream: true` : body.previous_response_id ? `${path} with previous_response_id` : null;
      if (refusal) {
        unexpected.push({ method: request.method, path, refusal });
        return reply(response, 404, { error: { message: `fake-provider answers POST /v1/chat/completions and /v1/responses without streaming or server state; got ${refusal}`, type: "invalid_request_error" } });
      }
      const seen = wire.read(body);
      const index = turnAfter(turns, seen.toolCallsSoFar);
      requests.push({ api, path, model: body.model, system: seen.system, tools: seen.tools, temperature: body.temperature });
      const turn = turns[index];
      if (!turn) {
        unexpected.push({ method: "POST", path, refusal: `turn ${index + 1} is past the ${turns.length} recorded turns` });
        return reply(response, 500, { error: { message: "fake-provider: no recorded turn left", type: "server_error" } });
      }
      reply(response, 200, wire.answer(body, turn, index + 1));
    });
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  return {
    url: `http://${host}:${address.port}`,
    requests,
    unexpected,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const at = process.argv.indexOf("--port");
  const provider = await startFakeProvider({ port: at === -1 ? 4181 : Number(process.argv[at + 1]) });
  console.log(`fake-provider: ${provider.url}/v1 (set OPENAI_BASE_URL to this); each conversation replays the recorded tool loop of ${recording().turns.length} turns. Ctrl-C to stop.`);
  process.on("SIGINT", () => provider.close().then(() => process.exit(0)));
}
