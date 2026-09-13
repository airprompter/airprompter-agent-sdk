/**
 * `airprompter unlock`: make the staged release on this host live (T9,
 * D33). The operator's unlock — one of the three ways a release staged
 * under `unlock_required` activates (the others: the update window and the
 * runtime's `apply.onStaged` hook). Goes through the host daemon when one
 * runs (so every attached SDK switches at once); otherwise activates the
 * store's staged slot directly, which a resident SDK notices on its next
 * pass. `--generation N` refuses to unlock anything but generation N, so a
 * change ticket names exactly what went live.
 */

import { isStoreError } from "../../../sdk-typescript/src/store/slotStore.js";
import { DaemonClient, daemonSocketPath } from "../../../sdk-typescript/src/sync/daemon.js";
import { CLI_VERSION } from "../version.js";
import { COMMON_OPTIONS, SCOPE_OPTIONS, STORE_OPTIONS, defaultStateDir, flag, helpFor, openStore, parse, scopeOf, str, type OptionSpec } from "../args.js";
import { CliError, EXIT, Output, refused, type Context } from "../io.js";

export const UNLOCK_OPTIONS: OptionSpec = {
  agent: SCOPE_OPTIONS.agent!,
  environment: SCOPE_OPTIONS.environment!,
  org: { type: "string", help: "Organization id (optional for unlock)" },
  generation: { type: "string", help: "Unlock only if the staged release is this generation (a change ticket names it)" },
  ...STORE_OPTIONS,
  socket: { type: "string", help: "Daemon socket path (default: the store's daemon.sock when present)" },
  ...COMMON_OPTIONS,
};

export async function unlock(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, UNLOCK_OPTIONS);
  if (flag(parsed, "help")) {
    ctx.stdout(helpFor("unlock", "--agent … --environment … [--generation N] [--state-dir …]", UNLOCK_OPTIONS));
    return EXIT.ok;
  }
  const out = new Output(ctx, flag(parsed, "json"));
  const scope = scopeOf({ ...parsed, values: { ...parsed.values, org: parsed.values.org ?? "-" } });
  const wanted = str(parsed, "generation");
  const wantedGeneration = wanted === undefined ? null : Number(wanted);
  if (wantedGeneration !== null && (!Number.isInteger(wantedGeneration) || wantedGeneration < 1)) throw new CliError(EXIT.usage, "--generation must be a positive integer");

  // The daemon first: it holds the store on a shared host, and every attached SDK follows its switch.
  const socketPath = str(parsed, "socket") ?? daemonSocketPath({ stateDir: str(parsed, "state-dir") ?? defaultStateDir(ctx), agentId: scope.agentId, target: scope.target });
  const client = await DaemonClient.connect({ socketPath, agentId: scope.agentId, target: scope.target, sdk: `airprompter-cli/${CLI_VERSION}` }).catch(() => null);
  if (client) {
    try {
      const status = await client.request("status");
      const staged = typeof status.stagedGeneration === "number" ? status.stagedGeneration : null;
      if (staged === null) throw refused("nothing is staged on this host", { reason: "not_staged" });
      if (wantedGeneration !== null && staged !== wantedGeneration) throw refused(`generation ${staged} is staged, not ${wantedGeneration}`, { reason: "generation_mismatch", staged });
      const result = await client.request("unlock");
      out.field("via", "daemon");
      out.field("generation", result.generation);
      out.field("outcome", "activated");
      out.line(`unlocked generation ${String(result.generation)} through the daemon; every attached runtime switches now`);
      out.flush();
      return EXIT.ok;
    } finally {
      client.close();
    }
  }

  let store;
  try {
    store = await openStore(parsed, ctx, scope);
  } catch (error) {
    if (isStoreError(error)) throw refused(`store: ${error.message}`, { reason: error.code });
    throw error;
  }
  const state = store.state;
  if (!state.staged || state.staged === state.active) throw refused("nothing is staged on this host", { reason: "not_staged" });
  const staged = store.load(state.staged, { now: new Date(ctx.now()).toISOString(), root: state.root });
  if (wantedGeneration !== null && staged.generation !== wantedGeneration) throw refused(`generation ${staged.generation} is staged, not ${wantedGeneration}`, { reason: "generation_mismatch", staged: staged.generation });
  const slot = store.activate();
  out.field("via", "store");
  out.field("slot", slot);
  out.field("generation", staged.generation);
  out.field("previousGeneration", state.generation, "previous generation");
  out.field("outcome", "activated");
  out.line(`unlocked generation ${staged.generation} (slot ${slot}); a resident runtime picks it up on its next pass`);
  out.flush();
  return EXIT.ok;
}
