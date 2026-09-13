/**
 * The spool uploader (T26 P4, D52/D66): closed segments from ANY writer in
 * `<store>/spool/telemetry/` are validated line by line against the spool
 * row contract, quarantined when they do not fit, and POSTed straight to S3
 * under the heartbeat's presigned grant — one in flight per host, oldest
 * first, exponential backoff with full jitter (1 s → 5 min), acknowledged
 * segments DELETED (S6: S3 keys are idempotent, a lost response is a
 * replay, nothing needs keeping), `quarantine/` and `exported/` capped in
 * bytes and swept by age, abandoned `.open` files reclaimed, the host
 * budget enforced across writers with the loss written as a `dropped` row.
 * Nothing here reads a row for anything but its shape.
 *
 * S6 — the disk budget is a published invariant (spool-format.md draft 2):
 *
 *   tree ≤ budget + (writers × 1 MiB open) + quarantine cap + exported cap
 *
 * Closed unsent segments are the budget; each live writer holds at most one
 * open segment of at most 1 MiB; quarantine/ and exported/ hold at most
 * their caps; nothing else is ever parked under the spool.
 *
 * A grant is per INSTANCE prefix (`org/{org}/agent/{agent}/{target}/{instance}/`)
 * and the ingest processor holds every row to the prefix it arrived under,
 * so a daemon that uploads for several writers holds one grant per writer:
 * `grantFor(instanceId)` is the daemon's heartbeat carrying that writer's
 * instance id. The serverless path uses the same `postSegment` with the
 * runtime's own grant at invocation end.
 */

import { nodeFs } from "../ports/node.js";
import { fsFailureCode, type FsPort } from "../protocol/ports.js";
import { join } from "node:path";

import { HOST_SPOOL_BUDGET_BYTES, LATENCY_BUCKET_EDGES_MS, SEGMENT_MAX_BYTES, epochMinute, segmentName, type ErrorClass, type SpoolRow } from "../spool/writer.js";
import type { FetchLike } from "../sync/client.js";

export const UPLOAD_BACKOFF_BASE_MS = 1000;
export const UPLOAD_BACKOFF_CAP_MS = 5 * 60 * 1000;
export const QUARANTINE_RETENTION_MS = 24 * 60 * 60 * 1000;
/** S6: `quarantine/` and `exported/` are capped in bytes, oldest first — a buggy third-party writer cannot fill the disk through quarantine. */
export const QUARANTINE_CAP_BYTES = 10 * 1024 * 1024;
export const EXPORTED_CAP_BYTES = 10 * 1024 * 1024;
/** S6: an `.open` segment untouched this long has no writer behind it (a live one closes every minute it has traffic, and its stale windows within one); it is closed and uploaded like any other. */
export const OPEN_SEGMENT_RECLAIM_MS = 60 * 60 * 1000;
/** S6: the uploader stamps its last acknowledged upload here (mtime), so `airprompter status` can say it without a daemon. */
export const LAST_UPLOAD_MARKER = ".last-upload";
/** A grant is refreshed this long before its `expiresAt`, so an upload never starts on one about to lapse. */
export const GRANT_REFRESH_MARGIN_MS = 60 * 1000;
export const SEGMENT_NAME = /^seg-([A-Za-z0-9._~-]{8,64})-(\d+)-(\d+)\.ndjson$/;
export const OPEN_SEGMENT_NAME = /^seg-([A-Za-z0-9._~-]{8,64})-(\d+)-(\d+)\.ndjson\.open$/;

/** The heartbeat's `uploadGrant` (protocol heartbeat.schema.json). */
export interface UploadGrant {
  grantId: string;
  url: string;
  fields: Record<string, string>;
  keyPrefix: string;
  expiresAt: string;
  maxObjectBytes: number;
  contentType?: "application/x-ndjson";
}

export type GrantDecision = { kind: "grant"; grant: UploadGrant; uploadIntervalSeconds?: number } | { kind: "hold"; retryAfterSeconds: number; reason?: string } | { kind: "unavailable"; reason: string };

