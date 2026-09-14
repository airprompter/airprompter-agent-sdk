/**
 * `airprompter daemon` (`airprompterd`): the per-host sync loop and shared
 * store behind a local socket. Runs an `AirPrompterAgent` in resident
 * mode — the same verification, store and apply policy every SDK
 * process runs in-process — and serves it. Logs are one JSON object per
 * line on stderr, never with prompt text. Stops on SIGINT / SIGTERM.
 */

import { join } from "node:path";

import { AirPrompterAgent, isAgentStartError, SDK_NAME, SDK_VERSION } from "../../../sdk-typescript/packages/sdk/src/agent.js";
import { daemonSocketPath } from "../../../sdk-typescript/packages/sync/src/sync/daemon.js";
import { SlotStore } from "../../../sdk-typescript/packages/sync/src/store/slotStore.js";
import { SpoolUploader } from "../../../sdk-typescript/packages/telemetry/src/uploader.js";
import { otlpUploadSink } from "../../../sdk-typescript/packages/otel-bridge/src/sink.js";
import type { UploadSink } from "../../../sdk-typescript/packages/core/src/telemetry/uploadSink.js";
import { COMMON_OPTIONS, ROOT_OPTIONS, SCOPE_OPTIONS, STORE_OPTIONS, defaultStateDir, flag, helpFor, parse, rootOf, scopeOf, str, type OptionSpec } from "../args.js";
import { DaemonServer } from "../daemon/server.js";
import { EXIT, refused, usage, type Context } from "../io.js";
import { CLI_VERSION, PROTOCOL_VERSION } from "../version.js";

