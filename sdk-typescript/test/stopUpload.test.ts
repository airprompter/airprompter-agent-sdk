/**
 * AIR-2261: `stop()` sends the runs it ends, within a bound, and a start on an unknown signing key says what to check.
 *
 * A short-lived process (a script, a Zapier or n8n step) that serves a run and calls `stop()` has uploaded that run
 * before `stop()` returns; a pass already in flight at `stop()` does not hide the last segment; a bucket that never
 * answers costs at most `telemetry.stopUploadTimeoutMs`, the request is aborted so the process can exit, and the row
 * stays in the spool for the next start; `0` makes no pass.
 *
 * Usage: `node --import tsx --test test/stopUpload.test.ts`
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AirPrompterAgent } from "../packages/sdk/src/agent.js";
import type { FetchLike } from "../packages/sdk/src/core/index.js";
import { publicJwkOf } from "../packages/sdk/src/core/protocol/trust.js";
import { FakeControlPlane } from "../packages/sdk/src/core/testing/index.js";
import { SlotStore } from "../packages/sdk/src/sync/store/slotStore.js";
import { timedFetch } from "../packages/sdk/src/frameworks/steps/index.js";

const scope = { organizationId: "org_1", agentId: "agt_stop", target: "prod" as const };
const T0 = Date.parse("2026-11-16T12:00:00Z");
const BUCKET = "https://bucket.test";

type Telemetry = { upload?: boolean; sink?: "memory" | "directory"; stopUploadTimeoutMs?: number };

function plane(): FakeControlPlane {
  const p = new FakeControlPlane(scope);
  p.grantBaseUrl = BUCKET;
  p.promote([p.slot({ tag: "support.reply", text: "Reply." })]);
  return p;
}

function start(p: FakeControlPlane, stateDir: string, options: { telemetry?: Telemetry; mode?: "resident" | "on_invoke"; fetch?: FetchLike; events?: Record<string, unknown>[]; clock?: { ms: number } } = {}) {
  return AirPrompterAgent.start({
    ...scope,
    apiKey: p.apiKey,
    baseUrl: "https://api.test",
    stateDir,
    root: { pinned: publicJwkOf(p.rootKey) },
    sync: { mode: options.mode ?? "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" },
    fetch: options.fetch ?? p.fetch(),
    random: () => 0.5,
    now: () => options.clock?.ms ?? T0,
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
    ...(options.events ? { logger: (e: Record<string, unknown>) => void options.events!.push(e) } : {}),
  });
}

/** The plane's fetch, with the bucket's POSTs routed through `bucket` (to delay, hang or count them). */
function withBucket(p: FakeControlPlane, bucket: (url: string, init: Parameters<FetchLike>[1], real: FetchLike) => ReturnType<FetchLike>): FetchLike {
  const real = p.fetch();
  return (url, init) => (url.startsWith(BUCKET) ? bucket(url, init, real) : real(url, init));
}

const unsent = (stateDir: string) => readdirSync(join(SlotStore.path({ stateDir, ...scope }), "spool", "telemetry")).filter((n) => n.startsWith("seg-") && n.endsWith(".ndjson"));

function serveOne(ap: AirPrompterAgent, latencyMs = 12): void {
  const r = ap.prompt("support.reply").render({});
  ap.report({ tag: r.tag, artifactId: "art_1", versionId: r.versionId, arm: r.arm, model: r.model, status: "ok", latencyMs });
}

const rowsOf = (p: FakeControlPlane, key: string) => p.objects.get(key)!.toString("utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; latencyMs?: { sum?: number } });

test("a process that serves one run and calls stop() has uploaded it before stop() returns", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-stop-"));
  const p = plane();
  const ap = await start(p, stateDir);
  serveOne(ap);
  assert.equal(p.uploads.length, 0, "nothing sent yet: the window is still open");
  await ap.stop();
  assert.equal(p.uploads.length, 1, "stop() ended the run, closed the window and sent it");
  assert.deepEqual(rowsOf(p, p.uploads[0]!).map((r) => r.type), ["window"]);
  assert.deepEqual(unsent(stateDir), [], "nothing left for the next start");
  rmSync(stateDir, { recursive: true, force: true });
});

