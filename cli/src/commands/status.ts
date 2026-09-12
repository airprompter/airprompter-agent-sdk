/**
 * `airprompter status`: what the store on this host holds — active and
 * staged generation, lease, storage protection, spool depth, last upload.
 * Reads only; the store's own verification runs on the active slot so a
 * corrupted host shows as such here before a runtime finds out.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { instant } from "../../../sdk-typescript/src/protocol/trust.js";
import { StoreError } from "../../../sdk-typescript/src/store/slotStore.js";
import { DaemonClient, daemonSocketPath } from "../../../sdk-typescript/src/sync/daemon.js";
import { CLI_VERSION } from "../version.js";
import { COMMON_OPTIONS, SCOPE_OPTIONS, STORE_OPTIONS, defaultStateDir, flag, helpFor, openStore, parse, scopeOf, str, type OptionSpec } from "../args.js";
import { summarizeManifest } from "../chain.js";
import { EXIT, Output, refused, type Context } from "../io.js";

export const STATUS_OPTIONS: OptionSpec = {
  agent: SCOPE_OPTIONS.agent!,
  environment: SCOPE_OPTIONS.environment!,
  org: { type: "string", help: "Organization id (optional for status)" },
  ...STORE_OPTIONS,
  socket: { type: "string", help: "Daemon socket path to ask (default: the store's daemon.sock when present)" },
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

function lastUpload(sentDir: string): string | null {
  if (!existsSync(sentDir)) return null;
  let newest = 0;
  for (const name of readdirSync(sentDir)) newest = Math.max(newest, statSync(join(sentDir, name)).mtimeMs);
  return newest ? new Date(newest).toISOString() : null;
}

export async function status(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, STATUS_OPTIONS);
  if (flag(parsed, "help")) {
    ctx.stdout(helpFor("status", "--agent … --environment … [--state-dir …]", STATUS_OPTIONS));
    return EXIT.ok;
  }
  const out = new Output(ctx, flag(parsed, "json"));
  const scope = scopeOf({ ...parsed, values: { ...parsed.values, org: parsed.values.org ?? "-" } });
  let store;
  try {
    store = await openStore(parsed, ctx, scope);
  } catch (error) {
    if (error instanceof StoreError) throw refused(`store: ${error.message}`, { reason: error.code });
    throw error;
  }
  const state = store.state;
  const now = ctx.now();
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
      const reason = error instanceof StoreError ? `${error.code}${error.detail ? `/${error.detail}` : ""}` : (error as Error).message;
      out.set(label, { slot, verified: false, reason });
      out.line(`${label}: slot ${slot} does not verify (${reason})`);
    }
  }
  if (!state.active) out.line("no active release: nothing has been applied on this host");

  const spoolDir = join(store.dir, "spool", "telemetry");
  const depth = spoolDepth(spoolDir);
  out.field("spool", depth, "spool");
  out.field("lastUpload", lastUpload(join(spoolDir, "sent")), "last upload");

  // A daemon on this host knows what the store cannot: last sync, backoff, attached clients.
  const socketPath = str(parsed, "socket") ?? daemonSocketPath({ stateDir: str(parsed, "state-dir") ?? defaultStateDir(ctx), agentId: scope.agentId, target: scope.target });
  try {
    const client = await DaemonClient.connect({ socketPath, agentId: scope.agentId, target: scope.target, sdk: `airprompter-cli/${CLI_VERSION}` });
    if (client) {
      try {
        const daemon = await client.request("status");
        out.set("daemon", daemon);
        out.line(`daemon: ${daemon.daemon} pid ${daemon.pid}, up ${daemon.uptimeSeconds}s, ${daemon.clients} client${daemon.clients === 1 ? "" : "s"}, last sync ${daemon.lastSyncAt ?? "never"} (${daemon.lastSyncOutcome ?? "—"}), ${daemon.consecutiveFailures} consecutive failure${daemon.consecutiveFailures === 1 ? "" : "s"}, next ${daemon.nextSyncAt ?? "—"}, rss ${Math.round(Number(daemon.rssBytes) / 1048576)} MiB`);
      } finally {
        client.close();
      }
    } else {
      out.set("daemon", null);
      out.line("daemon: none on this host (SDKs sync in-process)");
    }
  } catch (error) {
    out.set("daemon", { error: (error as Error).message });
    out.line(`daemon: ${(error as Error).message}`);
  }
  out.flush();
  return EXIT.ok;
}
