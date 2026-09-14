/**
 * T16 (AIR-1946): the spool over a file. `export-telemetry` packs the closed segments a host that never calls home
 * wrote (and moves them aside so the next export packs only what is new); `import-telemetry` on a connected host
 * heartbeats as each instance the file carries, takes the grant to that instance's prefix, and posts every segment —
 * importing the same file twice leaves S3 with the same objects (PUT is idempotent by key). A segment with no valid
 * row is left behind at export and never uploaded; a hold answers with the retry the platform asked for.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SlotStore } from "../../sdk-typescript/packages/sync/src/store/slotStore.js";
import { epochMinute, segmentName, type SpoolRow } from "../../sdk-typescript/packages/telemetry/src/spool/writer.js";
import { FakeControlPlane } from "../../sdk-typescript/test/helpers/controlPlane.js";
import { run } from "../src/cli.js";
import { EXIT, type Context } from "../src/io.js";
import type { TelemetryExportFile } from "../src/commands/telemetry.js";

const scope = { organizationId: "org_1", agentId: "agt_1", target: "prod" as const };
const T0 = Date.parse("2026-09-12T14:03:10Z");
const WRITER = "i-offlineAAAAAAA";
const OTHER = "i-offlineBBBBBBB";

function windowRow(instanceId: string, minute: string): SpoolRow {
  return { type: "window", v: 1, minute, instanceId, instanceClass: "resident", tag: "support.triage", versionId: "ver_1", arm: "none", model: "gpt-5", status: "ok", errorClass: null, usageSource: "reported", count: 1, latencyMs: { buckets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0], sum: 812 }, tokens: { input: 40, output: 9 }, sdk: "agent-sdk-ts/0.1.0" };
}

function harness(plane: FakeControlPlane, work: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx: Context = { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l), env: { HOME: work, AIRPROMPTER_AGENT_KEY: plane.apiKey }, cwd: work, now: () => T0 + 5 * 60_000, fetch: plane.fetch(), isTTY: false };
  return { ctx, stdout, stderr, json: () => JSON.parse(stdout[stdout.length - 1]!) as Record<string, unknown>, reset: () => void ((stdout.length = 0), (stderr.length = 0)) };
}

const scopeArgs = ["--org", scope.organizationId, "--agent", scope.agentId, "--environment", scope.target];

test("export packs the closed segments and moves them aside; import heartbeats per instance, uploads through the grant, and is idempotent; a rowless segment never travels; a hold is reported", async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-cli-telemetry-"));
  const plane = new FakeControlPlane(scope);
  plane.grantBaseUrl = "https://bucket.test";
  plane.now = () => T0 + 5 * 60_000;
  const stateDir = join(work, "state");
  const spool = join(SlotStore.path({ stateDir, agentId: scope.agentId, target: scope.target }), "spool", "telemetry");
  mkdirSync(spool, { recursive: true });
  const write = (instanceId: string, minuteMs: number, n: number, lines: string[]) => {
    const name = segmentName(instanceId, epochMinute(minuteMs), n);
    writeFileSync(join(spool, name), lines.map((line) => `${line}\n`).join(""));
    return name;
  };
  const a0 = write(WRITER, T0, 0, [JSON.stringify(windowRow(WRITER, "2026-09-12T14:03:00Z"))]);
  const a1 = write(WRITER, T0 + 60_000, 0, [JSON.stringify(windowRow(WRITER, "2026-09-12T14:04:00Z"))]);
  const b0 = write(OTHER, T0, 0, [JSON.stringify(windowRow(OTHER, "2026-09-12T14:03:00Z"))]);
  const junk = write("i-junkCCCCCCCCCC", T0, 0, ["not json", JSON.stringify({ type: "window", v: 1, prompt: "You are a helpful assistant" })]);
  writeFileSync(join(spool, `${segmentName(WRITER, epochMinute(T0 + 120_000), 0)}.open`), "{}\n");

  const h = harness(plane, work);
  const out = join(work, "telemetry.aptelemetry");
  assert.equal(await run(["export-telemetry", ...scopeArgs, "--state-dir", stateDir, "--out", out, "--json"], h.ctx), EXIT.ok, h.stderr.join("\n"));
  assert.deepEqual({ segments: h.json().segments, instances: h.json().instances, generation: h.json().generation }, { segments: 3, instances: 2, generation: 0 });
  const file = JSON.parse(readFileSync(out, "utf8")) as TelemetryExportFile;
  assert.deepEqual(file.segments.map((s) => s.name).sort(), [a0, a1, b0].sort());
  assert.equal(JSON.stringify(file).includes("helpful assistant"), false, "the junk segment (no valid row) never travels");
  assert.deepEqual(readdirSync(spool).filter((n) => !n.startsWith(".")).sort(), [junk, `${segmentName(WRITER, epochMinute(T0 + 120_000), 0)}.open`, "exported"].sort(), "packed segments moved aside; the open one and the junk stay");
  assert.deepEqual(readdirSync(join(spool, "exported")).sort(), [a0, a1, b0].sort());
  assert.ok(h.stderr.some((line) => line.includes(junk) && line.includes("left in place")));

  // A second export packs nothing new.
  h.reset();
  const again = join(work, "again.aptelemetry");
  assert.equal(await run(["export-telemetry", ...scopeArgs, "--state-dir", stateDir, "--out", again, "--json"], h.ctx), EXIT.ok);
  assert.equal(h.json().segments, 0);

  // exported/ is swept by the next export that packs something: a segment packed more than a week ago goes, the others stay.
  const old = new Date(h.ctx.now() - 8 * 86_400_000);
  utimesSync(join(spool, "exported", a0), old, old);
  const c0 = write(OTHER, T0 + 60_000, 0, [JSON.stringify(windowRow(OTHER, "2026-09-12T14:04:00Z"))]);
  h.reset();
  assert.equal(await run(["export-telemetry", ...scopeArgs, "--state-dir", stateDir, "--out", again, "--json"], h.ctx), EXIT.ok);
  assert.deepEqual({ segments: h.json().segments, swept: h.json().swept }, { segments: 1, swept: 1 });
  assert.deepEqual(readdirSync(join(spool, "exported")).sort(), [a1, b0, c0].sort());

  // Import on a connected host: one heartbeat per instance, as that instance, offline; every segment lands under its own prefix.
  h.reset();
  assert.equal(await run(["import-telemetry", ...scopeArgs, "--in", out, "--base-url", "https://api.test", "--json"], h.ctx), EXIT.ok, h.stderr.join("\n"));
  assert.deepEqual({ uploaded: h.json().uploaded, refused: h.json().refused, quarantined: h.json().quarantined }, { uploaded: 3, refused: 0, quarantined: 0 });
  assert.equal(plane.heartbeats.length, 2);
  assert.deepEqual(plane.heartbeats.map((b) => [b.instanceId, b.syncMode, (b.sdk as { name: string }).name, (b.spool as { depthSegments: number }).depthSegments]).sort(), [[OTHER, "offline", "airprompter-cli", 1], [WRITER, "offline", "airprompter-cli", 2]].sort());
  assert.deepEqual([...plane.objects.keys()].sort(), [`org/org_1/agent/agt_1/prod/${WRITER}/${a0}`, `org/org_1/agent/agt_1/prod/${WRITER}/${a1}`, `org/org_1/agent/agt_1/prod/${OTHER}/${b0}`].sort());
  assert.equal(plane.objects.get(`org/org_1/agent/agt_1/prod/${OTHER}/${b0}`)!.toString("utf8"), readFileSync(join(spool, "exported", b0), "utf8"), "the bytes S3 holds are the segment's");

  // Idempotent: the same file again re-PUTs the same keys; nothing new, nothing lost.
  h.reset();
  assert.equal(await run(["import-telemetry", ...scopeArgs, "--in", out, "--base-url", "https://api.test", "--json"], h.ctx), EXIT.ok);
  assert.equal(plane.objects.size, 3);
  assert.equal(plane.uploads.length, 6);

  // A hold: the platform's retry is reported and nothing is uploaded.
  h.reset();
  plane.grantHold = { retryAfterSeconds: 120 };
  assert.equal(await run(["import-telemetry", ...scopeArgs, "--in", out, "--base-url", "https://api.test", "--json"], h.ctx), EXIT.refused);
  assert.equal(h.json().retryAfterSeconds, 120);
  assert.equal(plane.uploads.length, 6);
  plane.grantHold = null;

  // The wrong scope and a foreign file are usage errors before any network.
  h.reset();
  assert.equal(await run(["import-telemetry", "--org", "org_1", "--agent", "agt_2", "--environment", "prod", "--in", out, "--json"], h.ctx), EXIT.usage);
  writeFileSync(join(work, "bogus.json"), "{}");
  assert.equal(await run(["import-telemetry", ...scopeArgs, "--in", join(work, "bogus.json"), "--json"], h.ctx), EXIT.usage);
  assert.equal(existsSync(join(spool, "exported")), true);
  rmSync(work, { recursive: true, force: true });
});
