/**
 * `frameworks/anthropic`: the direct-client table over a client shaped like the real `@anthropic-ai/sdk` one.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { applyPlacement, instrument } from "../../packages/sdk/src/frameworks/anthropic.js";
import { FakeAnthropic, anthropicMessage, byKey, startAgent } from "./clients.js";

type Params = Record<string, unknown>;
const settings = { temperatureMilli: 200, topPBps: 9000, maxOutputTokens: 800, stopSequences: ["\n\nHuman:"], reasoningEffort: "low" as const };
const slots = (plane: Parameters<Parameters<typeof startAgent>[0]>[0]) => [{ ...plane.slot({ tag: "support.reply", text: "Reply politely.", model: "claude-haiku-4-5", variables: [] }), inference: settings }];

test("a slot: `system` is the approved text, the sealed settings go on (one sampling parameter, none beside thinking), one run row", async () => {
  const events: Record<string, unknown>[] = [];
  const { ap, rows } = await startAgent(slots, events);
  const client = new FakeAnthropic();
  const anthropic = instrument(client, ap, { slot: "support.reply" });
  const params = { model: "claude-haiku-4-5", max_tokens: 100, temperature: 1, system: "mine", messages: [{ role: "user", content: "hi" }] };
  const reply = (await ap.run({}, () => anthropic.messages.create(params))) as ReturnType<typeof anthropicMessage>;
  assert.equal(reply.content[0]!.text, "plain reply");
  assert.equal(params.system, "mine", "the input is never mutated");
  const sent = client.calls[0] as Params;
  assert.deepEqual([sent.system, sent.model, sent.temperature, "top_p" in sent, sent.max_tokens, sent.stop_sequences, "reasoning_effort" in sent], ["Reply politely.", "claude-haiku-4-5", 0.2, false, 800, ["\n\nHuman:"], false]);
  await ap.run({}, () => anthropic.messages.create({ max_tokens: 100, thinking: { type: "enabled", budget_tokens: 1024 }, messages: [] }));
  const thought = client.calls[1] as Params;
  assert.deepEqual(["temperature" in thought, "top_p" in thought, thought.model], [false, false, "claude-haiku-4-5"]);
  const out = await rows();
  assert.deepEqual(out.map((r) => [r.tag, r.count, r.agentRun, r.tokens]), [["support.reply", 2, 2, { input: 80, cachedInput: 16, output: 24 }]]);
});

test("a stream from create({ stream: true }) is measured from message_start and message_delta; messages.stream() passes through with one log", async () => {
  const events: Record<string, unknown>[] = [];
  const { ap, rows } = await startAgent(slots, events);
  const client = new FakeAnthropic();
  const anthropic = instrument(client, ap, { slot: "support.reply" });
  await ap.run({}, async () => {
    const s = (await anthropic.messages.create({ model: "claude-haiku-4-5", max_tokens: 100, stream: true, messages: [] })) as AsyncIterable<{ type: string }>;
    const types: string[] = [];
    for await (const event of s) types.push(event.type);
    assert.deepEqual([types[0], types.at(-1)], ["message_start", "message_stop"]);
  });
  const helper = { model: "claude-haiku-4-5", max_tokens: 100, messages: [] };
  assert.equal((await anthropic.messages.stream(helper).finalMessage()).content[0]!.text, "helper reply");
  assert.equal(client.calls[1], helper);
  assert.equal(events.filter((e) => e.event === "adapter_stream_helper_unmeasured").length, 1);
  const out = byKey(await rows());
  assert.deepEqual(out.map((r) => [r.status, r.errorClass, r.count, r.tokens]), [["error", "truncated", 1, { input: 40, cachedInput: 8, output: 12 }]]);
});

test("a different model with no modelFor declines and sends the caller's request; modelFor maps a Bedrock id", async () => {
  const { ap, rows } = await startAgent(slots);
  const client = new FakeAnthropic();
  const params = { model: "claude-opus-4-5", max_tokens: 100, messages: [] };
  await ap.run({}, () => instrument(client, ap, { slot: "support.reply" }).messages.create(params));
  assert.equal(client.calls[0], params);
  await ap.run({}, () => instrument(client, ap, { slot: "support.reply", modelFor: (id) => `anthropic.${id}-v1:0` }).messages.create(params));
  assert.equal((client.calls[1] as Params).model, "anthropic.claude-haiku-4-5-v1:0");
  const out = byKey(await rows());
  assert.deepEqual(out.map((r) => [r.status, r.errorClass]), [["error", "model_unresolved"], ["ok", null]]);
});

test("applyPlacement replaces `system` and keeps the rest, on a copy", () => {
  const params = { model: "x", system: [{ type: "text", text: "old" }], messages: [] };
  assert.deepEqual(applyPlacement(params, { kind: "approved", slot: "s", instructions: "new", model: "claude-haiku-4-5", settings: {} }), { model: "claude-haiku-4-5", system: "new", messages: [] });
  assert.deepEqual(params.system, [{ type: "text", text: "old" }]);
});
