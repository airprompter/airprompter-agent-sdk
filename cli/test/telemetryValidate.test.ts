/**
 * S14: `airprompter telemetry validate <segment>…` — a third-party writer's segments through the uploader's own
 * inspection. The reference example writer's segment passes; a row with a content-bearing field, a wrong instance id
 * and a malformed line are named by line and field (never by value); a partial last line is skipped, not failed; a
 * misnamed file needs --instance-id; the exit code is the contract (0 fits, 1 would be quarantined).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { run } from "../src/cli.js";
import { EXIT, type Context } from "../src/io.js";

const WINDOW = { type: "window", v: 1, minute: "2026-09-12T14:03:00Z", instanceId: "i-writer-a", instanceClass: "resident", tag: "support.triage", versionId: "rev-4", arm: "candidate", model: "claude-sonnet-5", status: "ok", errorClass: null, usageSource: "reported", count: 1, latencyMs: { buckets: [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], sum: 12 }, tokens: { input: 3, output: 4 }, sdk: "my-writer/1.0" };

function ctx(work: string): { ctx: Context; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { ctx: { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l), env: {}, cwd: work, now: () => Date.now(), fetch: null, isTTY: false }, stdout, stderr };
}

test("telemetry validate: a fitting segment passes; content, a foreign instance id, a malformed line and a partial tail are reported by line and field; exit codes", async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-tv-"));
  try {
    const good = join(work, "seg-i-writer-a-29821660-0.ndjson");
    writeFileSync(good, `${JSON.stringify(WINDOW)}\n${JSON.stringify({ ...WINDOW, arm: "control" })}\n`);
    const bad = join(work, "seg-i-writer-a-29821661-0.ndjson");
    writeFileSync(bad, [JSON.stringify(WINDOW), JSON.stringify({ ...WINDOW, prompt: "Reply warmly to the customer" }), JSON.stringify({ ...WINDOW, instanceId: "i-writer-b" }), "{not json", JSON.stringify(WINDOW).slice(0, 40)].join("\n"));
    const misnamed = join(work, "my-export.ndjson");
    writeFileSync(misnamed, `${JSON.stringify(WINDOW)}\n`);

    let c = ctx(work);
    assert.equal(await run(["telemetry", "validate", good, "--json"], c.ctx), EXIT.ok);
    let doc = JSON.parse(c.stdout.join("")) as { ok: boolean; segments: Array<{ ok: boolean; rows: number; lines: number; invalid: unknown[]; instanceId: string; partialTail: boolean }> };
    assert.equal(doc.ok, true);
    assert.deepEqual({ ok: doc.segments[0]!.ok, rows: doc.segments[0]!.rows, lines: doc.segments[0]!.lines, invalid: doc.segments[0]!.invalid, instanceId: doc.segments[0]!.instanceId }, { ok: true, rows: 2, lines: 2, invalid: [], instanceId: "i-writer-a" });

    c = ctx(work);
    assert.equal(await run(["telemetry", "validate", bad, "--json"], c.ctx), EXIT.refused);
    doc = JSON.parse(c.stdout.join(""));
    assert.equal(doc.ok, false);
    assert.deepEqual(doc.segments[0]!.invalid, [
      { line: 2, reason: "unknown_field:prompt" },
      { line: 3, reason: "instance_mismatch" },
      { line: 4, reason: "not_json" },
    ]);
    assert.equal(doc.segments[0]!.partialTail, true, "the truncated last line is a crashed writer, not an invalid row");
    assert.equal(doc.segments[0]!.rows, 1);
    assert.doesNotMatch(c.stdout.join("\n"), /Reply warmly/, "a reason names the field, never the value");

    c = ctx(work);
    assert.equal(await run(["telemetry", "validate", bad], c.ctx), EXIT.refused);
    assert.match(c.stdout.join("\n"), /FAIL .*seg-i-writer-a-29821661-0\.ndjson: 1 row of 5 lines.*partial last line skipped/);
    assert.match(c.stdout.join("\n"), /line 2: unknown_field:prompt/);
    assert.match(c.stdout.join("\n"), /1 of 1 segment would be quarantined/);
    assert.doesNotMatch(c.stdout.join("\n"), /Reply warmly/);

    c = ctx(work);
    assert.equal(await run(["telemetry", "validate", misnamed, "--json"], c.ctx), EXIT.refused);
    doc = JSON.parse(c.stdout.join(""));
    assert.deepEqual(doc.segments[0]!.invalid, [{ line: 0, reason: "segment_name" }]);
    c = ctx(work);
    assert.equal(await run(["telemetry", "validate", misnamed, "--instance-id", "i-writer-a", "--json"], c.ctx), EXIT.ok, "--instance-id stands in for the file name");

    c = ctx(work);
    assert.equal(await run(["telemetry", "validate", good, bad, "--json"], c.ctx), EXIT.refused, "one bad segment fails the run");
    doc = JSON.parse(c.stdout.join(""));
    assert.deepEqual(doc.segments.map((s) => s.ok), [true, false]);

    c = ctx(work);
    assert.equal(await run(["telemetry", "validate", join(work, "missing.ndjson"), "--json"], c.ctx), EXIT.refused);
    doc = JSON.parse(c.stdout.join(""));
    assert.deepEqual(doc.segments[0]!.invalid, [{ line: 0, reason: "read:ENOENT" }]);

    c = ctx(work);
    assert.equal(await run(["telemetry", "validate"], c.ctx), EXIT.usage, "no segment named is usage");
    assert.equal(await run(["telemetry", "frobnicate"], c.ctx).catch((e: { code: number }) => e.code), EXIT.usage);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
