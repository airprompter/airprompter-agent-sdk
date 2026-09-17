/**
 * Key providers hand the store its KEK — the key that wraps the per-store
 * DEK. What protects the KEK is what the store's confidentiality rests on,
 * and the heartbeat reports it (`storageProtection`) so a fleet view can
 * show a `file_key` host as a finding instead of hiding it (D15).
 *
 * `fileKey()` ships here: a 0600 file beside the store. `kms()`, `vault()`
 * and `osKeystore()` are optional packages; `custom()` wraps anything that
 * can wrap and unwrap 32 bytes.
 *
 * @example
 * ```ts
 * const provider = customKeyProvider({
 *   storageProtection: "kms", // what the heartbeat reports; "custom" when unnamed
 *   wrap: async (dek) => (await kms.encrypt({ KeyId, Plaintext: dek })).CiphertextBlob!,
 *   unwrap: async (wrapped) => (await kms.decrypt({ CiphertextBlob: wrapped })).Plaintext!,
 * });
 * const store = await SlotStore.open({ stateDir, agentId, target: "prod", keyProvider: provider }); // fileKey(path) is the fallback
 * ```
 */

import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { nodeFs, type FsPort } from "@airprompter/agent-core";

export type StorageProtection = "os_keystore" | "kms" | "vault" | "custom" | "file_key";

export interface KeyProvider {
  readonly storageProtection: StorageProtection;
  /** Wrap the DEK for storage in store.json. */
  wrap(dek: Uint8Array): Promise<Uint8Array>;
  /** Unwrap what `wrap` produced. Throws when the KEK cannot be obtained — the store then refuses to open. */
  unwrap(wrapped: Uint8Array): Promise<Uint8Array>;
}

/** AES-256-GCM wrap with a raw 32-byte KEK: iv(12) ‖ tag(16) ‖ ciphertext. */
export async function wrapWithRawKey(kek: Uint8Array, dek: Uint8Array): Promise<Uint8Array> {
  const { createCipheriv } = await import("node:crypto");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export async function unwrapWithRawKey(kek: Uint8Array, wrapped: Uint8Array): Promise<Uint8Array> {
  const { createDecipheriv } = await import("node:crypto");
  const buffer = Buffer.from(wrapped);
  const decipher = createDecipheriv("aes-256-gcm", kek, buffer.subarray(0, 12));
  decipher.setAuthTag(buffer.subarray(12, 28));
  return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]);
}

/**
 * The fallback: a 32-byte KEK in a 0600 file. Defends the store against
 * other users, backups and snapshots — not against a co-tenant process
 * running as the same user. Reported, never silent.
 */
export function fileKey(path: string, fs: FsPort = nodeFs): KeyProvider {
  // Through the same port as the store: an application that runs the store on a memory or custom filesystem keeps
  // the key there too, instead of finding a 0600 file on the real disk it never asked for.
  const load = (): Uint8Array => {
    if (!fs.exists(path)) {
      fs.mkdirp(dirname(path), 0o700);
      fs.writeFile(path, randomBytes(32), 0o600);
    }
    const kek = fs.readFile(path);
    if (kek.length !== 32) throw new Error(`${path} is not a 32-byte key file`);
    return kek;
  };
  return {
    storageProtection: "file_key",
    wrap: (dek) => wrapWithRawKey(load(), dek),
    unwrap: (wrapped) => unwrapWithRawKey(load(), wrapped),
  };
}

/** Bring your own wrap/unwrap (a KMS call, a Vault transit key, an HSM). */
export function customKeyProvider(input: { storageProtection?: Exclude<StorageProtection, "file_key">; wrap: KeyProvider["wrap"]; unwrap: KeyProvider["unwrap"] }): KeyProvider {
  return { storageProtection: input.storageProtection ?? "custom", wrap: input.wrap, unwrap: input.unwrap };
}
