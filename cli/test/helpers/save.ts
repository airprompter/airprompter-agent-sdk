/**
 * Two ways to save a file in a folder `airprompter dev` serves, for tests that need to say which they mean.
 *
 * - **`saveAtomic`**, as an editor's atomic save: the bytes go to a temp file beside the served folder (same filesystem,
 *   outside what is watched), and one rename puts them in place. The server can only ever read the old file or the new
 *   one. Use it where a count of generations is asserted: a plain write truncates and then writes, and a server that
 *   reads in between (the test stalled past the 200 ms debounce) sees an empty file and promotes a generation without
 *   that slot.
 * - **`saveInPlace`**, as `open('w')`, `echo >` and most editors' defaults: truncate, then write, the same inode. Use it
 *   to assert that an in-place save is picked up, on a file whose half-written state is harmless (it reads as the
 *   release already served, so it cannot promote).
 */

import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `tempDir` must be on the same filesystem as `path` and outside the served folder (a test's work dir, say). */
export function saveAtomic(tempDir: string, path: string, text: string): void {
  const temp = join(tempDir, `.save-${process.pid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(temp, text);
  renameSync(temp, path);
}

export function saveInPlace(path: string, text: string): void {
  writeFileSync(path, text);
}
