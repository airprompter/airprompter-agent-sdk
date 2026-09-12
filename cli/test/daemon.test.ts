/**
 * airprompterd: the daemon as its own process against a fake control
 * plane on a real HTTP listener, two SDK runtimes attached over the
 * socket, one poll moving both; healthz over HTTP on the socket; a
 * SIGKILL'd daemon leaves the store consistent and the SDKs reconnect;
 * a stale socket is reclaimed, a second daemon is refused; and an SDK in
 * daemon mode with no daemon runs in-process.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AirPrompterAgent } from "../../sdk-typescript/src/agent.js";
import { publicJwkOf } from "../../sdk-typescript/src/protocol/trust.js";
import { SlotStore } from "../../sdk-typescript/src/store/slotStore.js";
import { DaemonClient, daemonSocketPath } from "../../sdk-typescript/src/sync/daemon.js";
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
  const rootPath = join(work, "root.jwk.json");
  writeFileSync(rootPath, JSON.stringify(publicJwkOf(plane.rootKey)));
  const stateDir = join(work, "state");
  const socketPath = daemonSocketPath({ stateDir, ...scope });
  const args = ["--org", scope.organizationId, "--agent", scope.agentId, "--environment", scope.target, "--root", rootPath, "--state-dir", stateDir, "--base-url", http.baseUrl, "--edge-pointer-url", `${http.baseUrl}/g/token/generation.json`, "--root-url", `${http.baseUrl}/roots/prod/root.json`, "--poll-seconds", "1"];
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
  assert.equal(sdkA.prompt("support.reply").render({ name: "x" }).text, "one x");
  assert.equal(sdkB.generation, 1);
  assert.notEqual(sdkA.instanceId, sdkB.instanceId, "each writer has its own instance id");
  assert.notEqual(sdkA.instanceId, JSON.parse(readFileSync(join(SlotStore.path({ stateDir, ...scope }), "store.json"), "utf8")).instanceId);

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
  const healthBody = JSON.parse(health.slice(health.indexOf("\r\n\r\n") + 4)) as { ok: boolean; generation: number };
  assert.deepEqual({ ok: healthBody.ok, generation: healthBody.generation }, { ok: true, generation: 2 });

  // Status through the CLI asks the daemon.
  const lines: string[] = [];
  const code = await run(["status", "--agent", scope.agentId, "--environment", scope.target, "--state-dir", stateDir, "--json"], { stdout: (l) => lines.push(l), stderr: () => {}, env: {}, cwd: work, now: () => Date.now(), fetch: null, isTTY: false });
  assert.equal(code, EXIT.ok);
  const status = JSON.parse(lines[lines.length - 1]!) as { generation: number; daemon: { clients: number; generation: number; lastSyncOutcome: string; rssBytes: number } };
  assert.equal(status.generation, 2);
  assert.equal(status.daemon.generation, 2);
  assert.ok(status.daemon.clients >= 2, `clients: ${status.daemon.clients}`);
  assert.ok(status.daemon.rssBytes > 0);
  process.stdout.write(`[footprint] daemon rss ${(status.daemon.rssBytes / 1048576).toFixed(0)} MiB (node + tsx, not the executable)\n`);

  // Rollback through one runtime is host-wide.
  assert.deepEqual(await sdkA.rollback(), { generation: 1, forced: true });
  await until(() => sdkB.generation === 1, "runtime B follows the rollback");

  // SIGKILL the daemon: the store is consistent, both runtimes keep serving, and reattach when it is back.
  daemon.child.kill("SIGKILL");
  await daemon.exited;
  await until(() => sdkA.status().daemon?.attached === false, "runtime A noticed");
  assert.equal(sdkA.prompt("support.reply").render({ name: "z" }).text, "one z", "keeps serving what it holds");
  const store = await SlotStore.open({ stateDir, ...scope, keyProvider: (await import("../../sdk-typescript/src/store/keyProvider.js")).fileKey(join(SlotStore.path({ stateDir, ...scope }), "store.key")) });
  assert.equal(store.state.generation, 1);
  assert.equal(store.load(store.state.active!, { now: new Date().toISOString(), root: store.state.root, expectGeneration: 1 }).generation, 1);
  assert.ok(existsSync(socketPath), "the dead daemon left its socket file behind");

  daemon = startDaemon(args, env);
  await until(() => events(daemon).some((e) => e.event === "serving"), "restarted daemon serving");
  assert.ok(events(daemon).some((e) => e.event === "stale_socket_removed"), "the stale socket was reclaimed");
  await until(() => sdkA.status().daemon?.attached === true && sdkB.status().daemon?.attached === true, "both runtimes reattached");
  assert.equal(sdkA.generation, 1);

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
