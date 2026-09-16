#!/usr/bin/env node
// Generates protocol/vectors/manifest-verify.json from the private keys
// embedded below: real ES256 signatures over real canonical bytes, one case
// per refusal in trust-chain.md plus the accept cases. Keys are test keys and
// nothing else; they were generated once and are committed so the documents
// are reproducible (signatures still vary per run — ECDSA is randomised —
// which is why CI verifies a fresh file as well as the checked-in one).
//
//   node protocol/tools/gen_trust_vectors.mjs protocol/vectors/manifest-verify.json

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { canonicalJson, releaseDigest, sha256Prefixed } = await import(join(here, "..", "..", "conformance", "reference.mjs"));
const { jwkThumbprint, publicJwkOf, signBytes } = await import(join(here, "..", "..", "conformance", "trust.mjs"));

const PROTOCOL = readFileSync(join(here, "..", "VERSION"), "utf8").trim();
const KEYS = {
  root: { kty: "EC", crv: "P-256", x: "kHE8TI-jnQoL1Gb2fyooDgcvVUJGUQQwPXzfX1MGiK4", y: "-7-BQROtrrTIaS5tnbfiS72az-XDBzbph57mB8MT1jU", d: "hUxny0ocprVEGy2YVbwSFp3-SDNGSaZ2CEtyPISSNx8" },
  root2: { kty: "EC", crv: "P-256", x: "hOULaRqrgyc2St_4ql3hM3izY_z_LQttTS86ttFtrog", y: "DMcYKS3vcb6f87MfX9LMswbwb1GHmP4nGdRAn2l_9II", d: "hdViynm0uZGus5CvdSmMOZhmasQlv79Hh8zCLiTafbM" },
  targets: { kty: "EC", crv: "P-256", x: "2MDfMOVEz8pM_m7u_O9zMlr4T2GHN_tlpj9pfVMGdyo", y: "ym9DiH-4GitdO8-tBC3sZePPU-bEV9Hc0kYOen_IYho", d: "suiXAnwPf-Gk1JvX1m2PHRVKuL0iSXfIakwiFef6b5g" },
  targets2: { kty: "EC", crv: "P-256", x: "pzFiUrZVpM-NT02wHXJyzlcHP9or-ZxLgxR24t5x3iA", y: "nKKRl1lN4X8flhUg4KlE2Qqc5LZm62MnZLL96beQqcY", d: "PfaY6vfUmyzNmINe1mTP1XXcMYaql1Z3M-Z36qJq32c" },
  targetsOld: { kty: "EC", crv: "P-256", x: "m7ZYFNOFv1vzyBKaKFIMAJnndXPIwAV4Ocv-KZjgjYk", y: "9r0Dm26RQU5qPk09TE3CG_FkBf5s_uE_rRrwRaJ9DlI", d: "189Y3MrD1Kvy6DO2Iuan9Dsqas720OaOTeUWc4z5D-c" },
  customer: { kty: "EC", crv: "P-256", x: "KzsmGuM-Z53x0MWWsHgFHIsdG_b9cFKjSnAMbzY7oBw", y: "DVgFOkksqri95aXKTV6K5K19EPjmVtEEakm12yo70VY", d: "x78RSsCI0IyvrCrvYPCQeI-VeAxtEXEU3yT9eISUoM8" },
  stranger: { kty: "EC", crv: "P-256", x: "SRbRjFVinD_IgVolkoIQ7Gm_NA7-AMDdtFnm9GE7K60", y: "lM4vYLVTRnyZGKRYr9Ww-cQmSCK9bECU-2_Y8WRYzIc", d: "ejW56s3ZZEOOfnzGVUpJwj4nf8Q2juc27-9PS_8LTWw" },
};
const id = Object.fromEntries(Object.entries(KEYS).map(([name, jwk]) => [name, jwkThumbprint(jwk)]));
const pub = (name) => ({ keyType: "ecdsa-p256", scheme: "ES256", publicKey: publicJwkOf(KEYS[name]) });

const NOW = "2026-09-12T12:00:00Z";
const SCOPE = { organizationId: "org_7d3f9a2b", agentId: "agt_4e8c1b6d", target: "prod" };

