/**
 * T33 (AIR-1963, D65): `ap.wrap()` over clients shaped like the OpenAI and
 * Anthropic SDKs (recorded responses, streams, the `.stream()` helpers,
 * `withResponse()`), attribution by rendered text and by scope, the
 * declared checks running on what the wrapper saw, error classes, the AI SDK
 * middleware, and the rule that nothing the wrapper does can fail the
 * customer's call.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent } from "../packages/sdk/src/agent.js";
import { publicJwkOf } from "../packages/core/src/protocol/trust.js";
import type { WindowRow } from "../packages/telemetry/src/spool/writer.js";
import { RenderRegistry, requestTexts } from "../packages/runtime/src/wrap/attribution.js";
import { wrapClient } from "../packages/runtime/src/wrap/client.js";
import { aiSdkMiddleware } from "../packages/runtime/src/wrap/aiSdk.js";
import { FakeControlPlane } from "./helpers/controlPlane.js";

const scope = { organizationId: "org_1", agentId: "agt_1", target: "prod" as const };
const tempDir = () => mkdtempSync(join(tmpdir(), "ap-wrap-"));

async function startAgent(events: Record<string, unknown>[] = []) {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  plane.promote([
    {
      ...plane.slot({ tag: "support.triage", text: "Triage for {{team}}.", variables: [{ name: "team", required: true, trust: "operator" }], model: "gpt-5" }),
      outputChecks: [{ kind: "must_not_match" as const, name: "no-guarantee", pattern: "refund guaranteed", flags: "i" as const }],
    },
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
    logger: (event) => events.push(event),
  });
  const windows = async () => {
    await ap.stop();
    return ap.drainMemorySink().filter((r) => (r as { type: string }).type === "window") as WindowRow[];
  };
  return { ap, windows, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

// --- clients shaped like the real ones ---------------------------------------------------------------------------

/** An `APIPromise`: a promise with `withResponse()` (and a private field, to prove the proxy never stands in for `this`). */
class ApiPromise<T> extends Promise<T> {
  #response = { status: 200 };
  withResponse(): Promise<{ data: T; response: { status: number } }> {
    return this.then((data) => ({ data, response: this.#response }));
  }
  static override get [Symbol.species]() {
    return Promise;
  }
}

/** An OpenAI `Stream`: async iterable with `tee()` and a controller. */
function stream<T>(chunks: T[]) {
  return {
    controller: new AbortController(),
    tee() {
      return [stream(chunks), stream(chunks)];
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

const usage = { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } };
const chatCompletion = (content: string, finish = "stop") => ({ id: "chatcmpl_1", choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content } }], usage });
const chatChunks = (content: string, finish = "stop") => [
  { id: "chatcmpl_2", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
  ...content.split(" ").map((word, i) => ({ id: "chatcmpl_2", choices: [{ index: 0, delta: { content: (i ? " " : "") + word }, finish_reason: null }] })),
  { id: "chatcmpl_2", choices: [{ index: 0, delta: {}, finish_reason: finish }] },
  { id: "chatcmpl_2", choices: [], usage },
];

class FakeOpenAI {
  #calls = 0;
  readonly calls: unknown[] = [];
  fail: { status?: number; sync?: boolean } | null = null;
  readonly chat = {
    completions: {
      create: (params: Record<string, unknown>): unknown => {
        this.#calls += 1;
        this.calls.push(params);
        if (this.fail?.sync) throw Object.assign(new Error("bad request"), { status: 400 });
        if (this.fail) return new ApiPromise<never>((_, reject) => reject(Object.assign(new Error("rate limited"), { status: this.fail!.status })));
        const content = params.messages && Array.isArray(params.messages) ? `answer ${this.#calls}` : "answer";
        if (params.stream) return new ApiPromise((resolve) => resolve(stream(chatChunks(`streamed ${content} refund guaranteed`, "length"))));
        return new ApiPromise((resolve) => resolve(chatCompletion(`${content} refund guaranteed`)));
      },
      stream: (params: Record<string, unknown>) => {
        this.calls.push(params);
        const chunks = chatChunks("helper answer");
        return {
          async finalChatCompletion() {
            return chatCompletion("helper answer");
          },
          async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) yield chunk;
          },
        };
      },
    },
  };
  readonly responses = {
    create: (params: Record<string, unknown>): unknown => {
      this.calls.push(params);
      const response = {
        id: "resp_1",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "responses answer" }] }],
        usage: { input_tokens: 50, output_tokens: 10, input_tokens_details: { cached_tokens: 5 } },
      };
      if (params.stream) {
        return new ApiPromise((resolve) =>
          resolve(
            stream([
              { type: "response.created", response: { id: "resp_1" } },
              { type: "response.output_text.delta", delta: "responses " },
              { type: "response.output_text.delta", delta: "answer" },
              { type: "response.incomplete", response },
            ]),
          ),
        );
      }
      return new ApiPromise((resolve) => resolve({ ...response, output_text: "responses answer" }));
    },
  };
  countCalls() {
    return this.#calls;
  }
}

