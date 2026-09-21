/**
 * `airprompter pin <seal>`: write the pin sidecar (`pin.json`, `protocol/pins.md`) beside this host's store, so
 * the next SDK start on this state directory renders that named seal — a seal id (12 hex) or a full release
 * digest (`sha256:` + 64 hex) — instead of wherever the pointer has moved, while still obeying the environment's
 * live directives, lease and countersign requirement ("content pinned, control live"). This command never talks
 * to a running SDK or the daemon: a pin file is read only at `start()`, so an SDK already running on this state
 * directory keeps rendering what it started with until it restarts.
 *
 * @example
 * ```sh
 * airprompter pin a3a20ff4f7fb --agent agt_… --environment prod
 * airprompter pin sha256:a3a20ff4f7fb9c2e1d0… --agent agt_… --environment prod --state-dir /var/lib/acme
 * ```
 */

import { writePinFile } from "../../../sdk-typescript/packages/sync/src/sync/pin.js";
import { nodeFs } from "../../../sdk-typescript/packages/core/src/ports/node.js";
import { COMMON_OPTIONS, SCOPE_OPTIONS, STORE_OPTIONS, defaultStateDir, flag, helpFor, parse, scopeOf, str, type OptionSpec } from "../args.js";
import { CliError, EXIT, Output, type Context } from "../io.js";

/** The `?release=` grammar (`protocol/pins.md`, the same regex the fake control plane and the SDKs enforce): a full digest or at least 12 hex characters of one, an optional `sha256:` prefix. */
const SEAL_GRAMMAR = /^(sha256:)?[0-9a-fA-F]{12,64}$/;

export const PIN_OPTIONS: OptionSpec = {
  agent: SCOPE_OPTIONS.agent!,
  environment: SCOPE_OPTIONS.environment!,
  org: { type: "string", help: "Organization id (optional for pin)" },
  ...STORE_OPTIONS,
  ...COMMON_OPTIONS,
};

export async function pin(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, PIN_OPTIONS);
  if (flag(parsed, "help") || parsed.positionals.length !== 1) {
    ctx.stdout(helpFor("pin", "<seal> --agent … --environment … [--state-dir …]", PIN_OPTIONS));
    return flag(parsed, "help") ? EXIT.ok : EXIT.usage;
  }
  const release = parsed.positionals[0]!;
  if (!SEAL_GRAMMAR.test(release)) throw new CliError(EXIT.usage, `not a seal (12-64 hex, or "sha256:" + hex): ${release}`, { reason: "seal_invalid" });

  const out = new Output(ctx, flag(parsed, "json"));
  const scope = scopeOf({ ...parsed, values: { ...parsed.values, org: parsed.values.org ?? "-" } });
  const stateDir = str(parsed, "state-dir") ?? defaultStateDir(ctx);
  const pinnedAt = new Date(ctx.now()).toISOString();
  writePinFile(nodeFs, stateDir, scope.agentId, scope.target, { version: 1, release, pinnedAt, by: "cli" });

  const path = `${stateDir}/airprompter/${scope.agentId}/${scope.target}/pin.json`;
  out.field("release", release);
  out.field("pinnedAt", pinnedAt);
  out.field("path", path);
  out.line(`pinned ${release} at ${path}`);
  out.line("A running SDK reads pin.json only at start — restart it to take the pin.");
  out.flush();
  return EXIT.ok;
}
