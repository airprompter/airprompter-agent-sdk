/**
 * `airprompter status`: what the store on this host holds — active and
 * staged generation, lease, storage protection — and the telemetry: spool
 * depth, last upload, and the telemetry daemon as its discovery file says
 * (`protocol/daemon.md`). Reads only; the store's own verification runs on
 * the active slot so a corrupted host shows as such here before a runtime
 * finds out. A host with no store (the telemetry daemon's own container)
 * reports the telemetry alone. Exits `refused` (1) when the daemon's file is
 * stale — and, with `--require-daemon`, when there is none: the deploy
 * manifests' liveness probe.
 *
 * @example
 * ```sh
 * airprompter status --agent agt_… --environment prod
 * airprompter status --agent agt_… --environment prod --state-dir /var/lib/airprompter --json
 * airprompter status --agent agt_… --environment prod --require-daemon --json   # a liveness probe
 * ```
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { instant } from "../../../sdk-typescript/packages/core/src/protocol/trust.js";
import { isStoreError } from "../../../sdk-typescript/packages/sync/src/store/slotStore.js";
import { SlotStore } from "../../../sdk-typescript/packages/sync/src/store/slotStore.js";
import { nodeFs } from "../../../sdk-typescript/packages/core/src/ports/node.js";
import { readDaemonDiscovery } from "../../../sdk-typescript/packages/telemetry/src/spool/manifest.js";
import { LAST_UPLOAD_MARKER } from "../../../sdk-typescript/packages/telemetry/src/uploader.js";
import { COMMON_OPTIONS, SCOPE_OPTIONS, STORE_OPTIONS, defaultStateDir, flag, helpFor, openStore, parse, scopeOf, str, type OptionSpec } from "../args.js";
import { summarizeManifest } from "../chain.js";
import { EXIT, Output, refused, type Context } from "../io.js";

export const STATUS_OPTIONS: OptionSpec = {
  agent: SCOPE_OPTIONS.agent!,
  environment: SCOPE_OPTIONS.environment!,
  org: { type: "string", help: "Organization id (optional for status)" },
  ...STORE_OPTIONS,
  "require-daemon": { type: "boolean", help: "Exit 1 when no live telemetry daemon runs for this agent and target (a liveness probe)" },
  ...COMMON_OPTIONS,
};

function spoolDepth(dir: string): { segments: number; bytes: number; openSegments: number } {
  if (!existsSync(dir)) return { segments: 0, bytes: 0, openSegments: 0 };
  let segments = 0;
  let bytes = 0;
  let openSegments = 0;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("seg-")) continue;
    if (name.endsWith(".open")) openSegments += 1;
    else if (name.endsWith(".ndjson")) {
      segments += 1;
      bytes += statSync(join(dir, name)).size;
    }
  }
  return { segments, bytes, openSegments };
}

/** S6: acknowledged segments are deleted; the uploader stamps its last acknowledged upload in one marker file instead. */
function lastUpload(spoolDir: string): string | null {
  const marker = join(spoolDir, LAST_UPLOAD_MARKER);
  if (!existsSync(marker)) return null;
  const stamped = readFileSync(marker, "utf8").trim();
  return stamped && Number.isFinite(Date.parse(stamped)) ? stamped : new Date(statSync(marker).mtimeMs).toISOString();
}

