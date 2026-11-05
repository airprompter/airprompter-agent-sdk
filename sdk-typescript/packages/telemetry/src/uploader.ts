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
 * `grantFor(instanceId, report)` is a heartbeat carrying that writer's
 * instance id and — from the segment's manifest (`protocol/daemon.md`) —
 * that writer's own report. The serverless path uses the same `postSegment` with the
 * runtime's own grant at invocation end.
 *
 * @example
 * ```ts
 * const uploader = new SpoolUploader({
 *   dir: join(storeDir, "spool", "telemetry"),
 *   instanceId, // the daemon's own: the budget sweep's `dropped` rows name it
 *   grantFor: async (writerId) => heartbeatFor(writerId), // { kind: "grant", grant } | { kind: "hold", retryAfterSeconds } | { kind: "unavailable", reason }
 *   fetch,
 *   logger: (event) => console.log(event),
 * });
 * uploader.start(); // one pass in flight per host, oldest segment first, backoff with full jitter
 * await uploader.stop();
 * ```
 */

import { validAudienceMinute } from "@airprompter/agent-core";
import { nodeFs, SLOT_TAG, STEP_STATUSES, validStepName, WINDOW_STATUSES } from "@airprompter/agent-core";
import { fsFailureCode, type FsPort } from "@airprompter/agent-core";
import { join } from "node:path";

import { MANIFEST_GRACE_MS, MANIFEST_NAME, manifestNameOf, readSegmentManifest, segmentNameOfManifest, sha256Hex } from "./spool/manifest.js";
import { HOST_SPOOL_BUDGET_BYTES, LATENCY_BUCKET_EDGES_MS, SEGMENT_MAX_BYTES, epochMinute, segmentName, type SpoolRow } from "./spool/writer.js";
import type { FetchLike, UploadSink } from "@airprompter/agent-core";

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
const TAG = SLOT_TAG;
const ARM = SLOT_TAG;
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OUTCOME_NAME = /^[a-z][a-zA-Z0-9]{0,31}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/** A later 3.x may add an error class, a usage source or a refusal reason: a reader takes the shape, not the list. */
const SLUG = /^[a-z][a-z0-9_]{0,31}$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNonNegativeInt = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isInteger(value) && value >= min;
const isString = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const onlyKeys = (object: Record<string, unknown>, allowed: readonly string[]): string | null => Object.keys(object).find((key) => !allowed.includes(key)) ?? null;

const ROW_VERSIONS: Readonly<Record<string, number>> = { window: 4, step: 1, refusal: 1, dropped: 1 };
const TOKEN_MOMENTS = ["input", "cachedInput", "output", "inputOutput", "inputCached", "cachedOutput"] as const;
const WINDOW_FIELDS = ["type", "v", "artifactId", "audienceIds", "outcomeRunMinute", "minute", "instanceId", "instanceClass", "tag", "versionId", "arm", "model", "status", "errorClass", "usageSource", "count", "modelCalls", "agentRun", "tools", "latencyMs", "tokens", "tokensSq", "checks", "outcomes", "sdk"] as const;
const STEP_FIELDS = ["type", "v", "artifactId", "audienceIds", "minute", "instanceId", "instanceClass", "tag", "versionId", "arm", "model", "step", "status", "errorClass", "usageSource", "modelCalls", "latencyMs", "tokens", "tools", "sdk"] as const;
const WINDOW_ONLY_FIELDS = ["tokensSq", "count", "outcomes", "checks"] as const;
const REFUSAL_FIELDS = ["type", "v", "at", "instanceId", "reason", "generation", "tag"] as const;
const DROPPED_FIELDS = ["type", "v", "at", "instanceId", "segments", "lines", "bytes"] as const;

/**
 * `row`: the line as it may leave this host, holding only the fields this reader knows; `stripped` names the rest.
 * `later`: a row this reader cannot read and a later 3.x may have written. It is skipped and counted, and only the line
 * goes. Anything else refused is corruption, and quarantines the segment.
 */
export type RowVerdict = { ok: true; row: SpoolRow; stripped: string[] } | { ok: false; reason: string; later?: true };

