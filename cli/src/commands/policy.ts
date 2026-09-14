/**
 * `airprompter policy`: the apply policy this host holds (S4). The policy
 * is the customer's: the first verified manifest pins it in store.json
 * (trust-on-first-use), a later manifest may tighten it (`auto` →
 * `unlock_required`) and never loosen it. Loosening is this command — an
 * operator's act on the host, logged, host-wide through the daemon when
 * one runs. `policy show` prints what is in force and where it came from;
 * `policy set auto|unlock_required` records the operator's choice.
 */

import { isStoreError } from "../../../sdk-typescript/packages/sync/src/store/slotStore.js";
import { DaemonClient, daemonSocketPath } from "../../../sdk-typescript/packages/sync/src/sync/daemon.js";
import { CLI_VERSION } from "../version.js";
import { COMMON_OPTIONS, SCOPE_OPTIONS, STORE_OPTIONS, defaultStateDir, flag, helpFor, openStore, parse, scopeOf, str, type OptionSpec } from "../args.js";
import { CliError, EXIT, Output, refused, type Context } from "../io.js";

export const POLICY_OPTIONS: OptionSpec = {
  agent: SCOPE_OPTIONS.agent!,
  environment: SCOPE_OPTIONS.environment!,
  org: { type: "string", help: "Organization id (optional for policy)" },
  by: { type: "string", help: "Who is making the change, for the log (a name or a ticket; never a secret)" },
  ...STORE_OPTIONS,
  socket: { type: "string", help: "Daemon socket path (default: the store's daemon.sock when present)" },
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

  // The daemon first: it holds the store on a shared host, and every attached SDK adopts its policy at once.
  const socketPath = str(parsed, "socket") ?? daemonSocketPath({ stateDir: str(parsed, "state-dir") ?? defaultStateDir(ctx), agentId: scope.agentId, target: scope.target });
  const client = await DaemonClient.connect({ socketPath, agentId: scope.agentId, target: scope.target, sdk: `airprompter-cli/${CLI_VERSION}` }).catch(() => null);
  if (client) {
    try {
      const answer = verb === "set" ? await client.request("policy", { value: wanted, ...(by ? { by } : {}) }) : await client.request("status");
      const applyPolicy = answer.applyPolicy as { effective: string; source: string; manifestSaid: string | null };
      out.field("via", "daemon");
      out.field("applyPolicy", applyPolicy, "apply policy");
      if (verb === "set") out.line(`policy set to ${wanted} through the daemon; every attached runtime runs under it now`);
      out.line(`in force: ${applyPolicy.effective} (${applyPolicy.source})${applyPolicy.manifestSaid && applyPolicy.manifestSaid !== applyPolicy.effective ? ` — the console asked for ${applyPolicy.manifestSaid}; that setting is advisory on this host` : ""}`);
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
  const before = store.state.applyPolicyPin ?? null;
  if (verb === "set") {
    store.pinApplyPolicy({ value: wanted as "auto" | "unlock_required", source: "operator", generation: before?.generation ?? 0, setAt: new Date(ctx.now()).toISOString() });
    out.field("via", "store");
    out.field("previous", before);
    out.field("applyPolicy", store.state.applyPolicyPin, "apply policy");
    out.line(`policy set to ${wanted} on this host (was ${before ? `${before.value}, ${before.source}` : "not pinned"}); a resident runtime reads it on its next pass`);
    out.flush();
    return EXIT.ok;
  }
  out.field("via", "store");
  out.field("applyPolicy", before, "apply policy");
  out.line(`pinned: ${describe(before)}`);
  out.flush();
  return EXIT.ok;
}
