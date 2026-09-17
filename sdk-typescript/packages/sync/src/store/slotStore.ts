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
 *
 * @example
 * ```ts
 * const store = await SlotStore.open({ stateDir, agentId, target: "prod", keyProvider: fileKey(join(stateDir, "store.key")) });
 * store.acceptRoot(root); // the root document every later load verifies against
 * const slot = store.stage({ manifest, payloads }); // "A" or "B": the inactive slot, fsynced
 * store.activate(); // one rename of store.json flips it
 * const loaded = store.load(slot, { now: new Date().toISOString() }); // throws StoreError("slot_corrupt") rather than serve unverified bytes
 * ```
 */

import { randomBytes } from "node:crypto";
import { errorNamed } from "@airprompter/agent-core";
import { nodeFs } from "@airprompter/agent-core";
import type { FsPort } from "@airprompter/agent-core";
import { join } from "node:path";

import { sha256Prefixed } from "@airprompter/agent-core";
import { SDK_VERSION } from "@airprompter/agent-core";
import { referencedPayloads, verifyManifest, type Verdict } from "@airprompter/agent-core";
import type { ApplyPolicy, Manifest, RefusalCode, RootMetadata, Target } from "@airprompter/agent-core";
import type { KeyProvider, StorageProtection } from "./keyProvider.js";
import { decryptPayload, encryptPayload, isPayloadDecryptError, payloadAad } from "./payloadCrypto.js";

export type SlotName = "A" | "B";

/**
 * S8: store.json is a cross-package contract (`protocol/store-format.md`) — the daemon binary writes it, the application's
 * SDK reads it, and they deploy on different days. A reader at format N accepts N and N-1, writes N, migrates an N-1 file
 * forward on its first write, and refuses N+1 with `store_newer` naming the writer. Format 2 adds the writer and the S4 pin.
 */
export const STORE_FORMAT_VERSION = 2 as const;
export const STORE_FORMATS_READ: ReadonlySet<number> = new Set([1, 2]);

export interface StoreFile {
  /** The format (S8): 1 or 2 on disk, 2 once this runtime has written. */
  version: 1 | 2;
  /** Format 2: the package that last wrote the file, so a reader that meets a newer format can name what wrote it. */
  writer?: { name: string; version: string };
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
  /** The generation a local rollback stepped down from: sync holds that generation (and older) back until the control plane moves past it. */
  heldBackBelow?: number;
  /**
   * S4: the apply policy this host holds. Trust-on-first-use from the first verified manifest; a later manifest may
   * tighten it (`auto` → `unlock_required`), never loosen it; loosening is an operator's act (`airprompter policy set`)
   * and is recorded as such. Absent until the first manifest verifies.
   */
  applyPolicyPin?: ApplyPolicyPin;
  updatedAt: string;
}

/** S4: what store.json says about the apply policy — the value, who set it, and when. */
export interface ApplyPolicyPin {
  value: ApplyPolicy;
  /** `manifest`: pinned on first use or tightened by a signed manifest; `operator`: set by hand on this host. */
  source: "manifest" | "operator";
  /** The manifest generation that pinned or tightened it (0 for an operator's act before any manifest). */
  generation: number;
  setAt: string;
}

export interface LoadedSlot {
  slot: SlotName;
  manifest: Manifest;
  generation: number;
  signingKeyId: string;
  /** contentHash → plaintext bytes, all verified. */
  payloads: Map<string, Buffer>;
}

export type StoreErrorCode = "kek_unavailable" | "store_corrupt" | "store_newer" | "slot_corrupt" | "generation_rollback" | "no_release" | "not_staged" | "release_staged" | "no_previous_release";

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
    readonly detail?: RefusalCode | string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

/** `StoreError` by name and code — true for one thrown by another copy of this package too. */
export function isStoreError(error: unknown): error is StoreError {
  return errorNamed<StoreErrorCode>(error, "StoreError");
}

const otherSlot = (slot: SlotName): SlotName => (slot === "A" ? "B" : "A");
/** The SDK's own name and version, recorded as the writer unless the host (the daemon) names itself. */
const DEFAULT_WRITER = { name: "agent-sdk-typescript", version: SDK_VERSION };

function fsyncFile(fs: FsPort, path: string): void {
  // Write access: on Windows an fsync on a read-only descriptor is refused (FlushFileBuffers needs it).
  const fd = fs.open(path, "r+");
  try {
    fs.fsync(fd);
  } finally {
    fs.close(fd);
  }
}