const isMoment = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const histogramFits = (latency: unknown): latency is { buckets: number[]; sum: number } => isObject(latency) && Array.isArray(latency.buckets) && latency.buckets.length === LATENCY_BUCKET_EDGES_MS.length && latency.buckets.every((b) => isNonNegativeInt(b)) && isNonNegativeInt(latency.sum);
const tokensFit = (tokens: unknown): tokens is { input: number; cachedInput?: number; output: number } => isObject(tokens) && isNonNegativeInt(tokens.input) && isNonNegativeInt(tokens.output) && (tokens.cachedInput === undefined || isNonNegativeInt(tokens.cachedInput));
const toolsFit = (tools: unknown): tools is { calls: number; errors: number } => isObject(tools) && isNonNegativeInt(tools.calls) && isNonNegativeInt(tools.errors);
const audienceIdsFit = (ids: unknown): boolean => ids === undefined || (Array.isArray(ids) && ids.length <= 8 && ids.every((id, i) => typeof id === "string" && /^aud_[A-Za-z0-9_-]{22}$/.test(id) && (i === 0 || ids[i - 1] < id)));
const histogramTotal = (latency: { buckets: number[] }): number => latency.buckets.reduce((sum, n) => sum + n, 0);

/** Only the named fields survive; what went is named in `stripped`, path first. No value is ever read. */
function pick(object: Record<string, unknown>, fields: readonly string[], path: string, stripped: string[]): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    if (fields.includes(key)) kept[key] = value;
    else stripped.push(`${path}${key}`);
  }
  return kept;
}

/** The nested objects of a window or step row, down to what this reader knows. */
function pickNested(row: Record<string, unknown>, stripped: string[]): Record<string, unknown> {
  const nested: Record<string, unknown> = { ...row };
  const within = (field: string, fields: readonly string[]) => {
    if (isObject(row[field])) nested[field] = pick(row[field], fields, `${field}.`, stripped);
  };
  within("latencyMs", ["buckets", "sum"]);
  within("tokens", ["input", "cachedInput", "output"]);
  within("tools", ["calls", "errors"]);
  within("tokensSq", TOKEN_MOMENTS);
  within("checks", ["passed", "failed"]);
  if (isObject(row.outcomes)) nested.outcomes = Object.fromEntries(Object.entries(row.outcomes).map(([name, entry]) => [name, isObject(entry) ? pick(entry, ["n", "sum", "sumSq"], `outcomes.${name}.`, stripped) : entry]));
  return nested;
}

/** The fields a run dimension shares between window and step rows, in the order a reason names them. */
function dimensionReason(value: Record<string, unknown>): string | null {
  if (!isString(value.artifactId, 128) || !ARTIFACT_ID.test(value.artifactId)) return "artifactId";
  if (!audienceIdsFit(value.audienceIds)) return "audienceIds";
  if (!validAudienceMinute(value.minute)) return "minute";
  if (value.instanceClass !== "resident" && value.instanceClass !== "ephemeral") return "instanceClass";
  if (!isString(value.tag, 128) || !TAG.test(value.tag)) return "tag";
  if (!isString(value.versionId, 128)) return "versionId";
  if (!isString(value.arm, 32) || !ARM.test(value.arm)) return "arm";
  if (!isString(value.model, 128)) return "model";
  if (value.errorClass !== undefined && value.errorClass !== null && !(typeof value.errorClass === "string" && SLUG.test(value.errorClass))) return "errorClass";
  if (typeof value.usageSource !== "string" || !SLUG.test(value.usageSource)) return "usageSource";
  if (!isNonNegativeInt(value.modelCalls)) return "modelCalls";
  if (!toolsFit(value.tools)) return "tools";
  if (!histogramFits(value.latencyMs)) return "latencyMs";
  if (!tokensFit(value.tokens)) return "tokens";
  if (value.sdk !== undefined && !isString(value.sdk, 64)) return "sdk";
  return null;
}

