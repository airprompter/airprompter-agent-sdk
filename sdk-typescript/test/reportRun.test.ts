/**
 * `ap.reportRun`: a prompt rendered in one stateless invocation (a Zapier or n8n "Get prompt" step) is counted by a
 * later, separate invocation that holds only the `runRef` and the same Agent key (the "Report run" step), with the
 * tokens, error class and latency the platform's model step returned. The row lands on the slot, version and arm the
 * reference carries, whatever release the reporting process holds by then; the render alone writes no run row, so
 * the run counts exactly once, with usage or without; a forged reference or one under another key writes nothing.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent } from "../packages/sdk/src/agent.js";
import { publicJwkOf, releaseDigest } from "../packages/sdk/src/core/protocol/trust.js";
import { FakeControlPlane } from "../packages/sdk/src/core/testing/index.js";
import type { WindowRow } from "../packages/sdk/src/telemetry/spool/writer.js";

const scope = { organizationId: "org_1", agentId: "agt_report", target: "prod" as const };
const T0 = Date.parse("2026-11-16T12:00:10Z");

/** One stateless step: its own store, its own process identity, the shared Agent key unless told otherwise. */
function step(plane: FakeControlPlane, clock: { ms: number }, events: Array<Record<string, unknown>> = [], extra: { runRefSecret?: string } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-report-"));
  const started = AirPrompterAgent.start({
    ...scope,
    apiKey: plane.apiKey,
    baseUrl: "https://api.test",
    stateDir,
    root: { pinned: publicJwkOf(plane.rootKey) },
    sync: { mode: "on_invoke", rootUrl: "https://edge.test/roots/prod/root.json" },
    fetch: plane.fetch(),
    now: () => clock.ms,
    random: () => 0.5,
    logger: (event) => void events.push(event),
    ...extra,
  });
  return { started, stateDir };
}

