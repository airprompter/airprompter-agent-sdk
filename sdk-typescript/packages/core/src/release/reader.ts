/**
 * The seam between the packages (S10): a verified release as a runtime
 * consumes it, and where one comes from. `@airprompter/agent-sync` produces
 * a `LoadedRelease` from the encrypted slot store or a daemon;
 * `@airprompter/agent-core` produces one from a bundle the customer loads
 * (`loadBundleRelease`); `@airprompter/agent-runtime` renders and assigns
 * over either without knowing which. Structural, never a class: two copies
 * of a package in one lockfile must agree on it (S1, the discriminant rule).
 */

import type { Manifest } from "../protocol/types.js";

/** A verified release: the manifest, its generation, and the verified payload bytes by content hash. */
export interface LoadedRelease {
  readonly manifest: Manifest;
  readonly generation: number;
  /** contentHash → plaintext bytes, every one verified against the manifest before it is here. */
  readonly payloads: ReadonlyMap<string, Uint8Array>;
}

/** Where a runtime reads releases from: the slot store, a daemon, or a bundle the customer loaded. */
export interface ReleaseReader {
  /** What the reader is, as data — never branch on a class. */
  readonly kind: "store" | "daemon" | "bundle" | (string & {});
  /** The release in force, or null when nothing verified is held. */
  current(): LoadedRelease | null;
}

/** One slot of a release as the runtime resolves it: the manifest slot, and the arm and bucket the subject fell in. */
export interface ReleaseSlot {
  slot: Manifest["payload"]["slots"][number];
  arm: string;
  bucket: number | null;
}
