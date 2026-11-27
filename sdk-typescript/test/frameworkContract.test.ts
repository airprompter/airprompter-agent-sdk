/**
 * `frameworks/contract`: the helpers every adapter uses, over a release with three slots (sealed settings, a different
 * model, no settings). With `render.test.ts` the pair proves that what the resolver renders is what reaches the call.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { chooseModel, measureCall, settingsFor } from "../packages/sdk/src/frameworks/contract.js";
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
    assert.deepEqual(settingsFor(plain.settings, { temperatureMilli: "temperature" }), { values: {}, unsupported: [] });
  });
  await rows();
});

test("measureCall records usage, the finish reason and checks' text, and rethrows a failure after recording it", async () => {
  const { ap, rows } = await startAgent(slots);
  await ap.run({}, async (run) => {
    await run.place("no.settings");
    const result = { choices: [{ finish_reason: "length", message: { content: "cut" } }], usage: { prompt_tokens: 10, completion_tokens: 4 } };
    assert.equal(await measureCall(run, "no.settings", () => result, { model: "gpt-5", step: "draft" }), result);
    await assert.rejects(measureCall(run, "no.settings", () => Promise.reject(Object.assign(new Error("slow"), { status: 504 })), { model: "gpt-5" }), /slow/);
    // A framework result is read through `read`.
    await measureCall(run, "no.settings", () => ({ text: "ok" }), { model: "gpt-5", read: () => ({ usage: { input_tokens: 1, output_tokens: 1 } }) });
  });
  const out = (await rows()).filter((r) => r.tag === "no.settings");
  assert.equal(out.length, 1);
  assert.deepEqual([out[0]!.modelCalls, out[0]!.status, out[0]!.errorClass, out[0]!.usageSource], [3, "ok", null, "unavailable"], "the last call's class ends the run; the failed call has no usage");
});
