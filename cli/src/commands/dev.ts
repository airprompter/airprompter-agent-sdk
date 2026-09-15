/**
 * `airprompter dev ./dir` (S12): a directory of prompts served as a registry
 * over the protocol's own routes — the manifest, the payloads, the heartbeat,
 * the catalogue, the edge pointer and the root — signed with a dev key under
 * a dev root, so an SDK, a daemon or the CLI syncs from it exactly as from
 * the hosted service. Git customers get live sync while they edit; Hangar (a
 * self-hosted registry) gets a runnable conformance target; the conformance
 * runner's live mode (`conformance/live.mjs`) exercises it beside hosted.
 *
 * The directory: every `.md` / `.txt` / `.prompt` file is a slot; its tag is
 * the relative path without the extension, `/` as `.`, lower-cased
 * (`support/Triage.md` → `support.triage`). Front matter may name `model:`,
 * `variables:` (comma-separated; `name!` is required, `name?` is end-user
 * text; without the line every `{{placeholder}}` is an optional operator
 * variable), `version:`. An optional `release.json` beside them carries the
 * manifest's `applyPolicy`, `leaseSeconds`, `onLeaseExpiry`, `unlockWindow`,
 * `experiment` and `directives`.
 *
 * The rules:
 * - **Every save is a generation.** The directory is watched; a change that
 *   alters the release (a slot's bytes, model, variables, or release.json) is
 *   promoted as generation + 1, signed; an unchanged re-read is not. A file
 *   that does not parse is reported and the last good generation keeps
 *   serving.
 * - **The keys persist.** `<dir>/.airprompter-dev/keys.json` (mode 0600) holds
 *   the dev root and signing keys; `root.pub.json` beside it is what a client
 *   pins (`--root`). A root pinned yesterday verifies today's generations.
 * - **`unlock_required` is honoured locally.** With `release.json`'s
 *   `applyPolicy: "unlock_required"` (or `--apply-policy`), every generation
 *   is staged by the clients and waits for `airprompter unlock` on the host —
 *   the same flow as production, on the laptop.
 * - **The daemon socket carries the generations.** With `--daemon`, an
 *   embedded `airprompterd` attached to this server serves the host's SDKs
 *   over the local socket, and every promotion reaches them as a
 *   `generation` event within one poll.
 * - **Nothing here is trusted beyond the machine.** The API key is a
 *   fixed dev key (`apa_dev_local`), the root is self-made, the listener is
 *   loopback unless `--host` says otherwise; a manifest signed here never
 *   verifies against a production root.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join, relative, sep } from "node:path";

import { AirPrompterAgent } from "../../../sdk-typescript/packages/sdk/src/agent.js";
import type { ManifestPayload, ManifestSlot, P256PrivateJwk, SlotVariable, Target } from "../../../sdk-typescript/packages/core/src/protocol/types.js";
import { sha256Prefixed } from "../../../sdk-typescript/packages/core/src/protocol/canonicalJson.js";
import { publicJwkOf } from "../../../sdk-typescript/packages/core/src/protocol/trust.js";
import { FakeControlPlane, serveOverHttp } from "../../../sdk-typescript/packages/core/src/testing/controlPlane.js";
import { daemonSocketPath } from "../../../sdk-typescript/packages/sync/src/sync/daemon.js";
import { SlotStore } from "../../../sdk-typescript/packages/sync/src/store/slotStore.js";

import { COMMON_OPTIONS, flag, helpFor, parse, str, type OptionSpec } from "../args.js";
import { DaemonServer } from "../daemon/server.js";
import { EXIT, Output, usage, type Context } from "../io.js";
import { CLI_VERSION, PROTOCOL_VERSION } from "../version.js";

export const DEV_API_KEY = "apa_dev_local";
export const DEV_DIR = ".airprompter-dev";

export const DEV_OPTIONS: OptionSpec = {
  org: { type: "string", default: "org_dev", help: "Organization id the manifests carry" },
  agent: { type: "string", default: "agt_dev", help: "Agent id the manifests carry" },
  environment: { type: "string", default: "dev", help: "Target: dev, staging or prod (the dev root is scoped to it)" },
  host: { type: "string", default: "127.0.0.1", help: "Listen address (loopback unless you say otherwise)" },
  port: { type: "string", default: "4180", help: "Listen port (0 picks a free one)" },
  "apply-policy": { type: "string", help: "The manifest's apply policy: auto (default) or unlock_required (every generation waits for airprompter unlock on each host)" },
  "lease-seconds": { type: "string", help: "The manifest's lease (default 3600)" },
  daemon: { type: "boolean", help: "Also run airprompterd attached to this server: SDKs on this host get generation events over the local socket" },
  "state-dir": { type: "string", help: "The embedded daemon's state directory (default: <dir>/.airprompter-dev/state)" },
  "poll-seconds": { type: "string", default: "2", help: "The embedded daemon's poll interval" },
  "exit-after": { type: "string", help: "Seconds to run before exiting (tests and smoke checks)" },
  ...COMMON_OPTIONS,
};

const PROMPT_FILE = /\.(md|txt|prompt)$/i;
const TAG = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export interface DevSlotSpec {
  tag: string;
  text: string;
  model: string;
  variables: SlotVariable[];
  versionId: string;
}

export interface DevRelease {
  slots: DevSlotSpec[];
  options: Partial<Pick<ManifestPayload, "applyPolicy" | "leaseSeconds" | "experiment" | "directives" | "onLeaseExpiry" | "unlockWindow">>;
  requireCountersign: boolean;
  /** What the release amounts to: a change here is a generation, nothing else is. */
  fingerprint: string;
  problems: string[];
}

