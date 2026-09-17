/**
 * The trust chain (`protocol/trust-chain.md`): thumbprints, ES256 over
 * canonical bytes, root-metadata acceptance R1–R5 and manifest verification
 * M1–M12. Pure over its inputs; `now` is always passed in. This is what
 * decides whether bytes go live, so it never reads the network or the disk.
 *
 * @example
 * ```ts
 * const root = trustedRootFromPinnedKey({ purpose: "platform", environment: "prod", pinnedRoot: PINNED_ROOT_JWK });
 * const rootVerdict = verifyRootMetadata({ candidate: fetchedRoot, trusted: root, now }); // R1–R5; a newer root replaces the pinned one
 * const verdict = verifyManifest({ manifest, root: rootVerdict.ok ? fetchedRoot : root, now, scope, storedGeneration: 3, payloads });
 * if (!verdict.ok) refuse(verdict.reason); // "signature_invalid" | "scope_mismatch" | "generation_rollback" | "payload_hash_mismatch" | …
 * ```
 */

import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

import { isAssignmentError, validateRamp } from "./assignment.js";
import { canonicalBytes, canonicalJson, sha256Prefixed } from "./canonicalJson.js";
import { DIRECTIVE_KINDS, experimentConflict, experimentsOf, type Manifest, type ManifestPayload, type ManifestSlot, type P256PrivateJwk, type P256PublicJwk, type RefusalCode, type RootMetadata, type RootMetadataSigned, type Signature, type SlotInference, type Target } from "./types.js";

export const SUPPORTED_PROTOCOL_MAJORS: ReadonlySet<number> = new Set([0]);

/** RFC 7638: sha256 over canonical {crv, kty, x, y}, lowercase hex. */
export function keyThumbprint(jwk: P256PublicJwk): string {
  return createHash("sha256").update(canonicalJson({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }), "utf8").digest("hex");
}