const anthropicMessage = (text: string, stop = "end_turn") => ({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: stop, usage: { input_tokens: 40, output_tokens: 12, cache_read_input_tokens: 8 } });
const anthropicEvents = (text: string, stop = "end_turn") => [
  { type: "message_start", message: { id: "msg_2", role: "assistant", content: [], usage: { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 8 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  ...text.split(" ").map((word, i) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: (i ? " " : "") + word } })),
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 12 } },
  { type: "message_stop" },
];

class FakeAnthropic {
  readonly calls: unknown[] = [];
  readonly messages = {
    create: (params: Record<string, unknown>): unknown => {
      this.calls.push(params);
      if (params.stream) return new ApiPromise((resolve) => resolve(stream(anthropicEvents("streamed reply", "max_tokens"))));
      return new ApiPromise((resolve) => resolve(anthropicMessage("plain reply")));
    },
    stream: (params: Record<string, unknown>) => {
      this.calls.push(params);
      const events = anthropicEvents("helper reply");
      return {
        on() {
          return this;
        },
        async finalMessage() {
          return anthropicMessage("helper reply");
        },
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event;
        },
      };
    },
  };
}

const byKey = (rows: WindowRow[]) => [...rows].sort((a, b) => `${a.tag}${a.model}${a.status}${a.errorClass}`.localeCompare(`${b.tag}${b.model}${b.status}${b.errorClass}`));

// ---------------------------------------------------------------------------------------------------------------------

test("OpenAI chat: attributed by the rendered system text, returned unchanged, usage split and checks counted; withResponse() and instanceof still work", async () => {
  const events: Record<string, unknown>[] = [];
  const { ap, windows, cleanup } = await startAgent(events);
  const client = new FakeOpenAI();
  const openai = ap.wrap(client);
  assert.ok(openai instanceof FakeOpenAI);
  assert.equal(ap.wrap(openai), openai, "wrapping twice is once");
  const rendered = ap.prompt("support.triage").render({ team: "Billing" });
  const completion = (await openai.chat.completions.create({ model: "gpt-5-mini", messages: [{ role: "system", content: rendered.text }, { role: "user", content: "hi" }] })) as ReturnType<typeof chatCompletion>;
  assert.equal(completion.choices[0]!.message.content, "answer 1 refund guaranteed");
  const { data, response } = await (openai.chat.completions.create({ model: "gpt-5-mini", messages: [{ role: "system", content: [{ type: "text", text: rendered.text }] }] }) as ApiPromise<unknown>).withResponse();
  assert.equal(response.status, 200);
  assert.equal((data as ReturnType<typeof chatCompletion>).choices[0]!.message.content, "answer 2 refund guaranteed");
  assert.equal(client.countCalls(), 2, "the private field saw both calls through the real receiver");
  const rows = await windows();
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.tag, "support.triage");
  assert.equal(row.model, "gpt-5-mini", "the request's model names the window, not the slot's");
  assert.equal(row.count, 2);
  assert.deepEqual(row.tokens, { input: 200, cachedInput: 40, output: 60 });
  assert.deepEqual(row.checks, { passed: 0, failed: 2 }, "the must-not-match check ran on the answer the wrapper saw");
  assert.equal(events.some((e) => e.event === "wrap_unattributed"), false);
  assert.equal(JSON.stringify(rows).includes("guaranteed"), false, "no output text on the wire");
  cleanup();
});

