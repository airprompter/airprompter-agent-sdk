// Reference spool writer semantics (protocol/spool-format.md) and the feedback
// catalogue normalisation (schemas/feedback-signals.schema.json). Pure: the
// filesystem rules (0600, fsync + rename, .open recovery) are the SDKs' to
// test; what is checkable across implementations is here.
//
//   latencyBucketIndex(1234);                          // the index into LATENCY_BUCKET_EDGES_MS
//   segmentName("i-abc123", epochMs, 0);               // "seg-i-abc123-<epochMinute>-0.ndjson"
//   new SegmentPlanner("i-abc123").append(epochMs, lineBytes);   // { segment, rotated }: a new segment at the minute boundary or SEGMENT_MAX_BYTES
//   normalizeFeedback(signals);                        // { accepted, outcomes, rejected } per the catalogue

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const LATENCY_BUCKET_EDGES_MS = JSON.parse(readFileSync(join(existsSync(join(here, "..", "protocol", "schemas")) ? join(here, "..", "protocol") : join(here, "protocol"), "schemas", "latency-buckets.json"), "utf8")).edges;
export const SEGMENT_MAX_BYTES = 1024 * 1024;
const OUTCOME_NAME = /^[a-z][a-zA-Z0-9]{0,31}$/;
const OUTCOME_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z$/;

const validOutcomeRunMinute = (value) => {
  if (typeof value !== "string" || !OUTCOME_MINUTE.test(value) || value.startsWith("0000-") || !Number.isFinite(Date.parse(value))) return false;
  const date = value.slice(0, 10);
  const midnight = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(midnight) && new Date(midnight).toISOString().slice(0, 10) === date && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60;
};
const validAudienceIds = (value) => Array.isArray(value) && value.length <= 8 && value.every((id, i) => typeof id === "string" && /^aud_[A-Za-z0-9_-]{22}$/.test(id) && (i === 0 || value[i - 1] < id));
const hasValidOutcome = (outcomes) => Object.entries(outcomes).some(([name, value]) => OUTCOME_NAME.test(name) && (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value * value))));
/** A count a row may carry: a non-negative integer, whatever a caller handed in. */
const countOf = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value))) : 0);
const roundedMs = (value) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);

export function latencyBucketIndex(latencyMs) {
  const index = LATENCY_BUCKET_EDGES_MS.findIndex((edge) => latencyMs <= edge);
  return index === -1 ? LATENCY_BUCKET_EDGES_MS.length - 1 : index;
}

export function minuteOf(epochMs) {
  return new Date(Math.floor(epochMs / 60000) * 60000).toISOString().replace(".000Z", "Z");
}

export function epochMinute(epochMs) {
  return Math.floor(epochMs / 60000);
}

export function segmentName(instanceId, minute, n) {
  return `seg-${instanceId}-${minute}-${n}.ndjson`;
}

/** Decides the segment an appended line lands in: rotate on a new minute, or when the line would push past 1 MiB. */
export class SegmentPlanner {
  constructor(instanceId) {
    this.instanceId = instanceId;
    this.openMinute = null;
    this.openBytes = 0;
    this.n = 0;
  }
  append(epochMs, lineBytes) {
    const minute = epochMinute(epochMs);
    const rotated = this.openMinute === null || minute !== this.openMinute || this.openBytes + lineBytes > SEGMENT_MAX_BYTES;
    if (rotated) {
      this.n = minute === this.openMinute ? this.n + 1 : 0;
      this.openMinute = minute;
      this.openBytes = 0;
    }
    this.openBytes += lineBytes;
    return { segment: segmentName(this.instanceId, this.openMinute, this.n), rotated };
  }
}

const isFinite = (value) => typeof value === "number" && Number.isFinite(value);

export function mergeOutcomes(row, outcomes) {
  for (const [name, value] of Object.entries(outcomes)) {
    if (!OUTCOME_NAME.test(name)) continue;
    const numeric = typeof value === "boolean" ? (value ? 1 : 0) : value;
    if (!isFinite(numeric)) continue;
    const current = row.outcomes?.[name] ?? { n: 0, sum: 0, sumSq: 0 };
    const merged = { n: current.n + 1, sum: current.sum + numeric, sumSq: current.sumSq + numeric * numeric };
    if (!isFinite(merged.sum) || !isFinite(merged.sumSq)) continue;
    (row.outcomes ??= {})[name] = merged;
  }
}

