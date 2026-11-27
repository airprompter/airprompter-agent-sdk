/**
 * The run: one request, one version per slot, one count. Drives a real agent over the fake control plane with a fake
 * clock and the memory sink, so what these tests read is the window row that would upload.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent } from "../packages/sdk/src/agent.js";
import { publicJwkOf, releaseDigest, signBytes } from "../packages/sdk/src/core/protocol/trust.js";
import { canonicalBytes } from "../packages/sdk/src/core/protocol/canonicalJson.js";
import { FakeControlPlane } from "../packages/sdk/src/core/testing/index.js";
import type { Directive, Experiment, ManifestSlot } from "../packages/sdk/src/core/protocol/types.js";
import type { ErrorClass } from "../packages/sdk/src/core/telemetry/rows.js";
import { mintRunRef } from "../packages/sdk/src/core/render/runRef.js";
import { DEFAULT_RUN_IDLE_TIMEOUT_MS } from "../packages/sdk/src/runtime/run/registry.js";

const scope = { organizationId: "org_1", agentId: "agt_run", target: "prod" as const };
const TAG = "support.reply";
const T0 = 1_789_300_800_000;

type WindowRow = { type: string; tag: string; arm: string; versionId: string; count: number; modelCalls: number; agentRun: number; tools: { calls: number; errors: number }; checks?: { passed: number; failed: number }; step?: string; status: string; errorClass: string | null; usageSource: string; toolsReported: boolean; minute: string; tokens: { input: number; output: number; cachedInput?: number }; latencyMs: { sum: number } };

function fixture() {
  const plane = new FakeControlPlane(scope);
  const clock = { ms: T0 };
  plane.now = () => clock.ms;
  const events: Array<Record<string, unknown>> = [];
  const start = () => AirPrompterAgent.start({
    ...scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir: mkdtempSync(join(tmpdir(), "ap-run-")),
    root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" },
    fetch: plane.fetch(), telemetry: { sink: "memory" }, now: () => clock.ms, logger: (event) => events.push(event),
  });
  const slotOf = (text: string, versionId: string) => plane.slot({ tag: TAG, text, versionId, variables: [] });
  const experiment = (control: ManifestSlot, candidate: ManifestSlot, candidateBps = 5000, subjectKey: Experiment["subjectKey"] = "request"): Experiment => ({
    experimentId: "exp_1", tag: TAG, salt: "AAECAwQFBgcICQoLDA0ODw", subjectKey,
    arms: [
      { arm: "control", weightBps: 10_000 - candidateBps, releaseDigest: releaseDigest([control]), overrides: [] },
      { arm: "candidate", weightBps: candidateBps, releaseDigest: releaseDigest([candidate]), overrides: [candidate] },
    ],
  });
  const rows = (ap: AirPrompterAgent) => {
    (ap as unknown as { spool: { closeWindows(nowMs: number): void } }).spool.closeWindows(clock.ms + 120_000);
    return (ap.drainMemorySink() as WindowRow[]).filter((row) => row.type === "window" || row.count !== undefined);
  };
  /** Window and step rows together, for tests that read both. */
  const allRows = (ap: AirPrompterAgent) => {
    (ap as unknown as { spool: { closeWindows(nowMs: number): void } }).spool.closeWindows(clock.ms + 120_000);
    return ap.drainMemorySink() as WindowRow[];
  };
  return { plane, clock, events, start, slotOf, experiment, rows, allRows };
}

/** The run id a reference carries: the third element of its signed body. Tests only; `ap.explain` is the public read. */
const runIdOf = (runRef: string): string => (JSON.parse(Buffer.from(runRef.slice(0, runRef.lastIndexOf(".")), "base64url").toString("utf8")) as unknown[])[2] as string;

const usage = (input: number, output: number) => ({ input, cachedInput: 0, output, source: "reported" as const });
const disable = (directive: { scope: "agent" | "slot" | "arm"; tag?: string; arm?: string; experimentId?: string }): Directive => ({ kind: "disable", ...directive, issuedAt: new Date(T0).toISOString() });

test("no subject never uses the instance id: 1,000 runs on one instance split near the weights", async () => {
  const { plane, start, slotOf, experiment } = fixture();
  const a = slotOf("Version A", "ver_a");
  const b = slotOf("Version B", "ver_b");
  plane.promote([a], { experiments: [experiment(a, b, 2000)] });
  const ap = await start();
  const seen: Record<string, number> = {};
  for (let i = 0; i < 1000; i += 1) {
    const placed = await ap.run({}, (run) => run.place(TAG));
    assert.equal(placed.kind, "approved");
    const text = placed.kind === "approved" ? placed.instructions : "";
    seen[text] = (seen[text] ?? 0) + 1;
  }
  assert.ok(seen["Version B"]! > 140 && seen["Version B"]! < 260, `candidate share near 20 %: ${JSON.stringify(seen)}`);
  const direct = new Set(Array.from({ length: 200 }, () => ap.prompt(TAG).render({}).text));
  assert.equal(direct.size, 2, "the direct path no longer hashes the instance either");
  await ap.stop();
});

test('subjectKey "instance" still uses the instance id, so the whole process lands on one arm', async () => {
  const { plane, start, slotOf, experiment } = fixture();
  const a = slotOf("Version A", "ver_a");
  const b = slotOf("Version B", "ver_b");
  plane.promote([a], { experiments: [experiment(a, b, 5000, "instance")] });
  const ap = await start();
  const texts = new Set<string>();
  for (let i = 0; i < 100; i += 1) {
    const placed = await ap.run({ subject: `user-${i}` }, (run) => run.place(TAG));
    if (placed.kind === "approved") texts.add(placed.instructions);
  }
  assert.equal(texts.size, 1);
  await ap.stop();
});

test("prompt() takes one id, so needs() and render() read the same arm with no subject", async () => {
  const { plane, start, slotOf, experiment } = fixture();
  const a = plane.slot({ tag: TAG, text: "A {{x}}", versionId: "ver_a", variables: [{ name: "x", required: true, trust: "operator" }] });
  const b = slotOf("Version B", "ver_b");
  plane.promote([a], { experiments: [experiment(a, b)] });
  const ap = await start();
  for (let i = 0; i < 40; i += 1) {
    const prompt = ap.prompt(TAG);
    const needs = prompt.needs();
    const text = prompt.render(needs.length === 1 ? { x: "1" } : {}).text;
    assert.equal(text, needs.length === 1 ? "A 1" : "Version B", "the arm needs() read is the arm render() used");
  }
  await ap.stop();
});

test("subject is subject, then conversationId, then the run id", async () => {
  const { plane, start, slotOf, experiment } = fixture();
  const a = slotOf("Version A", "ver_a");
  const b = slotOf("Version B", "ver_b");
  plane.promote([a], { experiments: [experiment(a, b)] });
  const ap = await start();
  const textOf = async (input: Parameters<typeof ap.openRun>[0]) => {
    const placed = await ap.openRun(input).place(TAG);
    return placed.kind === "approved" ? placed.instructions : null;
  };
  for (let i = 0; i < 20; i += 1) {
    assert.equal(await textOf({ subject: `u${i}` }), await textOf({ conversationId: `u${i}` }), "conversationId hashes like a subject");
    assert.equal(await textOf({ subject: `u${i}`, conversationId: "other" }), await textOf({ subject: `u${i}` }));
    const ref = ap.openRun().runRef;
    assert.equal(await textOf({ resume: ref }), await textOf({ subject: runIdOf(ref) }), "the run id hashes like a subject");
  }
  await ap.stop();
});