/** One parsed line against the contract. The reason names the first field that does not fit, never the value. */
export function validateSpoolRow(value: unknown): RowVerdict {
  if (!isObject(value)) return { ok: false, reason: "not_an_object" };
  if (typeof value.type !== "string" || !Object.prototype.hasOwnProperty.call(ROW_VERSIONS, value.type)) return { ok: false, reason: "unknown_type", later: true };
  if (value.v !== ROW_VERSIONS[value.type]) return { ok: false, reason: "v", later: true };
  if (!isString(value.instanceId, 64) || !INSTANCE_ID.test(value.instanceId)) return { ok: false, reason: "instanceId" };
  const stripped: string[] = [];
  switch (value.type) {
    case "window": {
      // A member of the other row form is a crossed row, not a later one: the two forms never mix.
      if ("step" in value) return { ok: false, reason: "unknown_field:step" };
      const dimension = dimensionReason(value);
      if (dimension) return { ok: false, reason: dimension };
      if (!WINDOW_STATUSES.includes(value.status as string)) return { ok: false, reason: "status", later: true };
      if (!isNonNegativeInt(value.count)) return { ok: false, reason: "count" };
      if (!isNonNegativeInt(value.agentRun) || value.agentRun > value.count) return { ok: false, reason: "agentRun" };
      if (value.outcomeRunMinute !== undefined && (!validAudienceMinute(value.outcomeRunMinute) || Date.parse(value.outcomeRunMinute) > Date.parse(value.minute as string))) return { ok: false, reason: "outcomeRunMinute" };
      if (value.count === 0 && (value.outcomeRunMinute === undefined || !isObject(value.outcomes) || Object.keys(value.outcomes).length === 0)) return { ok: false, reason: "outcomeRunMinute" };
      if (value.count > 0 && value.outcomeRunMinute !== undefined && Date.parse(String(value.outcomeRunMinute)) !== Date.parse(value.minute as string)) return { ok: false, reason: "outcomeRunMinute" };
      const latency = value.latencyMs as { buckets: number[]; sum: number };
      const tokens = value.tokens as { input: number; cachedInput?: number; output: number };
      const tools = value.tools as { calls: number; errors: number };
      if (value.count === 0 && (value.modelCalls !== 0 || tools.calls !== 0 || tools.errors !== 0 || latency.sum !== 0 || tokens.input !== 0 || tokens.output !== 0 || (tokens.cachedInput ?? 0) !== 0 || value.tokensSq !== undefined || (isObject(value.checks) && ((value.checks.passed ?? 0) !== 0 || (value.checks.failed ?? 0) !== 0)))) return { ok: false, reason: "feedback_measurements" };
      if (value.count > 0) {
        const moments = value.tokensSq;
        if (!isObject(moments) || !TOKEN_MOMENTS.every((name) => isMoment(moments[name]))) return { ok: false, reason: "tokensSq" };
      }
      if (value.checks !== undefined) {
        const checks = value.checks;
        if (!isObject(checks) || (checks.passed !== undefined && !isNonNegativeInt(checks.passed)) || (checks.failed !== undefined && !isNonNegativeInt(checks.failed))) return { ok: false, reason: "checks" };
      }
      if (value.outcomes !== undefined) {
        const outcomes = value.outcomes;
        if (!isObject(outcomes)) return { ok: false, reason: "outcomes" };
        for (const [name, entry] of Object.entries(outcomes)) {
          if (!OUTCOME_NAME.test(name) || !isObject(entry) || !isNonNegativeInt(entry.n) || typeof entry.sum !== "number" || !Number.isFinite(entry.sum) || !isMoment(entry.sumSq)) return { ok: false, reason: `outcomes:${name}` };
        }
        const thumbs = outcomes.thumbs;
        if (thumbs && (!isObject(thumbs) || !Number.isSafeInteger(thumbs.sum) || Number(thumbs.sum) < 0 || Number(thumbs.sum) > Number(thumbs.n))) return { ok: false, reason: "thumbs" };
      }
      if (histogramTotal(latency) !== value.count) return { ok: false, reason: "histogram" };
      return { ok: true, row: pickNested(pick(value, WINDOW_FIELDS, "", stripped), stripped) as unknown as SpoolRow, stripped };
    }
    case "step": {
      const crossed = WINDOW_ONLY_FIELDS.find((name) => name in value);
      if (crossed) return { ok: false, reason: `unknown_field:${crossed}` };
      const dimension = dimensionReason(value);
      if (dimension) return { ok: false, reason: dimension };
      if (!validStepName(value.step)) return { ok: false, reason: "step" };
      if (!STEP_STATUSES.includes(value.status as string)) return { ok: false, reason: "status", later: true };
      if (histogramTotal(value.latencyMs as { buckets: number[] }) !== value.modelCalls) return { ok: false, reason: "histogram" };
      return { ok: true, row: pickNested(pick(value, STEP_FIELDS, "", stripped), stripped) as unknown as SpoolRow, stripped };
    }
    case "refusal": {
      if (!isString(value.at, 64) || !DATE_TIME.test(value.at)) return { ok: false, reason: "at" };
      if (typeof value.reason !== "string" || !SLUG.test(value.reason)) return { ok: false, reason: "reason" };
      if (!isNonNegativeInt(value.generation)) return { ok: false, reason: "generation" };
      if (!("tag" in value) || !(value.tag === null || (isString(value.tag, 128) && TAG.test(value.tag)))) return { ok: false, reason: "tag" };
      return { ok: true, row: pick(value, REFUSAL_FIELDS, "", stripped) as unknown as SpoolRow, stripped };
    }
    default: {
      if (!isString(value.at, 64) || !DATE_TIME.test(value.at)) return { ok: false, reason: "at" };
      if (value.lines !== undefined && !isNonNegativeInt(value.lines, 1)) return { ok: false, reason: "lines" };
      if (!isNonNegativeInt(value.segments, value.lines === undefined ? 1 : 0)) return { ok: false, reason: "segments" };
      if (!isNonNegativeInt(value.bytes)) return { ok: false, reason: "bytes" };
      return { ok: true, row: pick(value, DROPPED_FIELDS, "", stripped) as unknown as SpoolRow, stripped };
    }
  }
}

