/**
 * `frameworks/openai`: each row of the direct-client table, over a client shaped like the real `openai` one, read back
 * as the rows that would upload.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { AirPrompterAgent } from "../../packages/sdk/src/agent.js";
import type { InstrumentRuntime } from "../../packages/sdk/src/frameworks/contract.js";
import { applyPlacement, instrument } from "../../packages/sdk/src/frameworks/openai.js";
import { ApiPromise, FakeOpenAI, byKey, chatCompletion, startAgent, supportSlots } from "./clients.js";

type Params = Record<string, unknown> & { messages?: Array<{ role: string; content: unknown }> };
const settled = () => new Promise((resolve) => setImmediate(resolve));

// A type test: the agent is what `instrument` takes.
const _runtime: InstrumentRuntime = null as unknown as AirPrompterAgent;
void _runtime;

test("a slot inside ap.run: the approved text in the system position, the release's model, one run row; the caller's params are untouched", async () => {
  const { ap, rows } = await startAgent(supportSlots);
  const client = new FakeOpenAI();
  const openai = instrument(client, ap, { slot: "support.triage" });
  assert.ok(openai instanceof FakeOpenAI);
  assert.equal(instrument(openai, ap, { slot: "support.triage" }), openai, "instrumenting twice is once");
  const params: Params = { model: "gpt-5", messages: [{ role: "system", content: "my own prompt" }, { role: "user", content: "hi" }] };
  const reply = await ap.run({ subject: "u1", variables: { team: "Billing" } }, async () => {
    const first = (await openai.chat.completions.create(params)) as ReturnType<typeof chatCompletion>;
    await openai.chat.completions.create({ messages: [{ role: "user", content: "again" }] });
    return first;
  });
  assert.equal(reply.choices[0]!.message.content, "answer 1 refund guaranteed");
  assert.deepEqual(params.messages![0], { role: "system", content: "my own prompt" }, "the input is never mutated");
  const [sent, again] = client.calls as Params[];
  assert.deepEqual(sent!.messages![0], { role: "system", content: "Triage for Billing." }, "a leading system message is replaced");
  assert.equal(sent!.messages!.length, 2);
  assert.deepEqual(again!.messages![0], { role: "system", content: "Triage for Billing." }, "one is prepended when there is none");
  assert.equal(again!.model, "gpt-5", "a call that named no model gets the release's");
  const out = await rows();
  assert.equal(out.length, 1);
  assert.deepEqual([out[0]!.tag, out[0]!.count, out[0]!.modelCalls, out[0]!.agentRun], ["support.triage", 1, 2, 1]);
  assert.deepEqual(out[0]!.checks, { passed: 0, failed: 2 }, "the declared check ran on both answers");
});

test("a slot with no run open: each call is a one-call run; withResponse() still works on the slot-bound call", async () => {
  const { ap, rows } = await startAgent(supportSlots);
  const openai = instrument(new FakeOpenAI(), ap, { slot: "support.reply" });
  await openai.chat.completions.create({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }] });
  const { data, response } = await (openai.chat.completions.create({ model: "claude-haiku-4-5", messages: [] }) as unknown as ApiPromise<unknown>).withResponse();
  assert.equal(response.status, 200);
  assert.equal((data as ReturnType<typeof chatCompletion>).choices[0]!.message.content, "answer 2 refund guaranteed");
  await settled();
  const out = await rows();
  assert.equal(out.length, 1);
  assert.deepEqual([out[0]!.tag, out[0]!.count, out[0]!.agentRun, out[0]!.status], ["support.reply", 2, 2, "ok"], "two runs, one call each");
});

test("a different model id with no modelFor declines: one error row, the caller's request goes out unchanged; modelFor maps the id", async () => {
  const events: Record<string, unknown>[] = [];
  const { ap, rows } = await startAgent(supportSlots, events);
  const client = new FakeOpenAI();
  const params = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };
  await ap.run({ variables: { team: "Billing" } }, () => instrument(client, ap, { slot: "support.triage" }).chat.completions.create(params));
  assert.deepEqual(client.calls[0], params, "the caller's own prompt and model run");
  assert.equal(events.filter((e) => e.event === "model_unresolved").length, 1);
  const mapped = instrument(client, ap, { slot: "support.triage", modelFor: (release, caller) => `azure-${release}-for-${caller}` });
  await ap.run({ variables: { team: "Billing" } }, () => mapped.chat.completions.create(params));
  assert.equal((client.calls[1] as Params).model, "azure-gpt-5-for-gpt-4o");
  assert.deepEqual((client.calls[1] as Params).messages![0], { role: "system", content: "Triage for Billing." });
  const out = byKey(await rows());
  assert.equal(out.filter((r) => r.errorClass === "model_unresolved").length, 1);
  assert.equal(out.filter((r) => r.status === "ok").length, 1, "the mapped call ran on the version and was measured");
});

test("a modelFor that throws after the slot pinned declines it: the caller's request goes out, and the version gets an error row, never an ok one", async () => {
  const events: Record<string, unknown>[] = [];
  const { ap, rows } = await startAgent(supportSlots, events);
  const client = new FakeOpenAI();
  const params = { model: "gpt-4o", messages: [] };
  const openai = instrument(client, ap, { slot: "support.triage", modelFor: () => { throw new Error("no deployment"); } });
  await ap.run({ variables: { team: "Billing" } }, () => openai.chat.completions.create(params));
  assert.equal(client.calls[0], params);
  assert.equal(events.filter((e) => e.event === "adapter_placement_failed").length, 1);
  const out = await rows();
  assert.deepEqual(out.map((r) => [r.status, r.errorClass]), [["error", "model_unresolved"]]);
});

test("two instrumented clients with different slots in one run give two run rows", async () => {
  const { ap, rows } = await startAgent((plane) => [plane.slot({ tag: "support.triage", text: "Triage.", model: "gpt-5", variables: [] }), plane.slot({ tag: "support.reply", text: "Reply.", model: "gpt-5", variables: [] })]);
  const triage = instrument(new FakeOpenAI(), ap, { slot: "support.triage" });
  const reply = instrument(new FakeOpenAI(), ap, { slot: "support.reply" });
  await ap.run({}, async () => {
    await triage.chat.completions.create({ messages: [] });
    await reply.chat.completions.create({ messages: [] });
  });
  const out = byKey(await rows());
  assert.deepEqual(out.map((r) => [r.tag, r.modelCalls]), [["support.reply", 1], ["support.triage", 1]]);
  assert.equal(out.reduce((sum, r) => sum + (r.agentRun ?? 0), 0), 1, "one run");
});

test("a stream consumed inside ap.run is measured to its end; a .stream() helper on a slot-bound client passes through with one log", async () => {
  const events: Record<string, unknown>[] = [];
  const { ap, rows } = await startAgent(supportSlots, events);
  const client = new FakeOpenAI();
  const openai = instrument(client, ap, { slot: "support.triage" });
  await ap.run({ variables: { team: "Billing" } }, async () => {
    const s = (await openai.chat.completions.create({ model: "gpt-5", stream: true, messages: [] })) as AsyncIterable<{ choices: Array<{ delta: { content?: string } }> }> & { tee: () => unknown };
    assert.equal(typeof s.tee, "function", "the stream keeps its own surface");
    let text = "";
    for await (const chunk of s) text += chunk.choices[0]?.delta?.content ?? "";
    assert.equal(text, "streamed answer 1 refund guaranteed");
  });
  const helperParams = { model: "gpt-5", messages: [{ role: "user", content: "hi" }] };
  for (let i = 0; i < 2; i += 1) for await (const _ of openai.chat.completions.stream(helperParams)) void _;
  assert.deepEqual(client.calls.slice(1), [helperParams, helperParams], "the helper's params are untouched");
  assert.equal(events.filter((e) => e.event === "adapter_stream_helper_unmeasured").length, 1);
  const out = await rows();
  assert.equal(out.length, 1);
  assert.deepEqual([out[0]!.status, out[0]!.errorClass, out[0]!.tokens, out[0]!.checks], ["error", "truncated", { input: 100, cachedInput: 20, output: 30 }, { passed: 0, failed: 1 }]);
});

test("Responses: the instructions field carries the approved text", async () => {
  const { ap, rows } = await startAgent(supportSlots);
  const client = new FakeOpenAI();
  const openai = instrument(client, ap, { slot: "support.triage" });
  await ap.run({ variables: { team: "Billing" } }, () => openai.responses.create({ model: "gpt-5", instructions: "mine", input: "hi" }));
  assert.equal((client.calls[0] as Params).instructions, "Triage for Billing.");
  const out = await rows();
  assert.deepEqual([out[0]!.errorClass, out[0]!.tokens], ["truncated", { input: 45, cachedInput: 5, output: 10 }]);
});

test("a passthrough leaves the request untouched and measures nothing; a failing call is classified and the caller sees the same error", async () => {
  const { ap, rows } = await startAgent(supportSlots);
  const client = new FakeOpenAI();
  const params = { model: "gpt-5", messages: [{ role: "user", content: "hi" }] };
  await ap.run({}, () => instrument(client, ap, { slot: "not.released" }).chat.completions.create(params));
  assert.deepEqual(client.calls[0], params);
  const openai = instrument(client, ap, { slot: "support.reply" });
  client.fail = { status: 429 };
  await assert.rejects(ap.run({}, () => openai.chat.completions.create({ messages: [] }) as Promise<unknown>), /rate limited/);
  client.fail = { sync: true };
  await assert.rejects(ap.run({}, () => openai.chat.completions.create({ messages: [] }) as Promise<unknown>), /bad request/, "a synchronous throw arrives as the call's rejection");
  const out = byKey(await rows());
  assert.deepEqual(out.map((r) => [r.tag, r.status, r.errorClass]), [["support.reply", "error", "provider_error"], ["support.reply", "error", "provider_rate_limited"]]);
});

test("nothing the adapter does fails the call: a run whose place throws sends the caller's request", async () => {
  const log: Record<string, unknown>[] = [];
  const broken = { place: async () => { throw new Error("exploded"); }, end() {}, decline() {}, recordModelCall() {} };
  const runtime = { currentRun: () => broken, openRun: () => broken, withRun: (_r: unknown, fn: () => unknown) => fn(), log: (e: Record<string, unknown>) => void log.push(e), currentAttribution: () => undefined, observe: async (_t: unknown, call: () => unknown) => call() } as unknown as InstrumentRuntime;
  const client = new FakeOpenAI();
  const params = { model: "gpt-5", messages: [] };
  const completion = (await instrument(client, runtime, { slot: "s" }).chat.completions.create(params)) as ReturnType<typeof chatCompletion>;
  assert.equal(completion.choices[0]!.message.content, "answer 1 refund guaranteed");
  assert.equal(client.calls[0], params);
  assert.deepEqual(log.map((e) => e.event), ["adapter_placement_failed"]);
});

test("no slot and no scope: untouched, unobserved, one log per method; inside ap.attribute the sealed settings go on a call to the release's model, and a call to another model goes out as written, unobserved", async () => {
  const events: Record<string, unknown>[] = [];
  const { ap, rows } = await startAgent((plane) => [{ ...plane.slot({ tag: "support.reply", text: "Reply politely.", model: "gpt-5" }), inference: { temperatureMilli: 200, maxOutputTokens: 800 } }], events);
  const client = new FakeOpenAI();
  const openai = instrument(client, ap);
  const params = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };
  await openai.chat.completions.create(params);
  await openai.chat.completions.create(params);
  assert.deepEqual(client.calls, [params, params]);
  assert.deepEqual(events.filter((e) => e.event === "adapter_unattributed").map((e) => [e.adapter, e.method]), [["openai", "chat.completions.create"]]);
  const rendered = ap.prompt("support.reply").render({});
  await ap.attribute(rendered, async () => {
    await Promise.resolve();
    await openai.chat.completions.create({ model: "gpt-5", temperature: 1, messages: [{ role: "user", content: `${rendered.text} Today is Friday.` }] });
    await openai.chat.completions.create({ messages: [{ role: "user", content: rendered.text }] });
    // An Azure deployment name: replacing it would send the call nowhere, so it keeps its model and its own settings.
    await openai.chat.completions.create({ model: "my-azure-deployment", temperature: 1, messages: [{ role: "user", content: rendered.text }] });
  });
  const [scoped, unnamed, azure] = client.calls.slice(2) as Params[];
  assert.deepEqual([scoped!.model, scoped!.temperature, scoped!.max_completion_tokens], ["gpt-5", 0.2, 800], "the release's model gets the sealed settings");
  assert.deepEqual([unnamed!.model, unnamed!.temperature], ["gpt-5", 0.2], "a call that names no model gets the release's");
  assert.deepEqual([azure!.model, azure!.temperature, "max_completion_tokens" in azure!], ["my-azure-deployment", 1, false], "another model is never replaced");
  assert.equal(events.filter((e) => e.event === "model_unresolved").length, 1);
  assert.deepEqual(events.find((e) => e.event === "adapter_inference_overridden")?.parameters, ["temperature"]);
  // With modelFor, the call goes out under the mapped id and is measured under the release's.
  const mapped = instrument(client, ap, { modelFor: (release) => `azure-${release}` });
  await ap.attribute(rendered, () => mapped.chat.completions.create({ model: "gpt-4o", messages: [] }));
  assert.equal((client.calls[5] as Params).model, "azure-gpt-5");
  const out = byKey(await rows());
  assert.deepEqual(out.map((r) => [r.tag, r.model, r.count]), [["support.reply", "gpt-5", 3]], "another model's numbers never count against this version; a mapped one counts as the release's");
});

test("asResponse() on a slot-bound call hands back a response nobody has read, and the call is still measured", async () => {
  const { ap, rows } = await startAgent(supportSlots);
  let bodyRead = 0;
  const response = { status: 200, json: async () => (bodyRead += 1, chatCompletion("raw")) };
  const client = { chat: { completions: { create: (_params: Record<string, unknown>) => Object.assign(Promise.resolve().then(() => { bodyRead += 1; return chatCompletion("parsed"); }), { asResponse: async () => response }) } } };
  // A promise whose `then` reads the body, as `APIPromise` does: only `asResponse()` is called here, so it is never read.
  const lazy = { chat: { completions: { create: (params: Record<string, unknown>) => {
    const parsed = { then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => client.chat.completions.create(params).then(resolve, reject), asResponse: async () => response };
    return parsed;
  } } } };
  const openai = instrument(lazy, ap, { slot: "support.reply" });
  const raw = await (openai.chat.completions.create({ messages: [] }) as unknown as { asResponse(): Promise<typeof response> }).asResponse();
  assert.equal(raw, response);
  assert.equal(bodyRead, 0, "the body is the caller's to read");
  assert.equal(((await raw.json()) as ReturnType<typeof chatCompletion>).choices[0]!.message.content, "raw");
  await settled();
  const out = await rows();
  assert.deepEqual(out.map((r) => [r.tag, r.count, r.usageSource]), [["support.reply", 1, "unavailable"]], "measured: latency only");
});

test("applyPlacement: a developer message keeps its role; settings land as floats; a copy", () => {
  const params = { model: "x", temperature: 1, messages: [{ role: "developer", content: "old" }, { role: "user", content: "hi" }] };
  const out = applyPlacement(params, { kind: "approved", slot: "s", instructions: "new", model: "gpt-5", settings: { temperatureMilli: 300, stopSequences: ["END"] } });
  assert.deepEqual(out, { model: "gpt-5", temperature: 0.3, stop: ["END"], messages: [{ role: "developer", content: "new" }, { role: "user", content: "hi" }] });
  assert.equal(params.messages[0]!.content, "old");
  assert.equal(params.temperature, 1);
});