/** `support/Triage.md` → `support.triage`. */
export function tagFromPath(relativePath: string): string {
  return relativePath.replace(PROMPT_FILE, "").split(sep).join("/").split("/").join(".").toLowerCase();
}

/** `name!` required operator text, `name?` end-user text (fenced), `name` optional operator text. */
export function parseVariables(spec: string | undefined): SlotVariable[] {
  if (!spec?.trim()) return [];
  return spec.split(",").map((raw) => raw.trim()).filter(Boolean).map((raw) => {
    const required = raw.endsWith("!");
    const endUser = raw.endsWith("?");
    const name = raw.replace(/[!?]$/, "");
    return { name, required: required || endUser, trust: endUser ? "end_user" : "operator" };
  });
}

export function parsePromptFile(relativePath: string, raw: string): DevSlotSpec {
  let text = raw.replace(/\r\n/g, "\n");
  const meta: Record<string, string> = {};
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (front) {
    for (const line of front[1]!.split("\n")) {
      const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (m) meta[m[1]!.toLowerCase()] = m[2]!.trim();
    }
    text = text.slice(front[0].length);
  }
  const tag = meta.tag ?? tagFromPath(relativePath);
  if (!TAG.test(tag)) throw new Error(`${relativePath}: "${tag}" is not a slot tag (lower-case words joined by . _ -)`);
  const content = text.trim();
  if (!content) throw new Error(`${relativePath}: empty`);
  // No `variables:` line: every `{{placeholder}}` in the text is an optional operator variable, so a file with no
  // front matter renders at all. Declare them to make one required or end-user text.
  const variables = meta.variables !== undefined ? parseVariables(meta.variables) : [...new Set([...content.matchAll(/\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g)].map((m) => m[1]!))].map((name) => ({ name, required: false, trust: "operator" as const }));
  return { tag, text: content, model: meta.model ?? "claude-sonnet-5", variables, versionId: meta.version ?? `dev_${sha256Prefixed(Buffer.from(content, "utf8")).slice(7, 19)}` };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (PROMPT_FILE.test(entry)) out.push(path);
  }
  return out;
}

