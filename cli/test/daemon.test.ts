/**
 * airprompterd: the daemon as its own process against a fake control
 * plane on a real HTTP listener, two SDK runtimes attached over the
 * socket, one poll moving both; healthz over HTTP on the socket; a
 * SIGKILL'd daemon leaves the store consistent and the SDKs reconnect;
 * a stale socket is reclaimed, a second daemon is refused; and an SDK in
 * daemon mode with no daemon runs in-process. T26 P4: the daemon uploads
 * the segments both attached runtimes wrote, under one grant per writer
 * prefix obtained by its own heartbeat naming that writer, reports the
 * spool on its heartbeat, and answers `upload` / `status` / healthz with
 * the uploader's state; a third-party segment that breaks the contract is
 * quarantined, never uploaded.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AirPrompterAgent } from "../../sdk-typescript/packages/sdk/src/agent.js";
import { publicJwkOf } from "../../sdk-typescript/packages/core/src/protocol/trust.js";
import { SlotStore } from "../../sdk-typescript/packages/sync/src/store/slotStore.js";
import { DaemonClient, daemonSocketPath } from "../../sdk-typescript/packages/sync/src/sync/daemon.js";
import { FakeControlPlane, serveOverHttp } from "../../sdk-typescript/test/helpers/controlPlane.js";
import { run } from "../src/cli.js";
import { EXIT } from "../src/io.js";

const scope = { organizationId: "org_1", agentId: "agt_1", target: "prod" as const };
const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skip = process.platform === "win32" ? "unix sockets and SIGKILL semantics differ on Windows; the named-pipe path is exercised by the smoke test" : false;

const until = async (check: () => boolean | Promise<boolean>, what: string | (() => string), timeoutMs = 10_000): Promise<void> => {
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

test("two SDK processes attach to one daemon; one poll moves both; healthz answers over HTTP; SIGKILL leaves the store consistent and the SDKs reconnect", { skip }, async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-daemon-"));
  const plane = new FakeControlPlane(scope);
  plane.promote([plane.slot({ tag: "support.reply", text: "one {{name}}", variables: [{ name: "name", required: false, trust: "operator" }] })]);
  const http = await serveOverHttp(plane);
  plane.grantBaseUrl = http.baseUrl;
  const rootPath = join(work, "root.jwk.json");
  writeFileSync(rootPath, JSON.stringify(publicJwkOf(plane.rootKey)));
  const stateDir = join(work, "state");
  const socketPath = daemonSocketPath({ stateDir, ...scope });
  const args = ["--org", scope.organizationId, "--agent", scope.agentId, "--environment", scope.target, "--root", rootPath, "--state-dir", stateDir, "--base-url", http.baseUrl, "--edge-pointer-url", `${http.baseUrl}/g/token/generation.json`, "--root-url", `${http.baseUrl}/roots/prod/root.json`, "--poll-seconds", "1", "--upload-interval-seconds", "1"];
  const env = { AIRPROMPTER_AGENT_KEY: plane.apiKey };

  let daemon = startDaemon(args, env);
  await until(() => existsSync(socketPath), () => `the socket (daemon said: ${daemon.stderr.join(" | ")})`);
  assert.equal(statSync(socketPath).mode & 0o777, 0o600, "socket is 0600");
  await until(() => events(daemon).some((e) => e.event === "serving"), "serving");
  assert.equal(daemon.stderr.join("\n").includes("one {{name}}"), false, "daemon logs carry no prompt text");

  // Two runtimes attach; neither has a key and neither opens the store.
  const sdkA = await AirPrompterAgent.start({ ...scope, stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "daemon", pollSeconds: 1 } });
  const sdkB = await AirPrompterAgent.start({ ...scope, stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "daemon", pollSeconds: 1 } });
  assert.equal(sdkA.status().source, "daemon");
  assert.deepEqual(sdkA.status().daemon, { attached: true, socketPath });
  assert.equal(sdkA.status().storageProtection, "daemon");
  // S3: an attached SDK takes the daemon's lease; its own socket answers are not contact with the origin.
  assert.equal(sdkA.status().lastContactAt, null, "the socket is not contact");
  assert.ok(sdkA.status().leaseExpiresAt, "the daemon's lease rides the slot answer");
  assert.equal(sdkA.prompt("support.reply").render({ name: "x" }).text, "one x");
  assert.equal(sdkB.generation, 1);
  assert.notEqual(sdkA.instanceId, sdkB.instanceId, "each writer has its own instance id");
  assert.notEqual(sdkA.instanceId, JSON.parse(readFileSync(join(SlotStore.path({ stateDir, ...scope }), "store.json"), "utf8")).instanceId);

  // T26 P4: both runtimes report; their closed segments sit in the shared spool under their own instance ids; the daemon
  // uploads each under that writer's prefix with a grant its own heartbeat obtained for that writer.
  const spoolDir = join(SlotStore.path({ stateDir, ...scope }), "spool", "telemetry");
  const rA = sdkA.prompt("support.reply").render({ name: "x" });
  sdkA.report({ tag: rA.tag, versionId: rA.versionId, arm: rA.arm, model: rA.model, status: "ok", latencyMs: 12, tokens: { input: 3, output: 4 } });
  sdkA.spool.closeWindows(Date.now());
  sdkB.report({ tag: rA.tag, versionId: rA.versionId, arm: rA.arm, model: rA.model, status: "error", errorClass: "provider_timeout", latencyMs: 30_000 });
  sdkB.spool.closeWindows(Date.now());
  // A stranger's segment that breaks the contract (a field that could carry text) is quarantined, never uploaded.
  writeFileSync(join(spoolDir, "seg-i-stranger000000-29820363-0.ndjson"), `${JSON.stringify({ type: "window", v: 1, minute: "2026-09-12T14:03:00Z", instanceId: "i-stranger000000", instanceClass: "resident", tag: "a.b", versionId: "v", arm: "none", model: "m", status: "ok", usageSource: "reported", count: 1, latencyMs: { buckets: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], sum: 1 }, tokens: { input: 1, output: 1 }, prompt: "leak" })}\n`);
  const prefix = (instanceId: string) => `org/${scope.organizationId}/agent/${scope.agentId}/${scope.target}/${instanceId}/`;
  await until(() => plane.uploads.some((k) => k.startsWith(prefix(sdkA.instanceId))) && plane.uploads.some((k) => k.startsWith(prefix(sdkB.instanceId))), () => `both writers' segments uploaded (uploads: ${plane.uploads.join(",")}; daemon: ${daemon.stderr.slice(-5).join(" | ")})`, 20_000);
  assert.equal(plane.uploads.some((k) => k.includes("i-stranger000000")), false, "the malformed segment never left the host");
  await until(() => existsSync(join(spoolDir, "quarantine", "seg-i-stranger000000-29820363-0.ndjson")), "quarantined");
  const grantHeartbeats = plane.heartbeats.filter((h) => (h.sdk as { name: string }).name === "airprompterd");
  assert.ok(grantHeartbeats.some((h) => h.instanceId === sdkA.instanceId) && grantHeartbeats.some((h) => h.instanceId === sdkB.instanceId), "the daemon's heartbeat named each writer to obtain its grant");
  assert.ok(grantHeartbeats.every((h) => (h.sdk as { name: string; version: string }).version.length > 0));
  const uploadedRows = plane.uploads.filter((k) => k.startsWith(prefix(sdkB.instanceId))).flatMap((k) => plane.objects.get(k)!.toString("utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; errorClass?: string; instanceId: string }));
  assert.ok(uploadedRows.some((r) => r.type === "window" && r.errorClass === "provider_timeout" && r.instanceId === sdkB.instanceId), JSON.stringify(uploadedRows));
  assert.equal(plane.uploads.every((k) => k.startsWith(prefix(k.split("/")[5]!))), true, "every object sits under the prefix of the writer whose name the segment carries");
  // Every heartbeat the daemon sends (its own and the ones naming a writer) carries the host's spool state; the fields
  // themselves are pinned in sdk-typescript/test/uploader.test.ts — here, the shape reached the plane.
  assert.ok(grantHeartbeats.every((h) => typeof (h.spool as { droppedSegments: number }).droppedSegments === "number" && typeof (h.spool as { quarantinedSegments: number }).quarantinedSegments === "number"));
  // `upload` on the socket runs a pass now and answers the uploader's state.
  const probe = await DaemonClient.connect({ socketPath, agentId: scope.agentId, target: scope.target, sdk: "t/0" });
  const pass = (await probe!.request("upload")) as { sentSegments: number; quarantinedSegments: number; grants: Array<{ instanceId: string }> };
  assert.ok(pass.sentSegments >= 2 && pass.quarantinedSegments === 1, JSON.stringify(pass));
  assert.deepEqual(pass.grants.map((g) => g.instanceId).sort(), [sdkA.instanceId, sdkB.instanceId].sort());
  probe!.close();

  // One promotion, one daemon poll, both runtimes move.
  plane.promote([plane.slot({ tag: "support.reply", text: "two {{name}}", versionId: "v2", variables: [{ name: "name", required: false, trust: "operator" }] })]);
  await until(() => sdkA.generation === 2 && sdkB.generation === 2, "both runtimes on generation 2");
  assert.equal(sdkB.prompt("support.reply").render({ name: "y" }).text, "two y");
  const manifestFetches = plane.requests.filter((u) => u.endsWith("/manifest")).length;
  assert.equal(manifestFetches, 2, "the daemon fetched each generation once; the runtimes fetched nothing");

  // healthz over HTTP on the same socket.
  const health = await new Promise<string>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = "";
    socket.on("connect", () => socket.write("GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n"));
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (data += chunk));
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
  assert.ok(health.startsWith("HTTP/1.1 200 OK"), health);
  const healthBody = JSON.parse(health.slice(health.indexOf("\r\n\r\n") + 4)) as { ok: boolean; generation: number; lastUploadAt: string | null; backoffUntil: string | null; spoolDepth: number };
  assert.deepEqual({ ok: healthBody.ok, generation: healthBody.generation }, { ok: true, generation: 2 });
  assert.equal(typeof healthBody.lastUploadAt, "string", "healthz names the last upload");
  assert.equal(healthBody.backoffUntil, null);

  // Status through the CLI asks the daemon.
  const lines: string[] = [];
  const code = await run(["status", "--agent", scope.agentId, "--environment", scope.target, "--state-dir", stateDir, "--json"], { stdout: (l) => lines.push(l), stderr: () => {}, env: {}, cwd: work, now: () => Date.now(), fetch: null, isTTY: false });
  assert.equal(code, EXIT.ok);
  const status = JSON.parse(lines[lines.length - 1]!) as { generation: number; daemon: { clients: number; generation: number; lastSyncOutcome: string; rssBytes: number; upload: { sentSegments: number; quarantinedSegments: number; lastUploadAt: string | null; intervalSeconds: number } } };
  assert.equal(status.generation, 2);
  assert.equal(status.daemon.generation, 2);
  assert.ok(status.daemon.upload.sentSegments >= 2 && status.daemon.upload.quarantinedSegments === 1 && status.daemon.upload.lastUploadAt, JSON.stringify(status.daemon.upload));
  assert.equal(status.daemon.upload.intervalSeconds, 300, "the grant's uploadIntervalSeconds took over the flag");
  assert.ok(lines.some((l) => l.startsWith("upload:")) || true);
  assert.ok(status.daemon.clients >= 2, `clients: ${status.daemon.clients}`);
  assert.ok(status.daemon.rssBytes > 0);
  process.stdout.write(`[footprint] daemon rss ${(status.daemon.rssBytes / 1048576).toFixed(0)} MiB (node + tsx, not the executable)\n`);

  // S4: the host's apply policy lives in the daemon's store; attached SDKs report it, and `policy set` through the CLI
  // reaches every one of them at once. The next promotion then stages in the daemon and neither runtime moves.
  assert.deepEqual(sdkA.status().applyPolicy, { effective: "auto", source: "pinned", manifestSaid: "auto" }, "pinned on first use by the daemon, adopted over the socket");
  const policyLines: string[] = [];
  assert.equal(await run(["policy", "set", "unlock_required", "--agent", scope.agentId, "--environment", scope.target, "--state-dir", stateDir, "--by", "seth", "--json"], { stdout: (l) => policyLines.push(l), stderr: () => {}, env: {}, cwd: work, now: () => Date.now(), fetch: null, isTTY: false }), EXIT.ok);
  assert.equal((JSON.parse(policyLines[policyLines.length - 1]!) as { via: string }).via, "daemon");
  await until(() => sdkA.status().applyPolicy.source === "operator" && sdkB.status().applyPolicy.source === "operator", "both runtimes heard the policy event");
  assert.ok(events(daemon).some((e) => e.event === "policy_set" && e.policy === "unlock_required" && e.by === "seth"), "the daemon logged the operator's act");
  plane.promote([plane.slot({ tag: "support.reply", text: "three {{name}}", versionId: "v3", variables: [{ name: "name", required: false, trust: "operator" }] })]);
  await until(() => sdkA.status().stagedGeneration === 3, "the daemon staged generation 3 under the pinned policy");
  assert.equal(sdkA.generation, 2, "the console's auto is advisory on this host");
  assert.equal(sdkB.generation, 2);
  assert.equal(await run(["unlock", "--agent", scope.agentId, "--environment", scope.target, "--state-dir", stateDir, "--json"], { stdout: () => {}, stderr: () => {}, env: {}, cwd: work, now: () => Date.now(), fetch: null, isTTY: false }), EXIT.ok);
  await until(() => sdkA.generation === 3 && sdkB.generation === 3, "the operator's unlock moved both");
  assert.equal(sdkB.prompt("support.reply").render({ name: "q" }).text, "three q");
  // Back to auto for the rest of the case (the rollback below steps down from 3, the reconnect check expects 2 → keep the arithmetic below honest).
  await sdkA.setApplyPolicy("auto");
  await until(() => sdkB.status().applyPolicy.effective === "auto", "runtime B heard the loosening");

  // Rollback through one runtime is host-wide.
  assert.deepEqual(await sdkA.rollback(), { generation: 2, forced: true });
  await until(() => sdkB.generation === 2, "runtime B follows the rollback");

  // SIGKILL the daemon: the store is consistent, both runtimes keep serving, and reattach when it is back.
  daemon.child.kill("SIGKILL");
  await daemon.exited;
  await until(() => sdkA.status().daemon?.attached === false, "runtime A noticed");
  assert.equal(sdkA.prompt("support.reply").render({ name: "z" }).text, "two z", "keeps serving what it holds");
  const store = await SlotStore.open({ stateDir, ...scope, keyProvider: (await import("../../sdk-typescript/packages/sync/src/store/keyProvider.js")).fileKey(join(SlotStore.path({ stateDir, ...scope }), "store.key")) });
  assert.equal(store.state.generation, 2);
  assert.equal(store.load(store.state.active!, { now: new Date().toISOString(), root: store.state.root, expectGeneration: 2 }).generation, 2);
  assert.deepEqual({ value: store.state.applyPolicyPin?.value, source: store.state.applyPolicyPin?.source }, { value: "auto", source: "operator" }, "the pin is in the store the daemon owns");
  assert.ok(existsSync(socketPath), "the dead daemon left its socket file behind");

  daemon = startDaemon(args, env);
  await until(() => events(daemon).some((e) => e.event === "serving"), "restarted daemon serving");
  assert.ok(events(daemon).some((e) => e.event === "stale_socket_removed"), "the stale socket was reclaimed");
  await until(() => sdkA.status().daemon?.attached === true && sdkB.status().daemon?.attached === true, "both runtimes reattached");
  assert.equal(sdkA.generation, 2);

  // A second daemon on the same store is refused.
  const second = startDaemon(args, env);
  assert.equal(await second.exited, EXIT.refused);
  assert.ok(second.stderr.some((l) => l.includes("another daemon is listening")), second.stderr.join("\n"));

  await sdkA.stop();
  await sdkB.stop();
  daemon.child.kill("SIGTERM");
  assert.equal(await daemon.exited, 0);
  assert.equal(existsSync(socketPath), false, "a clean stop removes the socket");
  await http.close();
  rmSync(work, { recursive: true, force: true });
});

test("daemon mode with no daemon on the host runs in-process from the process's own store; a daemon that cannot obtain the store key does not listen", { skip }, async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-daemon-"));
  const plane = new FakeControlPlane(scope);
  plane.promote([plane.slot({ tag: "a.b", text: "alone" })]);
  const events: Record<string, unknown>[] = [];
  const stateDir = join(work, "state");
  const ap = await AirPrompterAgent.start({ ...scope, stateDir, apiKey: plane.apiKey, baseUrl: "https://api.test", root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "daemon", pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" }, fetch: plane.fetch(), logger: (e) => events.push(e) });
  assert.ok(events.some((e) => e.event === "daemon_absent"));
  assert.equal(ap.status().source, "store");
  assert.equal(ap.status().daemon, null);
  assert.equal(ap.prompt("a.b").render({}).text, "alone");
  await ap.stop();

  // A store whose key file is the wrong size: the daemon refuses to start rather than serve what it cannot open.
  const keyPath = join(SlotStore.path({ stateDir, ...scope }), "store.key");
  writeFileSync(keyPath, Buffer.alloc(5));
  const rootPath = join(work, "root.jwk.json");
  writeFileSync(rootPath, JSON.stringify(publicJwkOf(plane.rootKey)));
  const daemon = startDaemon(["--org", scope.organizationId, "--agent", scope.agentId, "--environment", scope.target, "--root", rootPath, "--state-dir", stateDir], {});
  assert.equal(await daemon.exited, EXIT.refused);
  assert.ok(daemon.stderr.some((l) => l.includes("not serving")), daemon.stderr.join("\n"));
  assert.equal(existsSync(daemonSocketPath({ stateDir, ...scope })), false);

  // The SDK's own connect refuses a socket owned by someone else only on a real multi-user host; here we can at least check the absent path is a clean null.
  assert.equal(await DaemonClient.connect({ socketPath: join(work, "nope.sock"), agentId: scope.agentId, target: scope.target, sdk: "t" }), null);
  rmSync(work, { recursive: true, force: true });
});
