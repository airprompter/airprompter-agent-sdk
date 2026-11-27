/**
 * `airprompter dev ./dir` (S12): a directory of prompts served as a registry
 * over the protocol's own routes — the manifest, the payloads, the heartbeat,
 * the edge pointer and the root — signed with a dev key under
 * a dev root, so an SDK or the CLI syncs from it exactly as from
 * the hosted service. Git customers get live sync while they edit; Hangar (a
 * self-hosted registry) gets a runnable conformance target; the conformance
 * runner's live mode (`conformance/live.mjs`) exercises it beside hosted.
 *
 * The directory: every `.md` / `.txt` / `.prompt` file is a slot; its tag is
 * the relative path without the extension, `/` as `.`, lower-cased
 * (`support/Triage.md` → `support.triage`). Front matter may name `model:`,
 * `variables:` (comma-separated; `name!` is required, `name?` is end-user
 * text, `name=some default` gives an optional operator variable its default
 * (a default holds no comma), `name~` marks it as filled by the
 * application's own source (`source: runtime`) — the markers go in that
 * order, `name!~` and `name~=default`; without the line every
 * `{{placeholder}}` is an optional operator variable), `version:`. An optional `release.json` beside them carries the
 * manifest's `applyPolicy`, `leaseSeconds`, `unlockWindow`, `experiments` and
 * `directives`.
 *
 * The rules:
 * - **Every save is a generation.** The directory is watched; a change that
 *   alters the release (a slot's bytes, model, variables, or release.json) is
 *   promoted as generation + 1, signed; an unchanged re-read is not. A file
 *   that does not parse is reported and the last good generation keeps
 *   serving. `fs.watch` can miss an event (a busy macOS fseventsd, network
 *   and container mounts; AIR-2268), so the directory is also re-read every
 *   500 ms: a read that differs from the last one is handled as a watch event
 *   would be, and an unchanged fingerprint never promotes.
 * - **The keys persist.** `<dir>/.airprompter-dev/keys.json` (mode 0600) holds
 *   the dev root and signing keys; `root.pub.json` beside it is what a client
 *   pins (`--root`). A root pinned yesterday verifies today's generations.
 * - **`unlock_required` is honoured locally.** With `release.json`'s
 *   `applyPolicy: "unlock_required"` (or `--apply-policy`), every generation
 *   is staged by the clients and waits for `airprompter unlock` on the host —
 *   the same flow as production, on the laptop.
 * - **SDKs sync from it directly.** Point a resident SDK at the registry
 *   (`baseUrl`, the edge pointer, the root) with a short `pollSeconds`, and
 *   every promotion reaches it within one poll. (`--daemon` was removed in
 *   0.3.0 with the release-serving daemon: `protocol/daemon.md`.)
 * - **Nothing here is trusted beyond the machine.** The API key is a
 *   fixed dev key (`apa_dev_local`), the root is self-made, the listener is
 *   loopback unless `--host` says otherwise; a manifest signed here never
 *   verifies against a production root.
 *
 * @example
 * ```sh
 * airprompter dev ./prompts --port 4180
 * AIRPROMPTER_AGENT_KEY=apa_dev_local airprompter pull --org org_dev --agent agt_dev --environment dev \
 *   --root ./prompts/.airprompter-dev/root.pub.json --base-url http://127.0.0.1:4180 --out ./release.apbundle --plaintext
 * ```
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, watch, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { ManifestPayload, ManifestSlot, P256PrivateJwk, SlotVariable, Target } from "../../../sdk-typescript/packages/sdk/src/core/protocol/types.js";
import { sha256Prefixed } from "../../../sdk-typescript/packages/sdk/src/core/protocol/canonicalJson.js";
import { publicJwkOf } from "../../../sdk-typescript/packages/sdk/src/core/protocol/trust.js";
import { FakeControlPlane, serveOverHttp } from "../../../sdk-typescript/packages/sdk/src/core/testing/controlPlane.js";

import { COMMON_OPTIONS, TARGET, TARGET_USAGE, flag, helpFor, parse, str, type OptionSpec } from "../args.js";
import { EXIT, Output, usage, type Context } from "../io.js";
import { CLI_VERSION, PROTOCOL_VERSION } from "../version.js";

export const DEV_API_KEY = "apa_dev_local";
export const DEV_DIR = ".airprompter-dev";

export const DEV_OPTIONS: OptionSpec = {
  org: { type: "string", default: "org_dev", help: "Organization id the manifests carry" },
  agent: { type: "string", default: "agt_dev", help: "Agent id the manifests carry" },
  environment: { type: "string", default: "dev", help: "Target: a lowercase slug such as dev, qa or prod" },
  host: { type: "string", default: "127.0.0.1", help: "Listen address (loopback unless you say otherwise)" },
  port: { type: "string", default: "4180", help: "Listen port (0 picks a free one)" },
  "apply-policy": { type: "string", help: "The manifest's apply policy: auto (default) or unlock_required (every generation waits for airprompter unlock on each host)" },
  "lease-seconds": { type: "string", help: "The manifest's lease (default 3600)" },
  daemon: { type: "boolean", help: "Removed in 0.3.0: point SDKs at the registry directly (resident mode, a short pollSeconds)" },
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
  options: Partial<Pick<ManifestPayload, "applyPolicy" | "leaseSeconds" | "experiments" | "directives" | "unlockWindow">>;
  requireCountersign: boolean;
  /** What the release amounts to: a change here is a generation, nothing else is. */
  fingerprint: string;
  problems: string[];
}

