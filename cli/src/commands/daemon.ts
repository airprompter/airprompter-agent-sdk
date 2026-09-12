/**
 * `airprompter daemon` (`airprompterd`): the per-host sync loop and shared
 * store behind a local socket. Runs an `AirPrompterAgent` in resident
 * mode — the same verification, store and apply policy every SDK
 * process runs in-process — and serves it. Logs are one JSON object per
 * line on stderr, never with prompt text. Stops on SIGINT / SIGTERM.
 */

import { AirPrompterAgent, AgentStartError, SDK_NAME, SDK_VERSION } from "../../../sdk-typescript/src/agent.js";
import { daemonSocketPath } from "../../../sdk-typescript/src/sync/daemon.js";
import { SlotStore } from "../../../sdk-typescript/src/store/slotStore.js";
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
    });
  } catch (error) {
    // A store whose key cannot be obtained, or nothing verified anywhere: the daemon does not listen.
    if (error instanceof AgentStartError) throw refused(`not serving: ${error.message}`, { reason: error.code });
    throw error;
  }
  const server = new DaemonServer(agent, { socketPath, version: CLI_VERSION, protocol: PROTOCOL_VERSION, agentId: scope.agentId, target: scope.target, now: ctx.now, logger: log });
  try {
    await server.listen();
  } catch (error) {
    await agent.stop();
    throw refused((error as Error).message, { reason: "socket_unavailable" });
  }
  log({ event: "serving", generation: agent.generation, store: SlotStore.path({ stateDir, agentId: scope.agentId, target: scope.target }), sdk: `${SDK_NAME}/${SDK_VERSION}` });

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
  return EXIT.ok;
}