// ---------------------------------------------------------------------------
// Row validation: the spool contract (spool-rows.schema.json + telemetry-window.schema.json), structurally
// ---------------------------------------------------------------------------

const INSTANCE_ID = /^[A-Za-z0-9._~-]{8,64}$/;
const TAG = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const ARM = /^[a-z0-9_-]{1,32}$/;
const OUTCOME_NAME = /^[a-z][a-zA-Z0-9]{0,31}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const ERROR_CLASSES: ReadonlySet<string> = new Set<ErrorClass>(["render_missing_variable", "context_length_exceeded", "output_schema_invalid", "truncated", "content_filter", "provider_error", "provider_timeout", "provider_rate_limited"]);
const REFUSAL_REASONS: ReadonlySet<string> = new Set(["disabled", "lease_expired", "payload_verification_failed", "forced_downgrade", "model_unavailable", "unlock_refused"]);
const USAGE_SOURCES: ReadonlySet<string> = new Set(["reported", "measured", "estimated", "unavailable"]);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNonNegativeInt = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isInteger(value) && value >= min;
const isString = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const onlyKeys = (object: Record<string, unknown>, allowed: readonly string[]): string | null => Object.keys(object).find((key) => !allowed.includes(key)) ?? null;

export type RowVerdict = { ok: true; row: SpoolRow } | { ok: false; reason: string };

/** One parsed line against the contract. The reason names the first field that does not fit — never the value. */
export function validateSpoolRow(value: unknown): RowVerdict {
  if (!isObject(value)) return { ok: false, reason: "not_an_object" };
  if (value.v !== 1) return { ok: false, reason: "v" };
  if (!isString(value.instanceId, 64) || !INSTANCE_ID.test(value.instanceId)) return { ok: false, reason: "instanceId" };
  switch (value.type) {
    case "window": {
      const extra = onlyKeys(value, ["type", "v", "minute", "instanceId", "instanceClass", "tag", "versionId", "arm", "model", "status", "errorClass", "usageSource", "count", "latencyMs", "tokens", "checks", "outcomes", "sdk"]);
      if (extra) return { ok: false, reason: `unknown_field:${extra}` };
      if (!isString(value.minute, 64) || !DATE_TIME.test(value.minute)) return { ok: false, reason: "minute" };
      if (value.instanceClass !== "resident" && value.instanceClass !== "ephemeral") return { ok: false, reason: "instanceClass" };
      if (!isString(value.tag, 128) || !TAG.test(value.tag)) return { ok: false, reason: "tag" };
      if (!isString(value.versionId, 128)) return { ok: false, reason: "versionId" };
      if (!isString(value.arm, 32) || !ARM.test(value.arm)) return { ok: false, reason: "arm" };
      if (!isString(value.model, 128)) return { ok: false, reason: "model" };
      if (value.status !== "ok" && value.status !== "error" && value.status !== "refused") return { ok: false, reason: "status" };
      if (value.errorClass !== undefined && value.errorClass !== null && !(typeof value.errorClass === "string" && ERROR_CLASSES.has(value.errorClass))) return { ok: false, reason: "errorClass" };
      if (typeof value.usageSource !== "string" || !USAGE_SOURCES.has(value.usageSource)) return { ok: false, reason: "usageSource" };
      if (!isNonNegativeInt(value.count)) return { ok: false, reason: "count" };
      const latency = value.latencyMs;
      if (!isObject(latency) || onlyKeys(latency, ["buckets", "sum"]) || !Array.isArray(latency.buckets) || latency.buckets.length !== LATENCY_BUCKET_EDGES_MS.length || !latency.buckets.every((b) => isNonNegativeInt(b)) || !isNonNegativeInt(latency.sum)) return { ok: false, reason: "latencyMs" };
      const tokens = value.tokens;
      if (!isObject(tokens) || onlyKeys(tokens, ["input", "cachedInput", "output"]) || !isNonNegativeInt(tokens.input) || !isNonNegativeInt(tokens.output) || (tokens.cachedInput !== undefined && !isNonNegativeInt(tokens.cachedInput))) return { ok: false, reason: "tokens" };
      if (value.checks !== undefined) {
        const checks = value.checks;
        if (!isObject(checks) || onlyKeys(checks, ["passed", "failed"]) || (checks.passed !== undefined && !isNonNegativeInt(checks.passed)) || (checks.failed !== undefined && !isNonNegativeInt(checks.failed))) return { ok: false, reason: "checks" };
      }
      if (value.outcomes !== undefined) {
        const outcomes = value.outcomes;
        if (!isObject(outcomes)) return { ok: false, reason: "outcomes" };
        for (const [name, entry] of Object.entries(outcomes)) {
          if (!OUTCOME_NAME.test(name) || !isObject(entry) || onlyKeys(entry, ["n", "sum"]) || !isNonNegativeInt(entry.n) || typeof entry.sum !== "number" || !Number.isFinite(entry.sum)) return { ok: false, reason: `outcomes:${name}` };
        }
      }
      if (value.sdk !== undefined && !isString(value.sdk, 64)) return { ok: false, reason: "sdk" };
      return { ok: true, row: value as unknown as SpoolRow };
    }
    case "refusal": {
      const extra = onlyKeys(value, ["type", "v", "at", "instanceId", "reason", "generation", "tag"]);
      if (extra) return { ok: false, reason: `unknown_field:${extra}` };
      if (!isString(value.at, 64) || !DATE_TIME.test(value.at)) return { ok: false, reason: "at" };
      if (typeof value.reason !== "string" || !REFUSAL_REASONS.has(value.reason)) return { ok: false, reason: "reason" };
      if (!isNonNegativeInt(value.generation)) return { ok: false, reason: "generation" };
      if (!("tag" in value) || !(value.tag === null || (isString(value.tag, 128) && TAG.test(value.tag)))) return { ok: false, reason: "tag" };
      return { ok: true, row: value as unknown as SpoolRow };
    }
    case "dropped": {
      const extra = onlyKeys(value, ["type", "v", "at", "instanceId", "segments", "bytes"]);
      if (extra) return { ok: false, reason: `unknown_field:${extra}` };
      if (!isString(value.at, 64) || !DATE_TIME.test(value.at)) return { ok: false, reason: "at" };
      if (!isNonNegativeInt(value.segments, 1)) return { ok: false, reason: "segments" };
      if (!isNonNegativeInt(value.bytes)) return { ok: false, reason: "bytes" };
      return { ok: true, row: value as unknown as SpoolRow };
    }
    default:
      return { ok: false, reason: "unknown_type" };
  }
}

