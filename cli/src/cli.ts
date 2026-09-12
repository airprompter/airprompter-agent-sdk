/**
 * Dispatch. `run(argv, ctx)` is the whole program as a function: tests
 * call it with a fake fetch and captured output; `main.ts` calls it with
 * the process. Exit codes come from `EXIT`; a `CliError` is reported on
 * stderr (and as `{ ok: false, error, ... }` in `--json` mode).
 */

import { apply } from "./commands/apply.js";
import { daemon } from "./commands/daemon.js";
import { diff } from "./commands/diff.js";
import { keygen } from "./commands/keygen.js";
import { pull } from "./commands/pull.js";
import { status } from "./commands/status.js";
import { verify } from "./commands/verify.js";
import { CliError, EXIT, type Context } from "./io.js";
import { CLI_VERSION } from "./version.js";

const COMMANDS: Record<string, { run: (argv: string[], ctx: Context) => Promise<number>; summary: string }> = {
  pull: { run: pull, summary: "Fetch and verify the current release; write an encrypted .apbundle (--check compares the vendored one)" },
  verify: { run: verify, summary: "Run the verification chain on a bundle or a state directory and print the reasons" },
  apply: { run: apply, summary: "Stage a bundle into the store and activate it per the environment's policy" },
  status: { run: status, summary: "Active and staged generation, lease, storage protection, spool depth, last upload" },
  diff: { run: diff, summary: "What a bundle would change against the active release on this host" },
  keygen: { run: keygen, summary: "Generate a distribution or countersign keypair" },
  daemon: { run: daemon, summary: "airprompterd: one sync loop and one shared store per host, served to SDKs over a local socket" },
};

export function help(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length)) + 2;
  return [
    `airprompter ${CLI_VERSION} — run prompts approved in AirPrompter on your own systems`,
    "",
    "Usage: airprompter <command> [options]",
    "",
    ...Object.entries(COMMANDS).map(([name, entry]) => `  ${name.padEnd(width)}${entry.summary}`),
    "",
    "Every command takes --json (one document on stdout) and --help.",
    `Exit codes: ${EXIT.ok} ok · ${EXIT.refused} refused (reason on stderr) · ${EXIT.usage} usage · ${EXIT.stale} stale (pull --check)`,
    "Secrets are never taken on argv: the Agent key comes from AIRPROMPTER_AGENT_KEY (or --api-key-env), private keys from files.",
  ].join("\n");
}

export async function run(argv: string[], ctx: Context): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    ctx.stdout(help());
    return command ? EXIT.ok : EXIT.usage;
  }
  if (command === "--version" || command === "-V" || command === "version") {
    ctx.stdout(CLI_VERSION);
    return EXIT.ok;
  }
  const entry = COMMANDS[command];
  if (!entry) {
    ctx.stderr(`unknown command: ${command}`);
    ctx.stdout(help());
    return EXIT.usage;
  }
  const json = rest.includes("--json");
  try {
    return await entry.run(rest, ctx);
  } catch (error) {
    if (error instanceof CliError) {
      if (json) ctx.stdout(JSON.stringify({ ok: false, error: error.message, exitCode: error.exitCode, ...(error.detail ?? {}) }));
      ctx.stderr(`${error.exitCode === EXIT.usage ? "usage" : "refused"}: ${error.message}`);
      return error.exitCode;
    }
    const message = (error as Error).message ?? String(error);
    if (json) ctx.stdout(JSON.stringify({ ok: false, error: message, exitCode: EXIT.refused }));
    ctx.stderr(`error: ${message}`);
    return EXIT.refused;
  }
}