test("a pass in flight at stop() still lets the last segment go", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-stop-"));
  const p = plane();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let posts = 0;
  const clock = { ms: T0 };
  const ap = await start(p, stateDir, {
    clock,
    fetch: withBucket(p, async (url, init, real) => {
      posts += 1;
      if (posts === 1) await gate;
      return real(url, init);
    }),
  });
  serveOne(ap, 11);
  ap.spool.closeWindows(T0);
  const inFlight = ap.uploadNow(); // lists the folder now, then waits at the bucket
  await new Promise((resolve) => setTimeout(resolve, 20));
  clock.ms += 60_000; // the next minute: its own segment name
  serveOne(ap, 22); // a new window the pass in flight cannot see
  const stopping = ap.stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  assert.deepEqual(await inFlight, { uploaded: 1, quarantined: 0, dropped: 0, held: false });
  await stopping;
  assert.equal(p.uploads.length, 2, "the segment closed at stop() went after the pass in flight");
  assert.deepEqual(p.uploads.map((k) => rowsOf(p, k)[0]!.latencyMs?.sum), [11, 22]);
  assert.deepEqual(unsent(stateDir), []);
  rmSync(stateDir, { recursive: true, force: true });
});

test("a bucket that never answers: stop() returns at the bound, aborts the request, and keeps the row for the next start", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-stop-"));
  const p = plane();
  const events: Record<string, unknown>[] = [];
  let aborted = false;
  const ap = await start(p, stateDir, {
    telemetry: { stopUploadTimeoutMs: 150 },
    events,
    fetch: withBucket(p, (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      });
    })),
  });
  serveOne(ap);
  const began = Date.now();
  await ap.stop();
  const took = Date.now() - began;
  assert.ok(took >= 140 && took < 1500, `stop() took ${took} ms`);
  assert.ok(aborted, "the request was aborted, so its socket cannot hold the process");
  assert.equal(p.uploads.length, 0);
  assert.equal(unsent(stateDir).length, 1, "the row stays in the spool");
  assert.ok(events.some((e) => e.event === "stop_upload_bounded" && e.boundMs === 150));

  // The next start sends it.
  const next = await start(p, stateDir);
  await next.stop();
  assert.equal(p.uploads.length, 1, "the next process sent what the last one kept");
  assert.deepEqual(unsent(stateDir), []);
  rmSync(stateDir, { recursive: true, force: true });
});

test("a control plane that never answers the grant's heartbeat: stop() still returns at the bound and that request is aborted too", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-stop-"));
  const p = plane();
  const real = p.fetch();
  let hang = false;
  let abortedHeartbeats = 0;
  const fetch: FetchLike = (url, init) =>
    hang && url.endsWith("/heartbeat")
      ? new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => {
            abortedHeartbeats += 1;
            reject(new Error("aborted"));
          }),
        )
      : real(url, init);
  const ap = await start(p, stateDir, { telemetry: { stopUploadTimeoutMs: 150 }, fetch });
  while (ap.status().heartbeat.lastAt === null) await new Promise((resolve) => setTimeout(resolve, 10));
  hang = true;
  serveOne(ap);
  const began = Date.now();
  await ap.stop();
  const took = Date.now() - began;
  assert.ok(took >= 140 && took < 1500, `stop() took ${took} ms`);
  assert.equal(abortedHeartbeats, 1, "the grant's heartbeat was aborted at the bound, so it cannot hold the exit");
  assert.equal(p.uploads.length, 0);
  assert.equal(unsent(stateDir).length, 1, "the row stays in the spool");
  rmSync(stateDir, { recursive: true, force: true });
});

test("Steps' timedFetch keeps the caller's signal: the agent's stop bound still aborts a request under the per-request timeout", async () => {
  let seen: AbortSignal | undefined;
  const base = ((_url: string, init: { signal?: AbortSignal }) => {
    seen = init.signal;
    return new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  }) as unknown as typeof globalThis.fetch;
  const caller = new AbortController();
  const pending = timedFetch(base, 60_000)("https://api.test/x", { signal: caller.signal });
  caller.abort();
  await assert.rejects(pending, /aborted/);
  assert.ok(seen?.aborted, "the caller's abort reached the request");
});

