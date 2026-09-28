/**
 * The telemetry daemon's two files (`protocol/daemon.md`, draft 3): the
 * discovery file the daemon publishes (`<storeDir>/daemon.json` — the folder
 * it scans and how it is doing), and the manifest a writer adds beside each
 * closed segment (`seg-….manifest.json` — the segment's size, digest and rows,
 * the writer's scope, and its heartbeat report without `spool`). Both are
 * written with a temp file and a rename, so a reader never sees half of one.
 *
 * @example
 * ```ts
 * const found = readDaemonDiscovery(fs, storeDir, { agentId, target, organizationId, nowMs: Date.now() });
 * const spoolDir = found.live ? found.discovery.spoolDir : join(storeDir, "spool", "telemetry");
 * writeSegmentManifest(fs, spoolDir, "seg-i-7f3a…-29817383-0.ndjson", { organizationId, agentId, target, report, closedAtMs: Date.now() });
 * const manifest = readSegmentManifest(fs, spoolDir, "seg-i-7f3a…-29817383-0.ndjson"); // { ok: true, manifest } | { ok: false, reason } | null
 * ```
 */

import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { FsPort } from "@airprompter/agent-core";

export const SPOOL_MANIFEST_FORMAT = 1 as const;
export const DAEMON_DISCOVERY_FORMAT = 1 as const;
/** A closed segment with no manifest waits this long for its writer to add one before it is uploaded without. */
export const MANIFEST_GRACE_MS = 60 * 1000;
/** A discovery file whose `heartbeatAt` is older than this names a daemon that is gone. */
export const DAEMON_DISCOVERY_MAX_AGE_MS = 10 * 60 * 1000;
/** The daemon refreshes `heartbeatAt` at least this often. */
export const DAEMON_DISCOVERY_REFRESH_MS = 60 * 1000;
export const DAEMON_DISCOVERY_FILE = "daemon.json";
export const MANIFEST_SUFFIX = ".manifest.json";
export const MANIFEST_NAME = /^seg-([A-Za-z0-9._~-]{8,64})-(\d+)-(\d+)\.manifest\.json$/;

export interface SegmentManifest {
  format: 1;
  kind: "segment";
  segment: string;
  bytes: number;
  sha256: string;
  rows: number;
  instanceId: string;
  organizationId: string;
  agentId: string;
  target: string;
  closedAt: string;
  /** The writer's heartbeat request without `spool` (heartbeat.schema.json › request). */
  report: Record<string, unknown>;
}

export interface DaemonDiscovery {
  format: 1;
  kind: "daemon";
  daemon: { name: "airprompterd"; version: string };
  pid: number;
  organizationId: string | null;
  agentId: string;
  target: string;
  spoolDir: string;
  startedAt: string;
  heartbeatAt: string;
  uploadIntervalSeconds: number;
  sink: "airprompter" | "otlp" | "none";
  upload: { lastUploadAt: string | null; backoffUntil: string | null; sentSegments: number; quarantinedSegments: number; droppedSegments: number; depthSegments: number; depthBytes: number };
}

/** `seg-….ndjson` → `seg-….manifest.json`. */
export function manifestNameOf(segment: string): string {
  return `${segment.slice(0, -".ndjson".length)}${MANIFEST_SUFFIX}`;
}

