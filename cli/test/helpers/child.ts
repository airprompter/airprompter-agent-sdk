/**
 * A spawned CLI process as the tests read it: its stdout and stderr as whole lines, and its exit once both streams are
 * drained.
 *
 * - **Lines, not chunks.** A pipe delivers whatever bytes are ready, so a chunk can end mid-line (and a JSON line then
 *   fails to parse). The trailing partial line is held until its newline arrives, or until the stream ends.
 * - **`closed`, not `exit`.** Node emits `exit` when the process ends, which can be before the parent has read the last
 *   of its output. `close` fires after the stdio streams have closed, so every line the process wrote is in by then.
 */

import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

export function collectLines(stream: Readable, into: string[]): void {
  let partial = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    const parts = (partial + chunk).split("\n");
    partial = parts.pop()!;
    into.push(...parts.filter(Boolean));
  });
  stream.on("end", () => {
    if (partial) into.push(partial);
    partial = "";
  });
}

export interface ChildLines {
  stdout: string[];
  stderr: string[];
  /** The exit code, once the process has exited and its stdout and stderr are drained (`close`). */
  closed: Promise<number | null>;
}

export function childLines(child: ChildProcess): ChildLines {
  const stdout: string[] = [];
  const stderr: string[] = [];
  if (child.stdout) collectLines(child.stdout, stdout);
  if (child.stderr) collectLines(child.stderr, stderr);
  const closed = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  return { stdout, stderr, closed };
}
