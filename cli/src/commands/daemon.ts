/**
 * `airprompter daemon` (`airprompterd`): the host's telemetry daemon
 * (`protocol/daemon.md`, draft 3). It ships the spool that SDK processes
 * on this host write — to AirPrompter under a grant per writer, or to the
 * customer's OpenTelemetry collector — and does nothing else: it syncs no
 * release, holds no store and no store key, and serves nothing. SDK
 * processes find it through the discovery file it publishes
 * (`<store dir>/daemon.json`, refreshed every minute) and add a manifest
 * beside every segment they close; the daemon reads each manifest, leaves
 * another agent's or target's segments alone, quarantines a segment that
 * does not match its manifest, and sends the writer's own report to obtain
 * that writer's grant. Logs are one JSON object per line on stderr, never
 * with prompt text. Stops on SIGINT / SIGTERM, deleting its discovery file.
 *
 * @example
 * ```sh
 * AIRPROMPTER_AGENT_KEY=… airprompter daemon --org org_… --agent agt_… --environment prod --json
 * airprompter daemon --org org_… --agent agt_… --environment prod --upload-sink otlp --otlp-endpoint http://localhost:4318/v1/metrics
 * ```
 */

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { SyncClient } from "../../../sdk-typescript/packages/core/src/control/client.js";
import { SlotStore } from "../../../sdk-typescript/packages/sync/src/store/slotStore.js";
import { DAEMON_DISCOVERY_REFRESH_MS, removeDaemonDiscovery, writeDaemonDiscovery, type DaemonDiscovery } from "../../../sdk-typescript/packages/telemetry/src/spool/manifest.js";
import { SpoolUploader, type GrantDecision, type UploadGrant } from "../../../sdk-typescript/packages/telemetry/src/uploader.js";
import { otlpUploadSink } from "../../../sdk-typescript/packages/otel-bridge/src/sink.js";
import { nodeFs } from "../../../sdk-typescript/packages/core/src/ports/node.js";
import type { UploadSink } from "../../../sdk-typescript/packages/core/src/telemetry/uploadSink.js";
import { COMMON_OPTIONS, SCOPE_OPTIONS, STORE_OPTIONS, defaultStateDir, flag, helpFor, parse, scopeOf, str, type OptionSpec } from "../args.js";
import { EXIT, refused, usage, type Context } from "../io.js";
import { CLI_VERSION, PROTOCOL_VERSION } from "../version.js";

/** Flags of the release-serving daemon that 0.3.0 removed: refused by name, so a stale unit file says what changed. */
const REMOVED_FLAGS = ["root", "hosted-environment", "root-url", "edge-pointer-url", "poll-seconds", "socket", "apply-policy"] as const;

export const DAEMON_OPTIONS: OptionSpec = {
  org: SCOPE_OPTIONS.org!,
  agent: SCOPE_OPTIONS.agent!,
  environment: SCOPE_OPTIONS.environment!,
  ...STORE_OPTIONS,
  "spool-dir": { type: "string", help: "The folder to scan and publish (default: <store dir>/spool/telemetry, where SDKs write by default)" },
  "api-key-env": { type: "string", default: "AIRPROMPTER_AGENT_KEY", help: "Environment variable holding the Agent key (for upload grants only)" },
  "base-url": { type: "string", default: "https://api.airprompter.com", help: "API base URL" },
  "upload-interval-seconds": { type: "string", help: "Spool upload cadence until a grant says otherwise (default 300)" },
  "spool-budget-bytes": { type: "string", help: "Host budget for unsent segments across every writer (default 100 MiB); the oldest go first and the loss is reported" },
  "no-upload": { type: "boolean", help: "Publish the folder and upload nothing (SDKs that can upload keep doing so; airprompter export-telemetry packs the rest)" },
  "upload-sink": { type: "string", help: "Where segments go: airprompter (default; a grant per writer) or otlp (your OpenTelemetry collector; no grant, no key needed)" },
  "otlp-endpoint": { type: "string", help: "With --upload-sink otlp: the collector's OTLP/HTTP metrics URL, e.g. http://localhost:4318/v1/metrics" },
  "otlp-header": { type: "string", multiple: true, help: "With --upload-sink otlp: a header on every export, name=value (repeatable; a secret comes from the environment as 'name=$VAR', quoted so the shell leaves it)" },
  "otlp-resource": { type: "string", multiple: true, help: "With --upload-sink otlp: a resource attribute, key=value (repeatable), e.g. service.name=support-bot" },
  "exit-after": { type: "string", help: "Seconds to run before exiting (tests and smoke checks)" },
  ...Object.fromEntries(REMOVED_FLAGS.map((name) => [name, { type: "string" as const, help: "Removed in 0.3.0: the daemon ships telemetry only (protocol/daemon.md)" }])),
  ...COMMON_OPTIONS,
};

