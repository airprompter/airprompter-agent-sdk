/**
 * `protocol/daemon.md` (draft 3): the telemetry daemon ships telemetry and nothing else. `sync.mode: "daemon"` is
 * refused at start. An SDK writes its spool to the folder the daemon publishes in `daemon.json` (unless told
 * otherwise), adds a manifest beside every closed segment, and runs no uploader of its own while a live daemon ships
 * that folder — taking the upload back when the daemon's file goes stale. A process hydrated from the customer's
 * datastore does exactly the same: its release never comes from the daemon. The uploader honours manifests: another
 * pair's segments are left alone, a segment that does not match its manifest is quarantined with it, a manifest-less
 * segment waits out the grace, the writer's report rides to its grant, and an orphan manifest is swept.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent, SPOOL_DIR_ENV, isAgentStartError, type StartOptions } from "../packages/sdk/src/agent.js";
import { generateX25519KeyPair } from "../packages/core/src/bundle/hpke.js";
import { SyncClient } from "../packages/core/src/control/client.js";
import { publicJwkOf, trustedRootFromPinnedKey } from "../packages/core/src/protocol/trust.js";
import { SlotStore } from "../packages/sync/src/store/slotStore.js";
import { MemoryReleaseDatastore } from "../packages/sync/src/store/releaseDatastore.js";
import { pullToDatastore } from "../packages/sync/src/sync/pullToDatastore.js";
import { DirectorySink, epochMinute, segmentName, SpoolWriter, type SpoolRow } from "../packages/telemetry/src/spool/writer.js";
import { MANIFEST_GRACE_MS, manifestNameOf, readSegmentManifest, sha256Hex, writeDaemonDiscovery, writeSegmentManifest, type DaemonDiscovery } from "../packages/telemetry/src/spool/manifest.js";
import { SpoolUploader, type GrantDecision } from "../packages/telemetry/src/uploader.js";
import { nodeFs } from "../packages/core/src/index.js";
import { FakeControlPlane } from "./helpers/controlPlane.js";

const scope: { organizationId: string; agentId: string; target: "dev" | "staging" | "prod" } = { organizationId: "org_1", agentId: "agt_1", target: "prod" };
const T0 = Date.parse("2026-09-20T10:00:10Z");
const heartbeatSchema = JSON.parse(readFileSync(new URL("../../protocol/schemas/heartbeat.schema.json", import.meta.url), "utf8")) as { $defs: { request: { properties: Record<string, unknown>; required: string[] } } };
const manifestSchema = JSON.parse(readFileSync(new URL("../../protocol/schemas/spool-manifest.schema.json", import.meta.url), "utf8")) as { required: string[] };

const storeDirOf = (stateDir: string) => SlotStore.path({ stateDir, agentId: scope.agentId, target: scope.target });
const segmentsIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => /^seg-.*\.ndjson$/.test(n)).sort() : []);
const manifestsIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".manifest.json")).sort() : []);

function discovery(spoolDir: string, heartbeatAtMs: number, overrides: Partial<DaemonDiscovery> = {}): DaemonDiscovery {
  return {
    format: 1,
    kind: "daemon",
    daemon: { name: "airprompterd", version: "0.3.0" },
    pid: 4242,
    organizationId: scope.organizationId,
    agentId: scope.agentId,
    target: scope.target,
    spoolDir,
    startedAt: new Date(heartbeatAtMs).toISOString(),
    heartbeatAt: new Date(heartbeatAtMs).toISOString(),
    uploadIntervalSeconds: 300,
    sink: "airprompter",
    upload: { lastUploadAt: null, backoffUntil: null, sentSegments: 0, quarantinedSegments: 0, droppedSegments: 0, depthSegments: 0, depthBytes: 0 },
    ...overrides,
  };
}

function windowRow(instanceId: string, minuteMs: number): SpoolRow {
  return { type: "window", v: 1, minute: new Date(Math.floor(minuteMs / 60_000) * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"), instanceId, instanceClass: "resident", tag: "support.reply", versionId: "ver_1", arm: "none", model: "gpt-5", status: "ok", errorClass: null, usageSource: "reported", count: 1, latencyMs: { buckets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0], sum: 812 }, tokens: { input: 4, output: 2 }, sdk: "agent-sdk-ts/0.3.0" };
}

function newPlane(clock: { ms: number }): FakeControlPlane {
  const plane = new FakeControlPlane(scope);
  plane.grantBaseUrl = "https://bucket.test";
  plane.now = () => clock.ms;
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply." })]);
  return plane;
}

async function onlineHost(stateDir: string, clock: { ms: number }, extra: Partial<StartOptions> = {}, plane: FakeControlPlane = newPlane(clock)) {
  const ap = await AirPrompterAgent.start({ ...scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" }, fetch: plane.fetch(), now: () => clock.ms, random: () => 0.5, ...extra });
  return { plane, ap };
}

test('sync.mode "daemon" is refused at start: the daemon never serves a release', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-tdaemon-"));
  const plane = new FakeControlPlane(scope);
  try {
    for (const sync of [{ mode: "daemon" }, { daemonSocketPath: "/run/x.sock" }]) {
      await assert.rejects(
        AirPrompterAgent.start({ ...scope, stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: sync as NonNullable<StartOptions["sync"]> }),
        (error: unknown) => isAgentStartError(error) && error.code === "invalid_options" && /removed in 0\.3\.0/.test(error.message),
      );
    }
    assert.equal(existsSync(join(storeDirOf(stateDir), "store.json")), false, "refused before the store was touched");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("every closed segment gets a manifest: its size, digest and rows, the writer's scope, and its heartbeat report without spool", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-tdaemon-"));
  const clock = { ms: T0 };
  const { ap } = await onlineHost(stateDir, clock, { telemetry: { upload: false } });
  try {
    const r = ap.prompt("support.reply").render({});
    ap.report({ tag: r.tag, versionId: r.versionId, arm: r.arm, model: r.model, status: "ok", latencyMs: 12 });
    ap.spool.closeWindows(clock.ms);
    const dir = join(storeDirOf(stateDir), "spool", "telemetry");
    const [segment] = segmentsIn(dir);
    assert.ok(segment);
    assert.deepEqual(manifestsIn(dir), [manifestNameOf(segment)]);
    const read = readSegmentManifest(nodeFs, dir, segment);
    assert.ok(read && read.ok);
    const manifest = read.manifest;
    const bytes = readFileSync(join(dir, segment));
    assert.deepEqual({ bytes: manifest.bytes, sha256: manifest.sha256, rows: manifest.rows, instanceId: manifest.instanceId }, { bytes: bytes.length, sha256: sha256Hex(bytes), rows: 1, instanceId: ap.instanceId });
    assert.deepEqual({ organizationId: manifest.organizationId, agentId: manifest.agentId, target: manifest.target }, scope);
    for (const field of manifestSchema.required) assert.ok(field in manifest, `manifest.${field}`);
    // The report is a heartbeat request minus spool: every key a heartbeat request property, every required one present.
    const { request } = heartbeatSchema.$defs;
    assert.equal("spool" in manifest.report, false, "the daemon adds its own view of the spool");
    for (const key of Object.keys(manifest.report)) assert.ok(key in request.properties, `report.${key} is a heartbeat field`);
    for (const key of request.required.filter((k) => k !== "spool")) assert.ok(key in manifest.report, `report.${key} is present`);
    assert.equal(manifest.report.instanceId, ap.instanceId);
    assert.equal(JSON.stringify(manifest).includes("Reply."), false, "content-free");
  } finally {
    await ap.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a live daemon's folder: the SDK writes there and runs no uploader; when the daemon's file goes stale it takes the upload back, and returns it when the daemon does", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-tdaemon-"));
  const shared = mkdtempSync(join(tmpdir(), "ap-tdaemon-shared-"));
  const clock = { ms: T0 };
  const storeDir = storeDirOf(stateDir);
  mkdirSync(storeDir, { recursive: true });
  writeDaemonDiscovery(nodeFs, storeDir, discovery(shared, clock.ms));
  const events: Array<Record<string, unknown>> = [];
  const { ap } = await onlineHost(stateDir, clock, { logger: (event) => events.push(event) });
  try {
    let placement = ap.status().telemetry;
    assert.deepEqual({ spoolDir: placement.spoolDir, from: placement.spoolDirFrom, uploadedBy: placement.uploadedBy, live: placement.daemon?.live }, { spoolDir: shared, from: "daemon", uploadedBy: "daemon", live: true });
    assert.equal(ap.status().upload, null, "no uploader of its own");
    assert.equal(await ap.uploadNow(), null);
    const r = ap.prompt("support.reply").render({});
    ap.report({ tag: r.tag, versionId: r.versionId, arm: r.arm, model: r.model, status: "ok", latencyMs: 12 });
    ap.spool.closeWindows(clock.ms);
    assert.equal(segmentsIn(shared).length, 1, "the segment is in the daemon's folder");
    assert.equal(manifestsIn(shared).length, 1, "with its manifest");
    assert.deepEqual(ap.healthz().telemetry, { uploadedBy: "daemon", daemon: "live" });

    // The daemon stops refreshing: ten minutes on, its file is stale. The SDK writes to its store's folder and uploads itself.
    clock.ms += 11 * 60_000;
    placement = await ap.checkTelemetryDaemon();
    assert.deepEqual({ spoolDir: placement.spoolDir, from: placement.spoolDirFrom, uploadedBy: placement.uploadedBy, live: placement.daemon?.live }, { spoolDir: join(storeDir, "spool", "telemetry"), from: "default", uploadedBy: "self", live: false });
    assert.ok(ap.status().upload, "the uploader is back");
    assert.deepEqual(ap.healthz().reasons.includes("upload_daemon_stale"), false, "stale, but this process uploads");
    assert.ok(events.some((e) => e.event === "spool_moved"));

    // The daemon comes back: the SDK hands the upload over again.
    writeDaemonDiscovery(nodeFs, storeDir, discovery(shared, clock.ms));
    placement = await ap.checkTelemetryDaemon();
    assert.deepEqual({ spoolDir: placement.spoolDir, uploadedBy: placement.uploadedBy }, { spoolDir: shared, uploadedBy: "daemon" });
    assert.equal(ap.status().upload, null);
    assert.ok(events.some((e) => e.event === "upload_handed_to_daemon"));
  } finally {
    await ap.stop();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("an explicit folder wins and never moves: the option, then AIRPROMPTER_SPOOL_DIR; a daemon naming another folder leaves the upload here", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-tdaemon-"));
  const shared = mkdtempSync(join(tmpdir(), "ap-tdaemon-shared-"));
  const mine = mkdtempSync(join(tmpdir(), "ap-tdaemon-mine-"));
  const envDir = mkdtempSync(join(tmpdir(), "ap-tdaemon-env-"));
  const clock = { ms: T0 };
  const storeDir = storeDirOf(stateDir);
  mkdirSync(storeDir, { recursive: true });
  writeDaemonDiscovery(nodeFs, storeDir, discovery(shared, clock.ms));
  const previous = process.env[SPOOL_DIR_ENV];
  try {
    process.env[SPOOL_DIR_ENV] = envDir;
    const plane = newPlane(clock);
    const first = await onlineHost(stateDir, clock, { telemetry: { spoolDir: mine } }, plane);
    assert.deepEqual({ dir: first.ap.status().telemetry.spoolDir, from: first.ap.status().telemetry.spoolDirFrom, by: first.ap.status().telemetry.uploadedBy }, { dir: mine, from: "option", by: "self" });
    await first.ap.stop();
    const second = await onlineHost(stateDir, clock, {}, plane);
    assert.deepEqual({ dir: second.ap.status().telemetry.spoolDir, from: second.ap.status().telemetry.spoolDirFrom, by: second.ap.status().telemetry.uploadedBy }, { dir: envDir, from: "env", by: "self" });
    await second.ap.stop();
    // The daemon names the same folder the environment does: it ships it.
    writeDaemonDiscovery(nodeFs, storeDir, discovery(envDir, clock.ms));
    const third = await onlineHost(stateDir, clock, {}, plane);
    assert.deepEqual({ from: third.ap.status().telemetry.spoolDirFrom, by: third.ap.status().telemetry.uploadedBy }, { from: "env", by: "daemon" });
    await third.ap.stop();
  } finally {
    if (previous === undefined) delete process.env[SPOOL_DIR_ENV];
    else process.env[SPOOL_DIR_ENV] = previous;
    for (const dir of [stateDir, shared, mine, envDir]) rmSync(dir, { recursive: true, force: true });
  }
});

test("offline with a stale daemon: nothing uploads, and healthz says so", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-tdaemon-"));
  const clock = { ms: T0 };
  const storeDir = storeDirOf(stateDir);
  const plane = new FakeControlPlane(scope);
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply." })]);
  // Seed the store online once, then run offline.
  const seed = await AirPrompterAgent.start({ ...scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" }, fetch: plane.fetch(), now: () => clock.ms, telemetry: { upload: false } });
  await seed.stop();
  writeDaemonDiscovery(nodeFs, storeDir, discovery(join(storeDir, "spool", "telemetry"), clock.ms - 20 * 60_000));
  const ap = await AirPrompterAgent.start({ ...scope, stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, now: () => clock.ms });
  try {
    assert.equal(ap.status().telemetry.uploadedBy, "none");
    const healthz = ap.healthz();
    assert.ok(healthz.reasons.includes("upload_daemon_stale"), JSON.stringify(healthz));
    assert.equal(healthz.ok, true, "degraded, still serving");
    assert.deepEqual(healthz.telemetry, { uploadedBy: "none", daemon: "stale" });
  } finally {
    await ap.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a process hydrated from the customer's datastore loads its release from the datastore, and its telemetry still goes to the daemon's folder", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-tdaemon-"));
  const shared = mkdtempSync(join(tmpdir(), "ap-tdaemon-shared-"));
  const plane = new FakeControlPlane(scope);
  const fleet = generateX25519KeyPair();
  const datastore = new MemoryReleaseDatastore();
  plane.promote([plane.slot({ tag: "support.reply", text: "From the datastore.", versionId: "ver_eu" })]);
  const client = new SyncClient({ baseUrl: "https://api.test", agentId: scope.agentId, target: scope.target, apiKey: plane.apiKey, fetch: plane.fetch() });
  const trustedRoot = trustedRootFromPinnedKey({ purpose: "platform", environment: "prod", pinnedRoot: publicJwkOf(plane.rootKey) });
  const fetchRoot = async () => JSON.parse(await (await plane.fetch()("https://edge.test/roots/prod/root.json", {})).text());
  assert.equal((await pullToDatastore({ datastore, region: "eu", client, scope, trustedRoot, fetchRoot, now: () => new Date().toISOString(), distributionPublicKey: fleet.publicRaw })).status, "ok");
  const storeDir = storeDirOf(stateDir);
  mkdirSync(storeDir, { recursive: true });
  writeDaemonDiscovery(nodeFs, storeDir, discovery(shared, Date.now()));
  const ap = await AirPrompterAgent.start({ ...scope, stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, fetch: async () => { throw new Error("offline"); }, distributionKey: { privateKey: fleet.privateKey, publicRaw: fleet.publicRaw }, datastore: { store: datastore, region: "eu" } });
  try {
    assert.equal(ap.generation, 1);
    assert.equal(ap.status().datastore!.rowsFrom, "region");
    assert.equal(ap.prompt("support.reply").render({}).text, "From the datastore.");
    const r = ap.prompt("support.reply").render({});
    ap.report({ tag: r.tag, versionId: r.versionId, arm: r.arm, model: r.model, status: "ok", latencyMs: 5 });
    ap.spool.closeWindows(Date.now());
    assert.equal(ap.status().telemetry.uploadedBy, "daemon");
    const [manifest] = manifestsIn(shared);
    assert.ok(manifest, "the daemon's folder holds the segment's manifest");
    const report = (JSON.parse(readFileSync(join(shared, manifest), "utf8")) as { report: { syncMode: string; generation: { active: number } } }).report;
    assert.deepEqual({ syncMode: report.syncMode, active: report.generation.active }, { syncMode: "offline", active: 1 }, "the daemon reports it as what it is");
  } finally {
    await ap.stop();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("the uploader honours manifests: another pair's left alone, a mismatch quarantined with its manifest, a manifest-less segment waits out the grace, the report rides to the grant, orphans swept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ap-tdaemon-up-"));
  const clock = { ms: T0 };
  const asked: Array<{ instanceId: string; report: Record<string, unknown> | undefined }> = [];
  const shipped: string[] = [];
  const grant = (): GrantDecision => ({ kind: "grant", grant: { grantId: "g", url: "https://bucket.test", fields: {}, keyPrefix: "p/", expiresAt: new Date(clock.ms + 900_000).toISOString(), maxObjectBytes: 1024 * 1024 } });
  const uploader = new SpoolUploader({
    dir,
    instanceId: "i-daemonDDDDDDDD",
    scope: { agentId: scope.agentId, target: scope.target },
    grantFor: async (instanceId, report) => (asked.push({ instanceId, report }), grant()),
    fetch: async (_url, init) => {
      const body = Buffer.from(init!.body as Uint8Array).toString("utf8");
      shipped.push(/filename="([^"]+)"/.exec(body)![1]!);
      return { status: 204, headers: { get: () => null }, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) } as never;
    },
    now: () => clock.ms,
    random: () => 0,
  });
  const report = { protocol: "0.3.4", instanceId: "i-writerAAAAAAAA", sdk: { name: "agent-sdk-typescript", version: "0.3.0" }, syncMode: "offline", generation: { active: 3 }, applyState: "active", storageProtection: "file_key", catalog: { models: [] }, lease: { expired: false } };
  const write = (instanceId: string, n: number, manifestScope: { agentId: string; target: string } | null) => {
    const name = segmentName(instanceId, epochMinute(clock.ms), n);
    writeFileSync(join(dir, name), `${JSON.stringify(windowRow(instanceId, clock.ms))}\n`);
    if (manifestScope) writeSegmentManifest(nodeFs, dir, name, { organizationId: scope.organizationId, ...manifestScope, report, closedAtMs: clock.ms });
    return name;
  };
  try {
    const ours = write("i-writerAAAAAAAA", 0, scope);
    const theirs = write("i-writerBBBBBBBB", 0, { agentId: "agt_other", target: "prod" });
    const tampered = write("i-writerCCCCCCCC", 0, scope);
    writeFileSync(join(dir, tampered), `${JSON.stringify(windowRow("i-writerCCCCCCCC", clock.ms))}\n${JSON.stringify(windowRow("i-writerCCCCCCCC", clock.ms))}\n`);
    const bare = write("i-writerEEEEEEEE", 0, null);
    writeFileSync(join(dir, "seg-i-goneGGGGGGGG-1-0.manifest.json"), "{}");

    let pass = await uploader.runOnce();
    assert.deepEqual(pass.uploaded, [ours], "ours now; the bare one waits for its writer's manifest");
    assert.deepEqual(pass.quarantined, [tampered]);
    assert.ok(existsSync(join(dir, "quarantine", tampered)) && existsSync(join(dir, "quarantine", manifestNameOf(tampered))), "the pair moves together");
    assert.equal(existsSync(join(dir, manifestNameOf(ours))), false, "acknowledged: the segment, then its manifest");
    assert.deepEqual(asked, [{ instanceId: "i-writerAAAAAAAA", report: { ...report } }], "the writer's own report rides to its grant");
    assert.ok(existsSync(join(dir, theirs)) && existsSync(join(dir, manifestNameOf(theirs))), "another pair's: never uploaded, never deleted");
    assert.equal(uploader.status().foreignSegments, 1);

    clock.ms += MANIFEST_GRACE_MS;
    pass = await uploader.runOnce();
    assert.deepEqual(pass.uploaded, [bare], "past the grace it goes, under the uploader's own scope");
    assert.deepEqual(asked.at(-1), { instanceId: "i-writerEEEEEEEE", report: undefined });
    assert.equal(existsSync(join(dir, "seg-i-goneGGGGGGGG-1-0.manifest.json")), false, "an orphan manifest is swept once past the grace");
    assert.ok(existsSync(join(dir, theirs)));
    assert.deepEqual(shipped, [ours, bare]);
  } finally {
    await uploader.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the sink's own eviction takes each evicted segment's manifest with it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ap-tdaemon-evict-"));
  try {
    const context = { organizationId: scope.organizationId, agentId: scope.agentId, target: scope.target, report: { protocol: "0.3.4" } };
    const sink = new DirectorySink(dir, "i-writerAAAAAAAA", 900, nodeFs, { manifest: () => context, now: () => T0 });
    const writer = new SpoolWriter(sink, { instanceId: "i-writerAAAAAAAA", instanceClass: "resident", sdk: "agent-sdk-ts/0.3.0" });
    for (let i = 0; i < 4; i += 1) {
      writer.observe({ tag: "support.reply", versionId: "ver_1", arm: "none", model: "gpt-5", status: "ok", latencyMs: 10 }, T0 + i * 60_000);
      writer.closeWindows(T0 + i * 60_000);
    }
    const segments = segmentsIn(dir);
    assert.ok(segments.length < 5, "the budget evicted some");
    assert.deepEqual(manifestsIn(dir), segments.map(manifestNameOf), "a manifest for every segment left, none for an evicted one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
