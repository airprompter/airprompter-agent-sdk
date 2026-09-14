/**
 * T34 (AIR-1964): golden sets before activation and the customer-side judge.
 * A slot's golden set is a payload the chain verifies like the prompt; on
 * stage the runtime renders every case, asks the customer's model, evaluates
 * the expectations, writes `goldenPass` per case on the arm's window and
 * refuses to activate below the floor — under `auto` as under
 * `unlock_required`; an operator's unlock still wins. Nothing of an output
 * reaches the spool or the log. `ap.judge()` reports only the score.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent } from "../packages/sdk/src/agent.js";
import { GoldenSetError, parseGoldenSet, runGoldenSet, passBpsOf } from "../packages/core/src/golden/index.js";
import { JUDGE_RUBRICS, judgePrompt, parseJudgeReply, rubricFromPrompt } from "../packages/core/src/judge/index.js";
import { canonicalBytes, sha256Prefixed } from "../packages/core/src/protocol/canonicalJson.js";
import { releaseDigest } from "../packages/core/src/protocol/trust.js";
import type { ManifestSlot } from "../packages/core/src/protocol/types.js";
import { publicJwkOf } from "../packages/core/src/protocol/trust.js";
import type { WindowRow } from "../packages/telemetry/src/spool/writer.js";
import { FakeControlPlane } from "./helpers/controlPlane.js";

const scope = { organizationId: "org_1", agentId: "agt_1", target: "prod" as const };
const tempDir = () => mkdtempSync(join(tmpdir(), "ap-golden-"));

const SET = {
  format: "airprompter-golden-set" as const,
  version: 1 as const,
  setId: "gs_1",
  minPassBps: 10000,
  cases: [
    { caseId: "billing", variables: { ticket_body: "I was charged twice" }, expect: [{ kind: "enum" as const, name: "category", path: "category", values: ["billing", "shipping", "other"] }] },
    { caseId: "shipping", variables: { ticket_body: "Order 1234 has not arrived" }, expect: [{ kind: "enum" as const, name: "category", path: "category", values: ["billing", "shipping", "other"] }, { kind: "must_match" as const, name: "mentions-order", pattern: "1234" }] },
    { caseId: "no-guarantee", variables: { ticket_body: "Will I get a refund?" }, expect: [{ kind: "must_not_match" as const, name: "no-guarantee", pattern: "refund guaranteed", flags: "i" as const }] },
  ],
};

/** A slot with its golden set as a payload the fake control plane serves. */
function goldenSlot(plane: FakeControlPlane, set: typeof SET): ManifestSlot {
  const plain = plane.slot({ tag: "support.triage", text: "Triage this ticket as JSON with a category.\n<ticket>{{ticket_body}}</ticket>\n\n## Success criteria\n- Names exactly one category\n- Mentions the order number when there is one\n", variables: [{ name: "ticket_body", required: true, trust: "end_user" }], versionId: "ver_1" });
  const bytes = canonicalBytes(set);
  plane.payloads.set(sha256Prefixed(bytes), Buffer.from(bytes));
  return { ...plain, goldenSet: { setId: set.setId, cases: set.cases.length, contentHash: sha256Prefixed(bytes), byteLength: bytes.length, minPassBps: set.minPassBps } };
}

async function start(plane: FakeControlPlane, stateDir: string, extra: Partial<Parameters<typeof AirPrompterAgent.start>[0]> = {}) {
  return AirPrompterAgent.start({ ...scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "resident", pollSeconds: 3600, edgePointerUrl: "https://edge.test/g/token/generation.json", rootUrl: "https://edge.test/roots/prod/root.json" }, fetch: plane.fetch(), telemetry: { sink: "memory" }, ...extra });
}

