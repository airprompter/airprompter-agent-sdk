// Reference implementation of protocol/trust-chain.md: thumbprints, ES256
// over canonical bytes (P1363, base64url), root-metadata acceptance (R1–R5)
// and manifest verification (M1–M12). Written from the prose; checked
// against vectors/manifest-verify.json.

import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

import { canonicalJson, sha256Prefixed } from "./reference.mjs";

/** RFC 7638 thumbprint of a P-256 JWK: sha256 over canonical {crv,kty,x,y}, hex. */
export function jwkThumbprint(jwk) {
  return createHash("sha256")
    .update(canonicalJson({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }), "utf8")
    .digest("hex");
}

/** ES256 over the bytes, P1363 r‖s, base64url without padding. */
export function signBytes(bytes, privateJwk) {
  const key = createPrivateKey({ key: privateJwk, format: "jwk" });
  return cryptoSign("sha256", bytes, { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
}

export function verifyBytes(bytes, signatureBase64url, publicJwk) {
  if (!/^[A-Za-z0-9_-]{86}$/.test(signatureBase64url)) return false;
  try {
    const key = createPublicKey({ key: publicJwk, format: "jwk" });
    return cryptoVerify("sha256", bytes, { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signatureBase64url, "base64url"));
  } catch {
    return false;
  }
}

export function publicJwkOf(jwk) {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

const bytesOf = (value) => Buffer.from(canonicalJson(value), "utf8");
/** Timestamps compare as instants (RFC 3339), never as strings: "…Z" and "….000Z" are the same moment. */
const instant = (text) => {
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new Error(`not an RFC 3339 timestamp: ${text}`);
  return ms;
};

/** The synthetic trusted document a runtime starts from: the pinned root key alone, in the root role. */
export function trustedRootFromPinnedKey({ purpose, environment, pinnedRootJwk }) {
  const keyId = jwkThumbprint(pinnedRootJwk);
  return {
    signed: {
      type: "root",
      protocol: "0.0.0",
      purpose,
      environment,
      version: 0,
      expires: "9999-12-31T23:59:59Z",
      keys: { [keyId]: { keyType: "ecdsa-p256", scheme: "ES256", publicKey: publicJwkOf(pinnedRootJwk) } },
      roles: { root: { keyIds: [keyId], threshold: 1 }, targets: { keyIds: [], threshold: 1 } },
    },
    signatures: [],
  };
}

function countValidSignatures(bytes, signatures, keyIds, keys) {
  const seen = new Set();
  let valid = 0;
  for (const signature of signatures) {
    if (!keyIds.includes(signature.keyId) || seen.has(signature.keyId)) continue;
    const key = keys[signature.keyId];
    if (!key) continue;
    if (verifyBytes(bytes, signature.sig, key.publicKey)) {
      seen.add(signature.keyId);
      valid += 1;
    }
  }
  return valid;
}

/** R1–R5. Returns { ok: true } or { ok: false, reason }. */
export function verifyRootMetadata({ candidate, trusted, now }) {
  const signed = candidate.signed;
  if (signed.purpose !== trusted.signed.purpose || signed.environment !== trusted.signed.environment) {
    return { ok: false, reason: "root_scope_mismatch" };
  }
  for (const [keyId, key] of Object.entries(signed.keys)) {
    if (jwkThumbprint(key.publicKey) !== keyId) return { ok: false, reason: "key_id_mismatch" };
  }
  if (signed.version < trusted.signed.version) return { ok: false, reason: "root_rollback" };
  if (signed.version === trusted.signed.version && canonicalJson(signed) !== canonicalJson(trusted.signed)) {
    return { ok: false, reason: "root_rollback" };
  }
  const role = trusted.signed.roles.root;
  if (countValidSignatures(bytesOf(signed), candidate.signatures, role.keyIds, trusted.signed.keys) < role.threshold) {
    return { ok: false, reason: "root_signature_invalid" };
  }
  if (!(instant(signed.expires) > instant(now))) return { ok: false, reason: "root_expired" };
  return { ok: true };
}

const SUPPORTED_PROTOCOL_MAJORS = new Set([0]);
/** M13 (S4): the directive kinds a runtime honours. */
const DIRECTIVE_KINDS = new Set(["request_unlock", "disable"]);

/** S16: every experiment a manifest carries — experiments[] (one per slot), else the legacy single one. */
export function experimentsOf(payload) {
  if (Array.isArray(payload.experiments)) return payload.experiments;
  return payload.experiment ? [payload.experiment] : [];
}

/**
 * M15 (S16): the per-prompt shape is consistent — never both keys; every experiments[] entry names a slot of the
 * release, no slot twice; each arm's overrides name that slot only; an arm-scoped disable names one of the experiments.
 * Null when it holds; the reason otherwise.
 */
export function experimentConflict(payload) {
  const hasLegacy = payload.experiment !== undefined && payload.experiment !== null;
  const list = payload.experiments;
  if (list === undefined || list === null) return null;
  if (hasLegacy) return "experiment_conflict";
  if (!Array.isArray(list) || list.length === 0) return "experiment_conflict";
  const slotTags = new Set((payload.slots ?? []).map((slot) => slot.tag));
  const seen = new Set();
  const ids = new Set();
  for (const experiment of list) {
    if (!experiment || typeof experiment !== "object" || typeof experiment.tag !== "string") return "experiment_conflict";
    if (!slotTags.has(experiment.tag) || seen.has(experiment.tag)) return "experiment_conflict";
    seen.add(experiment.tag);
    ids.add(experiment.experimentId);
    for (const arm of experiment.arms ?? []) for (const override of arm.overrides ?? []) if (override.tag !== experiment.tag) return "experiment_conflict";
  }
  for (const directive of payload.directives ?? []) {
    if (directive && directive.kind === "disable" && directive.scope === "arm" && !ids.has(directive.experimentId)) return "experiment_conflict";
  }
  return null;
}

function referencedHashes(payload) {
  const hashes = new Map();
  const add = (slot) => {
    hashes.set(slot.contentHash, slot.byteLength);
    for (const step of slot.steps ?? []) hashes.set(step.contentHash, step.byteLength);
    if (slot.goldenSet) hashes.set(slot.goldenSet.contentHash, slot.goldenSet.byteLength);
  };
  for (const slot of payload.slots) add(slot);
  for (const experiment of experimentsOf(payload)) for (const arm of experiment.arms ?? []) for (const override of arm.overrides) add(override);
  return hashes;
}

function keyUsableAt(key, now) {
  const at = instant(now);
  if (key.notBefore && !(instant(key.notBefore) <= at)) return false;
  if (key.notAfter && !(at < instant(key.notAfter))) return false;
  return true;
}

/**
 * M1–M12. `root` is the trusted, accepted root document; `countersignRoot`
 * the customer's, when the target requires countersign. `payloads` is a Map
 * of contentHash → bytes for whatever the runtime has fetched; pass null to
 * skip M9/M10 (a runtime verifies the envelope before fetching).
 */
export function verifyManifest({
  manifest,
  root,
  now,
  scope,
  storedGeneration,
  payloads = null,
  countersignRoot = null,
  requireCountersign = false,
}) {
  const payload = manifest.payload;
  if (!(instant(root.signed.expires) > instant(now))) return { ok: false, reason: "root_expired" };
  const major = Number(payload.protocol.split(".")[0]);
  if (!SUPPORTED_PROTOCOL_MAJORS.has(major)) return { ok: false, reason: "protocol_unsupported" };

  const targets = root.signed.roles.targets;
  const named = manifest.signatures.filter((signature) => targets.keyIds.includes(signature.keyId) && root.signed.keys[signature.keyId]);
  if (named.length === 0) return { ok: false, reason: "unknown_signing_key" };
  const usable = named.filter((signature) => keyUsableAt(root.signed.keys[signature.keyId], now));
  if (usable.length === 0) return { ok: false, reason: "signing_key_expired" };
  const valid = countValidSignatures(bytesOf(payload), usable, targets.keyIds, root.signed.keys);
  if (valid === 0) return { ok: false, reason: "signature_invalid" };
  if (valid < targets.threshold) return { ok: false, reason: "signature_threshold" };

  if (payload.organizationId !== scope.organizationId || payload.agentId !== scope.agentId || payload.target !== scope.target) {
    return { ok: false, reason: "scope_mismatch" };
  }
  if (payload.generation < storedGeneration) return { ok: false, reason: "generation_rollback" };
  // M13 (S4): the directive kinds a runtime honours are a closed set; an unknown one refuses the whole manifest.
  if (!Array.isArray(payload.directives) || payload.directives.some((d) => !d || typeof d !== "object" || !DIRECTIVE_KINDS.has(d.kind))) {
    return { ok: false, reason: "directive_unknown" };
  }
  // M15 (S16): the per-prompt shape is consistent, or the manifest is refused whole before any payload.
  const conflict = experimentConflict(payload);
  if (conflict) return { ok: false, reason: conflict };

  if (payloads) {
    for (const [hash, byteLength] of referencedHashes(payload)) {
      const bytes = payloads.get(hash);
      if (bytes === undefined) return { ok: false, reason: "payload_missing" };
      if (bytes.length !== byteLength || sha256Prefixed(bytes) !== hash) return { ok: false, reason: "payload_hash_mismatch" };
    }
  }

  if (payload.requireCountersign || requireCountersign) {
    const digests = new Set([payload.releaseDigest, ...experimentsOf(payload).flatMap((experiment) => (experiment.arms ?? []).map((arm) => arm.releaseDigest))]);
    const role = countersignRoot?.signed.roles.targets ?? { keyIds: [], threshold: 1 };
    const keys = countersignRoot?.signed.keys ?? {};
    for (const digest of digests) {
      const candidates = (manifest.countersignatures ?? []).filter(
        (c) => c.releaseDigest === digest && role.keyIds.includes(c.keyId) && keys[c.keyId],
      );
      if (candidates.length === 0) return { ok: false, reason: "countersign_missing" };
      if (countValidSignatures(Buffer.from(digest, "utf8"), candidates, role.keyIds, keys) < role.threshold) {
        return { ok: false, reason: "countersign_invalid" };
      }
    }
  }
  return { ok: true, signingKeyId: usable[0].keyId, generation: payload.generation };
}
