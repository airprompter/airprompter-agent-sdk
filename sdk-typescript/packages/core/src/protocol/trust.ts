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

import { capabilitiesImplemented, isAssignmentError, servableExperiments, servableSlots, validateRamp, validAudienceManifest } from "./assignment.js";
import { canonicalBytes, canonicalJson, sha256Prefixed } from "./canonicalJson.js";
import { DIRECTIVE_KINDS, experimentConflict, type HostedEnvironment, type Manifest, type ManifestPayload, type ManifestSlot, type P256PrivateJwk, type P256PublicJwk, type RefusalCode, type RootMetadata, type RootMetadataSigned, type Signature, type SlotInference, type Target } from "./types.js";

export const SUPPORTED_PROTOCOL_MAJORS: ReadonlySet<number> = new Set([3]);
const PROTOCOL_SHAPE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

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
export function trustedRootFromPinnedKey(input: ({ purpose: "platform"; environment: HostedEnvironment } | { purpose: "countersign"; environment: Target }) & { pinnedRoot: P256PublicJwk }): RootMetadata {
  const keyId = keyThumbprint(input.pinnedRoot);
  return {
    signed: {
      type: "root",
      protocol: "0.0.0",
      ...(input.purpose === "platform" ? { purpose: input.purpose, environment: input.environment } : { purpose: input.purpose, environment: input.environment }),
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

/** `directivesStand`: refused, but its signature, scope and generation verified, so its disables reach this host (`capabilities.md`). */
export type Verdict<T = object> = ({ ok: true } & T) | { ok: false; reason: RefusalCode; directivesStand?: true };

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

/** Every hash one slot or override names, with its declared length: main, steps and golden set. */
export function slotHashes(entry: ManifestSlot): Map<string, number> {
  const hashes = new Map<string, number>();
  const add = (pin: { contentHash?: unknown; byteLength?: unknown } | undefined) => {
    if (pin && typeof pin.contentHash === "string") hashes.set(pin.contentHash, pin.byteLength as number);
  };
  add(entry);
  for (const step of Array.isArray(entry.steps) ? entry.steps : []) add(step);
  add(entry.goldenSet);
  return hashes;
}

/** Every content hash a manifest references, with the declared length: servable slots, their steps, arm overrides. */
export function referencedPayloads(payload: ManifestPayload): Map<string, number> {
  const hashes = new Map<string, number>();
  const add = (slot: ManifestSlot) => {
    for (const [hash, byteLength] of slotHashes(slot)) hashes.set(hash, byteLength);
  };
  for (const slot of servableSlots(payload)) add(slot);
  for (const experiment of servableExperiments(payload)) for (const arm of experiment.arms) for (const override of arm.overrides) add(override);
  return hashes;
}

const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;

/** A well-formed `{contentHash, byteLength}` pair, or null. */
function pairOf(value: object): [string, number] | null {
  const { contentHash, byteLength } = value as { contentHash?: unknown; byteLength?: unknown };
  return typeof contentHash === "string" && CONTENT_HASH.test(contentHash) && typeof byteLength === "number" && Number.isSafeInteger(byteLength) && byteLength >= 0 ? [contentHash, byteLength] : null;
}

/**
 * Every `{contentHash, byteLength}` pair anywhere under a manifest payload, whatever holds it. Pull paths only: a
 * puller carries a release for runtimes that may know more than it does, so it fetches what a newer runtime needs
 * (a `slot.variants[*].pin`, an open slot) without being able to read it. A runtime reads `referencedPayloads`.
 */
export function carriedPayloads(payload: ManifestPayload): Map<string, number> {
  const hashes = new Map<string, number>();
  const pending: unknown[] = [payload];
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    const pair = pairOf(value);
    if (pair) hashes.set(pair[0], pair[1]);
    for (const member of Object.values(value)) pending.push(member);
  }
  return hashes;
}

/**
 * The hashes named only under a slot or an arm override carrying `requires`, by the same walk: the only payloads a store
 * or a carrier may go without (M9). A hash named anywhere else is required, so a `requires` slot sharing it cannot excuse
 * it, and a `requires` anywhere but those two positions excuses nothing.
 */
export function optionalPayloads(payload: ManifestPayload): Set<string> {
  const positions = new Set<unknown>(Array.isArray(payload.slots) ? payload.slots : []);
  for (const experiment of Array.isArray(payload.experiments) ? payload.experiments : []) {
    for (const arm of Array.isArray(experiment?.arms) ? experiment.arms : []) {
      for (const override of Array.isArray(arm?.overrides) ? arm.overrides : []) positions.add(override);
    }
  }
  const plain = new Set<string>();
  const underRequires = new Set<string>();
  const pending: Array<[unknown, boolean]> = [[payload, false]];
  while (pending.length > 0) {
    const [value, under] = pending.pop()!;
    if (!value || typeof value !== "object") continue;
    const inside = under || (positions.has(value) && (value as { requires?: unknown }).requires !== undefined);
    const pair = pairOf(value);
    if (pair) (inside ? underRequires : plain).add(pair[0]);
    for (const member of Object.values(value)) pending.push([member, inside]);
  }
  return new Set([...underRequires].filter((hash) => !plain.has(hash)));
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
  /**
   * A pull path's check: no capability refusal and no servable filter, so a puller carries a release it cannot read
   * itself. M9 and M10 run over `carriedPayloads`. The runtime that opens the bundle verifies it again, in full.
   */
  carrying?: boolean;
  /** M9 may go without `optionalPayloads`. A store and a carrier pass it; every other caller keeps strict M9. */
  absentRequires?: boolean;
}

/** M1–M14. */
export function verifyManifest(input: VerifyManifestInput): Verdict<{ signingKeyId: string; generation: number }> {
  const { manifest, root } = input;
  const payload = manifest.payload;
  if (!(instant(root.signed.expires) > instant(input.now))) return { ok: false, reason: "root_expired" };
  const version = typeof payload.protocol === "string" ? PROTOCOL_SHAPE.exec(payload.protocol) : null;
  if (!version || !SUPPORTED_PROTOCOL_MAJORS.has(Number(version[1]))) return { ok: false, reason: "protocol_unsupported" };
  if (payload.requiredCapabilities !== undefined && !Array.isArray(payload.requiredCapabilities)) return { ok: false, reason: "protocol_unsupported" };
  // A manifest asking for a capability this SDK lacks may use shapes it cannot read, so only the envelope is checked.
  const capable = capabilitiesImplemented(payload);
  if (capable && !validAudienceManifest(payload)) return { ok: false, reason: "protocol_unsupported" };

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
  if (!capable && !input.carrying) return { ok: false, reason: "protocol_unsupported", directivesStand: true };
  // What this SDK cannot read, it cannot judge: a carrier leaves M13 to M15 of such a manifest to the runtime.
  if (capable) {
    // M13 (S4): the kinds a runtime honours are a closed set; one it does not know refuses the whole manifest before a byte is fetched.
    if (!Array.isArray(payload.directives) || payload.directives.some((directive) => !directive || typeof directive !== "object" || !DIRECTIVE_KINDS.has((directive as { kind?: unknown }).kind as string))) {
      return { ok: false, reason: "directive_unknown" };
    }
    // M15 (S16): the per-prompt shape is consistent, or the manifest is refused whole before any payload.
    const conflict = experimentConflict(payload);
    if (conflict) return { ok: false, reason: conflict };
    // M14 (S9): every experiment's ramp plan, when present, is well-formed — a malformed one is refused whole rather than walked wrongly.
    for (const experiment of servableExperiments(payload)) {
      if (experiment.ramp === undefined) continue;
      try {
        validateRamp(experiment.ramp, experiment.arms.length);
      } catch (error) {
        if (isAssignmentError(error) && error.reason === "ramp_invalid") return { ok: false, reason: "ramp_invalid" };
        throw error;
      }
    }
  }

  if (input.payloads) {
    const optional = input.absentRequires ? optionalPayloads(payload) : new Set<string>();
    for (const [hash, byteLength] of input.carrying ? carriedPayloads(payload) : referencedPayloads(payload)) {
      const bytes = input.payloads.get(hash);
      if (bytes === undefined) {
        if (optional.has(hash)) continue;
        return { ok: false, reason: "payload_missing" };
      }
      if (bytes.length !== byteLength || sha256Prefixed(bytes) !== hash) return { ok: false, reason: "payload_hash_mismatch" };
    }
  }

  if (payload.requireCountersign || input.requireCountersign) {
    const digests = new Set<string>([payload.releaseDigest, ...servableExperiments(payload).flatMap((experiment) => (Array.isArray(experiment.arms) ? experiment.arms.map((arm) => arm.releaseDigest) : []))]);
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
    .map((slot) => {
      const pin = {
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
        // `default` and `source` ride the digest only when the pin carries them, so a slot without them keeps its digest.
        variables: slot.variables?.map((v) => ({ name: v.name, required: v.required, trust: v.trust, ...(v.default !== undefined && v.default !== null ? { default: v.default } : {}), ...(v.source !== undefined && v.source !== null ? { source: v.source } : {}) })),
        ...(slot.requires !== undefined && slot.requires !== null ? { requires: slot.requires } : {}),
        ...(slot.steps
          ? { steps: slot.steps.map((s) => ({ stepId: s.stepId, ordinal: s.ordinal, promptArtifactId: s.promptArtifactId, promptVersionId: s.promptVersionId, contentHash: s.contentHash, byteLength: s.byteLength, ...(s.inference ? { inference: inferenceDigestInput(s.inference) } : {}) })) }
          : {}),
      };
      // An open slot projects the members it has: `canonical-json.md`.
      return Object.fromEntries(Object.entries(pin).filter(([, value]) => value !== undefined));
    });
}

export function releaseDigest(slots: readonly ManifestSlot[]): `sha256:${string}` {
  return sha256Prefixed(canonicalBytes(releaseDigestInput(slots)));
}
