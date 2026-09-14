/**
 * S2 (AIR-1970): the spool never throws on the request path, and what it
 * cannot keep it says. Every case runs over `MemoryFs` — a filesystem that
 * fills, fails and loses files — because a forgiving fake hides every budget
 * bug. Two writers, two segments over budget, a crash mid-open, no daemon:
 * the ticket's own list.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { DirectorySink, HOST_SPOOL_BUDGET_BYTES, SpoolWriter, type SpoolRow } from "../packages/telemetry/src/spool/writer.js";
import { SlotStore } from "../packages/sync/src/store/slotStore.js";
import { customKeyProvider } from "../packages/sync/src/store/keyProvider.js";
import { SpoolUploader } from "../packages/telemetry/src/uploader.js";
import { FakeClock, MemoryFs } from "../packages/core/src/testing/index.js";

const DIR = "/state/airprompter/agt_1/prod/spool/telemetry";
const MINUTE = Date.UTC(2026, 8, 13, 12, 0, 0);
/** One `dropped` row as its own closed segment — the report the sweep writes after evicting. */
const REPORT_SEGMENT_BYTES = 160;

function rowOf(sink: DirectorySink, n: number, at: number): SpoolRow {
  return { type: "refusal", v: 1, at: new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z"), instanceId: "i-writer-a", reason: "lease_expired", generation: n, tag: null };
}

function rowsOnDisk(fs: MemoryFs, dir = DIR): SpoolRow[] {
  const rows: SpoolRow[] = [];
  for (const name of fs.list(dir).filter((n) => n.startsWith("seg-") && n.endsWith(".ndjson")).sort()) {
    for (const line of Buffer.from(fs.readFile(`${dir}/${name}`)).toString("utf8").split("\n").filter(Boolean)) rows.push(JSON.parse(line) as SpoolRow);
  }
  return rows;
}

test("a full disk does not reach the caller: rows are counted while it is full and reported as one dropped row when writing works again", () => {
  const fs = new MemoryFs();
  const sink = new DirectorySink(DIR, "i-writer-a", HOST_SPOOL_BUDGET_BYTES, fs);
  sink.append(rowOf(sink, 1, MINUTE), MINUTE);
  const written = fs.bytesUsed();
  fs.capacityBytes = written; // full from here
  assert.doesNotThrow(() => sink.append(rowOf(sink, 2, MINUTE + 1000), MINUTE + 1000));
  assert.doesNotThrow(() => sink.append(rowOf(sink, 3, MINUTE + 2000), MINUTE + 2000));
  assert.equal(sink.faults.byCode.ENOSPC, 2, "both writes were refused by the disk");
  assert.equal(sink.faults.pendingRows, 2);
  assert.match(sink.faults.last!, /ENOSPC/);
  // Space returns (an operator cleared the disk): the next minute's segment opens with the loss stated first.
  fs.capacityBytes = Number.POSITIVE_INFINITY;
  sink.append(rowOf(sink, 4, MINUTE + 60_000), MINUTE + 60_000);
  sink.flush(MINUTE + 60_000);
  const rows = rowsOnDisk(fs);
  const dropped = rows.filter((r) => r.type === "dropped") as Array<{ segments: number; bytes: number }>;
  assert.equal(dropped.length, 1, "one dropped row, not one per failure");
  assert.equal(dropped[0]!.segments, 2, "rows lost are counted as segments, as the memory sink does");
  assert.ok(dropped[0]!.bytes > 0);
  assert.equal(sink.faults.pendingRows, 0, "the loss was said, so it is no longer pending");
  assert.deepEqual(rows.filter((r) => r.type === "refusal").map((r) => (r as { generation: number }).generation), [1, 4]);
});

test("an I/O error on fsync leaves the segment open for the next start and never throws; the next start recovers it", () => {
  const fs = new MemoryFs();
  const sink = new DirectorySink(DIR, "i-writer-a", HOST_SPOOL_BUDGET_BYTES, fs);
  sink.append(rowOf(sink, 1, MINUTE), MINUTE);
  fs.failNext("fsync", "EIO");
  assert.doesNotThrow(() => sink.flush(MINUTE));
  assert.equal(sink.faults.byCode.EIO, 1);
  assert.ok(fs.list(DIR).some((n) => n.endsWith(".ndjson.open")), "not renamed: an unsynced segment is not a closed one");
  // The same writer's next start closes it (the partial last line is the daemon's to skip).
  const again = new DirectorySink(DIR, "i-writer-a", HOST_SPOOL_BUDGET_BYTES, fs);
  assert.equal(again.faults.last, null);
  assert.ok(!fs.list(DIR).some((n) => n.endsWith(".ndjson.open")), "recovered on start");
  assert.equal(rowsOnDisk(fs).length, 1);
});

test("two writers over budget with a crash mid-open: the tree stays under budget plus one open segment per writer, the oldest unsent segments go, and one dropped row says how much", () => {
  const fs = new MemoryFs();
  const budget = 4096;
  const a = new DirectorySink(DIR, "i-writer-a", budget, fs);
  const b = new DirectorySink(DIR, "i-writer-b", budget, fs);
  // Each writer closes a segment per minute; ~700 bytes each — the budget holds five or six.
  for (let minute = 0; minute < 8; minute += 1) {
    const at = MINUTE + minute * 60_000;
    for (let n = 0; n < 5; n += 1) {
      a.append(rowOf(a, minute * 10 + n, at), at);
      b.append({ ...rowOf(b, minute * 10 + n, at), instanceId: "i-writer-b" }, at);
    }
    a.flush(at);
    b.flush(at);
  }
  const closed = fs.list(DIR).filter((n) => n.startsWith("seg-") && n.endsWith(".ndjson"));
  const closedBytes = closed.reduce((sum, n) => sum + fs.stat(`${DIR}/${n}`).size, 0);
  assert.ok(closedBytes <= budget + 2 * REPORT_SEGMENT_BYTES, `closed segments ${closedBytes} ≤ budget ${budget} + one report segment per writer`);
  const dropped = rowsOnDisk(fs).filter((r) => r.type === "dropped") as Array<{ instanceId: string; segments: number; bytes: number }>;
  assert.ok(dropped.length >= 1, "the eviction was said");
  assert.ok(dropped.every((r) => r.segments >= 1 && r.bytes > 0));
  // The oldest minute is what went.
  assert.ok(!closed.some((n) => n.includes(`-${Math.floor(MINUTE / 60_000)}-`)), "minute 0 was evicted first");
  // A crash mid-open: writer A dies with a segment open; on restart the open file is closed, then the budget still holds.
  a.append(rowOf(a, 99, MINUTE + 9 * 60_000), MINUTE + 9 * 60_000);
  assert.ok(fs.list(DIR).some((n) => n.startsWith("seg-i-writer-a-") && n.endsWith(".open")));
  const restarted = new DirectorySink(DIR, "i-writer-a", budget, fs);
  assert.ok(!fs.list(DIR).some((n) => n.startsWith("seg-i-writer-a-") && n.endsWith(".open")));
  restarted.append(rowOf(restarted, 100, MINUTE + 10 * 60_000), MINUTE + 10 * 60_000);
  restarted.flush(MINUTE + 10 * 60_000);
  const after = fs.list(DIR).filter((n) => n.startsWith("seg-") && n.endsWith(".ndjson")).reduce((sum, n) => sum + fs.stat(`${DIR}/${n}`).size, 0);
  assert.ok(after <= budget + 2 * REPORT_SEGMENT_BYTES, `after restart ${after} ≤ ${budget} + one report segment per writer`);
});

test("a segment a sibling process took away between the listing and the stat is skipped, not thrown, by the writer's sweep and the uploader's", () => {
  const fs = new MemoryFs();
  const clock = new FakeClock(MINUTE);
  const sink = new DirectorySink(DIR, "i-writer-a", 512, fs);
  for (let minute = 0; minute < 4; minute += 1) {
    const at = MINUTE + minute * 60_000;
    sink.append(rowOf(sink, minute, at), at);
    sink.flush(at);
  }
  const victim = fs.list(DIR).filter((n) => n.startsWith("seg-") && n.endsWith(".ndjson")).sort()[0]!;
  fs.failNext("stat", "ENOENT"); // the daemon evicted it after our listing
  assert.doesNotThrow(() => sink.depth());
  assert.equal(sink.faults.byCode.ENOENT, 1);
  fs.vanish(`${DIR}/${victim}`);
  const uploader = new SpoolUploader({ dir: DIR, instanceId: "i-daemon", fetch: async () => ({ status: 500, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0), text: async () => "" }), now: clock.now, fs, grantFor: async () => ({ kind: "unavailable", reason: "no_registry" }) });
  fs.failNext("stat", "ENOENT");
  assert.doesNotThrow(() => uploader.depth());
  assert.equal(uploader.fsFaults.ENOENT, 1);
});