/** Every window row the plane received from one instance. */
function windowsOf(plane: FakeControlPlane, instanceId: string): WindowRow[] {
  return plane.uploads
    .filter((key) => key.includes(`/${instanceId}/`))
    .flatMap((key) => plane.objects.get(key)!.toString("utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string }))
    .filter((row): row is WindowRow => row.type === "window");
}

function experimentPlane(clock: { ms: number }) {
  const plane = new FakeControlPlane(scope);
  plane.grantBaseUrl = "https://bucket.test";
  plane.now = () => clock.ms;
  const control = plane.slot({ tag: "support.reply", text: "control {{ticket}}", versionId: "ver_control", model: "gpt-5", variables: [{ name: "ticket", required: false, trust: "end_user" }] });
  const candidate = plane.slot({ tag: "support.reply", text: "candidate {{ticket}}", versionId: "ver_candidate", model: "gpt-5", variables: [{ name: "ticket", required: false, trust: "end_user" }] });
  plane.promote([control], { experiments: [{ tag: control.tag, experimentId: "exp_1", salt: "AAECAwQFBgcICQoLDA0ODw", subjectKey: "request", arms: [{ arm: "control", weightBps: 5000, releaseDigest: releaseDigest([control]), overrides: [] }, { arm: "candidate", weightBps: 5000, releaseDigest: releaseDigest([candidate]), overrides: [candidate] }] }] });
  return { plane, candidate };
}

/** The "Get prompt" step: one invocation that renders a candidate-arm prompt and hands back text and `runRef`. */
async function getPrompt(ap: AirPrompterAgent) {
  return ap.invoke(async () => {
    for (let i = 1; ; i += 1) {
      const rendered = ap.prompt("support.reply", { subject: `request-${i}` }).render({ ticket: "my order is late" });
      if (rendered.arm === "candidate") return rendered;
    }
  });
}

test("a second invocation with only the runRef counts the run once, with its tokens and latency, on the version and arm it rendered", async () => {
  const clock = { ms: T0 };
  const { plane, candidate } = experimentPlane(clock);
  const get = step(plane, clock);
  const report = step(plane, clock);
  const [a, b] = [await get.started, await report.started];
  try {
    const rendered = await getPrompt(a);
    assert.equal(rendered.versionId, "ver_candidate");
    assert.deepEqual(windowsOf(plane, a.instanceId), [], "a render alone writes no run row: the report is the run's only count");

    // The experiment ends and the release moves on before the platform's model step finishes.
    plane.promote([plane.slot({ tag: "support.reply", text: "winner", versionId: "ver_next", model: "claude-sonnet-5" })]);
    clock.ms += 95_000;
    const landed = await b.invoke(async () => b.reportRun(rendered.runRef, { inputTokens: 120, cachedInputTokens: 20, outputTokens: 40, latencyMs: 900 }));
    assert.equal(landed, true);

    const windows = windowsOf(plane, b.instanceId);
    assert.equal(windows.length, 1, "one run row, flushed before invoke() returned");
    const row = windows[0]!;
    assert.deepEqual(
      { tag: row.tag, artifactId: row.artifactId, versionId: row.versionId, arm: row.arm, model: row.model, status: row.status, errorClass: row.errorClass, usageSource: row.usageSource },
      { tag: "support.reply", artifactId: candidate.artifactId, versionId: "ver_candidate", arm: "candidate", model: "gpt-5", status: "ok", errorClass: null, usageSource: "reported" },
      "the reference's slot, version and arm, not the release the reporting process now holds",
    );
    assert.deepEqual({ count: row.count, agentRun: row.agentRun, modelCalls: row.modelCalls }, { count: 1, agentRun: 1, modelCalls: 1 });
    assert.deepEqual(row.tokens, { input: 100, cachedInput: 20, output: 40 }, "input is uncached, as everywhere in the spool");
    assert.equal(row.latencyMs.sum, 900);
    assert.equal(row.latencyMs.buckets.reduce((sum, n) => sum + n, 0), 1);
    assert.deepEqual(row.tokensSq, { input: 10_000, cachedInput: 400, output: 1_600, inputOutput: 4_000, inputCached: 2_000, cachedOutput: 800 });
    assert.equal(row.minute, "2026-11-16T12:01:00Z", "measured in the minute it was reported");

    // Quality from the same step rides on the run's arm, as before.
    assert.equal(b.feedback(rendered.runRef, { thumbs: "up" }), true);
  } finally {
    await a.stop();
    await b.stop();
    rmSync(get.stateDir, { recursive: true, force: true });
    rmSync(report.stateDir, { recursive: true, force: true });
  }
});

test("an error from the platform's model step lands as an error run with its class only", async () => {
  const clock = { ms: T0 };
  const { plane } = experimentPlane(clock);
  const get = step(plane, clock);
  const report = step(plane, clock);
  const [a, b] = [await get.started, await report.started];
  try {
    const first = await getPrompt(a);
    const second = await getPrompt(a);
    const third = await getPrompt(a);
    await b.invoke(async () => {
      assert.equal(b.reportRun(first.runRef, { error: { status: 429, message: "slow down, customer 42" }, latencyMs: 30 }), true);
      assert.equal(b.reportRun(second.runRef, { error: "provider_timeout", inputTokens: 50, outputTokens: 0 }), true, "an error class by name, with the usage it burned");
      assert.equal(b.reportRun(third.runRef, { error: "The model refused: content policy" }), true, "a platform's message is classified, never kept");
    });
    const rows = windowsOf(plane, b.instanceId);
    const byClass = Object.fromEntries(rows.map((row) => [row.errorClass, { status: row.status, count: row.count, usageSource: row.usageSource, arm: row.arm, versionId: row.versionId }]));
    assert.deepEqual(byClass, {
      provider_rate_limited: { status: "error", count: 1, usageSource: "unavailable", arm: "candidate", versionId: "ver_candidate" },
      provider_timeout: { status: "error", count: 1, usageSource: "reported", arm: "candidate", versionId: "ver_candidate" },
      content_filter: { status: "error", count: 1, usageSource: "unavailable", arm: "candidate", versionId: "ver_candidate" },
    });
    const serialized = plane.uploads.map((key) => plane.objects.get(key)!.toString("utf8")).join("\n");
    assert.ok(!serialized.includes("customer 42") && !serialized.includes("content policy") && !serialized.includes("my order is late"), "no message, prompt text or variable value reaches the spool");
  } finally {
    await a.stop();
    await b.stop();
    rmSync(get.stateDir, { recursive: true, force: true });
    rmSync(report.stateDir, { recursive: true, force: true });
  }
});

test("a run reported with no usage still counts once, with an upper-bound latency; nothing double-counts", async () => {
  const clock = { ms: T0 };
  const { plane } = experimentPlane(clock);
  const get = step(plane, clock);
  const report = step(plane, clock);
  const [a, b] = [await get.started, await report.started];
  try {
    const rendered = await getPrompt(a);
    clock.ms += 7_000;
    assert.equal(await b.invoke(async () => b.reportRun(rendered.runRef)), true);
    const rows = [...windowsOf(plane, a.instanceId), ...windowsOf(plane, b.instanceId)];
    assert.equal(rows.reduce((sum, row) => sum + row.count, 0), 1, "the render and the report together are one run");
    const row = rows[0]!;
    assert.deepEqual({ status: row.status, usageSource: row.usageSource, tokens: row.tokens, arm: row.arm }, { status: "ok", usageSource: "unavailable", tokens: { input: 0, output: 0 }, arm: "candidate" });
    assert.equal(row.latencyMs.sum, 17_000, "no measured duration: the time since the minute the prompt rendered");
  } finally {
    await a.stop();
    await b.stop();
    rmSync(get.stateDir, { recursive: true, force: true });
    rmSync(report.stateDir, { recursive: true, force: true });
  }
});

test("a forged reference, one under another key, a slot the run did not use, or a value out of range writes nothing", async () => {
  const clock = { ms: T0 };
  const { plane } = experimentPlane(clock);
  const events: Array<Record<string, unknown>> = [];
  const get = step(plane, clock);
  const report = step(plane, clock, events);
  const stranger = step(plane, clock, [], { runRefSecret: "another-agents-secret" });
  const [a, b, c] = [await get.started, await report.started, await stranger.started];
  try {
    const rendered = await getPrompt(a);
    const [body, mac] = [rendered.runRef.slice(0, rendered.runRef.lastIndexOf(".")), rendered.runRef.slice(rendered.runRef.lastIndexOf(".") + 1)];
    const forgedBody = Buffer.from(Buffer.from(body, "base64url").toString("utf8").replace("ver_candidate", "ver_control").replace('"candidate"', '"control"'), "utf8").toString("base64url");
    await b.invoke(async () => {
      assert.equal(b.reportRun(`${forgedBody}.${mac}`, { inputTokens: 1, outputTokens: 1 }), false, "an edited body fails its MAC");
      assert.equal(b.reportRun("not-a-ref", { inputTokens: 1, outputTokens: 1 }), false);
      assert.equal(b.reportRun(rendered.runRef, { slot: "support.other" }), false);
      assert.equal(b.reportRun(rendered.runRef, { inputTokens: -1, outputTokens: 1 }), false);
      assert.equal(b.reportRun(rendered.runRef, { inputTokens: 1.5, outputTokens: 1 }), false);
      assert.equal(b.reportRun(rendered.runRef, { inputTokens: 10, cachedInputTokens: 11, outputTokens: 1 }), false);
      assert.equal(b.reportRun(rendered.runRef, { latencyMs: Number.NaN }), false);
      assert.equal(b.reportRun(rendered.runRef, { model: "bad\nmodel" }), false);
    });
    assert.equal(await c.invoke(async () => c.reportRun(rendered.runRef, { inputTokens: 1, outputTokens: 1 })), false, "a reference minted under another key");
    assert.deepEqual(windowsOf(plane, b.instanceId), []);
    assert.deepEqual(windowsOf(plane, c.instanceId), []);
    assert.deepEqual(
      events.filter((event) => event.event === "run_report_rejected").map((event) => event.reason),
      ["run_ref_invalid", "run_ref_invalid", "slot_not_in_run", "invalid_inputTokens", "invalid_inputTokens", "invalid_cachedInputTokens", "invalid_latencyMs", "invalid_model"],
    );
  } finally {
    for (const ap of [a, b, c]) await ap.stop();
    for (const dir of [get.stateDir, report.stateDir, stranger.stateDir]) rmSync(dir, { recursive: true, force: true });
  }
});

test("a reference naming several slots needs the slot the model step ran", async () => {
  const clock = { ms: T0 };
  const plane = new FakeControlPlane(scope);
  plane.grantBaseUrl = "https://bucket.test";
  plane.now = () => clock.ms;
  plane.promote([plane.slot({ tag: "support.reply", text: "reply", versionId: "ver_reply" }), plane.slot({ tag: "support.triage", text: "triage", versionId: "ver_triage" })]);
  const get = step(plane, clock);
  const report = step(plane, clock);
  const [a, b] = [await get.started, await report.started];
  try {
    // A multi-slot reference comes from a run session, which counts itself; reading one here must still pick one slot.
    const runRef = await a.invoke(async () => {
      const run = a.openRun();
      const ref = a.withRun(run, () => {
        a.prompt("support.reply").render({});
        return a.prompt("support.triage").render({}).runRef;
      });
      return ref;
    });
    assert.equal(b.explain(runRef)?.length, 2);
    assert.equal(b.reportRun(runRef, { inputTokens: 1, outputTokens: 1 }), false);
    assert.equal(b.reportRun(runRef, { slot: "support.triage", inputTokens: 1, outputTokens: 1 }), true);
  } finally {
    await a.stop();
    await b.stop();
    rmSync(get.stateDir, { recursive: true, force: true });
    rmSync(report.stateDir, { recursive: true, force: true });
  }
});
