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
  row.outcomes ??= {};
  for (const [name, value] of Object.entries(outcomes)) {
    if (!OUTCOME_NAME.test(name)) continue;
    const numeric = typeof value === "boolean" ? (value ? 1 : 0) : value;
    if (!isFinite(numeric)) continue;
    const current = row.outcomes[name] ?? { n: 0, sum: 0 };
    row.outcomes[name] = { n: current.n + 1, sum: current.sum + numeric };
  }
}

/** Minute windows per dimension set (tag, versionId, arm, model, status, errorClass). */
export class WindowAggregator {
  constructor({ instanceId, instanceClass, sdk }) {
    this.identity = { instanceId, instanceClass, sdk };
    this.open = new Map();
    this.openMinute = null;
    this.emitted = [];
  }
  window(at, dimensions) {
    const minute = minuteOf(at);
    if (this.openMinute !== null && this.openMinute !== minute) this.close(at);
    this.openMinute = minute;
    const errorClass = dimensions.errorClass ?? null;
    const key = JSON.stringify([dimensions.tag, dimensions.versionId, dimensions.arm, dimensions.model, dimensions.status, errorClass]);
    let row = this.open.get(key);
    if (!row) {
      row = {
        type: "window",
        v: 1,
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
        latencyMs: { buckets: new Array(LATENCY_BUCKET_EDGES_MS.length).fill(0), sum: 0 },
        tokens: { input: 0, output: 0 },
        sdk: this.identity.sdk,
      };
      this.open.set(key, row);
    }
    return row;
  }
  observe(at, observation) {
    const row = this.window(at, observation);
    row.count += 1;
    row.latencyMs.buckets[latencyBucketIndex(observation.latencyMs)] += 1;
    row.latencyMs.sum += Math.max(0, Math.round(observation.latencyMs));
    row.tokens.input += observation.tokens?.input ?? 0;
    row.tokens.output += observation.tokens?.output ?? 0;
    if (observation.tokens?.cachedInput) row.tokens.cachedInput = (row.tokens.cachedInput ?? 0) + observation.tokens.cachedInput;
    if (observation.checks) row.checks = { passed: (row.checks?.passed ?? 0) + (observation.checks.passed ?? 0), failed: (row.checks?.failed ?? 0) + (observation.checks.failed ?? 0) };
    if (observation.outcomes) mergeOutcomes(row, observation.outcomes);
  }
  outcomes(at, feedback) {
    mergeOutcomes(this.window(at, { ...feedback, status: "ok" }), feedback.outcomes);
  }
  close(_at) {
    this.emitted.push(...this.open.values());
    this.open.clear();
    this.openMinute = null;
  }
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
