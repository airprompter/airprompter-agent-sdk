#!/usr/bin/env node
// Generates protocol/vectors/datastore.json from the reference layout and encoder (conformance/datastore.mjs):
// the keys of representative scopes, the canonical text of every record kind, and the records a reader refuses.
// Deterministic.
//
//   $ node protocol/tools/gen_datastore_vectors.mjs protocol/vectors/datastore.json
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { DATASTORE_FORMAT, datastoreKeys, decodeRecord, encodeRecord } = await import(join(here, "..", "..", "conformance", "datastore.mjs"));

const scopes = [
  { name: "global rows under the default prefix", prefix: "airprompter/", key: { organizationId: "org_1", agentId: "agt_1", target: "prod", region: null }, generation: 42 },
  { name: "a region of its own", prefix: "airprompter/", key: { organizationId: "org_1", agentId: "agt_1", target: "prod", region: "eu-west-1" }, generation: 1 },
  { name: "a region called global never collides with the global rows", prefix: "airprompter/", key: { organizationId: "org_1", agentId: "agt_1", target: "staging", region: "global" }, generation: 7 },
  { name: "separators, dots, percent and non-ASCII are encoded", prefix: "tenants/acme/", key: { organizationId: "org/7", agentId: "agt.4", target: "dev", region: "zürich/1 %x" }, generation: 999999999999 },
  { name: "an empty prefix", prefix: "", key: { organizationId: "org_1", agentId: "agt_1", target: "prod", region: "us-east-1" }, generation: 12 },
];

const keys = scopes.map(({ name, prefix, key, generation }) => {
  const k = datastoreKeys(prefix, key);
  return { name, prefix, key, generation, expect: { releasesPrefix: k.releasesPrefix, release: k.release(generation), latest: k.latest, edge: k.edge, control: k.control } };
});

const bundle = { format: "apbundle", version: 1, protocol: "0.3.4", agentId: "agt_1", target: "prod", encryption: { scheme: "hpke-x25519-aes256gcm", recipientKeyId: "dk_0123456789abcdef", enc: "q83vEjRWeJA", ciphertext: "3q2-7wABAgMEBQYHCAkKCw" } };
const rollout = {
  applyPolicy: "auto",
  experiments: [{ experimentId: "exp_1", tag: "support.reply", arms: [{ arm: "control", weightBps: 9000 }, { arm: "candidate", weightBps: 1000 }], ramp: [{ notBefore: "2026-09-20T02:00:00Z", weightBps: [7500, 2500] }, { notBefore: "2026-09-21T02:00:00Z", weightBps: [5000, 5000] }] }],
  disabled: { agent: false, slots: [], arms: [{ arm: "candidate", experimentId: null }] },
};

const recordInputs = [
  { name: "a release", fields: { kind: "release", generation: 42, releaseDigest: `sha256:${"ab".repeat(32)}`, createdAt: "2026-09-20T01:00:00.000Z", notAfter: "2026-12-19T01:00:00.000Z", bundle, rollout } },
  { name: "a release with no experiment", fields: { kind: "release", generation: 1, releaseDigest: `sha256:${"01".repeat(32)}`, createdAt: "2026-09-20T01:00:00.000Z", notAfter: "2026-12-19T01:00:00.000Z", bundle, rollout: { applyPolicy: "unlock_required", experiments: [], disabled: { agent: true, slots: ["support.reply"], arms: [] } } } },
  { name: "the latest pointer", fields: { kind: "latest", generation: 42 } },
  { name: "the edge state", fields: { kind: "edge", pointerUrl: "https://edge.airprompter.com/p/agt_1/prod/generation.json", pointerEtag: '"abc"', manifestEtag: 'W/"g42"', lastOriginAt: "2026-09-20T01:00:00.000Z" } },
  { name: "the edge state before any pull", fields: { kind: "edge", pointerUrl: null, pointerEtag: null, manifestEtag: null, lastOriginAt: null } },
  { name: "a rollback with its reason", fields: { kind: "control", generation: 41, heldBackBelow: 42, setAt: "2026-09-20T03:00:00.000Z", reason: "INC-4312: élevated refusals", setBy: "ops@example.com" } },
  { name: "a rollback with neither reason nor author", fields: { kind: "control", generation: 3, heldBackBelow: 5, setAt: "2026-09-20T03:00:00.000Z" } },
];
const records = recordInputs.map(({ name, fields }) => ({ name, fields, text: encodeRecord(fields) }));

const refused = [
  { name: "a newer format", kind: "latest", text: `{"format":${DATASTORE_FORMAT + 1},"generation":3,"kind":"latest"}`, code: "datastore_record_newer" },
  { name: "not JSON", kind: "latest", text: "{format:1", code: "datastore_record_invalid" },
  { name: "no format", kind: "latest", text: '{"generation":3,"kind":"latest"}', code: "datastore_record_invalid" },
  { name: "the wrong kind", kind: "latest", text: '{"format":1,"generation":3,"kind":"control"}', code: "datastore_record_invalid" },
  { name: "a missing field", kind: "edge", text: '{"format":1,"kind":"edge","pointerUrl":null}', code: "datastore_record_invalid" },
  { name: "generation zero", kind: "latest", text: '{"format":1,"generation":0,"kind":"latest"}', code: "datastore_record_invalid" },
  { name: "a release under another generation's key", kind: "release", keyGeneration: 43, text: records[0].text, code: "datastore_record_invalid" },
  { name: "a release without its bundle", kind: "release", keyGeneration: 1, text: '{"bundle":null,"createdAt":"2026-09-20T01:00:00.000Z","format":1,"generation":1,"kind":"release","notAfter":"2026-12-19T01:00:00.000Z","releaseDigest":"sha256:0101010101010101010101010101010101010101010101010101010101010101","rollout":{}}', code: "datastore_record_invalid" },
];
for (const entry of refused) {
  try {
    decodeRecord(entry.text, entry.kind, entry.keyGeneration);
    throw new Error(`${entry.name}: the reference decoded it`);
  } catch (error) {
    if (error.code !== entry.code) throw new Error(`${entry.name}: ${error.code ?? error.message}, expected ${entry.code}`);
  }
}

const vectors = { description: "protocol/datastore-format.md: the keys of a scope's records, the canonical text of each record kind, and the records a reader refuses. Generated by protocol/tools/gen_datastore_vectors.mjs.", format: DATASTORE_FORMAT, keys, records, refused };
const out = process.argv[2] ?? join(here, "..", "vectors", "datastore.json");
writeFileSync(out, JSON.stringify(vectors, null, 2) + "\n");
console.log(`wrote ${out}: ${keys.length} key cases, ${records.length} records, ${refused.length} refusals`);
