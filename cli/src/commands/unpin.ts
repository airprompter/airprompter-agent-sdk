/**
 * `airprompter unpin`: remove the pin sidecar (`pin.json`) so the next SDK start on this state directory resumes
 * following the pointer — `pins.md`'s unpin re-bases the stored generation to the pointer's current one, so the
 * first live manifest after an unpin is never seen as a rollback merely because the pointer outran the pin. Like
 * `pin`, this command never talks to a running SDK: it only takes effect on the next start.
 *
 * @example
 * ```sh
 * airprompter unpin --agent agt_… --environment prod
 * ```
 */

import { clearPinFile, readPinFile } from "../../../sdk-typescript/packages/sync/src/sync/pin.js";
import { nodeFs } from "../../../sdk-typescript/packages/core/src/ports/node.js";
import { COMMON_OPTIONS, SCOPE_OPTIONS, STORE_OPTIONS, defaultStateDir, flag, helpFor, parse, scopeOf, str, type OptionSpec } from "../args.js";
import { EXIT, Output, type Context } from "../io.js";

export const UNPIN_OPTIONS: OptionSpec = {
  agent: SCOPE_OPTIONS.agent!,
  environment: SCOPE_OPTIONS.environment!,
  org: { type: "string", help: "Organization id (optional for unpin)" },
  ...STORE_OPTIONS,
  ...COMMON_OPTIONS,
};

export async function unpin(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, UNPIN_OPTIONS);
  if (flag(parsed, "help")) {
    ctx.stdout(helpFor("unpin", "--agent … --environment … [--state-dir …]", UNPIN_OPTIONS));
    return EXIT.ok;
  }
  const out = new Output(ctx, flag(parsed, "json"));
  const scope = scopeOf({ ...parsed, values: { ...parsed.values, org: parsed.values.org ?? "-" } });
  const stateDir = str(parsed, "state-dir") ?? defaultStateDir(ctx);
  const existing = readPinFile(nodeFs, stateDir, scope.agentId, scope.target);
  clearPinFile(nodeFs, stateDir, scope.agentId, scope.target);

  out.field("removed", existing !== null);
  out.field("release", existing?.release ?? null);
  out.line(existing ? `removed the pin to ${existing.release}` : "nothing was pinned on this host");
  out.line("A running SDK reads pin.json only at start — restart it to take the unpin.");
  out.flush();
  return EXIT.ok;
}