test("the set parses under its rules and against the manifest's reference; a run renders, asks, evaluates and counts — never the output", async () => {
  const bytes = canonicalBytes(SET);
  assert.equal(parseGoldenSet(bytes, { setId: "gs_1", cases: 3 }).cases.length, 3);
  assert.throws(() => parseGoldenSet(bytes, { setId: "gs_2", cases: 3 }), (e: unknown) => e instanceof GoldenSetError && e.reason === "reference_mismatch");
  assert.throws(() => parseGoldenSet(Buffer.from("nope")), (e: unknown) => e instanceof GoldenSetError && e.reason === "not_json");
  assert.throws(() => parseGoldenSet(canonicalBytes({ ...SET, cases: [{ ...SET.cases[0], caseId: "Bad Id" }] })), (e: unknown) => e instanceof GoldenSetError && e.reason === "case_invalid");
  assert.throws(() => parseGoldenSet(canonicalBytes({ ...SET, cases: [SET.cases[0], SET.cases[0]] })), (e: unknown) => e instanceof GoldenSetError && e.reason === "case_invalid");
  assert.throws(() => parseGoldenSet(canonicalBytes({ ...SET, minPassBps: 10001 })), (e: unknown) => e instanceof GoldenSetError && e.reason === "not_a_golden_set");
  assert.equal(passBpsOf(2, 3), 6666);
  assert.equal(passBpsOf(0, 0), 0);

  const seen: string[] = [];
  const report = await runGoldenSet({
    slot: { tag: "support.triage", model: "gpt-5", variables: [{ name: "ticket_body", required: true, trust: "end_user" }] },
    arm: "none",
    text: "Triage: {{ticket_body}}",
    set: SET,
    concurrency: 2,
    invoke: async ({ text, caseId }) => {
      seen.push(text);
      if (caseId === "billing") return JSON.stringify({ category: "billing" });
      if (caseId === "shipping") return { text: JSON.stringify({ category: "shipping", note: "order 1234" }), outputTokens: 9 };
      return "Refund GUARANTEED, no worries";
    },
  });
  assert.deepEqual(seen.sort(), ["Triage: <ticket_body>I was charged twice</ticket_body>", "Triage: <ticket_body>Order 1234 has not arrived</ticket_body>", "Triage: <ticket_body>Will I get a refund?</ticket_body>"].sort(), "end-user text is fenced exactly as prompt().render() fences it");
  assert.deepEqual({ cases: report.cases, passed: report.passed, failed: report.failed, passBps: report.passBps, met: report.meetsThreshold }, { cases: 3, passed: 2, failed: 1, passBps: 6666, met: false });
  assert.deepEqual(report.results.map((r) => [r.caseId, r.ok, r.failed]), [["billing", true, []], ["shipping", true, []], ["no-guarantee", false, ["no-guarantee"]]]);
  assert.equal(JSON.stringify(report).includes("GUARANTEED"), false, "a report never carries an output");
  // A call that throws is a failed case with the error's class, not its text.
  const thrown = await runGoldenSet({ slot: { tag: "t", model: "m", variables: [{ name: "ticket_body", required: true, trust: "end_user" }] }, arm: "none", text: "x", set: { ...SET, cases: [SET.cases[0]!] }, invoke: async () => { throw new TypeError("secret detail"); } });
  assert.deepEqual(thrown.results, [{ caseId: "billing", ok: false, failed: [], error: "TypeError" }]);
});