test("a ramp step and a release swap keep the pin and its text, and the next run moves", async () => {
  const { plane, start, slotOf, experiment } = fixture();
  const a = slotOf("Version A", "ver_a");
  const b = slotOf("Version B", "ver_b");
  plane.promote([a], { experiments: [experiment(a, b, 0)] });
  const ap = await start();
  const run = ap.openRun({ subject: "ann" });
  const first = await run.place(TAG);
  assert.equal(first.kind === "approved" && first.instructions, "Version A");
  plane.promote([slotOf("Version C", "ver_c")]);
  await ap.syncNow();
  assert.equal(ap.generation, 2);
  const again = await run.place(TAG);
  assert.deepEqual(again, first, "the old payload is gone from the store, and the run still holds its text");
  run.recordModelCall(TAG, { model: "gpt", latencyMs: 1, usage: usage(1, 1) });
  run.end();
  const next = await ap.run({ subject: "ann" }, (r) => r.place(TAG));
  assert.equal(next.kind === "approved" && next.instructions, "Version C");
  await ap.stop();
});

test("a slot disable gives passthrough at the next place, even for a pinned slot, and the row keeps the pin", async () => {
  const { plane, start, slotOf, rows } = fixture();
  const a = slotOf("Version A", "ver_a");
  plane.promote([a]);
  const ap = await start();
  const run = ap.openRun({ subject: "ann" });
  assert.equal((await run.place(TAG)).kind, "approved");
  run.recordModelCall(TAG, { model: "gpt", latencyMs: 1, usage: usage(5, 5) });
  plane.promote([a], { directives: [disable({ scope: "slot", tag: TAG })] });
  await ap.syncNow();
  assert.deepEqual(await run.place(TAG), { kind: "passthrough", slot: TAG, reason: "slot_disabled" });
  run.end();
  const written = rows(ap).filter((row) => row.count > 0);
  assert.deepEqual(written.map((row) => [row.versionId, row.count, row.tokens.input]), [["ver_a", 1, 5]]);
  await ap.stop();
});

test("a disabled pinned arm re-places on the control, and the run stays counted on the arm it started on", async () => {
  const { plane, start, slotOf, experiment, rows } = fixture();
  const a = slotOf("Version A", "ver_a");
  const b = slotOf("Version B", "ver_b");
  const test = experiment(a, b, 10_000);
  plane.promote([a], { experiments: [test] });
  const ap = await start();
  const run = ap.openRun({ subject: "ann" });
  const first = await run.place(TAG);
  assert.equal(first.kind === "approved" && first.instructions, "Version B");
  run.recordModelCall(TAG, { model: "gpt", latencyMs: 1, usage: usage(5, 5) });
  plane.promote([a], { experiments: [test], directives: [disable({ scope: "arm", arm: "candidate", experimentId: "exp_1" })] });
  await ap.syncNow();
  const second = await run.place(TAG);
  assert.equal(second.kind === "approved" && second.instructions, "Version A");
  run.recordModelCall(TAG, { model: "gpt", latencyMs: 1, usage: usage(5, 5) });
  run.end();
  const written = rows(ap).filter((row) => row.count > 0);
  assert.deepEqual(written.map((row) => [row.arm, row.count, row.tokens.input]), [["candidate", 1, 10]]);
  await ap.stop();
});

test("each reason returns passthrough and throws nothing", async () => {
  const { plane, start, slotOf } = fixture();
  const ap = await start();
  assert.deepEqual(await ap.openRun().place(TAG), { kind: "passthrough", slot: TAG, reason: "no_verified_release" });
  plane.promote([
    slotOf("Version A", "ver_a"),
    plane.slot({ tag: "needs.variable", text: "Hello {{name}}", versionId: "ver_b", variables: [{ name: "name", required: true, trust: "operator" }] }),
    plane.slot({ tag: "off.slot", text: "Off", versionId: "ver_c", variables: [] }),
  ], { directives: [disable({ scope: "slot", tag: "off.slot" })] });
  await ap.syncNow();
  assert.deepEqual(await ap.openRun().place("nothing.here"), { kind: "passthrough", slot: "nothing.here", reason: "no_slot" });
  assert.deepEqual(await ap.openRun().place("needs.variable"), { kind: "passthrough", slot: "needs.variable", reason: "variables_unfilled" });
  assert.deepEqual(await ap.openRun().place("off.slot"), { kind: "passthrough", slot: "off.slot", reason: "slot_disabled" });
  assert.equal((await ap.openRun({ variables: { name: "Ann" } }).place("needs.variable")).kind, "approved");
  await ap.stop();
});

test("a run that started as a passthrough stays one: a promotion reaches the next run", async () => {
  const { plane, start, slotOf } = fixture();
  const ap = await start();
  const run = ap.openRun({ subject: "ann" });
  assert.equal((await run.place(TAG)).kind, "passthrough");
  plane.promote([slotOf("Version A", "ver_a")]);
  await ap.syncNow();
  assert.equal((await run.place(TAG)).kind, "passthrough");
  assert.equal((await ap.openRun({ subject: "ann" }).place(TAG)).kind, "approved");
  await ap.stop();
});

test("two concurrent place calls render once", async () => {
  const { plane, start } = fixture();
  plane.promote([plane.slot({ tag: TAG, text: "Hello {{name}}", versionId: "ver_a", variables: [{ name: "name", required: true, trust: "operator" }] })]);
  const ap = await start();
  let calls = 0;
  ap.variables.provide("name", {
    trust: "operator",
    resolve: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "Ann";
    },
  });
  const run = ap.openRun();
  const [one, two] = await Promise.all([run.place(TAG), run.place(TAG)]);
  assert.equal(calls, 1);
  assert.deepEqual(one, two);
  await ap.stop();
});

test("five model calls and end give one count, summed tokens and wall-clock latency", async () => {
  const { plane, clock, start, slotOf, rows } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  const run = ap.openRun({ subject: "ann" });
  await run.place(TAG);
  for (let i = 0; i < 5; i += 1) {
    clock.ms += 1000;
    run.recordModelCall(TAG, { model: "gpt", latencyMs: 400, usage: usage(10, 5) });
  }
  run.end();
  const [row, ...rest] = rows(ap).filter((entry) => entry.count > 0);
  assert.deepEqual(rest, []);
  assert.deepEqual([row!.count, row!.tokens.input, row!.tokens.output, row!.latencyMs.sum, row!.status, row!.usageSource], [1, 50, 25, 5000, "ok", "reported"]);
  await ap.stop();
});

test("end twice writes once; a pinned slot with no model call still writes a run row with modelCalls 0", async () => {
  const { plane, start, slotOf, rows } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  const silent = ap.openRun();
  await silent.place(TAG);
  silent.end();
  const run = ap.openRun();
  await run.place(TAG);
  run.recordModelCall(TAG, { model: "gpt", latencyMs: 1, usage: usage(1, 1) });
  run.end();
  run.end();
  run.recordModelCall(TAG, { model: "gpt", latencyMs: 1, usage: usage(9, 9) });
  run.end({ errorClass: "provider_error" });
  // The silent run has no usage, so it is `unavailable` and lands on a row of its own beside the `reported` run.
  assert.deepEqual(rows(ap).filter((row) => row.count > 0).map((row) => [row.count, row.modelCalls, row.tokens.input, row.status, row.usageSource]).sort(), [[1, 0, 0, "ok", "unavailable"], [1, 1, 1, "ok", "reported"]]);
  await ap.stop();
});

