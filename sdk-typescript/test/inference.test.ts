/**
 * Protocol 0.3.1 / 0.3.2: the slot's (and a workflow step's) inference
 * settings, applied by `applyInference` and the AI SDK middleware, and
 * carried by golden-set invocations.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent } from "../packages/sdk/src/agent.js";
import { publicJwkOf } from "../packages/core/src/protocol/trust.js";
import { applyInference } from "../packages/runtime/src/wrap/inference.js";
import { applyAiSdkInference } from "../packages/runtime/src/wrap/aiSdk.js";
import { inferenceDigestInput, releaseDigest } from "../packages/core/src/protocol/trust.js";
import { GOLDEN_SET_FORMAT, GOLDEN_SET_VERSION, runGoldenSet, type GoldenSet } from "../packages/core/src/golden/index.js";
import { FakeControlPlane } from "./helpers/controlPlane.js";
import type { SlotInference } from "../packages/core/src/protocol/types.js";

const scope = { organizationId: "org_1", agentId: "agt_1", target: "prod" as const };
const tempDir = () => mkdtempSync(join(tmpdir(), "ap-inference-"));
const full: SlotInference = { temperatureMilli: 200, topPBps: 9000, maxOutputTokens: 800, stopSequences: ["\n\nHuman:"], reasoningEffort: "low" };

test("applyInference: a call to another model is skipped whole; a JSON null is unset; a value the wrapper cannot compare is replaced without a report; the order of reports is the settings' order", () => {
  const skipped = applyInference("chat", { model: "gpt-5-mini", temperature: 1 }, full, { model: "gpt-5" });
  assert.equal(skipped.skipped, "model_mismatch");
  assert.deepEqual(skipped.params, { model: "gpt-5-mini", temperature: 1 });
  assert.equal(applyInference("chat", { model: "gpt-5" }, full, { model: "gpt-5" }).skipped, undefined);
  assert.equal(applyInference("chat", {}, full, { model: "gpt-5" }).skipped, undefined, "a call that names no model gets the settings");

  const nulls = applyInference("chat", {}, { temperatureMilli: null, topPBps: 9000 } as unknown as SlotInference);
  assert.deepEqual(nulls.params, { top_p: 0.9 }, "a null key is absent, not temperature 0");

  const sentinel = Symbol("NOT_GIVEN");
  const odd = applyInference("chat", { temperature: sentinel, top_p: undefined }, { temperatureMilli: 200, topPBps: 9000 });
  assert.deepEqual(odd.params, { temperature: 0.2, top_p: 0.9 });
  assert.deepEqual(odd.overridden, ["temperature"], "an unset top_p is not a disagreement; a sentinel is replaced and reported");

  const ordered = applyInference("chat", { max_completion_tokens: 1, temperature: 1 }, { maxOutputTokens: 800, temperatureMilli: 200 });
  assert.deepEqual(ordered.overridden, ["temperature", "max_completion_tokens"], "the settings' order, not the manifest's key order");
});

test("applyInference: Messages takes one sampling parameter and none beside thinking; Responses merges the reasoning object", () => {
  const both = applyInference("messages", { max_tokens: 10 }, full);
  assert.deepEqual(both.params, { max_tokens: 800, temperature: 0.2, stop_sequences: ["\n\nHuman:"] });
  assert.deepEqual(both.unsupported, [{ setting: "topPBps", reason: "one_sampling_parameter" }, { setting: "reasoningEffort", reason: "shape" }]);
  const onlyTopP = applyInference("messages", {}, { topPBps: 9000 });
  assert.deepEqual(onlyTopP.params, { top_p: 0.9 }, "top-p alone goes");
  const thinking = applyInference("messages", { thinking: { type: "enabled", budget_tokens: 1024 } }, { temperatureMilli: 200, maxOutputTokens: 800 });
  assert.deepEqual(thinking.params, { thinking: { type: "enabled", budget_tokens: 1024 }, max_tokens: 800 });
  assert.deepEqual(thinking.unsupported, [{ setting: "temperatureMilli", reason: "thinking" }]);

  const merged = applyInference("responses", { reasoning: { effort: "low", summary: "auto" } }, { reasoningEffort: "low" });
  assert.deepEqual(merged.params, { reasoning: { effort: "low", summary: "auto" } });
  assert.deepEqual(merged.overridden, [], "the same effort is not a disagreement");
  const replaced = applyInference("responses", { reasoning: { effort: "high", summary: "auto" } }, { reasoningEffort: "low" });
  assert.deepEqual(replaced.params, { reasoning: { effort: "low", summary: "auto" } });
  assert.deepEqual(replaced.overridden, ["reasoning.effort"]);
  assert.deepEqual(applyInference("responses", {}, { reasoningEffort: "medium" }).params, { reasoning: { effort: "medium" } });
});

test("the AI SDK middleware applies the settings through transformParams under the same rules", () => {
  const applied = applyAiSdkInference({ temperature: 1, maxOutputTokens: 5 }, full, { model: "gpt-5", modelId: "gpt-5" });
  assert.deepEqual(applied.params, { temperature: 0.2, topP: 0.9, maxOutputTokens: 800, stopSequences: ["\n\nHuman:"] });
  assert.deepEqual(applied.overridden, ["temperature", "maxOutputTokens"]);
  assert.deepEqual(applied.unsupported, [{ setting: "reasoningEffort", reason: "shape" }]);
  assert.equal(applyAiSdkInference({ temperature: 1 }, full, { model: "gpt-5", modelId: "gpt-5-mini" }).skipped, "model_mismatch");
  // AI SDK 4 (middleware v1) names the cap maxTokens; the release's cap lands there and the call site's is reported.
  const v1 = applyAiSdkInference({ maxTokens: 5 }, { maxOutputTokens: 800 }, { model: "gpt-5", modelId: "gpt-5", version: "v1" });
  assert.deepEqual(v1.params, { maxTokens: 800 });
  assert.deepEqual(v1.overridden, ["maxTokens"]);
});

test("0.3.2: a workflow step carries its own settings — in the release digest, on the rendered step, on a wrapped call for that step; a golden invocation carries the slot's", async () => {
  const events: Record<string, unknown>[] = [];
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  const stepInference: SlotInference = { temperatureMilli: 0, maxOutputTokens: 1200 };
  const wf = plane.slot({ tag: "docs.flow", text: "flow", model: "gpt-5", steps: [{ text: "Summarise {{doc}}", inference: stepInference }, { text: "Translate to {{lang}}" }], variables: [{ name: "doc", required: true, trust: "end_user" }, { name: "lang", required: true, trust: "operator" }] });
  const bare = plane.slot({ tag: "docs.flow", text: "flow", model: "gpt-5", steps: [{ text: "Summarise {{doc}}" }, { text: "Translate to {{lang}}" }], variables: wf.variables });
  assert.notEqual(releaseDigest([wf]), releaseDigest([bare]), "a step's settings are in the release digest");
  assert.deepEqual(inferenceDigestInput({ topPBps: null, temperatureMilli: 0 } as unknown as SlotInference), { temperatureMilli: 0 }, "a null key is unset in the digest input");

  const golden = { ...plane.slot({ tag: "support.reply", text: "Reply to {{name}}.", model: "gpt-5", variables: [{ name: "name", required: true, trust: "operator" }] }), inference: full };
  plane.promote([wf, golden]);
  const ap = await AirPrompterAgent.start({ ...scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" }, fetch: plane.fetch(), logger: (e) => void events.push(e) });
  const flow = ap.workflow("docs.flow");
  assert.deepEqual(flow.steps[0]!.inference, stepInference);
  assert.equal(flow.steps[1]!.inference, undefined);
  assert.throws(() => { (flow.steps[0]!.inference as { temperatureMilli?: number }).temperatureMilli = 999; }, "the handed-out block is frozen");

  const calls: Record<string, unknown>[] = [];
  const client = { chat: { completions: { create: async (params: Record<string, unknown>) => { calls.push(params); return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }; } } } };
  await ap.wrap(client).chat.completions.create({ model: "gpt-5", temperature: 1, messages: [{ role: "system", content: flow.steps[0]!.text }] });
  assert.equal(calls[0]!.temperature, 0, "the step's own temperature");
  assert.equal(calls[0]!.max_completion_tokens, 1200);
  await ap.wrap(client).chat.completions.create({ model: "gpt-5", temperature: 1, messages: [{ role: "system", content: flow.steps[1]!.text }] });
  assert.equal(calls[1]!.temperature, 1, "a step without settings leaves the call alone");
  await ap.attribute({ ...flow.steps[0]!, arm: flow.arm }, () => ap.wrap(client).chat.completions.create({ model: "gpt-5", temperature: 1, messages: [{ role: "user", content: "unseen" }] }));
  assert.equal(calls[2]!.temperature, 0, "attribute() on a workflow step carries the step's settings");

  // A golden-set invocation is made as production makes the call: the slot's settings ride it.
  const seen: unknown[] = [];
  const set = { format: GOLDEN_SET_FORMAT, version: GOLDEN_SET_VERSION, setId: "gs_1", minPassBps: 10000, cases: [{ caseId: "c1", variables: { name: "Ada" }, expect: [] }] } as unknown as GoldenSet;
  await runGoldenSet({ slot: golden, arm: "none", text: "Reply to {{name}}.", set, invoke: async (input) => { seen.push(input.inference); return "Reply to Ada."; } });
  assert.deepEqual(seen, [full]);
  await ap.stop();
  rmSync(stateDir, { recursive: true, force: true });
});
