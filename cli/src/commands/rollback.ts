/**
 * `airprompter rollback`: make the previous release on this host live again,
 * now, without the control plane. The store keeps two slots; the other one
 * is the release this host served before, and flipping to it is instant and
 * offline. Flips the store directly — exactly what `ap.rollback()` does in
 * process. A runtime started after the flip serves the previous release; a
 * runtime already running on the same state directory keeps what it loaded
 * and moves with its own `ap.rollback()` — or, across a fleet, with a
 * rollback set in the customer's datastore (`docs/datastore.md`).
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
import { COMMON_OPTIONS, SCOPE_OPTIONS, STORE_OPTIONS, flag, helpFor, openStore, parse, scopeOf, str, type OptionSpec } from "../args.js";
import { EXIT, Output, refused, type Context } from "../io.js";

export const ROLLBACK_OPTIONS: OptionSpec = {
  agent: SCOPE_OPTIONS.agent!,
  environment: SCOPE_OPTIONS.environment!,
  org: { type: "string", help: "Organization id (optional for rollback)" },
  ...STORE_OPTIONS,
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
    // `release_staged`: the other slot is a release waiting for an unlock, not a previous one; `no_previous_release`:
    // this host has held one release only; `no_release`: nothing was ever applied. Each is a refusal by name.
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
  out.line(`rolled back to generation ${after} (slot ${slot}) from ${before}${forced ? "; a forced downgrade: reported on the next heartbeat, and sync holds generation " + before + " back" : ""}; a runtime started from now serves it (a runtime already running keeps what it loaded: it moves with its own ap.rollback(), or across a fleet with a rollback in the datastore)`);
  out.flush();
  return EXIT.ok;
}