test("two runs in one minute, one reported and one unavailable, land in two rows", async () => {
  const { plane, start, slotOf, rows } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  const reported = ap.openRun();
  await reported.place(TAG);
  reported.recordModelCall(TAG, { model: "gpt", latencyMs: 1, usage: usage(4, 2) });
  reported.end();
  const unavailable = ap.openRun();
  await unavailable.place(TAG);
  unavailable.recordModelCall(TAG, { model: "gpt", latencyMs: 1 });
  unavailable.end();
  const written = rows(ap).filter((row) => row.count > 0);
  assert.equal(new Set(written.map((row) => row.minute)).size, 1, "one minute");
  assert.deepEqual(written.map((row) => [row.usageSource, row.count, row.modelCalls, row.tokens.input]).sort(), [["reported", 1, 1, 4], ["unavailable", 1, 1, 0]]);
  await ap.stop();
});

test("toolsReported: a tool record makes it true, a slot with no tool hook is false, and toolsObserved with no tools is true with calls 0", async () => {
  const CLASSIFY = "support.classify";
  const { plane, start, slotOf, allRows } = fixture();
  plane.promote([slotOf("Version A", "ver_a"), plane.slot({ tag: CLASSIFY, text: "Classify", versionId: "ver_c", variables: [] })]);
  const ap = await start();
  await ap.run({ subject: "ann" }, async (run) => {
    await run.place(TAG);
    await run.place(CLASSIFY);
    run.recordModelCall(TAG, { step: "plan", model: "gpt", latencyMs: 10, usage: usage(1, 1) });
    run.recordToolCall(TAG, { ok: true });
    run.recordModelCall(CLASSIFY, { step: "classify", model: "gpt", latencyMs: 10, usage: usage(1, 1) });
  });
  await ap.run({ subject: "bob" }, async (run) => {
    await run.place(CLASSIFY);
    run.recordModelCall(CLASSIFY, { model: "gpt", latencyMs: 10, usage: usage(1, 1), toolsObserved: true });
  });
  const written = allRows(ap);
  const windows = written.filter((row) => row.type === "window" && row.count > 0).map((row) => [row.tag, row.toolsReported, row.tools.calls, row.count]).sort();
  assert.deepEqual(windows, [[CLASSIFY, false, 0, 1], [CLASSIFY, true, 0, 1], [TAG, true, 1, 1]]);
  const steps = written.filter((row) => row.type === "step").map((row) => [row.tag, row.step, row.toolsReported]).sort();
  assert.deepEqual(steps, [[CLASSIFY, "classify", false], [TAG, "plan", true]], "a step row takes its slot's value");
  await ap.stop();
});

test("status is the class end carries, else the last model call's class; a recovered failure is ok", async () => {
  const { plane, start, slotOf, rows } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  const once = async (calls: Array<ErrorClass | undefined>, carried?: ErrorClass) => {
    const run = ap.openRun();
    await run.place(TAG);
    for (const errorClass of calls) run.recordModelCall(TAG, { model: "gpt", latencyMs: 1, usage: usage(1, 1), ...(errorClass ? { errorClass } : {}) });
    run.end(carried ? { errorClass: carried } : {});
  };
  await once(["provider_error", undefined]);
  await once([undefined, "truncated"]);
  await once([undefined], "provider_rate_limited");
  const summary = rows(ap).filter((row) => row.count > 0).map((row) => [row.status, row.errorClass, row.count]).sort();
  assert.deepEqual(summary, [["error", "provider_rate_limited", 1], ["error", "truncated", 1], ["ok", null, 1]]);
  await ap.stop();
});

test("ap.run ends the run, with the thrown error's class", async () => {
  const { plane, start, slotOf, rows } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  await assert.rejects(ap.run({}, async (run) => {
    assert.equal(ap.currentRun(), run);
    await run.place(TAG);
    run.recordModelCall(TAG, { model: "gpt", latencyMs: 1 });
    throw Object.assign(new Error("slow"), { status: 429 });
  }), /slow/);
  assert.equal(ap.currentRun(), undefined);
  const [row] = rows(ap).filter((entry) => entry.count > 0);
  assert.deepEqual([row!.count, row!.status, row!.errorClass, row!.usageSource], [1, "error", "provider_rate_limited", "unavailable"]);
  await ap.stop();
});

test("the sweep ends an idle run with the last error's class", async () => {
  const { plane, clock, start, slotOf, rows } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  const run = ap.openRun();
  await run.place(TAG);
  run.recordModelCall(TAG, { model: "gpt", latencyMs: 1, errorClass: "provider_error" });
  clock.ms += 15 * 60_000 - 1;
  ap.openRun();
  assert.deepEqual(rows(ap).filter((row) => row.count > 0), [], "not yet idle");
  clock.ms += 1;
  ap.openRun();
  assert.deepEqual(rows(ap).filter((row) => row.count > 0).map((row) => [row.count, row.errorClass]), [[1, "provider_error"]]);
  await ap.stop();
});

test("the sweep skips a run inside an open withRun, including one whose promise is pending", async () => {
  const { plane, clock, start, slotOf, rows } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  const run = ap.openRun();
  await run.place(TAG);
  run.recordModelCall(TAG, { model: "gpt", latencyMs: 1 });
  let finish = () => {};
  const tool = ap.withRun(run, () => new Promise<void>((resolve) => { finish = resolve; }));
  clock.ms += 60 * 60_000;
  ap.openRun();
  assert.deepEqual(rows(ap).filter((row) => row.count > 0), [], "a long tool does not end a live run");
  finish();
  await tool;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ap.openRun({ resume: run.runRef }), run, "the run is still live, and idle time restarts when the tool returns");
  clock.ms += 15 * 60_000;
  ap.openRun();
  assert.equal(rows(ap).filter((row) => row.count > 0).length, 1);
  await ap.stop();
});

test("openRun with resume is get-or-create: after a sweep, repeated resumes are one new session on the same subject", async () => {
  const { plane, clock, start, slotOf, experiment } = fixture();
  const a = slotOf("Version A", "ver_a");
  const b = slotOf("Version B", "ver_b");
  plane.promote([a], { experiments: [experiment(a, b)] });
  const ap = await start();
  const run = ap.openRun({ subject: "ann" });
  assert.equal(ap.openRun({ resume: run.runRef }), run);
  const before = await run.place(TAG);
  const old = run.runRef;
  clock.ms += 15 * 60_000;
  const resumed = ap.openRun({ resume: old, subject: "ann" });
  assert.notEqual(resumed, run);
  assert.equal(runIdOf(resumed.runRef), runIdOf(old));
  assert.equal(ap.openRun({ resume: old, subject: "ann" }), resumed);
  assert.deepEqual(await resumed.place(TAG), before, "sticky assignment keeps the arm");
  await ap.stop();
});

test("stop() ends open runs before the windows close", async () => {
  const { plane, start, slotOf } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  const run = ap.openRun();
  await run.place(TAG);
  run.recordModelCall(TAG, { model: "gpt", latencyMs: 1, usage: usage(3, 3) });
  await ap.stop();
  const written = (ap.drainMemorySink() as WindowRow[]).filter((row) => row.count > 0);
  assert.deepEqual(written.map((row) => [row.count, row.tokens.input]), [[1, 3]]);
});

test("a label the heartbeat cannot carry does not stop a served call", async () => {
  const { plane, start } = fixture();
  plane.promote([plane.slot({ tag: "Odd_Tag", text: "Version A", versionId: "ver_a", variables: [] })]);
  const ap = await start();
  const placed = await ap.openRun().place("Odd_Tag");
  assert.equal(placed.kind === "approved" && placed.instructions, "Version A");
  await ap.stop();
});

test("a slot name no release can hold is no_slot, not a throw", async () => {
  const { plane, start, slotOf } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  assert.deepEqual(await ap.openRun().place("Not A Valid Tag"), { kind: "passthrough", slot: "Not A Valid Tag", reason: "no_slot" });
  await ap.stop();
});