test("stopUploadTimeoutMs: 0 and upload: false make no pass at stop()", async () => {
  for (const telemetry of [{ stopUploadTimeoutMs: 0 }, { upload: false }] satisfies Telemetry[]) {
    const stateDir = mkdtempSync(join(tmpdir(), "ap-stop-"));
    const p = plane();
    const ap = await start(p, stateDir, { telemetry });
    serveOne(ap);
    await ap.stop();
    assert.equal(p.uploads.length, 0, JSON.stringify(telemetry));
    assert.equal(unsent(stateDir).length, 1, `${JSON.stringify(telemetry)}: the closed segment waits in the spool`);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("memory sink: stop() flushes the buffer under the same bound; a later flush finds nothing, never a half-sent buffer", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-stop-"));
  const p = plane();
  const ap = await start(p, stateDir, { telemetry: { sink: "memory" }, mode: "on_invoke" });
  serveOne(ap);
  await ap.stop();
  assert.equal(p.uploads.length, 1, "the memory sink's run went at stop()");
  assert.deepEqual(await ap.flushTelemetry(), { status: "nothing" });

  // Bounded: a hung bucket returns at the bound, and a flush right after waits for the aborted one to put its rows back.
  const hung = plane();
  let hungPosts = 0;
  const ap2 = await start(hung, stateDir, {
    telemetry: { sink: "memory", stopUploadTimeoutMs: 100 },
    mode: "on_invoke",
    // The first POST hangs until aborted; the next is answered 503, so the flush after stop() reports what it holds.
    fetch: withBucket(hung, (_url, init) =>
      hungPosts++ === 0
        ? new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))
        : Promise.resolve({ status: 503, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0), text: async () => "" }),
    ),
  });
  serveOne(ap2);
  const began = Date.now();
  await ap2.stop();
  assert.ok(Date.now() - began < 1500);
  const after = await ap2.flushTelemetry();
  assert.equal(after.status, "held", `the rows are back in the buffer, not lost: ${JSON.stringify(after)}`);
  rmSync(stateDir, { recursive: true, force: true });
});

test("a start whose root does not name the manifest's signing key logs what to check", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-stop-"));
  const p = plane();
  const strangerRoot = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
  const events: Record<string, unknown>[] = [];
  const ap = await AirPrompterAgent.start({
    ...scope,
    apiKey: p.apiKey,
    baseUrl: "https://api.dev.test",
    stateDir,
    root: { pinned: strangerRoot as never, hostedEnvironment: "prod" },
    sync: { mode: "on_invoke", rootUrl: "https://edge.test/roots/prod/root.json" },
    fetch: p.fetch(),
    now: () => T0,
    logger: (e) => void events.push(e),
  });
  await ap.stop();
  const refused = events.find((e) => e.reason === "unknown_signing_key");
  assert.ok(refused, JSON.stringify(events.map((e) => [e.event, e.reason])));
  const hint = String(refused.hint);
  for (const said of ["root.pinned", "https://api.dev.test", 'hostedEnvironment ("prod")', "sync.rootUrl", "agent key"]) assert.ok(hint.includes(said), `${said} in: ${hint}`);
  rmSync(stateDir, { recursive: true, force: true });
});

test("a real process whose bucket never answers exits soon after stop(), not when the socket times out", async (t) => {
  // A server that takes the connection and never answers: without the abort, the open request keeps Node alive for minutes.
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(() => undefined);
  server.on("connection", (s) => void sockets.add(s));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  const port = (server.address() as { port: number }).port;
  const here = dirname(fileURLToPath(import.meta.url));
  const work = mkdtempSync(join(tmpdir(), "ap-stop-proc-"));
  const script = join(work, "child.mts");
  const src = (rel: string) => JSON.stringify(pathToFileURL(resolve(here, rel)).href);
  writeFileSync(
    script,
    `import { AirPrompterAgent } from ${src("../packages/sdk/src/agent.ts")};
import { publicJwkOf } from ${src("../packages/sdk/src/core/protocol/trust.ts")};
import { FakeControlPlane } from ${src("../packages/sdk/src/core/testing/index.ts")};
const scope = { organizationId: "org_1", agentId: "agt_stop", target: "prod" };
const p = new FakeControlPlane(scope);
const bucket = "http://127.0.0.1:${port}";
p.grantBaseUrl = bucket;
p.promote([p.slot({ tag: "support.reply", text: "Reply." })]);
const planeFetch = p.fetch();
const ap = await AirPrompterAgent.start({ ...scope, apiKey: p.apiKey, baseUrl: "https://api.test", stateDir: ${JSON.stringify(join(work, "state"))},
  root: { pinned: publicJwkOf(p.rootKey) }, sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" },
  fetch: (url, init) => (url.startsWith(bucket) ? globalThis.fetch(url, init) : planeFetch(url, init)),
  telemetry: { stopUploadTimeoutMs: 300 } });
const r = ap.prompt("support.reply").render({});
ap.report({ tag: r.tag, artifactId: "art_1", versionId: r.versionId, arm: r.arm, model: r.model, status: "ok", latencyMs: 5 });
await ap.stop();
process.stdout.write("stopped\\n");
`,
  );
  const began = Date.now();
  const child = spawn(process.execPath, ["--import", "tsx", script], { cwd: resolve(here, ".."), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(killer);
  const took = Date.now() - began;
  rmSync(work, { recursive: true, force: true });
  assert.equal(code, 0, out);
  assert.match(out, /stopped/);
  assert.ok(sockets.size >= 1, "the child really reached the bucket");
  assert.ok(took < 15_000, `the process exited ${took} ms after start; a held socket would keep it for minutes`);
});
