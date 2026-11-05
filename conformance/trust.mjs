// Reference implementation of protocol/trust-chain.md: thumbprints, ES256
// over canonical bytes (P1363, base64url), root-metadata acceptance (R1–R5)
// and manifest verification (M1–M12). Written from the prose; checked
// against vectors/manifest-verify.json.
//
//   const trusted = trustedRootFromPinnedKey({ purpose: "platform", environment: "prod", pinnedRootJwk });
//   const accepted = verifyRootMetadata({ candidate: rootJson, trusted, now });            // { ok, reason? } per R1–R5
//   const verdict = verifyManifest({ manifest, root: rootJson, now, scope, storedGeneration, payloads });   // { ok, reason? } or { ok: true, signingKeyId, generation } per M1–M12

import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

import { audiencePredicate, canonicalJson, sha256Prefixed } from "./reference.mjs";

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

const SUPPORTED_PROTOCOL_MAJORS = new Set([3]);
/** capabilities.md: 3.0.0 registers none. */
const SUPPORTED_CAPABILITIES = new Set();
/** M13 (S4): the directive kinds a runtime honours. */
const DIRECTIVE_KINDS = new Set(["request_unlock", "disable"]);

const met = (entry) => entry?.requires === undefined || (Array.isArray(entry.requires) && entry.requires.every((capability) => SUPPORTED_CAPABILITIES.has(capability)));
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** trust-chain.md › Slots a reader cannot serve: a slot whose `requires` this reader lacks is absent. */
export function servableSlots(payload) {
  return (payload.slots ?? []).filter((slot) => isObject(slot) && met(slot));
}

/** Only the unmet override goes: the arm and its other overrides stay. */
export function servableOverrides(arm) {
  return Array.isArray(arm?.overrides) ? arm.overrides.filter((override) => isObject(override) && met(override)) : [];
}

/** An arm that loses the override of the experiment's own tag: the host sits that experiment out. */
const sitsOut = (experiment) => (experiment.subjectKey !== "request" && experiment.subjectKey !== "instance") || Array.isArray(experiment.arms) && experiment.arms.some((arm) => isObject(arm) && Array.isArray(arm.overrides) && arm.overrides.some((override) => isObject(override) && override.tag === experiment.tag && !met(override)));

/** The experiments a reader acts on: those naming a slot it can serve and that it does not sit out, each arm holding its servable overrides. */
export function servableExperiments(payload) {
  const tags = new Set(servableSlots(payload).map((slot) => slot.tag));
  return (Array.isArray(payload.experiments) ? payload.experiments : []).filter((experiment) => isObject(experiment) && tags.has(experiment.tag) && !sitsOut(experiment)).map((experiment) => (Array.isArray(experiment.arms) ? { ...experiment, arms: experiment.arms.map((arm) => (isObject(arm) ? { ...arm, overrides: servableOverrides(arm) } : arm)) } : experiment));
}

/** The tags whose experiment has every arm disabled and whose audience holds this run, read from the raw list: a host that sits one out stops too. */
export function frozenTags(payload, tags = {}) {
  const off = {};
  for (const directive of Array.isArray(payload.directives) ? payload.directives : []) if (directive?.kind === "disable" && directive.scope === "arm") (off[directive.experimentId] ??= []).push(directive.arm);
  return (Array.isArray(payload.experiments) ? payload.experiments : []).filter((experiment) => isObject(experiment) && Array.isArray(experiment.arms) && experiment.arms.length > 0 && experiment.arms.every((arm) => (off[experiment.experimentId] ?? []).includes(arm?.arm)) && (experiment.audience === undefined || audiencePredicate({ selector: experiment.audience?.selector, tags }).matches)).map((experiment) => experiment.tag).sort();
}

/**
 * M15 (S16): the per-prompt shape is consistent: every experiments[] entry names a slot of the release, no slot twice; each arm's overrides name that slot only; an arm-scoped disable names one of the experiments.
 * Null when it holds; the reason otherwise.
 */