test("an ended run is not current, so work left running after it cannot write to a run already counted", async () => {
  const { plane, start, slotOf } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  const run = ap.openRun();
  await ap.withRun(run, async () => {
    assert.equal(ap.currentRun(), run);
    run.end();
    assert.equal(ap.currentRun(), undefined);
  });
  await ap.stop();
});

test("a swept run's latency stops at its last activity, not after the idle wait", async () => {
  const { plane, clock, start, slotOf, rows } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  const run = ap.openRun();
  await run.place(TAG);
  clock.ms += 2000;
  run.recordModelCall(TAG, { model: "gpt", latencyMs: 2000, errorClass: "provider_error" });
  clock.ms += 15 * 60_000;
  ap.openRun();
  assert.deepEqual(rows(ap).filter((row) => row.count > 0).map((row) => row.latencyMs.sum), [2000]);
  await ap.stop();
});

test("stop() during an open scope keeps the time up to now", async () => {
  const { plane, clock, start, slotOf } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  const run = ap.openRun();
  await run.place(TAG);
  run.recordModelCall(TAG, { model: "gpt", latencyMs: 1 });
  let finish = () => {};
  const tool = ap.withRun(run, () => new Promise<void>((resolve) => { finish = resolve; }));
  clock.ms += 600_000;
  await ap.stop();
  finish();
  await tool;
  assert.deepEqual((ap.drainMemorySink() as WindowRow[]).filter((row) => row.count > 0).map((row) => row.latencyMs.sum), [600_000]);
});

test("the spool timer runs the sweep", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { plane, clock, start, slotOf, rows } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  const run = ap.openRun();
  await run.place(TAG);
  run.recordModelCall(TAG, { model: "gpt", latencyMs: 1, usage: usage(1, 1) });
  clock.ms += 15 * 60_000;
  t.mock.timers.tick(60_000);
  assert.deepEqual(rows(ap).filter((row) => row.count > 0).map((row) => row.count), [1], "no openRun here: only the timer can have swept it");
  await ap.stop();
});

test("a tool call keeps a run from looking idle", async () => {
  const { plane, clock, start, slotOf } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  const run = ap.openRun();
  await run.place(TAG);
  clock.ms += 14 * 60_000;
  run.recordToolCall(TAG, { ok: true });
  clock.ms += 14 * 60_000;
  assert.equal(ap.openRun({ resume: run.runRef }), run);
  await ap.stop();
});

test("a lapsed lease keeps serving a first placement and a pinned one, and stamps once", async () => {
  const { plane, clock, start, slotOf } = fixture();
  plane.promote([slotOf("Version A", "ver_a")], { leaseSeconds: 60 });
  const ap = await start();
  const run = ap.openRun();
  assert.equal((await run.place(TAG)).kind, "approved");
  clock.ms += 120_000;
  assert.equal((await run.place(TAG)).kind, "approved");
  assert.equal((await ap.openRun().place(TAG)).kind, "approved");
  await ap.stop();
  const refusals = ap.drainMemorySink().filter((row) => (row as { type: string }).type === "refusal");
  assert.deepEqual(refusals.map((row) => (row as { reason: string }).reason), ["lease_expired"]);
});

test("run tags reach the experiment's audience, and their names reach the heartbeat", async () => {
  const { plane, start, slotOf, experiment } = fixture();
  const a = slotOf("Version A", "ver_a");
  const b = slotOf("Version B", "ver_b");
  const audience = { audienceId: "aud_AAAAAAAAAAAAAAAAAAAAAA", selector: { mode: "when" as const, when: { key: "plan", is: "pro" } } };
  const manifest = plane.promote([a], { experiments: [{ ...experiment(a, b, 10_000), audience }] });
  manifest.payload.observations = [{ ...audience, tag: TAG, observeFrom: "2026-01-01T00:00:00Z" }];
  manifest.signatures[0]!.sig = signBytes(canonicalBytes(manifest.payload), plane.signingKey);
  (plane as unknown as { current: { bytes: Buffer } }).current.bytes = Buffer.from(JSON.stringify(manifest));
  const ap = await start();
  const textOf = async (input: Parameters<typeof ap.openRun>[0]) => {
    const placed = await ap.openRun(input).place(TAG);
    return placed.kind === "approved" ? placed.instructions : null;
  };
  assert.equal(await textOf({ subject: "ann", tags: { plan: "pro" } }), "Version B");
  assert.equal(await textOf({ subject: "ann", tags: { plan: "free" } }), "Version A");
  await ap.heartbeatNow();
  await ap.heartbeatNow();
  assert.deepEqual((ap.heartbeatBody() as { registration?: { tagKeys: string[] } }).registration?.tagKeys, ["plan"]);
  await ap.stop();
});

test("runRef has no entries until a slot is placed; its run id is fixed at open", async () => {
  const { plane, start, slotOf } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  const run = ap.openRun();
  const first = run.runRef;
  assert.deepEqual(ap.explain(first), []);
  await run.place(TAG);
  assert.deepEqual(ap.explain(run.runRef)!.map((entry) => entry.tag), [TAG]);
  assert.equal(runIdOf(run.runRef), runIdOf(first));
  await ap.stop();
});

// ---------------------------------------------------------------------------------------------- AIR-2242: the full run

const OTHER = "support.classify";

test("rows: five model calls, two tools and two steps give one run row and step rows of their own type", async () => {
  const { plane, start, slotOf, allRows } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  await ap.run({ subject: "ann" }, async (run) => {
    await run.place(TAG);
    for (let i = 0; i < 5; i += 1) run.recordModelCall(TAG, { step: i < 3 ? "plan" : "reply", model: "gpt", latencyMs: 100, usage: usage(10, 2) });
    run.recordToolCall(TAG, { step: "plan", ok: true });
    run.recordToolCall(TAG, { ok: false });
  });
  const written = allRows(ap);
  const windows = written.filter((row) => row.type === "window" && row.count > 0);
  assert.deepEqual(windows.map((row) => [row.count, row.modelCalls, row.agentRun, row.tools.calls, row.tools.errors, row.tokens.input]), [[1, 5, 1, 2, 1, 50]]);
  const steps = written.filter((row) => row.type === "step").map((row) => [row.step, row.modelCalls, row.tools.calls, row.count]).sort();
  assert.deepEqual(steps, [["plan", 3, 1, undefined], ["reply", 2, 0, undefined]]);
  await ap.stop();
});

test("two slots in one run write two run rows whose agentRun sums to 1, under one growing ref with one runId", async () => {
  const { plane, start, slotOf, rows } = fixture();
  plane.promote([slotOf("Version A", "ver_a"), plane.slot({ tag: OTHER, text: "Classify", versionId: "ver_c", variables: [] })]);
  const ap = await start();
  const refs: string[] = [];
  await ap.run({ subject: "ann" }, async (run) => {
    refs.push(run.runRef);
    await run.place(OTHER);
    run.recordModelCall(OTHER, { model: "gpt", latencyMs: 1, usage: usage(1, 1) });
    refs.push(run.runRef);
    await run.place(TAG);
    run.recordModelCall(TAG, { model: "gpt", latencyMs: 1, usage: usage(2, 2) });
    refs.push(run.runRef);
  });
  assert.deepEqual(refs.map((ref) => ap.explain(ref)!.map((entry) => entry.tag)), [[], [OTHER], [OTHER, TAG]]);
  assert.equal(new Set(refs.map(runIdOf)).size, 1);
  const written = rows(ap).filter((row) => row.count > 0);
  assert.deepEqual(written.map((row) => [row.tag, row.count, row.agentRun]), [[OTHER, 1, 1], [TAG, 1, 0]]);
  await ap.stop();
});

