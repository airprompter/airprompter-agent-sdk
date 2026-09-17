/**
 * `airprompter doctor` (S14): every reason a host is not serving the release
 * it should, with the remedy next to it. Twelve checks, each `ok`, `warn`,
 * `fail` or `skip`, never a throw: the source (the API answers this key for
 * this agent and target; the edge pointer when named), the root, the store
 * (present, opens, active slot re-verifies as a runtime would), the lease,
 * the key protection, the spool against its budget (and quarantine), the
 * daemon (reachable and its healthz), the policy pin. Reads only — nothing
 * here creates a store, writes a file or sends a heartbeat. Exit 0 when no
 * check fails (warnings are printed, not fatal); `refused` (1) otherwise.
 *
 * @example
 * ```sh
 * AIRPROMPTER_AGENT_KEY=… airprompter doctor --org org_… --agent agt_… --environment prod --root ./airprompter-root.jwk.json
 * airprompter doctor --org org_… --agent agt_… --environment prod --json     # no key set: the source check is skipped, the host checks still run
 * ```
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { SyncClient } from "../../../sdk-typescript/packages/core/src/control/client.js";
import { instant } from "../../../sdk-typescript/packages/core/src/protocol/trust.js";
import { SlotStore, isStoreError } from "../../../sdk-typescript/packages/sync/src/store/slotStore.js";
import { fileKey } from "../../../sdk-typescript/packages/sync/src/store/keyProvider.js";
import { DaemonClient, daemonSocketPath } from "../../../sdk-typescript/packages/sync/src/sync/daemon.js";
import { HOST_SPOOL_BUDGET_BYTES } from "../../../sdk-typescript/packages/telemetry/src/spool/writer.js";
import { LAST_UPLOAD_MARKER } from "../../../sdk-typescript/packages/telemetry/src/uploader.js";
import { COMMON_OPTIONS, SCOPE_OPTIONS, STORE_OPTIONS, defaultStateDir, flag, helpFor, parse, scopeOf, str, type OptionSpec } from "../args.js";
import { summarizeManifest } from "../chain.js";
import { EXIT, Output, usage, type Context } from "../io.js";
import { loadRoot } from "../keys.js";
import { CLI_VERSION } from "../version.js";

export const DOCTOR_OPTIONS: OptionSpec = {
  ...SCOPE_OPTIONS,
  root: { type: "string", help: "Pinned root public JWK file or a signed root document, to check it parses (optional)" },
  ...STORE_OPTIONS,
  "base-url": { type: "string", default: "https://api.airprompter.com", help: "API base URL, asked for the manifest with the key in --api-key-env" },
  "api-key-env": { type: "string", default: "AIRPROMPTER_AGENT_KEY", help: "Environment variable holding the Agent key (never on argv); unset: the source check is skipped" },
  "edge-pointer-url": { type: "string", help: "The edge pointer to fetch, when the host uses one" },
  socket: { type: "string", help: "Daemon socket path to ask (default: the store's daemon.sock)" },
  "spool-budget-bytes": { type: "string", help: "The closed-segment budget the host runs with (default 104857600)" },
  ...COMMON_OPTIONS,
};

export type CheckLevel = "ok" | "warn" | "fail" | "skip";
export interface Check {
  name: string;
  level: CheckLevel;
  detail: string;
  remedy?: string;
}

const check = (name: string, level: CheckLevel, detail: string, remedy?: string): Check => ({ name, level, detail, ...(remedy ? { remedy } : {}) });

function spoolTree(dir: string): { segments: number; bytes: number; openSegments: number; quarantined: number; lastUpload: string | null } {
  const tree = { segments: 0, bytes: 0, openSegments: 0, quarantined: 0, lastUpload: null as string | null };
  if (!existsSync(dir)) return tree;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("seg-")) continue;
    if (name.endsWith(".open")) tree.openSegments += 1;
    else if (name.endsWith(".ndjson")) {
      tree.segments += 1;
      tree.bytes += statSync(join(dir, name)).size;
    }
  }
  const quarantine = join(dir, "quarantine");
  if (existsSync(quarantine)) tree.quarantined = readdirSync(quarantine).filter((n) => n.endsWith(".ndjson")).length;
  const marker = join(dir, LAST_UPLOAD_MARKER);
  if (existsSync(marker)) {
    const stamped = readFileSync(marker, "utf8").trim();
    tree.lastUpload = stamped && Number.isFinite(Date.parse(stamped)) ? stamped : new Date(statSync(marker).mtimeMs).toISOString();
  }
  return tree;
}

export async function doctor(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, DOCTOR_OPTIONS);
  if (flag(parsed, "help")) {
    ctx.stdout(helpFor("doctor", "--org … --agent … --environment … [--root …] [--state-dir …] [--base-url …]", DOCTOR_OPTIONS));
    return EXIT.ok;
  }
  const scope = scopeOf(parsed);
  const out = new Output(ctx, flag(parsed, "json"));
  const now = ctx.now();
  const checks: Check[] = [];
  const stateDir = str(parsed, "state-dir") ?? defaultStateDir(ctx);
  const budget = str(parsed, "spool-budget-bytes") !== undefined ? Number(str(parsed, "spool-budget-bytes")) : HOST_SPOOL_BUDGET_BYTES;
  if (!Number.isFinite(budget) || budget < 1) throw usage("--spool-budget-bytes must be a positive number");

  // 1. The source: does the API answer this key for this agent and target?
  const apiKeyEnv = str(parsed, "api-key-env") ?? "AIRPROMPTER_AGENT_KEY";
  const apiKey = ctx.env[apiKeyEnv];
  const baseUrl = str(parsed, "base-url") ?? "https://api.airprompter.com";
  if (!apiKey) checks.push(check("source", "skip", `${apiKeyEnv} is not set: the API was not asked (an offline host serves the store and a vendored bundle)`));
  else if (!ctx.fetch) checks.push(check("source", "skip", "no fetch in this runtime"));
  else {
    const client = new SyncClient({ baseUrl, agentId: scope.agentId, target: scope.target, apiKey, fetch: ctx.fetch, userAgent: `airprompter-cli/${CLI_VERSION}` });
    try {
      const answer = await client.manifest({});
      if (answer.status === "ok") checks.push(check("source", "ok", `${baseUrl} answers: generation ${answer.generation ?? answer.manifest.payload.generation} for ${scope.agentId}/${scope.target}`));
      else if (answer.status === "not_found") checks.push(check("source", "warn", `${baseUrl}: no release promoted yet for ${scope.agentId}/${scope.target}`, "promote a release in the console (or airprompter dev for a local registry)"));
      else if (answer.status === "unauthorized") checks.push(check("source", "fail", `${baseUrl} refused the key in ${apiKeyEnv} (401)`, `the Agent key in ${apiKeyEnv} is wrong, rotated or for another environment: issue one for ${scope.target} in the console`));
      else if (answer.status === "forbidden") checks.push(check("source", "fail", `${baseUrl}: forbidden (${answer.code ?? "no code"})`, answer.code === "agent_mismatch" ? `the key is for another agent: check --agent ${scope.agentId}` : answer.code === "target_mismatch" ? `the key is for another environment: check --environment ${scope.target}` : "the key does not cover this agent and environment"));
      else checks.push(check("source", "fail", `${baseUrl} answered ${answer.status === "error" ? answer.httpStatus : answer.status}`, "the API is unhealthy or a proxy answers in its place; try again, then check the base URL"));
    } catch (error) {
      checks.push(check("source", "fail", `${baseUrl} unreachable: ${(error as Error).message}`, "egress from this host to the API is blocked or the base URL is wrong; an air-gapped host runs from a vendored bundle instead"));
    }
    const pointerUrl = str(parsed, "edge-pointer-url");
    if (pointerUrl) {
      try {
        const pointer = await client.edgePointer(pointerUrl, null);
        if (pointer.status === "ok") checks.push(check("edge_pointer", "ok", `${pointerUrl}: generation ${pointer.pointer.generation}`));
        else checks.push(check("edge_pointer", "warn", `${pointerUrl}: ${pointer.status}`, "the runtime falls back to the manifest route; check the edge URL and its cache"));
      } catch (error) {
        checks.push(check("edge_pointer", "warn", `${pointerUrl} unreachable: ${(error as Error).message}`, "the runtime falls back to the manifest route; check the edge URL"));
      }
    }
  }

  // 2. The root.
  const rootPath = str(parsed, "root");
  if (!rootPath) checks.push(check("root", "skip", "--root not given: the root was not checked (the store carries its own)"));
  else if (!existsSync(rootPath)) checks.push(check("root", "fail", `${rootPath} does not exist`, "download the environment's root (a pinned public JWK or a signed root.json) from the console and pin it where the runtime reads it"));
  else {
    try {
      const root = loadRoot(rootPath, scope.target);
      if (root.kind === "pinned") checks.push(check("root", "ok", `${rootPath}: a pinned root public key`));
      else {
        const expires = root.document.signed.expires;
        const lapsed = instant(expires) <= now;
        checks.push(check("root", lapsed ? "fail" : "ok", `${rootPath}: root document version ${root.document.signed.version}, expires ${expires}${lapsed ? " (lapsed)" : ""}`, lapsed ? "fetch the rotated root document from the console; a runtime refuses a manifest under a lapsed root" : undefined));
      }
    } catch (error) {
      checks.push(check("root", "fail", `${rootPath}: ${(error as Error).message}`, "expected a pinned public JWK ({kty,crv,x,y}) or a signed root document"));
    }
  }

  // 3–6. The store, its active slot, the lease, the key protection.
  const storeDir = SlotStore.path({ stateDir, agentId: scope.agentId, target: scope.target });
  let store: SlotStore | null = null;
  if (!existsSync(join(storeDir, "store.json"))) checks.push(check("store", "fail", `no store at ${storeDir}`, `nothing has been applied on this host: airprompter pull … then airprompter apply …, or start a runtime / airprompterd with a key (this command never creates a store)`));
  else {
    try {
      store = await SlotStore.open({ stateDir, agentId: scope.agentId, target: scope.target, keyProvider: fileKey(join(storeDir, "store.key")), hooks: { writer: { name: "airprompter-cli", version: CLI_VERSION } } });
      checks.push(check("store", "ok", `${storeDir}: generation ${store.state.generation}, active slot ${store.state.active ?? "none"}${store.state.staged && store.state.staged !== store.state.active ? `, staged slot ${store.state.staged}` : ""}, written by ${store.state.writer?.name ?? "unknown"}`));
    } catch (error) {
      const code = isStoreError(error) ? error.code : "error";
      checks.push(check("store", "fail", `${storeDir}: ${(error as Error).message}`, code === "kek_unavailable" ? "the store key is missing or unreadable: the runtime that created the store holds it (an OS keystore, KMS, Vault or store.key next to the store); this command can only open a file-key store" : code === "store_corrupt" ? "store.json is unreadable: move the store aside and apply again; the runtime re-verifies on start" : "open the store with the runtime that created it"));
    }
  }
  if (store) {
    const state = store.state;
    if (!state.active) checks.push(check("active_release", "fail", "no active release", "airprompter apply … (or airprompter unlock when one is staged under unlock_required)"));
    else {
      try {
        const loaded = store.load(state.active, { now: new Date(now).toISOString(), root: state.root, expectGeneration: state.generation });
        const summary = summarizeManifest(loaded.manifest);
        checks.push(check("active_release", "ok", `slot ${state.active} verifies: generation ${summary.generation}, release ${summary.releaseDigest.slice(0, 19)}…, ${summary.slots} slots, signed by ${loaded.signingKeyId}`));
        const leaseFromIssue = instant(summary.issuedAt) + summary.leaseSeconds * 1000;
        if (leaseFromIssue <= now) checks.push(check("lease", "warn", `the lease (${summary.leaseSeconds}s) lapsed from issue at ${new Date(leaseFromIssue).toISOString()} → ${summary.onLeaseExpiry}; only a runtime or daemon in contact renews it`, summary.onLeaseExpiry === "halt" ? "a runtime with no contact refuses every render under halt: restore the source (above) or apply a fresh release" : "a runtime with no contact serves this release degraded: restore the source (above) or apply a fresh release"));
        else checks.push(check("lease", "ok", `${summary.leaseSeconds}s from the last contact (from issue it lapses ${new Date(leaseFromIssue).toISOString()}) → ${summary.onLeaseExpiry}`));
      } catch (error) {
        const reason = isStoreError(error) ? `${error.code}${error.detail ? `/${error.detail}` : ""}` : (error as Error).message;
        checks.push(check("active_release", "fail", `slot ${state.active} does not verify (${reason})`, "the runtime refuses this slot on start and falls back to the other slot or a vendored bundle: airprompter verify <state-dir> for the chain, then apply a fresh release"));
      }
    }
    if (store.storageProtection === "file_key") checks.push(check("key_protection", "warn", "file_key: the store key is a file next to the store (0600)", "use an OS keystore, KMS or Vault key provider where the host allows it (docs/key-handling.md)"));
    else checks.push(check("key_protection", "ok", store.storageProtection));
    // 6. The policy pin.
    const pin = state.applyPolicyPin ?? null;
    if (!pin) checks.push(check("policy_pin", "warn", "no apply policy pinned yet", "the first verified update pins it; airprompter policy set … pins one by hand (only this host loosens it)"));
    else checks.push(check("policy_pin", "ok", `${pin.value} (${pin.source === "operator" ? "set by an operator on this host" : `pinned from update ${pin.generation}`})`));
  }

  // 7. The spool against its budget.
  const spoolDir = join(storeDir, "spool", "telemetry");
  const tree = spoolTree(spoolDir);
  const share = tree.bytes / budget;
  const depth = `${tree.segments} unsent segment${tree.segments === 1 ? "" : "s"} (${tree.bytes} B, ${Math.round(share * 100)} % of the ${budget}-byte budget), ${tree.openSegments} open`;
  if (share >= 1) checks.push(check("spool", "warn", `${depth}: at the budget, the oldest are being dropped`, "nothing is uploading: check the source and the daemon (below), or airprompter export-telemetry on a host that never calls home"));
  else if (share >= 0.8) checks.push(check("spool", "warn", `${depth}: near the budget`, "uploads are not keeping up: check the source and the daemon (below)"));
  else checks.push(check("spool", "ok", depth));
  if (tree.quarantined > 0) checks.push(check("quarantine", "warn", `${tree.quarantined} quarantined segment${tree.quarantined === 1 ? "" : "s"} in ${join(spoolDir, "quarantine")}`, "a writer broke the spool contract: airprompter telemetry validate <segment> names the line and the field"));
  if (tree.segments > 0 && tree.lastUpload && now - instant(tree.lastUpload) > 24 * 3600 * 1000) checks.push(check("last_upload", "warn", `last upload ${tree.lastUpload}, over a day ago, with segments waiting`, "check the source and the daemon (below)"));
  else if (tree.lastUpload) checks.push(check("last_upload", "ok", tree.lastUpload));

  // 8. The daemon.
  const socketPath = str(parsed, "socket") ?? daemonSocketPath({ stateDir, agentId: scope.agentId, target: scope.target });
  if (!existsSync(socketPath)) checks.push(check("daemon", "skip", `none on this host (${socketPath}): SDKs sync in-process`));
  else {
    try {
      const client = await DaemonClient.connect({ socketPath, agentId: scope.agentId, target: scope.target, sdk: `airprompter-cli/${CLI_VERSION}`, timeoutMs: 3000 });
      if (!client) checks.push(check("daemon", "fail", `${socketPath} exists but is not ours to trust or does not answer`, "a stale socket from a dead daemon: restart airprompterd (it reclaims the socket)"));
      else {
        try {
          const healthz = (await client.request("healthz")) as { ok?: boolean; status?: string; reasons?: string[]; generation?: number };
          const status = (await client.request("status")) as { pid?: number; uptimeSeconds?: number; clients?: number; lastSyncAt?: string | null; lastSyncOutcome?: string | null };
          const detail = `pid ${status.pid}, up ${status.uptimeSeconds}s, ${status.clients} client${status.clients === 1 ? "" : "s"}, generation ${healthz.generation}, last sync ${status.lastSyncAt ?? "never"} (${status.lastSyncOutcome ?? "—"}); healthz ${healthz.status ?? (healthz.ok ? "ok" : "failing")}${healthz.reasons?.length ? `: ${healthz.reasons.join(", ")}` : ""}`;
          checks.push(check("daemon", healthz.ok === false ? "fail" : healthz.status === "degraded" ? "warn" : "ok", detail, healthz.ok === false ? "the daemon serves nothing: its log names why (no verified release, a lapsed lease under halt)" : healthz.status === "degraded" ? "the daemon is serving but something is off: its log and airprompter status say what" : undefined));
        } finally {
          client.close();
        }
      }
    } catch (error) {
      checks.push(check("daemon", "fail", `${socketPath}: ${(error as Error).message}`, "a stale socket from a dead daemon, or one another user runs: restart airprompterd"));
    }
  }

  // The verdict.
  const failed = checks.filter((c) => c.level === "fail");
  const warned = checks.filter((c) => c.level === "warn");
  for (const c of checks) {
    out.line(`${{ ok: "ok  ", warn: "warn", fail: "FAIL", skip: "skip" }[c.level]} ${c.name}: ${c.detail}`);
    if (c.remedy) out.line(`       → ${c.remedy}`);
  }
  out.set("checks", checks);
  out.set("ok", failed.length === 0);
  out.line(failed.length === 0 ? `doctor: ${warned.length === 0 ? "healthy" : `serving, ${warned.length} warning${warned.length === 1 ? "" : "s"}`}` : `doctor: ${failed.length} check${failed.length === 1 ? "" : "s"} failed${warned.length ? `, ${warned.length} warning${warned.length === 1 ? "" : "s"}` : ""}`);
  out.flush();
  return failed.length === 0 ? EXIT.ok : EXIT.refused;
}