test("OpenAI chat with stream: true — chunks pass through, usage from the last chunk, a length finish is truncated, the text is checked; tee() is still there", async () => {
  const { ap, windows, cleanup } = await startAgent();
  const openai = ap.wrap(new FakeOpenAI());
  const rendered = ap.prompt("support.triage").render({ team: "Billing" });
  const s = (await openai.chat.completions.create({ model: "gpt-5", stream: true, messages: [{ role: "system", content: rendered.text }] })) as AsyncIterable<{ choices: Array<{ delta: { content?: string } }> }> & { tee: () => unknown[] };
  assert.equal(typeof s.tee, "function");
  let text = "";
  for await (const chunk of s) text += chunk.choices[0]?.delta?.content ?? "";
  assert.equal(text, "streamed answer 1 refund guaranteed");
  const rows = await windows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "error");
  assert.equal(rows[0]!.errorClass, "truncated");
  assert.deepEqual(rows[0]!.tokens, { input: 100, cachedInput: 20, output: 30 });
  assert.deepEqual(rows[0]!.checks, { passed: 0, failed: 1 });
  cleanup();
});

test("the .stream() helpers report through finalChatCompletion() / finalMessage(); the Responses API reads instructions, incomplete status and cached input", async () => {
  const { ap, windows, cleanup } = await startAgent();
  const openai = ap.wrap(new FakeOpenAI());
  const anthropic = ap.wrap(new FakeAnthropic());
  const triage = ap.prompt("support.triage").render({ team: "Billing" });
  const reply = ap.prompt("support.reply").render({});
  const helper = openai.chat.completions.stream({ model: "gpt-5", messages: [{ role: "system", content: triage.text }] });
  const seen: unknown[] = [];
  for await (const chunk of helper) seen.push(chunk);
  assert.equal(seen.length, 5);
  const ms = anthropic.messages.stream({ model: "claude-haiku-4-5", max_tokens: 100, system: reply.text, messages: [{ role: "user", content: "hi" }] });
  const final = await ms.finalMessage();
  assert.equal(final.content[0]!.text, "helper reply");
  const responses = (await openai.responses.create({ model: "gpt-5", instructions: triage.text, input: "hi" })) as { output_text: string };
  assert.equal(responses.output_text, "responses answer");
  const rs = (await openai.responses.create({ model: "gpt-5", stream: true, instructions: triage.text, input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] })) as AsyncIterable<unknown>;
  let events = 0;
  for await (const _ of rs) events += 1;
  assert.equal(events, 4);
  const rows = byKey(await windows());
  assert.deepEqual(
    rows.map((r) => [r.tag, r.model, r.status, r.errorClass ?? null, r.count, r.tokens.input, r.tokens.cachedInput ?? 0, r.tokens.output]),
    [
      ["support.reply", "claude-haiku-4-5", "ok", null, 1, 40, 8, 12],
      ["support.triage", "gpt-5", "error", "truncated", 2, 90, 10, 20],
      ["support.triage", "gpt-5", "ok", null, 1, 100, 20, 30],
    ],
  );
  assert.deepEqual(rows[1]!.checks, { passed: 2, failed: 0 }, "the Responses output text (plain and streamed) was checked");
  cleanup();
});

