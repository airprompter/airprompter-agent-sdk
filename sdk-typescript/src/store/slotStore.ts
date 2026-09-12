/**
 * The A/B slot store (D35), modelled on OS update partitions.
 *
 *   <stateDir>/airprompter/<agentId>/<target>/
 *     store.json            active slot, staged slot, generation, root document, instanceId, wrapped DEK
 *     slots/A/manifest.json signed envelope, plaintext (no prompt text in it)
 *     slots/A/payloads/sha256-<hex>.enc
 *     slots/B/…
 *
 * Stage into the inactive slot and fsync every file; flip `active` by
 * writing store.json to a temp file and renaming it. A crash mid-apply
 * leaves the previous slot intact and the staged slot either complete or
 * discarded on the next open. Every open verifies the manifest signature
 * against the stored root document and every payload's hash after decrypt.
 * Any failure marks the slot corrupt and the caller falls back: other slot
 * → vendored bundle → refuse to start. Render never serves unverified bytes.
 */

import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Prefixed } from "../protocol/canonicalJson.js";
import { referencedPayloads, verifyManifest, type Verdict } from "../protocol/trust.js";
import type { Manifest, RefusalCode, RootMetadata, Target } from "../protocol/types.js";
import type { KeyProvider, StorageProtection } from "./keyProvider.js";
import { decryptPayload, encryptPayload, payloadAad, PayloadDecryptError } from "./payloadCrypto.js";

export type SlotName = "A" | "B";

export interface StoreFile {
  version: 1;
  agentId: string;
  target: Target;
  instanceId: string;
  /** Base64url of the DEK wrapped by the key provider. */
  wrappedDek: string;
  storageProtection: StorageProtection;
  /** The slot that serves; null until the first apply. */
  active: SlotName | null;
  /** A verified, not yet activated release (unlock_required). */
  staged: SlotName | null;
  /** The generation the active slot holds; 0 before the first apply. Anti-rollback compares against it. */
  generation: number;
  /** The last accepted root document; null until one is accepted. */
  root: RootMetadata | null;
  /** Set by a forced local downgrade; reported on evidence. */
  forcedDowngrade?: boolean;
  updatedAt: string;
}

export interface LoadedSlot {
  slot: SlotName;
  manifest: Manifest;
  generation: number;
  signingKeyId: string;
  /** contentHash → plaintext bytes, all verified. */
  payloads: Map<string, Buffer>;
}