export function publicJwkOf(jwk: P256PublicJwk | P256PrivateJwk): P256PublicJwk {
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

/** ES256, P1363 r‖s, base64url without padding. Local keys only (the platform signs in KMS). */
export function signBytes(bytes: Uint8Array, privateJwk: P256PrivateJwk): string {
  const key = createPrivateKey({ key: privateJwk as unknown as import("node:crypto").JsonWebKey, format: "jwk" });
  return cryptoSign("sha256", bytes, { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
}

export function verifyBytes(bytes: Uint8Array, signature: string, publicJwk: P256PublicJwk): boolean {
  // P1363 r‖s is 64 bytes, exactly 86 base64url characters unpadded; any other length is not an ES256 signature and never reaches the verifier.
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try {
    const key = createPublicKey({ key: publicJwk as unknown as import("node:crypto").JsonWebKey, format: "jwk" });
    return cryptoVerify("sha256", bytes, { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

/** Timestamps compare as instants (RFC 3339), never as strings. */
export function instant(text: string): number {
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new Error(`not an RFC 3339 timestamp: ${text}`);
  return ms;
}

/** The synthetic trusted document a runtime starts from: the pinned root key alone, in the root role. */
export function trustedRootFromPinnedKey(input: { purpose: "platform" | "countersign"; environment: Target; pinnedRoot: P256PublicJwk }): RootMetadata {
  const keyId = keyThumbprint(input.pinnedRoot);
  return {
    signed: {
      type: "root",
      protocol: "0.0.0",
      purpose: input.purpose,
      environment: input.environment,
      version: 0,
      expires: "9999-12-31T23:59:59Z",
      keys: { [keyId]: { keyType: "ecdsa-p256", scheme: "ES256", publicKey: publicJwkOf(input.pinnedRoot) } },
      roles: { root: { keyIds: [keyId], threshold: 1 }, targets: { keyIds: [], threshold: 1 } },
    },
    signatures: [],
  };
}

function countValidSignatures(bytes: Uint8Array, signatures: readonly Signature[], keyIds: readonly string[], keys: RootMetadataSigned["keys"]): number {
  const seen = new Set<string>();
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

export type Verdict<T = object> = ({ ok: true } & T) | { ok: false; reason: RefusalCode };

/** R1–R5. */
export function verifyRootMetadata(input: { candidate: RootMetadata; trusted: RootMetadata; now: string }): Verdict {
  const signed = input.candidate.signed;
  const trusted = input.trusted.signed;
  if (signed.purpose !== trusted.purpose || signed.environment !== trusted.environment) return { ok: false, reason: "root_scope_mismatch" };
  for (const [keyId, key] of Object.entries(signed.keys)) {
    if (keyThumbprint(key.publicKey) !== keyId) return { ok: false, reason: "key_id_mismatch" };
  }
  if (signed.version < trusted.version) return { ok: false, reason: "root_rollback" };
  if (signed.version === trusted.version && canonicalJson(signed) !== canonicalJson(trusted)) return { ok: false, reason: "root_rollback" };
  const role = trusted.roles.root;
  if (countValidSignatures(canonicalBytes(signed), input.candidate.signatures, role.keyIds, trusted.keys) < role.threshold) {
    return { ok: false, reason: "root_signature_invalid" };
  }
  if (!(instant(signed.expires) > instant(input.now))) return { ok: false, reason: "root_expired" };
  return { ok: true };
}

/** Every content hash a manifest references, with the declared length: slots, steps, arm overrides. */
export function referencedPayloads(payload: ManifestPayload): Map<string, number> {
  const hashes = new Map<string, number>();
  const add = (slot: ManifestSlot) => {
    hashes.set(slot.contentHash, slot.byteLength);
    for (const step of slot.steps ?? []) hashes.set(step.contentHash, step.byteLength);
    if (slot.goldenSet) hashes.set(slot.goldenSet.contentHash, slot.goldenSet.byteLength);
  };
  for (const slot of payload.slots) add(slot);
  for (const experiment of experimentsOf(payload)) for (const arm of experiment.arms) for (const override of arm.overrides) add(override);
  return hashes;
}

function keyUsableAt(key: RootMetadataSigned["keys"][string], now: string): boolean {
  const at = instant(now);
  if (key.notBefore && !(instant(key.notBefore) <= at)) return false;
  if (key.notAfter && !(at < instant(key.notAfter))) return false;
  return true;
}

export interface VerifyManifestInput {
  manifest: Manifest;
  root: RootMetadata;
  now: string;
  scope: { organizationId: string; agentId: string; target: Target };
  storedGeneration: number;
  /** contentHash → bytes for whatever was fetched; null skips M9/M10 (verify the envelope before fetching). */
  payloads?: ReadonlyMap<string, Uint8Array> | null;
  countersignRoot?: RootMetadata | null;
  /** The local side may be stricter than the manifest. */
  requireCountersign?: boolean;
}

/** M1–M14. */
export function verifyManifest(input: VerifyManifestInput): Verdict<{ signingKeyId: string; generation: number }> {
  const { manifest, root } = input;
  const payload = manifest.payload;
  if (!(instant(root.signed.expires) > instant(input.now))) return { ok: false, reason: "root_expired" };
  const major = Number(payload.protocol.split(".")[0]);
  if (!SUPPORTED_PROTOCOL_MAJORS.has(major)) return { ok: false, reason: "protocol_unsupported" };

  const targets = root.signed.roles.targets;
  const named = manifest.signatures.filter((signature) => targets.keyIds.includes(signature.keyId) && root.signed.keys[signature.keyId]);
  if (named.length === 0) return { ok: false, reason: "unknown_signing_key" };
  const usable = named.filter((signature) => keyUsableAt(root.signed.keys[signature.keyId]!, input.now));
  if (usable.length === 0) return { ok: false, reason: "signing_key_expired" };
  const valid = countValidSignatures(canonicalBytes(payload), usable, targets.keyIds, root.signed.keys);
  if (valid === 0) return { ok: false, reason: "signature_invalid" };
  if (valid < targets.threshold) return { ok: false, reason: "signature_threshold" };

  if (payload.organizationId !== input.scope.organizationId || payload.agentId !== input.scope.agentId || payload.target !== input.scope.target) {
    return { ok: false, reason: "scope_mismatch" };
  }
  if (payload.generation < input.storedGeneration) return { ok: false, reason: "generation_rollback" };
  // M13 (S4): the kinds a runtime honours are a closed set; one it does not know refuses the whole manifest before a byte is fetched.
  if (!Array.isArray(payload.directives) || payload.directives.some((directive) => !directive || typeof directive !== "object" || !DIRECTIVE_KINDS.has((directive as { kind?: unknown }).kind as string))) {
    return { ok: false, reason: "directive_unknown" };
  }
  // M15 (S16): the per-prompt shape is consistent, or the manifest is refused whole before any payload.
  const conflict = experimentConflict(payload);
  if (conflict) return { ok: false, reason: conflict };
  // M14 (S9): every experiment's ramp plan, when present, is well-formed — a malformed one is refused whole rather than walked wrongly.
  for (const experiment of experimentsOf(payload)) {
    if (experiment.ramp === undefined) continue;
    try {
      validateRamp(experiment.ramp, experiment.arms.length);
    } catch (error) {
      if (isAssignmentError(error) && error.reason === "ramp_invalid") return { ok: false, reason: "ramp_invalid" };
      throw error;
    }
  }

  if (input.payloads) {
    for (const [hash, byteLength] of referencedPayloads(payload)) {
      const bytes = input.payloads.get(hash);
      if (bytes === undefined) return { ok: false, reason: "payload_missing" };
      if (bytes.length !== byteLength || sha256Prefixed(bytes) !== hash) return { ok: false, reason: "payload_hash_mismatch" };
    }
  }

  if (payload.requireCountersign || input.requireCountersign) {
    const digests = new Set<string>([payload.releaseDigest, ...experimentsOf(payload).flatMap((experiment) => experiment.arms.map((arm) => arm.releaseDigest))]);
    const role = input.countersignRoot?.signed.roles.targets ?? { keyIds: [], threshold: 1 };
    const keys = input.countersignRoot?.signed.keys ?? {};
    for (const digest of digests) {
      const candidates = (manifest.countersignatures ?? []).filter((c) => c.releaseDigest === digest && role.keyIds.includes(c.keyId) && keys[c.keyId]);
      if (candidates.length === 0) return { ok: false, reason: "countersign_missing" };
      if (countValidSignatures(Buffer.from(digest, "utf8"), candidates, role.keyIds, keys) < role.threshold) return { ok: false, reason: "countersign_invalid" };
    }
  }
  return { ok: true, signingKeyId: usable[0]!.keyId, generation: payload.generation };
}

export const INFERENCE_DIGEST_KEYS = ["maxOutputTokens", "reasoningEffort", "stopSequences", "temperatureMilli", "topPBps"] as const satisfies readonly (keyof SlotInference)[];

/** The inference block as the digest covers it: the known keys, each only when set (a JSON null is unset; canonical JSON sorts them). */
export function inferenceDigestInput(inference: SlotInference): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of INFERENCE_DIGEST_KEYS) {
    const value = inference[key];
    if (value === undefined || value === null) continue;
    out[key] = key === "stopSequences" ? [...(value as readonly string[])] : value;
  }
  return out;
}

/** The digest input: pins sorted by tag, projected to exactly the covered members (canonical-json.md). */
export function releaseDigestInput(slots: readonly ManifestSlot[]): unknown[] {
  return [...slots]
    .sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
    .map((slot) => ({
      tag: slot.tag,
      kind: slot.kind,
      artifactId: slot.artifactId,
      versionId: slot.versionId,
      versionOrdinal: slot.versionOrdinal,
      contentHash: slot.contentHash,
      byteLength: slot.byteLength,
      model: slot.model,
      ...(slot.modelRequired === true ? { modelRequired: true } : {}),
      ...(Array.isArray(slot.outputChecks) && slot.outputChecks.length > 0 ? { outputChecks: slot.outputChecks } : {}),
      ...(slot.goldenSet ? { goldenSet: { setId: slot.goldenSet.setId, cases: slot.goldenSet.cases, contentHash: slot.goldenSet.contentHash, byteLength: slot.goldenSet.byteLength, minPassBps: slot.goldenSet.minPassBps } } : {}),
      ...(slot.inference ? { inference: inferenceDigestInput(slot.inference) } : {}),
      // 0.3.4: `default` and `source` ride the digest only when the pin carries them, so a slot without them keeps its digest.
      variables: slot.variables.map((v) => ({ name: v.name, required: v.required, trust: v.trust, ...(v.default !== undefined && v.default !== null ? { default: v.default } : {}), ...(v.source !== undefined && v.source !== null ? { source: v.source } : {}) })),
      ...(slot.steps
        ? { steps: slot.steps.map((s) => ({ stepId: s.stepId, ordinal: s.ordinal, promptArtifactId: s.promptArtifactId, promptVersionId: s.promptVersionId, contentHash: s.contentHash, byteLength: s.byteLength, ...(s.inference ? { inference: inferenceDigestInput(s.inference) } : {}) })) }
        : {}),
    }));
}

export function releaseDigest(slots: readonly ManifestSlot[]): `sha256:${string}` {
  return sha256Prefixed(canonicalBytes(releaseDigestInput(slots)));
}