export interface SegmentInspection {
  rows: SpoolRow[];
  /** Line numbers (1-based) and reasons; empty means the segment fits the contract. */
  invalid: Array<{ line: number; reason: string }>;
  /** A last line without its `\n` (a crashed writer): skipped, never counted as invalid. */
  partialTail: boolean;
}

/** Every line of a segment against the contract; `instanceId` (from the file name) is authoritative for every row. */
export function inspectSegment(bytes: Uint8Array, instanceId: string): SegmentInspection {
  const text = Buffer.from(bytes).toString("utf8");
  const partialTail = text.length > 0 && !text.endsWith("\n");
  const lines = text.split("\n");
  if (partialTail) lines.pop();
  else lines.pop(); // the empty string after the final newline
  const rows: SpoolRow[] = [];
  const invalid: SegmentInspection["invalid"] = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      invalid.push({ line: index + 1, reason: "not_json" });
      return;
    }
    const verdict = validateSpoolRow(parsed);
    if (!verdict.ok) invalid.push({ line: index + 1, reason: verdict.reason });
    else if (verdict.row.instanceId !== instanceId) invalid.push({ line: index + 1, reason: "instance_mismatch" });
    else rows.push(verdict.row);
  });
  return { rows, invalid, partialTail };
}

// ---------------------------------------------------------------------------
// The POST: a presigned S3 POST policy, multipart/form-data, fields verbatim then key then file
// ---------------------------------------------------------------------------

