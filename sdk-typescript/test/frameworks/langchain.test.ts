/**
 * The LangChain middleware on the real `createAgent`, the real `ChatOpenAI` and a fake `fetch`, so these tests read
 * what a provider would receive and the window row that would upload. Each case is something the proofs found.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ChatAnthropic } from "@langchain/anthropic";
import { AzureChatOpenAI, ChatOpenAI } from "@langchain/openai";
import { Command, MemorySaver, interrupt } from "@langchain/langgraph";
import { HumanMessage, ToolMessage, createAgent, createMiddleware, humanInTheLoopMiddleware, initChatModel, modelFallbackMiddleware, modelRetryMiddleware, tool } from "langchain";
import { z } from "zod";

import { AirPrompterAgent } from "../../packages/sdk/src/agent.js";
import { airprompter } from "../../packages/sdk/src/frameworks/langchain.js";
import { publicJwkOf, releaseDigest } from "../../packages/core/src/protocol/trust.js";
import { FakeControlPlane } from "../../packages/core/src/testing/index.js";

const scope = { organizationId: "org_1", agentId: "agt_lc", target: "prod" as const };
const TAG = "support-reply";
const fixture = JSON.parse(readFileSync(new URL("../../../conformance/frameworks/fixtures/langchain/tool-loop.json", import.meta.url), "utf8"));

type Turn = { content?: string; toolCalls?: string[]; usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens: number } }; finish?: string; fail?: number };
type Request = { url: string; model: string; system: string[]; temperature?: number; top_p?: number; max_tokens?: number; stop?: unknown; messages: Array<{ role: string; content: unknown }> };
type WindowRow = { tag: string; arm: string; versionId: string; count: number; status: string; errorClass: string | null; usageSource: string; tokens: { input: number; output: number; cachedInput?: number } };

const textOf = (content: unknown) => (Array.isArray(content) ? content.map((block: { text: string }) => block.text).join("") : String(content));

/** `initChatModel` takes no caller defaults, so a release on another id reaches the environment's key and global fetch. */
async function withEnvironment<T>(fetch: typeof globalThis.fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = fetch;
  process.env.OPENAI_API_KEY = "test-only";
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
    delete process.env.OPENAI_API_KEY;
  }
}