test("rule 2: a frozen experiment (every arm disabled) passes a pinned slot through", async () => {
  const { plane, start, slotOf, experiment } = fixture();
  const a = slotOf("Version A", "ver_a");
  const b = slotOf("Version B", "ver_b");
  const test = experiment(a, b);
  plane.promote([a], { experiments: [test] });
  const ap = await start();
  const run = ap.openRun({ subject: "ann" });
  assert.equal((await run.place(TAG)).kind, "approved");
  plane.promote([a], { experiments: [test], directives: [disable({ scope: "arm", arm: "candidate", experimentId: "exp_1" }), disable({ scope: "arm", arm: "control", experimentId: "exp_1" })] });
  await ap.syncNow();
  assert.deepEqual(await run.place(TAG), { kind: "passthrough", slot: TAG, reason: "slot_disabled" });
  await ap.stop();
});

test("rule 3: repeated resume returns one live session, merging tags and keeping the subject", async () => {
  const { plane, start, slotOf, experiment } = fixture();
  const a = slotOf("Version A", "ver_a");
  const b = slotOf("Version B", "ver_b");
  plane.promote([a], { experiments: [experiment(a, b)] });
  const ap = await start();
  const run = ap.openRun({ subject: "ann" });
  const before = await run.place(TAG);
  for (let i = 0; i < 3; i += 1) assert.equal(ap.openRun({ resume: run.runRef, subject: `other-${i}`, tags: { plan: "pro" } }), run);
  assert.deepEqual(await run.place(TAG), before);
  await ap.stop();
});

test("rule 3: after a sweep, the same old ref on every hook of a two-call resume is one new run on the same arm", async () => {
  const { plane, clock, start, slotOf, experiment, rows } = fixture();
  const a = slotOf("Version A", "ver_a");
  const b = slotOf("Version B", "ver_b");
  plane.promote([a], { experiments: [experiment(a, b)] });
  const ap = await start();
  const first = ap.openRun();
  const placed = await first.place(TAG);
  first.recordModelCall(TAG, { model: "gpt", latencyMs: 1 });
  const old = first.runRef;
  clock.ms += 15 * 60_000;
  const sessions = new Set<unknown>([first]);
  for (let hook = 0; hook < 2; hook += 1) {
    const resumed = ap.openRun({ resume: old });
    sessions.add(resumed);
    assert.deepEqual(await resumed.place(TAG), placed, "no subject: the run id hashes the same, so the arm holds");
    resumed.recordModelCall(TAG, { model: "gpt", latencyMs: 1 });
    assert.equal(runIdOf(resumed.runRef), runIdOf(old));
  }
  assert.equal(sessions.size, 2, "two sessions in all, not four");
  ap.openRun({ resume: old }).end();
  assert.deepEqual(rows(ap).filter((row) => row.count > 0).map((row) => row.count), [1, 1], "the resume after the sweep counts as a second run");
  await ap.stop();
});

test("rule 3: a forged ref opens a new run and logs run_resume_refused, without throwing", async () => {
  const { plane, start, slotOf, events } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  const run = ap.openRun();
  const forged = `${run.runRef.slice(0, -3)}AAA`;
  const opened = ap.openRun({ resume: forged });
  assert.notEqual(opened, run);
  assert.notEqual(runIdOf(opened.runRef), runIdOf(run.runRef));
  assert.equal(events.filter((event) => event.event === "run_resume_refused").length, 1);
  assert.equal(ap.openRun({ resume: "not a ref" }) instanceof Object, true);
  await ap.stop();
});

test("rule 4: each of the seven reasons is a passthrough and nothing throws", async () => {
  const { plane, start, slotOf } = fixture();
  const ap = await start();
  assert.deepEqual(await ap.openRun().place(TAG), { kind: "passthrough", slot: TAG, reason: "no_verified_release" });
  plane.promote([
    slotOf("Version A", "ver_a"),
    plane.slot({ tag: "needs.variable", text: "Hello {{name}}", versionId: "ver_b", variables: [{ name: "name", required: true, trust: "operator" }] }),
    plane.slot({ tag: "off.slot", text: "Off", versionId: "ver_c", variables: [] }),
    plane.slot({ tag: "a.flow", text: "flow", versionId: "ver_f", variables: [], steps: [{ text: "Step one" }] }),
  ], { directives: [disable({ scope: "slot", tag: "off.slot" })] });
  await ap.syncNow();
  const reasons = async (slot: string) => {
    const placed = await ap.openRun().place(slot);
    return placed.kind === "passthrough" ? placed.reason : placed.kind;
  };
  assert.equal(await reasons("nothing.here"), "no_slot");
  assert.equal(await reasons("needs.variable"), "variables_unfilled");
  assert.equal(await reasons("off.slot"), "slot_disabled");
  assert.equal(await reasons("a.flow"), "slot_kind_unsupported");
  const run = ap.openRun();
  await run.place(TAG);
  assert.deepEqual(run.decline(TAG, "model_unresolved"), { kind: "passthrough", slot: TAG, reason: "model_unresolved" });
  await ap.stop();
  const locked = fixture();
  locked.plane.promote([locked.slotOf("Version A", "ver_a")], { applyPolicy: "unlock_required" });
  const waiting = await locked.start();
  assert.deepEqual(await waiting.openRun().place(TAG), { kind: "passthrough", slot: TAG, reason: "awaiting_unlock" });
  await waiting.stop();
});

test("rule 4: decline writes one error row however many calls follow, and carries agentRun 1 when it is first", async () => {
  const { plane, start, slotOf, rows } = fixture();
  plane.promote([slotOf("Version A", "ver_a"), plane.slot({ tag: OTHER, text: "Classify", versionId: "ver_c", variables: [] })]);
  const ap = await start();
  await ap.run({}, async (run) => {
    await run.place(TAG);
    run.decline(TAG, "model_unresolved");
    for (let i = 0; i < 3; i += 1) assert.deepEqual(await run.place(TAG), { kind: "passthrough", slot: TAG, reason: "model_unresolved" });
    await run.place(OTHER);
    run.recordModelCall(OTHER, { model: "gpt", latencyMs: 1 });
  });
  const written = rows(ap).filter((row) => row.count > 0);
  assert.deepEqual(written.map((row) => [row.tag, row.status, row.errorClass, row.agentRun]), [[TAG, "error", "model_unresolved", 1], [OTHER, "ok", null, 0]]);
  assert.deepEqual((ap.heartbeatBody() as { runCounters: { passthrough: Record<string, number> } }).runCounters.passthrough, { model_unresolved: 1 });
  await ap.stop();
});

test("rule 4: a missing variable writes one error row against its version, however many places follow", async () => {
  const { plane, start, rows } = fixture();
  plane.promote([plane.slot({ tag: TAG, text: "Hello {{name}}", versionId: "ver_a", variables: [{ name: "name", required: true, trust: "operator" }] })]);
  const ap = await start();
  await ap.run({}, async (run) => {
    for (let i = 0; i < 3; i += 1) assert.equal((await run.place(TAG)).kind, "passthrough");
  });
  assert.deepEqual(rows(ap).filter((row) => row.count > 0).map((row) => [row.versionId, row.count, row.status, row.errorClass]), [["ver_a", 1, "error", "render_missing_variable"]]);
  await ap.stop();
});

