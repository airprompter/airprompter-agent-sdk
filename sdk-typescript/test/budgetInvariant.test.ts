/**
 * S6 (AIR-1974): the disk budget is a published invariant.
 *
 *   tree ≤ budget + (writers × 1 MiB open) + quarantine cap + exported cap
 *
 * These cases prove each term on the filling `MemoryFs` with no registry
 * (the sink absent): two writers over budget with a crash mid-open lose
 * exactly the oldest unsent segments and say so in one `dropped` row with
 * the right byte count; the abandoned `.open` is reclaimed and the live one
 * left alone; `quarantine/` and `exported/` are held under their caps
 * oldest-first; acknowledged segments are deleted, so nothing acknowledged
 * counts; every process is its own instance; and an idle writer's last
 * minute closes on the spool timer, never parked in an `.open` file.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent } from "../src/agent.js";
import { publicJwkOf } from "../src/protocol/trust.js";
import { epochMinute, segmentName, SEGMENT_MAX_BYTES, SpoolWriter, type SpoolRow } from "../src/spool/writer.js";
import { SlotStore } from "../src/store/slotStore.js";
import { OPEN_SEGMENT_RECLAIM_MS, QUARANTINE_CAP_BYTES, SEGMENT_NAME, SpoolUploader } from "../src/telemetry/uploader.js";
import { FakeControlPlane, MemoryFs } from "../src/testing/index.js";
import { MemorySink } from "../src/spool/writer.js";

const T0 = Date.parse("2026-09-13T12:00:10Z");
const WRITER_A = "i-writerAAAAAAAA";
const WRITER_B = "i-writerBBBBBBBB";
const DIR = "/spool";

function windowRow(instanceId: string, minute: string): SpoolRow {
  return { type: "window", v: 1, minute, instanceId, instanceClass: "resident", tag: "support.reply", versionId: "ver_1", arm: "none", model: "gpt-5", status: "ok", errorClass: null, usageSource: "reported", count: 1, latencyMs: { buckets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0], sum: 812 }, tokens: { input: 40, output: 9 }, sdk: "agent-sdk-ts/0.1.0" };
}

function segment(fs: MemoryFs, instanceId: string, minuteMs: number, n: number, rows: SpoolRow[], open = false): string {
  const name = segmentName(instanceId, epochMinute(minuteMs), n) + (open ? ".open" : "");
  fs.writeFile(join(DIR, name), Buffer.from(rows.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8"), 0o600);
  return name;
}

const closed = (fs: MemoryFs) => fs.list(DIR).filter((n) => SEGMENT_NAME.test(n)).sort();

test("two writers over budget with a crash mid-open, sink absent: exactly the oldest unsent segments go, one dropped row says the bytes, the abandoned .open is reclaimed and the live one left alone, and the tree stays under the published bound", () => {
  const fs = new MemoryFs();
  fs.clockMs = T0;
  fs.mkdirp(DIR, 0o700);
  const events: Record<string, unknown>[] = [];
  const uploader = new SpoolUploader({ dir: DIR, instanceId: "i-hostprocess000", grantFor: async () => ({ kind: "unavailable", reason: "sink_absent" }), fetch: async () => { throw new Error("no registry"); }, fs, now: () => fs.clockMs, random: () => 0.5, logger: (e) => events.push(e), budgetBytes: 900, quarantineCapBytes: 4096, exportedCapBytes: 4096 });
  // Five one-row segments alternate between two writers over five minutes; each is ~380 bytes, so three do not fit in 900.
  const names: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    fs.clockMs = T0 + i * 60_000;
    names.push(segment(fs, i % 2 === 0 ? WRITER_A : WRITER_B, fs.clockMs, 0, [windowRow(i % 2 === 0 ? WRITER_A : WRITER_B, new Date(T0 + i * 60_000).toISOString().slice(0, 17) + "00Z")]));
  }
  const each = fs.stat(join(DIR, names[0]!)).size;
  assert.ok(each * 3 > 900 && each * 2 <= 900, `segment ${each} bytes`);
  // A crashed writer's .open from two hours ago, and a live writer's .open from this minute.
  fs.clockMs = T0 - 2 * 60 * 60_000;
  const abandoned = segment(fs, "i-crashed0000000", fs.clockMs, 0, [windowRow("i-crashed0000000", "2026-09-13T10:00:00Z")], true);
  fs.clockMs = T0 + 5 * 60_000;
  const live = segment(fs, WRITER_A, fs.clockMs, 0, [windowRow(WRITER_A, "2026-09-13T12:05:00Z")], true);

  const result = uploader.runOnce();
  return result.then((pass) => {
    // The reclaimed segment is the oldest of all (10:00): six closed segments, two fit in 900 — it and the three oldest of the five went.
    assert.equal(uploader.status().reclaimedSegments, 1, "the abandoned .open was closed");
    assert.ok(events.some((e) => e.event === "open_segment_reclaimed" && e.segment === abandoned.slice(0, -".open".length)));
    assert.equal(pass.dropped, 4);
    assert.equal(pass.held, true, "sink absent: nothing uploads");
    const remaining = closed(fs);
    const dropped = remaining.find((n) => n.startsWith("seg-i-hostprocess000-"));
    assert.ok(dropped, "the loss was written as the uploader's own segment");
    assert.deepEqual(remaining.filter((n) => n !== dropped), [names[3]!, names[4]!].sort(), "exactly the oldest unsent segments were evicted");
    const row = JSON.parse(Buffer.from(fs.readFile(join(DIR, dropped!))).toString("utf8").trim()) as { type: string; segments: number; bytes: number; instanceId: string };
    const reclaimedBytes = Buffer.byteLength(`${JSON.stringify(windowRow("i-crashed0000000", "2026-09-13T10:00:00Z"))}\n`);
    assert.deepEqual(row, { ...row, type: "dropped", segments: 4, bytes: each * 3 + reclaimedBytes, instanceId: "i-hostprocess000" }, "the dropped row names the bytes that actually went");
    assert.ok(fs.exists(join(DIR, live)), "the live writer's .open is not touched");
    assert.equal(fs.exists(join(DIR, abandoned)), false);
    const tree = uploader.status().tree;
    assert.deepEqual({ open: tree.openSegments, quarantine: tree.quarantineBytes, exported: tree.exportedBytes }, { open: 1, quarantine: 0, exported: 0 });
    assert.ok(tree.totalBytes <= uploader.bound(1), `tree ${tree.totalBytes} ≤ bound ${uploader.bound(1)}`);
    assert.ok(uploader.status().depth.bytes <= 900, "closed unsent within the budget");
    assert.equal(uploader.bound(2), 900 + 2 * SEGMENT_MAX_BYTES + 4096 + 4096, "the formula, in numbers");
  });
});

test("quarantine/ and exported/ are capped in bytes, oldest first; a buggy third-party writer cannot fill the disk through quarantine", async () => {
  const fs = new MemoryFs();
  fs.clockMs = T0;
  fs.mkdirp(DIR, 0o700);
  const uploader = new SpoolUploader({ dir: DIR, instanceId: "i-hostprocess000", grantFor: async () => ({ kind: "unavailable", reason: "sink_absent" }), fetch: async () => { throw new Error("no registry"); }, fs, now: () => fs.clockMs, random: () => 0.5, quarantineCapBytes: 1000, exportedCapBytes: 500 });
  // Six malformed segments from a stranger (a field the contract has no place for), ~420 bytes each.
  const bad: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    fs.clockMs = T0 + i * 60_000;
    bad.push(segment(fs, "i-thirdparty0000", fs.clockMs, 0, [{ ...windowRow("i-thirdparty0000", "2026-09-13T12:00:00Z"), prompt: "You are a helpful assistant" } as unknown as SpoolRow]));
  }
  await uploader.runOnce();
  assert.equal(uploader.status().quarantinedSegments, 6, "every one was quarantined");
  // The cap is enforced on the next sweep: the oldest go first until the directory fits.
  await uploader.runOnce();
  const kept = fs.list(join(DIR, "quarantine")).sort();
  assert.ok(uploader.status().tree.quarantineBytes <= 1000, `quarantine ${uploader.status().tree.quarantineBytes} B`);
  assert.ok(kept.length >= 1 && kept.length < 6);
  assert.deepEqual(kept, bad.slice(6 - kept.length), "the newest survive; the oldest went");
  assert.equal(uploader.status().capEvictedFiles, 6 - kept.length);
  // exported/ (an offline host's packed segments) is held the same way.
  for (let i = 0; i < 3; i += 1) fs.writeFile(join(DIR, "exported", segmentName(WRITER_A, epochMinute(T0) + i, 0)), Buffer.alloc(300, 0x78), 0o600);
  await uploader.runOnce();
  assert.ok(uploader.status().tree.exportedBytes <= 500);
  assert.equal(fs.list(join(DIR, "exported")).length, 1, "two of three 300-byte files went to fit 500");
  assert.equal(QUARANTINE_CAP_BYTES, 10 * 1024 * 1024, "the default cap is 10 MiB");
  assert.equal(OPEN_SEGMENT_RECLAIM_MS, 60 * 60 * 1000, "an .open is abandoned after an hour untouched");
});

test("an idle writer's last minute closes on the stale-window sweep, never the current minute", () => {
  const sink = new MemorySink({ instanceId: WRITER_A });
  const writer = new SpoolWriter(sink, { instanceId: WRITER_A, instanceClass: "resident", sdk: "test/0" });
  let clock = T0;
  writer.observe({ tag: "support.reply", versionId: "ver_1", arm: "none", model: "gpt-5", status: "ok", latencyMs: 5, usageSource: "unavailable" }, clock);
  assert.equal(writer.openWindowCount, 1);
  writer.closeStaleWindows(clock + 10_000);
  assert.equal(writer.openWindowCount, 1, "the same minute: the window stays open, no split row");
  clock += 60_000;
  writer.closeStaleWindows(clock);
  assert.equal(writer.openWindowCount, 0, "the minute passed: written and closed");
  assert.equal(sink.drain(clock).length, 1);
});

test("every process is its own instance: two runtimes on one store report distinct ids, never the store's, and one host uploader carries both writers under their own prefixes", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-instances-"));
  const scope = { organizationId: "org_1", agentId: "agt_workers", target: "prod" as const };
  const plane = new FakeControlPlane(scope);
  plane.grantBaseUrl = "https://bucket.test";
  const clock = { ms: T0 };
  plane.now = () => clock.ms;
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply." })]);
  const start = () => AirPrompterAgent.start({ ...scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" }, fetch: plane.fetch(), now: () => clock.ms, random: () => 0.5 });
  const a = await start();
  const b = await start();
  try {
    const storeId = (await SlotStore.open({ stateDir, ...scope, keyProvider: (await import("../src/store/keyProvider.js")).fileKey(join(SlotStore.path({ stateDir, ...scope }), "store.key")) })).instanceId;
    assert.notEqual(a.instanceId, b.instanceId, "N workers are N instances");
    assert.notEqual(a.instanceId, storeId, "the store's id is the store's, not a process's");
    assert.notEqual(b.instanceId, storeId);
    while (a.status().heartbeat.lastAt === null || b.status().heartbeat.lastAt === null) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(new Set(plane.heartbeats.map((h) => h.instanceId)), new Set([a.instanceId, b.instanceId]), "the fleet sees both");
    for (const ap of [a, b]) {
      const r = ap.prompt("support.reply").render({});
      ap.report({ tag: r.tag, versionId: r.versionId, arm: r.arm, model: r.model, status: "ok", latencyMs: 3 });
      ap.spool.closeWindows(clock.ms);
    }
    const spool = join(SlotStore.path({ stateDir, ...scope }), "spool", "telemetry");
    assert.equal(readdirSync(spool).filter((n) => SEGMENT_NAME.test(n)).length, 2, "two writers, two segments, one spool");
    // One process's uploader sweeps the whole directory: each segment goes under its own writer's prefix, with that writer's grant.
    const pass = await a.uploadNow();
    assert.equal(pass!.uploaded, 2);
    assert.deepEqual(new Set(plane.uploads.map((k) => k.split("/")[5])), new Set([a.instanceId, b.instanceId]));
    assert.deepEqual(new Set(plane.grants.map((g) => g.instanceId)), new Set([a.instanceId, b.instanceId]), "one grant per writer");
    assert.equal(readdirSync(spool).filter((n) => SEGMENT_NAME.test(n)).length, 0, "deleted on ack");
  } finally {
    await a.stop();
    await b.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
