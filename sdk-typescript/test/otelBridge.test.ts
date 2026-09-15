/**
 * S13 — `@airprompter/otel-bridge`: the spool as an OTLP exporter.
 *
 *   1. The mapping is the protocol's vector (`otel-mapping.json`): every spool field lands where docs/telemetry.md says.
 *   2. The sink's outcomes: a 2xx ships; a 5xx, a 4xx or a thrown exporter DROPS and counts; an unanswered request (the network) FAILS and is kept (never
 *      holds the spool); a 429/503 with Retry-After holds for that long.
 *   3. The uploader over the bridge: a shipped segment is deleted, a dropped one is deleted and counted, a held one
 *      stays; no grant is ever requested; `status().sink` names it.
 *   4. In-process: `AirPrompterAgent.start({ telemetry: { uploadSink } })` runs the bridge on a host with no key.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publicJwkOf } from "../packages/core/src/protocol/trust.js";
import type { SpoolRow, UploadSegment } from "../packages/core/src/index.js";
import { FakeControlPlane } from "../packages/core/src/testing/index.js";
import { httpJsonExporter, otlpUploadSink, spoolRowsToOtlp } from "../packages/otel-bridge/src/index.js";
import { AirPrompterAgent } from "../packages/sdk/src/agent.js";
import { SpoolUploader, epochMinute, segmentName } from "../packages/telemetry/src/index.js";

const vector = JSON.parse(readFileSync(new URL("../../protocol/vectors/otel-mapping.json", import.meta.url), "utf8")) as { cases: Array<{ name: string; rows: SpoolRow[]; resource: Record<string, string>; expected: unknown }> };
const T0 = Date.parse("2026-09-12T14:03:10Z");
const WRITER = "i-writerAAAAAAAA";

function windowRow(minute: string, instanceId = WRITER): SpoolRow {
  return { type: "window", v: 1, minute, instanceId, instanceClass: "resident", tag: "support.triage", versionId: "ver_1", arm: "none", model: "gpt-5", status: "ok", errorClass: null, usageSource: "reported", count: 1, latencyMs: { buckets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0], sum: 812 }, tokens: { input: 40, output: 9 }, sdk: "agent-sdk-ts/0.1.0" };
}

function writeSegment(dir: string, minuteMs: number, n: number, rows: SpoolRow[]): string {
  const name = segmentName(WRITER, epochMinute(minuteMs), n);
  writeFileSync(join(dir, name), rows.map((row) => `${JSON.stringify(row)}\n`).join(""), { mode: 0o600 });
  return name;
}

/** A collector: records every request; answers what the script says, in order. */
function collector(script: Array<{ status: number; headers?: Record<string, string> } | "network">) {
  const requests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const fetch = async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    const next = script.shift() ?? { status: 200 };
    if (next === "network") throw new Error("ECONNREFUSED");
    requests.push({ url, headers: init?.headers ?? {}, body: JSON.parse(init?.body ?? "null") });
    return { status: next.status, headers: { get: (name: string) => next.headers?.[name.toLowerCase()] ?? null }, arrayBuffer: async () => new ArrayBuffer(0), text: async () => "" };
  };
  return { requests, fetch: fetch as never };
}

test("the mapping is the protocol's vector: every spool field lands where docs/telemetry.md says, and nothing else does", () => {
  for (const c of vector.cases) {
    // The vector fixes the scope version it was generated with; the bridge defaults to SDK_VERSION when none is given.
    assert.deepEqual(spoolRowsToOtlp(c.rows, { resource: c.resource, sdkVersion: "0.1.0" }), c.expected, c.name);
  }
  const request = spoolRowsToOtlp(vector.cases[2]!.rows, { resource: vector.cases[2]!.resource, sdkVersion: "0.1.0" });
  const text = JSON.stringify(request);
  assert.doesNotMatch(text, /Triage|helpful|prompt text/, "no prompt text can appear: the rows have no field for it");
  assert.equal(spoolRowsToOtlp([]).resourceMetrics[0]!.scopeMetrics[0]!.metrics.length, 0, "no rows, no metrics");
});