/** The two caps on a step name; a name past either is written as `other`. */
export const STEP_BOUNDS = { maxLength: 64, maxPerRun: 32 };
const validStep = (value) => typeof value === "string" && [...value].length >= 1 && [...value].length <= STEP_BOUNDS.maxLength && !/[\u0000-\u001f\u007f]/u.test(value) && !/[\uD800-\uDFFF]/u.test(value);

/** Minute windows per dimension set (tag, artifactId, versionId, arm, model, status, errorClass, audienceIds, outcomeRunMinute); step rows beside them, never in them. */
export class WindowAggregator {
  constructor({ instanceId, instanceClass, sdk }) {
    this.identity = { instanceId, instanceClass, sdk };
    this.open = new Map();
    this.openSteps = new Map();
    this.stepNames = new Map();
    this.openMinute = null;
    this.emitted = [];
    this.emittedSteps = [];
  }
  turnMinute(at) {
    const minute = minuteOf(at);
    if (this.openMinute !== null && this.openMinute !== minute) this.close(at);
    this.openMinute = minute;
    return minute;
  }
  checkDimensions(dimensions, at) {
    if (typeof dimensions.artifactId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(dimensions.artifactId)) throw new Error("telemetry_artifact_id_invalid");
    if (dimensions.audienceIds !== undefined && !validAudienceIds(dimensions.audienceIds)) throw new Error("telemetry_audience_ids_invalid");
    if (dimensions.outcomeRunMinute !== undefined && (!validOutcomeRunMinute(dimensions.outcomeRunMinute) || dimensions.outcomeRunMinute > minuteOf(at))) throw new Error("telemetry_outcome_run_minute_invalid");
  }
  window(at, dimensions) {
    this.checkDimensions(dimensions, at);
    const minute = this.turnMinute(at);
    const errorClass = dimensions.errorClass ?? null;
    const outcomeRunMinute = dimensions.outcomeRunMinute === minute ? null : dimensions.outcomeRunMinute ?? null;
    const key = JSON.stringify([dimensions.tag, dimensions.artifactId, dimensions.versionId, dimensions.arm, dimensions.model, dimensions.status, errorClass, dimensions.audienceIds ?? null, outcomeRunMinute]);
    let row = this.open.get(key);
    if (!row) {
      row = {
        type: "window",
        v: 4,
        artifactId: dimensions.artifactId,
        minute,
        instanceId: this.identity.instanceId,
        instanceClass: this.identity.instanceClass,
        tag: dimensions.tag,
        versionId: dimensions.versionId,
        arm: dimensions.arm,
        model: dimensions.model,
        status: dimensions.status,
        errorClass,
        usageSource: dimensions.usageSource ?? "reported",
        count: 0,
        modelCalls: 0,
        agentRun: 0,
        tools: { calls: 0, errors: 0 },
        latencyMs: { buckets: new Array(LATENCY_BUCKET_EDGES_MS.length).fill(0), sum: 0 },
        tokens: { input: 0, output: 0 },
        sdk: this.identity.sdk,
      };
      if (dimensions.audienceIds !== undefined) row.audienceIds = [...dimensions.audienceIds];
      if (dimensions.outcomeRunMinute !== undefined) row.outcomeRunMinute = dimensions.outcomeRunMinute;
      this.open.set(key, row);
    }
    return row;
  }
  /** One run's totals: the only place `count` rises. Moments are over the run's totals, never per model call. */
  recordRun(at, totals) {
    const dimensions = { ...totals.dimensions, status: totals.status, errorClass: totals.errorClass, usageSource: totals.usageSource };
    const row = this.window(at, dimensions);
    if (row.outcomeRunMinute === row.minute) delete row.outcomeRunMinute;
    row.count += 1;
    row.agentRun += totals.agentRun;
    row.modelCalls += countOf(totals.modelCalls);
    row.tools.calls += countOf(totals.tools.calls);
    row.tools.errors += countOf(totals.tools.errors);
    row.latencyMs.buckets[latencyBucketIndex(totals.latencyMs)] += 1;
    row.latencyMs.sum += roundedMs(totals.latencyMs);
    const [input, cachedInput, output] = [totals.tokens.input, totals.tokens.cachedInput, totals.tokens.output].map(countOf);
    row.tokens.input += input;
    row.tokens.output += output;
    if (cachedInput) row.tokens.cachedInput = (row.tokens.cachedInput ?? 0) + cachedInput;
    row.tokensSq ??= { input: 0, cachedInput: 0, output: 0, inputOutput: 0, inputCached: 0, cachedOutput: 0 };
    row.tokensSq.input += input * input;
    row.tokensSq.cachedInput += cachedInput * cachedInput;
    row.tokensSq.output += output * output;
    row.tokensSq.inputOutput += input * output;
    row.tokensSq.inputCached += input * cachedInput;
    row.tokensSq.cachedOutput += cachedInput * output;
    if (totals.checks) row.checks = { passed: (row.checks?.passed ?? 0) + totals.checks.passed, failed: (row.checks?.failed ?? 0) + totals.checks.failed };
    return row;
  }
  /** One step's totals: a step row of its own; no window changes. */
  recordStep(at, totals) {
    const d = totals.dimensions;
    this.checkDimensions(d, at);
    const minute = this.turnMinute(at);
    const dimensionKey = JSON.stringify([d.tag, d.artifactId, d.versionId, d.arm, d.model, d.audienceIds ?? null]);
    const names = this.stepNames.get(dimensionKey) ?? new Set();
    this.stepNames.set(dimensionKey, names);
    let step = validStep(totals.step) ? totals.step : "other";
    if (step !== "other" && !names.has(step)) {
      if (names.size >= STEP_BOUNDS.maxPerRun) step = "other";
      else names.add(step);
    }
    const errorClass = totals.errorClass ?? null;
    const key = JSON.stringify([dimensionKey, step, totals.status, errorClass]);
    let row = this.openSteps.get(key);
    if (!row) {
      row = { type: "step", v: 1, artifactId: d.artifactId, minute, instanceId: this.identity.instanceId, instanceClass: this.identity.instanceClass, tag: d.tag, versionId: d.versionId, arm: d.arm, model: d.model, step, status: totals.status, errorClass, usageSource: totals.usageSource, modelCalls: 0, latencyMs: { buckets: new Array(LATENCY_BUCKET_EDGES_MS.length).fill(0), sum: 0 }, tokens: { input: 0, output: 0 }, tools: { calls: 0, errors: 0 }, sdk: this.identity.sdk };
      if (d.audienceIds !== undefined) row.audienceIds = [...d.audienceIds];
      this.openSteps.set(key, row);
    }
    totals.latency.buckets.forEach((n, i) => {
      row.latencyMs.buckets[i] += countOf(n);
      row.modelCalls += countOf(n);
    });
    row.latencyMs.sum += roundedMs(totals.latency.sum);
    row.tokens.input += countOf(totals.tokens.input);
    row.tokens.output += countOf(totals.tokens.output);
    if (countOf(totals.tokens.cachedInput)) row.tokens.cachedInput = (row.tokens.cachedInput ?? 0) + countOf(totals.tokens.cachedInput);
    row.tools.calls += countOf(totals.tools.calls);
    row.tools.errors += countOf(totals.tools.errors);
  }
  /** A one-call run: one run row, and a step row only when the observation names a step. */
  observe(at, o) {
    const tokens = { input: o.tokens?.input ?? 0, cachedInput: o.tokens?.cachedInput ?? 0, output: o.tokens?.output ?? 0 };
    const tools = { calls: o.toolCalls?.calls ?? 0, errors: o.toolCalls?.errors ?? 0 };
    const { tag } = o;
    const step = o.step;
    const dimensions = { tag, artifactId: o.artifactId, versionId: o.versionId, arm: o.arm, model: o.model, ...(o.audienceIds !== undefined ? { audienceIds: o.audienceIds } : {}) };
    const usageSource = o.usageSource ?? "reported";
    const errorClass = o.errorClass ?? null;
    const row = this.recordRun(at, { dimensions, status: o.status, errorClass, usageSource, agentRun: 1, modelCalls: 1, latencyMs: o.latencyMs, tokens, tools, ...(o.checks ? { checks: { passed: o.checks.passed ?? 0, failed: o.checks.failed ?? 0 } } : {}) });
    if (o.outcomes) mergeOutcomes(row, o.outcomes);
    if (step !== undefined) {
      const buckets = new Array(LATENCY_BUCKET_EDGES_MS.length).fill(0);
      buckets[latencyBucketIndex(o.latencyMs)] = 1;
      this.recordStep(at, { dimensions, step, status: o.status === "ok" ? "ok" : "error", errorClass, usageSource, modelCalls: 1, latency: { buckets, sum: roundedMs(o.latencyMs) }, tokens, tools });
    }
  }
  outcomes(at, feedback) {
    if (!hasValidOutcome(feedback.outcomes) || feedback.artifactId === undefined) return;
    if (feedback.audienceIds !== undefined && !validAudienceIds(feedback.audienceIds)) return;
    if (feedback.outcomeRunMinute !== undefined && (!validOutcomeRunMinute(feedback.outcomeRunMinute) || feedback.outcomeRunMinute > minuteOf(at))) return;
    if (feedback.outcomeRunMinute === undefined) {
      const minute = minuteOf(at);
      if (this.openMinute !== minute) return;
      const key = JSON.stringify([feedback.tag, feedback.artifactId, feedback.versionId, feedback.arm, feedback.model, "ok", null, feedback.audienceIds ?? null, null]);
      const existing = this.open.get(key);
      if (!existing || existing.count === 0) return;
      mergeOutcomes(existing, feedback.outcomes);
      return;
    }
    mergeOutcomes(this.window(at, { ...feedback, tag: feedback.tag, status: "ok" }), feedback.outcomes);
  }
  close(_at) {
    this.emitted.push(...this.open.values());
    this.emittedSteps.push(...this.openSteps.values());
    this.open.clear();
    this.openSteps.clear();
    this.stepNames.clear();
    this.openMinute = null;
  }
}