function writeFileSynced(fs: FsPort, path: string, bytes: Uint8Array, mode = 0o600): void {
  fs.writeFile(path, bytes, mode);
  fsyncFile(fs, path);
}

/** Write to a temp file, fsync, rename: the file is either the old one or the new one, never half. */
function replaceFileAtomically(fs: FsPort, path: string, bytes: Uint8Array, hooks?: StoreHooks): void {
  const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSynced(fs, temp, bytes);
  hooks?.beforeRename?.(path);
  fs.rename(temp, path);
  try {
    const dir = fs.open(join(path, ".."), "r");
    try {
      fs.fsync(dir);
    } finally {
      fs.close(dir);
    }
  } catch {
    // Directory fsync is best effort on platforms that refuse it (Windows refuses to open a directory this way).
  }
}

/** Test seams: a crash between fsync and rename is the case the layout exists for. */
export interface StoreHooks {
  beforeRename?: (path: string) => void;
  /** S8: the writer this runtime records in store.json (the SDK's or the daemon's name and version). */
  writer?: { name: string; version: string };
}

export interface OpenStoreInput {
  stateDir: string;
  agentId: string;
  target: Target;
  keyProvider: KeyProvider;
  hooks?: StoreHooks;
  /** The filesystem (S2): the Node port by default; a fake that fills or fails in tests. */
  fs?: FsPort;
}

export class SlotStore {
  private constructor(
    readonly dir: string,
    private file: StoreFile,
    private readonly dek: Uint8Array,
    private readonly hooks: StoreHooks | undefined,
    private readonly fs: FsPort,
  ) {}

  static path(input: { stateDir: string; agentId: string; target: Target }): string {
    return join(input.stateDir, "airprompter", input.agentId, input.target);
  }