test("the sink: a 2xx ships; 5xx, 4xx and a thrown exporter drop and count; a network error fails and keeps; 429/503 with Retry-After holds", async () => {
  const c = collector([{ status: 200 }, { status: 500 }, { status: 400 }, "network", { status: 429, headers: { "retry-after": "30" } }, { status: 503, headers: { "retry-after": "5" } }]);
  const sink = otlpUploadSink({ endpoint: "http://collector.test/v1/metrics", headers: { authorization: "Bearer c" }, resource: { "service.name": "support-bot" }, fetch: c.fetch, now: () => T0 });
  assert.equal(sink.kind, "otlp");
  const segment: UploadSegment = { instanceId: WRITER, segment: "seg-x", rows: [windowRow("2026-09-12T14:03:00Z")], bytes: new Uint8Array() };
  assert.deepEqual(await sink.ship(segment), { status: "ok" });
  assert.equal(c.requests[0]!.url, "http://collector.test/v1/metrics");
  assert.equal(c.requests[0]!.headers.authorization, "Bearer c");
  assert.deepEqual(c.requests[0]!.body, spoolRowsToOtlp(segment.rows, { resource: { "service.name": "support-bot" } }), "the request is the mapping");
  assert.deepEqual(await sink.ship(segment), { status: "dropped", reason: "http_500" });
  assert.deepEqual(await sink.ship(segment), { status: "dropped", reason: "http_400" });
  assert.deepEqual(await sink.ship(segment), { status: "failed", reason: "network:ECONNREFUSED" }, "unanswered is not a decision: kept under backoff");
  assert.deepEqual(await sink.ship(segment), { status: "hold", retryAfterMs: 30_000, reason: "http_429" });
  assert.deepEqual(await sink.ship(segment), { status: "hold", retryAfterMs: 5_000, reason: "http_503" });
  assert.deepEqual(sink.status(), { exported: 1, dropped: 2, lastExportAt: new Date(T0).toISOString(), lastError: "http_503" });
  const throwing = otlpUploadSink({ exporter: { export: async () => { throw new Error("boom"); } } });
  assert.deepEqual(await throwing.ship(segment), { status: "dropped", reason: "exporter:boom" });
  const custom = otlpUploadSink({ exporter: { export: async () => undefined } });
  assert.deepEqual(await custom.ship(segment), { status: "ok" }, "an exporter that resolves with nothing shipped");
  assert.throws(() => otlpUploadSink({}), /endpoint or an exporter/);
  assert.equal(typeof httpJsonExporter({ endpoint: "x", fetch: c.fetch }).export, "function");
});

