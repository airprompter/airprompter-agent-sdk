/**
 * `.apbundle` (`protocol/schemas/bundle.schema.json`): the OTA release,
 * serialized — manifest, every payload, the root document(s), a `notAfter`.
 * Encrypted to the target's X25519 distribution key by default; plaintext
 * is a `dev` opt-in. `open` runs the identical verification the sync path
 * runs, so a bundle is never a way around the trust chain.
 *
 * @example
 * ```ts
 * const bundle = createEncryptedBundle(contents, fleetPublicRaw); // contents: { createdAt, notAfter, manifest, keySet, payloads }
 * // On the target: the AAD binds the bundle to this agent and target, so one relabelled for another target does not open.
 * const opened = openBundle(bundle, { agentId, target: "prod" }, distributionKey);
 * const payloads = bundlePayloadBytes(opened); // contentHash → bytes, still to be verified against the manifest
 * ```
 */

import { createHash, type KeyObject } from "node:crypto";

import { canonicalJson } from "../protocol/canonicalJson.js";
import type { Bundle, BundleContents } from "../protocol/types.js";
import { AEAD_AES_256_GCM, openFrom, sealTo } from "./hpke.js";

export const APBUNDLE_INFO = "airprompter-apbundle-v1";

/** RFC 7638 thumbprint of an OKP JWK: sha256 over canonical {crv, kty, x}, hex. */
export function distributionKeyId(publicRaw: Uint8Array): string {
  return createHash("sha256").update(canonicalJson({ crv: "X25519", kty: "OKP", x: Buffer.from(publicRaw).toString("base64url") }), "utf8").digest("hex");
}

function bundleAad(contents: BundleContents): Buffer {
  return Buffer.from(`${contents.manifest.payload.agentId}|${contents.manifest.payload.target}`, "utf8");
}

export function createPlaintextBundle(contents: BundleContents): Bundle {
  return { format: "apbundle", version: 1, protocol: contents.manifest.payload.protocol, encryption: { scheme: "none", contents } };
}

export function createEncryptedBundle(contents: BundleContents, recipientPublicRaw: Uint8Array): Bundle {
  const sealed = sealTo(recipientPublicRaw, Buffer.from(APBUNDLE_INFO, "utf8"), bundleAad(contents), Buffer.from(canonicalJson(contents), "utf8"), AEAD_AES_256_GCM);
  return {
    format: "apbundle",
    version: 1,
    protocol: contents.manifest.payload.protocol,
    encryption: {
      scheme: "hpke-x25519-hkdf-sha256-aes-256-gcm",
      recipientKeyId: distributionKeyId(recipientPublicRaw),
      enc: sealed.enc.toString("base64url"),
      info: APBUNDLE_INFO,
      ciphertext: sealed.ciphertext.toString("base64url"),
    },
  };
}

export class BundleError extends Error {
  constructor(
    readonly code: "malformed" | "wrong_recipient" | "decrypt_failed" | "relabelled",
    message: string,
  ) {
    super(message);
    this.name = "BundleError";
  }
}

export interface DistributionKey {
  privateKey: KeyObject;
  publicRaw: Uint8Array;
}

/**
 * Decrypts (when sealed) and returns the contents. The AAD binds the bundle
 * to the agent and target the caller expects, so a bundle cannot be
 * relabelled for another target; signature and hash verification is the
 * caller's (the same path as OTA).
 */
export function openBundle(bundle: Bundle, expected: { agentId: string; target: string }, distributionKey?: DistributionKey): BundleContents {
  if (bundle.format !== "apbundle" || bundle.version !== 1) throw new BundleError("malformed", "not an apbundle v1");
  if (bundle.encryption.scheme === "none") {
    const contents = bundle.encryption.contents;
    if (contents.manifest.payload.agentId !== expected.agentId || contents.manifest.payload.target !== expected.target) {
      throw new BundleError("relabelled", "bundle is for another agent or target");
    }
    return contents;
  }
  if (!distributionKey) throw new BundleError("wrong_recipient", "an encrypted bundle needs the target's distribution key");
  if (bundle.encryption.recipientKeyId !== distributionKeyId(distributionKey.publicRaw)) throw new BundleError("wrong_recipient", "bundle was sealed to another distribution key");
  let plaintext: Buffer;
  try {
    plaintext = openFrom({
      enc: Buffer.from(bundle.encryption.enc, "base64url"),
      recipientPrivateKey: distributionKey.privateKey,
      recipientPublicRaw: distributionKey.publicRaw,
      info: Buffer.from(bundle.encryption.info ?? APBUNDLE_INFO, "utf8"),
      aad: Buffer.from(`${expected.agentId}|${expected.target}`, "utf8"),
      ciphertext: Buffer.from(bundle.encryption.ciphertext, "base64url"),
    });
  } catch {
    // A wrong AAD and a tampered ciphertext are indistinguishable by design; both mean "not for this target as sealed".
    throw new BundleError("decrypt_failed", "bundle does not open for this agent and target");
  }
  const contents = JSON.parse(plaintext.toString("utf8")) as BundleContents;
  if (contents.manifest.payload.agentId !== expected.agentId || contents.manifest.payload.target !== expected.target) {
    throw new BundleError("relabelled", "bundle is for another agent or target");
  }
  return contents;
}

export function bundlePayloadBytes(contents: BundleContents): Map<string, Buffer> {
  return new Map(contents.payloads.map((entry) => [entry.contentHash, Buffer.from(entry.bytes, "base64url")]));
}
