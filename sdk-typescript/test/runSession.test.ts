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
import { publicJwkOf, releaseDigest, signBytes } from "../packages/core/src/protocol/trust.js";
import { canonicalBytes } from "../packages/core/src/protocol/canonicalJson.js";
import { FakeControlPlane } from "../packages/core/src/testing/index.js";
import type { Directive, Experiment, ManifestSlot } from "../packages/core/src/protocol/types.js";
import type { ErrorClass } from "../packages/core/src/telemetry/rows.js";

const scope = { organizationId: "org_1", agentId: "agt_run", target: "prod" as const };
const TAG = "support.reply";
const T0 = 1_789_300_800_000;

type WindowRow = { type: string; tag: string; arm: string; versionId: string; count: number; status: string; errorClass: string | null; usageSource: string; tokens: { input: number; output: number; cachedInput?: number }; latencyMs: { sum: number } };

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
  return { plane, clock, events, start, slotOf, experiment, rows };
}

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
    assert.equal(await textOf({ resume: `u${i}` }), await textOf({ subject: `u${i}` }), "the run id hashes like a subject");
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

test("end twice writes once; a run with no model call writes nothing", async () => {
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
  assert.deepEqual(rows(ap).filter((row) => row.count > 0).map((row) => [row.count, row.tokens.input, row.status]), [[1, 1, "ok"]]);
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
  assert.equal(ap.openRun({ resume: run.id }), run, "the run is still live, and idle time restarts when the tool returns");
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
  assert.equal(ap.openRun({ resume: run.id }), run);
  const before = await run.place(TAG);
  clock.ms += 15 * 60_000;
  const resumed = ap.openRun({ resume: run.id, subject: "ann" });
  assert.notEqual(resumed, run);
  assert.equal(resumed.id, run.id);
  assert.equal(ap.openRun({ resume: run.id, subject: "ann" }), resumed);
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
  assert.notEqual(ap.openRun({ resume: run.id }), run);
  assert.deepEqual(rows(ap).filter((row) => row.count > 0).map((row) => row.count), [1]);
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
  assert.equal(ap.openRun({ resume: run.id }), run);
  await ap.stop();
});

test("a lapsed lease under halt stops a first placement and a pinned one", async () => {
  const { plane, clock, start, slotOf } = fixture();
  plane.promote([slotOf("Version A", "ver_a")], { leaseSeconds: 60, onLeaseExpiry: "halt" });
  const ap = await start();
  const run = ap.openRun();
  assert.equal((await run.place(TAG)).kind, "approved");
  clock.ms += 120_000;
  assert.deepEqual(await run.place(TAG), { kind: "passthrough", slot: TAG, reason: "lease_expired" });
  assert.deepEqual(await ap.openRun().place(TAG), { kind: "passthrough", slot: TAG, reason: "lease_expired" });
  await ap.stop();
});

test("run tags reach the experiment's audience, and their names reach the heartbeat", async () => {
  const { plane, start, slotOf, experiment } = fixture();
  const a = slotOf("Version A", "ver_a");
  const b = slotOf("Version B", "ver_b");
  const audience = { audienceId: "aud_AAAAAAAAAAAAAAAAAAAAAA", selector: { mode: "tags" as const, conditions: [{ key: "plan", operator: "is" as const, value: "pro" }] } };
  const manifest = plane.promote([a], { protocol: "2.0.0", experiments: [{ ...experiment(a, b, 10_000), audience }] });
  manifest.payload.requiredCapabilities = ["audience"];
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

test("runRef is undefined until the slot is placed; the id is fixed at open", async () => {
  const { plane, start, slotOf } = fixture();
  plane.promote([slotOf("Version A", "ver_a")]);
  const ap = await start();
  const run = ap.openRun();
  const { id } = run;
  assert.equal(run.runRef, undefined);
  await run.place(TAG);
  assert.equal(typeof run.runRef, "string");
  assert.equal(run.id, id);
  await ap.stop();
});