export class StoreError extends Error {
  constructor(
    readonly code: "kek_unavailable" | "store_corrupt" | "slot_corrupt" | "generation_rollback" | "no_release" | "not_staged",
    message: string,
    readonly detail?: RefusalCode | string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

const otherSlot = (slot: SlotName): SlotName => (slot === "A" ? "B" : "A");

function fsyncFile(path: string): void {
  // Write access: on Windows an fsync on a read-only descriptor is refused (FlushFileBuffers needs it).
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeFileSynced(path: string, bytes: Uint8Array, mode = 0o600): void {
  writeFileSync(path, bytes, { mode });
  fsyncFile(path);
}

/** Write to a temp file, fsync, rename: the file is either the old one or the new one, never half. */
function replaceFileAtomically(path: string, bytes: Uint8Array, hooks?: StoreHooks): void {
  const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSynced(temp, bytes);
  hooks?.beforeRename?.(path);
  renameSync(temp, path);
  try {
    const dir = openSync(join(path, ".."), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch {
    // Directory fsync is best effort on platforms that refuse it (Windows refuses to open a directory this way).
  }
}

/** Test seams: a crash between fsync and rename is the case the layout exists for. */
export interface StoreHooks {
  beforeRename?: (path: string) => void;
}

export interface OpenStoreInput {
  stateDir: string;
  agentId: string;
  target: Target;
  keyProvider: KeyProvider;
  hooks?: StoreHooks;
}

export class SlotStore {
  private constructor(
    readonly dir: string,
    private file: StoreFile,
    private readonly dek: Uint8Array,
    private readonly hooks: StoreHooks | undefined,
  ) {}

  static path(input: { stateDir: string; agentId: string; target: Target }): string {
    return join(input.stateDir, "airprompter", input.agentId, input.target);
  }

  /** Opens (creating on first use). Throws `kek_unavailable` when the key provider cannot produce the KEK. */
  static async open(input: OpenStoreInput): Promise<SlotStore> {
    const dir = SlotStore.path(input);
    mkdirSync(join(dir, "slots", "A", "payloads"), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, "slots", "B", "payloads"), { recursive: true, mode: 0o700 });
    const storePath = join(dir, "store.json");
    if (!existsSync(storePath)) {
      const dek = randomBytes(32);
      let wrapped: Uint8Array;
      try {
        wrapped = await input.keyProvider.wrap(dek);
      } catch (error) {
        throw new StoreError("kek_unavailable", `the key provider could not wrap the store key: ${(error as Error).message}`);
      }
      const file: StoreFile = {
        version: 1,
        agentId: input.agentId,
        target: input.target,
        instanceId: `i-${randomBytes(12).toString("base64url")}`,
        wrappedDek: Buffer.from(wrapped).toString("base64url"),
        storageProtection: input.keyProvider.storageProtection,
        active: null,
        staged: null,
        generation: 0,
        root: null,
        updatedAt: new Date().toISOString(),
      };
      replaceFileAtomically(storePath, Buffer.from(JSON.stringify(file, null, 2), "utf8"));
      return new SlotStore(dir, file, dek, input.hooks);
    }
    let file: StoreFile;
    try {
      file = JSON.parse(readFileSync(storePath, "utf8")) as StoreFile;
    } catch {
      throw new StoreError("store_corrupt", "store.json is unreadable");
    }
    if (file.version !== 1 || file.agentId !== input.agentId || file.target !== input.target) {
      throw new StoreError("store_corrupt", "store.json belongs to another agent or target");
    }
    let dek: Uint8Array;
    try {
      dek = await input.keyProvider.unwrap(Buffer.from(file.wrappedDek, "base64url"));
    } catch (error) {
      throw new StoreError("kek_unavailable", `the key provider could not unwrap the store key: ${(error as Error).message}`);
    }
    if (dek.length !== 32) throw new StoreError("store_corrupt", "unwrapped store key has the wrong length");
    return new SlotStore(dir, file, dek, input.hooks);
  }

  get state(): Readonly<StoreFile> {
    return this.file;
  }

  get instanceId(): string {
    return this.file.instanceId;
  }

  get storageProtection(): StorageProtection {
    return this.file.storageProtection;
  }

  /**
   * KEK rotation: the DEK is re-WRAPPED under the new provider, never
   * re-generated — every payload stays readable during a live serve and
   * nothing is re-encrypted. The old provider is not consulted (the DEK is
   * already in memory), so a rotation works even after the old KEK is gone.
   */
  async rotateKey(provider: KeyProvider): Promise<void> {
    const wrapped = await provider.wrap(this.dek);
    this.write({ ...this.file, wrappedDek: Buffer.from(wrapped).toString("base64url"), storageProtection: provider.storageProtection });
  }

  /** Persist a newly accepted root document (the caller verified it). */
  acceptRoot(root: RootMetadata): void {
    this.write({ ...this.file, root });
  }

  /**
   * Stage a verified release into the inactive slot: encrypt every payload
   * under the DEK with the slot-binding AAD, write the manifest, fsync all,
   * then record `staged` in store.json. Refuses a generation below the
   * active one unless `force` (a forced downgrade is stamped on evidence).
   */
  stage(input: { manifest: Manifest; payloads: ReadonlyMap<string, Uint8Array>; force?: boolean }): SlotName {
    const generation = input.manifest.payload.generation;
    if (generation < this.file.generation && !input.force) {
      throw new StoreError("generation_rollback", `generation ${generation} is below the stored ${this.file.generation}`);
    }
    for (const [hash, byteLength] of referencedPayloads(input.manifest.payload)) {
      const bytes = input.payloads.get(hash);
      if (!bytes) throw new StoreError("slot_corrupt", `payload ${hash} missing from the stage set`, "payload_missing");
      if (bytes.length !== byteLength || sha256Prefixed(bytes) !== hash) throw new StoreError("slot_corrupt", `payload ${hash} does not hash`, "payload_hash_mismatch");
    }
    const slot = this.file.active ? otherSlot(this.file.active) : "A";
    const slotDir = join(this.dir, "slots", slot);
    rmSync(join(slotDir, "payloads"), { recursive: true, force: true });
    mkdirSync(join(slotDir, "payloads"), { recursive: true, mode: 0o700 });
    for (const [hash, bytes] of input.payloads) {
      const aad = payloadAad({ agentId: this.file.agentId, target: this.file.target, generation, contentHash: hash });
      writeFileSynced(join(slotDir, "payloads", `${hash.replace(":", "-")}.enc`), encryptPayload(this.dek, bytes, aad));
    }
    writeFileSynced(join(slotDir, "manifest.json"), Buffer.from(JSON.stringify(input.manifest), "utf8"));
    this.write({ ...this.file, staged: slot, ...(input.force && generation < this.file.generation ? { forcedDowngrade: true } : {}) });
    return slot;
  }

  /** Flip `active` to the staged slot: one atomic store.json replace. */
  activate(): SlotName {
    const slot = this.file.staged;
    if (!slot) throw new StoreError("not_staged", "nothing is staged");
    const manifest = this.readManifest(slot);
    this.write({ ...this.file, active: slot, staged: null, generation: manifest.payload.generation });
    return slot;
  }

  /** Instant local rollback: the previous release is the other slot. Stamped on evidence by the caller. */
  rollbackLocal(): SlotName {
    if (!this.file.active) throw new StoreError("no_release", "nothing is active");
    const previous = otherSlot(this.file.active);
    const manifest = this.readManifest(previous);
    this.write({ ...this.file, active: previous, staged: null, generation: manifest.payload.generation, forcedDowngrade: manifest.payload.generation < this.file.generation });
    return previous;
  }

  /** Discard a staged slot (a crashed apply, or a refused unlock). */
  discardStaged(): void {
    if (!this.file.staged) return;
    rmSync(join(this.dir, "slots", this.file.staged, "payloads"), { recursive: true, force: true });
    rmSync(join(this.dir, "slots", this.file.staged, "manifest.json"), { force: true });
    this.write({ ...this.file, staged: null });
  }

  /**
   * Load and verify a slot: manifest signature against the stored root,
   * scope, every payload decrypts under this slot's AAD and hashes. Throws
   * `slot_corrupt` on any failure — never returns unverified bytes.
   */
  load(slot: SlotName, input: { now: string; root?: RootMetadata | null; requireCountersign?: boolean; countersignRoot?: RootMetadata | null; expectGeneration?: number }): LoadedSlot {
    const root = input.root ?? this.file.root;
    if (!root) throw new StoreError("slot_corrupt", "no trusted root document to verify against");
    const manifest = this.readManifest(slot);
    const generation = manifest.payload.generation;
    // The active slot must hold the generation store.json says it holds: directories swapped on disk
    // put an older manifest (self-consistent, still signed) behind the active letter, and this is
    // where that shows — the counter lives outside the slots.
    if (input.expectGeneration !== undefined && generation !== input.expectGeneration) {
      throw new StoreError("slot_corrupt", `slot ${slot} holds generation ${generation}, store.json expects ${input.expectGeneration}`, "generation_rollback");
    }
    const payloads = new Map<string, Buffer>();
    for (const hash of referencedPayloads(manifest.payload).keys()) {
      const path = join(this.dir, "slots", slot, "payloads", `${hash.replace(":", "-")}.enc`);
      if (!existsSync(path)) throw new StoreError("slot_corrupt", `payload ${hash} missing`, "payload_missing");
      try {
        payloads.set(hash, decryptPayload(this.dek, readFileSync(path), payloadAad({ agentId: this.file.agentId, target: this.file.target, generation, contentHash: hash })));
      } catch (error) {
        if (error instanceof PayloadDecryptError) throw new StoreError("slot_corrupt", `payload ${hash} does not decrypt for this slot`, "payload_hash_mismatch");
        throw error;
      }
    }
    const verdict: Verdict<{ signingKeyId: string; generation: number }> = verifyManifest({
      manifest,
      root,
      now: input.now,
      scope: { organizationId: manifest.payload.organizationId, agentId: this.file.agentId, target: this.file.target },
      // A stored slot is checked against itself, not the store's counter: the counter is the anti-rollback for NEW manifests.
      storedGeneration: 0,
      payloads,
      countersignRoot: input.countersignRoot ?? null,
      ...(input.requireCountersign !== undefined ? { requireCountersign: input.requireCountersign } : {}),
    });
    if (!verdict.ok) {
      // Expired root: the bytes are still the last verified release; report and serve (D39). Everything else is corrupt.
      if (verdict.reason === "root_expired") {
        const relaxed = verifyManifest({ manifest, root: { ...root, signed: { ...root.signed, expires: "9999-12-31T23:59:59Z" } }, now: input.now, scope: { organizationId: manifest.payload.organizationId, agentId: this.file.agentId, target: this.file.target }, storedGeneration: 0, payloads });
        if (relaxed.ok) return { slot, manifest, generation, signingKeyId: relaxed.signingKeyId, payloads };
      }
      throw new StoreError("slot_corrupt", `slot ${slot} failed verification: ${verdict.reason}`, verdict.reason);
    }
    return { slot, manifest, generation, signingKeyId: verdict.signingKeyId, payloads };
  }

  listSlotFiles(slot: SlotName): string[] {
    const dir = join(this.dir, "slots", slot);
    return existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : [];
  }

  private readManifest(slot: SlotName): Manifest {
    const path = join(this.dir, "slots", slot, "manifest.json");
    if (!existsSync(path)) throw new StoreError("slot_corrupt", `slot ${slot} has no manifest`);
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Manifest;
    } catch {
      throw new StoreError("slot_corrupt", `slot ${slot} manifest is unreadable`, "schema_invalid");
    }
  }

  private write(next: StoreFile): void {
    const file = { ...next, updatedAt: new Date().toISOString() };
    replaceFileAtomically(join(this.dir, "store.json"), Buffer.from(JSON.stringify(file, null, 2), "utf8"), this.hooks);
    this.file = file;
  }
}