test("rule 5: the sweep writes interrupted when no record carried an error", async () => {
  const { plane, clock, start, slotOf, rows } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  const run = ap.openRun();
  await run.place(TAG);
  run.recordModelCall(TAG, { model: "gpt", latencyMs: 1 });
  clock.ms += 15 * 60_000;
  ap.openRun();
  assert.deepEqual(rows(ap).filter((row) => row.count > 0).map((row) => [row.status, row.errorClass]), [["interrupted", null]]);
  await ap.stop();
});

test("rule 5: a parked run survives ap.run's end, resumes in-process and writes one row", async () => {
  const { plane, start, slotOf, rows } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  let ref = "";
  await ap.run({ subject: "ann" }, async (run) => {
    await run.place(TAG);
    run.recordModelCall(TAG, { model: "gpt", latencyMs: 1, usage: usage(1, 1) });
    run.end({ interrupted: true }); // a person must approve before it goes on
    ref = run.runRef;
  });
  assert.deepEqual(rows(ap).filter((row) => row.count > 0), [], "ap.run's own end does not close a parked run");
  await ap.run({ resume: ref }, async (run) => {
    assert.equal(runIdOf(run.runRef), runIdOf(ref));
    await run.place(TAG);
    run.recordModelCall(TAG, { model: "gpt", latencyMs: 1, usage: usage(2, 2) });
  });
  assert.deepEqual(rows(ap).filter((row) => row.count > 0).map((row) => [row.count, row.modelCalls, row.tokens.input, row.status]), [[1, 2, 3, "ok"]]);
  await ap.stop();
});

test("rule 5: the sweep skips an adapter's tool call whose promise is pending inside withRun", async () => {
  const { plane, clock, start, slotOf, rows } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  let finish = () => {};
  const done = ap.run({}, async (run) => {
    await run.place(TAG);
    await ap.withRun(run, () => new Promise<void>((resolve) => { finish = resolve; }));
    run.recordToolCall(TAG, { ok: true });
  });
  await new Promise((resolve) => setImmediate(resolve));
  clock.ms += 60 * 60_000;
  ap.openRun();
  assert.deepEqual(rows(ap).filter((row) => row.count > 0), []);
  finish();
  await done;
  assert.deepEqual(rows(ap).filter((row) => row.count > 0).map((row) => [row.status, row.tools.calls]), [["ok", 1]]);
  await ap.stop();
});

test("rule 6: no rendered text, output text or tag value reaches the ref or any log event", async () => {
  const { plane, start, events } = fixture();
  plane.promote([plane.slot({ tag: TAG, text: "SECRET-PROMPT {{name}}", versionId: "ver_a", variables: [{ name: "name", required: true, trust: "operator" }] })]);
  const ap = await start();
  let ref = "";
  await ap.run({ subject: "SECRET-SUBJECT", tags: { plan: "SECRET-TAG" }, variables: { name: "SECRET-NAME" } }, async (run) => {
    run.setTags({ late: "SECRET-LATE" });
    await run.place(TAG);
    run.recordModelCall(TAG, { model: "gpt", latencyMs: 1, outputText: "SECRET-OUTPUT" });
    run.slotFor({ known: TAG }, "SECRET-UNMAPPED-NAME-IS-A-NAME");
    ref = run.runRef;
  });
  const decoded = Buffer.from(ref.slice(0, ref.lastIndexOf(".")), "base64url").toString("utf8");
  const logged = JSON.stringify(events);
  for (const secret of ["SECRET-PROMPT", "SECRET-SUBJECT", "SECRET-TAG", "SECRET-NAME", "SECRET-LATE", "SECRET-OUTPUT"]) {
    assert.ok(!decoded.includes(secret), `${secret} is not in the ref`);
    assert.ok(!logged.includes(secret), `${secret} is not in a log event`);
  }
  await ap.stop();
});

test("rule 7: feedback reaches each entry once, slot names one, and model without slot on two entries is refused", async () => {
  const { plane, start, slotOf, experiment, rows } = fixture();
  const a = slotOf("Version A", "ver_a");
  const b = slotOf("Version B", "ver_b");
  const other = plane.slot({ tag: OTHER, text: "Classify", versionId: "ver_c", variables: [] });
  const test = experiment(a, b, 10_000);
  test.arms[0]!.releaseDigest = releaseDigest([a, other]);
  test.arms[1]!.releaseDigest = releaseDigest([b, other]);
  plane.promote([a, other], { experiments: [test] });
  const ap = await start();
  const ref = await ap.run({ subject: "ann" }, async (run) => {
    await run.place(TAG);
    await run.place(OTHER);
    run.recordModelCall(TAG, { model: "gpt", latencyMs: 1 });
    return run.runRef;
  });
  rows(ap);
  assert.equal(ap.feedback(ref, { thumbs: "up" }), true);
  assert.equal(ap.feedback(ref, { thumbs: "down" }, { slot: OTHER }), true);
  assert.equal(ap.feedback(ref, { thumbs: "down" }, { slot: "never.used" }), false);
  assert.equal(ap.feedback(ref, { thumbs: "down" }, { model: "gpt-x" }), false);
  assert.equal(ap.feedback(ref, { thumbs: "down" }, { model: "gpt-x", slot: TAG }), true);
  const outcomes = (rows(ap) as Array<WindowRow & { outcomes?: Record<string, { n: number }> }>).filter((row) => row.outcomes).map((row) => [row.tag, row.arm, row.versionId, row.outcomes!.thumbs!.n]).sort();
  // Feedback on one window merges; the model override is its own window.
  assert.deepEqual(outcomes, [[OTHER, "none", "ver_c", 2], [TAG, "candidate", "ver_b", 1], [TAG, "candidate", "ver_b", 1]]);
  await ap.stop();
});

test("rule 7: a ref minted before a release swap files on its own version; explain decodes it, and null for a forged one", async () => {
  const { plane, start, slotOf, rows } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  const ref = await ap.run({}, async (run) => {
    await run.place(TAG);
    return run.runRef;
  });
  plane.promote([slotOf("Version C", "ver_c")]);
  await ap.syncNow();
  rows(ap);
  assert.equal(ap.feedback(ref, { thumbs: "up" }), true);
  assert.deepEqual((rows(ap) as Array<WindowRow & { outcomes?: object }>).filter((row) => row.outcomes).map((row) => row.versionId), ["ver_a"]);
  assert.deepEqual(ap.explain(ref)!.map((entry) => [entry.tag, entry.versionId, entry.arm]), [[TAG, "ver_a", "none"]]);
  assert.equal(ap.explain(`${ref.slice(0, -2)}xx`), null);
  await ap.stop();
});

test("rule 7: the ref stops at eight entries; a ninth slot is served and measured, with one log", async () => {
  const { plane, start, events, rows } = fixture();
  const tags = Array.from({ length: 9 }, (_, i) => `slot${i}`);
  plane.promote(tags.map((tag) => plane.slot({ tag, text: `Text ${tag}`, versionId: `ver_${tag}`, variables: [] })));
  const ap = await start();
  const ref = await ap.run({}, async (run) => {
    for (const tag of tags) {
      assert.equal((await run.place(tag)).kind, "approved");
      run.recordModelCall(tag, { model: "gpt", latencyMs: 1 });
      void run.runRef;
    }
    return run.runRef;
  });
  assert.deepEqual(ap.explain(ref)!.map((entry) => entry.tag), tags.slice(0, 8));
  assert.equal(rows(ap).filter((row) => row.count > 0).length, 9);
  assert.equal(events.filter((event) => event.event === "run_ref_slots_capped").length, 1);
  await ap.stop();
});

