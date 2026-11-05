/**
 * The run as the unit: `recordRun` is the only thing that raises `count`, a step is a row of its own, and the two
 * row forms hold the validator's rules. The shared cases live in `protocol/vectors/spool.json`; this file proves the
 * rules the vectors cannot say, such as what a call does not touch.
 *
 * @example
 *   $ TSX_DISABLE_CACHE=1 node --import tsx --test test/spoolRunRows.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { spoolRowsToOtlp } from "../packages/otel-bridge/src/mapping.js";
import { LATENCY_BUCKET_EDGES_MS, MemorySink, SpoolWriter, latencyBucketIndex, type RunTotals, type SpoolRow, type StepRow, type StepTotals, type WindowRow } from "../packages/telemetry/src/spool/writer.js";
import { inspectSegment, validateSpoolRow } from "../packages/telemetry/src/uploader.js";

const T0 = Date.parse("2026-09-12T14:03:10Z");
const identity = { instanceId: "i-testinstance", instanceClass: "resident" as const, sdk: "t/0" };
const dimensions = { tag: "support.reply", artifactId: "prm_1", versionId: "ver_1", arm: "none", model: "gpt-5" };
const run = (patch: Partial<RunTotals> = {}): RunTotals => ({ dimensions, status: "ok", errorClass: null, usageSource: "reported", agentRun: 1, modelCalls: 1, latencyMs: 100, tokens: { input: 10, cachedInput: 0, output: 5 }, tools: { calls: 0, errors: 0 }, ...patch });
const histogram = (...latencies: number[]) => {
  const buckets = new Array<number>(LATENCY_BUCKET_EDGES_MS.length).fill(0);
  for (const ms of latencies) buckets[latencyBucketIndex(ms)]! += 1;
  return { buckets, sum: latencies.reduce((sum, ms) => sum + ms, 0) };
};
const step = (name: string, patch: Partial<StepTotals> = {}): StepTotals => ({ dimensions, step: name, status: "ok", errorClass: null, usageSource: "reported", modelCalls: 2, latency: histogram(100, 200), tokens: { input: 10, cachedInput: 2, output: 5 }, tools: { calls: 1, errors: 0 }, ...patch });
function writing() {
  const sink = new MemorySink();
  const writer = new SpoolWriter(sink, identity);
  const rows = () => {
    writer.closeWindows(T0);
    return sink.drain() as SpoolRow[];
  };
  return { writer, rows };
}
const windows = (rows: SpoolRow[]) => rows.filter((row): row is WindowRow => row.type === "window");
const steps = (rows: SpoolRow[]) => rows.filter((row): row is StepRow => row.type === "step");

test("recordRun is the only thing that raises count", () => {
  const { writer, rows } = writing();
  writer.recordRun(run(), T0);
  writer.recordStep(step("a"), T0);
  writer.recordStep(step("b"), T0);
  writer.checks(dimensions, { passed: 1, failed: 0 }, T0);
  writer.outcomes(dimensions, { thumbs: true }, T0);
  const [row] = windows(rows());
  assert.equal(row!.count, 1, "a step, a check and an outcome add no run");
  assert.deepEqual(row!.outcomes, { thumbs: { n: 1, sum: 1, sumSq: 1 } });
  assert.deepEqual(row!.checks, { passed: 1, failed: 0 });
});

test("recordStep writes a type step row and no window", () => {
  const { writer, rows } = writing();
  writer.recordStep(step("support.reply#1"), T0);
  const written = rows();
  assert.equal(windows(written).length, 0, "no window at all");
  const [row] = steps(written);
  assert.equal(row!.tag, "support.reply", "the slot tag");
  assert.equal(row!.step, "support.reply#1", "the step id");
  assert.equal(row!.v, 1);
  assert.equal(row!.latencyMs.buckets.reduce((sum, n) => sum + n, 0), row!.modelCalls, "bucket total equals modelCalls");
  assert.equal(validateSpoolRow(row).ok, true);
});

test("a step name past either cap is written as other", () => {
  const { writer, rows } = writing();
  for (let i = 0; i < 40; i += 1) writer.recordStep(step(`node-${i}`), T0);
  writer.recordStep(step("x".repeat(65)), T0);
  writer.recordStep(step("😀".repeat(64)), T0);
  const written = steps(rows());
  const names = written.map((row) => row.step);
  assert.equal(names.filter((name) => name !== "other").length, 32, "maxPerRun: the distinct names; the 64-character name found the cap spent");
  assert.equal(names.includes("other"), true);
  assert.equal(written.find((row) => row.step === "other")!.modelCalls, 2 * 10, "eight past the cap and the two past maxLength fold into other");
});

test("a name is counted in characters, not code units", () => {
  const { writer, rows } = writing();
  writer.recordStep(step("😀".repeat(64)), T0);
  assert.deepEqual(steps(rows()).map((row) => row.step), ["😀".repeat(64)]);
});

test("two recordRun calls for one run, agentRun 1 then 0, add 2 to count and 1 to agentRun", () => {
  const { writer, rows } = writing();
  writer.recordRun(run({ agentRun: 1 }), T0);
  writer.recordRun(run({ agentRun: 0 }), T0);
  const [row] = windows(rows());
  assert.deepEqual([row!.count, row!.agentRun], [2, 1]);
});

test("moments are over each run's totals: five calls in one run square the total, never each call", () => {
  const { writer, rows } = writing();
  writer.recordRun(run({ modelCalls: 5, tokens: { input: 1000, cachedInput: 200, output: 300 }, tools: { calls: 2, errors: 1 } }), T0);
  const [row] = windows(rows());
  assert.deepEqual(row!.tokensSq, { input: 1_000_000, cachedInput: 40_000, output: 90_000, inputOutput: 300_000, inputCached: 200_000, cachedOutput: 60_000 });
  assert.deepEqual([row!.count, row!.modelCalls, row!.tools], [1, 5, { calls: 2, errors: 1 }]);
});

test("the validator takes each form and refuses a crossed one", () => {
  const { writer, rows } = writing();
  writer.recordRun(run({ status: "error", errorClass: "model_unresolved" }), T0);
  writer.recordRun(run({ status: "interrupted" }), T0);
  writer.recordStep(step("a"), T0);
  writer.outcomes({ ...dimensions, outcomeRunMinute: "2026-09-12T14:02:00Z" }, { rating: 4 }, T0);
  const written = rows();
  for (const row of written) assert.deepEqual(validateSpoolRow(row), { ok: true, row, stripped: [] }, JSON.stringify(row));
  const runRow = windows(written).find((row) => row.status === "error")!;
  const stepRow = steps(written)[0]!;
  const feedback = windows(written).find((row) => row.count === 0)!;
  assert.equal(runRow.errorClass, "model_unresolved");
  assert.equal(windows(written).find((row) => row.status === "interrupted")!.errorClass, null, "interrupted counts as a run, not as an error");
  assert.deepEqual(validateSpoolRow({ ...stepRow, tokensSq: runRow.tokensSq }), { ok: false, reason: "unknown_field:tokensSq" });
  for (const name of ["count", "outcomes", "checks"]) assert.deepEqual(validateSpoolRow({ ...stepRow, [name]: 1 }), { ok: false, reason: `unknown_field:${name}` }, name);
  assert.deepEqual(validateSpoolRow({ ...runRow, step: "a" }), { ok: false, reason: "unknown_field:step" });
  assert.deepEqual(validateSpoolRow({ ...stepRow, modelCalls: 3 }), { ok: false, reason: "histogram" });
  assert.deepEqual(validateSpoolRow({ ...stepRow, status: "interrupted" }), { ok: false, reason: "status", later: true }, "a closed list per row type; the line is skipped and counted");
  assert.deepEqual(validateSpoolRow({ ...runRow, status: "paused" }), { ok: false, reason: "status", later: true });
  assert.equal(validateSpoolRow({ ...runRow, errorClass: "a".repeat(32) }).ok, true, "a later error class: any slug of 32");
  assert.deepEqual(validateSpoolRow({ ...runRow, errorClass: "a".repeat(33) }), { ok: false, reason: "errorClass" });
  assert.equal(validateSpoolRow({ ...runRow, usageSource: "a".repeat(32) }).ok, true);
  assert.deepEqual(validateSpoolRow({ ...runRow, usageSource: "a".repeat(33) }), { ok: false, reason: "usageSource" });
  assert.deepEqual(validateSpoolRow({ ...stepRow, step: "" }), { ok: false, reason: "step" });
  assert.deepEqual(validateSpoolRow({ ...runRow, agentRun: 2 }), { ok: false, reason: "agentRun" });
  const { tokensSq: _tokensSq, ...withoutMoments } = runRow;
  assert.deepEqual(validateSpoolRow(withoutMoments), { ok: false, reason: "tokensSq" });
  assert.deepEqual(validateSpoolRow({ ...runRow, tokensSq: { ...runRow.tokensSq, inputOutput: -1 } }), { ok: false, reason: "tokensSq" });
  assert.deepEqual(validateSpoolRow({ ...feedback, tokensSq: runRow.tokensSq }), { ok: false, reason: "feedback_measurements" });
  assert.deepEqual(validateSpoolRow({ ...feedback, modelCalls: 1 }), { ok: false, reason: "feedback_measurements" });
  assert.deepEqual(validateSpoolRow({ ...feedback, outcomes: { rating: { n: 1, sum: 4 } } }), { ok: false, reason: "outcomes:rating" });
});

test("OTel: a segment with step rows gives the same metrics as without them", () => {
  const { writer, rows } = writing();
  writer.recordRun(run({ tokens: { input: 7, cachedInput: 1, output: 3 } }), T0);
  writer.recordStep(step("a"), T0);
  writer.recordStep(step("b"), T0);
  const written = rows();
  const without = written.filter((row) => row.type !== "step");
  assert.equal(written.length - without.length, 2);
  assert.deepEqual(spoolRowsToOtlp(written), spoolRowsToOtlp(without));
  const fromAnotherWriter = { ...written.find((row) => row.type === "step")!, sdk: "other-writer/9", instanceClass: "ephemeral" } as SpoolRow;
  assert.deepEqual(spoolRowsToOtlp([fromAnotherWriter, ...without]), spoolRowsToOtlp(without), "a step row first names no resource");
  assert.deepEqual(spoolRowsToOtlp(written.filter((row) => row.type === "step")).resourceMetrics[0]!.scopeMetrics[0]!.metrics, [], "step rows alone are no metrics");
});

test("a writer takes a bad observation as a refusal to write: the row never exists", () => {
  const { writer, rows } = writing();
  const good = { tag: "support.reply", artifactId: "prm_1", versionId: "ver_1", arm: "none", model: "gpt-5", status: "ok" as const, latencyMs: 5 };
  const bad: Array<[string, Record<string, unknown>]> = [
    ["telemetry_tag_invalid", { tag: "docs.flow#2" }],
    ["telemetry_tag_invalid", { tag: "Upper" }],
    ["telemetry_arm_invalid", { arm: "Upper" }],
    ["telemetry_arm_invalid", { arm: "a".repeat(33) }],
    ["telemetry_model_invalid", { model: "m".repeat(129) }],
    ["telemetry_version_id_invalid", { versionId: "v".repeat(129) }],
    ["telemetry_status_invalid", { status: "paused" }],
    ["telemetry_usage_source_invalid", { usageSource: "guessed" }],
    ["telemetry_error_class_invalid", { status: "error", errorClass: "exploded" }],
  ];
  for (const [message, change] of bad) assert.throws(() => writer.observe({ ...good, ...change } as never, T0), new RegExp(message), JSON.stringify(change));
  assert.deepEqual(rows(), [], "nothing was written");
});

test("no writer input quarantines a segment: what the writer takes, the validator takes", () => {
  const wild: unknown[] = [undefined, null, NaN, Infinity, -1, 1.5, 1e308, "", "x y", "Not Slug", "a#1", "A", "x".repeat(200), [], {}, true];
  const good: Record<string, unknown> = { tag: "support.reply", artifactId: "prm_1", versionId: "ver_1", arm: "none", model: "gpt-5", status: "ok", latencyMs: 5, tokens: { input: 3, cachedInput: 1, output: 2 }, step: "s1", toolCalls: { calls: 1, errors: 0 }, checks: { passed: 1, failed: 0 } };
  const quarantined: string[] = [];
  const attempt = (observation: Record<string, unknown>, label: string) => {
    const { writer, rows } = writing();
    try {
      writer.observe(observation as never, T0);
    } catch {
      // Dropped and logged by `observe` and `report`.
    }
    writer.closeWindows(T0 + 120_000);
    const bytes = Buffer.from(rows().map((row) => `${JSON.stringify(row)}\n`).join(""));
    if (inspectSegment(bytes, "i-testinstance", T0).invalid.length > 0) quarantined.push(label);
  };
  for (const name of Object.keys(good)) for (const value of wild) attempt({ ...good, [name]: value }, `${name}=${String(value)}`);
  for (const [outer, inner] of [["tokens", "input"], ["tokens", "output"], ["tokens", "cachedInput"], ["toolCalls", "calls"], ["toolCalls", "errors"], ["checks", "passed"], ["checks", "failed"]] as const) {
    for (const value of wild) attempt({ ...good, [outer]: { ...(good[outer] as object), [inner]: value } }, `${outer}.${inner}=${String(value)}`);
  }
  assert.deepEqual(quarantined, []);
});

test("a skipped line is a line: the dropped row says so and OTel counts no segment", () => {
  const { writer, rows } = writing();
  writer.recordRun(run(), T0);
  const row = rows()[0] as WindowRow;
  const inspection = inspectSegment(Buffer.from(`${JSON.stringify(row)}\n${JSON.stringify({ ...row, v: 5 })}\n`), row.instanceId, T0);
  const dropped = inspection.rows.find((entry) => entry.type === "dropped") as { segments: number; lines?: number };
  assert.deepEqual([dropped.segments, dropped.lines], [0, 1]);
  assert.deepEqual(validateSpoolRow(dropped), { ok: true, row: dropped, stripped: [] }, "the row this reader wrote passes this reader");
  const again = inspectSegment(inspection.payload, row.instanceId, T0);
  assert.deepEqual([again.invalid, again.skipped, again.stripped], [[], [], []], "a cleaned segment inspects clean, so it is never quarantined on a second pass");
  const metrics = spoolRowsToOtlp(inspection.rows).resourceMetrics[0]!.scopeMetrics[0]!.metrics;
  const segments = metrics.find((metric) => metric.name.includes("dropped") && metric.name.includes("segment"));
  assert.equal(JSON.stringify(segments).includes('"asInt":"1"'), false, JSON.stringify(segments));
});