/** S13: the OpenTelemetry bridge from the command line — endpoint, headers (a value may name an env var), resource. */
function otlpSinkFromArgs(parsed: ReturnType<typeof parse>, ctx: Context): UploadSink {
  const endpoint = str(parsed, "otlp-endpoint");
  if (!endpoint) throw usage("--upload-sink otlp needs --otlp-endpoint (the collector's OTLP/HTTP metrics URL)");
  const headers: Record<string, string> = {};
  for (const raw of (parsed.values["otlp-header"] as string[] | undefined) ?? []) {
    const eq = raw.indexOf("=");
    if (eq <= 0) throw usage(`--otlp-header: "${raw}" is not name=value`);
    const value = raw.slice(eq + 1);
    if (value.startsWith("$")) {
      // Quote it in the shell ('authorization=$OTEL_TOKEN') so the token never reaches argv; unset is an error, not an empty header.
      const fromEnv = ctx.env[value.slice(1)];
      if (fromEnv === undefined || fromEnv === "") throw usage(`--otlp-header ${raw.slice(0, eq)}=${value}: ${value.slice(1)} is not set in the environment`);
      headers[raw.slice(0, eq)] = fromEnv;
    } else headers[raw.slice(0, eq)] = value;
  }
  const resource: Record<string, string> = {};
  for (const raw of (parsed.values["otlp-resource"] as string[] | undefined) ?? []) {
    const eq = raw.indexOf("=");
    if (eq <= 0) throw usage(`--otlp-resource: "${raw}" is not key=value`);
    resource[raw.slice(0, eq)] = raw.slice(eq + 1);
  }
  return otlpUploadSink({ endpoint, headers, resource, fetch: ctx.fetch ?? (globalThis.fetch as unknown as NonNullable<typeof ctx.fetch>), now: ctx.now, sdkVersion: CLI_VERSION });
}

const HOST_OS = process.platform === "linux" || process.platform === "darwin" ? process.platform : process.platform === "win32" ? "windows" : "other";

/**
 * The report for a segment with no manifest — a third-party writer, a segment reclaimed from a crashed one, an SDK
 * before 0.3.0: attributed to the daemon's own agent and target, and saying nothing it does not know.
 */
export function minimalReport(instanceId: string, nowMs: number): Record<string, unknown> {
  return {
    protocol: PROTOCOL_VERSION,
    instanceId,
    instanceClass: "resident",
    sdk: { name: "airprompterd", version: CLI_VERSION.slice(0, 64) },
    host: { os: HOST_OS, arch: process.arch.slice(0, 16), runtime: `node ${process.versions.node}`.slice(0, 64) },
    syncMode: "offline",
    generation: { active: 0 },
    applyState: "active",
    storageProtection: "custom",
    catalog: { models: [], reportedAt: new Date(nowMs).toISOString() },
    lease: { expired: false },
  };
}

/** One writer's grant: a heartbeat carrying that writer's report (or the minimal one) and the daemon's view of the spool. */
async function grantFor(client: SyncClient, body: Record<string, unknown>): Promise<GrantDecision> {
  try {
    const result = await client.heartbeat(body);
    if (result.status === "ok") {
      const interval = Number(result.response.uploadIntervalSeconds);
      const uploadIntervalSeconds = Number.isFinite(interval) && interval >= 1 ? interval : undefined;
      const grant = result.response.uploadGrant as UploadGrant | undefined;
      if (grant && typeof grant.url === "string" && typeof grant.keyPrefix === "string") return { kind: "grant", grant, ...(uploadIntervalSeconds ? { uploadIntervalSeconds } : {}) };
      const retryAfter = Number(result.response.retryAfterSeconds);
      return { kind: "hold", retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 900, reason: "retry_after" };
    }
    return { kind: "unavailable", reason: result.status === "refused" ? (result.code ?? `http_${result.httpStatus}`) : `http_${result.httpStatus}` };
  } catch (error) {
    return { kind: "unavailable", reason: `network:${(error as Error).message}` };
  }
}

