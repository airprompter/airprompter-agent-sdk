/**
 * Each payload is encrypted with AES-256-GCM under the store's DEK. The AAD
 * is `agentId ‖ target ‖ generation ‖ contentHash` joined by NUL bytes (U+0000 — spelled
 * `\u0000` below so the separator is visible; an SDK in another language must use the same byte), so a ciphertext cannot
 * be moved between slots or targets and swapping the A and B directories on
 * disk cannot roll the store back: decryption fails, the slot is corrupt,
 * and the fallback chain runs.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { errorNamed } from "../protocol/errors.js";

export function payloadAad(input: { agentId: string; target: string; generation: number; contentHash: string }): Buffer {
  return Buffer.from(`${input.agentId}\u0000${input.target}\u0000${input.generation}\u0000${input.contentHash}`, "utf8");
}

/** iv(12) ‖ tag(16) ‖ ciphertext */
export function encryptPayload(dek: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export class PayloadDecryptError extends Error {
  readonly code = "payload_decrypt_failed" as const;
  constructor() {
    super("payload does not decrypt under this store's key and slot (moved, swapped, or tampered)");
    this.name = "PayloadDecryptError";
  }
}

/** `PayloadDecryptError` by name and code — true across duplicated package copies. */
export function isPayloadDecryptError(error: unknown): error is PayloadDecryptError {
  return errorNamed(error, "PayloadDecryptError");
}

export function decryptPayload(dek: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Buffer {
  const buffer = Buffer.from(sealed);
  if (buffer.length < 28) throw new PayloadDecryptError();
  try {
    const decipher = createDecipheriv("aes-256-gcm", dek, buffer.subarray(0, 12));
    decipher.setAAD(aad);
    decipher.setAuthTag(buffer.subarray(12, 28));
    return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]);
  } catch {
    throw new PayloadDecryptError();
  }
}
