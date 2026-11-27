/**
 * `frameworks/contract`: the helpers every adapter uses, over a release with three slots (sealed settings, a different
 * model, no settings). With `render.test.ts` the pair proves that what the resolver renders is what reaches the call.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { acquireRun, beginMeasure, chooseModel, measureCall, settingsFor } from "../packages/sdk/src/frameworks/contract.js";
import { startAgent } from "./frameworks/clients.js";

const slots = (plane: Parameters<Parameters<typeof startAgent>[0]>[0]) => [
  { ...plane.slot({ tag: "with.settings", text: "Sealed.", model: "gpt-5", variables: [] }), inference: { temperatureMilli: 250, topPBps: 9500, maxOutputTokens: 600, stopSequences: ["END"] } },
  plane.slot({ tag: "other.model", text: "Elsewhere.", model: "claude-haiku-4-5", variables: [] }),
  plane.slot({ tag: "no.settings", text: "Plain.", model: "gpt-5", variables: [] }),
];

test("chooseModel: modelFor, then the caller's model on a matching id, then the adapter's resolver, else undefined", async () => {
  const { ap, rows } = await startAgent(slots);
  const caller = { id: "gpt-5" };
  await ap.run({}, async (run) => {
    const sealed = await run.place("with.settings");
    const elsewhere = await run.place("other.model");
    assert.ok(sealed.kind === "approved" && elsewhere.kind === "approved");
    const built = { id: "built" };
    assert.equal(chooseModel({ releaseModelId: sealed.model, callerModel: caller, callerModelId: caller.id, modelFor: () => built, resolve: () => undefined }), built, "modelFor first, even on a matching id");
    assert.equal(chooseModel({ releaseModelId: sealed.model, callerModel: caller, callerModelId: caller.id, resolve: () => built }), caller, "the caller's own model when the ids match");
    assert.equal(chooseModel({ releaseModelId: elsewhere.model, callerModel: caller, callerModelId: caller.id, resolve: (id) => id }), "claude-haiku-4-5", "the resolver's string is for the adapter to build");
    assert.equal(chooseModel({ releaseModelId: elsewhere.model, callerModel: caller, callerModelId: caller.id }), undefined, "nothing left: the adapter declines");
  });
  await rows();
});

test("settingsFor: milli and bps become floats under the framework's names; unmapped settings are reported; no settings is nothing", async () => {
  const { ap, rows } = await startAgent(slots);
  await ap.run({}, async (run) => {
    const sealed = await run.place("with.settings");
    const plain = await run.place("no.settings");
    assert.ok(sealed.kind === "approved" && plain.kind === "approved");
    const { values, unsupported } = settingsFor(sealed.settings, { temperatureMilli: "temperature", topPBps: "topP", maxOutputTokens: "maxTokens" });
    assert.deepEqual(values, { temperature: 0.25, topP: 0.95, maxTokens: 600 });
    assert.deepEqual(unsupported, ["stopSequences"]);
    assert.deepEqual(settingsFor(plain.settings, { temperatureMilli: "temperature" }), { values: {}, unsupported: [], overridden: [] });
    assert.deepEqual(settingsFor(sealed.settings, { temperatureMilli: "temperature", topPBps: "topP" }, { temperature: 1, topP: 0.95 }).overridden, ["temperature"], "the caller's agreeing value is not an override");
  });
  await rows();
});

test("measureCall records usage, the finish reason and the text the declared checks read; a failure is recorded with its class and rethrown; beginMeasure settles once on the agent's clock", async () => {
  const { ap, rows } = await startAgent((plane) => [
    { ...plane.slot({ tag: "checked", text: "Checked.", model: "gpt-5", variables: [] }), outputChecks: [{ kind: "must_match" as const, name: "signed", pattern: "Regards" }] },
    plane.slot({ tag: "failing", text: "Failing.", model: "gpt-5", variables: [] }),
    plane.slot({ tag: "streamed", text: "Streamed.", model: "gpt-5", variables: [] }),
  ]);
  const result = { choices: [{ finish_reason: "length", message: { content: "cut, no signature" } }], usage: { prompt_tokens: 10, completion_tokens: 4 } };
  await ap.run({}, async (run) => {
    await run.place("checked");
    assert.equal(await measureCall(run, "checked", () => result, { model: "gpt-5" }), result, "the result comes back untouched");
  });
  await assert.rejects(ap.run({}, async (run) => {
    await run.place("failing");
    return measureCall(run, "failing", () => Promise.reject(Object.assign(new Error("slow"), { status: 504 })), { model: "gpt-5" });
  }), /slow/);
  let clock = 1_000;
  await ap.run({}, async (run) => {
    await run.place("streamed");
    let ended = 0;
    const measurement = beginMeasure(run, "streamed", { model: "gpt-5", now: () => clock, onSettled: () => (ended += 1), read: (framework) => ({ usage: { input_tokens: (framework as { n: number }).n, output_tokens: 1 } }) });
    clock += 250;
    measurement.settle({ n: 7 });
    measurement.settle({ n: 99 });
    measurement.fail(new Error("late"));
    assert.equal(measurement.settled, true);
    assert.equal(ended, 1, "settles once");
  });
  const out = await rows();
  const row = (tag: string) => out.find((r) => r.tag === tag)!;
  assert.deepEqual([row("checked").status, row("checked").errorClass, row("checked").tokens, row("checked").checks], ["error", "truncated", { input: 10, output: 4 }, { passed: 0, failed: 1 }]);
  assert.deepEqual([row("failing").status, row("failing").errorClass, row("failing").usageSource], ["error", "provider_timeout", "unavailable"]);
  assert.deepEqual([row("streamed").status, row("streamed").tokens.input, row("streamed").modelCalls], ["ok", 7, 1], "read shaped the framework's result; the second settle was ignored");
});

test("acquireRun: the open run is not owned; with none, a new run is, and resume gets the live one", async () => {
  const { ap, rows } = await startAgent(slots);
  await ap.run({}, async (run) => {
    const inside = acquireRun(ap);
    assert.deepEqual([inside.run, inside.owned], [run, false]);
  });
  const opened = acquireRun(ap);
  assert.equal(opened.owned, true);
  assert.equal(acquireRun(ap, { resume: opened.run.runRef }).run, opened.run, "get-or-create on the reference");
  opened.run.end();
  await rows();
});