// ---------------------------------------------------------------------------
// A reader's tolerance: rows a later 3.x wrote
// ---------------------------------------------------------------------------

const WINDOW_NESTED = { latencyMs: ["buckets", "sum"], tokens: ["input", "cachedInput", "output"], tools: ["calls", "errors"], tokensSq: ["input", "cachedInput", "output", "inputOutput", "inputCached", "cachedOutput"], checks: ["passed", "failed"] };
const WINDOW_FIELDS = ["type", "v", "artifactId", "audienceIds", "outcomeRunMinute", "minute", "instanceId", "instanceClass", "tag", "versionId", "arm", "model", "status", "errorClass", "usageSource", "count", "modelCalls", "agentRun", "tools", "latencyMs", "tokens", "tokensSq", "checks", "outcomes", "sdk"];
const STEP_FIELDS = ["type", "v", "artifactId", "audienceIds", "minute", "instanceId", "instanceClass", "tag", "versionId", "arm", "model", "step", "status", "errorClass", "usageSource", "modelCalls", "latencyMs", "tokens", "tools", "sdk"];
const ROW_FIELDS = { window: { v: 4, fields: WINDOW_FIELDS }, step: { v: 1, fields: STEP_FIELDS }, refusal: { v: 1, fields: ["type", "v", "at", "instanceId", "reason", "generation", "tag"] }, dropped: { v: 1, fields: ["type", "v", "at", "instanceId", "segments", "bytes"] } };

