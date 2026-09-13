/**
 * T26 P4 (AIR-1956): the spool uploader. The row validator against every
 * row the conformance vectors expect (all valid) and the shapes it must
 * refuse (unknown type, extra field, a text-bearing field, another
 * instance's row); the presigned POST body; full-jitter backoff bounds;
 * then the uploader on a directory two writers and a stranger wrote into:
 * one grant per writer prefix, the malformed third-party segment
 * quarantined, acknowledged segments in sent/, a replay after a lost
 * response writing the same key once, a hold honoured, an expired grant
 * refreshed, a failure backing off, the host budget evicting oldest-first
 * with a dropped row, and the serverless flush under the runtime's own grant.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent } from "../src/agent.js";
import { publicJwkOf } from "../src/protocol/trust.js";
import { epochMinute, segmentName, type SpoolRow } from "../src/spool/writer.js";
import { backoffDelayMs, inspectSegment, multipartBody, postSegment, SpoolUploader, UPLOAD_BACKOFF_CAP_MS, validateSpoolRow, type GrantDecision, type UploadGrant } from "../src/telemetry/uploader.js";
import { FakeControlPlane } from "./helpers/controlPlane.js";

const vector = (name: string) => JSON.parse(readFileSync(new URL(`../../protocol/vectors/${name}`, import.meta.url), "utf8"));
const scope = { organizationId: "org_1", agentId: "agt_1", target: "prod" as const };
const T0 = Date.parse("2026-09-12T14:03:10Z");
const WRITER_A = "i-writerAAAAAAAA";
const WRITER_B = "i-writerBBBBBBBB";

function windowRow(instanceId: string, minute: string, tag = "support.triage"): SpoolRow {
  return { type: "window", v: 1, minute, instanceId, instanceClass: "resident", tag, versionId: "ver_1", arm: "none", model: "gpt-5", status: "ok", errorClass: null, usageSource: "reported", count: 1, latencyMs: { buckets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0], sum: 812 }, tokens: { input: 40, output: 9 }, sdk: "agent-sdk-ts/0.1.0" };
}

function writeSegment(dir: string, instanceId: string, minuteMs: number, n: number, lines: string[]): string {
  const name = segmentName(instanceId, epochMinute(minuteMs), n);
  writeFileSync(join(dir, name), lines.map((line) => `${line}\n`).join(""), { mode: 0o600 });
  return name;
}

test("the validator accepts every row the vectors expect and refuses the shapes the contract forbids", () => {
  const sp = vector("spool.json");
  let accepted = 0;
  for (const c of sp.windows) {
    for (const row of [...c.expectedWindows, ...c.expectedRefusals]) {
      const verdict = validateSpoolRow(row);
      assert.ok(verdict.ok, `${c.name}: ${JSON.stringify(row)} → ${JSON.stringify(verdict)}`);
      accepted += 1;
    }
  }
  assert.ok(accepted >= 10, `vector rows accepted: ${accepted}`);
  assert.ok(validateSpoolRow({ type: "dropped", v: 1, at: "2026-09-12T14:03:00Z", instanceId: WRITER_A, segments: 3, bytes: 900 }).ok);
  const base = windowRow(WRITER_A, "2026-09-12T14:03:00Z");
  assert.deepEqual(validateSpoolRow({ ...base, type: "trace" }), { ok: false, reason: "unknown_type" });
  assert.deepEqual(validateSpoolRow({ ...base, prompt: "the secret text" }), { ok: false, reason: "unknown_field:prompt" });
  assert.deepEqual(validateSpoolRow({ ...base, tokens: { input: 1, output: 2, text: "leak" } }), { ok: false, reason: "tokens" });
  assert.deepEqual(validateSpoolRow({ ...base, latencyMs: { buckets: [1], sum: 1 } }), { ok: false, reason: "latencyMs" });
  assert.deepEqual(validateSpoolRow({ ...base, errorClass: "exploded" }), { ok: false, reason: "errorClass" });
  assert.deepEqual(validateSpoolRow({ ...base, outcomes: { thumbs: { n: 1, sum: 1 }, "Free Text": { n: 1, sum: 0 } } }), { ok: false, reason: "outcomes:Free Text" });
  assert.deepEqual(validateSpoolRow({ ...base, v: 2 }), { ok: false, reason: "v" });
  assert.deepEqual(validateSpoolRow({ type: "refusal", v: 1, at: "2026-09-12T14:03:00Z", instanceId: WRITER_A, reason: "bored", generation: 1, tag: null }), { ok: false, reason: "reason" });
  assert.deepEqual(validateSpoolRow("a line"), { ok: false, reason: "not_an_object" });
  const segment = Buffer.from(`${JSON.stringify(base)}\n${JSON.stringify(windowRow(WRITER_B, "2026-09-12T14:03:00Z"))}\nnot json\n{"type":"window","v":1,"partial`, "utf8");
  const inspection = inspectSegment(segment, WRITER_A);
  assert.equal(inspection.rows.length, 1);
  assert.deepEqual(inspection.invalid, [
    { line: 2, reason: "instance_mismatch" },
    { line: 3, reason: "not_json" },
  ]);
  assert.equal(inspection.partialTail, true, "a crashed writer's last line is skipped, never counted as invalid");
});

test("the POST body is a presigned POST: policy fields verbatim, then key and Content-Type, file last; backoff is full jitter under the cap", async () => {
  const grant: UploadGrant = { grantId: "grant_0001_test0000", url: "https://bucket.test/", fields: { policy: "cG9saWN5", "x-amz-signature": "sig", "x-amz-meta-grant-id": "grant_0001_test0000" }, keyPrefix: "org/org_1/agent/agt_1/prod/i-writerAAAAAAAA/", expiresAt: new Date(T0 + 600_000).toISOString(), maxObjectBytes: 1048576, contentType: "application/x-ndjson" };
  const body = multipartBody("XBOUNDARY", [["policy", "cG9saWN5"], ["key", `${grant.keyPrefix}seg-1.ndjson`]], { name: "seg-1.ndjson", contentType: "application/x-ndjson", bytes: Buffer.from('{"a":1}\n') });
  const text = body.toString("utf8");
  assert.ok(text.startsWith('--XBOUNDARY\r\nContent-Disposition: form-data; name="policy"\r\n\r\ncG9saWN5\r\n--XBOUNDARY\r\nContent-Disposition: form-data; name="key"'));
  assert.ok(text.endsWith('Content-Type: application/x-ndjson\r\n\r\n{"a":1}\n\r\n--XBOUNDARY--\r\n'));
  const calls: Array<{ url: string; init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array } }> = [];
  const fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array } = {}) => {
    calls.push({ url, init });
    return { status: 204, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0), text: async () => "" };
  };
  const outcome = await postSegment({ grant, segment: "seg-i-writerAAAAAAAA-1-0.ndjson", bytes: Buffer.from("{}\n"), fetch, now: () => T0, boundary: "B" });
  assert.deepEqual(outcome, { status: "ok", key: `${grant.keyPrefix}seg-i-writerAAAAAAAA-1-0.ndjson` });
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.headers?.["content-type"], "multipart/form-data; boundary=B");
  const sent = Buffer.from(calls[0]!.init.body as Uint8Array).toString("utf8");
  assert.ok(sent.indexOf('name="policy"') < sent.indexOf('name="key"') && sent.indexOf('name="key"') < sent.indexOf('name="file"'), "fields, then key, then file");
  assert.deepEqual(await postSegment({ grant, segment: "s", bytes: Buffer.alloc(grant.maxObjectBytes + 1), fetch, now: () => T0 }), { status: "too_large", bytes: grant.maxObjectBytes + 1 });
  assert.deepEqual(await postSegment({ grant, segment: "s", bytes: Buffer.from("{}\n"), fetch, now: () => T0 + 601_000 }), { status: "refused", httpStatus: 403, expired: true }, "a lapsed grant is refused before any bytes move");
  assert.equal(calls.length, 1);
  for (const attempt of [0, 1, 5, 12, 40]) {
    const max = Math.min(UPLOAD_BACKOFF_CAP_MS, 1000 * 2 ** attempt);
    assert.equal(backoffDelayMs(attempt, () => 1), max);
    assert.equal(backoffDelayMs(attempt, () => 0), 0);
    assert.equal(backoffDelayMs(attempt, () => 0.5), Math.round(max / 2));
  }
  assert.equal(backoffDelayMs(40, () => 1), UPLOAD_BACKOFF_CAP_MS, "five minutes is the cap");
});

interface Harness {
  dir: string;
  plane: FakeControlPlane;
  uploader: SpoolUploader;
  clock: { ms: number };
  requests: string[];
  events: Record<string, unknown>[];
}

function harness(options: { budgetBytes?: number; grantFor?: (instanceId: string) => Promise<GrantDecision> } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "ap-uploader-"));
  const plane = new FakeControlPlane(scope);
  plane.grantBaseUrl = "https://bucket.test";
  const fetch = plane.fetch();
  const clock = { ms: T0 };
  plane.now = () => clock.ms;
  const requests: string[] = [];
  const events: Record<string, unknown>[] = [];
  // The daemon's grantFor is a heartbeat carrying the writer's instance id; here the fake plane issues it directly.
  const grantFor = options.grantFor ?? (async (instanceId: string): Promise<GrantDecision> => {
    requests.push(`grant:${instanceId}`);
    const response = await fetch("https://api.test/v1/agents/agt_1/targets/prod/heartbeat", { method: "POST", headers: { authorization: `Bearer ${plane.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ protocol: "0.2.5", instanceId, sdk: { name: "airprompterd", version: "0.1.0" }, syncMode: "resident", generation: { active: 1 }, applyState: "active", storageProtection: "file_key", catalog: { models: [] }, lease: { expired: false }, spool: { depthSegments: 0, depthBytes: 0, droppedSegments: 0, quarantinedSegments: 0 } }) });
    const answer = JSON.parse(await response.text()) as { uploadGrant?: UploadGrant; uploadIntervalSeconds: number; retryAfterSeconds?: number };
    return answer.uploadGrant ? { kind: "grant", grant: answer.uploadGrant, uploadIntervalSeconds: answer.uploadIntervalSeconds } : { kind: "hold", retryAfterSeconds: answer.retryAfterSeconds ?? 900, reason: "retry_after" };
  });
  const uploader = new SpoolUploader({ dir, instanceId: "i-daemon00000000", grantFor, fetch, now: () => clock.ms, random: () => 0.5, logger: (event) => events.push(event), ...(options.budgetBytes ? { budgetBytes: options.budgetBytes } : {}) });
  return { dir, plane, uploader, clock, requests, events };
}

test("two writers and a stranger: one grant per writer prefix, the malformed third-party segment quarantined, acknowledged segments in sent/, a replay writes one key", async () => {
  const h = harness();
  try {
    const m0 = "2026-09-12T14:03:00Z";
    const a0 = writeSegment(h.dir, WRITER_A, T0, 0, [JSON.stringify(windowRow(WRITER_A, m0))]);
    const b0 = writeSegment(h.dir, WRITER_B, T0, 0, [JSON.stringify(windowRow(WRITER_B, m0)), JSON.stringify({ type: "refusal", v: 1, at: m0, instanceId: WRITER_B, reason: "disabled", generation: 1, tag: null })]);
    const a1 = writeSegment(h.dir, WRITER_A, T0 + 60_000, 0, [JSON.stringify(windowRow(WRITER_A, "2026-09-12T14:04:00Z"))]);
    // A third-party writer whose row carries a field the contract has no place for.
    const stranger = writeSegment(h.dir, "i-thirdparty0000", T0, 0, [JSON.stringify({ ...windowRow("i-thirdparty0000", m0), prompt: "You are a helpful assistant" })]);
    // An open segment is never read.
    writeFileSync(join(h.dir, `${segmentName(WRITER_A, epochMinute(T0 + 120_000), 0)}.open`), "{}\n");
    const result = await h.uploader.runOnce();
    assert.deepEqual(result.uploaded, [a0, b0, a1], "oldest first, by minute then n");
    assert.deepEqual(result.quarantined, [stranger]);
    assert.deepEqual(h.requests, [`grant:${WRITER_A}`, `grant:${WRITER_B}`], "one grant per writer, reused across that writer's segments");
    assert.deepEqual(
      h.plane.uploads,
      [`org/org_1/agent/agt_1/prod/${WRITER_A}/${a0}`, `org/org_1/agent/agt_1/prod/${WRITER_B}/${b0}`, `org/org_1/agent/agt_1/prod/${WRITER_A}/${a1}`],
      "each segment lands under its own writer's prefix",
    );
    assert.deepEqual(readdirSync(join(h.dir, "sent")).sort(), [a0, a1, b0].sort());
    assert.deepEqual(readdirSync(join(h.dir, "quarantine")), [stranger]);
    assert.deepEqual(readdirSync(h.dir).filter((n) => n.startsWith("seg-")), [`${segmentName(WRITER_A, epochMinute(T0 + 120_000), 0)}.open`]);
    assert.equal(h.plane.objects.get(`org/org_1/agent/agt_1/prod/${WRITER_B}/${b0}`)!.toString("utf8"), readFileSync(join(h.dir, "sent", b0), "utf8"), "the bytes S3 holds are the segment's");
    const status = h.uploader.status();
    assert.equal(status.sentSegments, 3);
    assert.equal(status.quarantinedSegments, 1);
    assert.equal(status.lastUploadAt, new Date(T0).toISOString());
    assert.equal(status.intervalSeconds, 300, "the grant's uploadIntervalSeconds");
    assert.deepEqual(status.grants.map((g) => g.instanceId).sort(), [WRITER_A, WRITER_B]);
    assert.equal(h.events.some((e) => JSON.stringify(e).includes("helpful assistant")), false, "the quarantine log names the line and the field, never the value");
    // Replay: the same segment again (a lost response) is the same key, once.
    writeFileSync(join(h.dir, a0), readFileSync(join(h.dir, "sent", a0)));
    await h.uploader.runOnce();
    assert.equal(h.plane.objects.size, 3, "S3 PUT is idempotent by key");
    assert.equal(h.plane.uploads.length, 4);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a hold is honoured until retryAfter; an expired grant is refreshed once; a failing bucket backs off with full jitter; sent/ is swept after 24 h", async () => {
  const h = harness();
  try {
    const name = writeSegment(h.dir, WRITER_A, T0, 0, [JSON.stringify(windowRow(WRITER_A, "2026-09-12T14:03:00Z"))]);
    h.plane.grantHold = { retryAfterSeconds: 900 };
    let result = await h.uploader.runOnce();
    assert.equal(result.held, true);
    assert.deepEqual(result.uploaded, []);
    assert.equal(h.uploader.status().backoffUntil, new Date(T0 + 900_000).toISOString(), "the spool holds for retryAfter");
    assert.equal(h.uploader.status().lastError, "hold:retry_after");
    h.plane.grantHold = null;
    h.clock.ms += 300_000;
    result = await h.uploader.runOnce();
    assert.equal(result.held, true, "still inside retryAfter: no request made");
    assert.equal(h.requests.length, 1);
    h.clock.ms = T0 + 900_001;
    result = await h.uploader.runOnce();
    assert.deepEqual(result.uploaded, [name]);
    assert.equal(h.uploader.status().backoffUntil, null);

    // The grant the uploader holds lapses (15 min): the uploader replaces it a minute early, before the POST.
    const second = writeSegment(h.dir, WRITER_A, T0 + 900_001, 0, [JSON.stringify(windowRow(WRITER_A, "2026-09-12T14:18:00Z"))]);
    h.clock.ms += 16 * 60_000;
    const before = h.requests.length;
    result = await h.uploader.runOnce();
    assert.deepEqual(result.uploaded, [second]);
    assert.equal(h.requests.length, before + 1, "the lapsed grant was replaced before the POST");

    // The bucket fails twice: backoff doubles under full jitter (random = 0.5 → half the ceiling), then succeeds.
    const third = writeSegment(h.dir, WRITER_A, h.clock.ms, 0, [JSON.stringify(windowRow(WRITER_A, "2026-09-12T14:34:00Z"))]);
    h.plane.failNextUploads = 2;
    result = await h.uploader.runOnce();
    assert.equal(result.held, true);
    assert.equal(h.uploader.status().lastError, "http_500");
    assert.equal(h.uploader.status().backoffUntil, new Date(h.clock.ms + 500).toISOString(), "attempt 0: half of 1 s");
    h.clock.ms += 501;
    result = await h.uploader.runOnce();
    assert.equal(h.uploader.status().attempt, 2);
    assert.equal(h.uploader.status().backoffUntil, new Date(h.clock.ms + 1000).toISOString(), "attempt 1: half of 2 s");
    h.clock.ms += 1001;
    result = await h.uploader.runOnce();
    assert.deepEqual(result.uploaded, [third]);
    assert.equal(h.uploader.status().attempt, 0, "a success resets the backoff");

    // sent/ is swept after 24 h; quarantine/ too.
    mkdirSync(join(h.dir, "quarantine"), { recursive: true });
    writeFileSync(join(h.dir, "quarantine", "seg-i-thirdparty0000-1-0.ndjson"), "x\n");
    assert.equal(readdirSync(join(h.dir, "sent")).length, 3);
    // The sweep reads mtimes: age every acknowledged and quarantined file past a day.
    const old = new Date(h.clock.ms - 25 * 60 * 60 * 1000);
    for (const sub of ["sent", "quarantine"]) for (const name of readdirSync(join(h.dir, sub))) utimesSync(join(h.dir, sub, name), old, old);
    await h.uploader.runOnce();
    assert.deepEqual(readdirSync(join(h.dir, "sent")), []);
    assert.deepEqual(readdirSync(join(h.dir, "quarantine")), []);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("the host budget across writers: the oldest unsent segments go first and the loss is one dropped row under the daemon's own id, uploaded like any segment", async () => {
  const h = harness({ budgetBytes: 900 });
  try {
    const names = [0, 1, 2, 3, 4].map((i) => writeSegment(h.dir, i % 2 === 0 ? WRITER_A : WRITER_B, T0 + i * 60_000, 0, [JSON.stringify(windowRow(i % 2 === 0 ? WRITER_A : WRITER_B, `2026-09-12T14:0${3 + i}:00Z`))]));
    const each = readFileSync(join(h.dir, names[0]!)).length;
    assert.ok(each * 3 > 900 && each * 2 <= 900, `segment ${each} bytes`);
    const result = await h.uploader.runOnce();
    assert.equal(result.dropped, 3, "three oldest evicted to fit two under 900 bytes");
    const droppedSegment = readdirSync(join(h.dir, "sent")).find((n) => n.startsWith("seg-i-daemon00000000-"));
    assert.ok(droppedSegment, "the dropped row was written as the daemon's own segment and uploaded");
    const row = JSON.parse(readFileSync(join(h.dir, "sent", droppedSegment!), "utf8").trim()) as { type: string; segments: number; bytes: number; instanceId: string };
    assert.deepEqual({ type: row.type, segments: row.segments, bytes: row.bytes, instanceId: row.instanceId }, { type: "dropped", segments: 3, bytes: each * 3, instanceId: "i-daemon00000000" });
    assert.deepEqual(result.uploaded.sort(), [names[3]!, names[4]!, droppedSegment!].sort());
    assert.ok(h.plane.uploads.some((k) => k.startsWith("org/org_1/agent/agt_1/prod/i-daemon00000000/")));
    assert.equal(h.uploader.status().droppedSegments, 3);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("the heartbeat carries what the uploader knows: drops, quarantine, last upload, backoff — and the daemon reports as airprompterd", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-report-"));
  const plane = new FakeControlPlane(scope);
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply." })]);
  const ap = await AirPrompterAgent.start({ ...scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" }, fetch: plane.fetch(), sdk: { name: "airprompterd", version: "0.1.0" } });
  try {
    assert.deepEqual(ap.heartbeatBody().sdk, { name: "airprompterd", version: "0.1.0" });
    assert.deepEqual(ap.heartbeatBody().spool, { depthSegments: 0, depthBytes: 0, droppedSegments: 0, quarantinedSegments: 0 }, "no uploader: the counters are zero and the optional stamps absent");
    ap.setSpoolReporter(() => ({ droppedSegments: 3, quarantinedSegments: 1, lastUploadAt: "2026-09-12T14:05:00.000Z", backoffUntil: "2026-09-12T14:09:00.000Z" }));
    assert.deepEqual(ap.heartbeatBody().spool, { depthSegments: 0, depthBytes: 0, droppedSegments: 3, quarantinedSegments: 1, lastUploadAt: "2026-09-12T14:05:00.000Z", backoffUntil: "2026-09-12T14:09:00.000Z" });
    // The boot heartbeat is in flight (built before the reporter was set): let it land, then send one that carries the report.
    while (ap.status().heartbeat.lastAt === null) await new Promise((resolve) => setTimeout(resolve, 10));
    await ap.heartbeatNow();
    assert.deepEqual((plane.heartbeats.at(-1)!.spool as { droppedSegments: number }).droppedSegments, 3, "the fake accepted the strict body with the stamps");
    // A grant request for another writer is a heartbeat naming that writer, still reported by airprompterd.
    plane.grantBaseUrl = "https://bucket.test";
    const decision = await ap.requestUploadGrant({ instanceId: "i-writerAAAAAAAA", instanceClass: "resident" });
    assert.equal(decision.kind, "grant");
    assert.equal(plane.heartbeats.at(-1)!.instanceId, "i-writerAAAAAAAA");
    assert.deepEqual(plane.heartbeats.at(-1)!.sdk, { name: "airprompterd", version: "0.1.0" });
    assert.ok((decision as { grant: UploadGrant }).grant.keyPrefix.endsWith("/i-writerAAAAAAAA/"));
    plane.grantHold = { retryAfterSeconds: 120 };
    assert.deepEqual(await ap.requestUploadGrant({ instanceId: "i-writerBBBBBBBB" }), { kind: "hold", retryAfterSeconds: 120, reason: "retry_after" });
  } finally {
    await ap.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("serverless: invoke() flushes the memory sink under the runtime's own grant; a hold keeps the rows for the next invocation", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-flush-"));
  const plane = new FakeControlPlane(scope);
  plane.grantBaseUrl = "https://bucket.test";
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply." })]);
  const ap = await AirPrompterAgent.start({ ...scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "on_invoke", rootUrl: "https://edge.test/roots/prod/root.json" }, fetch: plane.fetch() });
  try {
    const r = ap.prompt("support.reply").render({});
    await ap.invoke(async () => ap.report({ tag: r.tag, versionId: r.versionId, arm: r.arm, model: r.model, status: "ok", latencyMs: 12 }));
    // S5: the flush is awaited — the segment is there the moment invoke() returns, with nothing left for a frozen process to lose.
    assert.equal(plane.uploads.length, 1, "one segment per invocation");
    assert.ok(plane.uploads[0]!.startsWith(`org/org_1/agent/agt_1/prod/${ap.instanceId}/seg-${ap.instanceId}-`));
    const rows = plane.objects.get(plane.uploads[0]!)!.toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; count: number });
    assert.deepEqual(rows.map((x) => [x.type, x.count]), [["window", 1]]);
    assert.deepEqual(ap.drainMemorySink(), [], "flushed rows are gone");
    // A hold: the rows stay buffered and go with the next flush.
    plane.grantHold = { retryAfterSeconds: 60 };
    (ap as unknown as { uploadGrant: null }).uploadGrant = null;
    ap.report({ tag: r.tag, versionId: r.versionId, arm: r.arm, model: r.model, status: "ok", latencyMs: 3 });
    ap.spool.closeWindows(Date.now() + 60_000);
    const held = await ap.flushTelemetry();
    assert.equal(held.status, "held");
    assert.equal(ap.drainMemorySink().length, 1, "kept for the next invocation");
  } finally {
    await ap.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
