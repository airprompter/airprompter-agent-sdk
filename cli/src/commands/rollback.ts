/**
 * `airprompter rollback`: make the previous release on this host live again,
 * now, without the control plane. The store keeps two slots; the other one
 * is the release this host served before, and flipping to it is instant and
 * offline. Goes through the host daemon when one runs (so every attached SDK
 * switches at once); otherwise flips the store directly, which a resident
 * SDK notices on its next pass — exactly what `ap.rollback()` does in
 * process.
 *
 * The rules a rollback keeps: a step BELOW the stored generation is a forced
 * downgrade, recorded in `store.json` (`forcedDowngrade`) and reported on the
 * next heartbeat as evidence; sync then holds that generation and older back
 * (`heldBackBelow`) until the control plane moves past it, so the release
 * you stepped away from does not come straight back. The fleet-wide undo is
 * the console's rollback, which seals a new generation; this is the host's.
 *
 * @example
 * ```sh
 * airprompter rollback --agent agt_… --environment prod
 * airprompter rollback --agent agt_… --environment prod --state-dir /var/lib/acme --json
 * ```
 */

import { isStoreError } from "../../../sdk-typescript/packages/sync/src/store/slotStore.js";
import { DaemonClient, daemonSocketPath } from "../../../sdk-typescript/packages/sync/src/sync/daemon.js";
import { CLI_VERSION } from "../version.js";
import { COMMON_OPTIONS, SCOPE_OPTIONS, STORE_OPTIONS, defaultStateDir, flag, helpFor, openStore, parse, scopeOf, str, type OptionSpec } from "../args.js";
import { EXIT, Output, refused, type Context } from "../io.js";

export const ROLLBACK_OPTIONS: OptionSpec = {
  agent: SCOPE_OPTIONS.agent!,
  environment: SCOPE_OPTIONS.environment!,
  org: { type: "string", help: "Organization id (optional for rollback)" },
  ...STORE_OPTIONS,
  socket: { type: "string", help: "Daemon socket path (default: the store's daemon.sock when present)" },
  ...COMMON_OPTIONS,
};

export async function rollback(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, ROLLBACK_OPTIONS);
  if (flag(parsed, "help")) {
    ctx.stdout(helpFor("rollback", "--agent … --environment … [--state-dir …]", ROLLBACK_OPTIONS));
    return EXIT.ok;
  }
  const out = new Output(ctx, flag(parsed, "json"));
  const scope = scopeOf({ ...parsed, values: { ...parsed.values, org: parsed.values.org ?? "-" } });

  // The daemon first: it holds the store on a shared host, and every attached SDK follows its switch.
  const socketPath = str(parsed, "socket") ?? daemonSocketPath({ stateDir: str(parsed, "state-dir") ?? defaultStateDir(ctx), agentId: scope.agentId, target: scope.target });
  const client = await DaemonClient.connect({ socketPath, agentId: scope.agentId, target: scope.target, sdk: `airprompter-cli/${CLI_VERSION}` }).catch(() => null);
  if (client) {
    try {
      const result = (await client.request("rollback")) as { generation: number; forced: boolean };
      out.field("via", "daemon");
      out.field("generation", result.generation);
      out.field("forced", result.forced);
      out.field("outcome", "rolled_back");
      out.line(`rolled back to generation ${result.generation} through the daemon${result.forced ? " (a forced downgrade: reported on the next heartbeat, and sync holds the newer generation back)" : ""}; every attached runtime switches now`);
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
  const before = store.state.generation;
  let slot;
  try {
    slot = store.rollbackLocal();
  } catch (error) {
    // The store has only ever held one release: there is nothing to go back to.
    if (isStoreError(error)) throw refused(`store: ${error.message}`, { reason: error.code });
    throw error;
  }
  const after = store.state.generation;
  const forced = after < before;
  out.field("via", "store");
  out.field("slot", slot);
  out.field("generation", after);
  out.field("previousGeneration", before, "previous generation");
  out.field("forced", forced);
  out.field("outcome", "rolled_back");
  out.line(`rolled back to generation ${after} (slot ${slot}) from ${before}${forced ? "; a forced downgrade: reported on the next heartbeat, and sync holds generation " + before + " back" : ""}; a resident runtime picks it up on its next pass`);
  out.flush();
  return EXIT.ok;
}