test("Anthropic messages.create: plain and streamed events; the stream's usage comes from message_start and message_delta", async () => {
  const { ap, windows, cleanup } = await startAgent();
  const anthropic = ap.wrap(new FakeAnthropic());
  const reply = ap.prompt("support.reply").render({});
  const plain = (await anthropic.messages.create({ model: "claude-haiku-4-5", max_tokens: 100, system: [{ type: "text", text: reply.text }], messages: [{ role: "user", content: "hi" }] })) as ReturnType<typeof anthropicMessage>;
  assert.equal(plain.content[0]!.text, "plain reply");
  const s = (await anthropic.messages.create({ model: "claude-haiku-4-5", max_tokens: 100, stream: true, system: reply.text, messages: [{ role: "user", content: "hi" }] })) as AsyncIterable<{ type: string }>;
  const types: string[] = [];
  for await (const event of s) types.push(event.type);
  assert.equal(types[0], "message_start");
  assert.equal(types.at(-1), "message_stop");
  const rows = byKey(await windows());
  assert.deepEqual(
    rows.map((r) => [r.status, r.errorClass ?? null, r.count, r.tokens]),
    [
      ["error", "truncated", 1, { input: 40, cachedInput: 8, output: 12 }],
      ["ok", null, 1, { input: 40, cachedInput: 8, output: 12 }],
    ],
  );
  cleanup();
});

test("a call that names no render passes through untouched and is logged, never guessed; attribute() scopes a call whose text is elsewhere and beats the text match", async () => {
  const events: Record<string, unknown>[] = [];
  const { ap, windows, cleanup } = await startAgent(events);
  const client = new FakeOpenAI();
  const openai = ap.wrap(client);
  const triage = ap.prompt("support.triage").render({ team: "Billing" });
  const reply = ap.prompt("support.reply").render({});
  await openai.chat.completions.create({ model: "gpt-5", messages: [{ role: "user", content: "no prompt of ours here" }] });
  assert.equal(events.filter((e) => e.event === "wrap_unattributed").length, 1);
  assert.equal(client.calls.length, 1);
  // The rendered text is embedded in a larger message: the scope names the slot.
  await ap.attribute(reply, async () => {
    await Promise.resolve();
    await openai.chat.completions.create({ model: "gpt-5", messages: [{ role: "user", content: `${reply.text}\n\nToday is Friday.` }] });
    // Even a message that IS a triage render is the reply's inside the scope.
    await openai.chat.completions.create({ model: "gpt-5", messages: [{ role: "system", content: triage.text }] });
  });
  const rows = await windows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.tag, "support.reply");
  assert.equal(rows[0]!.count, 2);
  cleanup();
});

test("a failing call is classified and the customer sees the same error; a synchronous throw is counted too", async () => {
  const { ap, windows, cleanup } = await startAgent();
  const client = new FakeOpenAI();
  const openai = ap.wrap(client);
  const triage = ap.prompt("support.triage").render({ team: "Billing" });
  client.fail = { status: 429 };
  await assert.rejects(openai.chat.completions.create({ model: "gpt-5", messages: [{ role: "system", content: triage.text }] }) as Promise<unknown>, /rate limited/);
  client.fail = { sync: true };
  assert.throws(() => openai.chat.completions.create({ model: "gpt-5", messages: [{ role: "system", content: triage.text }] }), /bad request/);
  await new Promise((r) => setImmediate(r)); // the observation of a synchronous throw lands a microtask later
  const rows = byKey(await windows());
  assert.deepEqual(
    rows.map((r) => [r.status, r.errorClass, r.count, r.usageSource]),
    [
      ["error", "provider_error", 1, "unavailable"],
      ["error", "provider_rate_limited", 1, "unavailable"],
    ],
  );
  cleanup();
});