function rootDoc({ version, expires = "2026-12-11T00:00:00Z", targets = ["targets"], threshold = 1, extraKeys = {}, signWith = ["root"], purpose = "platform", environment = "prod", rootKeys = ["root"] }) {
  const keys = {};
  for (const name of rootKeys) keys[id[name]] = pub(name);
  for (const name of targets) keys[id[name]] = { ...pub(name), ...(extraKeys[name] ?? {}) };
  const signed = {
    type: "root",
    protocol: PROTOCOL,
    purpose,
    environment,
    version,
    expires,
    keys,
    roles: { root: { keyIds: rootKeys.map((n) => id[n]), threshold: 1 }, targets: { keyIds: targets.map((n) => id[n]), threshold } },
  };
  const bytes = Buffer.from(canonicalJson(signed), "utf8");
  return { signed, signatures: signWith.map((name) => ({ keyId: id[name], alg: "ES256", sig: signBytes(bytes, KEYS[name]) })) };
}

const triage = Buffer.from("You are a support triage assistant.\n<ticket>{{ticket_body}}</ticket>\n", "utf8");
const reply = Buffer.from("Draft a reply for {{customer_name}}.\n", "utf8");
const slots = [
  { tag: "support.reply", kind: "prompt", artifactId: "prm_1c4d5e6f7a8b", versionId: "ver_01j9x4k2n0aa", versionOrdinal: 3, contentHash: sha256Prefixed(reply), byteLength: reply.length, model: "gpt-5", variables: [{ name: "customer_name", required: true, trust: "operator" }] },
  { tag: "support.triage", kind: "prompt", artifactId: "prm_8b2f3c1d9e4a", versionId: "ver_01j9x4k2m7q8", versionOrdinal: 7, contentHash: sha256Prefixed(triage), byteLength: triage.length, model: "claude-sonnet-5", variables: [{ name: "ticket_body", required: true, trust: "end_user" }] },
];
const digest = releaseDigest(slots);
// T15: a slot whose model is required — the flag is part of the digest input only when true, so this release has a
// different digest from the plain one and every SDK must reproduce it from the pins.
const requiredSlots = [slots[0], { ...slots[1], modelRequired: true }];
const requiredDigest = releaseDigest(requiredSlots);
if (requiredDigest === digest) throw new Error("modelRequired: true must change the release digest");
if (releaseDigest([slots[0], { ...slots[1], modelRequired: false }]) !== digest) throw new Error("modelRequired: false must not change the release digest");
const payloadsOk = [
  { contentHash: slots[0].contentHash, bytes: reply.toString("base64url") },
  { contentHash: slots[1].contentHash, bytes: triage.toString("base64url") },
];
// T34: a slot with a golden set — the reference is in the digest input, and the cases are a payload the chain
// verifies like any other (golden-sets.md). Canonical bytes, so every SDK reproduces the hash from the cases.
const goldenSet = { format: "airprompter-golden-set", version: 1, setId: "gs_20260912", minPassBps: 10000, cases: [
  { caseId: "billing-refund", variables: { ticket_body: "I was charged twice, please refund one" }, expect: [{ kind: "must_match", name: "names-billing", pattern: "billing", flags: "i" }] },
  { caseId: "where-is-my-order", variables: { ticket_body: "Order 1234 has not arrived" }, expect: [{ kind: "must_match", name: "mentions-order", pattern: "1234" }] },
] };
const goldenBytes = Buffer.from(canonicalJson(goldenSet), "utf8");
const goldenSlots = [slots[0], { ...slots[1], goldenSet: { setId: goldenSet.setId, cases: goldenSet.cases.length, contentHash: sha256Prefixed(goldenBytes), byteLength: goldenBytes.length, minPassBps: goldenSet.minPassBps } }];
const goldenDigest = releaseDigest(goldenSlots);
if (goldenDigest === digest) throw new Error("a golden set must change the release digest");
const payloadsWithGolden = [...payloadsOk, { contentHash: sha256Prefixed(goldenBytes), bytes: goldenBytes.toString("base64url") }];
// 0.3.1: a slot's inference settings are in the digest input when present — and only the settings, in one order,
// so every SDK reproduces the digest whatever order the manifest's author wrote the keys in.
const inferenceSlots = [slots[0], { ...slots[1], inference: { topPBps: 9000, temperatureMilli: 200, maxOutputTokens: 800, stopSequences: ["\n\nHuman:"], reasoningEffort: "low" } }];
const inferenceDigest = releaseDigest(inferenceSlots);
if (inferenceDigest === digest) throw new Error("inference must change the release digest");
if (releaseDigest([slots[0], { ...slots[1], inference: { reasoningEffort: "low", stopSequences: ["\n\nHuman:"], maxOutputTokens: 800, temperatureMilli: 200, topPBps: 9000 } }]) !== inferenceDigest) throw new Error("the inference digest input is order-free");