test("no daemon and no grant: the writer alone caps the tree at the budget forever and reports every eviction", () => {
  const fs = new MemoryFs();
  const budget = 2048;
  const sink = new DirectorySink(DIR, "i-writer-a", budget, fs);
  for (let minute = 0; minute < 60; minute += 1) {
    const at = MINUTE + minute * 60_000;
    for (let n = 0; n < 4; n += 1) sink.append(rowOf(sink, minute * 10 + n, at), at);
    sink.flush(at);
    const closed = fs.list(DIR).filter((x) => x.startsWith("seg-") && x.endsWith(".ndjson")).reduce((sum, x) => sum + fs.stat(`${DIR}/${x}`).size, 0);
    // The eviction report is itself a closed segment written after the sweep; S6 folds it into the published formula. Here: budget + one report.
    assert.ok(closed <= budget + REPORT_SEGMENT_BYTES, `minute ${minute}: ${closed} ≤ ${budget} + one report segment`);
  }
  const dropped = rowsOnDisk(fs).filter((r) => r.type === "dropped");
  assert.ok(dropped.length >= 1);
  assert.equal(sink.faults.pendingRows, 0, "nothing lost silently");
});

test("the store runs over the same port and still refuses loudly when the disk is full at boot", async () => {
  const fs = new MemoryFs();
  const stateDir = "/state";
  fs.mkdirp(stateDir);
  const keyProvider = customKeyProvider({ wrap: async (dek) => dek, unwrap: async (wrapped) => wrapped });
  // A healthy disk: the store opens over the fake exactly as over Node.
  const store = await SlotStore.open({ stateDir, agentId: "agt_1", target: "prod", keyProvider, fs });
  assert.equal(store.state.generation, 0);
  assert.ok(fs.exists("/state/airprompter/agt_1/prod/store.json"));
  // A full disk at first boot: the store refuses with the filesystem's own code, never a half-written store.json.
  const fresh = new MemoryFs(0);
  fresh.mkdirp(stateDir);
  await assert.rejects(
    () => SlotStore.open({ stateDir, agentId: "agt_2", target: "prod", keyProvider, fs: fresh }),
    (error: unknown) => (error as { code?: string }).code === "ENOSPC",
    "a store that cannot write refuses at boot; it does not pretend",
  );
  assert.ok(!fresh.exists("/state/airprompter/agt_2/prod/store.json"));
});

test("a writer with a clock that skews still names minutes by the clock it was given", () => {
  const fs = new MemoryFs();
  const sink = new DirectorySink(DIR, "i-writer-a", HOST_SPOOL_BUDGET_BYTES, fs);
  const clock = new FakeClock(MINUTE);
  const writer = new SpoolWriter(sink, { instanceId: "i-writer-a", instanceClass: "resident", sdk: "test/0" });
  clock.skew(90_000);
  writer.refusal({ at: new Date(clock.nowMs()).toISOString(), reason: "lease_expired", generation: 1, tag: null }, clock.nowMs());
  sink.flush(clock.nowMs());
  const names = fs.list(DIR).filter((n) => n.startsWith("seg-") && n.endsWith(".ndjson"));
  assert.equal(names.length, 1);
  assert.ok(names[0]!.includes(`-${Math.floor((MINUTE + 90_000) / 60_000)}-`), "the segment minute follows the skewed clock, as the ramp walk will");
});
