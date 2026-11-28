// A release as the conformance suite writes it, sealed into plaintext bundles
// (`protocol/schemas/bundle.schema.json`) the SDK under test opens with
// `applyBundle` on an offline agent. The harness seals, so both languages are
// handed the same bytes: the same artifact ids, digests and salts, and so the
// same arms. The keys are fresh per run and never leave the process.
//
//   const sealer = newSealer({ organizationId, agentId, target });
//   const bundle = sealer.seal(release, { nowMs });          // generation 1, 2, … per call
//   adapter: root = { pinned: sealer.rootPublicJwk }, then applyBundle(bundle)
//
// A release (`vector.schema.json#/$defs/release`):
//   { slots: [{ tag, text, versionId?, model?, variables?, inference?, steps? }],
//     experiments?: [{ experimentId, tag, salt, subjectKey?, audience?, ramp?, arms: [{ arm, weightBps, overrides?: [slot] }] }],
//     observations?, directives?, applyPolicy? }

import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, releaseDigest, sha256Prefixed } from "../reference.mjs";
import { jwkThumbprint, publicJwkOf, signBytes } from "../trust.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** The protocol version the bundles are sealed under: `../protocol/VERSION` in this repository, `./protocol/VERSION` in the package. */
function protocolVersion() {
  for (const candidate of [join(here, "..", "..", "protocol", "VERSION"), join(here, "..", "protocol", "VERSION")]) {
    try {
      return readFileSync(candidate, "utf8").trim();
    } catch {
      // the other layout
    }
  }
  throw new Error("no protocol/VERSION next to the harness");
}

function newKey() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d };
}

const bytesOf = (value) => Buffer.from(canonicalJson(value), "utf8");
const iso = (ms) => new Date(ms).toISOString();

/** A slot as the manifest carries it, its bytes added to `payloads`. */
function manifestSlot(spec, payloads) {
  const bytes = Buffer.from(spec.text, "utf8");
  const contentHash = sha256Prefixed(bytes);
  payloads.set(contentHash, bytes);
  const slot = {
    tag: spec.tag,
    kind: spec.steps ? "workflow" : "prompt",
    artifactId: spec.artifactId ?? `art_${spec.tag.replace(/[^A-Za-z0-9_-]/g, "_")}`,
    versionId: spec.versionId ?? `ver_${spec.tag.replace(/[^A-Za-z0-9_-]/g, "_")}_1`,
    versionOrdinal: spec.versionOrdinal ?? 1,
    contentHash,
    byteLength: bytes.length,
    model: spec.model ?? "claude-sonnet-5",
    variables: spec.variables ?? [],
    ...(spec.inference ? { inference: spec.inference } : {}),
  };
  if (spec.steps) {
    slot.steps = spec.steps.map((step, index) => {
      const stepBytes = Buffer.from(step.text, "utf8");
      const stepHash = sha256Prefixed(stepBytes);
      payloads.set(stepHash, stepBytes);
      return { stepId: `${spec.tag}#${index + 1}`, ordinal: index + 1, promptArtifactId: `${slot.artifactId}_${index + 1}`, promptVersionId: step.versionId ?? `${slot.versionId}_step${index + 1}`, contentHash: stepHash, byteLength: stepBytes.length };
    });
  }
  return slot;
}

export function newSealer(scope, { hostedEnvironment = "prod" } = {}) {
  const rootKey = newKey();
  const signingKey = newKey();
  const protocol = protocolVersion();
  const rootId = jwkThumbprint(rootKey);
  const signingId = jwkThumbprint(signingKey);
  const signed = {
    type: "root",
    protocol,
    purpose: "platform",
    environment: hostedEnvironment,
    version: 1,
    expires: "2099-12-31T00:00:00Z",
    keys: {
      [rootId]: { keyType: "ecdsa-p256", scheme: "ES256", publicKey: publicJwkOf(rootKey) },
      [signingId]: { keyType: "ecdsa-p256", scheme: "ES256", publicKey: publicJwkOf(signingKey) },
    },
    roles: { root: { keyIds: [rootId], threshold: 1 }, targets: { keyIds: [signingId], threshold: 1 } },
  };
  const root = { signed, signatures: [{ keyId: rootId, alg: "ES256", sig: signBytes(bytesOf(signed), rootKey) }] };
  let generation = 0;
  return {
    rootPublicJwk: publicJwkOf(rootKey),
    root,
    /** Seal the next generation of `release` at `nowMs`. */
    seal(release, { nowMs }) {
      generation += 1;
      const payloads = new Map();
      const slots = release.slots.map((spec) => manifestSlot(spec, payloads)).sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
      const experiments = (release.experiments ?? []).map((experiment) => {
        const arms = experiment.arms.map((arm) => {
          const overrides = (arm.overrides ?? []).map((spec) => manifestSlot(spec, payloads));
          const armSlots = slots.map((slot) => overrides.find((o) => o.tag === slot.tag) ?? slot);
          return { arm: arm.arm, weightBps: arm.weightBps, releaseDigest: releaseDigest(armSlots), overrides };
        });
        const { arms: _arms, ...rest } = experiment;
        return { subjectKey: "request", ...rest, arms };
      });
      const payload = {
        protocol,
        ...scope,
        generation,
        releaseDigest: releaseDigest(slots),
        issuedAt: iso(nowMs),
        leaseSeconds: 3600,
        applyPolicy: release.applyPolicy ?? "auto",
        requireCountersign: false,
        slots,
        ...(release.observations ? { observations: release.observations } : {}),
        ...(experiments.length ? { experiments } : {}),
        directives: (release.directives ?? []).map((directive) => ({ issuedAt: iso(nowMs), ...directive })),
      };
      const manifest = { payload, signatures: [{ keyId: signingId, alg: "ES256", sig: signBytes(bytesOf(payload), signingKey) }], countersignatures: [] };
      const contents = {
        createdAt: iso(nowMs),
        notAfter: iso(nowMs + 365 * 86_400_000),
        manifest,
        keySet: root,
        payloads: [...payloads].sort(([a], [b]) => (a < b ? -1 : 1)).map(([contentHash, bytes]) => ({ contentHash, byteLength: bytes.length, bytes: bytes.toString("base64url") })),
      };
      return { format: "apbundle", version: 1, protocol, encryption: { scheme: "none", contents } };
    },
  };
}