function provider(turns: Turn[]) {
  const requests: Request[] = [];
  let next = 0;
  const fetch = async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Omit<Request, "url" | "system">;
    requests.push({ ...body, url: String(url), system: body.messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)) });
    const turn = turns[Math.min(next, turns.length - 1)]!;
    next += 1;
    if (turn.fail) return new Response(JSON.stringify({ error: { message: "failed", type: "server" } }), { status: turn.fail, headers: { "content-type": "application/json" } });
    const tool_calls = (turn.toolCalls ?? []).map((name, index) => ({ id: `call_${next}_${index}`, type: "function", function: { name, arguments: "{}" } }));
    return new Response(JSON.stringify({
      id: `chatcmpl-${next}`, object: "chat.completion", created: 1, model: body.model,
      choices: [{ index: 0, finish_reason: turn.finish ?? (tool_calls.length ? "tool_calls" : "stop"), message: { role: "assistant", content: turn.content ?? "", ...(tool_calls.length ? { tool_calls } : {}) } }],
      usage: { ...(turn.usage ?? { prompt_tokens: 3, completion_tokens: 2 }), total_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { requests, fetch: fetch as unknown as typeof globalThis.fetch };
}

const chatModel = (fetch: typeof globalThis.fetch, id = "gpt-5", extra: Record<string, unknown> = {}) => new ChatOpenAI({ model: id, apiKey: "test-only", maxRetries: 0, configuration: { fetch }, ...extra });

async function host(options: { promote?: boolean; model?: string; inference?: Record<string, unknown> } = {}) {
  const plane = new FakeControlPlane(scope);
  const events: Array<Record<string, unknown>> = [];
  const clock = { ms: 1_789_300_800_000 };
  if (options.promote !== false) plane.promote([plane.slot({ tag: TAG, text: "Approved text.", versionId: "ver_a", model: options.model ?? "gpt-5", variables: [], ...(options.inference ? { inference: options.inference } : {}) })]);
  const ap = await AirPrompterAgent.start({
    ...scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir: mkdtempSync(join(tmpdir(), "ap-lc-")), root: { pinned: publicJwkOf(plane.rootKey) },
    sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" }, fetch: plane.fetch(), telemetry: { sink: "memory" }, now: () => clock.ms, logger: (event) => events.push(event),
  });
  const rows = async () => {
    await ap.stop();
    return (ap.drainMemorySink() as WindowRow[]).filter((row) => row.count > 0);
  };
  return { ap, plane, events, clock, rows };
}

const lookup = tool(async () => "found it", { name: "lookup", description: "look it up", schema: z.object({}) });
const ask = (text = "hi") => ({ messages: [new HumanMessage(text)] });

test("the fixture: five model calls and four tools are one run, with the release's text and model on every request", async () => {
  const { ap, plane, rows } = await host({ promote: false });
  const { release } = fixture;
  plane.promote([plane.slot({ tag: release.tag, text: release.text, versionId: release.versionId, model: release.model, variables: [] })]);
  await ap.syncNow();
  const { requests, fetch } = provider(fixture.recorded.turns);
  const agent = createAgent({ model: chatModel(fetch, release.model), tools: [lookup], systemPrompt: "The caller's own prompt.", middleware: [airprompter(ap, { slots: fixture.agent.slots })] });
  const result = await agent.invoke(ask(), { context: { airprompter: fixture.input } } as never);
  assert.equal(requests.length, fixture.expect.calls.count);
  for (const request of requests) {
    assert.deepEqual(request.system, [fixture.expect.calls.system]);
    assert.equal(request.model, fixture.expect.calls.model);
  }
  assert.equal(typeof (result as { airprompter_run_ref?: unknown }).airprompter_run_ref, "string");
  const written = await rows();
  assert.equal(written.length, fixture.expect.rows.length);
  for (const [index, expected] of fixture.expect.rows.entries()) {
    const row = written[index] as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
      if (key === "tokens") assert.deepEqual({ input: (row.tokens as WindowRow["tokens"]).input, output: (row.tokens as WindowRow["tokens"]).output }, value);
      else assert.equal(row[key], value, key);
    }
  }
});

test("a caller's model loses to the release's, and on one provider its key and base URL stay, so a gateway is not bypassed", async () => {
  const { ap, rows } = await host();
  const { requests, fetch } = provider([{ content: "ok" }]);
  await createAgent({ model: chatModel(fetch, "gpt-4-caller", { configuration: { fetch, baseURL: "https://gateway.test/v1" } }), tools: [], middleware: [airprompter(ap, { slots: TAG })] }).invoke(ask());
  assert.deepEqual([requests[0]!.model, requests[0]!.system], ["gpt-5", ["Approved text."]]);
  assert.match(requests[0]!.url, /^https:\/\/gateway\.test\/v1/);
  const stringBuilt = provider([{ content: "ok" }]);
  const model = await initChatModel("openai:gpt-4-caller", { apiKey: "test-only", configuration: { fetch: stringBuilt.fetch, baseURL: "https://gateway.test/v1" } });
  await createAgent({ model, tools: [], middleware: [airprompter(ap, { slots: TAG })] }).invoke(ask());
  assert.deepEqual([stringBuilt.requests[0]!.model, stringBuilt.requests[0]!.url.startsWith("https://gateway.test/v1")], ["gpt-5", true]);
  await rows();
});

test("a release id with a provider prefix reaches the wire without it", async () => {
  const { ap, rows } = await host({ model: "openai:gpt-5-mini" });
  const object = provider([{ content: "ok" }]);
  await createAgent({ model: chatModel(object.fetch, "gpt-4-caller"), tools: [], middleware: [airprompter(ap, { slots: TAG })] }).invoke(ask());
  assert.equal(object.requests[0]!.model, "gpt-5-mini");
  const stringBuilt = provider([{ content: "ok" }]);
  const model = await initChatModel("openai:gpt-4-caller", { apiKey: "test-only", configuration: { fetch: stringBuilt.fetch } });
  await createAgent({ model, tools: [], middleware: [airprompter(ap, { slots: TAG })] }).invoke(ask());
  assert.equal(stringBuilt.requests[0]!.model, "gpt-5-mini");
  await rows();
});

test("an id no provider claims runs on the caller's own model or gateway, and otherwise leaves the request alone", async () => {
  for (const id of ["my-llama-3", "anthropic.claude-haiku-4-5-20251001-v1:0"]) {
    const { ap, rows } = await host({ model: id, inference: { temperatureMilli: 200 } });
    const { requests, fetch } = provider([{ content: "ok" }]);
    await createAgent({ model: chatModel(fetch, id), tools: [], middleware: [airprompter(ap, { slots: TAG })] }).invoke(ask());
    assert.deepEqual([requests[0]!.model, requests[0]!.temperature], [id, 0.2], "the caller already runs this id");
    assert.deepEqual((await rows()).map((row) => row.count), [1]);
  }
  const gateway = await host({ model: "my-llama-3" });
  const routed = provider([{ content: "ok" }]);
  await createAgent({ model: chatModel(routed.fetch, "other", { configuration: { fetch: routed.fetch, baseURL: "https://gateway.test/v1" } }), tools: [], middleware: [airprompter(gateway.ap, { slots: TAG })] }).invoke(ask());
  assert.equal(routed.requests[0]!.model, "my-llama-3");
  await gateway.rows();
  const open = await host({ model: "my-llama-3" });
  const pub = provider([{ content: "ok" }]);
  await createAgent({ model: chatModel(pub.fetch, "gpt-5"), tools: [], systemPrompt: "Own.", middleware: [airprompter(open.ap, { slots: TAG })] }).invoke(ask());
  assert.deepEqual([pub.requests[0]!.model, pub.requests[0]!.system], ["gpt-5", ["Own."]], "the public endpoint has no such model");
  assert.equal(open.events.filter((event) => event.reason === "model_unresolved").length, 1);
  assert.deepEqual(await open.rows(), []);
});

test("an Azure caller never moves to the public endpoint, or runs another id on its deployment", async () => {
  for (const id of ["gpt-5", "my-llama-3", "azure_openai:gpt-5-mini"]) {
    const { ap, events, rows } = await host({ model: id });
    const { requests, fetch } = provider([{ content: "ok" }]);
    const azure = new AzureChatOpenAI({ model: "my-deployment", azureOpenAIApiKey: "test-only", azureOpenAIApiInstanceName: "acme", azureOpenAIApiDeploymentName: "my-deployment", azureOpenAIApiVersion: "2024-10-21", maxRetries: 0, configuration: { fetch } });
    await withEnvironment(fetch, () => createAgent({ model: azure, tools: [], systemPrompt: "Own.", middleware: [airprompter(ap, { slots: TAG })] }).invoke(ask()));
    assert.deepEqual(requests[0]!.system, ["Own."], id);
    assert.match(requests[0]!.url, /acme\.openai\.azure\.com/);
    assert.equal(events.filter((event) => event.reason === "model_unresolved").length, 1);
    assert.deepEqual(await rows(), []);
  }
});

test("an Anthropic model keeps its own key with none in the environment, and its stop_reason counts", async () => {
  const { ap, rows } = await host({ model: "claude-sonnet-5" });
  const seen: Array<string | null> = [];
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("x-api-key"));
    return new Response(JSON.stringify({ id: `m${seen.length}`, type: "message", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "cut" }], stop_reason: "max_tokens", usage: { input_tokens: 4, output_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  const model = new ChatAnthropic({ model: "claude-haiku-caller", apiKey: "caller-key", maxRetries: 0, clientOptions: { fetch } });
  await createAgent({ model, tools: [], middleware: [airprompter(ap, { slots: TAG })] }).invoke(ask());
  assert.deepEqual(seen, ["caller-key"]);
  assert.deepEqual((await rows()).map((row) => [row.status, row.errorClass]), [["error", "truncated"]]);
});

test("a built model is cached per placement: new sealed settings reach the wire", async () => {
  const { ap, plane, rows } = await host({ inference: { temperatureMilli: 200 } });
  const { requests, fetch } = provider([{ content: "ok" }]);
  const agent = createAgent({ model: chatModel(fetch), tools: [], middleware: [airprompter(ap, { slots: TAG })] });
  await agent.invoke(ask());
  plane.promote([plane.slot({ tag: TAG, text: "Approved text.", versionId: "ver_b", model: "gpt-5", variables: [], inference: { temperatureMilli: 700 } })]);
  await ap.syncNow();
  await agent.invoke(ask());
  assert.deepEqual(requests.map((request) => request.temperature), [0.2, 0.7]);
  await rows();
});

test("bad tool arguments keep LangChain's own message, not wrapped twice", async () => {
  const strict = tool(async () => "ok", { name: "lookup", description: "look it up", schema: z.object({ order: z.string() }) });
  const message = async (middleware: unknown[]) => {
    const { fetch } = provider([{ toolCalls: ["lookup"] }, { content: "sorry" }]);
    const result = await createAgent({ model: chatModel(fetch), tools: [strict], middleware: middleware as never }).invoke(ask() as never);
    return (result as { messages: unknown[] }).messages.find((m) => ToolMessage.isInstance(m)) as ToolMessage;
  };
  const { ap, rows } = await host();
  const ours = String((await message([airprompter(ap, { slots: TAG })])).content);
  const theirs = String((await message([])).content);
  assert.equal(ours.split("\n")[0], theirs.split("\n")[0]);
  assert.match(ours, / Please fix the error and try again\.$/);
  assert.doesNotMatch(ours, /Please fix your mistakes/, "not wrapped a second time");
  await rows();
});

test("an interrupt on the model path is not a failed call", async () => {
  const { ap, rows } = await host();
  const { fetch } = provider([{ content: "ok", usage: { prompt_tokens: 5, completion_tokens: 1 } }]);
  const ask_first = createMiddleware({ name: "AskFirst", wrapModelCall: async (request, handler) => {
    interrupt("approve this call?");
    return handler(request);
  } });
  const agent = createAgent({ model: chatModel(fetch), tools: [], checkpointer: new MemorySaver(), middleware: [airprompter(ap, { slots: TAG }), ask_first] });
  const config = { configurable: { thread_id: "t-model" } };
  await agent.invoke(ask() as never, config as never);
  await agent.invoke(new Command({ resume: "yes" }) as never, config as never);
  assert.deepEqual((await rows()).map((row) => [row.count, row.status, row.usageSource, row.tokens.input]), [[1, "ok", "reported", 5]], "an interrupt recorded as a failed call would leave the usage unavailable");
});

test("a truncated reply counts as an error on the run", async () => {
  const { ap, rows } = await host();
  const { fetch } = provider([{ content: "cut off", finish: "length" }]);
  await createAgent({ model: chatModel(fetch), tools: [], middleware: [airprompter(ap, { slots: TAG })] }).invoke(ask());
  assert.deepEqual((await rows()).map((row) => [row.count, row.status, row.errorClass]), [[1, "error", "truncated"]]);
});

test("with responseFormat the handler's messages hold the usage", async () => {
  const { ap, rows } = await host();
  const { fetch } = provider([{ content: "{\"answer\":\"yes\"}", usage: { prompt_tokens: 7, completion_tokens: 3 } }]);
  const result = await createAgent({ model: chatModel(fetch), tools: [], responseFormat: z.object({ answer: z.string() }), middleware: [airprompter(ap, { slots: TAG })] } as never).invoke(ask() as never);
  assert.deepEqual((result as { structuredResponse?: unknown }).structuredResponse, { answer: "yes" });
  assert.deepEqual((await rows()).map((row) => [row.count, row.tokens.input, row.tokens.output]), [[1, 7, 3]]);
});

test("a bad context never fails the customer's request: a subject that is not a string is dropped", async () => {
  const { ap, rows } = await host();
  const { requests, fetch } = provider([{ content: "ok" }]);
  const agent = createAgent({ model: chatModel(fetch), tools: [], middleware: [airprompter(ap, { slots: TAG })] });
  await agent.invoke(ask() as never, { context: { airprompter: { subject: 12345, tags: { "bad key!": "x" }, variables: { name: { nested: true } } } } } as never);
  assert.deepEqual(requests[0]!.system, ["Approved text."]);
  assert.deepEqual((await rows()).map((row) => row.count), [1]);
});

test("a slot name the release could never hold is a passthrough, not a failed request", async () => {
  const { ap, rows } = await host();
  const { requests, fetch } = provider([{ content: "ok" }]);
  await createAgent({ model: chatModel(fetch), tools: [], systemPrompt: "Own.", middleware: [airprompter(ap, { slots: "Support-Reply" })] }).invoke(ask());
  assert.deepEqual(requests[0]!.system, ["Own."]);
  assert.deepEqual(await rows(), []);
});

test("inside ap.run the middleware joins that run: two agents in one request are one count, ended by ap.run", async () => {
  const { ap, rows } = await host();
  const { fetch } = provider([{ content: "one", usage: { prompt_tokens: 10, completion_tokens: 1 } }, { content: "two", usage: { prompt_tokens: 20, completion_tokens: 2 } }]);
  const agent = createAgent({ model: chatModel(fetch), tools: [], middleware: [airprompter(ap, { slots: TAG })] });
  await ap.run({ subject: "ann" }, async () => {
    await agent.invoke(ask());
    await agent.invoke(ask());
  });
  assert.deepEqual((await rows()).map((row) => [row.count, row.tokens.input]), [[1, 30]]);
});

test("stream runs the same path: one run, tokens as invoke", async () => {
  const { ap, rows } = await host();
  const { fetch } = provider(fixture.recorded.turns);
  const agent = createAgent({ model: chatModel(fetch), tools: [lookup], middleware: [airprompter(ap, { slots: TAG })] });
  for await (const _chunk of await agent.stream(ask(), { streamMode: "values" } as never)) void _chunk;
  assert.deepEqual((await rows()).map((row) => [row.count, row.tokens.input, row.tokens.output]), [[1, 600, 60]]);
});

test("cached tokens stay inside input_tokens: the row splits them", async () => {
  const { ap, rows } = await host();
  const { fetch } = provider([{ content: "ok", usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } } }]);
  await createAgent({ model: chatModel(fetch), tools: [], middleware: [airprompter(ap, { slots: TAG })] }).invoke(ask());
  assert.deepEqual((await rows()).map((row) => [row.tokens.input, row.tokens.cachedInput]), [[60, 40]]);
});

test("context reaches the subject, and thread_id stands in for it", async () => {
  const { ap, plane, rows } = await host({ promote: false });
  const a = plane.slot({ tag: TAG, text: "Version A", versionId: "ver_a", model: "gpt-5", variables: [] });
  const b = plane.slot({ tag: TAG, text: "Version B", versionId: "ver_b", model: "gpt-5", variables: [] });
  plane.promote([a], { experiments: [{ experimentId: "exp_1", tag: TAG, salt: "AAECAwQFBgcICQoLDA0ODw", subjectKey: "request", arms: [
    { arm: "control", weightBps: 5000, releaseDigest: releaseDigest([a]), overrides: [] },
    { arm: "candidate", weightBps: 5000, releaseDigest: releaseDigest([b]), overrides: [b] },
  ] }] });
  await ap.syncNow();
  const { requests, fetch } = provider([{ content: "ok" }]);
  const agent = createAgent({ model: chatModel(fetch), tools: [], checkpointer: new MemorySaver(), middleware: [airprompter(ap, { slots: TAG })] });
  const textFor = async (config: Record<string, unknown>) => {
    await agent.invoke(ask() as never, config as never);
    return requests.at(-1)!.system[0];
  };
  const seen = new Set<string | undefined>();
  for (let i = 0; i < 16; i += 1) {
    const bySubject = await textFor({ context: { airprompter: { subject: `user-${i}` } }, configurable: { thread_id: `s-${i}` } });
    assert.equal(await textFor({ context: { airprompter: { subject: `user-${i}` } }, configurable: { thread_id: `s2-${i}` } }), bySubject, "one subject, one arm");
    assert.equal(await textFor({ configurable: { thread_id: `user-${i}` } }), bySubject, "the thread id hashes like a subject");
    seen.add(bySubject);
  }
  assert.equal(seen.size, 2, "subjects split between both arms");
  await rows();
});

test("a custom input function reads the caller's own context", async () => {
  const { ap, plane, rows } = await host({ promote: false });
  plane.promote([plane.slot({ tag: TAG, text: "Hello {{name}}", versionId: "ver_a", model: "gpt-5", variables: [{ name: "name", required: true, trust: "operator" }] })]);
  await ap.syncNow();
  const { requests, fetch } = provider([{ content: "ok" }]);
  const middleware = airprompter(ap, { slots: TAG, contextSchema: z.object({ userName: z.string() }), input: (context) => ({ variables: { name: (context as { userName: string }).userName } }) });
  await createAgent({ model: chatModel(fetch), tools: [], middleware: [middleware] }).invoke(ask() as never, { context: { userName: "Ann" } } as never);
  assert.deepEqual(requests[0]!.system, ["Hello Ann"]);
  await rows();
});

test("a thrown model error: the graph rejects, afterAgent does not fire, and the sweep writes it", async () => {
  const { ap, clock, rows } = await host();
  const { fetch } = provider([{ fail: 400 }]);
  await assert.rejects(createAgent({ model: chatModel(fetch), tools: [], middleware: [airprompter(ap, { slots: TAG })] }).invoke(ask()));
  clock.ms += 15 * 60_000;
  ap.openRun();
  assert.deepEqual((await rows()).map((row) => [row.count, row.status, row.errorClass]), [[1, "error", "provider_error"]]);
});

test("a retry middleware outside it: a failed call then a good one is one run, status ok, and an outer wrapper does not hide the status", async () => {
  const { ap, rows } = await host();
  const { requests, fetch } = provider([{ fail: 429 }, { content: "ok", usage: { prompt_tokens: 10, completion_tokens: 1 } }]);
  const agent = createAgent({ model: chatModel(fetch), tools: [], middleware: [modelRetryMiddleware({ maxRetries: 2, initialDelayMs: 1, backoffFactor: 1 }) as never, airprompter(ap, { slots: TAG })] });
  await agent.invoke(ask() as never);
  assert.equal(requests.length, 2);
  assert.deepEqual((await rows()).map((row) => [row.count, row.status, row.tokens.input]), [[1, "ok", 10]]);
});

test("a thrown tool keeps today's recoverable text, with the exact message", async () => {
  const { ap, rows } = await host();
  const broken = tool(async () => { throw new Error("no such ticket"); }, { name: "lookup", description: "look it up", schema: z.object({}) });
  const { fetch } = provider([{ toolCalls: ["lookup"] }, { content: "sorry" }]);
  const agent = createAgent({ model: chatModel(fetch), tools: [broken], middleware: [airprompter(ap, { slots: TAG })] });
  const plain = createAgent({ model: chatModel(provider([{ toolCalls: ["lookup"] }, { content: "sorry" }]).fetch), tools: [broken] });
  const message = (result: { messages: unknown[] }) => result.messages.find((m) => ToolMessage.isInstance(m)) as ToolMessage;
  const ours = message(await agent.invoke(ask()) as never);
  const theirs = message(await plain.invoke(ask()) as never);
  assert.equal(ours.content, theirs.content);
  assert.equal(ours.status, "error");
  assert.match(String(ours.content), /no such ticket\n Please fix your mistakes\.$/);
  assert.deepEqual((await rows()).map((row) => [row.count, row.status]), [[1, "ok"]]);
});

test("a nested agent joins the run: its calls add to the parent's one count, and it does not end the parent", async () => {
  const { ap, rows } = await host();
  const { requests, fetch } = provider([{ toolCalls: ["ask_helper"], usage: { prompt_tokens: 10, completion_tokens: 1 } }, { content: "inner", usage: { prompt_tokens: 20, completion_tokens: 2 } }, { content: "outer", usage: { prompt_tokens: 30, completion_tokens: 3 } }]);
  const inner = createAgent({ model: chatModel(fetch), tools: [], middleware: [airprompter(ap, { slots: TAG })] });
  const askHelper = tool(async () => {
    const reply = await inner.invoke(ask("nested"));
    return String(reply.messages.at(-1)?.content);
  }, { name: "ask_helper", description: "ask", schema: z.object({}) });
  await createAgent({ model: chatModel(fetch), tools: [askHelper], middleware: [airprompter(ap, { slots: TAG })] }).invoke(ask());
  assert.equal(requests.length, 3);
  assert.deepEqual((await rows()).map((row) => [row.count, row.tokens.input, row.tokens.output]), [[1, 60, 6]]);
});

test("an interrupt then a resume in the same process is one run", async () => {
  const { ap, rows } = await host();
  const { requests, fetch } = provider([{ toolCalls: ["lookup"], usage: { prompt_tokens: 10, completion_tokens: 1 } }, { content: "done", usage: { prompt_tokens: 20, completion_tokens: 2 } }]);
  const agent = createAgent({ model: chatModel(fetch), tools: [lookup], checkpointer: new MemorySaver(), middleware: [humanInTheLoopMiddleware({ interruptOn: { lookup: true } } as never) as never, airprompter(ap, { slots: TAG })] });
  const config = { configurable: { thread_id: "t1" } };
  await agent.invoke(ask() as never, config as never);
  assert.equal(requests.length, 1);
  await agent.invoke(new Command({ resume: { decisions: [{ type: "approve" }] } }) as never, config as never);
  assert.equal(requests.length, 2);
  assert.deepEqual((await rows()).map((row) => [row.count, row.tokens.input]), [[1, 30]]);
});

test("a resume after a sweep, with the same context, is a new run on the same subject: it keeps its arm and counts again", async () => {
  const { ap, plane, clock, rows } = await host({ promote: false });
  const a = plane.slot({ tag: TAG, text: "Version A", versionId: "ver_a", model: "gpt-5", variables: [] });
  const b = plane.slot({ tag: TAG, text: "Version B", versionId: "ver_b", model: "gpt-5", variables: [] });
  plane.promote([a], { experiments: [{ experimentId: "exp_1", tag: TAG, salt: "AAECAwQFBgcICQoLDA0ODw", subjectKey: "request", arms: [
    { arm: "control", weightBps: 5000, releaseDigest: releaseDigest([a]), overrides: [] },
    { arm: "candidate", weightBps: 5000, releaseDigest: releaseDigest([b]), overrides: [b] },
  ] }] });
  await ap.syncNow();
  for (let i = 0; i < 8; i += 1) {
    const { requests, fetch } = provider([{ toolCalls: ["lookup"] }, { content: "done" }]);
    const agent = createAgent({ model: chatModel(fetch), tools: [lookup], checkpointer: new MemorySaver(), middleware: [humanInTheLoopMiddleware({ interruptOn: { lookup: true } } as never) as never, airprompter(ap, { slots: TAG })] });
    const config = { configurable: { thread_id: `t-${i}` }, context: { airprompter: { subject: `ann-${i}` } } };
    await agent.invoke(ask() as never, config as never);
    clock.ms += 15 * 60_000;
    await agent.invoke(new Command({ resume: { decisions: [{ type: "approve" }] } }) as never, config as never);
    assert.deepEqual(requests[1]!.system, requests[0]!.system, "the same subject keeps the arm");
  }
  assert.equal((await rows()).reduce((sum, row) => sum + row.count, 0), 16, "each counts twice");
});

test("a string-built model takes the sealed settings: the constructor's temperature does not win", async () => {
  const { ap, rows } = await host({ model: "gpt-4o", inference: { temperatureMilli: 200, maxOutputTokens: 100 } });
  const { requests, fetch } = provider([{ content: "ok" }]);
  const model = await initChatModel("openai:gpt-4o", { temperature: 0.9, apiKey: "test-only", configuration: { fetch } });
  await createAgent({ model, tools: [], middleware: [airprompter(ap, { slots: TAG })] }).invoke(ask());
  assert.deepEqual([requests[0]!.model, requests[0]!.temperature, requests[0]!.max_tokens ?? (requests[0] as unknown as { max_completion_tokens?: number }).max_completion_tokens], ["gpt-4o", 0.2, 100]);
  await rows();
});

test("a model object takes the sealed settings and keeps the caller's key and fetch", async () => {
  const { ap, rows } = await host({ inference: { temperatureMilli: 300, topPBps: 5000, stopSequences: ["END"] } });
  const { requests, fetch } = provider([{ content: "ok" }]);
  await createAgent({ model: chatModel(fetch, "gpt-5", { temperature: 0.9 }), tools: [], middleware: [airprompter(ap, { slots: TAG })] }).invoke(ask());
  assert.deepEqual([requests[0]!.temperature, requests[0]!.top_p, requests[0]!.stop], [0.3, 0.5, ["END"]]);
  await rows();
});

test("a release on another provider leaves the caller's provider behind", async () => {
  const { ap, rows } = await host({ model: "claude-sonnet-5" });
  const { requests, fetch } = provider([{ content: "ok" }]);
  const anthropic: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    anthropic.push(`${String(url)} ${(JSON.parse(String(init?.body)) as { model: string }).model}`);
    return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "test-only";
  try {
    const model = await initChatModel("openai:gpt-4o", { apiKey: "test-only", configuration: { fetch } });
    await createAgent({ model, tools: [], middleware: [airprompter(ap, { slots: TAG })] }).invoke(ask());
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.ANTHROPIC_API_KEY;
  }
  assert.equal(requests.length, 0, "nothing went to the OpenAI path");
  assert.match(anthropic[0]!, /anthropic\.com.* claude-sonnet-5$/);
  assert.deepEqual((await rows()).map((row) => [row.count, row.tokens.input]), [[1, 4]]);
});

test("a model that cannot be built leaves the request untouched, writes nothing and says so once", async () => {
  const { ap, events, rows } = await host({ model: "gemini-pro" });
  const { requests, fetch } = provider([{ content: "ok" }]);
  const agent = createAgent({ model: chatModel(fetch, "gpt-5"), tools: [], systemPrompt: "The caller's own prompt.", middleware: [airprompter(ap, { slots: TAG })] });
  await agent.invoke(ask());
  await agent.invoke(ask());
  assert.deepEqual(requests.map((request) => [request.model, request.system]), [["gpt-5", ["The caller's own prompt."]], ["gpt-5", ["The caller's own prompt."]]]);
  assert.equal(events.filter((event) => event.reason === "model_unresolved").length, 1);
  assert.deepEqual(await rows(), []);
});

test("nothing promoted: the framework's own prompt and model run, untouched, and nothing is written", async () => {
  const { ap, plane, rows } = await host({ promote: false });
  const { requests, fetch } = provider([{ content: "ok" }]);
  const agent = createAgent({ model: chatModel(fetch, "gpt-4-caller"), tools: [], systemPrompt: "The caller's own prompt.", middleware: [airprompter(ap, { slots: TAG })] });
  await agent.invoke(ask());
  assert.deepEqual([requests[0]!.model, requests[0]!.system], ["gpt-4-caller", ["The caller's own prompt."]]);
  plane.promote([plane.slot({ tag: TAG, text: "Approved text.", versionId: "ver_a", model: "gpt-4-caller", variables: [] })]);
  await ap.syncNow();
  await agent.invoke(ask());
  assert.deepEqual(requests[1]!.system, ["Approved text."], "a promotion lands with no restart");
  assert.deepEqual((await rows()).map((row) => row.count), [1]);
});

test("airprompter last: a fallback model cannot run the approved text. Listed first, it can, which is why the order is documented", async () => {
  const run = async (order: "last" | "first") => {
    const { ap, rows } = await host();
    const seen: Array<[string, string[]]> = [];
    const { requests, fetch } = provider([{ fail: 500 }, { content: "ok" }]);
    const mine = airprompter(ap, { slots: TAG });
    const fallback = modelFallbackMiddleware(chatModel(fetch, "gpt-fallback"));
    await withEnvironment(fetch, () => createAgent({ model: chatModel(fetch, "gpt-5"), tools: [], middleware: order === "last" ? [fallback, mine] : [mine, fallback] }).invoke(ask()));
    for (const request of requests) seen.push([request.model, request.system]);
    await rows();
    return seen;
  };
  assert.deepEqual(await run("last"), [["gpt-5", ["Approved text."]], ["gpt-5", ["Approved text."]]]);
  assert.deepEqual((await run("first")).at(-1), ["gpt-fallback", ["Approved text."]]);
});

test("no prompt text enters graph state", async () => {
  const { ap, rows } = await host();
  const { fetch } = provider([{ content: "ok" }]);
  const result = await createAgent({ model: chatModel(fetch), tools: [], middleware: [airprompter(ap, { slots: TAG })] }).invoke(ask());
  assert.equal(JSON.stringify(result).includes("Approved text."), false);
  await rows();
});

test("a caller's own middleware keeps working beside it", async () => {
  const { ap, rows } = await host();
  const { fetch } = provider([{ content: "ok" }]);
  let calls = 0;
  const mine = createMiddleware({ name: "Counter", wrapModelCall: async (request, handler) => { calls += 1; return handler(request); } });
  await createAgent({ model: chatModel(fetch), tools: [], middleware: [mine, airprompter(ap, { slots: TAG })] }).invoke(ask());
  assert.equal(calls, 1);
  await rows();
});