/** S16: a well-formed per-slot experiment — the candidate arm overrides that slot only, on a digest of its own. */
function experimentFor(tag, experimentId) {
  const own = slots.find((s) => s.tag === tag);
  return { experimentId, tag, salt: "AAECAwQFBgcICQoLDA0ODw", subjectKey: "request", arms: [{ arm: "control", weightBps: 9000, releaseDigest: digest, overrides: [] }, { arm: "candidate", weightBps: 1000, releaseDigest: "sha256:" + experimentId.slice(-1).repeat(64), overrides: [{ ...own, versionId: "ver_candidate" }] }] };
}

function payload(overrides = {}) {
  return {
    protocol: PROTOCOL,
    ...SCOPE,
    generation: 42,
    releaseDigest: digest,
    issuedAt: "2026-09-12T11:00:00Z",
    leaseSeconds: 3600,
    onLeaseExpiry: "degrade",
    applyPolicy: "unlock_required",
    requireCountersign: false,
    slots,
    directives: [],
    ...overrides,
  };
}
function manifest(p, signWith = ["targets"], countersignatures) {
  const bytes = Buffer.from(canonicalJson(p), "utf8");
  const doc = { payload: p, signatures: signWith.map((name) => ({ keyId: id[name], alg: "ES256", sig: signBytes(bytes, KEYS[name]) })) };
  if (countersignatures) doc.countersignatures = countersignatures;
  return doc;
}
function countersign(d, name = "customer", signedAt = "2026-09-12T10:30:00Z") {
  return { keyId: id[name], alg: "ES256", releaseDigest: d, sig: signBytes(Buffer.from(d, "utf8"), KEYS[name]), signedAt };
}
const customerRoot = rootDoc({ version: 1, purpose: "countersign", targets: ["customer"], rootKeys: ["root2"], signWith: ["root2"] });

const rootV1 = rootDoc({ version: 1 });
const base = {
  pinnedRoot: publicJwkOf(KEYS.root),
  purpose: "platform",
  environment: "prod",
  scope: SCOPE,
  now: NOW,
  storedRootVersion: 0,
  storedGeneration: 41,
};

const rootCases = [
  { name: "root v1 signed by the pinned root is accepted", ...base, candidate: rootV1, expected: { ok: true } },
  { name: "root signed by a stranger is refused", ...base, candidate: rootDoc({ version: 1, signWith: ["stranger"] }), expected: { ok: false, reason: "root_signature_invalid" } },
  { name: "root signed by a targets key (not root) is refused — a signing key cannot authorize its successor", ...base, candidate: rootDoc({ version: 1, signWith: ["targets"] }), expected: { ok: false, reason: "root_signature_invalid" } },
  { name: "root whose bytes were altered after signing is refused", ...base, candidate: (() => { const d = rootDoc({ version: 1 }); return { ...d, signed: { ...d.signed, expires: "2027-12-11T00:00:00Z" } }; })(), expected: { ok: false, reason: "root_signature_invalid" } },
  { name: "expired root is refused (and an accepted one that expires degrades, never bricks)", ...base, candidate: rootDoc({ version: 1, expires: "2026-09-01T00:00:00Z" }), expected: { ok: false, reason: "root_expired", effect: "refuse_new_manifests_keep_active" } },
  { name: "root for another environment is refused", ...base, candidate: rootDoc({ version: 1, environment: "staging" }), expected: { ok: false, reason: "root_scope_mismatch" } },
  { name: "root for the countersign purpose is not a platform root", ...base, candidate: rootDoc({ version: 1, purpose: "countersign" }), expected: { ok: false, reason: "root_scope_mismatch" } },
  { name: "root version below the stored one is refused", ...base, storedRootVersion: 2, trustedRoot: rootDoc({ version: 2 }), candidate: rootV1, expected: { ok: false, reason: "root_rollback" } },
  { name: "root listing a key under a foreign id is refused", ...base, candidate: (() => { const d = rootDoc({ version: 1 }); const keys = { ...d.signed.keys }; keys[id.targets] = pub("stranger"); const signed = { ...d.signed, keys }; const bytes = Buffer.from(canonicalJson(signed), "utf8"); return { signed, signatures: [{ keyId: id.root, alg: "ES256", sig: signBytes(bytes, KEYS.root) }] }; })(), expected: { ok: false, reason: "key_id_mismatch" } },
  { name: "rotation: root v2 (signed by root) listing the new key is accepted over v1", ...base, storedRootVersion: 1, trustedRoot: rootV1, candidate: rootDoc({ version: 2, targets: ["targets2", "targetsOld"], extraKeys: { targetsOld: { notAfter: "2026-10-01T00:00:00Z" } } }), expected: { ok: true } },
];

