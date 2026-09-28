/**
 * `airprompter unlock`: make the staged release on this host live (T9,
 * D33). The operator's unlock — one of the three ways a release staged
 * under `unlock_required` activates (the others: the update window and the
 * runtime's `apply.onStaged` hook). Activates the store's staged slot
 * directly — a runtime started after that serves it; a runtime already
 * running on the same state directory keeps what it loaded and moves with
 * its own `ap.unlock()`, the window or the hook (the telemetry daemon holds
 * no store and serves no release, `protocol/daemon.md`).
 * `--generation N` refuses to unlock anything but generation N, so a change
 * ticket names exactly what went live.
 *
 * @example
 * ```sh
 * airprompter unlock --agent agt_… --environment prod --generation 12
 * ```
 */

import { isStoreError } from "../../../sdk-typescript/packages/sync/src/store/slotStore.js";
import { COMMON_OPTIONS, SCOPE_OPTIONS, STORE_OPTIONS, flag, helpFor, openStore, parse, scopeOf, str, type OptionSpec } from "../args.js";
import { CliError, EXIT, Output, refused, type Context } from "../io.js";

export const UNLOCK_OPTIONS: OptionSpec = {
  agent: SCOPE_OPTIONS.agent!,
  environment: SCOPE_OPTIONS.environment!,
  org: { type: "string", help: "Organization id (optional for unlock)" },
  generation: { type: "string", help: "Unlock only if the staged release is this generation (a change ticket names it)" },
  ...STORE_OPTIONS,
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
  out.line(`unlocked generation ${staged.generation} (slot ${slot}); a runtime started from now serves it (a runtime already running keeps what it loaded: it moves with its own ap.unlock(), the update window or its onStaged hook)`);
  out.flush();
  return EXIT.ok;
}
