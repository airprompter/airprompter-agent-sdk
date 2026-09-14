#!/usr/bin/env node
// The live conformance target (S12): a registry that answers the protocol's
// routes — `airprompter dev`, Hangar, or the hosted service — exercised over
// HTTP with the same schemas and the same trust chain the offline runner
// applies to the examples and vectors. Every check names a route and a
// rule; the manifest is verified against a root the caller pins (never one
// the server hands over), every referenced payload is fetched and hashed,
// the heartbeat's answer is schema-valid, and the refusals are the ones the
// OpenAPI promises.
//
//   node live.mjs --base-url http://127.0.0.1:4180 --agent agt_dev --environment dev \
//     --api-key apa_dev_local --root ./prompts/.airprompter-dev/root.pub.json \
//     [--org org_dev] [--edge-pointer-url …] [--root-url …] [--json]
//
// Exit 0 when every check passes, 1 otherwise. Nothing printed is prompt
// text: routes, statuses, hashes, ids, counts.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { sha256Prefixed } from "./reference.mjs";
import { trustedRootFromPinnedKey, verifyManifest, verifyRootMetadata } from "./trust.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const protocolDir = join(here, "..", "protocol");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const json = args.includes("--json");
const baseUrl = String(opt("base-url", "")).replace(/\/+$/, "");
const agentId = opt("agent", "agt_dev");
const target = opt("environment", "dev");
const organizationId = opt("org", "org_dev");
const apiKey = opt("api-key", process.env.AIRPROMPTER_AGENT_KEY ?? "");
const rootPath = opt("root", "");
if (!baseUrl || !rootPath || !apiKey) {
  console.error("usage: node live.mjs --base-url <url> --root <root.pub.json|root.json> --api-key <key> [--agent … --environment … --org …]");
  process.exit(2);
}
const edgePointerUrl = opt("edge-pointer-url", `${baseUrl}/edge/${agentId}/${target}/generation.json`);
const rootUrl = opt("root-url", `${baseUrl}/roots/${target}/root.json`);