/** Lines to rows: unknown fields stripped, later rows skipped and counted, only corruption refused. */
const ROW_STATUSES = { window: ["ok", "error", "refused", "interrupted"], step: ["ok", "error"] };

export function inspectLines({ instanceId, lines, nowMs }) {
  const rows = [], invalid = [], skipped = [], stripped = [];
  let skippedBytes = 0;
  lines.forEach((line, index) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      invalid.push({ line: index + 1, reason: "not_json" });
      return;
    }
    const known = Object.hasOwn(ROW_FIELDS, value?.type) ? ROW_FIELDS[value.type] : null;
    if (!known || value.v !== known.v) {
      skipped.push({ line: index + 1, reason: known ? "v" : "unknown_type" });
      skippedBytes += Buffer.byteLength(line, "utf8") + 1;
      return;
    }
    const crossed = (value.type === "window" ? ["step"] : value.type === "step" ? ["tokensSq", "count", "outcomes", "checks"] : []).find((name) => name in value);
    if (crossed) {
      invalid.push({ line: index + 1, reason: `unknown_field:${crossed}` });
      return;
    }
    if (ROW_STATUSES[value.type] && !ROW_STATUSES[value.type].includes(value.status)) {
      skipped.push({ line: index + 1, reason: "status" });
      skippedBytes += Buffer.byteLength(line, "utf8") + 1;
      return;
    }
    if (value.instanceId !== instanceId) {
      invalid.push({ line: index + 1, reason: "instance_mismatch" });
      return;
    }
    const row = {};
    for (const [key, entry] of Object.entries(value)) {
      if (!known.fields.includes(key)) stripped.push({ line: index + 1, field: key });
      else if (WINDOW_NESTED[key] && entry && typeof entry === "object") {
        row[key] = Object.fromEntries(Object.entries(entry).filter(([name]) => {
          if (!WINDOW_NESTED[key].includes(name)) stripped.push({ line: index + 1, field: `${key}.${name}` });
          return WINDOW_NESTED[key].includes(name);
        }));
      } else row[key] = entry;
    }
    rows.push(row);
  });
  if (skipped.length > 0) rows.push({ type: "dropped", v: 1, at: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z"), instanceId, segments: 0, lines: skipped.length, bytes: skippedBytes });
  return { rows, invalid, skipped, stripped };
}

// ---------------------------------------------------------------------------
// Feedback catalogue → outcomes
// ---------------------------------------------------------------------------

export const BOOLEAN_SIGNALS = ["flagged", "accepted", "edited", "regenerated", "copied", "followUp", "escalated", "abandoned", "corrected", "resolved", "reopened", "converted", "refunded", "slaMet"];
export const UNIT_SIGNALS = ["editDistanceRatio", "judgeScore"];
export const COUNT_SIGNALS = ["regenerations", "timeToAcceptMs"];
/** T34: written by the runtime on a window (a golden-set run), never accepted from ap.feedback(); reserved so custom cannot shadow it. */
export const RUNTIME_SIGNALS = ["goldenPass"];
export const CATALOGUE = new Set(["thumbs", "rating", "correctedValue", "custom", ...BOOLEAN_SIGNALS, ...UNIT_SIGNALS, ...COUNT_SIGNALS, ...RUNTIME_SIGNALS]);

export function normalizeFeedback(signals) {
  const outcomes = {};
  const rejected = {};
  for (const [name, value] of Object.entries(signals)) {
    if (name === "thumbs") {
      if (value === "up" || value === "down") outcomes.thumbs = value === "up";
      else rejected[name] = "invalid_value";
    } else if (name === "rating") {
      if (Number.isInteger(value) && value >= 1 && value <= 5) outcomes.rating = value;
      else rejected[name] = "invalid_value";
    } else if (BOOLEAN_SIGNALS.includes(name)) {
      if (typeof value === "boolean") outcomes[name] = value;
      else rejected[name] = "invalid_value";
    } else if (UNIT_SIGNALS.includes(name)) {
      if (isFinite(value) && value >= 0 && value <= 1) outcomes[name] = value;
      else rejected[name] = "invalid_value";
    } else if (COUNT_SIGNALS.includes(name)) {
      if (Number.isInteger(value) && value >= 0) outcomes[name] = value;
      else rejected[name] = "invalid_value";
    } else if (name === "correctedValue") {
      rejected[name] = typeof value === "string" && value.length <= 64 ? "needs_slot_enum" : "invalid_value";
    } else if (RUNTIME_SIGNALS.includes(name)) {
      rejected[name] = "reserved_name";
    } else if (name === "custom") {
      if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length > 8) {
        rejected[name] = "invalid_value";
        continue;
      }
      for (const [customName, customValue] of Object.entries(value)) {
        if (!OUTCOME_NAME.test(customName)) rejected[`custom.${customName}`] = "invalid_name";
        else if (CATALOGUE.has(customName)) rejected[`custom.${customName}`] = "reserved_name";
        else if (typeof customValue === "boolean" || isFinite(customValue)) outcomes[customName] = customValue;
        else rejected[`custom.${customName}`] = "invalid_value";
      }
    } else rejected[name] = "unknown_signal";
  }
  return { accepted: Object.keys(outcomes).length > 0, outcomes, rejected };
}
