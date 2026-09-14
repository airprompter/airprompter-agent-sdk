/**
 * T33: `ap.wrap()` and the AI SDK middleware against the REAL provider
 * packages (`openai`, `@anthropic-ai/sdk`, `ai`) with recorded responses
 * served through each client's own `fetch` option — the public extension
 * point, so nothing here reaches the network. The packages are not
 * dependencies of this SDK: the suite skips when they are absent and runs
 * in the weekly `wrap-latest` workflow, which installs their latest
 * releases (`WRAP_LIVE=1` turns a skip into a failure there).
 *
 *   npm i --no-save openai @anthropic-ai/sdk ai && WRAP_LIVE=1 npx tsx --test test/wrapLive.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent } from "../packages/sdk/src/agent.js";
import { publicJwkOf } from "../packages/core/src/protocol/trust.js";
import type { WindowRow } from "../packages/telemetry/src/spool/writer.js";
import { FakeControlPlane } from "./helpers/controlPlane.js";

const scope = { organizationId: "org_1", agentId: "agt_1", target: "prod" as const };
const required = process.env.WRAP_LIVE === "1";

async function load(name: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(name)) as Record<string, unknown>;
  } catch (error) {
    if (required) throw new Error(`${name} is required with WRAP_LIVE=1: ${(error as Error).message}`);
    return null;
  }
}

async function startAgent() {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-wrap-live-"));
  const plane = new FakeControlPlane(scope);
  plane.promote([
    { ...plane.slot({ tag: "support.triage", text: "Triage this ticket.", model: "gpt-5" }), outputChecks: [{ kind: "must_match" as const, name: "signed", pattern: "Regards" }] },
    plane.slot({ tag: "support.reply", text: "Reply politely.", model: "claude-haiku-4-5" }),
  ]);
  const ap = await AirPrompterAgent.start({
    ...scope,
    apiKey: plane.apiKey,
    baseUrl: "https://api.test",
    stateDir,
    root: { pinned: publicJwkOf(plane.rootKey) },
    sync: { mode: "resident", pollSeconds: 3600, edgePointerUrl: "https://edge.test/g/token/generation.json", rootUrl: "https://edge.test/roots/prod/root.json" },
    fetch: plane.fetch(),
    telemetry: { sink: "memory" },
  });
  return {
    ap,
    windows: async () => {
      await ap.stop();
      rmSync(stateDir, { recursive: true, force: true });
      return ap.drainMemorySink().filter((r) => (r as { type: string }).type === "window") as WindowRow[];
    },
  };
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const sse = (events: Array<{ event?: string; data: unknown }>, done = false) =>
  new Response(events.map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${JSON.stringify(e.data)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""), { status: 200, headers: { "content-type": "text/event-stream" } });

/** A `fetch` that answers from the recorded bodies by URL path and streaming flag; records what was asked. */
function recordedFetch(routes: Record<string, (body: Record<string, unknown>) => Response>) {
  const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const body = JSON.parse((init?.body as string | undefined) ?? "{}") as Record<string, unknown>;
    seen.push({ path: url.pathname, body });
    const route = routes[url.pathname];
    if (!route) return new Response(JSON.stringify({ error: { message: `no recording for ${url.pathname}` } }), { status: 404 });
    return route(body);
  };
  return { fetchImpl, seen };
}

const openaiUsage = { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, prompt_tokens_details: { cached_tokens: 2 } };

test("openai: chat.completions.create (plain and stream: true), chat.completions.stream(), responses.create through the real client", async (t) => {
  const mod = await load("openai");
  if (!mod) return t.skip("openai is not installed");
  const OpenAI = mod.default as new (options: Record<string, unknown>) => Record<string, any>;
  const { fetchImpl, seen } = recordedFetch({
    "/v1/chat/completions": (body) =>
      body.stream
        ? sse(
            [
              { data: { id: "chatcmpl_s", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: { role: "assistant", content: "Regards, " }, finish_reason: null }] } },
              { data: { id: "chatcmpl_s", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: { content: "us" }, finish_reason: null }] } },
              { data: { id: "chatcmpl_s", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: {}, finish_reason: "length" }] } },
              { data: { id: "chatcmpl_s", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [], usage: openaiUsage } },
            ],
            true,
          )
        : json({ id: "chatcmpl_p", object: "chat.completion", created: 1, model: "gpt-5", choices: [{ index: 0, message: { role: "assistant", content: "Regards, us" }, finish_reason: "stop" }], usage: openaiUsage }),
    "/v1/responses": () =>
      json({
        id: "resp_1",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "gpt-5",
        output: [{ type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "No signature", annotations: [] }] }],
        usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
      }),
  });
  const { ap, windows } = await startAgent();
  const openai = ap.wrap(new OpenAI({ apiKey: "sk-test", fetch: fetchImpl }));
  const triage = ap.prompt("support.triage").render({});
  const messages = [
    { role: "system", content: triage.text },
    { role: "user", content: "hello" },
  ];
  const plain = await openai.chat.completions.create({ model: "gpt-5", messages });
  assert.equal(plain.choices[0].message.content, "Regards, us");
  const { response } = await openai.chat.completions.create({ model: "gpt-5", messages }).withResponse();
  assert.equal(response.status, 200);
  let streamed = "";
  for await (const chunk of await openai.chat.completions.create({ model: "gpt-5", messages, stream: true, stream_options: { include_usage: true } })) streamed += chunk.choices[0]?.delta?.content ?? "";
  assert.equal(streamed, "Regards, us");
  const helper = openai.chat.completions.stream({ model: "gpt-5", messages });
  const final = await helper.finalChatCompletion();
  assert.equal(final.choices[0].message.content, "Regards, us");
  const responses = await openai.responses.create({ model: "gpt-5", instructions: triage.text, input: "hello" });
  assert.equal(responses.output_text, "No signature");
  assert.equal(seen.length, 5);
  assert.equal(seen[0]!.body.model, "gpt-5");
  const rows = (await windows()).sort((a, b) => `${a.status}${a.errorClass}`.localeCompare(`${b.status}${b.errorClass}`));
  assert.deepEqual(
    rows.map((r) => [r.tag, r.model, r.status, r.errorClass ?? null, r.count, r.tokens, r.checks ?? null]),
    [
      ["support.triage", "gpt-5", "error", "truncated", 2, { input: 20, cachedInput: 4, output: 8 }, { passed: 2, failed: 0 }],
      ["support.triage", "gpt-5", "ok", null, 3, { input: 29, cachedInput: 4, output: 11 }, { passed: 2, failed: 1 }],
    ],
  );
});

