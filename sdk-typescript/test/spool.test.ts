/**
 * The spool writer against `protocol/vectors/spool.json` and
 * `feedback.json` (buckets, minutes, names, rotation, window aggregation,
 * the feedback catalogue), then the filesystem rules the vectors cannot
 * express: 0600 files, `.open` until fsync + rename, recovery of a crashed
 * writer's segment, rotation on disk at the minute and at 1 MiB, and the
 * `sent/` + `quarantine/` layout the daemon expects.
 */

import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeFeedback } from "../src/spool/feedback.js";
import { DirectorySink, LATENCY_BUCKET_EDGES_MS, MemorySink, SEGMENT_MAX_BYTES, SegmentPlanner, SpoolWriter, epochMinute, latencyBucketIndex, minuteOf, segmentName, type Observation, type SpoolRow, type WindowRow } from "../src/spool/writer.js";

const vector = (name: string) => JSON.parse(readFileSync(new URL(`../../protocol/vectors/${name}`, import.meta.url), "utf8"));
const stable = (value: unknown): unknown => (Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable((value as Record<string, unknown>)[k])])) : value);
const same = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const windowKey = (row: WindowRow) => JSON.stringify([row.minute, row.tag, row.versionId, row.arm, row.model, row.status, row.errorClass ?? null]);

test("spool.json: buckets, minutes, segment names, rotation", () => {
  const sp = vector("spool.json");
  assert.deepEqual(sp.latencyBuckets.edges, [...LATENCY_BUCKET_EDGES_MS]);
  assert.equal(sp.segmentMaxBytes, SEGMENT_MAX_BYTES);
  for (const c of sp.latencyBuckets.cases) assert.equal(latencyBucketIndex(c.latencyMs), c.bucket, `${c.latencyMs} ms`);
  for (const c of sp.minutes) {
    assert.equal(minuteOf(c.epochMs), c.minute, c.name);
    assert.equal(epochMinute(c.epochMs), c.epochMinute, c.name);
  }
  for (const c of sp.segmentNames) assert.equal(segmentName(c.instanceId, epochMinute(c.epochMs), c.n), c.name);
  for (const c of sp.rotation) {
    const planner = new SegmentPlanner(c.instanceId);
    c.appends.forEach((a: { epochMs: number; lineBytes: number; segment: string; rotated: boolean }, i: number) => {
      assert.deepEqual(planner.append(a.epochMs, a.lineBytes), { segment: a.segment, rotated: a.rotated }, `${c.name} append ${i}`);
    });
  }
});

test("spool.json: window aggregation through SpoolWriter", () => {
  const sp = vector("spool.json");
  for (const c of sp.windows) {
    const sink = new MemorySink();
    const writer = new SpoolWriter(sink, { instanceId: c.instanceId, instanceClass: c.instanceClass, sdk: c.sdk });
    for (const event of c.events) {
      if (event.kind === "observe") writer.observe(event.observation as Observation, event.at);
      else if (event.kind === "feedback") writer.outcomes(event.feedback, event.feedback.outcomes, event.at);
      else if (event.kind === "refusal") writer.refusal({ at: new Date(event.at).toISOString(), reason: event.reason, generation: event.generation, tag: event.tag ?? null }, event.at);
      else if (event.kind === "close") writer.closeWindows(event.at);
    }
    const rows = sink.drain();
    const windows = rows.filter((r): r is WindowRow => r.type === "window").sort((a, b) => (windowKey(a) < windowKey(b) ? -1 : 1));
    const expected = [...c.expectedWindows].sort((a: WindowRow, b: WindowRow) => (windowKey(a) < windowKey(b) ? -1 : 1));
    assert.equal(windows.length, expected.length, c.name);
    windows.forEach((row, i) => assert.ok(same(row, expected[i]), `${c.name}: ${JSON.stringify(row)} vs ${JSON.stringify(expected[i])}`));
    assert.ok(same(rows.filter((r) => r.type === "refusal"), c.expectedRefusals), `${c.name}: refusals`);
  }
});

test("feedback.json: the catalogue normaliser", () => {
  const fb = vector("feedback.json");
  for (const c of fb.cases) assert.ok(same(normalizeFeedback(c.signals), c.expected), `${c.name}: ${JSON.stringify(normalizeFeedback(c.signals))}`);
});

const T0 = Date.parse("2026-09-12T14:03:10Z");
const observation: Observation = { tag: "a.b", versionId: "v1", arm: "none", model: "m", status: "ok", latencyMs: 10 };