test("the uploader over the bridge: shipped segments are deleted, dropped ones deleted and counted, held ones kept; no grant is ever requested", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ap-otel-"));
  try {
    const c = collector([{ status: 200 }, { status: 500 }, { status: 429, headers: { "retry-after": "60" } }]);
    const events: Array<Record<string, unknown>> = [];
    let grantCalls = 0;
    const sink = otlpUploadSink({ endpoint: "http://collector.test/v1/metrics", fetch: c.fetch, now: () => T0 });
    const uploader = new SpoolUploader({ dir, instanceId: "i-daemon00000000", sink, grantFor: async () => { grantCalls += 1; return { kind: "unavailable", reason: "never" }; }, fetch: c.fetch, now: () => T0, random: () => 0.5, logger: (e) => events.push(e) });
    const shipped = writeSegment(dir, T0 - 120_000, 0, [windowRow("2026-09-12T14:01:00Z")]);
    const dropped = writeSegment(dir, T0 - 60_000, 0, [windowRow("2026-09-12T14:02:00Z")]);
    const held = writeSegment(dir, T0, 0, [windowRow("2026-09-12T14:03:00Z")]);
    const first = await uploader.runOnce();
    assert.deepEqual({ uploaded: first.uploaded, dropped: first.dropped, held: first.held }, { uploaded: [shipped], dropped: 1, held: true });
    assert.equal(existsSync(join(dir, shipped)), false, "shipped: deleted on ack");
    assert.equal(existsSync(join(dir, dropped)), false, "dropped: deleted, never retried");
    assert.equal(existsSync(join(dir, held)), true, "held: kept for the retry");
    assert.equal(grantCalls, 0, "no AirPrompter grant was ever requested");
    const status = uploader.status();
    assert.equal(status.sink, "otlp");
    assert.equal(status.droppedSegments, 1);
    assert.equal(status.sentSegments, 1);
    assert.deepEqual(status.grants, []);
    assert.ok(status.backoffUntil && Date.parse(status.backoffUntil) === T0 + 60_000, "the hold is the collector's Retry-After");
    assert.ok(events.some((e) => e.event === "segment_dropped_by_sink" && e.sink === "otlp" && e.reason === "http_500"), JSON.stringify(events));
    assert.equal(c.requests.length, 3);
    assert.equal(readdirSync(dir).filter((n) => n.startsWith("seg-")).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("in-process: a host with no Agent key runs the bridge from AirPrompterAgent.start({ telemetry: { uploadSink } }) and its windows reach the collector", async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-otel-host-"));
  try {
    const plane = new FakeControlPlane({ organizationId: "org_1", agentId: "agt_1", target: "prod" });
    plane.promote([plane.slot({ tag: "support.reply", text: "Reply {{name}}", versionId: "v1", variables: [{ name: "name", required: false, trust: "operator" }] })]);
    // Vendored bundle, no key: the host never calls AirPrompter — and still exports its telemetry.
    const { createPlaintextBundle } = await import("../packages/core/src/bundle/apbundle.js");
    const bundle = createPlaintextBundle({ createdAt: new Date().toISOString(), notAfter: "2027-01-01T00:00:00Z", manifest: plane.manifest!, keySet: plane.root, payloads: [...plane.payloads].map(([contentHash, bytes]) => ({ contentHash: contentHash as `sha256:${string}`, byteLength: bytes.length, bytes: bytes.toString("base64url") })) });
    const c = collector([]);
    const clock = { ms: T0 };
    const sink = otlpUploadSink({ endpoint: "http://collector.test/v1/metrics", resource: { "service.name": "support-bot" }, fetch: c.fetch, now: () => clock.ms });
    const events: Array<Record<string, unknown>> = [];
    const ap = await AirPrompterAgent.start({ organizationId: "org_1", agentId: "agt_1", target: "prod", stateDir: work, root: { pinned: publicJwkOf(plane.rootKey) }, vendoredBundle: { bundle }, now: () => clock.ms, telemetry: { uploadSink: sink }, logger: (e) => events.push(e) });
    try {
      assert.ok(events.some((e) => e.event === "uploader_started" && e.sink === "otlp"), JSON.stringify(events.map((e) => e.event)));
      const r = ap.prompt("support.reply").render({ name: "Ada" });
      ap.report({ tag: r.tag, versionId: r.versionId, arm: r.arm, model: r.model, status: "ok", latencyMs: 120, tokens: { input: 10, output: 5 } });
      clock.ms += 61_000;
      ap.spool.closeWindows(clock.ms);
      const pass = await ap.uploadNow();
      assert.ok(pass && pass.uploaded === 1, JSON.stringify(pass));
      assert.equal(c.requests.length, 1);
      const body = c.requests[0]!.body as { resourceMetrics: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }; scopeMetrics: Array<{ metrics: Array<{ name: string }> }> }> };
      assert.ok(body.resourceMetrics[0]!.resource.attributes.some((a) => a.key === "service.name" && a.value.stringValue === "support-bot"));
      assert.ok(body.resourceMetrics[0]!.scopeMetrics[0]!.metrics.some((m) => m.name === "gen_ai.client.operation.duration"));
      assert.equal(plane.requests.filter((u) => u.includes("heartbeat")).length, 0, "no key, no heartbeat, no grant: the collector is the only destination");
    } finally {
      await ap.stop();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
