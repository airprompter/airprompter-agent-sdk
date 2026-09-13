/**
 * `MemoryFs` (S2, AIR-1970): a filesystem that fills, fails and loses files
 * on demand — the fake our own rule requires ("a forgiving fake hides every
 * budget bug"). Same contract as the Node port, so the spool, the store and
 * the uploader run over it unchanged.
 *
 * - `capacityBytes`: writes past it throw `ENOSPC`, like a full disk.
 * - `failNext(op, code, times?)`: the next call(s) to `op` throw that code.
 * - `vanish(path)`: the file disappears out from under a listing (the
 *   sibling-process race the budget sweep must survive).
 * - `bytesUsed()` and `tree()`: what a customer's CI asserts against.
 *
 * Handles are numbers; a closed or unknown handle throws `EBADF`.
 */

import type { FsFailure, FsOpenFlags, FsPort } from "../protocol/ports.js";

type Op = keyof FsPort;

function failure(code: string, path: string): FsFailure {
  const error = new Error(`${code}: ${path}`) as FsFailure;
  error.code = code;
  return error;
}

/** POSIX keys whatever the host's separator: `path.join` on Windows hands the sink backslashes, and a drive letter is dropped. */
function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/^[A-Za-z]:/, "").split(/[\\/]+/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

export class MemoryFs implements FsPort {
  private readonly files = new Map<string, { bytes: Uint8Array; mode: number; mtimeMs: number }>();
  private readonly dirs = new Set<string>(["/"]);
  private readonly handles = new Map<number, { path: string; flags: FsOpenFlags }>();
  private nextFd = 3;
  private readonly pending = new Map<Op, { code: string; times: number }>();
  /** Every operation in order — a test asserts what the spool did, not only what it left. */
  readonly journal: Array<{ op: Op; path: string }> = [];
  clockMs = 0;

  constructor(public capacityBytes: number = Number.POSITIVE_INFINITY) {}

  /** The next `times` calls to `op` fail with `code`. */
  failNext(op: Op, code: FsFailure["code"], times = 1): void {
    this.pending.set(op, { code, times });
  }

  /** The file is gone without a rename or unlink — a sibling process took it. */
  vanish(path: string): void {
    this.files.delete(normalize(path));
  }

  bytesUsed(): number {
    let total = 0;
    for (const file of this.files.values()) total += file.bytes.length;
    return total;
  }

  /** Every file path, sorted, with its size. */
  tree(): Array<{ path: string; bytes: number }> {
    return [...this.files.entries()].map(([path, file]) => ({ path, bytes: file.bytes.length })).sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  private gate(op: Op, path: string): void {
    this.journal.push({ op, path });
    const pending = this.pending.get(op);
    if (!pending) return;
    if (pending.times <= 1) this.pending.delete(op);
    else pending.times -= 1;
    throw failure(pending.code, path);
  }

  private ensureCapacity(extra: number, path: string): void {
    if (this.bytesUsed() + extra > this.capacityBytes) throw failure("ENOSPC", path);
  }

  mkdirp(path: string, _mode?: number): void {
    const p = normalize(path);
    this.gate("mkdirp", p);
    const parts = p.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      if (this.files.has(current)) throw failure("EEXIST", current);
      this.dirs.add(current);
    }
  }

  exists(path: string): boolean {
    const p = normalize(path);
    this.gate("exists", p);
    return this.files.has(p) || this.dirs.has(p);
  }

  list(dir: string): string[] {
    const d = normalize(dir);
    this.gate("list", d);
    if (!this.dirs.has(d)) return [];
    const prefix = d === "/" ? "/" : `${d}/`;
    const names = new Set<string>();
    for (const path of [...this.files.keys(), ...this.dirs]) {
      if (path !== d && path.startsWith(prefix)) names.add(path.slice(prefix.length).split("/")[0]!);
    }
    return [...names].sort();
  }

  listRecursive(dir: string): string[] {
    const d = normalize(dir);
    this.gate("listRecursive", d);
    if (!this.dirs.has(d)) return [];
    const prefix = d === "/" ? "/" : `${d}/`;
    return [...this.files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length)).sort();
  }

  stat(path: string): { size: number; mtimeMs: number } {
    const p = normalize(path);
    this.gate("stat", p);
    const file = this.files.get(p);
    if (file) return { size: file.bytes.length, mtimeMs: file.mtimeMs };
    if (this.dirs.has(p)) return { size: 0, mtimeMs: 0 };
    throw failure("ENOENT", p);
  }

  open(path: string, flags: FsOpenFlags, mode = 0o600): number {
    const p = normalize(path);
    this.gate("open", p);
    if (!this.dirs.has(parentOf(p))) throw failure("ENOENT", p);
    if (!this.files.has(p)) {
      if (flags === "r" || flags === "r+") throw failure("ENOENT", p);
      this.files.set(p, { bytes: new Uint8Array(0), mode, mtimeMs: this.clockMs });
    }
    const fd = this.nextFd++;
    this.handles.set(fd, { path: p, flags });
    return fd;
  }

  write(fd: number, bytes: Uint8Array): void {
    const handle = this.handles.get(fd);
    this.gate("write", handle?.path ?? `fd:${fd}`);
    if (!handle) throw failure("EBADF", `fd:${fd}`);
    const file = this.files.get(handle.path);
    if (!file) throw failure("ENOENT", handle.path);
    this.ensureCapacity(bytes.length, handle.path);
    const next = new Uint8Array(file.bytes.length + bytes.length);
    next.set(file.bytes, 0);
    next.set(bytes, file.bytes.length);
    file.bytes = next;
    file.mtimeMs = this.clockMs;
  }

  fsync(fd: number): void {
    const handle = this.handles.get(fd);
    this.gate("fsync", handle?.path ?? `fd:${fd}`);
    if (!handle) throw failure("EBADF", `fd:${fd}`);
  }

  close(fd: number): void {
    const handle = this.handles.get(fd);
    this.gate("close", handle?.path ?? `fd:${fd}`);
    if (!handle) throw failure("EBADF", `fd:${fd}`);
    this.handles.delete(fd);
  }

  rename(from: string, to: string): void {
    const f = normalize(from);
    const t = normalize(to);
    this.gate("rename", f);
    const file = this.files.get(f);
    if (!file) throw failure("ENOENT", f);
    if (!this.dirs.has(parentOf(t))) throw failure("ENOENT", t);
    this.files.delete(f);
    this.files.set(t, file);
    for (const handle of this.handles.values()) if (handle.path === f) handle.path = t;
  }

  unlink(path: string): void {
    const p = normalize(path);
    this.gate("unlink", p);
    if (!this.files.delete(p)) throw failure("ENOENT", p);
  }

  readFile(path: string): Uint8Array {
    const p = normalize(path);
    this.gate("readFile", p);
    const file = this.files.get(p);
    if (!file) throw failure("ENOENT", p);
    return file.bytes.slice();
  }

  writeFile(path: string, bytes: Uint8Array, mode = 0o600): void {
    const p = normalize(path);
    this.gate("writeFile", p);
    if (!this.dirs.has(parentOf(p))) throw failure("ENOENT", p);
    const existing = this.files.get(p)?.bytes.length ?? 0;
    this.ensureCapacity(bytes.length - existing, p);
    this.files.set(p, { bytes: bytes.slice(), mode, mtimeMs: this.clockMs });
  }

  rm(path: string, options?: { recursive?: boolean; force?: boolean }): void {
    const p = normalize(path);
    this.gate("rm", p);
    if (this.files.delete(p)) return;
    if (this.dirs.has(p)) {
      if (!options?.recursive) throw failure("EISDIR", p);
      const prefix = `${p}/`;
      for (const key of [...this.files.keys()]) if (key.startsWith(prefix)) this.files.delete(key);
      for (const dir of [...this.dirs]) if (dir === p || dir.startsWith(prefix)) this.dirs.delete(dir);
      return;
    }
    if (!options?.force) throw failure("ENOENT", p);
  }
}
