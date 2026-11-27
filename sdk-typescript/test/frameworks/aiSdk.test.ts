/**
 * `frameworks/ai-sdk` on the real `ai` (`generateText`, `streamText`, `wrapLanguageModel`) over its own mock model,
 * so these tests read what a provider would receive and the rows that would upload.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { generateText, streamText, wrapLanguageModel } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";

import { airprompterMiddleware, type AiSdkMiddleware } from "../../packages/sdk/src/frameworks/ai-sdk.js";
import { byKey, startAgent } from "./clients.js";

type CallOptions = { prompt: Array<{ role: string; content: unknown }>; temperature?: number; maxOutputTokens?: number; topP?: number };
const usage = { inputTokens: { total: 30, noCache: 20, cacheRead: 10, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const settings = { temperatureMilli: 200, maxOutputTokens: 800 };
const slots = (plane: Parameters<Parameters<typeof startAgent>[0]>[0]) => [{ ...plane.slot({ tag: "support.reply", text: "Reply politely.", model: "gpt-5", variables: [] }), inference: settings }];

function mock(modelId = "gpt-5") {
  const calls: CallOptions[] = [];
  const model = new MockLanguageModelV4({
    modelId,
    doGenerate: async (options) => {
      calls.push(options as unknown as CallOptions);
      return { content: [{ type: "text", text: `from ${modelId}` }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
    },
    doStream: async (options) => {
      calls.push(options as unknown as CallOptions);
      return {
        stream: convertArrayToReadableStream([
          { type: "text-start", id: "1" },
          { type: "text-delta", id: "1", delta: "streamed " },
          { type: "text-delta", id: "1", delta: "answer" },
          { type: "text-end", id: "1" },
          { type: "finish", finishReason: { unified: "length", raw: "length" }, usage },
        ] as never),
      };
    },
  });
  return { model, calls };
}

const wrap = (inner: ReturnType<typeof mock>["model"], middleware: AiSdkMiddleware) => wrapLanguageModel({ model: inner, middleware: middleware as never });

test("ai hands wrapGenerate and the model the exact object transformParams returned", async () => {
  const { ap, rows } = await startAgent(slots);
  const { model, calls } = mock();
  const inner = airprompterMiddleware(ap, { slot: "support.reply" });
  const seen: unknown[] = [];
  const spy: AiSdkMiddleware = {
    ...inner,
    transformParams: async (options) => {
      const out = await inner.transformParams(options);
      seen.push(out);
      return out;
    },
    wrapGenerate: async (options) => (seen.push(options.params), inner.wrapGenerate(options)),
  };
  await generateText({ model: wrap(model, spy), prompt: "hi" });
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1], "wrapGenerate's params are transformParams' result");
  assert.equal(calls[0], seen[0], "doGenerate received it too");
  await rows();
});

test("the approved text and sealed settings reach the model; no run open, a generate and a stream are one run row each", async () => {
  const events: Record<string, unknown>[] = [];
  const { ap, rows } = await startAgent(slots, events);
  const { model, calls } = mock();
  const wrapped = wrap(model, airprompterMiddleware(ap, { slot: "support.reply" }));
  const { text } = await generateText({ model: wrapped, system: "my own prompt", prompt: "hi", temperature: 1 });
  assert.equal(text, "from gpt-5");
  assert.deepEqual(calls[0]!.prompt[0], { role: "system", content: "Reply politely." });
  assert.equal(calls[0]!.prompt.filter((m) => m.role === "system").length, 1, "the caller's system message was replaced");
  assert.deepEqual([calls[0]!.temperature, calls[0]!.maxOutputTokens], [0.2, 800]);
  assert.deepEqual(events.find((e) => e.event === "wrap_inference_overridden")?.parameters, ["temperature"], "the call site's temperature was replaced and said once");
  const streamed = streamText({ model: wrapped, prompt: "hi" });
  assert.equal(await streamed.text, "streamed answer");
  const out = byKey(await rows());
  assert.deepEqual(out.map((r) => [r.status, r.errorClass, r.count, r.agentRun, r.tokens]), [
    ["error", "truncated", 1, 1, { input: 20, cachedInput: 10, output: 5 }],
    ["ok", null, 1, 1, { input: 20, cachedInput: 10, output: 5 }],
  ]);
});

test("two calls and a stream consumed inside one ap.run are one run", async () => {
  const { ap, rows } = await startAgent(slots);
  const { model } = mock();
  const wrapped = wrap(model, airprompterMiddleware(ap, { slot: "support.reply" }));
  await ap.run({ subject: "u1" }, async () => {
    await generateText({ model: wrapped, prompt: "one" });
    await generateText({ model: wrapped, prompt: "two" });
    await streamText({ model: wrapped, prompt: "three" }).text;
  });
  const out = await rows();
  assert.equal(out.reduce((sum, r) => sum + (r.agentRun ?? 0), 0), 1);
  assert.equal(out.reduce((sum, r) => sum + (r.modelCalls ?? 0), 0), 3);
});

test("modelFor swaps the model; a different id with no modelFor declines and sends the caller's prompt", async () => {
  const events: Record<string, unknown>[] = [];
  const { ap, rows } = await startAgent(slots, events);
  const caller = mock("gpt-4o");
  const released = mock("gpt-5");
  const swapped = wrap(caller.model, airprompterMiddleware(ap, { slot: "support.reply", modelFor: () => released.model }));
  assert.equal((await generateText({ model: swapped, prompt: "hi" })).text, "from gpt-5");
  assert.equal(caller.calls.length, 0);
  assert.deepEqual(released.calls[0]!.prompt[0], { role: "system", content: "Reply politely." });
  const declined = wrap(caller.model, airprompterMiddleware(ap, { slot: "support.reply" }));
  assert.equal((await generateText({ model: declined, system: "mine", prompt: "hi" })).text, "from gpt-4o");
  assert.deepEqual(caller.calls[0]!.prompt[0], { role: "system", content: "mine" });
  assert.equal(caller.calls[0]!.temperature, undefined);
  assert.equal(events.filter((e) => e.event === "model_unresolved").length, 1);
  const out = byKey(await rows());
  assert.deepEqual(out.map((r) => [r.status, r.errorClass]), [["error", "model_unresolved"], ["ok", null]]);
});

test("a call the middleware did not place passes through; the version stamps", async () => {
  const { ap, rows } = await startAgent(slots);
  const middleware = airprompterMiddleware(ap, { slot: "support.reply" });
  assert.deepEqual([middleware.middlewareVersion, middleware.specificationVersion], ["v2", "v4"]);
  for (const [version, stamps] of [["v1", ["v1", undefined]], ["v2", ["v2", undefined]], ["v3", [undefined, "v3"]], ["v4", [undefined, "v4"]]] as const) {
    const one = airprompterMiddleware(ap, { slot: "support.reply", version });
    assert.deepEqual([one.middlewareVersion, one.specificationVersion], stamps);
  }
  const generated = { content: [] };
  assert.equal(await middleware.wrapGenerate({ doGenerate: async () => generated, params: { prompt: [] }, model: {} }), generated);
  // AI SDK 4's call options carry `mode`: the cap is `maxTokens`.
  const v1 = (await middleware.transformParams({ type: "generate", params: { mode: { type: "regular" }, prompt: [] }, model: { modelId: "gpt-5" } })) as Record<string, unknown>;
  assert.deepEqual([v1.maxTokens, "maxOutputTokens" in v1], [800, false]);
  await rows();
});