export function experimentConflict(payload) {
  const disables = (payload.directives ?? []).filter((directive) => directive && directive.kind === "disable" && directive.scope === "arm");
  if (disables.some((directive) => typeof directive.experimentId !== "string")) return "experiment_conflict";
  const list = payload.experiments;
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list) || list.length === 0) return "experiment_conflict";
  const slotTags = new Set((payload.slots ?? []).map((slot) => slot?.tag));
  const seen = new Set();
  const ids = new Set();
  for (const experiment of list) {
    if (!experiment || typeof experiment !== "object" || typeof experiment.tag !== "string") return "experiment_conflict";
    if (!slotTags.has(experiment.tag) || seen.has(experiment.tag)) return "experiment_conflict";
    seen.add(experiment.tag);
    ids.add(experiment.experimentId);
    for (const arm of experiment.arms ?? []) for (const override of servableOverrides(arm)) if (override.tag !== experiment.tag) return "experiment_conflict";
  }
  return disables.every((directive) => ids.has(directive.experimentId)) ? null : "experiment_conflict";
}

function referencedHashes(payload) {
  const hashes = new Map();
  const add = (slot) => {
    hashes.set(slot.contentHash, slot.byteLength);
    for (const step of slot.steps ?? []) hashes.set(step.contentHash, step.byteLength);
    if (slot.goldenSet) hashes.set(slot.goldenSet.contentHash, slot.goldenSet.byteLength);
  };
  for (const slot of servableSlots(payload)) add(slot);
  for (const experiment of servableExperiments(payload)) for (const arm of experiment.arms ?? []) for (const override of arm.overrides) add(override);
  return hashes;
}

/** Every {contentHash, byteLength} pair anywhere under a payload: what a pull path carries. */
export function carriedHashes(payload) {
  const hashes = new Map();
  const pending = [payload];
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    const { contentHash, byteLength } = value;
    if (typeof contentHash === "string" && /^sha256:[0-9a-f]{64}$/.test(contentHash) && Number.isSafeInteger(byteLength) && byteLength >= 0) hashes.set(contentHash, byteLength);
    pending.push(...Object.values(value));
  }
  return hashes;
}