const manifestCases = [
  { name: "valid chain: root v1, manifest signed by the listed targets key, payloads hash", ...base, root: rootV1, manifest: manifest(payload()), payloads: payloadsOk, expected: { ok: true, signingKeyId: id.targets, generation: 42 } },
  { name: "equal generation is a no-op re-fetch, not a rollback", ...base, storedGeneration: 42, root: rootV1, manifest: manifest(payload()), expected: { ok: true, signingKeyId: id.targets, generation: 42 } },
  { name: "envelope with one unknown key and one listed key passes", ...base, root: rootV1, manifest: manifest(payload(), ["stranger", "targets"]), expected: { ok: true, signingKeyId: id.targets, generation: 42 } },
  { name: "manifest signed by a key absent from root is refused", ...base, root: rootV1, manifest: manifest(payload(), ["stranger"]), expected: { ok: false, reason: "unknown_signing_key" } },
  { name: "manifest signed by the root key itself is refused (root never signs manifests)", ...base, root: rootV1, manifest: manifest(payload(), ["root"]), expected: { ok: false, reason: "unknown_signing_key" } },
  { name: "expired root refuses new manifests; the active release keeps serving", ...base, root: rootDoc({ version: 1, expires: "2026-09-01T00:00:00Z" }), manifest: manifest(payload()), expected: { ok: false, reason: "root_expired", effect: "refuse_new_manifests_keep_active" } },
  { name: "payload altered after signing is refused", ...base, root: rootV1, manifest: (() => { const m = manifest(payload()); return { ...m, payload: { ...m.payload, leaseSeconds: 60 } }; })(), expected: { ok: false, reason: "signature_invalid" } },
  { name: "signature bytes corrupted is refused", ...base, root: rootV1, manifest: (() => { const m = manifest(payload()); const sig = m.signatures[0].sig; return { ...m, signatures: [{ ...m.signatures[0], sig: (sig[0] === "A" ? "B" : "A") + sig.slice(1) }] }; })(), expected: { ok: false, reason: "signature_invalid" } },
  { name: "threshold 2 with one valid signature is refused", ...base, root: rootDoc({ version: 1, targets: ["targets", "targets2"], threshold: 2 }), manifest: manifest(payload(), ["targets"]), expected: { ok: false, reason: "signature_threshold" } },
  { name: "threshold 2 with two valid signatures is accepted", ...base, root: rootDoc({ version: 1, targets: ["targets", "targets2"], threshold: 2 }), manifest: manifest(payload(), ["targets", "targets2"]), expected: { ok: true, signingKeyId: id.targets, generation: 42 } },
  { name: "the same key twice does not meet a threshold of 2", ...base, root: rootDoc({ version: 1, targets: ["targets", "targets2"], threshold: 2 }), manifest: manifest(payload(), ["targets", "targets"]), expected: { ok: false, reason: "signature_threshold" } },
  { name: "signing key past its notAfter is refused", ...base, root: rootDoc({ version: 1, targets: ["targets"], extraKeys: { targets: { notAfter: "2026-09-01T00:00:00Z" } } }), manifest: manifest(payload()), expected: { ok: false, reason: "signing_key_expired" } },
  { name: "signing key before its notBefore is refused", ...base, root: rootDoc({ version: 1, targets: ["targets"], extraKeys: { targets: { notBefore: "2026-10-01T00:00:00Z" } } }), manifest: manifest(payload()), expected: { ok: false, reason: "signing_key_expired" } },
  { name: "rotation: manifest signed by the removed key is refused under root v2", ...base, storedRootVersion: 2, root: rootDoc({ version: 2, targets: ["targets2"] }), manifest: manifest(payload(), ["targets"]), expected: { ok: false, reason: "unknown_signing_key" } },
  { name: "rotation: manifest signed by the new key is accepted under root v2", ...base, storedRootVersion: 2, root: rootDoc({ version: 2, targets: ["targets2"] }), manifest: manifest(payload(), ["targets2"]), expected: { ok: true, signingKeyId: id.targets2, generation: 42 } },
  { name: "manifest for another organization is refused", ...base, root: rootV1, manifest: manifest(payload({ organizationId: "org_other" })), expected: { ok: false, reason: "scope_mismatch" } },
  { name: "manifest for another agent is refused", ...base, root: rootV1, manifest: manifest(payload({ agentId: "agt_other" })), expected: { ok: false, reason: "scope_mismatch" } },
  { name: "staging manifest presented to a prod runtime is refused", ...base, root: rootV1, manifest: manifest(payload({ target: "staging" })), expected: { ok: false, reason: "scope_mismatch" } },
  { name: "generation below the stored one is refused (server-side rollback is a NEW generation)", ...base, storedGeneration: 43, root: rootV1, manifest: manifest(payload()), expected: { ok: false, reason: "generation_rollback" } },
  { name: "a referenced payload that was not fetched is refused", ...base, root: rootV1, manifest: manifest(payload()), payloads: [payloadsOk[0]], expected: { ok: false, reason: "payload_missing" } },
  { name: "payload bytes that do not hash to contentHash are refused", ...base, root: rootV1, manifest: manifest(payload()), payloads: [payloadsOk[0], { contentHash: slots[1].contentHash, bytes: Buffer.from("tampered", "utf8").toString("base64url") }], expected: { ok: false, reason: "payload_hash_mismatch" } },
  { name: "payload with the right hash but wrong declared length is refused", ...base, root: rootV1, manifest: manifest(payload({ slots: [slots[0], { ...slots[1], byteLength: slots[1].byteLength + 1 }] })), payloads: payloadsOk, expected: { ok: false, reason: "payload_hash_mismatch" } },
  { name: "unsupported protocol major is refused", ...base, root: rootV1, manifest: manifest(payload({ protocol: "9.0.0" })), expected: { ok: false, reason: "protocol_unsupported" } },
  { name: "countersign required, none present: refused", ...base, root: rootV1, countersignRoot: customerRoot, manifest: manifest(payload({ requireCountersign: true })), expected: { ok: false, reason: "countersign_missing" } },
  { name: "countersign required, valid customer signature: accepted", ...base, root: rootV1, countersignRoot: customerRoot, manifest: manifest(payload({ requireCountersign: true }), ["targets"], [countersign(digest)]), expected: { ok: true, signingKeyId: id.targets, generation: 42 } },
  { name: "countersign by a key outside the customer root is refused", ...base, root: rootV1, countersignRoot: customerRoot, manifest: manifest(payload({ requireCountersign: true }), ["targets"], [countersign(digest, "stranger")]), expected: { ok: false, reason: "countersign_missing" } },
  { name: "countersign over a different digest is refused", ...base, root: rootV1, countersignRoot: customerRoot, manifest: manifest(payload({ requireCountersign: true }), ["targets"], [countersign("sha256:" + "b".repeat(64))]), expected: { ok: false, reason: "countersign_missing" } },
  { name: "countersign with corrupted bytes is refused", ...base, root: rootV1, countersignRoot: customerRoot, manifest: manifest(payload({ requireCountersign: true }), ["targets"], [(() => { const c = countersign(digest); return { ...c, sig: (c.sig[0] === "A" ? "B" : "A") + c.sig.slice(1) }; })()]), expected: { ok: false, reason: "countersign_invalid" } },
  { name: "locally required countersign applies even when the manifest says false (the local side can be stricter)", ...base, requireCountersign: true, root: rootV1, countersignRoot: customerRoot, manifest: manifest(payload({ requireCountersign: false })), expected: { ok: false, reason: "countersign_missing" } },
  { name: "a slot whose model is required verifies; the flag is in its release digest (T15)", ...base, root: rootV1, manifest: manifest(payload({ slots: requiredSlots, releaseDigest: requiredDigest })), payloads: payloadsOk, expected: { ok: true, signingKeyId: id.targets, generation: 42 } },
  { name: "a slot with a golden set verifies when the set's payload is fetched; the reference is in its release digest (T34)", ...base, root: rootV1, manifest: manifest(payload({ slots: goldenSlots, releaseDigest: goldenDigest })), payloads: payloadsWithGolden, expected: { ok: true, signingKeyId: id.targets, generation: 42 } },
  { name: "a golden set's payload is referenced like any other: not fetched is refused (T34)", ...base, root: rootV1, manifest: manifest(payload({ slots: goldenSlots, releaseDigest: goldenDigest })), payloads: payloadsOk, expected: { ok: false, reason: "payload_missing" } },
  { name: "a slot with inference settings verifies, and the settings are in its release digest (0.3.1)", ...base, root: rootV1, manifest: manifest(payload({ slots: inferenceSlots, releaseDigest: inferenceDigest })), payloads: payloadsOk, expected: { ok: true, signingKeyId: id.targets, generation: 42 } },
  { name: "a directive of a kind the runtime does not honour refuses the whole manifest before any payload is fetched (S4)", ...base, root: rootV1, manifest: manifest(payload({ directives: [{ kind: "reboot", issuedAt: "2026-09-12T10:00:00Z" }, { kind: "disable", scope: "agent", issuedAt: "2026-09-12T10:00:00Z" }] })), payloads: payloadsOk, expected: { ok: false, reason: "directive_unknown" } },
  { name: "the two kinds the runtime honours verify (S4): disable acts without a local act, request_unlock only asks", ...base, root: rootV1, manifest: manifest(payload({ directives: [{ kind: "disable", scope: "slot", tag: "support.reply", issuedAt: "2026-09-12T10:00:00Z", reason: "incident" }, { kind: "request_unlock", releaseDigest: digest, requestedBy: "usr_console", requestedAt: "2026-09-12T10:00:00Z", expiresAt: "2026-09-12T14:00:00Z" }] })), payloads: payloadsOk, expected: { ok: true, signingKeyId: id.targets, generation: 42 } },
  // S16 (M15): per-prompt experiments — a well-formed experiments[] verifies; the conflicts are refused before any payload.
  { name: "experiments[] with one split per slot verifies (S16)", ...base, root: rootV1, manifest: manifest(payload({ experiments: [experimentFor("support.triage", "exp_a"), experimentFor("support.reply", "exp_b")] })), expected: { ok: true, signingKeyId: id.targets, generation: 42 } },
  { name: "experiment beside experiments[] is refused (S16, M15)", ...base, root: rootV1, manifest: manifest(payload({ experiment: (() => { const { tag: _t, ...legacy } = experimentFor("support.triage", "exp_legacy"); return legacy; })(), experiments: [experimentFor("support.reply", "exp_b")] })), expected: { ok: false, reason: "experiment_conflict" } },
  { name: "a slot in two experiments is refused (S16, M15)", ...base, root: rootV1, manifest: manifest(payload({ experiments: [experimentFor("support.triage", "exp_a"), experimentFor("support.triage", "exp_b")] })), expected: { ok: false, reason: "experiment_conflict" } },
  { name: "an override naming another experiment's slot is refused (S16, M15)", ...base, root: rootV1, manifest: manifest(payload({ experiments: [{ ...experimentFor("support.triage", "exp_a"), arms: [{ arm: "control", weightBps: 9000, releaseDigest: digest, overrides: [] }, { arm: "candidate", weightBps: 1000, releaseDigest: "sha256:" + "c".repeat(64), overrides: [slots.find((s) => s.tag === "support.reply")] }] }] })), expected: { ok: false, reason: "experiment_conflict" } },
  { name: "an arm-scoped disable without its experiment on an experiments[] manifest is refused (S16, M15)", ...base, root: rootV1, manifest: manifest(payload({ experiments: [experimentFor("support.triage", "exp_a")], directives: [{ kind: "disable", scope: "arm", arm: "candidate", issuedAt: "2026-09-12T11:30:00Z" }] })), expected: { ok: false, reason: "experiment_conflict" } },
  { name: "experiment on a countersign target: both arms must be countersigned (D58)", ...base, root: rootV1, countersignRoot: customerRoot, manifest: manifest(payload({ requireCountersign: true, experiment: { experimentId: "exp_1", salt: "AAECAwQFBgcICQoLDA0ODw", subjectKey: "request", arms: [{ arm: "control", weightBps: 9000, releaseDigest: digest, overrides: [] }, { arm: "candidate", weightBps: 1000, releaseDigest: "sha256:" + "c".repeat(64), overrides: [] }] } }), ["targets"], [countersign(digest)]), expected: { ok: false, reason: "countersign_missing" } },
];

const doc = {
  $comment: "Generated by protocol/tools/gen_trust_vectors.mjs from embedded TEST keys. Real signatures; regenerate deliberately (ECDSA is randomised). See trust-chain.md.",
  protocol: PROTOCOL,
  keyIds: id,
  rootMetadata: rootCases,
  manifests: manifestCases,
};
const out = process.argv[2];
if (!out) throw new Error("usage: gen_trust_vectors.mjs <out.json>");
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`${rootCases.length} root cases, ${manifestCases.length} manifest cases -> ${out}`);
