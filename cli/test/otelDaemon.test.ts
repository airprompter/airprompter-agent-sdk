/**
 * S13 in `airprompterd`: `--upload-sink otlp --otlp-endpoint …` ships every writer's windows to a collector on the
 * host, with no Agent key at all (the daemon runs offline from a vendored bundle); a collector that answers 500 costs
 * the segment (dropped and counted), never the spool; headers reach the collector and a `$VAR` value comes from the
 * environment, never argv; the daemon's log names the sink and carries no prompt text.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent } from "../../sdk-typescript/packages/sdk/src/agent.js";
import { createPlaintextBundle } from "../../sdk-typescript/packages/core/src/bundle/apbundle.js";
import { publicJwkOf } from "../../sdk-typescript/packages/core/src/protocol/trust.js";
import { SlotStore } from "../../sdk-typescript/packages/sync/src/store/slotStore.js";
import { daemonSocketPath } from "../../sdk-typescript/packages/sync/src/sync/daemon.js";
import { FakeControlPlane } from "../../sdk-typescript/test/helpers/controlPlane.js";

const cliRoot = join(import.meta.dirname, "..");
const scope = { organizationId: "org_1", agentId: "agt_otel", target: "prod" as const };
const skip = process.platform === "win32" ? "unix sockets differ on Windows; the ubuntu lane covers this" : false;

const until = async (check: () => boolean, label: string | (() => string), timeoutMs = 20_000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${typeof label === "function" ? label() : label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/** A collector on the host: records every OTLP request; the first `failFirst` answer 500. */
async function collector(failFirst = 0) {
  const requests: Array<{ headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }> = [];
  let remainingFailures = failFirst;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (c) => chunks.push(Buffer.from(c)));
    request.on("end", () => {
      requests.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        response.writeHead(500).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { requests, endpoint: `http://127.0.0.1:${port}/v1/metrics`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function startDaemon(args: string[], env: Record<string, string>): { child: ChildProcess; stderr: string[]; exited: Promise<number | null> } {
  const child = spawn(process.execPath, ["--import", "tsx", join(cliRoot, "src", "main.ts"), "daemon", ...args, "--json"], { cwd: cliRoot, env: { ...process.env, AIRPROMPTER_AGENT_KEY: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const stderr: string[] = [];
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => stderr.push(...chunk.split("\n").filter(Boolean)));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, stderr, exited };
}

test("airprompterd --upload-sink otlp: an offline host's windows reach the collector with no Agent key; a 500 drops and counts; headers and $VAR values arrive; no prompt text leaves", { skip }, async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-otel-daemon-"));
  const plane = new FakeControlPlane(scope);
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply warmly {{name}}", variables: [{ name: "name", required: false, trust: "operator" }] })]);
  const bundle = createPlaintextBundle({ createdAt: new Date().toISOString(), notAfter: "2027-01-01T00:00:00Z", manifest: plane.manifest!, keySet: plane.root, payloads: [...plane.payloads].map(([contentHash, bytes]) => ({ contentHash: contentHash as `sha256:${string}`, byteLength: bytes.length, bytes: bytes.toString("base64url") })) });
  const stateDir = join(work, "state");
  // Seed the daemon's store from the bundle (an offline host: nothing to pull from, no key).
  const seed = await AirPrompterAgent.start({ ...scope, stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, vendoredBundle: { bundle }, telemetry: { sink: "memory" } });
  await seed.stop();
  const rootPath = join(work, "root.jwk.json");
  writeFileSync(rootPath, JSON.stringify(publicJwkOf(plane.rootKey)));
  const otlp = await collector(1);
  const socketPath = daemonSocketPath({ stateDir, ...scope });
  const daemon = startDaemon(["--org", scope.organizationId, "--agent", scope.agentId, "--environment", scope.target, "--root", rootPath, "--state-dir", stateDir, "--poll-seconds", "3600", "--upload-interval-seconds", "1", "--upload-sink", "otlp", "--otlp-endpoint", otlp.endpoint, "--otlp-header", "authorization=$OTEL_TOKEN", "--otlp-header", "x-tenant=acme", "--otlp-resource", "service.name=support-bot"], { OTEL_TOKEN: "Bearer secret-from-env" });
  try {
    await until(() => existsSync(socketPath), () => `the socket (daemon said: ${daemon.stderr.join(" | ")})`);
    const events = () => daemon.stderr.map((line) => JSON.parse(line) as Record<string, unknown>);
    await until(() => events().some((e) => e.event === "serving"), "serving");
    const serving = events().find((e) => e.event === "serving")!;
    assert.match(String(serving.upload), /^otlp: every 1s$/, JSON.stringify(serving));
    assert.ok(events().some((e) => e.event === "offline"), "no key: the daemon says it never calls home");

    // Two writers attach and report; the daemon ships their closed windows to the collector.
    const sdkA = await AirPrompterAgent.start({ ...scope, stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "daemon", pollSeconds: 1 } });
    const sdkB = await AirPrompterAgent.start({ ...scope, stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "daemon", pollSeconds: 1 } });
    try {
      const r = sdkA.prompt("support.reply").render({ name: "Ada" });
      sdkA.report({ tag: r.tag, versionId: r.versionId, arm: r.arm, model: r.model, status: "ok", latencyMs: 12, tokens: { input: 3, output: 4 } });
      sdkA.spool.closeWindows(Date.now());
      sdkB.report({ tag: r.tag, versionId: r.versionId, arm: r.arm, model: r.model, status: "error", errorClass: "provider_timeout", latencyMs: 30_000 });
      sdkB.spool.closeWindows(Date.now());
      // The first export meets a 500: dropped and counted; the second writer's segment still ships.
      await until(() => otlp.requests.length >= 2, () => `two exports (got ${otlp.requests.length}; daemon: ${daemon.stderr.slice(-4).join(" | ")})`, 30_000);
      await until(() => events().some((e) => e.event === "segment_dropped_by_sink"), "the drop reported");
      const dropped = events().find((e) => e.event === "segment_dropped_by_sink")!;
      assert.equal(dropped.sink, "otlp");
      assert.equal(dropped.reason, "http_500");
      const spoolDir = join(SlotStore.path({ stateDir, ...scope }), "spool", "telemetry");
      await until(() => readdirSync(spoolDir).filter((n) => n.startsWith("seg-") && n.endsWith(".ndjson")).length === 0, "no closed segment left: one shipped, one dropped");
      for (const request of otlp.requests) {
        assert.equal(request.headers.authorization, "Bearer secret-from-env", "the header's $VAR value came from the environment");
        assert.equal(request.headers["x-tenant"], "acme");
        const text = JSON.stringify(request.body);
        assert.doesNotMatch(text, /Reply warmly/, "no prompt text");
        assert.match(text, /"service\.name"/);
        assert.match(text, /gen_ai\.client\.operation\.duration/);
      }
      assert.doesNotMatch(daemon.stderr.join("\n"), /Reply warmly/, "daemon logs carry no prompt text");
    } finally {
      await sdkA.stop();
      await sdkB.stop();
    }
  } finally {
    daemon.child.kill("SIGTERM");
    await daemon.exited;
    await otlp.close();
    rmSync(work, { recursive: true, force: true });
  }
});

test("airprompterd --otlp-header name=$VAR: an unset variable is a usage error, never an empty header; --upload-sink otlp without an endpoint is too", async () => {
  const { run } = await import("../src/cli.js");
  const { EXIT } = await import("../src/io.js");
  const work = mkdtempSync(join(tmpdir(), "ap-otel-usage-"));
  try {
    const rootPath = join(work, "root.jwk.json");
    writeFileSync(rootPath, JSON.stringify(publicJwkOf(new FakeControlPlane(scope).rootKey)));
    const errors: string[] = [];
    const ctx = { stdout: () => {}, stderr: (l: string) => errors.push(l), env: {}, cwd: work, now: () => Date.now(), fetch: null, isTTY: false };
    const base = ["daemon", "--org", scope.organizationId, "--agent", scope.agentId, "--environment", scope.target, "--root", rootPath, "--state-dir", join(work, "state")];
    assert.equal(await run([...base, "--upload-sink", "otlp", "--otlp-endpoint", "http://127.0.0.1:9/v1/metrics", "--otlp-header", "authorization=$OTEL_TOKEN"], ctx), EXIT.usage);
    assert.match(errors.join("\n"), /OTEL_TOKEN is not set/);
    assert.equal(await run([...base, "--upload-sink", "otlp"], ctx), EXIT.usage);
    assert.match(errors.join("\n"), /--otlp-endpoint/);
    assert.equal(await run([...base, "--upload-sink", "kafka"], ctx), EXIT.usage);
    assert.equal(existsSync(join(work, "state")), false, "refused before anything was opened");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