/** The hashes named only under a slot or an arm override carrying `requires`: all M9 may excuse, and only for a store or a carrier. */
export function optionalHashes(payload) {
  const positions = new Set(Array.isArray(payload.slots) ? payload.slots : []);
  for (const experiment of Array.isArray(payload.experiments) ? payload.experiments : []) {
    for (const arm of Array.isArray(experiment?.arms) ? experiment.arms : []) {
      for (const override of Array.isArray(arm?.overrides) ? arm.overrides : []) positions.add(override);
    }
  }
  const plain = new Set();
  const underRequires = new Set();
  const pending = [[payload, false]];
  while (pending.length > 0) {
    const [value, under] = pending.pop();
    if (!value || typeof value !== "object") continue;
    const inside = under || (positions.has(value) && value.requires !== undefined);
    const { contentHash, byteLength } = value;
    if (typeof contentHash === "string" && /^sha256:[0-9a-f]{64}$/.test(contentHash) && Number.isSafeInteger(byteLength) && byteLength >= 0) (inside ? underRequires : plain).add(contentHash);
    for (const member of Object.values(value)) pending.push([member, inside]);
  }
  return new Set([...underRequires].filter((hash) => !plain.has(hash)));
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
  carrying = false,
  absentRequires = false,
}) {
  const payload = manifest.payload;
  if (!(instant(root.signed.expires) > instant(now))) return { ok: false, reason: "root_expired" };
  const version = typeof payload.protocol === "string" ? /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(payload.protocol) : null;
  if (!version || !SUPPORTED_PROTOCOL_MAJORS.has(Number(version[1]))) return { ok: false, reason: "protocol_unsupported" };
  if (payload.requiredCapabilities !== undefined && !Array.isArray(payload.requiredCapabilities)) return { ok: false, reason: "protocol_unsupported" };
  const capable = (payload.requiredCapabilities ?? []).every((capability) => SUPPORTED_CAPABILITIES.has(capability));
  if (capable && !validAudiencePayload(payload)) return { ok: false, reason: "protocol_unsupported" };

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
  if (!capable && !carrying) return { ok: false, reason: "protocol_unsupported", directivesStand: true };
  // What this reader cannot read, it cannot judge: a carrier leaves such a manifest to the runtime.
  if (capable) {
    // M13 (S4): the directive kinds a runtime honours are a closed set; an unknown one refuses the whole manifest.
    if (!Array.isArray(payload.directives) || payload.directives.some((d) => !d || typeof d !== "object" || !DIRECTIVE_KINDS.has(d.kind))) {
      return { ok: false, reason: "directive_unknown" };
    }
    // M15 (S16): the per-prompt shape is consistent, or the manifest is refused whole before any payload.
    const conflict = experimentConflict(payload);
    if (conflict) return { ok: false, reason: conflict };
  }

  if (payloads) {
    const optional = absentRequires ? optionalHashes(payload) : new Set();
    for (const [hash, byteLength] of carrying ? carriedHashes(payload) : referencedHashes(payload)) {
      const bytes = payloads.get(hash);
      if (bytes === undefined) {
        if (optional.has(hash)) continue; // absent for a store or a carrier only (M9)
        return { ok: false, reason: "payload_missing" };
      }
      if (bytes.length !== byteLength || sha256Prefixed(bytes) !== hash) return { ok: false, reason: "payload_hash_mismatch" };
    }
  }

  if (payload.requireCountersign || requireCountersign) {
    const digests = new Set([payload.releaseDigest, ...servableExperiments(payload).flatMap((experiment) => (Array.isArray(experiment.arms) ? experiment.arms : []).map((arm) => arm.releaseDigest))]);
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

/** Independent audience envelope validation, before signature/payload fetch. */
function validAudiencePayload(p) {
  const object=v=>v!==null && typeof v === "object" && !Array.isArray(v);
  const keys=(v,allowed)=>Object.keys(v).every(k=>allowed.includes(k));
  const id=v=>typeof v === "string" && /^aud_[A-Za-z0-9_-]{22}$/.test(v);
  if (p.experiments !== undefined && !Array.isArray(p.experiments)) return false;
  if (!Array.isArray(p.slots) || (p.experiments??[]).some(e=>!object(e))) return false;
  if (p.observations !== undefined && (!Array.isArray(p.observations) || p.observations.length<1 || p.observations.length>8)) return false;
  if ((p.experiments??[]).length>32) return false;
  const served=servableSlots(p);
  const observations=(p.observations??[]).filter(o=>!object(o) || served.some(slot=>slot.tag===o.tag) || !p.slots.some(slot=>object(slot)&&slot.tag===o.tag));
  const experiments=servableExperiments(p);
  const seen=new Set();
  for (const o of observations) {
    if (!object(o) || !id(o.audienceId) || seen.has(o.audienceId) || !served.some(slot=>slot.tag===o.tag)) return false;
    if (typeof o.observeFrom!=="string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(o.observeFrom) || !Number.isFinite(Date.parse(o.observeFrom))) return false;
    const date=o.observeFrom.slice(0,10), midnight=Date.parse(date+"T00:00:00Z");
    if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0,10)!==date || Number(o.observeFrom.slice(11,13))>=24) return false;
    seen.add(o.audienceId);
  }
  return experiments.every(e=> {
    if (!Array.isArray(e.arms) || e.arms.length<2 || e.arms.length>8) return false;
    if (e.arms.some(arm=>!object(arm) || !Number.isInteger(arm.weightBps) || arm.weightBps<0 || arm.weightBps>10000 || typeof arm.arm!=="string" || arm.arm.length>32 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(arm.arm) || !Array.isArray(arm.overrides))) return false;
    if (e.arms.reduce((n,arm)=>n+arm.weightBps,0)!==10000 || new Set(e.arms.map(a=>a.arm)).size!==e.arms.length || e.arms[0].releaseDigest!==p.releaseDigest || e.arms[0].overrides.length!==0 || !e.arms.every(arm=>arm.overrides.length<=1)) return false;
    if (e.audience===undefined) return true;
    const a=e.audience;
    if (!object(a) || !id(a.audienceId)) return false;
    const o=observations.find(o=>o.audienceId===a.audienceId && o.tag===e.tag);
    return !!o && JSON.stringify(o.selector)===JSON.stringify(a.selector);
  });
}