export async function daemon(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, DAEMON_OPTIONS);
  if (flag(parsed, "help")) {
    ctx.stdout(helpFor("daemon", "--org … --agent … --environment … [--state-dir …] [--spool-dir …] [--upload-sink otlp --otlp-endpoint …]", DAEMON_OPTIONS));
    return EXIT.ok;
  }
  const removed = REMOVED_FLAGS.filter((name) => parsed.values[name] !== undefined);
  if (removed.length > 0) {
    throw usage(`${removed.map((name) => `--${name}`).join(", ")}: removed in 0.3.0 — airprompterd ships telemetry only and never serves a release; every SDK process loads its own (its store, the datastore, a vendored bundle). Drop the flag (protocol/daemon.md)`);
  }
  const scope = scopeOf(parsed);
  const apiKeyEnv = str(parsed, "api-key-env") ?? "AIRPROMPTER_AGENT_KEY";
  const apiKey = ctx.env[apiKeyEnv];
  const stateDir = str(parsed, "state-dir") ?? defaultStateDir(ctx);
  const storeDir = SlotStore.path({ stateDir, agentId: scope.agentId, target: scope.target });
  const spoolDir = resolve(ctx.cwd, str(parsed, "spool-dir") ?? join(storeDir, "spool", "telemetry"));
  const uploadIntervalSeconds = Number(str(parsed, "upload-interval-seconds") ?? "300");
  if (!Number.isFinite(uploadIntervalSeconds) || uploadIntervalSeconds < 1) throw usage("--upload-interval-seconds must be at least 1");
  const spoolBudgetBytes = str(parsed, "spool-budget-bytes") !== undefined ? Number(str(parsed, "spool-budget-bytes")) : undefined;
  if (spoolBudgetBytes !== undefined && (!Number.isFinite(spoolBudgetBytes) || spoolBudgetBytes < 1024 * 1024)) throw usage("--spool-budget-bytes must be at least 1048576");
  const uploadSinkKind = str(parsed, "upload-sink") ?? "airprompter";
  if (uploadSinkKind !== "airprompter" && uploadSinkKind !== "otlp") throw usage("--upload-sink must be airprompter or otlp");
  const otlpSink = uploadSinkKind === "otlp" ? otlpSinkFromArgs(parsed, ctx) : null;
  const json = flag(parsed, "json");
  const log = (event: Record<string, unknown>) => ctx.stderr(json ? JSON.stringify({ at: new Date(ctx.now()).toISOString(), ...event }) : `${new Date(ctx.now()).toISOString()} ${event.event ?? "log"} ${Object.entries(event).filter(([k]) => k !== "event").map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ")}`);

  try {
    mkdirSync(join(spoolDir, "quarantine"), { recursive: true, mode: 0o700 });
    mkdirSync(join(spoolDir, "exported"), { recursive: true, mode: 0o700 });
  } catch (error) {
    throw refused(`${spoolDir}: ${(error as Error).message}`, { reason: "spool_unavailable" });
  }

  // The daemon's own writer id: its budget sweep's `dropped` rows name it, and they upload like any segment.
  const instanceId = `i-${randomBytes(12).toString("base64url")}`;
  const client = apiKey ? new SyncClient({ baseUrl: str(parsed, "base-url") ?? "https://api.airprompter.com", agentId: scope.agentId, target: scope.target, apiKey, ...(ctx.fetch ? { fetch: ctx.fetch } : {}), userAgent: `airprompterd/${CLI_VERSION}` }) : null;
  const shipping = !flag(parsed, "no-upload") && (otlpSink !== null || client !== null);
  let uploader: SpoolUploader | null = null;
  const spoolBlock = (): Record<string, unknown> => {
    const s = uploader?.status();
    if (!s) return { depthSegments: 0, depthBytes: 0, droppedSegments: 0, quarantinedSegments: 0 };
    return { depthSegments: s.depth.segments, depthBytes: s.depth.bytes, droppedSegments: s.droppedSegments, quarantinedSegments: s.quarantinedSegments, ...(s.lastUploadAt ? { lastUploadAt: s.lastUploadAt } : {}), ...(s.backoffUntil ? { backoffUntil: s.backoffUntil } : {}) };
  };
  if (shipping) {
    uploader = new SpoolUploader({
      dir: spoolDir,
      instanceId,
      // One daemon per agent and target: another pair's segments are that pair's daemon's.
      scope: { agentId: scope.agentId, target: scope.target },
      ...(otlpSink
        ? { sink: otlpSink }
        : {
            // The writer's own report from its manifest, or the minimal one for a segment without; the daemon's spool view either way.
            grantFor: (writerId: string, report?: Record<string, unknown>) => grantFor(client!, { ...(report ?? minimalReport(writerId, ctx.now())), instanceId: writerId, spool: spoolBlock() }),
            fetch: ctx.fetch ?? (globalThis.fetch as unknown as NonNullable<typeof ctx.fetch>),
          }),
      now: ctx.now,
      logger: log,
      intervalSeconds: uploadIntervalSeconds,
      ...(spoolBudgetBytes !== undefined ? { budgetBytes: spoolBudgetBytes } : {}),
      // After every pass the discovery file says how it went.
      onPass: () => publish(),
    });
  } else {
    log({ event: "upload_off", reason: flag(parsed, "no-upload") ? "--no-upload" : `${apiKeyEnv} is not set and no --upload-sink otlp: publishing the folder, shipping nothing (SDKs that can upload keep doing so)` });
  }

  const startedAt = new Date(ctx.now()).toISOString();
  const discovery = (): DaemonDiscovery => {
    const s = uploader?.status();
    return {
      format: 1,
      kind: "daemon",
      daemon: { name: "airprompterd", version: CLI_VERSION },
      pid: process.pid,
      organizationId: scope.organizationId,
      agentId: scope.agentId,
      target: scope.target,
      spoolDir,
      startedAt,
      heartbeatAt: new Date(ctx.now()).toISOString(),
      uploadIntervalSeconds: s?.intervalSeconds ?? uploadIntervalSeconds,
      sink: uploader ? (otlpSink ? "otlp" : "airprompter") : "none",
      upload: {
        lastUploadAt: s?.lastUploadAt ?? null,
        backoffUntil: s?.backoffUntil ?? null,
        sentSegments: s?.sentSegments ?? 0,
        quarantinedSegments: s?.quarantinedSegments ?? 0,
        droppedSegments: s?.droppedSegments ?? 0,
        depthSegments: s?.depth.segments ?? 0,
        depthBytes: s?.depth.bytes ?? 0,
      },
    };
  };
  let stopped = false;
  const publish = () => {
    // Once stopping, the file is about to go: a pass that ends late never writes it back.
    if (stopped) return;
    try {
      writeDaemonDiscovery(nodeFs, storeDir, discovery());
    } catch (error) {
      log({ event: "discovery_write_failed", reason: (error as Error).message });
    }
  };
  try {
    writeDaemonDiscovery(nodeFs, storeDir, discovery());
  } catch (error) {
    throw refused(`${join(storeDir, "daemon.json")}: ${(error as Error).message}`, { reason: "discovery_unavailable" });
  }
  // Referenced on purpose: this timer is what keeps the daemon's process alive until a signal stops it.
  const refresh = setInterval(publish, DAEMON_DISCOVERY_REFRESH_MS);
  uploader?.start();
  log({ event: "shipping", spoolDir, discovery: join(storeDir, "daemon.json"), upload: uploader ? `${uploader.status().sink}: every ${uploadIntervalSeconds}s${otlpSink ? "" : " until a grant says otherwise"}` : "off" });

  const exitAfter = str(parsed, "exit-after");
  await new Promise<void>((done) => {
    const stop = () => done();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (exitAfter) setTimeout(stop, Number(exitAfter) * 1000).unref();
  });
  clearInterval(refresh);
  log({ event: "stopping" });
  if (uploader) {
    await uploader.stop();
    // One last pass carries whatever writers closed since the last one.
    await uploader.runOnce();
    const s = uploader.status();
    log({ event: "final_upload", sent: s.sentSegments, quarantined: s.quarantinedSegments, depth: s.depth.segments });
  }
  stopped = true;
  // A clean stop takes the file with it: SDKs that can upload take it back on their next minute.
  removeDaemonDiscovery(nodeFs, storeDir, process.pid);
  return EXIT.ok;
}