/** `support/Triage.md` → `support.triage`. */
export function tagFromPath(relativePath: string): string {
  return relativePath.replace(PROMPT_FILE, "").split(sep).join("/").split("/").join(".").toLowerCase();
}

const VARIABLE_NAME = /^[a-zA-Z0-9_.-]{1,64}$/;

/**
 * `name!` required operator text, `name?` end-user text (fenced), `name` optional operator text; `name=default` an
 * optional operator variable with its default, `name~` one the application fills from its own source
 * (`source: runtime`), `name~=default` both. The markers go in one order — `name!~`, `name?~`, then `=default` —
 * and the name is checked against the protocol's grammar, so `name~!` is an error rather than a variable called
 * `name~`. A default on a required or end-user variable is refused here, as the control plane refuses it; so is an
 * empty one.
 */
export function parseVariables(spec: string | undefined): SlotVariable[] {
  if (!spec?.trim()) return [];
  return spec.split(",").map((raw) => raw.trim()).filter(Boolean).map((raw) => {
    const eq = raw.indexOf("=");
    const head = eq === -1 ? raw : raw.slice(0, eq).trim();
    const defaultValue = eq === -1 ? undefined : raw.slice(eq + 1).trim();
    const runtime = head.endsWith("~");
    const marker = head.replace(/~$/, "");
    const required = marker.endsWith("!");
    const endUser = marker.endsWith("?");
    const name = marker.replace(/[!?]$/, "");
    if (!VARIABLE_NAME.test(name)) throw new Error(`variable ${JSON.stringify(raw)}: the name must match ${VARIABLE_NAME} — write the markers as name!, name?, name~ or name!~ / name?~, then =default`);
    if (defaultValue !== undefined && (required || endUser)) throw new Error(`variable ${name}: a default belongs to an optional operator variable only`);
    if (defaultValue === "") throw new Error(`variable ${name}: a default is never empty`);
    return {
      name,
      required: required || endUser,
      trust: endUser ? "end_user" : "operator",
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      ...(runtime ? { source: "runtime" as const } : {}),
    };
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

function isDanglingLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function walk(dir: string, out: string[] = [], root = true): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch (error) {
    // A subfolder removed while it is read (a rename, a checkout) is simply not there; the served folder itself is.
    if (!root && (error as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const path = join(dir, entry);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(path).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A prompt file that is a symlink to nothing is still there: read, it is reported as a problem.
      if (PROMPT_FILE.test(entry) && isDanglingLink(path)) out.push(path);
      // Anything else that vanished between the listing and the stat (an editor's temp file) is skipped, as the next
      // read will.
      continue;
    }
    if (isDirectory) walk(path, out, false);
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

/** How often the directory is re-read as a fallback to `fs.watch` (AIR-2268). */
export const DEV_RESCAN_MS = 500;
/** How long the directory must be quiet after an event before it is read, and how far apart the two reads that must
 * agree before a promotion are. */
export const DEV_DEBOUNCE_MS = 200;

/** A recursive watch on `dir`: `listener` for each change, `onError` if the watcher fails later (Windows reports EPERM
 * when the watched folder is deleted). */
export type WatchFn = (dir: string, listener: (name: string | null) => void, onError: (error: Error) => void) => { close(): void };

const nodeWatch: WatchFn = (dir, listener, onError) => {
  const watcher = watch(dir, { recursive: true }, (_kind, name) => listener(name === null ? null : String(name)));
  watcher.on("error", onError);
  return watcher;
};

export interface DevWatchOptions {
  dir: string;
  /** The release as read when serving began. */
  initial: DevRelease;
  /** The fingerprint being served now: a read with this fingerprint is never promoted. */
  served: () => string;
  /** A settled read whose release differs from the one served: promote it. A throw is logged, never fatal. */
  promote: (next: DevRelease) => void;
  log: (event: Record<string, unknown>) => void;
  /** Injected by tests; `fs.watch(dir, { recursive: true })` otherwise. */
  watch?: WatchFn;
  rescanMs?: number;
  debounceMs?: number;
}

export interface DevWatcher {
  close(): void;
  /** Counters a test can wait on: completed rescans, and settled reloads (two agreeing reads, handled). */
  readonly stats: { rescans: number; reloads: number };
}

/**
 * The directory's hot reload.
 *
 * - **Settled reads only.** A watch event starts a debounce. When the directory has been quiet for `debounceMs` it is
 *   read, and read again `debounceMs` later; only when the two reads agree (the same fingerprint and the same problems)
 *   are the problems logged and a release whose fingerprint differs from the served one promoted. Reads that disagree
 *   (a save still being written) start the pair again. So an in-place save written in bursts is promoted once, whole;
 *   only a writer that pauses for longer than `debounceMs` in the middle of a file can still be read half-written.
 * - **A fallback for missed events.** `fs.watch` can drop them (AIR-2268), so every `rescanMs` the directory is also
 *   read. A rescan that finds a different fingerprint or a different set of problems from the last settled read starts
 *   the same debounce, its read the first of the pair; one that finds the same does nothing and logs nothing. A missed
 *   event costs at most `rescanMs + debounceMs` (about 700 ms) more than a delivered one.
 * - **An unchanged fingerprint is never promoted**, on either path.
 * - **Nothing here stops the server:** a folder that cannot be read is logged once (`read_failed`), a watcher that
 *   cannot start or fails later is logged (`watch_unavailable`, `watch_failed`) and the rescans carry on alone, and a
 *   promotion that throws is logged (`promote_failed`). The last generation keeps serving throughout.
 *
 * The idle cost is one read of the directory per tick: a readdir per folder, a stat per entry, a read of every prompt
 * file and release.json, and the release's SHA-256s (one per slot without a `version:`, one for the whole).
 */
export function watchDevRelease(options: DevWatchOptions): DevWatcher {
  const { dir, log } = options;
  const rescanMs = options.rescanMs ?? DEV_RESCAN_MS;
  const debounceMs = options.debounceMs ?? DEV_DEBOUNCE_MS;
  const stats = { rescans: 0, reloads: 0 };
  const keyOf = (release: DevRelease) => `${release.fingerprint} ${JSON.stringify(release.problems)}`;
  let lastKey = keyOf(options.initial);
  let lastReadError: string | null = null;
  // The read the next one must agree with before anything is acted on; null: none yet.
  let candidate: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  const read = (): DevRelease | null => {
    try {
      const release = readDevRelease(dir);
      lastReadError = null;
      return release;
    } catch (error) {
      // The folder itself is gone or unreadable: keep serving the last generation, say so once.
      const reason = (error as Error).message;
      if (reason !== lastReadError) log({ event: "read_failed", reason });
      lastReadError = reason;
      return null;
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(reload, debounceMs);
  };
  const reload = () => {
    timer = null;
    if (closed) return;
    const next = read();
    if (!next) {
      candidate = null;
      return;
    }
    const key = keyOf(next);
    if (key !== candidate) {
      // Not settled yet (or the first read of the pair): read again once the folder has been quiet as long again.
      candidate = key;
      schedule();
      return;
    }
    candidate = null;
    stats.reloads += 1;
    lastKey = key;
    for (const problem of next.problems) log({ event: "problem", problem });
    if (next.slots.length === 0) {
      log({ event: "kept", reason: "no prompt files; the last generation keeps serving" });
      return;
    }
    if (next.fingerprint === options.served()) return;
    try {
      options.promote(next);
    } catch (error) {
      log({ event: "promote_failed", reason: (error as Error).message });
    }
  };
  /** Something may have changed: start the pair of reads again (`first`: a read already taken, the first of the pair). */
  const changed = (first: DevRelease | null = null) => {
    if (closed) return;
    candidate = first ? keyOf(first) : null;
    schedule();
  };

  let watcher: { close(): void } | null = null;
  try {
    watcher = (options.watch ?? nodeWatch)(
      dir,
      (name) => {
        if (name && name.startsWith(DEV_DIR)) return;
        changed();
      },
      (error) => {
        if (!watcher) return;
        log({ event: "watch_failed", reason: error.message, rescanMs });
        const failed = watcher;
        watcher = null;
        try {
          failed.close();
        } catch {
          // already closed
        }
      },
    );
  } catch (error) {
    log({ event: "watch_unavailable", reason: (error as Error).message, rescanMs });
  }
  const rescan = setInterval(() => {
    // A debounce already running reads the directory itself when it ends.
    if (closed || timer) return;
    const now = read();
    stats.rescans += 1;
    if (now && keyOf(now) !== lastKey) changed(now);
  }, rescanMs);
  rescan.unref();

  return {
    stats,
    close() {
      closed = true;
      clearInterval(rescan);
      if (timer) clearTimeout(timer);
      timer = null;
      watcher?.close();
      watcher = null;
    },
  };
}

export async function dev(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, DEV_OPTIONS);
  if (flag(parsed, "help")) {
    ctx.stdout(helpFor("dev", "<directory> [--port 4180] [--apply-policy unlock_required]", DEV_OPTIONS));
    return EXIT.ok;
  }
  if (flag(parsed, "daemon")) throw usage("--daemon was removed in 0.3.0 with the release-serving daemon: point SDKs at this registry directly (resident mode, a short pollSeconds; protocol/daemon.md)");
  const dir = parsed.positionals[0];
  if (!dir) throw usage("dev takes the directory to serve: airprompter dev ./prompts");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw usage(`${dir} is not a directory`);
  const target = str(parsed, "environment") ?? "dev";
  if (!TARGET.test(target)) throw usage(TARGET_USAGE);
  const applyPolicy = str(parsed, "apply-policy");
  if (applyPolicy !== undefined && applyPolicy !== "auto" && applyPolicy !== "unlock_required") throw usage("--apply-policy must be auto or unlock_required");
  const leaseSeconds = str(parsed, "lease-seconds") !== undefined ? Number(str(parsed, "lease-seconds")) : undefined;
  if (leaseSeconds !== undefined && (!Number.isFinite(leaseSeconds) || leaseSeconds < 60)) throw usage("--lease-seconds must be at least 60");
  const port = Number(str(parsed, "port") ?? "4180");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw usage("--port must be 0–65535");
  const host = str(parsed, "host") ?? "127.0.0.1";
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
  const watcher = watchDevRelease({
    dir,
    initial: release,
    served: () => release.fingerprint,
    promote: (next) => {
      // Served only once promoted: a promotion that throws leaves the last release served (and is logged).
      const generation = promoteRelease(plane, next, overrides);
      release = next;
      writeFileSync(counterPath, `${generation}\n`);
      log({ event: "generation", generation, slots: release.slots.map((s) => s.tag), applyPolicy: overrides.applyPolicy ?? release.options.applyPolicy ?? "auto" });
    },
    log,
  });

  out.flush();
  log({ event: "serving", baseUrl: server.baseUrl, generation: plane.generation });

  const exitAfter = str(parsed, "exit-after");
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (exitAfter) setTimeout(stop, Number(exitAfter) * 1000).unref();
  });
  watcher.close();
  await server.close();
  log({ event: "stopped", generation: plane.generation });
  return EXIT.ok;
}