test("@anthropic-ai/sdk: messages.create (plain and stream: true) and messages.stream() through the real client", async (t) => {
  const mod = await load("@anthropic-ai/sdk");
  if (!mod) return t.skip("@anthropic-ai/sdk is not installed");
  const Anthropic = mod.default as new (options: Record<string, unknown>) => Record<string, any>;
  const message = { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text: "Hello there" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 } };
  const events = [
    { event: "message_start", data: { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 1, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "there" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null }, usage: { output_tokens: 2 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
  const { fetchImpl, seen } = recordedFetch({ "/v1/messages": (body) => (body.stream ? sse(events) : json(message)) });
  const { ap, windows } = await startAgent();
  const anthropic = ap.wrap(new Anthropic({ apiKey: "sk-ant-test", fetch: fetchImpl }));
  const reply = ap.prompt("support.reply").render({});
  const plain = await anthropic.messages.create({ model: "claude-haiku-4-5", max_tokens: 64, system: reply.text, messages: [{ role: "user", content: "hi" }] });
  assert.equal(plain.content[0].text, "Hello there");
  let streamed = "";
  for await (const event of await anthropic.messages.create({ model: "claude-haiku-4-5", max_tokens: 64, system: reply.text, messages: [{ role: "user", content: "hi" }], stream: true })) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") streamed += event.delta.text;
  }
  assert.equal(streamed, "Hello there");
  const helper = anthropic.messages.stream({ model: "claude-haiku-4-5", max_tokens: 64, system: [{ type: "text", text: reply.text }], messages: [{ role: "user", content: "hi" }] });
  const final = await helper.finalMessage();
  assert.equal(final.content[0].text, "Hello there");
  assert.equal(seen.length, 3);
  const rows = (await windows()).sort((a, b) => `${a.status}`.localeCompare(`${b.status}`));
  assert.deepEqual(
    rows.map((r) => [r.tag, r.model, r.status, r.errorClass ?? null, r.count, r.tokens]),
    [
      ["support.reply", "claude-haiku-4-5", "error", "truncated", 2, { input: 14, cachedInput: 6, output: 4 }],
      ["support.reply", "claude-haiku-4-5", "ok", null, 1, { input: 7, cachedInput: 3, output: 2 }],
    ],
  );
});

test("ai: wrapLanguageModel({ middleware: ap.aiSdkMiddleware() }) with generateText and streamText over the AI SDK's own mock model", async (t) => {
  const ai = await load("ai");
  const aiTest = await load("ai/test");
  if (!ai || !aiTest) return t.skip("ai is not installed");
  const { generateText, streamText, wrapLanguageModel } = ai as Record<string, any>;
  const mocks = aiTest as Record<string, any>;
  const { simulateReadableStream } = mocks;
  // The newest mock the installed AI SDK ships, and that spec's usage / finish-reason shapes.
  const Mock = mocks.MockLanguageModelV4 ?? mocks.MockLanguageModelV3 ?? mocks.MockLanguageModelV2;
  const objectShapes = Boolean(mocks.MockLanguageModelV4 ?? mocks.MockLanguageModelV3);
  const usage = (input: number, output: number) => (objectShapes ? { inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: output, text: output, reasoning: 0 } } : { inputTokens: input, outputTokens: output, totalTokens: input + output });
  const finish = (unified: string) => (objectShapes ? { unified, raw: unified } : unified);
  const { ap, windows } = await startAgent();
  const triage = ap.prompt("support.triage").render({});
  const model = wrapLanguageModel({
    model: new Mock({
      modelId: "mock-gpt",
      doGenerate: async () => ({
        content: [{ type: "text", text: "Regards, mock" }],
        finishReason: finish("stop"),
        usage: usage(11, 3),
        warnings: [],
      }),
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: "No " },
            { type: "text-delta", id: "1", delta: "sign" },
            { type: "text-end", id: "1" },
            { type: "finish", finishReason: finish("length"), usage: usage(11, 2) },
          ],
        }),
      }),
    }),
    middleware: ap.aiSdkMiddleware(),
  });
  const generated = await generateText({ model, system: triage.text, prompt: "hello" });
  assert.equal(generated.text, "Regards, mock");
  const result = streamText({ model, system: triage.text, prompt: "hello" });
  let streamed = "";
  for await (const delta of result.textStream) streamed += delta;
  assert.equal(streamed, "No sign");
  const rows = (await windows()).sort((a, b) => `${a.status}`.localeCompare(`${b.status}`));
  assert.deepEqual(
    rows.map((r) => [r.tag, r.model, r.status, r.errorClass ?? null, r.count, r.tokens, r.checks ?? null]),
    [
      ["support.triage", "mock-gpt", "error", "truncated", 1, { input: 11, output: 2 }, { passed: 0, failed: 1 }],
      ["support.triage", "mock-gpt", "ok", null, 1, { input: 11, output: 3 }, { passed: 1, failed: 0 }],
    ],
  );
});