export function multipartBody(boundary: string, fields: Array<[string, string]>, file: { name: string; contentType: string; bytes: Uint8Array }): Buffer {
  const parts: Buffer[] = [];
  for (const [name, value] of fields) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, "utf8"));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.contentType}\r\n\r\n`, "utf8"));
  parts.push(Buffer.from(file.bytes));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  return Buffer.concat(parts);
}

export type PostOutcome = { status: "ok"; key: string } | { status: "refused"; httpStatus: number; expired: boolean } | { status: "too_large"; bytes: number } | { status: "network"; reason: string };

/** One segment under one grant. S3 PUT is idempotent by key, so a replay after a lost response overwrites identically. */
export async function postSegment(input: { grant: UploadGrant; segment: string; bytes: Uint8Array; fetch: FetchLike; now?: () => number; boundary?: string }): Promise<PostOutcome> {
  const { grant } = input;
  if (input.bytes.length > grant.maxObjectBytes) return { status: "too_large", bytes: input.bytes.length };
  const now = input.now?.() ?? Date.now();
  if (Date.parse(grant.expiresAt) <= now) return { status: "refused", httpStatus: 403, expired: true };
  const key = `${grant.keyPrefix}${input.segment}`;
  const contentType = grant.contentType ?? "application/x-ndjson";
  // The policy's own fields first, verbatim; `key` and `Content-Type` are what the policy conditions check; `file` last, as S3 requires.
  const fields: Array<[string, string]> = [...Object.entries(grant.fields).filter(([name]) => name !== "key" && name.toLowerCase() !== "content-type"), ["key", key], ["Content-Type", contentType]];
  const boundary = input.boundary ?? `----airprompter${Math.random().toString(36).slice(2)}${now.toString(36)}`;
  const body = multipartBody(boundary, fields, { name: input.segment, contentType, bytes: input.bytes });
  try {
    const response = await input.fetch(grant.url, { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(body.length) }, body });
    if (response.status >= 200 && response.status < 300) return { status: "ok", key };
    const text = await response.text().catch(() => "");
    return { status: "refused", httpStatus: response.status, expired: response.status === 403 && /expired|Policy expired|signature/i.test(text) };
  } catch (error) {
    return { status: "network", reason: (error as Error).message };
  }
}

/** Full jitter: uniform in [0, min(cap, base × 2^attempt)]. */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(UPLOAD_BACKOFF_CAP_MS, UPLOAD_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.max(0, Math.round(random() * ceiling));
}

// ---------------------------------------------------------------------------
// The uploader: a directory of segments from any writer, one grant per writer instance
// ---------------------------------------------------------------------------

export interface UploaderOptions {
  dir: string;
  /** The daemon's own instance id: `dropped` rows written by the budget sweep name it. */
  instanceId: string;
  /** A grant for one writer's prefix — the heartbeat carrying that writer's instance id. */
  grantFor: (instanceId: string) => Promise<GrantDecision>;
  fetch: FetchLike;
  now?: () => number;
  /** The filesystem (S2): the Node port by default; a fake that fills, fails or loses files in tests. */
  fs?: FsPort;
  random?: () => number;
  logger?: (event: Record<string, unknown>) => void;
  budgetBytes?: number;
  quarantineRetentionMs?: number;
  /** S6: byte caps on `quarantine/` and `exported/` (10 MiB each by default), oldest first. */
  quarantineCapBytes?: number;
  exportedCapBytes?: number;
  /** S6: how long an `.open` segment may sit untouched before it is closed as abandoned (1 h by default). */
  openReclaimMs?: number;
  /** The cadence between passes when no grant has said otherwise (the grant's `uploadIntervalSeconds` wins). */
  intervalSeconds?: number;
}

export interface UploaderStatus {
  lastUploadAt: string | null;
  lastError: string | null;
  backoffUntil: string | null;
  attempt: number;
  inFlight: boolean;
  intervalSeconds: number;
  nextPassAt: string | null;
  sentSegments: number;
  quarantinedSegments: number;
  droppedSegments: number;
  /** Live grants by writer instance and when each lapses. */
  grants: Array<{ instanceId: string; expiresAt: string }>;
  depth: { segments: number; bytes: number };
  /** S6: the invariant's other terms — open segments (one per live writer, ≤ 1 MiB each), quarantine/ and exported/ bytes — and the whole tree. */
  tree: { openSegments: number; openBytes: number; quarantineBytes: number; exportedBytes: number; totalBytes: number };
  /** S6: abandoned `.open` segments closed by the sweep, and quarantined / exported files evicted past their caps. */
  reclaimedSegments: number;
  capEvictedFiles: number;
}

export interface PassResult {
  uploaded: string[];
  quarantined: string[];
  dropped: number;
  held: boolean;
}

export class SpoolUploader {
  private readonly grants = new Map<string, UploadGrant>();
  private lastUploadMs: number | null = null;
  private lastError: string | null = null;
  private backoffUntilMs: number | null = null;
  private attempt = 0;
  private inFlight: Promise<PassResult> | null = null;
  private intervalSeconds: number;
  private nextPassMs: number | null = null;
  private sentSegments = 0;
  private quarantinedSegments = 0;
  private droppedSegments = 0;
  private reclaimedSegments = 0;
  private capEvictedFiles = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private readonly fs: FsPort;
  /** Filesystem failures by code — a sweep that could not stat, an evict that found the file gone (S2). */
  readonly fsFaults: Record<string, number> = {};

  constructor(private readonly options: UploaderOptions) {
    this.intervalSeconds = options.intervalSeconds ?? 300;
    this.fs = options.fs ?? nodeFs;
    this.fs.mkdirp(join(options.dir, "quarantine"), 0o700);
    this.fs.mkdirp(join(options.dir, "exported"), 0o700);
  }

  /** Run a filesystem step; a failure is counted by code and returns false (a segment a sibling took away is not an error). */
  private guard(step: string, run: () => void): boolean {
    try {
      run();
      return true;
    } catch (error) {
      const code = fsFailureCode(error);
      this.fsFaults[code] = (this.fsFaults[code] ?? 0) + 1;
      this.log({ event: "fs_fault", step, code });
      return false;
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private log(event: Record<string, unknown>): void {
    this.options.logger?.({ component: "uploader", ...event });
  }

  /** Closed, unsent segments, oldest first (by epoch minute, then n, then name). */
  closedSegments(): string[] {
    return this.fs
      .list(this.options.dir)
      .filter((name) => SEGMENT_NAME.test(name))
      .sort((a, b) => {
        const [, , ma, na] = SEGMENT_NAME.exec(a)!;
        const [, , mb, nb] = SEGMENT_NAME.exec(b)!;
        return Number(ma) - Number(mb) || Number(na) - Number(nb) || (a < b ? -1 : 1);
      });
  }

  depth(): { segments: number; bytes: number } {
    const segments = this.closedSegments();
    let bytes = 0;
    for (const name of segments) this.guard("stat_segment", () => void (bytes += this.fs.stat(join(this.options.dir, name)).size));
    return { segments: segments.length, bytes };
  }

  /** Bytes under one subdirectory (files only), oldest-first names beside it. */
  private dirBytes(sub: string): { names: string[]; bytes: number } {
    const dir = join(this.options.dir, sub);
    let names: string[] = [];
    this.guard("list_dir", () => void (names = this.fs.list(dir).sort()));
    let bytes = 0;
    for (const name of names) this.guard("stat_file", () => void (bytes += this.fs.stat(join(dir, name)).size));
    return { names, bytes };
  }

  /** S6: the invariant's terms as they stand — what a host actually has parked under the spool. */
  tree(): UploaderStatus["tree"] {
    const closed = this.depth();
    let openSegments = 0;
    let openBytes = 0;
    let names: string[] = [];
    this.guard("list_spool", () => void (names = this.fs.list(this.options.dir)));
    for (const name of names) {
      if (!OPEN_SEGMENT_NAME.test(name)) continue;
      openSegments += 1;
      this.guard("stat_open", () => void (openBytes += this.fs.stat(join(this.options.dir, name)).size));
    }
    const quarantineBytes = this.dirBytes("quarantine").bytes;
    const exportedBytes = this.dirBytes("exported").bytes;
    return { openSegments, openBytes, quarantineBytes, exportedBytes, totalBytes: closed.bytes + openBytes + quarantineBytes + exportedBytes };
  }

  /** S6: the published bound for this uploader's settings — `budget + writers × 1 MiB + quarantine cap + exported cap`. */
  bound(writers: number): number {
    return (this.options.budgetBytes ?? HOST_SPOOL_BUDGET_BYTES) + writers * SEGMENT_MAX_BYTES + (this.options.quarantineCapBytes ?? QUARANTINE_CAP_BYTES) + (this.options.exportedCapBytes ?? EXPORTED_CAP_BYTES);
  }

  /** Attached SDK processes and the daemon both write here; over the host budget the OLDEST unsent segments go and the loss is one `dropped` row under the daemon's own id. */
  enforceBudget(): number {
    const budget = this.options.budgetBytes ?? HOST_SPOOL_BUDGET_BYTES;
    const segments: Array<{ name: string; size: number }> = [];
    for (const name of this.closedSegments()) this.guard("stat_segment", () => void segments.push({ name, size: this.fs.stat(join(this.options.dir, name)).size }));
    let total = segments.reduce((sum, s) => sum + s.size, 0);
    let evicted = 0;
    let evictedBytes = 0;
    for (const segment of segments) {
      if (total <= budget) break;
      const removed = this.guard("evict_segment", () => this.fs.unlink(join(this.options.dir, segment.name)));
      total -= segment.size;
      if (!removed) continue;
      evicted += 1;
      evictedBytes += segment.size;
    }
    if (evicted > 0) {
      const at = this.now();
      const row = { type: "dropped", v: 1, at: new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z"), instanceId: this.options.instanceId, segments: evicted, bytes: evictedBytes };
      let n = 0;
      let name = segmentName(this.options.instanceId, epochMinute(at), n);
      while (this.fs.exists(join(this.options.dir, name)) || this.fs.exists(join(this.options.dir, `${name}.open`))) name = segmentName(this.options.instanceId, epochMinute(at), (n += 1));
      this.guard("write_dropped_row", () => this.fs.writeFile(join(this.options.dir, name), Buffer.from(`${JSON.stringify(row)}\n`, "utf8"), 0o600));
      this.droppedSegments += evicted;
      this.log({ event: "spool_evicted", segments: evicted, bytes: evictedBytes });
    }
    return evicted;
  }

  /** The segment's bytes, or null when it is gone (counted as a fault, never thrown). */
  private readSegment(path: string): Buffer | null {
    let bytes: Buffer | null = null;
    this.guard("read_segment", () => {
      bytes = Buffer.from(this.fs.readFile(path));
    });
    return bytes;
  }

  /**
   * S6: `quarantine/` entries older than their retention are deleted; `quarantine/` and `exported/` are held under their
   * byte caps, oldest first; an `.open` segment untouched past the reclaim age has no writer behind it and is closed so it
   * uploads (a partial last line is skipped at inspection) and counts against the budget like any other.
   */
  sweep(): void {
    const at = this.now();
    const quarantine = join(this.options.dir, "quarantine");
    for (const name of this.fs.list(quarantine)) {
      const path = join(quarantine, name);
      this.guard("sweep", () => {
        if (at - this.fs.stat(path).mtimeMs > (this.options.quarantineRetentionMs ?? QUARANTINE_RETENTION_MS)) this.fs.unlink(path);
      });
    }
    for (const [sub, cap] of [
      ["quarantine", this.options.quarantineCapBytes ?? QUARANTINE_CAP_BYTES],
      ["exported", this.options.exportedCapBytes ?? EXPORTED_CAP_BYTES],
    ] as const) {
      const listed = this.dirBytes(sub);
      let total = listed.bytes;
      for (const name of listed.names) {
        if (total <= cap) break;
        const path = join(this.options.dir, sub, name);
        let size = 0;
        this.guard("stat_file", () => void (size = this.fs.stat(path).size));
        if (this.guard("cap_evict", () => this.fs.unlink(path))) {
          this.capEvictedFiles += 1;
          this.log({ event: "cap_evicted", dir: sub, file: name, bytes: size });
        }
        total -= size;
      }
    }
    let names: string[] = [];
    this.guard("list_spool", () => void (names = this.fs.list(this.options.dir)));
    for (const name of names) {
      if (!OPEN_SEGMENT_NAME.test(name)) continue;
      const path = join(this.options.dir, name);
      this.guard("reclaim_open", () => {
        if (at - this.fs.stat(path).mtimeMs <= (this.options.openReclaimMs ?? OPEN_SEGMENT_RECLAIM_MS)) return;
        this.fs.rename(path, path.slice(0, -".open".length));
        this.reclaimedSegments += 1;
        this.log({ event: "open_segment_reclaimed", segment: name.slice(0, -".open".length) });
      });
    }
  }

  private quarantine(name: string, reason: string, detail?: unknown): void {
    this.guard("quarantine", () => this.fs.rename(join(this.options.dir, name), join(this.options.dir, "quarantine", name)));
    this.quarantinedSegments += 1;
    this.log({ event: "segment_quarantined", segment: name, reason, ...(detail !== undefined ? { detail } : {}) });
  }

  private async grantFor(instanceId: string): Promise<GrantDecision> {
    const held = this.grants.get(instanceId);
    if (held && Date.parse(held.expiresAt) - GRANT_REFRESH_MARGIN_MS > this.now()) return { kind: "grant", grant: held };
    this.grants.delete(instanceId);
    const decision = await this.options.grantFor(instanceId);
    if (decision.kind === "grant") {
      this.grants.set(instanceId, decision.grant);
      if (decision.uploadIntervalSeconds && decision.uploadIntervalSeconds >= 1) this.intervalSeconds = decision.uploadIntervalSeconds;
    }
    return decision;
  }

  /** One pass: sweep, budget, then each closed segment oldest first — validate, grant, POST, move — until the spool is empty, a hold, or a failure. Never throws. */
  runOnce(): Promise<PassResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.pass().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async pass(): Promise<PassResult> {
    const result: PassResult = { uploaded: [], quarantined: [], dropped: 0, held: false };
    try {
      this.sweep();
      result.dropped = this.enforceBudget();
      if (this.backoffUntilMs !== null && this.now() < this.backoffUntilMs) {
        result.held = true;
        return result;
      }
      for (const name of this.closedSegments()) {
        const path = join(this.options.dir, name);
        const instanceId = SEGMENT_NAME.exec(name)![1]!;
        const read = this.readSegment(path);
        // Taken away between the listing and the read (a sibling's eviction): nothing to upload, nothing lost here.
        if (read === null) continue;
        const bytes = read;
        if (bytes.length > SEGMENT_MAX_BYTES) {
          this.quarantine(name, "oversize", bytes.length);
          result.quarantined.push(name);
          continue;
        }
        const inspection = inspectSegment(bytes, instanceId);
        if (inspection.invalid.length > 0) {
          this.quarantine(name, "invalid_rows", inspection.invalid.slice(0, 5));
          result.quarantined.push(name);
          continue;
        }
        if (inspection.rows.length === 0) {
          // Nothing to say (an empty or partial-only segment): acknowledged locally, never uploaded.
          this.guard("ack_segment", () => this.fs.unlink(path));
          continue;
        }
        const decision = await this.grantFor(instanceId);
        if (decision.kind === "hold") {
          this.backoffUntilMs = this.now() + decision.retryAfterSeconds * 1000;
          this.lastError = `hold:${decision.reason ?? "retry_after"}`;
          this.log({ event: "upload_held", retryAfterSeconds: decision.retryAfterSeconds, reason: decision.reason ?? null });
          result.held = true;
          return result;
        }
        if (decision.kind === "unavailable") {
          this.fail(`grant:${decision.reason}`);
          result.held = true;
          return result;
        }
        // The partial tail (a crashed writer's last line) is not sent: the bytes posted are exactly the whole lines.
        const payload = inspection.partialTail ? Buffer.from(bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1)) : bytes;
        let outcome = await postSegment({ grant: decision.grant, segment: name, bytes: payload, fetch: this.options.fetch, now: () => this.now() });
        if (outcome.status === "refused" && outcome.expired) {
          // The grant lapsed between the check and the bucket's clock: one fresh grant, one more try.
          this.grants.delete(instanceId);
          const fresh = await this.grantFor(instanceId);
          if (fresh.kind === "grant") outcome = await postSegment({ grant: fresh.grant, segment: name, bytes: payload, fetch: this.options.fetch, now: () => this.now() });
        }
        if (outcome.status === "ok") {
          // S6: delete on ack. The object key is the file name, so a lost response replays to the same key; nothing is kept here.
          this.guard("ack_segment", () => this.fs.unlink(path));
          this.guard("stamp_upload", () => this.fs.writeFile(join(this.options.dir, LAST_UPLOAD_MARKER), Buffer.from(`${new Date(this.now()).toISOString()}\n`, "utf8"), 0o600));
          this.sentSegments += 1;
          this.lastUploadMs = this.now();
          this.lastError = null;
          this.attempt = 0;
          this.backoffUntilMs = null;
          result.uploaded.push(name);
          continue;
        }
        if (outcome.status === "too_large") {
          this.quarantine(name, "oversize", outcome.bytes);
          result.quarantined.push(name);
          continue;
        }
        this.fail(outcome.status === "refused" ? `http_${outcome.httpStatus}` : `network:${outcome.reason}`);
        result.held = true;
        return result;
      }
      return result;
    } catch (error) {
      this.fail(`pass:${(error as Error).message}`);
      result.held = true;
      return result;
    }
  }

  private fail(reason: string): void {
    const delay = backoffDelayMs(this.attempt, this.options.random);
    this.attempt += 1;
    this.backoffUntilMs = this.now() + delay;
    this.lastError = reason;
    this.log({ event: "upload_failed", reason, attempt: this.attempt, backoffMs: delay });
  }

  /** Passes every `intervalSeconds` (the grant's `uploadIntervalSeconds` once one has answered), with a random phase offset so a fleet does not upload together. */
  start(): void {
    this.stopped = false;
    this.schedule((this.options.random ?? Math.random)() * this.intervalSeconds * 1000);
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped) return;
    this.nextPassMs = this.now() + delayMs;
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => {
        const wait = this.backoffUntilMs !== null && this.backoffUntilMs > this.now() ? this.backoffUntilMs - this.now() : this.intervalSeconds * 1000;
        this.schedule(Math.max(250, wait));
      });
    }, delayMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextPassMs = null;
    if (this.inFlight) await this.inFlight;
  }

  status(): UploaderStatus {
    return {
      lastUploadAt: this.lastUploadMs === null ? null : new Date(this.lastUploadMs).toISOString(),
      lastError: this.lastError,
      backoffUntil: this.backoffUntilMs === null || this.backoffUntilMs <= this.now() ? null : new Date(this.backoffUntilMs).toISOString(),
      attempt: this.attempt,
      inFlight: this.inFlight !== null,
      intervalSeconds: this.intervalSeconds,
      nextPassAt: this.nextPassMs === null || !this.timer ? null : new Date(this.nextPassMs).toISOString(),
      sentSegments: this.sentSegments,
      quarantinedSegments: this.quarantinedSegments,
      droppedSegments: this.droppedSegments,
      grants: [...this.grants].map(([instanceId, grant]) => ({ instanceId, expiresAt: grant.expiresAt })),
      depth: this.depth(),
      tree: this.tree(),
      reclaimedSegments: this.reclaimedSegments,
      capEvictedFiles: this.capEvictedFiles,
    };
  }
}