export async function status(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, STATUS_OPTIONS);
  if (flag(parsed, "help")) {
    ctx.stdout(helpFor("status", "--agent … --environment … [--state-dir …]", STATUS_OPTIONS));
    return EXIT.ok;
  }
  const out = new Output(ctx, flag(parsed, "json"));
  const scope = scopeOf({ ...parsed, values: { ...parsed.values, org: parsed.values.org ?? "-" } });
  const stateDir = str(parsed, "state-dir") ?? defaultStateDir(ctx);
  const storeDir = SlotStore.path({ stateDir, agentId: scope.agentId, target: scope.target });
  const now = ctx.now();
  // A host with no store (the telemetry daemon's container) has telemetry to report and nothing else: never create one here.
  if (!existsSync(join(storeDir, "store.json"))) {
    out.field("store", null);
    out.line(`store: none at ${storeDir}`);
  } else {
    let store;
    try {
      store = await openStore(parsed, ctx, scope);
    } catch (error) {
      if (isStoreError(error)) throw refused(`store: ${error.message}`, { reason: error.code });
      throw error;
    }
    const state = store.state;
    out.field("store", store.dir);
    out.field("instanceId", state.instanceId, "instance");
    out.field("storageProtection", store.storageProtection, "storage protection");
    if (store.storageProtection === "file_key") out.line("note: the store key is a file next to the store; use an OS keystore, KMS or Vault key provider where the host allows it");
    out.field("activeSlot", state.active, "active slot");
    out.field("generation", state.generation);
    out.field("stagedSlot", state.staged, "staged slot");
    out.field("forcedDowngrade", state.forcedDowngrade === true, "forced downgrade");
    out.field("rootVersion", state.root?.signed.version ?? null, "root version");
    out.field("rootExpires", state.root?.signed.expires ?? null, "root expires");
    // S4: the apply policy is the host's; this is what store.json holds, whatever the console says.
    const pin = state.applyPolicyPin ?? null;
    out.field("applyPolicyPin", pin, "apply policy");
    out.line(pin ? `apply policy: ${pin.value} — ${pin.source === "operator" ? "set by an operator on this host" : `pinned from update ${pin.generation}; a later update may tighten it, never loosen it (airprompter policy set loosens)`}` : "apply policy: not pinned yet — the first verified update pins it");

    for (const [label, slot] of [["active", state.active], ["staged", state.staged]] as const) {
      if (!slot || (label === "staged" && slot === state.active)) continue;
      try {
        const loaded = store.load(slot, { now: new Date(now).toISOString(), root: state.root, ...(label === "active" ? { expectGeneration: state.generation } : {}) });
        const summary = summarizeManifest(loaded.manifest);
        const leaseFromIssue = new Date(instant(summary.issuedAt) + summary.leaseSeconds * 1000).toISOString();
        out.set(label, { slot, verified: true, ...summary, leaseExpiresAtFromIssue: leaseFromIssue });
        out.line(`${label}: slot ${slot}, generation ${summary.generation}, release ${summary.releaseDigest}, ${summary.slots} slots, policy ${summary.applyPolicy}, signed by ${loaded.signingKeyId}`);
        if (label === "active") {
          out.line(`lease: ${summary.leaseSeconds}s from the last contact (issued ${summary.issuedAt}; from issue it ${instant(leaseFromIssue) <= now ? "lapsed" : "lapses"} ${leaseFromIssue}) → ${summary.onLeaseExpiry}`);
          if (summary.directives.length) out.line(`directives: ${summary.directives.map((d) => `${d.kind}${d.scope ? ` ${d.scope}` : ""}${d.tag ? ` ${d.tag}` : ""}`).join(", ")}`);
        }
      } catch (error) {
        const reason = isStoreError(error) ? `${error.code}${error.detail ? `/${error.detail}` : ""}` : (error as Error).message;
        out.set(label, { slot, verified: false, reason });
        out.line(`${label}: slot ${slot} does not verify (${reason})`);
      }
    }
    if (!state.active) out.line("no active release: nothing has been applied on this host");
  }

  // The telemetry daemon, as its discovery file says; its folder is where the spool is.
  const found = readDaemonDiscovery(nodeFs, storeDir, { agentId: scope.agentId, target: scope.target, ...(scope.organizationId !== "-" ? { organizationId: scope.organizationId } : {}), nowMs: now });
  const spoolDir = found.live ? found.discovery.spoolDir : join(storeDir, "spool", "telemetry");
  const depth = spoolDepth(spoolDir);
  out.field("spoolDir", spoolDir, "spool dir");
  out.field("spool", depth, "spool");
  out.field("lastUpload", lastUpload(spoolDir), "last upload");
  let exit: number = EXIT.ok;
  if (found.live || found.reason === "stale") {
    const d = found.discovery!;
    out.set("daemon", { live: found.live, ...d });
    const u = d.upload;
    out.line(`daemon: airprompterd ${d.daemon.version} pid ${d.pid}, ${found.live ? "live" : "STALE"} (heartbeat ${d.heartbeatAt}), ships ${d.sink} from ${d.spoolDir} every ${d.uploadIntervalSeconds}s`);
    out.line(`upload: ${u.depthSegments} unsent (${u.depthBytes} B), last ${u.lastUploadAt ?? "never"}, sent ${u.sentSegments}, quarantined ${u.quarantinedSegments}, dropped ${u.droppedSegments}${u.backoffUntil ? `, backing off until ${u.backoffUntil}` : ""}`);
    if (!found.live) {
      out.line("the daemon's file is stale: it stopped without a clean exit; processes with a key upload their own spool until it is back");
      exit = EXIT.refused;
    }
  } else {
    out.set("daemon", found.reason === "absent" ? null : { error: found.reason });
    out.line(found.reason === "absent" ? "daemon: none on this host (processes with a key upload their own spool)" : `daemon: ${join(storeDir, "daemon.json")} is ${found.reason === "scope" ? "for another agent or target" : found.reason}`);
    if (flag(parsed, "require-daemon") || found.reason !== "absent") exit = EXIT.refused;
  }
  out.flush();
  return exit;
}
