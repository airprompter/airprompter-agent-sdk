/**
 * `airprompter daemon` (`airprompterd`): the per-host sync loop and shared
 * store behind a local socket. Runs an `AirPrompterAgent` in resident
 * mode — the same verification, store and apply policy every SDK
 * process runs in-process — and serves it. Logs are one JSON object per
 * line on stderr, never with prompt text. Stops on SIGINT / SIGTERM.
 */

import { join } from "node:path";

import { AirPrompterAgent, isAgentStartError, SDK_NAME, SDK_VERSION } from "../../../sdk-typescript/src/agent.js";
import { daemonSocketPath } from "../../../sdk-typescript/src/sync/daemon.js";
import { SlotStore } from "../../../sdk-typescript/src/store/slotStore.js";
import { SpoolUploader } from "../../../sdk-typescript/src/telemetry/uploader.js";
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
  "exit-after": { type: "string", help: "Seconds to run before exiting (tests and smoke checks)" },
  ...COMMON_OPTIONS,
};

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
  const json = flag(parsed, "json");
  const log = (event: Record<string, unknown>) => ctx.stderr(json ? JSON.stringify({ at: new Date(ctx.now()).toISOString(), ...event }) : `${new Date(ctx.now()).toISOString()} ${event.event ?? "log"} ${Object.entries(event).filter(([k]) => k !== "event" && k !== "sdk" && k !== "agentId" && k !== "target").map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ")}`);
  if (!apiKey) log({ event: "offline", reason: `${apiKeyEnv} is not set: serving the store, never calling home` });

  let agent: AirPrompterAgent;
  try {
    agent = await AirPrompterAgent.start({
      ...scope,
      ...(apiKey ? { apiKey } : {}),
      baseUrl: str(parsed, "base-url") ?? "https://api.airprompter.com",
      stateDir,
      root: root.kind === "pinned" ? { pinned: root.jwk } : root.document,
      sync: { mode: "resident", pollSeconds, ...(str(parsed, "edge-pointer-url") ? { edgePointerUrl: str(parsed, "edge-pointer-url")! } : {}), ...(str(parsed, "root-url") ? { rootUrl: str(parsed, "root-url")! } : {}) },
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
  const uploader =
    apiKey && !flag(parsed, "no-upload")
      ? new SpoolUploader({
          dir: join(storeDir, "spool", "telemetry"),
          instanceId: agent.instanceId,
          grantFor: (instanceId) => agent.requestUploadGrant({ instanceId, instanceClass: "resident" }),
          fetch: ctx.fetch ?? (globalThis.fetch as unknown as NonNullable<typeof ctx.fetch>),
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
  log({ event: "serving", generation: agent.generation, store: storeDir, sdk: `${SDK_NAME}/${SDK_VERSION}`, upload: uploader ? `every ${uploadIntervalSeconds}s until a grant says otherwise` : "off" });

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