  /** Opens (creating on first use). Throws `kek_unavailable` when the key provider cannot produce the KEK. */
  static async open(input: OpenStoreInput): Promise<SlotStore> {
    const dir = SlotStore.path(input);
    const fs = input.fs ?? nodeFs;
    fs.mkdirp(join(dir, "slots", "A", "payloads"), 0o700);
    fs.mkdirp(join(dir, "slots", "B", "payloads"), 0o700);
    const storePath = join(dir, "store.json");
    if (!fs.exists(storePath)) {
      const dek = randomBytes(32);
      let wrapped: Uint8Array;
      try {
        wrapped = await input.keyProvider.wrap(dek);
      } catch (error) {
        throw new StoreError("kek_unavailable", `the key provider could not wrap the store key: ${(error as Error).message}`);
      }
      const file: StoreFile = {
        version: STORE_FORMAT_VERSION,
        writer: input.hooks?.writer ?? DEFAULT_WRITER,
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
      replaceFileAtomically(fs, storePath, Buffer.from(JSON.stringify(file, null, 2), "utf8"));
      return new SlotStore(dir, file, dek, input.hooks, fs);
    }
    let file: StoreFile;
    try {
      file = JSON.parse(Buffer.from(fs.readFile(storePath)).toString("utf8")) as StoreFile;
    } catch {
      throw new StoreError("store_corrupt", "store.json is unreadable");
    }
    if (typeof file.version === "number" && Number.isInteger(file.version) && file.version > STORE_FORMAT_VERSION) {
      // N+1: written by something newer than this reader. Never guessed at; the writer is named so the operator knows what to update.
      const writer = file.writer && typeof file.writer === "object" ? `${file.writer.name} ${file.writer.version}` : "an unknown writer";
      throw new StoreError("store_newer", `store.json is format ${file.version}, written by ${writer}; this runtime reads formats ${[...STORE_FORMATS_READ].join(" and ")} — update it, or roll the writer back before its next write`, writer);
    }
    if (!STORE_FORMATS_READ.has(file.version) || file.agentId !== input.agentId || file.target !== input.target) {
      throw new StoreError("store_corrupt", "store.json belongs to another agent or target");
    }
    let dek: Uint8Array;
    try {
      dek = await input.keyProvider.unwrap(Buffer.from(file.wrappedDek, "base64url"));
    } catch (error) {
      throw new StoreError("kek_unavailable", `the key provider could not unwrap the store key: ${(error as Error).message}`);
    }
    if (dek.length !== 32) throw new StoreError("store_corrupt", "unwrapped store key has the wrong length");
    return new SlotStore(dir, file, dek, input.hooks, fs);
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

  /** S4: record the apply policy this host holds (the caller decided it may change — see `AirPrompterAgent.takeApplyPolicy`). */
  pinApplyPolicy(pin: ApplyPolicyPin): void {
    this.write({ ...this.file, applyPolicyPin: pin });
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
    this.fs.rm(join(slotDir, "payloads"), { recursive: true, force: true });
    this.fs.mkdirp(join(slotDir, "payloads"), 0o700);
    for (const [hash, bytes] of input.payloads) {
      const aad = payloadAad({ agentId: this.file.agentId, target: this.file.target, generation, contentHash: hash });
      writeFileSynced(this.fs, join(slotDir, "payloads", `${hash.replace(":", "-")}.enc`), encryptPayload(this.dek, bytes, aad));
    }
    writeFileSynced(this.fs, join(slotDir, "manifest.json"), Buffer.from(JSON.stringify(input.manifest), "utf8"));
    this.write({ ...this.file, staged: slot, ...(input.force && generation < this.file.generation ? { forcedDowngrade: true } : {}) });
    return slot;
  }

  /** Flip `active` to the staged slot: one atomic store.json replace. */
  activate(): SlotName {
    const slot = this.file.staged;
    if (!slot) throw new StoreError("not_staged", "nothing is staged");
    const manifest = this.readManifest(slot);
    const generation = manifest.payload.generation;
    // Moving past a held-back generation ends the hold; a forced downgrade stays stamped.
    const { heldBackBelow, ...rest } = this.file;
    this.write({ ...(heldBackBelow !== undefined && generation > heldBackBelow ? rest : this.file), active: slot, staged: null, generation });
    return slot;
  }

  /**
   * Instant local rollback: the previous release is the other slot. Stamped on evidence by the caller. Refused while
   * the other slot holds a STAGED release — flipping to it would be a silent unlock, not a rollback — and when this
   * host has only ever held one release.
   */
  rollbackLocal(): SlotName {
    if (!this.file.active) throw new StoreError("no_release", "nothing is active");
    if (this.file.staged) throw new StoreError("release_staged", "the other slot holds a staged release, not a previous one: unlock it first (a runtime can also discard it)");
    const previous = otherSlot(this.file.active);
    if (!this.fs.exists(join(this.dir, "slots", previous, "manifest.json"))) throw new StoreError("no_previous_release", "this host has held one release only; there is nothing to go back to");
    const manifest = this.readManifest(previous);
    const downgrade = manifest.payload.generation < this.file.generation;
    this.write({ ...this.file, active: previous, staged: null, generation: manifest.payload.generation, forcedDowngrade: downgrade, ...(downgrade ? { heldBackBelow: this.file.generation } : {}) });
    return previous;
  }

  /** Discard a staged slot (a crashed apply, or a refused unlock). */
  discardStaged(): void {
    if (!this.file.staged) return;
    this.fs.rm(join(this.dir, "slots", this.file.staged, "payloads"), { recursive: true, force: true });
    this.fs.rm(join(this.dir, "slots", this.file.staged, "manifest.json"), { force: true });
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
      if (!this.fs.exists(path)) throw new StoreError("slot_corrupt", `payload ${hash} missing`, "payload_missing");
      try {
        payloads.set(hash, decryptPayload(this.dek, Buffer.from(this.fs.readFile(path)), payloadAad({ agentId: this.file.agentId, target: this.file.target, generation, contentHash: hash })));
      } catch (error) {
        if (isPayloadDecryptError(error)) throw new StoreError("slot_corrupt", `payload ${hash} does not decrypt for this slot`, "payload_hash_mismatch");
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
    return this.fs.listRecursive(dir);
  }

  private readManifest(slot: SlotName): Manifest {
    const path = join(this.dir, "slots", slot, "manifest.json");
    if (!this.fs.exists(path)) throw new StoreError("slot_corrupt", `slot ${slot} has no manifest`);
    try {
      return JSON.parse(Buffer.from(this.fs.readFile(path)).toString("utf8")) as Manifest;
    } catch {
      throw new StoreError("slot_corrupt", `slot ${slot} manifest is unreadable`, "schema_invalid");
    }
  }

  /** S8: what this reader would write — an N-1 file migrates forward here, on the first write, never on open (the rollback window). */
  private write(next: StoreFile): void {
    const file: StoreFile = { ...next, version: STORE_FORMAT_VERSION, writer: this.hooks?.writer ?? DEFAULT_WRITER, updatedAt: new Date().toISOString() };
    replaceFileAtomically(this.fs, join(this.dir, "store.json"), Buffer.from(JSON.stringify(file, null, 2), "utf8"), this.hooks);
    this.file = file;
  }
}