export interface SegmentInspection {
  /** What may leave this host: known rows, known fields, and one `dropped` row when lines were skipped. */
  rows: SpoolRow[];
  /** Corruption, by line (1-based) and reason; empty means the segment may ship. */
  invalid: Array<{ line: number; reason: string }>;
  /** Lines a later 3.x may have written: skipped one by one, counted in the `dropped` row. */
  skipped: Array<{ line: number; reason: string }>;
  /** Fields this reader does not know, by line. They never leave the host. */
  stripped: Array<{ line: number; field: string }>;
  /** A last line without its `\n` (a crashed writer): skipped, never counted as invalid. */
  partialTail: boolean;
  /** The whole lines to send: the file's own bytes when nothing was changed, else `rows` serialised again. */
  payload: Buffer;
}

/** Every line of a segment against the contract; `instanceId` (from the file name) is authoritative for every row. */
export function inspectSegment(bytes: Uint8Array, instanceId: string, nowMs: number = Date.now()): SegmentInspection {
  const source = Buffer.from(bytes);
  const text = source.toString("utf8");
  const partialTail = text.length > 0 && !text.endsWith("\n");
  const lines = text.split("\n");
  lines.pop(); // the partial tail, or the empty string after the final newline
  const rows: SpoolRow[] = [];
  const invalid: SegmentInspection["invalid"] = [];
  const skipped: SegmentInspection["skipped"] = [];
  const stripped: SegmentInspection["stripped"] = [];
  let skippedBytes = 0;
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
    if (verdict.ok) {
      if (verdict.row.instanceId !== instanceId) invalid.push({ line: index + 1, reason: "instance_mismatch" });
      else {
        rows.push(verdict.row);
        for (const field of verdict.stripped) stripped.push({ line: index + 1, field });
      }
    } else if (verdict.later) {
      skipped.push({ line: index + 1, reason: verdict.reason });
      skippedBytes += Buffer.byteLength(line, "utf8") + 1;
    } else invalid.push({ line: index + 1, reason: verdict.reason });
  });
  if (skipped.length > 0) rows.push({ type: "dropped", v: 1, at: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z"), instanceId, segments: 0, lines: skipped.length, bytes: skippedBytes });
  const whole = partialTail ? source.subarray(0, source.lastIndexOf(0x0a) + 1) : source;
  const payload = skipped.length === 0 && stripped.length === 0 ? Buffer.from(whole) : Buffer.from(rows.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8");
  return { rows, invalid, skipped, stripped, partialTail, payload };
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
  /**
   * A grant for one writer's prefix — the heartbeat carrying that writer's instance id (AirPrompter's sink). `report` is
   * the writer's heartbeat report from its newest manifest (without `spool`), absent for a segment with no manifest.
   */
  grantFor?: (instanceId: string, report?: Record<string, unknown>) => Promise<GrantDecision>;
  fetch?: FetchLike;
  /**
   * S13: where validated segments go. Absent: AirPrompter's sink over `grantFor` + `fetch`. The OpenTelemetry bridge
   * (`@airprompter/otel-bridge`) or a customer's own sink takes the same segments with no AirPrompter grant at all.
   */
  sink?: UploadSink;
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
  /**
   * `protocol/daemon.md`: the agent and target this uploader ships for. A segment whose manifest names another pair is
   * left alone for that pair's uploader — never uploaded, never deleted. Absent: every manifest is this uploader's.
   */
  scope?: { agentId: string; target: string };
  /**
   * How long a closed segment with no manifest waits for its writer to add one before it is uploaded without (60 s when
   * `scope` is set, 0 otherwise). An orphan manifest is deleted after the same wait.
   */
  manifestGraceMs?: number;
  /** Called after every pass with what it did (the telemetry daemon refreshes its discovery file here). Never awaited; a throw is ignored. */
  onPass?: (result: PassResult) => void;
}

export interface UploaderStatus {
  /** S13: which sink the segments go to. */
  sink: string;
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
  /** Segments whose manifest names another agent or target, left for that pair's uploader. */
  foreignSegments: number;
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

/**
 * AirPrompter's sink: one grant per writer prefix (the daemon's heartbeat carrying that writer's instance id), a PUT of
 * exactly the whole lines to the customer's own prefix; a grant that lapsed between the check and the bucket's clock is
 * refreshed once. `onGrant` lets the uploader take the grant's cadence.
 */
export function airprompterUploadSink(input: { grantFor: (instanceId: string, report?: Record<string, unknown>) => Promise<GrantDecision>; fetch: FetchLike; now?: () => number; onGrant?: (decision: Extract<GrantDecision, { kind: "grant" }>) => void }): UploadSink & { readonly grants: Map<string, UploadGrant> } {
  const now = input.now ?? (() => Date.now());
  const grants = new Map<string, UploadGrant>();
  const grantFor = async (instanceId: string, report?: Record<string, unknown>): Promise<GrantDecision> => {
    const held = grants.get(instanceId);
    if (held && Date.parse(held.expiresAt) - GRANT_REFRESH_MARGIN_MS > now()) return { kind: "grant", grant: held };
    grants.delete(instanceId);
    const decision = await input.grantFor(instanceId, report);
    if (decision.kind === "grant") {
      grants.set(instanceId, decision.grant);
      input.onGrant?.(decision);
    }
    return decision;
  };
  return {
    kind: "airprompter",
    grants,
    status: () => ({ grants: [...grants].map(([instanceId, grant]) => ({ instanceId, expiresAt: grant.expiresAt })) }),
    async ship(segment) {
      const decision = await grantFor(segment.instanceId, segment.report);
      if (decision.kind === "hold") return { status: "hold", retryAfterMs: decision.retryAfterSeconds * 1000, ...(decision.reason !== undefined ? { reason: decision.reason } : {}) };
      if (decision.kind === "unavailable") return { status: "failed", reason: `grant:${decision.reason}` };
      let outcome = await postSegment({ grant: decision.grant, segment: segment.segment, bytes: segment.bytes, fetch: input.fetch, now });
      if (outcome.status === "refused" && outcome.expired) {
        // The grant lapsed between the check and the bucket's clock: one fresh grant, one more try.
        grants.delete(segment.instanceId);
        const fresh = await grantFor(segment.instanceId, segment.report);
        if (fresh.kind === "grant") outcome = await postSegment({ grant: fresh.grant, segment: segment.segment, bytes: segment.bytes, fetch: input.fetch, now });
      }
      if (outcome.status === "ok") return { status: "ok" };
      if (outcome.status === "too_large") return { status: "too_large", bytes: outcome.bytes };
      return { status: "failed", reason: outcome.status === "refused" ? `http_${outcome.httpStatus}` : `network:${outcome.reason}` };
    },
  };
}

export class SpoolUploader {
  private readonly sink: UploadSink;
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
  private foreignSegments = 0;
  /** When this uploader first saw a manifest-less segment or an orphan manifest, on its own clock: the grace runs from there. */
  private readonly firstSeen = new Map<string, number>();
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
    if (options.sink) this.sink = options.sink;
    else {
      if (!options.grantFor || !options.fetch) throw new Error("SpoolUploader: a sink, or grantFor + fetch for AirPrompter's, is required");
      this.sink = airprompterUploadSink({
        grantFor: options.grantFor,
        fetch: options.fetch,
        now: () => this.now(),
        onGrant: (decision) => {
          if (decision.uploadIntervalSeconds && decision.uploadIntervalSeconds >= 1) this.intervalSeconds = decision.uploadIntervalSeconds;
        },
      });
    }
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

  /** Every SDK process on the host and the uploader itself write here; over the host budget the OLDEST unsent segments go and the loss is one `dropped` row under the daemon's own id. */
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
      this.removeManifest(segment.name);
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
      // Written whole by this uploader: no writer will add a manifest, so it waits for no grace.
      this.firstSeen.set(name, -Infinity);
      this.droppedSegments += evicted;
      this.log({ event: "spool_evicted", segments: evicted, bytes: evictedBytes });
    }
    return evicted;
  }

  private get graceMs(): number {
    return this.options.manifestGraceMs ?? (this.options.scope ? MANIFEST_GRACE_MS : 0);
  }

  /** Whether `name` has waited out the grace since this uploader first saw it (always, with no grace). */
  private waited(name: string): boolean {
    if (this.graceMs <= 0) return true;
    const now = this.now();
    const seen = this.firstSeen.get(name);
    if (seen === undefined) {
      this.firstSeen.set(name, now);
      return false;
    }
    return now - seen >= this.graceMs;
  }

  /** A segment's manifest goes with it: after the ack, the eviction, the sink's drop. Gone already is fine. */
  private removeManifest(segment: string): void {
    const path = join(this.options.dir, manifestNameOf(segment));
    try {
      if (this.fs.exists(path)) this.fs.unlink(path);
    } catch {
      // A sibling took it; the sweep deletes an orphan anyway.
    }
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
    // A manifest whose segment is gone (acknowledged by a sibling, evicted), or a writer's temp file left by a crash, once it is past the grace.
    const present = new Set(names);
    for (const seen of [...this.firstSeen.keys()]) if (!present.has(seen.startsWith("orphan:") ? seen.slice("orphan:".length) : seen)) this.firstSeen.delete(seen);
    for (const name of names) {
      const orphan = MANIFEST_NAME.test(name) ? !present.has(segmentNameOfManifest(name)) && !present.has(`${segmentNameOfManifest(name)}.open`) : /^seg-.+\.manifest\.json\.[0-9a-f]+\.tmp$/.test(name);
      if (!orphan) continue;
      const key = `orphan:${name}`;
      const now = this.now();
      const seen = this.firstSeen.get(key);
      if (seen === undefined) this.firstSeen.set(key, now);
      else if (now - seen >= Math.max(this.graceMs, MANIFEST_GRACE_MS)) {
        this.guard("sweep_manifest", () => this.fs.unlink(join(this.options.dir, name)));
        this.firstSeen.delete(key);
      }
    }
  }

  private quarantine(name: string, reason: string, detail?: unknown): void {
    this.guard("quarantine", () => this.fs.rename(join(this.options.dir, name), join(this.options.dir, "quarantine", name)));
    // The pair moves together, so an operator reads the segment beside what its writer said about it.
    const manifest = manifestNameOf(name);
    if (this.fs.exists(join(this.options.dir, manifest))) this.guard("quarantine_manifest", () => this.fs.rename(join(this.options.dir, manifest), join(this.options.dir, "quarantine", manifest)));
    this.quarantinedSegments += 1;
    this.log({ event: "segment_quarantined", segment: name, reason, ...(detail !== undefined ? { detail } : {}) });
  }

  /** One pass: sweep, budget, then each closed segment oldest first — validate, grant, POST, move — until the spool is empty, a hold, or a failure. Never throws. */
  runOnce(): Promise<PassResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.pass().finally(() => {
      this.inFlight = null;
    });
    void this.inFlight.then((result) => {
      try {
        this.options.onPass?.(result);
      } catch {
        // The hook is the caller's; a pass is never undone by it.
      }
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
        // protocol/daemon.md: the manifest says whose segment this is and what it must be.
        let report: Record<string, unknown> | undefined;
        let manifest: ReturnType<typeof readSegmentManifest> = null;
        this.guard("read_manifest", () => void (manifest = readSegmentManifest(this.fs, this.options.dir, name)));
        const found = manifest as ReturnType<typeof readSegmentManifest>;
        if (found === null) {
          // Its writer may be about to add one: wait out the grace before shipping it under this uploader's own scope.
          if (!this.waited(name)) continue;
        } else if (!found.ok) {
          this.quarantine(name, found.reason);
          result.quarantined.push(name);
          continue;
        } else {
          const scope = this.options.scope;
          if (scope && (found.manifest.agentId !== scope.agentId || found.manifest.target !== scope.target)) {
            // Another agent's or target's: its own uploader ships it.
            this.foreignSegments += 1;
            continue;
          }
          if (found.manifest.bytes !== bytes.length || found.manifest.sha256 !== sha256Hex(bytes)) {
            this.quarantine(name, "manifest_mismatch");
            result.quarantined.push(name);
            continue;
          }
          report = found.manifest.report;
        }
        if (bytes.length > SEGMENT_MAX_BYTES) {
          this.quarantine(name, "oversize", bytes.length);
          result.quarantined.push(name);
          continue;
        }
        const inspection = inspectSegment(bytes, instanceId, this.now());
        if (inspection.skipped.length > 0 || inspection.stripped.length > 0) this.log({ event: "segment_cleaned", segment: name, skippedRows: inspection.skipped.length, strippedFields: inspection.stripped.length });
        if (inspection.invalid.length > 0) {
          this.quarantine(name, "invalid_rows", inspection.invalid.slice(0, 5));
          result.quarantined.push(name);
          continue;
        }
        if (inspection.rows.length === 0) {
          // Nothing to say (an empty or partial-only segment): acknowledged locally, never uploaded.
          if (this.guard("ack_segment", () => this.fs.unlink(path))) this.removeManifest(name);
          continue;
        }
        // The partial tail (a crashed writer's last line) is not sent: the bytes shipped are exactly the whole lines, cleaned.
        const outcome = await this.sink.ship({ instanceId, segment: name, rows: inspection.rows, bytes: inspection.payload, ...(report ? { report } : {}) });
        if (outcome.status === "hold") {
          this.backoffUntilMs = this.now() + outcome.retryAfterMs;
          this.lastError = `hold:${outcome.reason ?? "retry_after"}`;
          this.log({ event: "upload_held", retryAfterSeconds: Math.round(outcome.retryAfterMs / 1000), reason: outcome.reason ?? null });
          result.held = true;
          return result;
        }
        if (outcome.status === "dropped") {
          // S13: the sink gave this segment up for good (the bridge's drop-and-count): deleted, counted, never silent.
          if (this.guard("drop_segment", () => this.fs.unlink(path))) this.removeManifest(name);
          this.droppedSegments += 1;
          result.dropped += 1;
          this.log({ event: "segment_dropped_by_sink", segment: name, sink: this.sink.kind, reason: outcome.reason });
          continue;
        }
        if (outcome.status === "ok") {
          // S6: delete on ack. The object key is the file name, so a lost response replays to the same key; nothing is kept here.
          // The segment first, then its manifest: a crash between leaves an orphan manifest the sweep deletes, never a segment without one twice.
          if (this.guard("ack_segment", () => this.fs.unlink(path))) this.removeManifest(name);
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
        this.fail(outcome.reason);
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
      foreignSegments: this.foreignSegments,
      sink: this.sink.kind,
      grants: ((this.sink.status?.() as { grants?: Array<{ instanceId: string; expiresAt: string }> } | undefined)?.grants ?? []),
      depth: this.depth(),
      tree: this.tree(),
      reclaimedSegments: this.reclaimedSegments,
      capEvictedFiles: this.capEvictedFiles,
    };
  }
}