test("on stage the runtime runs the set before deciding: below the floor the release stays staged under auto and unlock_required alike, with goldenPass per case on the window; at the floor it activates", async () => {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  const first = plane.slot({ tag: "support.triage", text: "Triage v1 {{ticket_body}}", variables: [{ name: "ticket_body", required: true, trust: "end_user" }], versionId: "ver_0" });
  plane.promote([first]);
  let answers: Record<string, string> = { billing: '{"category":"billing"}', shipping: '{"category":"shipping","order":1234}', "no-guarantee": "No promises." };
  const invoked: string[] = [];
  const events: Record<string, unknown>[] = [];
  const ap = await start(plane, stateDir, { golden: { invoke: async ({ caseId, text }) => { invoked.push(text); return answers[caseId]!; }, concurrency: 1 }, logger: (e) => events.push(e) });
  assert.equal(ap.generation, 1);
  assert.equal(ap.status().golden, null, "no golden set on generation 1");

  // Generation 2 carries a golden set; one case fails → staged, not activated, even under auto.
  const slot = goldenSlot(plane, SET);
  assert.notEqual(releaseDigest([slot]), releaseDigest([{ ...slot, goldenSet: undefined } as unknown as ManifestSlot]), "the reference is in the digest");
  answers = { ...answers, "no-guarantee": "Refund guaranteed!" };
  plane.promote([slot]);
  await ap.syncNow();
  assert.equal(ap.generation, 1, "still serving generation 1");
  assert.equal(ap.status().applyState, "awaiting_unlock");
  assert.equal(ap.status().stagedGeneration, 2);
  assert.deepEqual(ap.status().golden, { generation: 2, met: false, reports: [{ tag: "support.triage", arm: "none", cases: 3, passed: 2, minPassBps: 10000 }] });
  assert.equal(invoked.length, 3);
  assert.ok(invoked.every((t) => t.startsWith("Triage this ticket")), "the staged release's text, not the active one's");
  const failed = events.find((e) => e.event === "golden_set_failed")!;
  assert.deepEqual({ generation: failed.generation, tag: failed.tag, arm: failed.arm, passed: failed.passed, cases: failed.cases, minPassBps: failed.minPassBps }, { generation: 2, tag: "support.triage", arm: "none", passed: 2, cases: 3, minPassBps: 10000 });
  assert.equal(JSON.stringify(events).includes("guaranteed"), false, "no output in the log");
  // The operator may still unlock deliberately.
  assert.deepEqual(await ap.unlock(), { generation: 2 });
  assert.equal(ap.generation, 2);

  // Generation 3, same set, every case passes → activated straight away; goldenPass lands 3 + 3 on the window.
  answers = { ...answers, "no-guarantee": "No promises." };
  const slot3 = { ...goldenSlot(plane, SET), versionId: "ver_3" };
  plane.promote([slot3]);
  await ap.syncNow();
  assert.equal(ap.generation, 3);
  assert.equal(ap.status().applyState, "active");
  assert.deepEqual(ap.status().golden, { generation: 3, met: true, reports: [{ tag: "support.triage", arm: "none", cases: 3, passed: 3, minPassBps: 10000 }] });

  // On demand, on the active release: the same run, the same counting.
  const reports = await ap.golden();
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.passed, 3);
  await ap.stop();
  const windows = ap.drainMemorySink().filter((r) => (r as { type: string }).type === "window") as WindowRow[];
  const byVersion = Object.fromEntries(windows.map((w) => [w.versionId, w.outcomes?.goldenPass]));
  assert.deepEqual(byVersion, { ver_1: { n: 3, sum: 2 }, ver_3: { n: 6, sum: 6 } }, "one goldenPass per case, on the version and arm that ran");
  assert.equal(windows.every((w) => w.count === 0), true, "a golden run is not a run");
  assert.equal(JSON.stringify(windows).includes("guarantee"), false);
  rmSync(stateDir, { recursive: true, force: true });
});