test("rule 8: concurrent place calls on two slots render each once", async () => {
  const { plane, start } = fixture();
  plane.promote([
    plane.slot({ tag: TAG, text: "Hello {{name}}", versionId: "ver_a", variables: [{ name: "name", required: true, trust: "operator" }] }),
    plane.slot({ tag: OTHER, text: "Hi {{name}}", versionId: "ver_c", variables: [{ name: "name", required: true, trust: "operator" }] }),
  ]);
  const ap = await start();
  let calls = 0;
  ap.variables.provide("name", { trust: "operator", resolve: async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return "Ann"; } });
  const run = ap.openRun();
  await Promise.all([run.place(TAG), run.place(OTHER), run.place(TAG), run.place(OTHER)]);
  assert.equal(calls, 2);
  await ap.stop();
});

test("rule 9: a tag set after the first slot reaches the second slot's rule and does not move the first", async () => {
  const { plane, start, slotOf } = fixture();
  const a = slotOf("Version A", "ver_a");
  const b = slotOf("Version B", "ver_b");
  const c = plane.slot({ tag: OTHER, text: "Classify A", versionId: "ver_c", variables: [] });
  const d = plane.slot({ tag: OTHER, text: "Classify B", versionId: "ver_d", variables: [] });
  const selector = { mode: "when" as const, when: { key: "intent", is: "billing" } };
  const audienceOf = (tag: string) => ({ audienceId: tag === TAG ? "aud_AAAAAAAAAAAAAAAAAAAAAA" : "aud_BBBBBBBBBBBBBBBBBBBBBB", selector });
  const arms = (candidate: ManifestSlot, id: string, tag: string): Experiment => ({
    experimentId: id, tag, salt: "AAECAwQFBgcICQoLDA0ODw", subjectKey: "request", audience: audienceOf(tag),
    arms: [
      { arm: "control", weightBps: 0, releaseDigest: releaseDigest([c, a]), overrides: [] },
      { arm: "candidate", weightBps: 10_000, releaseDigest: releaseDigest([c, a].map((slot) => (slot.tag === tag ? candidate : slot))), overrides: [candidate] },
    ],
  });
  plane.promote([c, a], { experiments: [arms(d, "exp_c", OTHER), arms(b, "exp_a", TAG)], observations: [OTHER, TAG].map((tag) => ({ ...audienceOf(tag), tag, observeFrom: "2026-01-01T00:00:00Z" })) });
  const ap = await start();
  await ap.run({ subject: "ann" }, async (run) => {
    const classified = await run.place(OTHER);
    assert.equal(classified.kind === "approved" && classified.instructions, "Classify A", "no intent yet: outside the audience");
    run.setTags({ intent: "billing" });
    const reply = await run.place(TAG);
    assert.equal(reply.kind === "approved" && reply.instructions, "Version B", "the late tag reaches the later slot's rule");
    const again = await run.place(OTHER);
    assert.equal(again.kind === "approved" && again.instructions, "Classify A", "the pinned slot never moves");
  });
  await ap.stop();
});

test("rule 10: an unmapped name and a slot absent from the release each log once and count", async () => {
  const { plane, start, slotOf, events } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  for (let i = 0; i < 2; i += 1) {
    await ap.run({}, async (run) => {
      assert.equal(run.slotFor({ agent: TAG }, "agent"), TAG);
      assert.equal(run.slotFor({ agent: TAG, default: TAG }, "anything"), TAG);
      assert.equal(run.slotFor({ agent: TAG }, "tools"), undefined);
      assert.equal(run.slotFor({ agent: TAG }, "tools"), undefined);
      assert.equal(run.slotFor({ typo: "support.rpely" }, "typo"), undefined);
    });
  }
  assert.equal(events.filter((event) => event.event === "run_step_unmapped").length, 1);
  assert.equal(events.filter((event) => event.event === "run_slot_not_in_release").length, 1);
  assert.deepEqual((ap.heartbeatBody() as { runCounters: { passthrough: Record<string, number> } }).runCounters.passthrough, { unmapped_step: 2, slot_not_in_release: 2 });
  await ap.stop();
});

test("rule 11: one run_placed log per slot, ids only", async () => {
  const { plane, start, slotOf, events } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  await ap.run({}, async (run) => {
    for (let i = 0; i < 3; i += 1) await run.place(TAG);
    await run.place("nothing.here");
  });
  const placed = events.filter((event) => event.event === "run_placed").map(({ event, slot, versionId, artifactId, arm, reason }) => ({ event, slot, versionId, artifactId, arm, reason }));
  assert.deepEqual(placed, [
    { event: "run_placed", slot: TAG, versionId: "ver_a", artifactId: `art_${TAG}`, arm: "none", reason: undefined },
    { event: "run_placed", slot: "nothing.here", versionId: undefined, artifactId: undefined, arm: undefined, reason: "no_slot" },
  ]);
  await ap.stop();
});

test("declared output checks read outputText once and count on the run row", async () => {
  const { plane, start, rows } = fixture();
  plane.promote([{ ...plane.slot({ tag: TAG, text: "Version A", versionId: "ver_a", variables: [] }), outputChecks: [{ kind: "must_match" as const, name: "signed", pattern: "Regards" }] }]);
  const ap = await start();
  await ap.run({}, async (run) => {
    await run.place(TAG);
    run.recordModelCall(TAG, { model: "gpt", latencyMs: 1, outputText: "Kind Regards" });
    run.recordModelCall(TAG, { model: "gpt", latencyMs: 1, outputText: "bye" });
    run.recordModelCall(TAG, { model: "gpt", latencyMs: 1 });
  });
  assert.deepEqual(rows(ap).filter((row) => row.count > 0).map((row) => row.checks), [{ passed: 1, failed: 1 }]);
  await ap.stop();
});

test("direct path: ap.prompt then ap.observe inside ap.run is one run row, and the rendered ref is the run's", async () => {
  const { plane, start, slotOf, rows } = fixture();
  plane.promote([slotOf("Version A", "ver_a"), plane.slot({ tag: OTHER, text: "Classify", versionId: "ver_c", variables: [] })]);
  const ap = await start();
  await ap.run({ subject: "ann" }, async (run) => {
    await run.place(OTHER);
    const rendered = ap.prompt(TAG).render();
    assert.equal(runIdOf(rendered.runRef), runIdOf(run.runRef));
    assert.deepEqual(ap.explain(rendered.runRef)!.map((entry) => entry.tag), [OTHER, TAG]);
    await ap.observe(rendered, async () => ({ usage: { input_tokens: 4, output_tokens: 2 } }));
    await ap.observe(rendered, async () => ({ usage: { input_tokens: 4, output_tokens: 2 } }));
  });
  const written = rows(ap).filter((row) => row.count > 0);
  assert.deepEqual(written.map((row) => [row.tag, row.count, row.modelCalls, row.tokens.input, row.agentRun]), [[OTHER, 1, 0, 0, 1], [TAG, 1, 2, 8, 0]]);
  await ap.stop();
});

test("direct path: ap.workflow inside a run pins, so every call keeps one arm", async () => {
  const { plane, start, experiment } = fixture();
  const a = plane.slot({ tag: TAG, text: "flow", versionId: "ver_a", variables: [], steps: [{ text: "Step A" }] });
  const b = plane.slot({ tag: TAG, text: "flow", versionId: "ver_b", variables: [], steps: [{ text: "Step B" }] });
  plane.promote([a], { experiments: [experiment(a, b)] });
  const ap = await start();
  for (let i = 0; i < 5; i += 1) {
    await ap.run({}, async () => {
      const arms = new Set(Array.from({ length: 10 }, () => ap.workflow(TAG).arm));
      assert.equal(arms.size, 1, "one arm per run");
    });
  }
  await ap.stop();
});