test("nothing the wrapper does fails the call: a broken attribution hook, an odd stream, a consumer that stops early", async () => {
  const log: Record<string, unknown>[] = [];
  const recorded: unknown[] = [];
  const client = new FakeOpenAI();
  const broken = wrapClient(client, {
    attribute: () => {
      throw new Error("registry exploded");
    },
    observe: async (_target, call) => call(),
    log: (event) => log.push(event),
  });
  const completion = (await broken.chat.completions.create({ model: "gpt-5", messages: [] })) as ReturnType<typeof chatCompletion>;
  assert.equal(completion.choices[0]!.message.content, "answer 1 refund guaranteed");
  assert.deepEqual(log.map((e) => e.event), ["wrap_attribution_failed", "wrap_unattributed"]);

  const odd = {
    messages: {
      create: (_params: Record<string, unknown>) => new ApiPromise((resolve) => resolve(stream([null, 42, { type: "content_block_delta", delta: { type: "text_delta", text: "x" } }, "str"]))),
    },
  };
  const wrapped = wrapClient(odd, {
    attribute: () => ({ tag: "t", versionId: "v", arm: "none", model: "m" }),
    observe: async (target, call, options) => {
      const result = await call();
      recorded.push({ target, model: options?.model, result });
      return result;
    },
    log: (event) => log.push(event),
  });
  const chunks: unknown[] = [];
  for await (const chunk of (await wrapped.messages.create({ model: "m2" })) as AsyncIterable<unknown>) chunks.push(chunk);
  assert.deepEqual(chunks, [null, 42, { type: "content_block_delta", delta: { type: "text_delta", text: "x" } }, "str"]);
  await new Promise((r) => setImmediate(r));
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0], { target: { tag: "t", versionId: "v", arm: "none", model: "m" }, model: "m2", result: { stop_reason: "end_turn", content: [{ type: "text", text: "x" }] } });

  // A consumer that stops after the first chunk: what was seen is reported (no usage yet → unavailable).
  recorded.length = 0;
  const early = wrapClient(new FakeOpenAI(), {
    attribute: () => ({ tag: "t", versionId: "v", arm: "none", model: "m" }),
    observe: async (target, call) => {
      const result = await call();
      recorded.push(result);
      return result;
    },
    log: () => {},
  });
  for await (const _ of (await early.chat.completions.create({ model: "gpt-5", stream: true, messages: [] })) as AsyncIterable<unknown>) break;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(recorded, [{ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }] }]);
});

