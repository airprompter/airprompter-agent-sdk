/**
 * The Node filesystem and clock behind the ports (S2). Thin: every method is
 * one `node:fs` call, so a failure surfaces with Node's own `code`
 * (`ENOSPC`, `EIO`, `ENOENT`, …) and the caller decides what it means.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";

import type { ClockPort, FsPort } from "../protocol/ports.js";

export const nodeFs: FsPort = {
  mkdirp: (path, mode = 0o700) => void mkdirSync(path, { recursive: true, mode }),
  exists: (path) => existsSync(path),
  list: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
  listRecursive: (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : []),
  stat: (path) => {
    const s = statSync(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  },
  open: (path, flags, mode) => openSync(path, flags, mode),
  write: (fd, bytes) => void writeSync(fd, bytes),
  fsync: (fd) => fsyncSync(fd),
  close: (fd) => closeSync(fd),
  rename: (from, to) => renameSync(from, to),
  unlink: (path) => unlinkSync(path),
  readFile: (path) => readFileSync(path),
  writeFile: (path, bytes, mode) => writeFileSync(path, bytes, mode === undefined ? undefined : { mode }),
  rm: (path, options) => rmSync(path, { recursive: options?.recursive ?? false, force: options?.force ?? false }),
};

export const systemClock: ClockPort = { nowMs: () => Date.now() };
