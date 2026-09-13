/**
 * S5 (AIR-1973): telemetry without a daemon.
 *
 * D52 says the daemon is an optimisation, never a requirement. These cases
 * prove it for the spool: a resident host with no daemon uploads its own
 * closed segments under its own grant, in-process, off the request path;
 * with no grant the budget holds and the loss is counted, never silent; a
 * grant that lapses mid-run is replaced before the POST; a serverless
 * invocation's rows land before `invoke()` returns, and the documented
 * opt-out hands the flush to the event loop instead.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent } from "../src/agent.js";
import { publicJwkOf } from "../src/protocol/trust.js";
import { SlotStore } from "../src/store/slotStore.js";
import { FakeControlPlane } from "../src/testing/index.js";

const scope = { organizationId: "org_1", agentId: "agt_upload", target: "prod" as const };
const T0 = Date.parse("2026-09-13T12:00:00Z");

function host(plane: FakeControlPlane, stateDir: string, clock: { ms: number }, telemetry: { upload?: boolean; spoolBudgetBytes?: number; flush?: "await" | "background"; sink?: "memory" | "directory" } = {}, mode: "resident" | "on_invoke" = "resident") {
  return AirPrompterAgent.start({
    ...scope,
    apiKey: plane.apiKey,
    baseUrl: "https://api.test",
    stateDir,
    root: { pinned: publicJwkOf(plane.rootKey) },
    sync: { mode, pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" },
    fetch: plane.fetch(),
    now: () => clock.ms,
    random: () => 0.5,
    telemetry,
  });
}

const spoolDir = (stateDir: string) => join(SlotStore.path({ stateDir, ...scope }), "spool", "telemetry");
const unsent = (stateDir: string) => readdirSync(spoolDir(stateDir)).filter((n) => n.startsWith("seg-") && n.endsWith(".ndjson"));
const prefix = (instanceId: string) => `org/${scope.organizationId}/agent/${scope.agentId}/${scope.target}/${instanceId}/`;

async function settled(ap: AirPrompterAgent): Promise<void> {
  while (ap.status().heartbeat.lastAt === null) await new Promise((resolve) => setTimeout(resolve, 10));
}

test("no daemon, grant present: a resident host uploads its own closed segments under its own grant, deletes them from the spool, and its heartbeat says so", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-uphost-"));
  const plane = new FakeControlPlane(scope);
  plane.grantBaseUrl = "https://bucket.test";
  const clock = { ms: T0 };
  plane.now = () => clock.ms;
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply to {{name}}", variables: [{ name: "name", required: false, trust: "operator" }] })]);
  const ap = await host(plane, stateDir, clock);
  try {
    await settled(ap);
    assert.ok(ap.status().upload, "a resident host with a key and a directory spool runs its own uploader");
    assert.equal(ap.status().upload!.sentSegments, 0);
    assert.ok(ap.status().upload!.nextPassAt, "scheduled, off the request path");
    const r = ap.prompt("support.reply").render({ name: "x" });
    ap.report({ tag: r.tag, versionId: r.versionId, arm: r.arm, model: r.model, status: "ok", latencyMs: 12, tokens: { input: 3, output: 4 } });
    ap.spool.closeWindows(clock.ms);
    assert.equal(unsent(stateDir).length, 1, "one closed segment waits in the spool");
    const pass = await ap.uploadNow();
    assert.deepEqual(pass, { uploaded: 1, quarantined: 0, dropped: 0, held: false });
    assert.equal(unsent(stateDir).length, 0, "acknowledged: gone from the spool");
    assert.equal(existsSync(join(spoolDir(stateDir), "sent")), false, "S6: deleted on ack, nothing parked");
    assert.equal(plane.uploads.length, 1);
    assert.ok(plane.uploads[0]!.startsWith(prefix(ap.instanceId)), "under this runtime's own prefix");
    assert.ok(plane.grants.every((g) => g.instanceId === ap.instanceId), "the only grant ever asked for is this runtime's own");
    const rows = plane.objects.get(plane.uploads[0]!)!.toString("utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; instanceId: string; count?: number });
    assert.deepEqual(rows.map((x) => [x.type, x.instanceId, x.count]), [["window", ap.instanceId, 1]]);
    assert.equal(ap.status().upload!.sentSegments, 1);
    assert.equal(ap.status().upload!.lastUploadAt, new Date(clock.ms).toISOString());
    const spool = ap.heartbeatBody().spool as { depthSegments: number; droppedSegments: number; lastUploadAt?: string };
    assert.deepEqual({ depth: spool.depthSegments, dropped: spool.droppedSegments, last: spool.lastUploadAt }, { depth: 0, dropped: 0, last: new Date(clock.ms).toISOString() }, "the heartbeat carries what the uploader knows");
  } finally {
    await ap.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("no daemon, no grant: the spool holds within its budget, the oldest segments past it are dropped and counted, and a grant that lapses mid-run is replaced before the POST", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-uphost-"));
  const plane = new FakeControlPlane(scope);
  plane.grantBaseUrl = "https://bucket.test";
  plane.grantHold = { retryAfterSeconds: 120 };
  const clock = { ms: T0 };
  plane.now = () => clock.ms;
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply to {{name}}", variables: [{ name: "name", required: false, trust: "operator" }] })]);
  const events: Record<string, unknown>[] = [];
  const ap = await AirPrompterAgent.start({ ...scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" }, fetch: plane.fetch(), now: () => clock.ms, random: () => 0.5, telemetry: { spoolBudgetBytes: 1024 * 1024 }, logger: (e) => events.push(e) });
  try {
    await settled(ap);
    // Six minutes of one-row windows, each its own closed segment.
    const r = ap.prompt("support.reply").render({ name: "x" });
    for (let i = 0; i < 6; i += 1) {
      ap.report({ tag: r.tag, versionId: r.versionId, arm: r.arm, model: r.model, status: "ok", latencyMs: 10 + i });
      clock.ms += 60_000;
      ap.spool.closeWindows(clock.ms);
    }
    assert.equal(unsent(stateDir).length, 6);
    let pass = await ap.uploadNow();
    assert.equal(pass!.held, true, "no grant: the pass holds");
    assert.equal(pass!.uploaded, 0);
    assert.equal(unsent(stateDir).length, 6, "under budget: nothing is lost");
    assert.equal(ap.status().upload!.backoffUntil, new Date(clock.ms + 120_000).toISOString(), "held until retryAfter");
    assert.equal(plane.uploads.length, 0);
    // The budget is the uploader's, the same sweep the daemon runs: past it the oldest segments go, and one dropped row says so.
    (ap as unknown as { uploader: { options: { budgetBytes: number } } }).uploader.options.budgetBytes = 700;
    clock.ms += 121_000;
    pass = await ap.uploadNow();
    assert.ok(pass!.dropped >= 1 && pass!.dropped <= 5, `dropped ${pass!.dropped}`);
    assert.equal(ap.status().upload!.droppedSegments, pass!.dropped);
    assert.equal(unsent(stateDir).length + pass!.dropped, 7, "what the sweep evicted plus the dropped row it wrote");
    assert.equal((ap.heartbeatBody().spool as { droppedSegments: number }).droppedSegments, pass!.dropped, "counted on the heartbeat, never silent");
    assert.ok(events.some((e) => e.component === "uploader" && e.event === "spool_evicted"), JSON.stringify(events.filter((e) => e.component === "uploader")));

    // The grant arrives, then lapses between two passes: the uploader replaces it a minute early, before any POST.
    plane.grantHold = null;
    clock.ms += 121_000; // past the hold the second pass renewed
    pass = await ap.uploadNow();
    assert.equal(pass!.held, false);
    assert.ok(pass!.uploaded >= 1, "everything left in the spool went, the dropped row with it");
    assert.equal(unsent(stateDir).length, 0);
    const grantsBefore = plane.grants.length;
    ap.report({ tag: r.tag, versionId: r.versionId, arm: r.arm, model: r.model, status: "ok", latencyMs: 9 });
    clock.ms += 16 * 60_000; // past the 15-minute grant
    ap.spool.closeWindows(clock.ms);
    pass = await ap.uploadNow();
    assert.deepEqual({ uploaded: pass!.uploaded, held: pass!.held }, { uploaded: 1, held: false });
    assert.equal(plane.grants.length, grantsBefore + 1, "a fresh grant before the POST; the lapsed one was never tried");
    assert.ok(plane.uploads.every((k) => k.startsWith(prefix(ap.instanceId))));
  } finally {
    await ap.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("telemetry.upload: false leaves the spool alone (a daemon or an operator's export owns it), and a memory sink runs no uploader", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-uphost-"));
  const plane = new FakeControlPlane(scope);
  plane.grantBaseUrl = "https://bucket.test";
  const clock = { ms: T0 };
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply." })]);
  const off = await host(plane, stateDir, clock, { upload: false });
  assert.equal(off.status().upload, null);
  assert.equal(await off.uploadNow(), null);
  const r = off.prompt("support.reply").render({});
  off.report({ tag: r.tag, versionId: r.versionId, arm: r.arm, model: r.model, status: "ok", latencyMs: 1 });
  off.spool.closeWindows(clock.ms);
  assert.equal(unsent(stateDir).length, 1, "the segment stays for whoever owns the spool");
  await off.stop();
  const memory = await host(plane, stateDir, clock, { sink: "memory" });
  assert.equal(memory.status().upload, null, "a memory sink has nothing to sweep; flushTelemetry() is its path");
  await memory.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

test("serverless: the invocation's rows land before invoke() returns; flush: \"background\" is the opt-out that returns first", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-uphost-"));
  const plane = new FakeControlPlane(scope);
  plane.grantBaseUrl = "https://bucket.test";
  const clock = { ms: T0 };
  plane.now = () => clock.ms;
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply." })]);
  const awaited = await host(plane, stateDir, clock, {}, "on_invoke");
  try {
    const r = awaited.prompt("support.reply").render({});
    await awaited.invoke(async () => awaited.report({ tag: r.tag, versionId: r.versionId, arm: r.arm, model: r.model, status: "ok", latencyMs: 12 }));
    assert.equal(plane.uploads.length, 1, "landed before the handler's caller got control back — a frozen process loses nothing");
    assert.ok(plane.uploads[0]!.startsWith(prefix(awaited.instanceId)));
    assert.deepEqual(awaited.drainMemorySink(), []);
  } finally {
    await awaited.stop();
  }
  const background = await host(plane, stateDir, clock, { flush: "background" }, "on_invoke");
  try {
    const r = background.prompt("support.reply").render({});
    await background.invoke(async () => background.report({ tag: r.tag, versionId: r.versionId, arm: r.arm, model: r.model, status: "ok", latencyMs: 12 }));
    assert.equal(plane.uploads.length, 1, "background: the flush is still in flight when invoke() returns");
    const deadline = Date.now() + 5000;
    while (plane.uploads.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(plane.uploads.length, 2, "…and lands when the event loop gets to it");
  } finally {
    await background.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