test("two agents in one process: b.currentRun() is undefined inside a.run", async () => {
  const one = fixture();
  const two = fixture();
  one.plane.promote([one.slotOf("Version A", "ver_a")]);
  two.plane.promote([two.slotOf("Version A", "ver_a")]);
  const a = await one.start();
  const b = await two.start();
  await a.run({}, async (run) => {
    assert.equal(a.currentRun(), run);
    assert.equal(b.currentRun(), undefined);
  });
  await a.stop();
  await b.stop();
});

// ------------------------------------------------------------------------------- AIR-2242 review regressions

test("review: two concurrent place calls after the pinned arm is disabled both settle", async () => {
  const { plane, start, slotOf, experiment } = fixture();
  const a = slotOf("Version A", "ver_a");
  const b = slotOf("Version B", "ver_b");
  const t = experiment(a, b, 10_000);
  plane.promote([a], { experiments: [t] });
  const ap = await start();
  const run = ap.openRun({ subject: "ann" });
  assert.equal((await run.place(TAG)).kind, "approved");
  plane.promote([a], { experiments: [t], directives: [disable({ scope: "arm", arm: "candidate", experimentId: "exp_1" })] });
  await ap.syncNow();
  const results = await Promise.allSettled([run.place(TAG), run.place(TAG)]);
  assert.ok(results.every((r) => r.status === "fulfilled"), "place must never throw");
  await ap.stop();
});

test("review: after a re-placed arm, ap.observe on the new arm still folds into the run", async () => {
  const { plane, start, slotOf, experiment, rows } = fixture();
  const a = slotOf("Version A", "ver_a");
  const b = slotOf("Version B", "ver_b");
  const t = experiment(a, b, 10_000);
  plane.promote([a], { experiments: [t] });
  const ap = await start();
  await ap.run({ subject: "ann" }, async () => {
    const r1 = ap.prompt(TAG).render();
    await ap.observe(r1, async () => ({ usage: { input_tokens: 4, output_tokens: 2 } }));
    plane.promote([a], { experiments: [t], directives: [disable({ scope: "arm", arm: "candidate", experimentId: "exp_1" })] });
    await ap.syncNow();
    const r2 = ap.prompt(TAG).render();
    assert.equal(r2.text, "Version A");
    await ap.observe(r2, async () => ({ usage: { input_tokens: 4, output_tokens: 2 } }));
  });
  const written = rows(ap).filter((row) => row.count > 0);
  assert.equal(written.reduce((n, r) => n + r.count, 0), 1, "one request counts once");
  await ap.stop();
});
test("review: inside a run, needs() reads the arm render() uses", async () => {
  const { plane, start, slotOf, experiment } = fixture();
  const a = plane.slot({ tag: TAG, text: "A {{x}}", versionId: "ver_a", variables: [{ name: "x", required: true, trust: "operator" }] });
  const b = slotOf("Version B", "ver_b");
  plane.promote([a], { experiments: [experiment(a, b)] });
  const ap = await start();
  let mismatches = 0;
  for (let i = 0; i < 40; i += 1) {
    await ap.run({ subject: `u${i}` }, async () => {
      const prompt = ap.prompt(TAG);
      const needs = prompt.needs();
      try { const t = prompt.render(needs.length === 1 ? { x: "1" } : {}).text; if (t !== (needs.length === 1 ? "A 1" : "Version B")) mismatches++; } catch { mismatches++; }
    });
  }
  assert.equal(mismatches, 0);
  await ap.stop();
});

test("review: a direct-path slot gets its one run_placed log", async () => {
  const { plane, start, slotOf, events } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  await ap.run({}, async () => { ap.prompt(TAG).render(); });
  const placed = events.filter((e) => e.event === "run_placed");
  assert.equal(placed.length, 1);
  await ap.stop();
});

test("review: the 10,000-run cap never ends a run held open by withRun", async () => {
  const { plane, start, slotOf, rows } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const live = ap.openRun({ subject: "first" });
  await live.place(TAG);
  const p = ap.withRun(live, () => held);
  for (let i = 0; i < 10_000; i += 1) ap.openRun();
  const stillCurrent = ap.withRun(live, () => ap.currentRun() === live);
  release(); await p;
  assert.equal(stillCurrent, true, "a run inside withRun is not idle");
  await ap.stop();
});
test("review: a slot disable keeps the direct-path pin, so the run keeps its version after the disable lifts", async () => {
  const { plane, start, slotOf, experiment, rows } = fixture();
  const a = slotOf("Version A", "ver_a");
  const b = slotOf("Version B", "ver_b");
  plane.promote([a], { experiments: [experiment(a, b, 10_000)] });
  const ap = await start();
  const texts: string[] = [];
  await ap.run({ subject: "ann" }, async () => {
    const r1 = ap.prompt(TAG).render(); texts.push(r1.text);
    await ap.observe(r1, async () => ({ usage: { input_tokens: 1, output_tokens: 1 } }));
    plane.promote([a], { experiments: [experiment(a, b, 10_000)], directives: [disable({ scope: "slot", tag: TAG })] });
    await ap.syncNow();
    try { ap.prompt(TAG).render(); } catch { texts.push("threw"); }
    plane.promote([a], { experiments: [experiment(a, b, 0)] });
    await ap.syncNow();
    const r3 = ap.prompt(TAG).render(); texts.push(r3.text);
    await ap.observe(r3, async () => ({ usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const written = rows(ap).filter((row) => row.count > 0);
  assert.equal(texts[2], "Version B", "the pin stays across a disable");
  await ap.stop();
});

test("the internal lookup finds only a live run by its verified reference and never opens, extends or revives one", async () => {
  // AIR-2231, exception granted by the orchestrator: one read-only lookup in the registry, for adapters whose hooks run
  // without the caller's context. The twin is test_run_session.py › the internal lookup.
  const { plane, clock, start, slotOf } = fixture();
  plane.promote([slotOf("Hello", "ver_1")]);
  const ap = await start();
  const registry = (ap as unknown as { runs: import("../packages/sdk/src/runtime/run/registry.js").RunRegistry }).runs;
  const run = ap.openRun({ subject: "u1" });
  await run.place(TAG);
  const ref = run.runRef;
  const touched = (run as unknown as { lastActive: number }).lastActive;
  clock.ms += 1_000;
  assert.equal(registry.findLive(ref), run, "the live run its reference names");
  assert.equal((run as unknown as { lastActive: number }).lastActive, touched, "a lookup does not extend the run");
  const opened = registry.openRuns;
  for (const bad of [undefined, 42, "", "not.a.ref", `${ref.slice(0, -4)}AAAA`, `${ref}x`]) assert.equal(registry.findLive(bad), undefined, String(bad));
  const foreign = mintRunRef({ agentId: scope.agentId, target: scope.target, runId: runIdOf(ref), entries: [] }, Buffer.alloc(32, 2));
  assert.equal(registry.findLive(foreign), undefined, "a reference signed under another key names no run");
  run.end();
  assert.equal(registry.findLive(ref), undefined, "an ended run is not revived");
  assert.equal(registry.openRuns, opened - 1, "nothing was opened");
  const idle = ap.openRun({ subject: "u2" });
  await idle.place(TAG);
  clock.ms += DEFAULT_RUN_IDLE_TIMEOUT_MS + 1;
  assert.equal(registry.findLive(idle.runRef), undefined, "an idle-expired run is not found, though the sweep has not ended it yet");
  assert.equal((idle as unknown as { isEnded: boolean }).isEnded, false, "the lookup ends nothing either");
  assert.equal("findRun" in ap, false, "not on the agent");
  await ap.stop();
});
