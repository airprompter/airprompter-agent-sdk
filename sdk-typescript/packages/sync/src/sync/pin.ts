/**
 * The pin sidecar and the "content pinned, control live" merge (`protocol/pins.md`). A pin names one sealed
 * release; store.json and store.schema.json stay format 2 (`additionalProperties: false`) so the pin never rides
 * inside them — it lives beside the store, in its own file, written with the same temp-file + fsync + rename
 * discipline `SlotStore` uses for its own files. `mergeLiveControl` is the other half of the contract: while
 * pinned, a runtime renders the pinned envelope's slots but keeps obeying the live manifest's directives, lease
 * and countersign requirement — this function is the one place that rule is expressed.
 *
 * @example
 * ```ts
 * writePinFile(fs, stateDir, agentId, target, { version: 1, release: "a3a20ff4f7fb", pinnedAt: now, by: "sdk" });
 * const pin = readPinFile(fs, stateDir, agentId, target); // null when never pinned, or after clearPinFile
 * const view = mergeLiveControl(pinnedManifest, liveManifest); // content from pinnedManifest, control from liveManifest
 * ```
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { FsPort, Manifest } from "@airprompter/agent-core";

export interface PinFile {
  version: 1;
  /** As given to `start({ release })` or `pin()` — a seal id (12 hex) or a full release digest. */
  release: string;
  pinnedAt: string;
  by: "sdk" | "cli";
}

function pinPath(stateDir: string, agentId: string, target: string): string {
  return join(stateDir, "airprompter", agentId, target, "pin.json");
}

/** Write to a temp file, fsync, rename: the file is either the old one or the new one, never half (the same rule `SlotStore` writes store.json under). */
function replacePinFileAtomically(fs: FsPort, path: string, bytes: Uint8Array): void {
  const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFile(temp, bytes, 0o600);
  const fd = fs.open(temp, "r+");
  try {
    fs.fsync(fd);
  } finally {
    fs.close(fd);
  }
  fs.rename(temp, path);
}

/** `null` when this target has never been pinned, or after `clearPinFile`. A file this reader cannot parse is treated as absent — never a boot failure. */
export function readPinFile(fs: FsPort, stateDir: string, agentId: string, target: string): PinFile | null {
  const path = pinPath(stateDir, agentId, target);
  if (!fs.exists(path)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(fs.readFile(path)).toString("utf8")) as PinFile;
    if (parsed && typeof parsed.release === "string" && parsed.release.length > 0) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function writePinFile(fs: FsPort, stateDir: string, agentId: string, target: string, pin: PinFile): void {
  const dir = join(stateDir, "airprompter", agentId, target);
  fs.mkdirp(dir, 0o700);
  replacePinFileAtomically(fs, pinPath(stateDir, agentId, target), Buffer.from(JSON.stringify(pin, null, 2), "utf8"));
}

/** `unpin()`: the pin file is removed so the next boot resumes unpinned. Never throws when there was nothing to remove. */
export function clearPinFile(fs: FsPort, stateDir: string, agentId: string, target: string): void {
  fs.rm(pinPath(stateDir, agentId, target), { force: true });
}

/**
 * "Content pinned, control live" (pins.md): the returned manifest is `pinned` with its control members —
 * `directives`, `leaseSeconds`, `onLeaseExpiry`, `requireCountersign`, `unlockWindow` — replaced by `live`'s.
 * `generation`, `slots`, `experiment(s)` and `releaseDigest` stay the pinned envelope's own: pinning is a
 * statement about slots, not about the release identity or the generation counter a pinned reader tracks
 * (pins.md › "Content pinned, control live", scoping anti-rollback to the pinned envelope's own generation).
 * The result is a VIEW for control decisions only — its signature is `pinned`'s, over `pinned`'s own payload, so
 * this merged payload must never be re-verified or written to the store as if it were a signed envelope.
 */
export function mergeLiveControl(pinned: Manifest, live: Manifest): Manifest {
  // Drop the pinned envelope's own unlockWindow first: control is live's, so a pinned envelope that carried one
  // must not leak past a live manifest that no longer has one (or never had one).
  const { unlockWindow: _pinnedUnlockWindow, ...pinnedPayloadRest } = pinned.payload;
  return {
    ...pinned,
    payload: {
      ...pinnedPayloadRest,
      directives: live.payload.directives,
      leaseSeconds: live.payload.leaseSeconds,
      onLeaseExpiry: live.payload.onLeaseExpiry,
      requireCountersign: live.payload.requireCountersign,
      ...(live.payload.unlockWindow !== undefined ? { unlockWindow: live.payload.unlockWindow } : {}),
    },
  };
}