/** Read the directory as a release. Problems are reported, never thrown: the last good generation keeps serving. */
export function readDevRelease(dir: string): DevRelease {
  const problems: string[] = [];
  const slots: DevSlotSpec[] = [];
  const seen = new Map<string, string>();
  for (const path of walk(dir)) {
    const rel = relative(dir, path);
    try {
      const spec = parsePromptFile(rel, readFileSync(path, "utf8"));
      const prior = seen.get(spec.tag);
      if (prior) {
        problems.push(`${rel}: tag "${spec.tag}" is already ${prior}'s`);
        continue;
      }
      seen.set(spec.tag, rel);
      slots.push(spec);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  let options: DevRelease["options"] = {};
  let requireCountersign = false;
  const releaseFile = join(dir, "release.json");
  if (existsSync(releaseFile)) {
    try {
      const parsed = JSON.parse(readFileSync(releaseFile, "utf8")) as Record<string, unknown>;
      const { requireCountersign: rc, ...rest } = parsed;
      requireCountersign = rc === true;
      options = rest as DevRelease["options"];
      if (options.applyPolicy !== undefined && options.applyPolicy !== "auto" && options.applyPolicy !== "unlock_required") problems.push(`release.json: applyPolicy must be auto or unlock_required`);
    } catch (error) {
      problems.push(`release.json: ${(error as Error).message}`);
    }
  }
  slots.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const fingerprint = sha256Prefixed(Buffer.from(JSON.stringify({ slots: slots.map((s) => [s.tag, s.text, s.model, s.variables, s.versionId]), options, requireCountersign }), "utf8"));
  return { slots, options, requireCountersign, fingerprint, problems };
}

interface DevKeys {
  rootKey: P256PrivateJwk;
  signingKey: P256PrivateJwk;
}

/** The dev keys under `<dir>/.airprompter-dev/`: made once, mode 0600, the public root beside them for clients to pin. */
export function loadOrCreateDevKeys(dir: string, target: Target): { keys: DevKeys; created: boolean; rootPubPath: string } {
  const devDir = join(dir, DEV_DIR);
  mkdirSync(devDir, { recursive: true });
  const keysPath = join(devDir, "keys.json");
  const rootPubPath = join(devDir, "root.pub.json");
  let created = false;
  let keys: DevKeys;
  if (existsSync(keysPath)) {
    keys = JSON.parse(readFileSync(keysPath, "utf8")) as DevKeys;
  } else {
    const plane = new FakeControlPlane({ organizationId: "org_dev", agentId: "agt_dev", target });
    keys = { rootKey: plane.rootKey, signingKey: plane.signingKey };
    writeFileSync(keysPath, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
    created = true;
  }
  writeFileSync(rootPubPath, `${JSON.stringify(publicJwkOf(keys.rootKey), null, 2)}\n`);
  return { keys, created, rootPubPath };
}

/** The plane behind `airprompter dev`: the fake control plane with persisted keys and the directory's release. */
export function devPlane(input: { scope: { organizationId: string; agentId: string; target: Target }; keys: DevKeys; release: DevRelease; overrides?: { applyPolicy?: "auto" | "unlock_required"; leaseSeconds?: number }; generation?: number }): FakeControlPlane {
  const plane = new FakeControlPlane(input.scope, DEV_API_KEY, input.keys);
  plane.requireCountersign = input.release.requireCountersign;
  promoteRelease(plane, input.release, input.overrides, input.generation);
  return plane;
}

export function promoteRelease(plane: FakeControlPlane, release: DevRelease, overrides: { applyPolicy?: "auto" | "unlock_required"; leaseSeconds?: number } = {}, generation?: number): number {
  const slots: ManifestSlot[] = release.slots.map((spec) => plane.slot({ tag: spec.tag, text: spec.text, model: spec.model, variables: spec.variables, versionId: spec.versionId }));
  plane.requireCountersign = release.requireCountersign;
  plane.promote(slots, { ...release.options, ...(overrides.applyPolicy ? { applyPolicy: overrides.applyPolicy } : {}), ...(overrides.leaseSeconds ? { leaseSeconds: overrides.leaseSeconds } : {}), ...(generation !== undefined ? { generation } : {}) });
  return plane.generation;
}

export async function dev(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, DEV_OPTIONS);
  if (flag(parsed, "help")) {
    ctx.stdout(helpFor("dev", "<directory> [--port 4180] [--apply-policy unlock_required] [--daemon]", DEV_OPTIONS));
    return EXIT.ok;
  }
  const dir = parsed.positionals[0];
  if (!dir) throw usage("dev takes the directory to serve: airprompter dev ./prompts");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw usage(`${dir} is not a directory`);
  const target = str(parsed, "environment") ?? "dev";
  if (target !== "dev" && target !== "staging" && target !== "prod") throw usage("--environment must be dev, staging or prod");
  const applyPolicy = str(parsed, "apply-policy");
  if (applyPolicy !== undefined && applyPolicy !== "auto" && applyPolicy !== "unlock_required") throw usage("--apply-policy must be auto or unlock_required");
  const leaseSeconds = str(parsed, "lease-seconds") !== undefined ? Number(str(parsed, "lease-seconds")) : undefined;
  if (leaseSeconds !== undefined && (!Number.isFinite(leaseSeconds) || leaseSeconds < 60)) throw usage("--lease-seconds must be at least 60");
  const port = Number(str(parsed, "port") ?? "4180");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw usage("--port must be 0–65535");
  const host = str(parsed, "host") ?? "127.0.0.1";
  const pollSeconds = Number(str(parsed, "poll-seconds") ?? "2");
  if (!Number.isFinite(pollSeconds) || pollSeconds < 1) throw usage("--poll-seconds must be at least 1");
  const json = flag(parsed, "json");
  const out = new Output(ctx, json);
  const log = (event: Record<string, unknown>) => ctx.stderr(json ? JSON.stringify({ at: new Date(ctx.now()).toISOString(), ...event }) : `${new Date(ctx.now()).toISOString()} ${event.event ?? "log"} ${Object.entries(event).filter(([k]) => k !== "event").map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ")}`);

  const scope = { organizationId: str(parsed, "org") ?? "org_dev", agentId: str(parsed, "agent") ?? "agt_dev", target: target as Target };
  const { keys, created, rootPubPath } = loadOrCreateDevKeys(dir, scope.target);
  const overrides = { ...(applyPolicy ? { applyPolicy: applyPolicy as "auto" | "unlock_required" } : {}), ...(leaseSeconds !== undefined ? { leaseSeconds } : {}) };
  let release = readDevRelease(dir);
  for (const problem of release.problems) log({ event: "problem", problem });
  if (release.slots.length === 0) throw usage(`${dir}: no prompt files (.md, .txt, .prompt) to serve`);
  // The generation counter persists too, so a client that holds generation N never sees a fresh N from a restart.
  const counterPath = join(dir, DEV_DIR, "generation");
  const startGeneration = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8").trim()) || 0 : 0;
  const plane = devPlane({ scope, keys, release, overrides, generation: startGeneration + 1 });
  writeFileSync(counterPath, `${plane.generation}\n`);

  const server = await serveOverHttp(plane, { host, port });
  out.field("baseUrl", server.baseUrl, "registry");
  out.field("apiKey", DEV_API_KEY, "agent key (AIRPROMPTER_AGENT_KEY)");
  out.field("root", rootPubPath, "root to pin (--root)");
  out.field("edgePointerUrl", `${server.baseUrl}/edge/${scope.agentId}/${scope.target}/generation.json`, "edge pointer");
  out.field("rootUrl", `${server.baseUrl}/roots/${scope.target}/root.json`, "root url");
  out.field("generation", plane.generation);
  out.field("slots", release.slots.map((s) => `${s.tag} (${s.model}, ${s.variables.length} vars)`));
  out.field("applyPolicy", overrides.applyPolicy ?? release.options.applyPolicy ?? "auto", "apply policy");
  if (created) out.line(`New dev keys under ${join(dir, DEV_DIR)} (keys.json is 0600; commit root.pub.json if teammates should pin it).`);
  out.line(`Try: AIRPROMPTER_AGENT_KEY=${DEV_API_KEY} airprompter pull --org ${scope.organizationId} --agent ${scope.agentId} --environment ${scope.target} --root ${rootPubPath} --hosted-environment ${scope.target} --base-url ${server.baseUrl} --out ./release.apbundle --plaintext`);

  // Hot reload: a change that alters the release is a generation; anything else is not.
  let timer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;
  const reload = () => {
    timer = null;
    const next = readDevRelease(dir);
    for (const problem of next.problems) log({ event: "problem", problem });
    if (next.slots.length === 0) {
      log({ event: "kept", reason: "no prompt files; the last generation keeps serving" });
      return;
    }
    if (next.fingerprint === release.fingerprint) return;
    release = next;
    const generation = promoteRelease(plane, release, overrides);
    writeFileSync(counterPath, `${generation}\n`);
    log({ event: "generation", generation, slots: release.slots.map((s) => s.tag), applyPolicy: overrides.applyPolicy ?? release.options.applyPolicy ?? "auto" });
  };
  try {
    watcher = watch(dir, { recursive: true }, (_kind, name) => {
      if (name && String(name).startsWith(DEV_DIR)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(reload, 200);
    });
  } catch (error) {
    log({ event: "watch_unavailable", reason: (error as Error).message });
  }

  // The embedded daemon: airprompterd attached to this server, so every SDK on the host sees each generation.
  let daemonServer: DaemonServer | null = null;
  let agent: AirPrompterAgent | null = null;
  if (flag(parsed, "daemon")) {
    const stateDir = str(parsed, "state-dir") ?? join(dir, DEV_DIR, "state");
    mkdirSync(stateDir, { recursive: true });
    const socketPath = daemonSocketPath({ stateDir, agentId: scope.agentId, target: scope.target });
    agent = await AirPrompterAgent.start({
      ...scope,
      apiKey: DEV_API_KEY,
      baseUrl: server.baseUrl,
      stateDir,
      root: { pinned: publicJwkOf(keys.rootKey), hostedEnvironment: scope.target },
      sync: { mode: "resident", pollSeconds, edgePointerUrl: `${server.baseUrl}/edge/${scope.agentId}/${scope.target}/generation.json`, rootUrl: `${server.baseUrl}/roots/${scope.target}/root.json` },
      telemetry: { upload: false },
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
      now: ctx.now,
      logger: log,
      sdk: { name: "airprompterd", version: CLI_VERSION },
    });
    daemonServer = new DaemonServer(agent, { socketPath, version: CLI_VERSION, protocol: PROTOCOL_VERSION, agentId: scope.agentId, target: scope.target, now: ctx.now, logger: log, uploader: null });
    await daemonServer.listen();
    out.field("daemonSocket", socketPath, "daemon socket");
    out.field("stateDir", SlotStore.path({ stateDir, agentId: scope.agentId, target: scope.target }), "daemon store");
  }
  out.flush();
  log({ event: "serving", baseUrl: server.baseUrl, generation: plane.generation, daemon: daemonServer !== null });

  const exitAfter = str(parsed, "exit-after");
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (exitAfter) setTimeout(stop, Number(exitAfter) * 1000).unref();
  });
  if (timer) clearTimeout(timer);
  watcher?.close();
  if (daemonServer) await daemonServer.close();
  if (agent) await agent.stop();
  await server.close();
  log({ event: "stopped", generation: plane.generation });
  return EXIT.ok;
}