/** `seg-….manifest.json` → `seg-….ndjson`. */
export function segmentNameOfManifest(manifest: string): string {
  return `${manifest.slice(0, -MANIFEST_SUFFIX.length)}.ndjson`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Write a file whole: temp + rename, mode 0600. Throws what the port throws — the callers count it. */
function replaceFile(fs: FsPort, path: string, text: string): void {
  const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFile(temp, Buffer.from(text, "utf8"), 0o600);
  fs.rename(temp, path);
}

/** Build and write a closed segment's manifest from the segment's own bytes. Throws on a filesystem failure. */
export function writeSegmentManifest(fs: FsPort, dir: string, segment: string, context: { organizationId: string; agentId: string; target: string; report: Record<string, unknown>; closedAtMs: number }): SegmentManifest {
  const bytes = fs.readFile(join(dir, segment));
  let rows = 0;
  for (const byte of bytes) if (byte === 0x0a) rows += 1;
  const instanceId = /^seg-(.+)-\d+-\d+\.ndjson$/.exec(segment)?.[1] ?? "";
  const { spool: _spool, ...report } = context.report;
  const manifest: SegmentManifest = {
    format: SPOOL_MANIFEST_FORMAT,
    kind: "segment",
    segment,
    bytes: bytes.length,
    sha256: sha256Hex(bytes),
    rows,
    instanceId,
    organizationId: context.organizationId,
    agentId: context.agentId,
    target: context.target,
    closedAt: new Date(context.closedAtMs).toISOString(),
    report: { ...report, instanceId },
  };
  replaceFile(fs, join(dir, manifestNameOf(segment)), JSON.stringify(manifest));
  return manifest;
}

const str = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * A segment's manifest: `null` when there is none; `{ ok: false, reason }` when there is one that cannot be trusted
 * (unreadable, another format, the wrong segment or instance) — the daemon quarantines the pair.
 */
export function readSegmentManifest(fs: FsPort, dir: string, segment: string): { ok: true; manifest: SegmentManifest } | { ok: false; reason: string } | null {
  const path = join(dir, manifestNameOf(segment));
  if (!fs.exists(path)) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(Buffer.from(fs.readFile(path)).toString("utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "manifest_unreadable" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "manifest_unreadable" };
  if (parsed.format !== SPOOL_MANIFEST_FORMAT || parsed.kind !== "segment") return { ok: false, reason: "manifest_format" };
  if (parsed.segment !== segment) return { ok: false, reason: "manifest_names_another_segment" };
  const instanceId = /^seg-(.+)-\d+-\d+\.ndjson$/.exec(segment)?.[1];
  if (parsed.instanceId !== instanceId) return { ok: false, reason: "manifest_instance_mismatch" };
  if (!Number.isInteger(parsed.bytes) || !str(parsed.sha256) || !Number.isInteger(parsed.rows)) return { ok: false, reason: "manifest_incomplete" };
  if (!str(parsed.organizationId) || !str(parsed.agentId) || !str(parsed.target) || !parsed.report || typeof parsed.report !== "object") return { ok: false, reason: "manifest_incomplete" };
  return { ok: true, manifest: parsed as unknown as SegmentManifest };
}

export function daemonDiscoveryPath(storeDir: string): string {
  return join(storeDir, DAEMON_DISCOVERY_FILE);
}

export type DiscoveryResult =
  | { live: true; discovery: DaemonDiscovery }
  | { live: false; reason: "absent" | "unreadable" | "format" | "scope" | "stale"; discovery: DaemonDiscovery | null };

/**
 * The daemon's discovery file for this agent and target, and whether it is live: readable, format 1, this scope, and
 * `heartbeatAt` within `maxAgeMs` (10 minutes). Anything else is ignored — never trusted in part.
 */
export function readDaemonDiscovery(fs: FsPort, storeDir: string, input: { agentId: string; target: string; organizationId?: string | null; nowMs: number; maxAgeMs?: number }): DiscoveryResult {
  const path = daemonDiscoveryPath(storeDir);
  let exists = false;
  try {
    exists = fs.exists(path);
  } catch {
    exists = false;
  }
  if (!exists) return { live: false, reason: "absent", discovery: null };
  let parsed: DaemonDiscovery;
  try {
    parsed = JSON.parse(Buffer.from(fs.readFile(path)).toString("utf8")) as DaemonDiscovery;
  } catch {
    return { live: false, reason: "unreadable", discovery: null };
  }
  if (!parsed || parsed.format !== DAEMON_DISCOVERY_FORMAT || parsed.kind !== "daemon" || !str(parsed.spoolDir) || !str(parsed.heartbeatAt)) return { live: false, reason: "format", discovery: null };
  if (parsed.agentId !== input.agentId || parsed.target !== input.target || (input.organizationId && parsed.organizationId && parsed.organizationId !== input.organizationId)) return { live: false, reason: "scope", discovery: parsed };
  const age = input.nowMs - Date.parse(parsed.heartbeatAt);
  if (!Number.isFinite(age) || age > (input.maxAgeMs ?? DAEMON_DISCOVERY_MAX_AGE_MS)) return { live: false, reason: "stale", discovery: parsed };
  return { live: true, discovery: parsed };
}

/** Publish (or refresh) the discovery file: temp + rename, mode 0600. Throws what the port throws. */
export function writeDaemonDiscovery(fs: FsPort, storeDir: string, discovery: DaemonDiscovery): void {
  fs.mkdirp(storeDir, 0o700);
  replaceFile(fs, daemonDiscoveryPath(storeDir), JSON.stringify(discovery, null, 2));
}

/** A clean stop removes the file; a crash leaves it to go stale. Never throws. */
export function removeDaemonDiscovery(fs: FsPort, storeDir: string, pid?: number): void {
  try {
    const path = daemonDiscoveryPath(storeDir);
    if (!fs.exists(path)) return;
    // Another daemon took over the file since: it is not ours to remove.
    if (pid !== undefined) {
      const held = JSON.parse(Buffer.from(fs.readFile(path)).toString("utf8")) as { pid?: number };
      if (held.pid !== pid) return;
    }
    fs.unlink(path);
  } catch {
    // Best effort: a file left behind goes stale on its own.
  }
}