test("the AI SDK middleware: wrapGenerate reads v5 usage/finish/text, wrapStream taps the parts, an unattributed prompt passes through, an error part is an error", async () => {
  const events: Record<string, unknown>[] = [];
  const { ap, windows, cleanup } = await startAgent(events);
  const middleware = ap.aiSdkMiddleware();
  assert.deepEqual([middleware.middlewareVersion, middleware.specificationVersion], ["v2", "v4"]);
  assert.deepEqual([ap.aiSdkMiddleware({ version: "v1" }).middlewareVersion, ap.aiSdkMiddleware({ version: "v1" }).specificationVersion], ["v1", undefined]);
  assert.deepEqual([ap.aiSdkMiddleware({ version: "v3" }).middlewareVersion, ap.aiSdkMiddleware({ version: "v3" }).specificationVersion], [undefined, "v3"]);
  const triage = ap.prompt("support.triage").render({ team: "Billing" });
  const prompt = [
    { role: "system", content: triage.text },
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ];
  const generated = { content: [{ type: "text", text: "Refund Guaranteed" }], finishReason: "length", usage: { inputTokens: 30, outputTokens: 5, totalTokens: 35, cachedInputTokens: 10 } };
  const result = await middleware.wrapGenerate({ doGenerate: async () => generated, params: { prompt }, model: { modelId: "gpt-5-mini" } });
  assert.equal(result, generated, "the result object is the provider's own");
  const parts = [
    { type: "text-start", id: "1" },
    { type: "text-delta", id: "1", delta: "fine " },
    { type: "text-delta", id: "1", delta: "answer" },
    { type: "finish", finishReason: "stop", usage: { inputTokens: 30, outputTokens: 2, totalTokens: 32 } },
  ];
  const streamed = (await middleware.wrapStream({
    doStream: async () => ({ stream: new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(p)), c.close()) }), request: { body: "x" } }),
    params: { prompt },
    model: { modelId: "gpt-5-mini" },
  })) as { stream: ReadableStream<unknown>; request: unknown };
  assert.deepEqual(streamed.request, { body: "x" });
  const got: unknown[] = [];
  const reader = streamed.stream.getReader();
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    got.push(step.value);
  }
  assert.deepEqual(got, parts);
  // An error part after some text: the call is an error.
  const failing = (await middleware.wrapStream({
    doStream: async () => ({ stream: new ReadableStream({ start: (c) => (c.enqueue({ type: "text-delta", delta: "partial" }), c.enqueue({ type: "error", error: Object.assign(new Error("boom"), { status: 504 }) }), c.close()) }) }),
    params: { prompt },
    model: { modelId: "gpt-5-mini" },
  })) as { stream: ReadableStream<unknown> };
  for (const r = failing.stream.getReader(); !(await r.read()).done; );
  // AI SDK 6+ shapes: object usage and a `{ unified }` finish reason.
  await middleware.wrapGenerate({
    doGenerate: async () => ({ content: [{ type: "text", text: "Regards" }], finishReason: { unified: "length", raw: "max_tokens" }, usage: { inputTokens: { total: 8, noCache: 5, cacheRead: 3, cacheWrite: 0 }, outputTokens: { total: 4, text: 4, reasoning: 0 } } }),
    params: { prompt },
    model: { modelId: "gpt-5-mini" },
  });
  // No render in the prompt: passed through, logged.
  await middleware.wrapGenerate({ doGenerate: async () => generated, params: { prompt: [{ role: "user", content: [{ type: "text", text: "unrelated" }] }] }, model: { modelId: "gpt-5-mini" } });
  assert.equal(events.filter((e) => e.event === "wrap_unattributed" && e.method === "ai-sdk").length, 1);
  const rows = byKey(await windows());
  assert.deepEqual(
    rows.map((r) => [r.model, r.status, r.errorClass ?? null, r.count, r.tokens, r.checks ?? null]),
    [
      ["gpt-5-mini", "error", "provider_timeout", 1, { input: 0, output: 0 }, null],
      ["gpt-5-mini", "error", "truncated", 2, { input: 25, cachedInput: 13, output: 9 }, { passed: 1, failed: 1 }],
      ["gpt-5-mini", "ok", null, 1, { input: 30, output: 2 }, { passed: 1, failed: 0 }],
    ],
  );
  cleanup();
});

test("requestTexts reads system and instructions before messages, strings and text parts alike; the registry keeps the last 256 renders", () => {
  assert.deepEqual(
    requestTexts({
      system: [{ type: "text", text: "S" }],
      instructions: "I",
      messages: [
        { role: "user", content: "M1" },
        { role: "assistant", content: [{ type: "text", text: "M2" }, { type: "image_url", image_url: { url: "…" } }] },
      ],
      input: [{ role: "user", content: [{ type: "input_text", text: "R1" }] }],
      prompt: [{ role: "system", content: "P1" }],
      model: "gpt-5",
      temperature: 0.2,
    }),
    ["S", "I", "M1", "M2", "R1", "P1"],
  );
  assert.deepEqual(requestTexts(null), []);
  assert.deepEqual(requestTexts({ messages: "just a string" }), ["just a string"]);
  const registry = new RenderRegistry(3);
  for (const n of [1, 2, 3, 4]) registry.register(`text ${n}`, { tag: `t${n}`, versionId: "v", arm: "none", model: "m" });
  assert.equal(registry.size, 3);
  assert.equal(registry.match(["text 1"]), undefined, "the oldest was evicted");
  assert.equal(registry.match(["nothing", "text 3"])?.tag, "t3");
  registry.register("text 2", { tag: "t2b", versionId: "v", arm: "none", model: "m" });
  assert.equal(registry.match(["text 2"])?.tag, "t2b", "the newest render of the same text wins");
});

