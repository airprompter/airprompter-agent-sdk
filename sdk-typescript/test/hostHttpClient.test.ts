/**
 * The host picks the HTTP client. A host that installs a userland undici as the global dispatcher (n8n does:
 * `setGlobalDispatcher(new Agent())`) runs every `globalThis.fetch` through that undici, which refuses a caller-set
 * `content-length` with "invalid content-length header". The telemetry POST set one, so under such a host every flush
 * held with `network:fetch failed` and no run was ever counted, while plain Node and the mocked tests passed.
 *
 * Here the real upload paths — `postSegment`, the spool uploader's pass, and the agent's `flushTelemetry()` through
 * `invoke()` — run with no injected fetch, under a userland undici (both majors) as the global dispatcher, against a
 * real HTTP listener on 127.0.0.1 that bridges onto the fake control plane and its fake S3. Each case checks that the
 * dispatcher really carried the requests, that the object landed byte-for-byte, and that the wire still carried a
 * content-length fetch derived itself. A host that hands the agent undici's own `fetch` is covered too, as a
 * conformance case: undici's fetch over its own dispatcher accepted the old header, so only the global-dispatcher cases
 * (Node's bundled fetch over a userland dispatcher) fail without the fix.
 * The original global dispatcher is put back after every case and checked at the end.
 *
 * Then a static guard: no SDK source sets a header the HTTP client owns (content-length, host, transfer-encoding,
 * connection, keep-alive, expect, te, trailer, upgrade, proxy-connection), with the detector proven on the line that
 * caused this.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AirPrompterAgent } from "../packages/sdk/src/agent.js";
import type { FetchLike } from "../packages/sdk/src/core/control/client.js";
import { publicJwkOf } from "../packages/sdk/src/core/protocol/trust.js";
import { epochMinute, segmentName } from "../packages/sdk/src/telemetry/spool/writer.js";
import { postSegment, SpoolUploader, type GrantDecision, type UploadGrant } from "../packages/sdk/src/telemetry/uploader.js";
import { FakeControlPlane } from "./helpers/controlPlane.js";

// `.1` is the slot Node's bundled fetch reads its dispatcher from; userland undici 7 and 8 both write it (8 as a
// wrapper) and also `.2`, which undici 8 reads. undici defines both non-configurable, so they can be reassigned but
// never removed: restoring means putting the original values back.
const SLOTS = [Symbol.for("undici.globalDispatcher.1"), Symbol.for("undici.globalDispatcher.2")] as const;
const slots = globalThis as unknown as Record<symbol, unknown>;
// Node installs its own Agent in `.1` on the first fetch; make that happen now, as in any process that has fetched,
// so the original is Node's dispatcher, not the one importing undici would install into an empty slot.
await globalThis.fetch("data:,");
const original = SLOTS.map((slot) => slots[slot]);
assert.ok(original[0], "Node's own dispatcher is in place");
const restoreDispatcher = () => SLOTS.forEach((slot, i) => (slots[slot] = original[i]));
const undici7 = await import("undici");
const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
// undici 8 needs Node >= 22.19 (CI runs 22 latest); on an older Node its cases are reported as skipped.
const undici8Runs = major > 22 || (major === 22 && minor >= 19);
const undici8 = undici8Runs ? await import("undici-v8") : null;
restoreDispatcher();
const versionOf = (pkg: string) => (JSON.parse(readFileSync(new URL(`../node_modules/${pkg}/package.json`, import.meta.url), "utf8")) as { version: string }).version;

type Undici = typeof undici7;
const scope = { organizationId: "org_1", agentId: "agt_1", target: "prod" as const };

/** The fake control plane and its S3 behind a real listener; every request's headers as the server read them off the wire. */
async function bridge(plane: FakeControlPlane): Promise<{ baseUrl: string; seen: Array<{ url: string; headers: IncomingHttpHeaders; bytes: number }>; close: () => Promise<void> }> {
  const planeFetch = plane.fetch();
  const seen: Array<{ url: string; headers: IncomingHttpHeaders; bytes: number }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      seen.push({ url: request.url ?? "/", headers: request.headers, bytes: raw.length });
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers[name] = value;
      const body = raw.length === 0 ? undefined : headers["content-type"]?.startsWith("multipart/") ? raw : raw.toString("utf8");
      const result = (await planeFetch(`http://${request.headers.host}${request.url ?? "/"}`, { method: request.method ?? "GET", headers, ...(body !== undefined ? { body } : {}) })) as Awaited<ReturnType<FetchLike>> & { headerEntries?: Array<[string, string]> };
      response.writeHead(result.status, Object.fromEntries(result.headerEntries ?? []));
      response.end(Buffer.from(await result.arrayBuffer()));
    })().catch((error: Error) => {
      response.writeHead(500);
      response.end(error.message);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  plane.grantBaseUrl = baseUrl;
  return {
    baseUrl,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** A userland undici Agent installed as the global dispatcher, counting what it carries; undone by the test's own teardown. */
function installAgent(t: test.TestContext, undici: Undici): { calls: () => number; agent: InstanceType<Undici["Agent"]> } {
  const agent = new undici.Agent();
  let calls = 0;
  const dispatch = agent.dispatch.bind(agent);
  agent.dispatch = ((options, handler) => {
    calls += 1;
    return dispatch(options, handler);
  }) as typeof agent.dispatch;
  undici.setGlobalDispatcher(agent);
  assert.equal(undici.getGlobalDispatcher(), agent);
  t.after(async () => {
    restoreDispatcher();
    await agent.close();
  });
  return { calls: () => calls, agent };
}

function assertFramedByFetch(seen: Array<{ url: string; headers: IncomingHttpHeaders; bytes: number }>): void {
  const uploads = seen.filter((s) => s.url === "/s3/agent-telemetry");
  assert.ok(uploads.length >= 1, "the bucket was reached");
  for (const s of uploads) {
    assert.equal(s.headers["content-length"], String(s.bytes), "fetch still frames the body with its own content-length");
    assert.equal(s.headers["transfer-encoding"], undefined, "a Buffer body is never chunked");
  }
}

const dispatchers: Array<{ name: string; undici: Undici }> = [{ name: `undici ${versionOf("undici")}`, undici: undici7 }];
if (undici8) dispatchers.push({ name: `undici ${versionOf("undici-v8")}`, undici: undici8 as unknown as Undici });
else test(`undici ${versionOf("undici-v8")} as the global dispatcher`, { skip: `needs Node >= 22.19, this is ${process.versions.node}` }, () => undefined);

for (const { name, undici } of dispatchers) {
  test(`${name} as the global dispatcher: postSegment over globalThis.fetch lands the segment`, async (t) => {
    const plane = new FakeControlPlane(scope);
    const http = await bridge(plane);
    t.after(http.close);
    const dispatcher = installAgent(t, undici);
    const heartbeat = await globalThis.fetch(`${http.baseUrl}/v1/agents/agt_1/targets/prod/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${plane.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ protocol: "0.2.5", instanceId: "i-hostdispatch00", sdk: { name: "agent-sdk-typescript", version: "0.0.0" }, syncMode: "resident", generation: { active: 1 }, applyState: "active", storageProtection: "file_key", catalog: { models: [] }, lease: { expired: false }, spool: { depthSegments: 0, depthBytes: 0, droppedSegments: 0, quarantinedSegments: 0 } }) });
    const grant = ((await heartbeat.json()) as { uploadGrant: UploadGrant }).uploadGrant;
    const bytes = Buffer.from('{"type":"window"}\n');
    const outcome = await postSegment({ grant, segment: "seg-i-hostdispatch00-1-0.ndjson", bytes, fetch: globalThis.fetch as unknown as FetchLike });
    assert.deepEqual(outcome, { status: "ok", key: `${grant.keyPrefix}seg-i-hostdispatch00-1-0.ndjson` });
    assert.deepEqual(plane.objects.get(outcome.status === "ok" ? outcome.key : ""), bytes, "S3 holds the segment's bytes");
    assert.ok(dispatcher.calls() >= 2, "the userland dispatcher carried the heartbeat and the POST");
    assertFramedByFetch(http.seen);
  });

  test(`${name} as the global dispatcher: the spool uploader's pass uploads and deletes a closed segment`, async (t) => {
    const plane = new FakeControlPlane(scope);
    const http = await bridge(plane);
    t.after(http.close);
    const dir = mkdtempSync(join(tmpdir(), "ap-host-dispatch-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const dispatcher = installAgent(t, undici);
    const fetch = globalThis.fetch as unknown as FetchLike;
    const writer = "i-writerAAAAAAAA";
    const now = Date.now();
    const minute = new Date(Math.floor(now / 60_000) * 60_000 - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const row = { type: "window", v: 5, artifactId: "art_1", minute, instanceId: writer, instanceClass: "resident", tag: "support.triage", versionId: "ver_1", arm: "none", model: "gpt-5", status: "ok", errorClass: null, usageSource: "reported", toolsReported: false, count: 1, modelCalls: 1, agentRun: 1, tools: { calls: 0, errors: 0 }, tokensSq: { input: 0, cachedInput: 0, output: 0, inputOutput: 0, inputCached: 0, cachedOutput: 0 }, latencyMs: { buckets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], sum: 812 }, tokens: { input: 40, output: 9 }, sdk: "agent-sdk-ts/0.1.0" };
    const segment = segmentName(writer, epochMinute(Date.parse(minute)), 0);
    writeFileSync(join(dir, segment), `${JSON.stringify(row)}\n`, { mode: 0o600 });
    const grantFor = async (instanceId: string): Promise<GrantDecision> => {
      const response = await fetch(`${http.baseUrl}/v1/agents/agt_1/targets/prod/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${plane.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ protocol: "0.2.5", instanceId, sdk: { name: "airprompterd", version: "0.1.0" }, syncMode: "resident", generation: { active: 1 }, applyState: "active", storageProtection: "file_key", catalog: { models: [] }, lease: { expired: false }, spool: { depthSegments: 0, depthBytes: 0, droppedSegments: 0, quarantinedSegments: 0 } }) });
      const answer = JSON.parse(await response.text()) as { uploadGrant: UploadGrant; uploadIntervalSeconds: number };
      return { kind: "grant", grant: answer.uploadGrant, uploadIntervalSeconds: answer.uploadIntervalSeconds };
    };
    const uploader = new SpoolUploader({ dir, instanceId: "i-daemon00000000", grantFor, fetch });
    const result = await uploader.runOnce();
    assert.deepEqual(result.uploaded, [segment], JSON.stringify(uploader.status()));
    assert.deepEqual(plane.uploads, [`org/org_1/agent/agt_1/prod/${writer}/${segment}`]);
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith("seg-")), [], "acknowledged, so deleted");
    assert.ok(dispatcher.calls() >= 2);
    assertFramedByFetch(http.seen);
  });

  test(`${name} as the global dispatcher: invoke() flushes the run under the runtime's own grant (no fetch option)`, async (t) => {
    const plane = new FakeControlPlane(scope);
    plane.promote([plane.slot({ tag: "support.reply", text: "Reply." })]);
    const http = await bridge(plane);
    t.after(http.close);
    const stateDir = mkdtempSync(join(tmpdir(), "ap-host-dispatch-flush-"));
    t.after(() => rmSync(stateDir, { recursive: true, force: true }));
    const dispatcher = installAgent(t, undici);
    const events: Array<Record<string, unknown>> = [];
    const ap = await AirPrompterAgent.start({ ...scope, apiKey: plane.apiKey, baseUrl: http.baseUrl, stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "on_invoke", rootUrl: `${http.baseUrl}/roots/prod/root.json` }, logger: (event: Record<string, unknown>) => void events.push(event) });
    t.after(() => ap.stop());
    const r = ap.prompt("support.reply").render({});
    await ap.invoke(async () => ap.report({ tag: r.tag, artifactId: "art_1", versionId: r.versionId, arm: r.arm, model: r.model, status: "ok", latencyMs: 12 }));
    assert.deepEqual(events.filter((e) => e.event === "telemetry_flush_failed"), [], "the flush did not hold");
    assert.equal(plane.uploads.length, 1, "the run is counted: one segment for the invocation");
    const rows = plane.objects.get(plane.uploads[0]!)!.toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; count: number });
    assert.deepEqual(rows.map((x) => [x.type, x.count]), [["window", 1]]);
    assert.ok(dispatcher.calls() >= 3, "the sync, the heartbeat and the POST all went through the host's dispatcher");
    assertFramedByFetch(http.seen);
  });

  test(`${name}: a host that hands the agent undici's own fetch gets the same upload`, async (t) => {
    const plane = new FakeControlPlane(scope);
    plane.promote([plane.slot({ tag: "support.reply", text: "Reply." })]);
    const http = await bridge(plane);
    t.after(http.close);
    const stateDir = mkdtempSync(join(tmpdir(), "ap-host-fetch-"));
    t.after(() => rmSync(stateDir, { recursive: true, force: true }));
    const dispatcher = installAgent(t, undici);
    const ap = await AirPrompterAgent.start({ ...scope, apiKey: plane.apiKey, baseUrl: http.baseUrl, stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "on_invoke", rootUrl: `${http.baseUrl}/roots/prod/root.json` }, fetch: undici.fetch as unknown as FetchLike });
    t.after(() => ap.stop());
    const r = ap.prompt("support.reply").render({});
    await ap.invoke(async () => ap.report({ tag: r.tag, artifactId: "art_1", versionId: r.versionId, arm: r.arm, model: r.model, status: "ok", latencyMs: 7 }));
    assert.equal(plane.uploads.length, 1);
    assert.ok(dispatcher.calls() >= 3);
    assertFramedByFetch(http.seen);
  });
}

test("every case put the original global dispatcher back, and Node's fetch works on it", async () => {
  SLOTS.forEach((slot, i) => assert.equal(slots[slot], original[i]));
  // A later undici that adds a slot (`.3`) would leak past this restore: fail loudly so SLOTS gets it.
  const present = Object.getOwnPropertySymbols(globalThis).filter((s) => s.description?.startsWith("undici.globalDispatcher."));
  assert.deepEqual(present.filter((s) => !(SLOTS as readonly symbol[]).includes(s)), [], "every dispatcher slot is one this test restores");
  const plane = new FakeControlPlane(scope);
  const http = await bridge(plane);
  try {
    assert.equal((await globalThis.fetch(`${http.baseUrl}/roots/prod/root.json`)).status, 200);
  } finally {
    await http.close();
  }
});

// ---------------------------------------------------------------------------
// Static guard: no SDK source sets a header the HTTP client owns
// ---------------------------------------------------------------------------

const CLIENT_OWNED = ["content-length", "host", "transfer-encoding", "connection", "keep-alive", "expect", "te", "trailer", "upgrade", "proxy-connection"];
const NAME = `["'\`]?(${CLIENT_OWNED.map((n) => n.replace("-", "\\-")).join("|")})["'\`]?`;
const HYPHENATED = CLIENT_OWNED.filter((n) => n.includes("-")).map((n) => n.replace("-", "\\-")).join("|");

/** Every client-owned header a source sets: a key in a headers literal, or a `.set` / `.append` / `setHeader` / index write by name. */
function clientOwnedHeadersSet(source: string): string[] {
  const found: string[] = [];
  // A headers literal: `headers: {`, `headers = {`, `new Headers({`, `fooHeaders({` — its keys, brace-matched.
  for (const opener of source.matchAll(/headers\w*\s*(?:[:=]\s*|\(\s*)\{/gi)) {
    const start = opener.index! + opener[0].length - 1;
    let depth = 0;
    let end = start;
    for (; end < source.length; end++) {
      if (source[end] === "{") depth++;
      else if (source[end] === "}" && --depth === 0) break;
    }
    for (const key of source.slice(start, end + 1).matchAll(new RegExp(`(?:^|[{,\\s])${NAME}\\s*:`, "gim"))) found.push(key[1]!.toLowerCase());
  }
  for (const call of source.matchAll(new RegExp(`(?:headers\\w*\\.(?:set|append)|setHeader)\\(\\s*${NAME}\\s*,`, "gi"))) found.push(call[1]!.toLowerCase());
  for (const write of source.matchAll(new RegExp(`headers\\w*\\[\\s*${NAME}\\s*\\]\\s*=(?!=)`, "gi"))) found.push(write[1]!.toLowerCase());
  // The hyphenated names mean nothing but a header, so anywhere as a quoted key or a `[name, value]` pair: a headers
  // object held in another variable, a spread constant, `new Headers([[…]])`.
  for (const any of source.matchAll(new RegExp(`(?:["'\`](${HYPHENATED})["'\`]\\s*:|\\[\\s*["'\`](${HYPHENATED})["'\`]\\s*,)`, "gi"))) found.push((any[1] ?? any[2])!.toLowerCase());
  return [...new Set(found)];
}

test("the detector finds the line that broke n8n, and the other ways to set a client-owned header", () => {
  const fixed = readFileSync(new URL("../packages/sdk/src/telemetry/uploader.ts", import.meta.url), "utf8");
  assert.deepEqual(clientOwnedHeadersSet('await input.fetch(grant.url, { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(body.length) }, body });'), ["content-length"]);
  assert.deepEqual(clientOwnedHeadersSet('new Headers({ Host: "api.test", Connection: "close" })'), ["host", "connection"]);
  assert.deepEqual(clientOwnedHeadersSet('headers.set("Transfer-Encoding", "chunked"); request.setHeader("Expect", "100-continue"); headers["keep-alive"] = "1";'), ["transfer-encoding", "expect", "keep-alive"]);
  assert.deepEqual(clientOwnedHeadersSet('const framing = { "Content-Length": n }; fetch(u, { headers: { ...framing } }); new Headers([["transfer-encoding", "chunked"]]);'), ["content-length", "transfer-encoding"]);
  assert.deepEqual(clientOwnedHeadersSet('const body = { host: { os: "linux" }, connection: 1 }; map.set("host", 1); ["content-length-range", 0, 1048576];'), [], "a heartbeat's host field and an S3 policy condition are not headers");
  assert.deepEqual(clientOwnedHeadersSet(fixed), [], "the uploader sets none");
});

test("no source in any TypeScript package, or the CLI, sets a header the HTTP client owns", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const offenders: string[] = [];
  let scanned = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== "node_modules" && entry !== "dist") walk(path);
      } else if (/\.(ts|mts|cts|js|mjs)$/.test(entry) && !entry.endsWith(".d.ts")) {
        scanned++;
        for (const name of clientOwnedHeadersSet(readFileSync(path, "utf8"))) offenders.push(`${path.slice(root.length)}: ${name}`);
      }
    }
  };
  const packages = join(root, "sdk-typescript", "packages");
  for (const pkg of readdirSync(packages)) walk(join(packages, pkg, "src"));
  walk(join(root, "cli", "src"));
  assert.ok(scanned > 50, `scanned ${scanned} files`);
  assert.deepEqual(offenders, [], "fetch / the HTTP client frames the request; a host's own dispatcher may refuse a caller-set framing header");
});
