/**
 * What every command shares: the exit-code contract, the two output modes
 * (human lines or one JSON document), and the rule that nothing printed
 * ever includes payload text. `Context` is what tests inject.
 */

import type { FetchLike } from "../../sdk-typescript/src/sync/client.js";
import { errorNamed } from "../../sdk-typescript/src/protocol/errors.js";

/** Exit codes are the CI contract: scripts branch on them, never on text. */
export const EXIT = {
  ok: 0,
  /** The command ran and refused: verification failed, apply refused, a fetch was denied. Reason on stderr / in `error`. */
  refused: 1,
  usage: 2,
  /** `pull --check`: the vendored bundle is more than `--max-behind` generations behind. */
  stale: 3,
} as const;

export class CliError extends Error {
  /** Identity as data (see `isCliError`); the exit code is the meaning. */
  readonly code = "cli" as const;
  constructor(
    readonly exitCode: number,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** `CliError` by name and code — the CLI links the SDK by path today and by package tomorrow; neither may rely on the class. */
export function isCliError(error: unknown): error is CliError {
  return errorNamed(error, "CliError") && typeof (error as { exitCode?: unknown }).exitCode === "number";
}

export const usage = (message: string): CliError => new CliError(EXIT.usage, message);
export const refused = (message: string, detail?: Record<string, unknown>): CliError => new CliError(EXIT.refused, message, detail);

export interface Context {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  now: () => number;
  fetch: FetchLike | null;
  /** Reads a secret from the terminal when a command must not take it on argv. Null on a non-interactive host. */
  isTTY: boolean;
}

export function defaultContext(): Context {
  return {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    cwd: process.cwd(),
    now: () => Date.now(),
    fetch: (globalThis.fetch as unknown as FetchLike) ?? null,
    isTTY: Boolean(process.stdout.isTTY),
  };
}

/** One document per invocation in `--json` mode; key/value lines otherwise. */
export class Output {
  private readonly document: Record<string, unknown> = {};
  constructor(
    private readonly ctx: Context,
    readonly json: boolean,
  ) {}

  set(key: string, value: unknown): void {
    this.document[key] = value;
  }

  /** A human line. Ignored in JSON mode (the document carries the facts). */
  line(text: string): void {
    if (!this.json) this.ctx.stdout(text);
  }

  field(key: string, value: unknown, label = key): void {
    this.set(key, value);
    this.line(`${label}: ${formatValue(value)}`);
  }

  flush(extra: Record<string, unknown> = {}): void {
    if (this.json) this.ctx.stdout(JSON.stringify({ ...this.document, ...extra }));
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.length ? value.map(formatValue).join(", ") : "none";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function requireOption<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === "") throw usage(`--${name} is required`);
  return value;
}
