/**
 * `airprompter policy`: the apply policy this host holds (S4). The policy
 * is the customer's: the first verified manifest pins it in store.json
 * (trust-on-first-use), a later manifest may tighten it (`auto` →
 * `unlock_required`) and never loosen it. Loosening is this command — an
 * operator's act on the host, logged in store.json, read by every runtime
 * that starts on it. `policy show` prints what is in force and where it came from;
 * `policy set auto|unlock_required` records the operator's choice.
 *
 * @example
 * ```sh
 * airprompter policy show --agent agt_… --environment prod
 * airprompter policy set auto --agent agt_… --environment prod --by "CHG-4821"
 * ```
 */

import { isStoreError } from "../../../sdk-typescript/packages/sync/src/store/slotStore.js";
import { COMMON_OPTIONS, SCOPE_OPTIONS, STORE_OPTIONS, flag, helpFor, openStore, parse, scopeOf, str, type OptionSpec } from "../args.js";
import { CliError, EXIT, Output, refused, type Context } from "../io.js";

export const POLICY_OPTIONS: OptionSpec = {
  agent: SCOPE_OPTIONS.agent!,
  environment: SCOPE_OPTIONS.environment!,
  org: { type: "string", help: "Organization id (optional for policy)" },
  by: { type: "string", help: "Who is making the change, for the log (a name or a ticket; never a secret)" },
  ...STORE_OPTIONS,
  ...COMMON_OPTIONS,
};

const SYNOPSIS = "show | set auto|unlock_required  --agent … --environment … [--by …] [--state-dir …]";

function describe(pin: { value: string; source: string } | null): string {
  if (!pin) return "not pinned yet: the first verified update will pin it";
  return `${pin.value} (${pin.source === "operator" ? "set by an operator on this host" : "pinned from a signed update; a later update may tighten it, never loosen it"})`;
}

export async function policy(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, POLICY_OPTIONS);
  if (flag(parsed, "help")) {
    ctx.stdout(helpFor("policy", SYNOPSIS, POLICY_OPTIONS));
    return EXIT.ok;
  }
  const [verb, wanted] = parsed.positionals;
  if (verb !== "show" && verb !== "set") throw new CliError(EXIT.usage, `policy takes "show" or "set auto|unlock_required"`);
  if (verb === "set" && wanted !== "auto" && wanted !== "unlock_required") throw new CliError(EXIT.usage, "policy set takes auto or unlock_required");
  const out = new Output(ctx, flag(parsed, "json"));
  const scope = scopeOf({ ...parsed, values: { ...parsed.values, org: parsed.values.org ?? "-" } });
  const by = str(parsed, "by");

  let store;
  try {
    store = await openStore(parsed, ctx, scope);
  } catch (error) {
    if (isStoreError(error)) throw refused(`store: ${error.message}`, { reason: error.code });
    throw error;
  }
  const before = store.state.applyPolicyPin ?? null;
  if (verb === "set") {
    store.pinApplyPolicy({ value: wanted as "auto" | "unlock_required", source: "operator", generation: before?.generation ?? 0, setAt: new Date(ctx.now()).toISOString() });
    out.field("via", "store");
    out.field("previous", before);
    out.field("applyPolicy", store.state.applyPolicyPin, "apply policy");
    out.line(`policy set to ${wanted} on this host (was ${before ? `${before.value}, ${before.source}` : "not pinned"}); a runtime started from now runs under it (a runtime already running keeps its policy until it restarts or calls ap.setApplyPolicy())`);
    out.flush();
    return EXIT.ok;
  }
  out.field("via", "store");
  out.field("applyPolicy", before, "apply policy");
  out.line(`pinned: ${describe(before)}`);
  out.flush();
  return EXIT.ok;
}
