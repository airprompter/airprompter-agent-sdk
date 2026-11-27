/**
 * A spawned CLI process as the tests read it: its stdout and stderr as whole lines, its JSON event lines, and its end.
 *
 * - **Lines, not chunks.** A pipe delivers whatever bytes are ready, so a chunk can end mid-line (and a JSON line then
 *   fails to parse). The trailing partial line is held until its newline arrives, or until the stream ends or closes.
 * - **`closed`, not `exit`.** Node emits `exit` when the process ends, which can be before the parent has read the last
 *   of its output. `closed` resolves on `close`, after the stdio streams have ended, so every line the process wrote is
 *   in by then. If something else holds the pipes open (a grandchild), it stops waiting `drainMs` after `exit`, and
 *   it rejects if the process could not be spawned at all (`error`).
 * - **`stop()`** sends SIGTERM, and SIGKILL if the process has not closed within `graceMs`.
 */

import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

export function collectLines(stream: Readable, into: string[]): void {
  let partial = "";
  const flush = () => {
    if (partial) into.push(partial);
    partial = "";
  };
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    const parts = (partial + chunk).split("\n");
    partial = parts.pop()!;
    into.push(...parts.filter(Boolean));
  });
  stream.on("end", flush);
  stream.on("close", flush);
}

/** The lines that parse as JSON objects, in order; anything else (a runtime warning, a stack trace) is skipped here and
 * stays in the raw lines for a failure message. */
export function jsonLines(lines: string[]): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) events.push(value as Record<string, unknown>);
    } catch {
      // not an event line
    }
  }
  return events;
}

export interface ChildLines {
  stdout: string[];
  stderr: string[];
  /** The exit code once the process has exited and its stdout and stderr are drained (`close`). */
  closed: Promise<number | null>;
  /** SIGTERM, then SIGKILL after `graceMs` if it has not closed; resolves with the exit code (null when signalled). */
  stop: (graceMs?: number) => Promise<number | null>;
}

export function childLines(child: ChildProcess, options: { drainMs?: number } = {}): ChildLines {
  const stdout: string[] = [];
  const stderr: string[] = [];
  if (child.stdout) collectLines(child.stdout, stdout);
  if (child.stderr) collectLines(child.stderr, stderr);
  const drainMs = options.drainMs ?? 5_000;
  const closed = new Promise<number | null>((resolve, reject) => {
    let drain: NodeJS.Timeout | undefined;
    child.once("error", (error) => {
      clearTimeout(drain);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(drain);
      resolve(code);
    });
    child.once("exit", (code) => {
      // Normally `close` follows at once. If another process still holds the pipes, stop reading them and go on.
      drain = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve(code);
      }, drainMs);
      drain.unref();
    });
  });
  // A spawn failure is the caller's to see when it awaits `closed`; it is never an unhandled rejection on its own.
  closed.catch(() => {});
  const stop = async (graceMs = 10_000): Promise<number | null> => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), graceMs);
      timer.unref();
    });
    const first = await Promise.race([closed, late]);
    clearTimeout(timer);
    if (first !== "late") return first;
    child.kill("SIGKILL");
    return closed;
  };
  return { stdout, stderr, closed, stop };
}
