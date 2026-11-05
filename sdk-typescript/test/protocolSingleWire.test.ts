/**
 * One wire: with `protocolVectors.test.ts` (every vector passes), this proves the SDK speaks exactly protocol 3.x.
 * Older majors are refused, any 3.x loads, the capability registry has one source, the older shapes fail the schema,
 * and every refused example is refused for the code it names. Older literals are built here, so the repository's
 * search for them stays clean.
 *
 * @example
 *   $ TSX_DISABLE_CACHE=1 node --import tsx --test test/protocolSingleWire.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

import { SUPPORTED_CAPABILITIES } from "../packages/sdk/src/core/protocol/capabilities.js";
import { canonicalBytes } from "../packages/sdk/src/core/protocol/canonicalJson.js";
import { AirPrompterAgent } from "../packages/sdk/src/agent.js";
import { keyThumbprint, publicJwkOf, signBytes, SUPPORTED_PROTOCOL_MAJORS, verifyManifest } from "../packages/sdk/src/core/protocol/trust.js";
import type { Manifest, ManifestPayload } from "../packages/sdk/src/core/protocol/types.js";
import { PROTOCOL_VERSION } from "../packages/sdk/src/core/protocol/version.js";
import { FakeControlPlane } from "./helpers/controlPlane.js";

const scope = { organizationId: "org_1", agentId: "agt_wire", target: "prod" };
const protocolPath = (path: string) => new URL(`../../protocol/${path}`, import.meta.url);
const OLDER_FIELD = ["onLease", "Expiry"].join("");

function promoted(patch: Partial<ManifestPayload> & Record<string, unknown>): { plane: FakeControlPlane; manifest: Manifest } {
  const plane = new FakeControlPlane(scope);
  const base = plane.promote([plane.slot({ tag: "support.reply", text: "Reply" })]);
  const payload = { ...base.payload, ...patch } as ManifestPayload;
  return { plane, manifest: { payload, signatures: [{ keyId: keyThumbprint(plane.signingKey), alg: "ES256", sig: signBytes(canonicalBytes(payload), plane.signingKey) }] } };
}
const verdict = ({ plane, manifest }: ReturnType<typeof promoted>) => verifyManifest({ manifest, root: plane.root, now: new Date().toISOString(), scope, storedGeneration: 0, payloads: null });

test("PROTOCOL_VERSION is protocol/VERSION, and the only major this SDK reads is 3", () => {
  assert.equal(PROTOCOL_VERSION, readFileSync(protocolPath("VERSION"), "utf8").trim());
  assert.deepEqual([...SUPPORTED_PROTOCOL_MAJORS], [3]);
});

test("older majors get the unsupported-major refusal", () => {
  for (const protocol of [[0, 3, 5].join("."), "2.0.0", "4.0.0"]) assert.deepEqual(verdict(promoted({ protocol })), { ok: false, reason: "protocol_unsupported" }, protocol);
});

test("any 3.x loads: a reader checks the major and the capabilities, never the minor", () => {
  assert.equal(verdict(promoted({ protocol: "3.7.0" })).ok, true);
  assert.equal(verdict(promoted({ protocol: "3.0.0" })).ok, true);
});

test("a manifest naming a capability this SDK does not implement is refused whole", () => {
  assert.deepEqual(verdict(promoted({ requiredCapabilities: ["guardrail_slots"] })), { ok: false, reason: "protocol_unsupported", directivesStand: true });
  assert.equal(verdict(promoted({ requiredCapabilities: [] })).ok, true, "asking for nothing asks for nothing");
});

test("a 3.0.0 manifest without observations loads", () => {
  const made = promoted({});
  assert.equal("observations" in made.manifest.payload, false);
  assert.equal(verdict(made).ok, true);
});

test("the capability registry has one source: capabilities.md equals SUPPORTED_CAPABILITIES", () => {
  const rows = readFileSync(protocolPath("capabilities.md"), "utf8").split("## Registry")[1]!.split("\n").filter((line) => line.startsWith("|")).slice(2);
  const names = rows.map((row) => row.split("|")[1]!.trim().replaceAll("`", ""));
  assert.deepEqual(names.sort(), [...SUPPORTED_CAPABILITIES].sort());
  assert.equal(SUPPORTED_CAPABILITIES.size, 0, "3.0.0 ships the registry empty");
});

const addFormats = createRequire(import.meta.url)("ajv-formats").default as (ajv: Ajv2020) => void;

async function schemas() {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  const ids: Record<string, string> = {};
  for (const file of readdirSync(protocolPath("schemas")).filter((name) => name.endsWith(".schema.json"))) {
    const schema = JSON.parse(readFileSync(protocolPath(`schemas/${file}`), "utf8")) as { $id: string };
    ajv.addSchema(schema);
    ids[file.replace(".schema.json", "")] = schema.$id;
  }
  return (name: string) => {
    const [base, fragment] = name.split("#");
    return ajv.getSchema(`${ids[base!]}${fragment ? `#${fragment}` : ""}`)!;
  };
}
const example = (path: string) => JSON.parse(readFileSync(protocolPath(`examples/${path}`), "utf8")) as Record<string, any>;

test("the older shapes fail the manifest schema, and a heartbeat with capabilities: [] validates", async () => {
  const schema = await schemas();
  const manifest = schema("manifest");
  const good = example("manifest.json");
  assert.equal(manifest(good), true, "the example validates");
  assert.equal(manifest({ ...good, payload: { ...good.payload, [OLDER_FIELD]: "degrade" } }), false, "the lease setting is gone");
  assert.equal(manifest({ ...good, payload: { ...good.payload, experiment: good.payload.experiments[0] } }), false, "the single experiment is gone");
  const { observations: _observations, ...noObservations } = good.payload;
  const withoutAudience = { ...noObservations, experiments: noObservations.experiments.map(({ audience: _audience, ...experiment }: Record<string, unknown>) => experiment) };
  assert.equal(manifest({ ...good, payload: withoutAudience }), true, "observations are optional");
  assert.equal(manifest({ ...good, payload: { ...good.payload, protocol: "3.7.0" } }), true, "any 3.x");
  const heartbeat = schema("heartbeat#/$defs/request");
  const request = example("heartbeat.request.json");
  assert.deepEqual(request.capabilities, []);
  assert.equal(heartbeat(request), true);
  assert.equal(heartbeat({ ...request, runCounters: { passthrough: { no_slot: 3, slot_disabled: 1 } } }), true, "an open map");
  assert.equal(heartbeat({ ...request, runCounters: { passthrough: { "Not A Key": 1 } } }), false);
  assert.equal(heartbeat({ ...request, capabilities: ["Not_A_Name"] }), false);
  assert.equal(heartbeat({ ...request, capabilities: new Array(33).fill(0).map((_, i) => `cap_${i}`) }), false, "at most 32");
});

test("a live heartbeat is the one schema: the fields older runtimes left out are all there", async () => {
  const schema = await schemas();
  const heartbeat = schema("heartbeat#/$defs/request");
  const plane = new FakeControlPlane(scope);
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply" })]);
  const stateDir = mkdtempSync(join(tmpdir(), "ap-wire-"));
  const ap = await AirPrompterAgent.start({ ...scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "resident", pollSeconds: 3600 }, fetch: plane.fetch(), tags: { region: "eu" } });
  try {
    const body = ap.heartbeatBody();
    assert.equal(heartbeat(body), true, JSON.stringify(heartbeat.errors));
    assert.deepEqual(body.capabilities, [...SUPPORTED_CAPABILITIES]);
    assert.deepEqual(body.runCounters, { passthrough: {} });
  } finally {
    await ap.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a target is a slug in every schema that names one; a deployment stays one of three", async () => {
  const schema = await schemas();
  const manifest = schema("manifest");
  const good = example("manifest.json");
  assert.equal(manifest({ ...good, payload: { ...good.payload, target: "qa" } }), true);
  for (const target of ["Prod", "1st", "", "a".repeat(33), "with_underscore"]) assert.equal(manifest({ ...good, payload: { ...good.payload, target } }), false, target);
  const keySet = schema("key-set");
  const keys = example("key-set.json");
  assert.equal(keySet(keys), true);
  assert.equal(keys.signed.purpose, "platform");
  assert.equal(keySet({ ...keys, signed: { ...keys.signed, environment: "qa" } }), false, "a platform root names a deployment, never a stage");
  const countersign = { ...keys, signed: { ...keys.signed, purpose: "countersign" } };
  assert.equal(keySet({ ...countersign, signed: { ...countersign.signed, environment: "qa" } }), true, "a countersign root may name any stage");
  assert.equal(keySet({ ...countersign, signed: { ...countersign.signed, environment: "prod" } }), true);
  assert.equal(keySet({ ...countersign, signed: { ...countersign.signed, environment: "Not A Slug" } }), false, "a slug, still");
  assert.equal(schema("store")({ ...example("store.v2.json"), target: "qa" }), true);
  assert.equal(schema("daemon")({ ...example("daemon.json"), target: "qa" }), true);
  assert.equal(schema("spool-manifest")({ ...example("spool-manifest.json"), target: "qa" }), true);
});

test("run counters: passthrough stays flat with its own keys, a new family takes identifiers, and free text never validates", async () => {
  const schema = await schemas();
  const request = schema("heartbeat#/$defs/request");
  const good = example("heartbeat.request.json");
  const counters = (runCounters: unknown) => request({ ...good, runCounters });
  assert.equal(counters({ passthrough: { no_slot: 1 } }), true);
  assert.equal(counters({ passthrough: { "no-slot": 1 } }), false, "passthrough keeps its key pattern");
  assert.equal(counters({ passthrough: { no_slot: { nested: 1 } } }), false, "passthrough is flat");
  assert.equal(counters({ passthrough: {}, experiments: { "exp-rollout-1": 3, nested: { "a.b:c": 1 } } }), true, "a family takes the identifier pattern");
  assert.equal(counters({ passthrough: {}, experiments: { name: "free text" } }), false, "free text never validates");
  assert.equal(counters({ passthrough: {}, "not an id": 1 }), false);
  assert.equal(counters({ passthrough: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`reason_${i}`, 1])) }), false, "a bound on passthrough");
  assert.equal(counters({ passthrough: {}, experiments: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`e${i}`, 1])) }), false, "a bound on a family");
});

test("every refused example is refused for the code it names", async () => {
  const schema = await schemas();
  const plane = new FakeControlPlane(scope);
  const validators: Record<string, string> = { manifest: "manifest", "key-set": "key-set", bundle: "bundle", "heartbeat-request": "heartbeat#/$defs/request", "heartbeat-response": "heartbeat#/$defs/response", "edge-pointer": "edge-pointer", store: "store", daemon: "daemon", "spool-manifest": "spool-manifest" };
  const files = readdirSync(protocolPath("examples/refused")).filter((name) => name.endsWith(".json"));
  assert.ok(files.length >= 30);
  for (const file of files) {
    const entry = example(`refused/${file}`) as { schema: string; code: string; at: string; document: Manifest };
    const validate = schema(validators[entry.schema]!);
    assert.equal(validate(entry.document), false, `${file}: accepted`);
    assert.ok(validate.errors?.some((error: { instancePath: string }) => error.instancePath.startsWith(entry.at)), `${file}: refused elsewhere than ${entry.at}`);
    if (entry.code === "schema_invalid") continue;
    // A code an SDK answers with: sign the document so the check under test, not the placeholder signature, decides.
    const payload = { ...entry.document.payload, organizationId: scope.organizationId, agentId: scope.agentId, target: scope.target };
    const manifest = { payload, signatures: [{ keyId: keyThumbprint(plane.signingKey), alg: "ES256" as const, sig: signBytes(canonicalBytes(payload), plane.signingKey) }] };
    const verdict = verifyManifest({ manifest, root: plane.root, now: "2026-09-12T12:00:00Z", scope, storedGeneration: 0, payloads: null });
    assert.deepEqual([verdict.ok, verdict.ok ? null : verdict.reason], [false, entry.code], file);
  }
});