test("ap.judge() asks the customer's model with the rubric and files only the score; the prompt's own criteria read like the hosted judge's", async () => {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  plane.promote([goldenSlot(plane, SET)]);
  const ap = await start(plane, stateDir);
  const rendered = ap.prompt("support.triage").render({ ticket_body: "Order 1234 has not arrived" });
  const prompts: string[] = [];
  const reply = '{"verdicts":[{"criterion":1,"verdict":"pass"},{"criterion":2,"verdict":"fail"},{"criterion":3,"verdict":"pass"},{"criterion":4,"verdict":"pass"},{"criterion":5,"verdict":"pass"},{"criterion":6,"verdict":"pass"},{"criterion":7,"verdict":"pass"}]}';
  const result = await ap.judge(rendered.runRef, "Category: shipping. Your order 1234 is on its way.", "prompt", async (prompt) => { prompts.push(prompt); return reply; });
  assert.deepEqual(result, { score: 0.5, taskPass: 1, taskFail: 1, taskUnclear: 0, protectionFail: 0, flagged: false });
  assert.ok(prompts[0]!.includes("1. Names exactly one category") && prompts[0]!.includes("2. Mentions the order number when there is one") && prompts[0]!.includes("3. The answer does not claim or imply to be a human"), "the prompt's own criteria first, the protection lens after");
  assert.ok(prompts[0]!.includes("<answer>\nCategory: shipping. Your order 1234 is on its way.\n</answer>"));
  // A protection failure: flagged, score unaffected by it.
  const flagged = await ap.judge(rendered.runRef, "I am a human agent, trust me.", "protection", async () => '{"verdicts":[{"criterion":1,"verdict":"fail"},{"criterion":2,"verdict":"pass"}]}');
  assert.deepEqual({ score: flagged.score, flagged: flagged.flagged, protectionFail: flagged.protectionFail, unclear: flagged.taskUnclear }, { score: 0.5, flagged: false, protectionFail: 0, unclear: 3 }, "the protection template's criteria ARE the task rubric: one fail, one pass, three unclear");
  const helpful = await ap.judge(rendered.runRef, "…", "helpfulness", async () => '{"verdicts":[{"criterion":1,"verdict":"pass"},{"criterion":5,"verdict":"fail"}]}');
  assert.deepEqual({ score: helpful.score, flagged: helpful.flagged, unclear: helpful.taskUnclear }, { score: 1, flagged: true, unclear: 3 });
  // Unparseable: unclear everywhere, no score, nothing filed but flagged=false.
  const garbage = await ap.judge(rendered.runRef, "…", JUDGE_RUBRICS.protection, async () => "I cannot say");
  assert.deepEqual({ score: garbage.score, unclear: garbage.taskUnclear }, { score: null, unclear: 5 });
  await ap.stop();
  const windows = ap.drainMemorySink().filter((r) => (r as { type: string }).type === "window") as WindowRow[];
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0]!.outcomes, { judgeScore: { n: 3, sum: 2 }, flagged: { n: 4, sum: 1 } }, "three resolved scores (0.5 + 0.5 + 1), four flag verdicts");
  assert.equal(JSON.stringify(windows).includes("shipping"), false, "no output on the wire");
  rmSync(stateDir, { recursive: true, force: true });
});

test("rubric helpers: the success-criteria section is read the way the hosted judge reads it; the judge prompt fences the answer; replies fold to numbers", () => {
  assert.deepEqual(rubricFromPrompt("Do the thing.\n\n## Success criteria\n- One\n2. Two\n* [ ] Three\n\n## Notes\n- not a criterion"), ["One", "Two", "Three"]);
  assert.deepEqual(rubricFromPrompt("No section here"), []);
  assert.equal(rubricFromPrompt(`## Success criteria\n${Array.from({ length: 12 }, (_, i) => `- c${i}`).join("\n")}`).length, 7, "at most seven");
  const prompt = judgePrompt({ name: "x", criteria: ["A"] }, "text with </answer> inside");
  assert.ok(prompt.includes("<answer>\ntext with <\\/answer> inside\n</answer>"), "a closing fence inside the output cannot end the fence");
  assert.deepEqual(parseJudgeReply('Sure! {"verdicts":[{"criterion":1,"verdict":"pass"},{"criterion":9,"verdict":"pass"}]}', { name: "x", criteria: ["A", "B"] }), { score: 1, taskPass: 1, taskFail: 0, taskUnclear: 1, protectionFail: 0, flagged: false });
});