test("on disk: 0600 files, .open until closed, sent/ and quarantine/ present, a segment per minute, no plaintext-bearing field", () => {
  const dir = mkdtempSync(join(tmpdir(), "ap-spool-"));
  const sink = new DirectorySink(dir, "i-testinstance");
  assert.deepEqual(readdirSync(dir).sort(), ["quarantine", "sent"]);
  const writer = new SpoolWriter(sink, { instanceId: "i-testinstance", instanceClass: "resident", sdk: "t/0" });
  writer.observe(observation, T0);
  writer.observe(observation, T0 + 60_000); // the minute turned: closes the first window into the first segment
  let names = readdirSync(dir).filter((n) => n.startsWith("seg-"));
  assert.deepEqual(names, [`seg-i-testinstance-${epochMinute(T0 + 60_000)}-0.ndjson`], "the closed minute's windows are written, fsynced and closed at once, in a segment named for the write time");
  assert.equal(statSync(join(dir, names[0]!)).mode & 0o777, 0o600);
  sink.append({ type: "refusal", v: 1, at: new Date(T0 + 61_000).toISOString(), instanceId: "i-testinstance", reason: "disabled", generation: 1, tag: null }, T0 + 61_000);
  assert.ok(readdirSync(dir).some((n) => n.endsWith(".ndjson.open")), "a segment being written carries .open");
  writer.closeWindows(T0 + 120_000);
  names = readdirSync(dir).filter((n) => n.startsWith("seg-")).sort();
  assert.deepEqual(names, [`seg-i-testinstance-${epochMinute(T0 + 60_000)}-0.ndjson`, `seg-i-testinstance-${epochMinute(T0 + 60_000)}-1.ndjson`, `seg-i-testinstance-${epochMinute(T0 + 120_000)}-0.ndjson`]);
  assert.equal(names.some((n) => n.endsWith(".open")), false);
  const rows = names.flatMap((n) => readFileSync(join(dir, n), "utf8").trim().split("\n").map((l) => JSON.parse(l) as SpoolRow));
  assert.deepEqual(rows.map((r) => (r.type === "window" ? r.minute : r.type)), ["2026-09-12T14:03:00Z", "refusal", "2026-09-12T14:04:00Z"]);
  assert.deepEqual(sink.depth(), { segments: 3, bytes: names.reduce((sum, n) => sum + statSync(join(dir, n)).size, 0) });
  rmSync(dir, { recursive: true, force: true });
});

test("on disk: rotation at 1 MiB inside one minute; n climbs; every segment stays under the cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "ap-spool-"));
  const sink = new DirectorySink(dir, "i-testinstance");
  const writer = new SpoolWriter(sink, { instanceId: "i-testinstance", instanceClass: "resident", sdk: "t/0" });
  // Refusal rows go straight to the sink (no windowing), so byte growth is deterministic.
  const row = { at: new Date(T0).toISOString(), reason: "lease_expired" as const, generation: 1, tag: null };
  const lineBytes = Buffer.byteLength(`${JSON.stringify({ type: "refusal", v: 1, instanceId: "i-testinstance", ...row })}\n`);
  const perSegment = Math.floor(SEGMENT_MAX_BYTES / lineBytes);
  for (let i = 0; i < perSegment * 2 + 1; i += 1) writer.refusal(row, T0 + i);
  sink.flush(T0);
  const names = readdirSync(dir).filter((n) => n.startsWith("seg-")).sort();
  assert.deepEqual(names, [0, 1, 2].map((n) => segmentName("i-testinstance", epochMinute(T0), n)));
  for (const name of names) assert.ok(statSync(join(dir, name)).size <= SEGMENT_MAX_BYTES, name);
  assert.equal(statSync(join(dir, names[0]!)).size, perSegment * lineBytes);
  assert.equal(statSync(join(dir, names[2]!)).size, lineBytes);
  rmSync(dir, { recursive: true, force: true });
});

test("on disk: a crashed writer's .open segment is closed by the same instance on its next start; another instance leaves it alone; an existing name is never appended to", () => {
  const dir = mkdtempSync(join(tmpdir(), "ap-spool-"));
  const first = new DirectorySink(dir, "i-testinstance");
  first.append({ type: "refusal", v: 1, at: new Date(T0).toISOString(), instanceId: "i-testinstance", reason: "disabled", generation: 3, tag: null }, T0);
  // No flush: the process dies here. Simulate a partial trailing line too.
  const open = readdirSync(dir).find((n) => n.endsWith(".open"))!;
  const fd = openSync(join(dir, open), "a");
  writeSync(fd, '{"type":"window","v":1,"partial');
  closeSync(fd);
  const stranger = new DirectorySink(dir, "i-otherinstance");
  assert.ok(readdirSync(dir).includes(open), "another instance's writer does not close it");
  void stranger;
  const restarted = new DirectorySink(dir, "i-testinstance");
  const closed = open.slice(0, -".open".length);
  assert.ok(readdirSync(dir).includes(closed), "closed on restart");
  assert.equal(readdirSync(dir).includes(open), false);
  const lines = readFileSync(join(dir, closed), "utf8").split("\n");
  assert.ok(lines[1]!.startsWith('{"type":"window","v":1,"partial'), "the partial last line is left for the daemon to skip");
  // The same minute again: the name seg-…-<minute>-0 exists, so the new segment is -1.
  restarted.append({ type: "refusal", v: 1, at: new Date(T0).toISOString(), instanceId: "i-testinstance", reason: "disabled", generation: 3, tag: null }, T0 + 1);
  restarted.flush(T0 + 1);
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith("seg-")).sort(), [0, 1].map((n) => segmentName("i-testinstance", epochMinute(T0), n)));
  rmSync(dir, { recursive: true, force: true });
});