export const DAEMON_OPTIONS: OptionSpec = {
  ...SCOPE_OPTIONS,
  ...ROOT_OPTIONS,
  ...STORE_OPTIONS,
  "api-key-env": { type: "string", default: "AIRPROMPTER_AGENT_KEY", help: "Environment variable holding the Agent key" },
  "base-url": { type: "string", default: "https://api.airprompter.com", help: "API base URL" },
  "edge-pointer-url": { type: "string", help: "The environment's generation.json URL (idle polls hit the edge, not the API)" },
  "root-url": { type: "string", help: "The environment's root.json URL (rotations are accepted against --root)" },
  "poll-seconds": { type: "string", default: "30", help: "Sync interval (jittered)" },
  socket: { type: "string", help: "Socket path (default: <store>/daemon.sock, or a named pipe on Windows)" },
  "apply-policy": { type: "string", help: "Local override: unlock_required stages every release until airprompter unlock (never looser than the manifest)" },
  "upload-interval-seconds": { type: "string", help: "Spool upload cadence until a grant says otherwise (default 300)" },
  "spool-budget-bytes": { type: "string", help: "Host budget for unsent segments across every writer (default 100 MiB); the oldest go first and the loss is reported" },
  "no-upload": { type: "boolean", help: "Serve and sync only; leave the spool on disk (airprompter export-telemetry packs it)" },
  "upload-sink": { type: "string", help: "Where segments go: airprompter (default; a grant per writer) or otlp (your OpenTelemetry collector; no grant, no key needed)" },
  "otlp-endpoint": { type: "string", help: "With --upload-sink otlp: the collector's OTLP/HTTP metrics URL, e.g. http://localhost:4318/v1/metrics" },
  "otlp-header": { type: "string", multiple: true, help: "With --upload-sink otlp: a header on every export, name=value (repeatable; a secret comes from the environment as 'name=$VAR', quoted so the shell leaves it)" },
  "otlp-resource": { type: "string", multiple: true, help: "With --upload-sink otlp: a resource attribute, key=value (repeatable), e.g. service.name=support-bot" },
  "exit-after": { type: "string", help: "Seconds to run before exiting (tests and smoke checks)" },
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

export async function daemon(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, DAEMON_OPTIONS);
  if (flag(parsed, "help")) {
    ctx.stdout(helpFor("daemon", "--org … --agent … --environment … --root … [--state-dir …] [--edge-pointer-url …]", DAEMON_OPTIONS));
    return EXIT.ok;
  }
  const scope = scopeOf(parsed);
  const root = rootOf(parsed, scope.target);
  const apiKeyEnv = str(parsed, "api-key-env") ?? "AIRPROMPTER_AGENT_KEY";
  const apiKey = ctx.env[apiKeyEnv];
  const stateDir = str(parsed, "state-dir") ?? defaultStateDir(ctx);
  const pollSeconds = Number(str(parsed, "poll-seconds") ?? "30");
  if (!Number.isFinite(pollSeconds) || pollSeconds < 1) throw usage("--poll-seconds must be at least 1");
  const applyPolicy = str(parsed, "apply-policy");
  if (applyPolicy !== undefined && applyPolicy !== "auto" && applyPolicy !== "unlock_required") throw usage("--apply-policy must be auto or unlock_required");
  const uploadIntervalSeconds = Number(str(parsed, "upload-interval-seconds") ?? "300");
  if (!Number.isFinite(uploadIntervalSeconds) || uploadIntervalSeconds < 1) throw usage("--upload-interval-seconds must be at least 1");
  const spoolBudgetBytes = str(parsed, "spool-budget-bytes") !== undefined ? Number(str(parsed, "spool-budget-bytes")) : undefined;
  if (spoolBudgetBytes !== undefined && (!Number.isFinite(spoolBudgetBytes) || spoolBudgetBytes < 1024 * 1024)) throw usage("--spool-budget-bytes must be at least 1048576");
  const socketPath = str(parsed, "socket") ?? daemonSocketPath({ stateDir, agentId: scope.agentId, target: scope.target });
  const uploadSinkKind = str(parsed, "upload-sink") ?? "airprompter";
  if (uploadSinkKind !== "airprompter" && uploadSinkKind !== "otlp") throw usage("--upload-sink must be airprompter or otlp");
  const otlpSink = uploadSinkKind === "otlp" ? otlpSinkFromArgs(parsed, ctx) : null;
  const json = flag(parsed, "json");
  const log = (event: Record<string, unknown>) => ctx.stderr(json ? JSON.stringify({ at: new Date(ctx.now()).toISOString(), ...event }) : `${new Date(ctx.now()).toISOString()} ${event.event ?? "log"} ${Object.entries(event).filter(([k]) => k !== "event" && k !== "sdk" && k !== "agentId" && k !== "target").map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ")}`);
  if (!apiKey) log({ event: "offline", reason: `${apiKeyEnv} is not set: serving the store, never calling home${otlpSink ? "; telemetry goes to the OpenTelemetry collector" : ""}` });

  let agent: AirPrompterAgent;
  try {
    agent = await AirPrompterAgent.start({
      ...scope,
      ...(apiKey ? { apiKey } : {}),
      baseUrl: str(parsed, "base-url") ?? "https://api.airprompter.com",
      stateDir,
      root: root.kind === "pinned" ? { pinned: root.jwk } : root.document,
      sync: { mode: "resident", pollSeconds, ...(str(parsed, "edge-pointer-url") ? { edgePointerUrl: str(parsed, "edge-pointer-url")! } : {}), ...(str(parsed, "root-url") ? { rootUrl: str(parsed, "root-url")! } : {}) },
      // S5: the daemon runs the host's uploader itself (one grant per attached writer, the `upload` op); the runtime's own is off.
      telemetry: { upload: false },
      ...(applyPolicy ? { apply: { policy: applyPolicy } } : {}),
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
      now: ctx.now,
      logger: log,
      sdk: { name: "airprompterd", version: CLI_VERSION },
    });
  } catch (error) {
    // A store whose key cannot be obtained, or nothing verified anywhere: the daemon does not listen.
    if (isAgentStartError(error)) throw refused(`not serving: ${error.message}`, { reason: error.code });
    throw error;
  }
  // T26 P4: the uploader — every writer's closed segments, validated, under one grant per writer prefix (the daemon's
  // heartbeat carrying that writer's instance id). Without a key there is nothing to ask a grant of: the spool stays.
  const storeDir = SlotStore.path({ stateDir, agentId: scope.agentId, target: scope.target });
  // S13: with --upload-sink otlp the daemon needs no key to ship telemetry — the collector is the customer's.
  const uploader =
    (otlpSink || apiKey) && !flag(parsed, "no-upload")
      ? new SpoolUploader({
          dir: join(storeDir, "spool", "telemetry"),
          instanceId: agent.instanceId,
          ...(otlpSink
            ? { sink: otlpSink }
            : {
                grantFor: (instanceId: string) => agent.requestUploadGrant({ instanceId, instanceClass: "resident" }),
                fetch: ctx.fetch ?? (globalThis.fetch as unknown as NonNullable<typeof ctx.fetch>),
              }),
          now: ctx.now,
          logger: log,
          intervalSeconds: uploadIntervalSeconds,
          ...(spoolBudgetBytes !== undefined ? { budgetBytes: spoolBudgetBytes } : {}),
        })
      : null;
  if (uploader) {
    agent.setSpoolReporter(() => {
      const s = uploader.status();
      return { droppedSegments: s.droppedSegments, quarantinedSegments: s.quarantinedSegments, lastUploadAt: s.lastUploadAt, backoffUntil: s.backoffUntil };
    });
  }
  const server = new DaemonServer(agent, { socketPath, version: CLI_VERSION, protocol: PROTOCOL_VERSION, agentId: scope.agentId, target: scope.target, now: ctx.now, logger: log, uploader });
  try {
    await server.listen();
  } catch (error) {
    await agent.stop();
    throw refused((error as Error).message, { reason: "socket_unavailable" });
  }
  if (uploader) uploader.start();
  log({ event: "serving", generation: agent.generation, store: storeDir, sdk: `${SDK_NAME}/${SDK_VERSION}`, upload: uploader ? `${uploader.status().sink}: every ${uploadIntervalSeconds}s${otlpSink ? "" : " until a grant says otherwise"}` : "off" });

  const exitAfter = str(parsed, "exit-after");
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (exitAfter) setTimeout(stop, Number(exitAfter) * 1000).unref();
  });
  log({ event: "stopping", clients: server.clientCount });
  await server.close();
  await agent.stop();
  // The daemon's own windows closed on stop: one last pass carries them (and whatever attached writers closed) before the process goes.
  if (uploader) {
    await uploader.stop();
    const last = await uploader.runOnce();
    log({ event: "final_upload", uploaded: last.uploaded.length, quarantined: last.quarantined.length, held: last.held });
  }
  return EXIT.ok;
}