const results = [];
let failures = 0;
const ok = (route, rule) => {
  results.push({ route, rule, ok: true });
  if (!json) console.log(`  ok   ${route}  ${rule}`);
};
const fail = (route, rule, detail) => {
  failures += 1;
  results.push({ route, rule, ok: false, detail });
  if (!json) console.log(`  FAIL ${route}  ${rule}${detail ? `\n       ${detail}` : ""}`);
};
const section = (title) => {
  if (!json) console.log(`\n${title}`);
};

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true, allowUnionTypes: true });
addFormats(ajv);
const schemaDir = join(protocolDir, "schemas");
for (const file of readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json")).sort()) ajv.addSchema(readJson(join(schemaDir, file)));
const validate = (name, value) => {
  const fn = ajv.getSchema(`https://airprompter.com/protocol/0.2/${name}`);
  if (!fn) throw new Error(`no schema ${name}`);
  return fn(value) ? null : ajv.errorsText(fn.errors, { separator: "; " });
};

const now = new Date().toISOString();
const pinned = readJson(rootPath);
const root = pinned.kty === "EC" ? trustedRootFromPinnedKey({ purpose: "platform", environment: target, pinnedRootJwk: pinned }) : pinned;
const authed = { authorization: `Bearer ${apiKey}` };
const get = (url, headers = {}) => fetch(url, { headers });

// ---------------------------------------------------------------------------
section("the root");
let trustedRoot = root;
try {
  const response = await get(rootUrl);
  if (response.status !== 200) fail("GET root.json", "answers 200", `HTTP ${response.status}`);
  else {
    const candidate = await response.json();
    const problem = validate("key-set.schema.json", candidate);
    if (problem) fail("GET root.json", "is a key set (key-set.schema.json)", problem);
    else ok("GET root.json", "is a key set (key-set.schema.json)");
    const verdict = verifyRootMetadata({ candidate, trusted: root, now });
    if (verdict.ok) {
      ok("GET root.json", "descends from the pinned root (R1–R5)");
      trustedRoot = candidate;
    } else fail("GET root.json", "descends from the pinned root (R1–R5)", verdict.reason);
  }
} catch (error) {
  fail("GET root.json", "reachable", error.message);
}

// ---------------------------------------------------------------------------
section("the edge pointer");
let pointer = null;
let pointerEtag = null;
try {
  const response = await get(edgePointerUrl);
  if (response.status !== 200) fail("GET generation.json", "answers 200", `HTTP ${response.status}`);
  else {
    pointer = await response.json();
    pointerEtag = response.headers.get("etag");
    const problem = validate("edge-pointer.schema.json", pointer);
    if (problem) fail("GET generation.json", "is an edge pointer (edge-pointer.schema.json)", problem);
    else ok("GET generation.json", "is an edge pointer (edge-pointer.schema.json)");
    if (pointerEtag) {
      const again = await get(edgePointerUrl, { "if-none-match": pointerEtag });
      if (again.status === 304) ok("GET generation.json", "answers 304 to If-None-Match with its own ETag");
      else fail("GET generation.json", "answers 304 to If-None-Match with its own ETag", `HTTP ${again.status}`);
    } else fail("GET generation.json", "carries an ETag", "none");
    const unauth = await fetch(edgePointerUrl, { headers: {} });
    if (unauth.status === 200) ok("GET generation.json", "is public (no key: the pointer extends no trust)");
    else fail("GET generation.json", "is public (no key: the pointer extends no trust)", `HTTP ${unauth.status}`);
  }
} catch (error) {
  fail("GET generation.json", "reachable", error.message);
}

// ---------------------------------------------------------------------------
section("the manifest");
const manifestUrl = `${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/targets/${target}/manifest`;
let manifest = null;
let manifestEtag = null;
try {
  const noKey = await get(manifestUrl);
  if (noKey.status === 401) ok("GET manifest", "refuses without a key (401)");
  else fail("GET manifest", "refuses without a key (401)", `HTTP ${noKey.status}`);
  const other = await get(`${baseUrl}/v1/agents/${encodeURIComponent(`${agentId}-other`)}/targets/${target}/manifest`, authed);
  if (other.status === 403 || other.status === 404) ok("GET manifest", "refuses another agent's manifest under this key (403/404)");
  else fail("GET manifest", "refuses another agent's manifest under this key (403/404)", `HTTP ${other.status}`);
  const response = await get(manifestUrl, authed);
  if (response.status !== 200) fail("GET manifest", "answers 200 under the key", `HTTP ${response.status}`);
  else {
    manifestEtag = response.headers.get("etag");
    const bytes = Buffer.from(await response.arrayBuffer());
    manifest = JSON.parse(bytes.toString("utf8"));
    const problem = validate("manifest.schema.json", manifest);
    if (problem) fail("GET manifest", "is a manifest (manifest.schema.json)", problem);
    else ok("GET manifest", "is a manifest (manifest.schema.json)");
    const header = response.headers.get("x-agent-generation");
    if (header && Number(header) === manifest.payload.generation) ok("GET manifest", "x-agent-generation names the payload's generation");
    else fail("GET manifest", "x-agent-generation names the payload's generation", `header ${header}, payload ${manifest.payload.generation}`);
    if (manifestEtag) {
      const again = await get(manifestUrl, { ...authed, "if-none-match": manifestEtag });
      if (again.status === 304) ok("GET manifest", "answers 304 to If-None-Match with its own ETag");
      else fail("GET manifest", "answers 304 to If-None-Match with its own ETag", `HTTP ${again.status}`);
    } else fail("GET manifest", "carries an ETag", "none");
    if (pointer) {
      if (pointer.generation === manifest.payload.generation && pointer.releaseDigest === manifest.payload.releaseDigest) ok("GET generation.json", "names the manifest's generation and release digest");
      else fail("GET generation.json", "names the manifest's generation and release digest", `pointer ${pointer.generation}/${pointer.releaseDigest}, manifest ${manifest.payload.generation}/${manifest.payload.releaseDigest}`);
    }
    const scope = { organizationId: manifest.payload.organizationId ?? organizationId, agentId, target };
    const envelope = verifyManifest({ manifest, root: trustedRoot, now, scope, storedGeneration: 0 });
    if (envelope.ok) ok("GET manifest", "verifies against the pinned root (M1–M8, M11–M14)");
    else fail("GET manifest", "verifies against the pinned root (M1–M8, M11–M14)", envelope.reason);
  }
} catch (error) {
  fail("GET manifest", "reachable", error.message);
}

// ---------------------------------------------------------------------------
section("the payloads");
if (manifest) {
  const payloads = new Map();
  const referenced = new Set();
  for (const slot of manifest.payload.slots) {
    referenced.add(slot.contentHash);
    for (const step of slot.steps ?? []) referenced.add(step.contentHash);
    if (slot.goldenSet) referenced.add(slot.goldenSet.contentHash);
  }
  for (const arm of manifest.payload.experiment?.arms ?? []) for (const override of arm.overrides) referenced.add(override.contentHash);
  for (const contentHash of referenced) {
    const url = `${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/payloads/${contentHash}`;
    try {
      const response = await get(url, authed);
      if (response.status !== 200) {
        fail(`GET payloads/${contentHash.slice(0, 19)}…`, "answers 200 under the key", `HTTP ${response.status}`);
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (sha256Prefixed(bytes) === contentHash) ok(`GET payloads/${contentHash.slice(0, 19)}…`, "hashes to its contentHash");
      else fail(`GET payloads/${contentHash.slice(0, 19)}…`, "hashes to its contentHash", sha256Prefixed(bytes));
      payloads.set(contentHash, bytes);
    } catch (error) {
      fail(`GET payloads/${contentHash.slice(0, 19)}…`, "reachable", error.message);
    }
  }
  const noKey = await get(`${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/payloads/${[...referenced][0]}`);
  if (noKey.status === 401) ok("GET payloads", "refuses without a key (401)");
  else fail("GET payloads", "refuses without a key (401)", `HTTP ${noKey.status}`);
  const missing = await get(`${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/payloads/sha256:${"0".repeat(64)}`, authed);
  if (missing.status === 404) ok("GET payloads", "answers 404 for a hash it does not hold");
  else fail("GET payloads", "answers 404 for a hash it does not hold", `HTTP ${missing.status}`);
  if (payloads.size === referenced.size) {
    const full = verifyManifest({ manifest, root: trustedRoot, now, scope: { organizationId: manifest.payload.organizationId ?? organizationId, agentId, target }, storedGeneration: 0, payloads });
    if (full.ok) ok("GET manifest + payloads", "every payload's bytes and length match the manifest (M9–M10)");
    else fail("GET manifest + payloads", "every payload's bytes and length match the manifest (M9–M10)", full.reason);
  }
}

// ---------------------------------------------------------------------------
section("the catalogue");
try {
  const response = await get(`${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/targets/${target}/slots`, authed);
  if (response.status !== 200) fail("GET slots", "answers 200 under the key", `HTTP ${response.status}`);
  else {
    const catalogue = await response.json();
    const tags = (catalogue.slots ?? []).map((s) => s.tag).sort();
    const expected = (manifest?.payload.slots ?? []).map((s) => s.tag).sort();
    if (JSON.stringify(tags) === JSON.stringify(expected)) ok("GET slots", "names exactly the manifest's tags");
    else fail("GET slots", "names exactly the manifest's tags", `${tags.join(",")} vs ${expected.join(",")}`);
    const leaked = JSON.stringify(catalogue).includes("contentHash") || (catalogue.slots ?? []).some((s) => "text" in s || "content" in s);
    if (!leaked) ok("GET slots", "carries no payload bytes or hashes");
    else fail("GET slots", "carries no payload bytes or hashes");
  }
} catch (error) {
  fail("GET slots", "reachable", error.message);
}

// ---------------------------------------------------------------------------
section("the heartbeat");
try {
  const example = readJson(join(protocolDir, "examples", "heartbeat.request.json"));
  const body = { ...example, instanceId: "inst_conformance_live", generation: { active: manifest?.payload.generation ?? 0 }, activeReleaseDigest: manifest?.payload.releaseDigest ?? example.activeReleaseDigest, applyState: "active", signingKeyId: manifest?.signatures[0]?.keyId ?? example.signingKeyId };
  delete body.stagedReleaseDigest;
  delete body.refusal;
  const problem = validate("heartbeat.schema.json#/$defs/request", body);
  if (problem) fail("POST heartbeat", "the runner's own body is schema-valid", problem);
  const noKey = await fetch(`${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/targets/${target}/heartbeat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (noKey.status === 401) ok("POST heartbeat", "refuses without a key (401)");
  else fail("POST heartbeat", "refuses without a key (401)", `HTTP ${noKey.status}`);
  const response = await fetch(`${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/targets/${target}/heartbeat`, { method: "POST", headers: { ...authed, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (response.status !== 200) fail("POST heartbeat", "answers 200 under the key", `HTTP ${response.status}: ${(await response.text()).slice(0, 120)}`);
  else {
    const answer = await response.json();
    const answerProblem = validate("heartbeat.schema.json#/$defs/response", answer);
    if (answerProblem) fail("POST heartbeat", "the answer is schema-valid (heartbeat.schema.json#response)", answerProblem);
    else ok("POST heartbeat", "the answer is schema-valid (heartbeat.schema.json#response)");
    if (typeof answer.expiresAt === "string" && Date.parse(answer.expiresAt) > Date.now()) ok("POST heartbeat", "answers a lease expiry in the future");
    else fail("POST heartbeat", "answers a lease expiry in the future", String(answer.expiresAt));
    if (answer.latestGeneration === undefined || answer.latestGeneration === manifest?.payload.generation) ok("POST heartbeat", "latestGeneration (when present) names the manifest's generation");
    else fail("POST heartbeat", "latestGeneration (when present) names the manifest's generation", `${answer.latestGeneration} vs ${manifest?.payload.generation}`);
  }
  const malformed = await fetch(`${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/targets/${target}/heartbeat`, { method: "POST", headers: { ...authed, "content-type": "application/json" }, body: JSON.stringify({ ...body, promptText: "leak" }) });
  if (malformed.status === 400) ok("POST heartbeat", "refuses a body with a field the schema does not name (400)");
  else fail("POST heartbeat", "refuses a body with a field the schema does not name (400)", `HTTP ${malformed.status}`);
} catch (error) {
  fail("POST heartbeat", "reachable", error.message);
}

// ---------------------------------------------------------------------------
if (json) console.log(JSON.stringify({ baseUrl, agentId, target, generation: manifest?.payload.generation ?? null, checks: results.length, failures, results }));
else console.log(failures === 0 ? `\nlive conformance: all ${results.length} checks passed against ${baseUrl}` : `\nlive conformance: ${failures} of ${results.length} checks failed against ${baseUrl}`);
process.exit(failures === 0 ? 0 : 1);
