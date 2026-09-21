/**
 * `airprompter mirror status` / `airprompter mirror resync --approve <who>`: the CLI's read-only window onto a
 * customer's own mirror of a release (`protocol/pins.md` › "Customer-store seal", `sdk-typescript/packages/sdk/src/mirror.ts`).
 * A mirror is application state — a config row, a database, a file in the application's own deploy — that only the
 * SDK in that process ever writes, on its own initiative once (materialise) or on the application's explicit
 * `ap.mirror(port).resync({ approvedBy })` call; there is no host-local copy of the customer's store this tool
 * could open, and no daemon operation that resyncs one. `status` reports what this host itself can see: the pin
 * file (if any) and the store's own active release, so a support engineer can compare that against what the
 * heartbeat's `seal` member says. `resync` always refuses — on purpose, see below.
 *
 * @example
 * ```sh
 * airprompter mirror status --agent agt_… --environment prod
 * airprompter mirror resync --approve ops@acme.example --agent agt_… --environment prod   # refused: see the message
 * ```
 */

import { sealIdOf } from "../../../sdk-typescript/packages/core/src/protocol/seal.js";
import { isStoreError } from "../../../sdk-typescript/packages/sync/src/store/slotStore.js";
import { readPinFile } from "../../../sdk-typescript/packages/sync/src/sync/pin.js";
import { nodeFs } from "../../../sdk-typescript/packages/core/src/ports/node.js";
import { COMMON_OPTIONS, SCOPE_OPTIONS, STORE_OPTIONS, defaultStateDir, flag, helpFor, openStore, parse, scopeOf, str, type OptionSpec } from "../args.js";
import { CliError, EXIT, Output, refused, type Context } from "../io.js";

const RESYNC_REFUSAL = "Re-sync runs inside the application that owns the store: call ap.mirror(port).resync({ approvedBy }) — the CLI never rewrites a customer store.";

export const MIRROR_STATUS_OPTIONS: OptionSpec = {
  agent: SCOPE_OPTIONS.agent!,
  environment: SCOPE_OPTIONS.environment!,
  org: { type: "string", help: "Organization id (optional for mirror status)" },
  ...STORE_OPTIONS,
  ...COMMON_OPTIONS,
};

export const MIRROR_RESYNC_OPTIONS: OptionSpec = {
  agent: SCOPE_OPTIONS.agent!,
  environment: SCOPE_OPTIONS.environment!,
  org: { type: "string", help: "Organization id (optional for mirror resync)" },
  approve: { type: "string", help: "Who is approving the re-sync (required — still refused, see the message)" },
  ...STORE_OPTIONS,
  ...COMMON_OPTIONS,
};

async function status(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, MIRROR_STATUS_OPTIONS);
  if (flag(parsed, "help")) {
    ctx.stdout(helpFor("mirror status", "--agent … --environment … [--state-dir …]", MIRROR_STATUS_OPTIONS));
    return EXIT.ok;
  }
  const out = new Output(ctx, flag(parsed, "json"));
  const scope = scopeOf({ ...parsed, values: { ...parsed.values, org: parsed.values.org ?? "-" } });
  const stateDir = str(parsed, "state-dir") ?? defaultStateDir(ctx);
  const pinFile = readPinFile(nodeFs, stateDir, scope.agentId, scope.target);
  out.field("pin", pinFile);
  out.line(pinFile ? `pinned: ${pinFile.release} (by ${pinFile.by}, at ${pinFile.pinnedAt})` : "not pinned");

  let store;
  try {
    store = await openStore(parsed, ctx, scope);
  } catch (error) {
    if (isStoreError(error)) throw refused(`store: ${error.message}`, { reason: error.code });
    throw error;
  }
  if (!store.state.active) {
    out.field("activeSealId", null, "active seal");
    out.line("no active release on this host");
  } else {
    const active = store.load(store.state.active, { now: new Date(ctx.now()).toISOString(), root: store.state.root, expectGeneration: store.state.generation });
    const sealId = sealIdOf(active.manifest.payload.releaseDigest);
    out.field("activeSealId", sealId, "active seal");
    out.field("activeReleaseDigest", active.manifest.payload.releaseDigest, "active release digest");
    out.line(`active seal: ${sealId} (${active.manifest.payload.releaseDigest})`);
  }
  out.line("The runtime reports drift on its heartbeat; see the Fleet tab. There is no local record of a mirror's last report here — the mirror lives in the application's own store, never on this host.");
  out.flush();
  return EXIT.ok;
}

async function resync(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, MIRROR_RESYNC_OPTIONS);
  if (flag(parsed, "help")) {
    ctx.stdout(helpFor("mirror resync", "--approve <who> --agent … --environment …", MIRROR_RESYNC_OPTIONS));
    return EXIT.ok;
  }
  const approve = str(parsed, "approve");
  if (approve === undefined || approve === "") throw new CliError(EXIT.usage, "--approve <who> is required (and is still refused — the CLI never re-syncs a customer's mirror)");
  throw new CliError(EXIT.usage, RESYNC_REFUSAL);
}

export async function mirror(argv: string[], ctx: Context): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === "status") return status(rest, ctx);
  if (verb === "resync") return resync(rest, ctx);
  throw new CliError(EXIT.usage, `mirror takes "status" or "resync --approve <who>"`);
}