test("the middleware never imports the AI SDK and the wrapper never reads a provider package", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["client.ts", "aiSdk.ts", "attribution.ts"]) {
    const source = readFileSync(new URL(`../packages/runtime/src/wrap/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from "(openai|@anthropic-ai\/sdk|ai|@ai-sdk\/[^"]+)"/, file);
  }
  assert.equal(typeof aiSdkMiddleware, "function");
});


test("0.3.1: a slot's inference settings ride the render and go out on the wrapped call — the release's values, whatever the call site wrote; integers on the wire, floats to the provider", async () => {
  const events: Record<string, unknown>[] = [];
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  plane.promote([
    { ...plane.slot({ tag: "support.reply", text: "Reply politely.", model: "gpt-5" }), inference: { temperatureMilli: 200, topPBps: 9000, maxOutputTokens: 800, stopSequences: ["\n\nHuman:"], reasoningEffort: "low" } },
    plane.slot({ tag: "support.triage", text: "Triage.", model: "gpt-5" }),
  ]);
  const ap = await AirPrompterAgent.start({ ...scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" }, fetch: plane.fetch(), logger: (e) => void events.push(e) });
  const rendered = ap.prompt("support.reply").render({});
  assert.deepEqual(rendered.inference, { temperatureMilli: 200, topPBps: 9000, maxOutputTokens: 800, stopSequences: ["\n\nHuman:"], reasoningEffort: "low" }, "the render carries the slot's settings");
  assert.equal(ap.prompt("support.triage").render({}).inference, undefined, "a slot without settings renders none");

  // OpenAI chat: every setting has a home; the call site's temperature and legacy max_tokens are replaced and reported.
  const openai = new FakeOpenAI();
  await ap.wrap(openai).chat.completions.create({ model: "gpt-5", temperature: 1, max_tokens: 50, messages: [{ role: "system", content: rendered.text }, { role: "user", content: "hi" }] });
  const chat = openai.calls[0] as Record<string, unknown>;
  assert.equal(chat.temperature, 0.2);
  assert.equal(chat.top_p, 0.9);
  assert.equal(chat.max_completion_tokens, 800);
  assert.equal("max_tokens" in chat, false, "the legacy cap is not sent beside the new one");
  assert.deepEqual(chat.stop, ["\n\nHuman:"]);
  assert.equal(chat.reasoning_effort, "low");
  const overridden = events.find((e) => e.event === "wrap_inference_overridden");
  assert.deepEqual(overridden?.parameters, ["temperature", "max_tokens"]);

  // Anthropic messages: stop_sequences and max_tokens land; a reasoning effort has no Messages parameter and is reported, not sent.
  const anthropic = new FakeAnthropic();
  await ap.wrap(anthropic).messages.create({ model: "claude-haiku-4-5", max_tokens: 100, system: rendered.text, messages: [{ role: "user", content: "hi" }] });
  const message = anthropic.calls[0] as Record<string, unknown>;
  assert.equal(message.temperature, 0.2);
  assert.equal(message.top_p, 0.9);
  assert.equal(message.max_tokens, 800);
  assert.deepEqual(message.stop_sequences, ["\n\nHuman:"]);
  assert.equal("reasoning_effort" in message, false);
  assert.deepEqual(events.find((e) => e.event === "wrap_inference_unsupported")?.settings, ["reasoningEffort"]);

  // A call site that already agrees is not reported.
  const quiet = new FakeOpenAI();
  const before = events.length;
  await ap.wrap(quiet).chat.completions.create({ model: "gpt-5", temperature: 0.2, messages: [{ role: "system", content: rendered.text }] });
  assert.equal(events.slice(before).some((e) => e.event === "wrap_inference_overridden"), false);
  await ap.stop();
  rmSync(stateDir, { recursive: true, force: true });
});
