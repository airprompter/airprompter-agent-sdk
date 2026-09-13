/**
 * Ports (S2, AIR-1970): the seams between the SDK and the world it cannot
 * control — the filesystem, the clock, the network. Every I/O module takes
 * one of these instead of reaching for `node:fs`, `Date.now` or `fetch`, so a
 * fake can *fill* (ENOSPC), *fail* (EIO), *vanish a file* (ENOENT) or *skew*
 * — our own rule: a forgiving fake hides every budget bug. The Node
 * implementations live in `../ports/node.js`; the fakes in `../testing/`.
 *
 * Pure types; nothing here imports Node.
 */

/** A filesystem error the port surfaces: the same `code` Node uses, never a class. */
export interface FsFailure extends Error {
  code: "ENOSPC" | "EIO" | "ENOENT" | "EACCES" | "EEXIST" | (string & {});
}

export type FsOpenFlags = "a" | "r" | "r+";

/**
 * The synchronous filesystem the spool, the store and the uploader use. Paths
 * are absolute strings; `fd` is an opaque handle the same port issued. Every
 * method throws an `FsFailure` on failure — the *callers* decide what a
 * failure means (the spool counts and carries on; the store refuses).
 */
export interface FsPort {
  mkdirp(path: string, mode?: number): void;
  exists(path: string): boolean;
  /** Entry names (not paths) of a directory; `[]` when it does not exist. */
  list(dir: string): string[];
  /** Relative paths of every file under `dir`, sorted; `[]` when it does not exist. */
  listRecursive(dir: string): string[];
  stat(path: string): { size: number; mtimeMs: number };
  open(path: string, flags: FsOpenFlags, mode?: number): number;
  write(fd: number, bytes: Uint8Array): void;
  fsync(fd: number): void;
  close(fd: number): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  readFile(path: string): Uint8Array;
  /** Whole-file write with `mode`; the caller decides whether it is atomic (the store renames a temp file). */
  writeFile(path: string, bytes: Uint8Array, mode?: number): void;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

/** The clock. `nowMs()` is epoch milliseconds; a fake advances on demand. */
export interface ClockPort {
  nowMs(): number;
}

/** `fetch` as the SDK calls it: the network port — the `FetchLike` the sync client and uploader already take. */
export type FetchPort = (input: string, init?: { method?: string; headers?: Record<string, string>; redirect?: "follow"; body?: string | Uint8Array }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** The `code` of a filesystem failure, or `"unknown"` for anything else thrown. */
export function fsFailureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.length > 0 ? code : "unknown";
}
