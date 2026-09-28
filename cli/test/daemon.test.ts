/**
 * airprompterd as the telemetry daemon (`protocol/daemon.md`, draft 3), as its own process against a fake control
 * plane on a real HTTP listener. It publishes `daemon.json` (0600, the folder it scans) and nothing else: no store, no
 * key file, no socket. Two SDK processes — one resident with a key, one offline that hydrates from the customer's
 * datastore — find the folder, write segments with manifests and run no uploader of their own; the daemon uploads
 * each under that writer's grant, obtained by a heartbeat carrying the writer's own report (the offline one appears
 * in the fleet as `offline`, never as the daemon); a segment that does not match its manifest is quarantined with it;
 * another agent's segment is left alone. A clean stop deletes `daemon.json` and the SDKs take the upload back.
 * `airprompter status` reads the file (and exits 1 when it is stale — the deploy probes' liveness check); the
 * release-serving flags are refused by name.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AirPrompterAgent } from "../../sdk-typescript/packages/sdk/src/agent.js";
import { generateX25519KeyPair } from "../../sdk-typescript/packages/core/src/bundle/hpke.js";
import { SyncClient } from "../../sdk-typescript/packages/core/src/control/client.js";
import { nodeFs } from "../../sdk-typescript/packages/core/src/ports/node.js";
import { publicJwkOf, trustedRootFromPinnedKey } from "../../sdk-typescript/packages/core/src/protocol/trust.js";
import { SlotStore } from "../../sdk-typescript/packages/sync/src/store/slotStore.js";
import { MemoryReleaseDatastore } from "../../sdk-typescript/packages/sync/src/store/releaseDatastore.js";
import { pullToDatastore } from "../../sdk-typescript/packages/sync/src/sync/pullToDatastore.js";
import { manifestNameOf, writeDaemonDiscovery, writeSegmentManifest } from "../../sdk-typescript/packages/telemetry/src/spool/manifest.js";
import { epochMinute, segmentName } from "../../sdk-typescript/packages/telemetry/src/spool/writer.js";
import type { RootMetadata } from "../../sdk-typescript/packages/core/src/protocol/types.js";
import { FakeControlPlane, serveOverHttp } from "../../sdk-typescript/test/helpers/controlPlane.js";
import { run } from "../src/cli.js";
import { EXIT, type Context } from "../src/io.js";

const scope = { organizationId: "org_1", agentId: "agt_1", target: "prod" as const };
const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skip = process.platform === "win32" ? "signals and file modes differ on Windows; the ubuntu lane covers this" : false;

const until = async (check: () => boolean | Promise<boolean>, what: string | (() => string), timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${typeof what === "function" ? what() : what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

interface Daemon {
  child: ChildProcess;
  stderr: string[];
  exited: Promise<number | null>;
}

function startDaemon(args: string[], env: Record<string, string>): Daemon {
  const child = spawn(process.execPath, ["--import", "tsx", join(cliRoot, "src", "main.ts"), "daemon", ...args, "--json"], { cwd: cliRoot, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const stderr: string[] = [];
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => stderr.push(...chunk.split("\n").filter(Boolean)));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, stderr, exited };
}

const events = (daemon: Daemon) => daemon.stderr.map((line) => JSON.parse(line) as Record<string, unknown>);

function capture(work: string, env: Record<string, string> = {}): { ctx: Context; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, ctx: { stdout: (l) => lines.push(l), stderr: (l) => errors.push(l), env, cwd: work, now: () => Date.now(), fetch: null, isTTY: false } };
}

function windowLine(instanceId: string, minuteMs: number): string {
  const minute = new Date(Math.floor(minuteMs / 60_000) * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `${JSON.stringify({ type: "window", v: 1, minute, instanceId, instanceClass: "resident", tag: "support.reply", versionId: "ver_1", arm: "none", model: "gpt-5", status: "ok", errorClass: null, usageSource: "reported", count: 1, latencyMs: { buckets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0], sum: 812 }, tokens: { input: 4, output: 2 }, sdk: "agent-sdk-ts/0.3.0" })}\n`;
}

test("the telemetry daemon: publishes daemon.json and no store; ships two writers' segments under their own grants and reports; quarantines a mismatch; a clean stop hands the upload back", { skip }, async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-daemon-"));
  const plane = new FakeControlPlane(scope);
  plane.promote([plane.slot({ tag: "support.reply", text: "one {{name}}", variables: [{ name: "name", required: false, trust: "operator" }] })]);
  const http = await serveOverHttp(plane);
  plane.grantBaseUrl = http.baseUrl;
  const stateDir = join(work, "state");
  const storeDir = SlotStore.path({ stateDir, ...scope });
  const discoveryPath = join(storeDir, "daemon.json");
  const spoolDir = join(storeDir, "spool", "telemetry");
  const daemon = startDaemon(["--org", scope.organizationId, "--agent", scope.agentId, "--environment", scope.target, "--state-dir", stateDir, "--base-url", http.baseUrl, "--upload-interval-seconds", "1"], { AIRPROMPTER_AGENT_KEY: plane.apiKey });
  const sdks: AirPrompterAgent[] = [];
  try {
    await until(() => existsSync(discoveryPath), () => `daemon.json (daemon said: ${daemon.stderr.join(" | ")})`);
    assert.equal(statSync(discoveryPath).mode & 0o777, 0o600, "daemon.json is 0600");
    const published = JSON.parse(readFileSync(discoveryPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual({ kind: published.kind, pid: published.pid, spoolDir: published.spoolDir, sink: published.sink, agentId: published.agentId }, { kind: "daemon", pid: daemon.child.pid, spoolDir, sink: "airprompter", agentId: scope.agentId });
    assert.equal(existsSync(join(storeDir, "store.json")) || existsSync(join(storeDir, "store.key")), false, "the daemon holds no store and no key file");
    assert.equal(readdirSync(storeDir).some((n) => n.endsWith(".sock")), false, "and no socket");

    // Writer B: offline, hydrated from the customer's datastore (it starts first, so the host's store is its). Writer A:
    // resident with the key, syncing itself. Both find daemon.json beside the store they share.
    const fleet = generateX25519KeyPair();
    const datastore = new MemoryReleaseDatastore();
    const client = new SyncClient({ baseUrl: http.baseUrl, agentId: scope.agentId, target: scope.target, apiKey: plane.apiKey });
    const trustedRoot = trustedRootFromPinnedKey({ purpose: "platform", environment: "prod", pinnedRoot: publicJwkOf(plane.rootKey) });
    const fetchRoot = async () => (await (await fetch(`${http.baseUrl}/roots/prod/root.json`)).json()) as RootMetadata;
    assert.equal((await pullToDatastore({ datastore, region: "eu", client, scope, trustedRoot, fetchRoot, now: () => new Date().toISOString(), distributionPublicKey: fleet.publicRaw })).status, "ok");
    const b = await AirPrompterAgent.start({ ...scope, stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, fetch: async () => { throw new Error("offline"); }, distributionKey: { privateKey: fleet.privateKey, publicRaw: fleet.publicRaw }, datastore: { store: datastore, region: "eu" } });
    sdks.push(b);
    assert.deepEqual({ generation: b.generation, outcome: b.status().datastore!.lastOutcome }, { generation: 1, outcome: "activated" }, "B's release came from the datastore");
    const a = await AirPrompterAgent.start({ ...scope, apiKey: plane.apiKey, baseUrl: http.baseUrl, stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "resident", pollSeconds: 3600, rootUrl: `${http.baseUrl}/roots/prod/root.json` } });
    sdks.push(a);
    assert.equal(a.status().telemetry.uploadedBy, "daemon", `a live daemon ships A's folder: A runs no uploader (${JSON.stringify(a.status().telemetry)})`);
    assert.equal(a.status().upload, null);
    assert.equal(b.status().telemetry.uploadedBy, "daemon");

    for (const sdk of [a, b]) {
      const r = sdk.prompt("support.reply").render({ name: "Ada" });
      sdk.report({ tag: r.tag, versionId: r.versionId, arm: r.arm, model: r.model, status: "ok", latencyMs: 12 });
      sdk.spool.closeWindows(Date.now());
    }
    // Two strangers: a segment that no longer matches its manifest, and another agent's. (A segment lands before its
    // manifest, as a writer does: until the manifest is there the daemon waits out its grace.)
    const now = Date.now();
    const tampered = segmentName("i-tamperedTTTTTTT", epochMinute(now), 0);
    const scratch = join(work, "scratch");
    mkdirSync(scratch);
    writeFileSync(join(scratch, tampered), windowLine("i-tamperedTTTTTTT", now));
    writeSegmentManifest(nodeFs, scratch, tampered, { organizationId: scope.organizationId, agentId: scope.agentId, target: scope.target, report: {}, closedAtMs: now });
    writeFileSync(join(spoolDir, tampered), windowLine("i-tamperedTTTTTTT", now).repeat(2));
    copyFileSync(join(scratch, manifestNameOf(tampered)), join(spoolDir, manifestNameOf(tampered)));
    const foreign = segmentName("i-foreignFFFFFFFF", epochMinute(now), 0);
    writeFileSync(join(spoolDir, foreign), windowLine("i-foreignFFFFFFFF", now));
    writeSegmentManifest(nodeFs, spoolDir, foreign, { organizationId: scope.organizationId, agentId: "agt_other", target: scope.target, report: {}, closedAtMs: now });

    const prefixOf = (instanceId: string) => `org/${scope.organizationId}/agent/${scope.agentId}/${scope.target}/${instanceId}/`;
    await until(() => [a, b].every((sdk) => plane.uploads.some((key) => key.startsWith(prefixOf(sdk.instanceId)))), () => `both writers' segments uploaded (uploads ${plane.uploads.join(", ")}; daemon: ${daemon.stderr.slice(-4).join(" | ")})`);
    await until(() => existsSync(join(spoolDir, "quarantine", tampered)), "the mismatch quarantined");
    assert.ok(existsSync(join(spoolDir, "quarantine", manifestNameOf(tampered))), "with its manifest");
    assert.ok(existsSync(join(spoolDir, foreign)) && existsSync(join(spoolDir, manifestNameOf(foreign))), "another agent's segment is left alone");
    assert.equal(plane.uploads.some((key) => key.includes("i-tamperedTTTTTTT") || key.includes("i-foreignFFFFFFFF")), false);

    // Each grant came from a heartbeat carrying that writer's own report, with the daemon's view of the spool.
    const bReport = plane.heartbeats.find((h) => h.instanceId === b.instanceId);
    assert.ok(bReport, "B, which never talks to AirPrompter, appears in the fleet through the daemon");
    assert.deepEqual({ syncMode: bReport!.syncMode, sdk: (bReport!.sdk as { name: string }).name, active: (bReport!.generation as { active: number }).active }, { syncMode: "offline", sdk: "agent-sdk-typescript", active: 1 }, "as what it is: an offline TypeScript runtime on generation 1, not the daemon");
    assert.ok(plane.heartbeats.some((h) => h.instanceId === a.instanceId && h.syncMode === "resident"));
    assert.equal(daemon.stderr.join("\n").includes("one {{name}}"), false, "daemon logs carry no prompt text");
    await until(() => (JSON.parse(readFileSync(discoveryPath, "utf8")) as { upload: { sentSegments: number } }).upload.sentSegments >= 2, "daemon.json reports the passes");

    // `airprompter status` reads the file: live exits 0.
    const live = capture(work);
    assert.equal(await run(["status", "--agent", scope.agentId, "--environment", scope.target, "--state-dir", stateDir, "--require-daemon", "--json"], live.ctx), EXIT.ok);
    const doc = JSON.parse(live.lines.join("")) as { store: unknown; spoolDir: string; daemon: { live: boolean; pid: number } };
    assert.deepEqual({ store: doc.store, spoolDir: doc.spoolDir, live: doc.daemon.live, pid: doc.daemon.pid }, { store: storeDir, spoolDir, live: true, pid: daemon.child.pid }, "A's store is on this host too; status reads it without the daemon");

    // A clean stop deletes the file; A takes its upload back within a minute (here: now).
    daemon.child.kill("SIGTERM");
    assert.equal(await daemon.exited, 0);
    assert.ok(events(daemon).some((e) => e.event === "final_upload"));
    assert.equal(existsSync(discoveryPath), false, "a clean stop takes daemon.json with it");
    const placement = await a.checkTelemetryDaemon();
    assert.deepEqual({ uploadedBy: placement.uploadedBy, daemon: placement.daemon }, { uploadedBy: "self", daemon: null });
  } finally {
    for (const sdk of sdks) await sdk.stop();
    if (daemon.child.exitCode === null) daemon.child.kill("SIGKILL");
    await http.close();
    rmSync(work, { recursive: true, force: true });
  }
});

test("airprompter status: no store and no daemon is fine; --require-daemon makes it the probe; a stale daemon.json exits 1", async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-daemon-status-"));
  try {
    const stateDir = join(work, "state");
    const storeDir = SlotStore.path({ stateDir, ...scope });
    const base = ["status", "--agent", scope.agentId, "--environment", scope.target, "--state-dir", stateDir, "--json"];
    let out = capture(work);
    assert.equal(await run(base, out.ctx), EXIT.ok);
    assert.deepEqual(JSON.parse(out.lines.join("")).store, null, "no store here, and status did not create one");
    assert.equal(existsSync(join(storeDir, "store.json")) || existsSync(join(storeDir, "store.key")), false);
    out = capture(work);
    assert.equal(await run([...base, "--require-daemon"], out.ctx), EXIT.refused);
    const discovery = (heartbeatAtMs: number) => ({ format: 1 as const, kind: "daemon" as const, daemon: { name: "airprompterd" as const, version: "0.3.0" }, pid: 4242, organizationId: scope.organizationId, agentId: scope.agentId, target: scope.target, spoolDir: join(work, "spool"), startedAt: new Date(heartbeatAtMs).toISOString(), heartbeatAt: new Date(heartbeatAtMs).toISOString(), uploadIntervalSeconds: 300, sink: "otlp" as const, upload: { lastUploadAt: null, backoffUntil: null, sentSegments: 0, quarantinedSegments: 0, droppedSegments: 0, depthSegments: 0, depthBytes: 0 } });
    writeDaemonDiscovery(nodeFs, storeDir, discovery(Date.now()));
    out = capture(work);
    assert.equal(await run([...base, "--require-daemon"], out.ctx), EXIT.ok);
    assert.equal(JSON.parse(out.lines.join("")).spoolDir, join(work, "spool"), "the spool is where the daemon says");
    writeDaemonDiscovery(nodeFs, storeDir, discovery(Date.now() - 11 * 60_000));
    out = capture(work);
    assert.equal(await run(base, out.ctx), EXIT.refused, "a stale file fails the probe");
    assert.equal(JSON.parse(out.lines.join("")).daemon.live, false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the release-serving flags are refused by name: --root, --edge-pointer-url, --poll-seconds, --socket, --apply-policy", async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-daemon-flags-"));
  try {
    const base = ["daemon", "--org", scope.organizationId, "--agent", scope.agentId, "--environment", scope.target, "--state-dir", join(work, "state")];
    for (const extra of [["--root", "root.json"], ["--edge-pointer-url", "https://edge/x"], ["--poll-seconds", "30"], ["--socket", "/run/x.sock"], ["--apply-policy", "unlock_required"]]) {
      const out = capture(work);
      assert.equal(await run([...base, ...extra], out.ctx), EXIT.usage, extra.join(" "));
      assert.match(out.errors.join("\n"), new RegExp(`${extra[0]}.*removed in 0\\.3\\.0`));
    }
    assert.equal(existsSync(join(work, "state")), false, "refused before anything was written");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
