// A spool writer without the SDK (protocol/spool-format.md, D66): what a team
// instrumenting a provider SDK themselves needs — minute windows per
// (tag, artifactId, versionId, arm, model, status, errorClass, audienceIds,
// outcomeRunMinute) where `count` means runs, step rows beside them, the fixed
// latency buckets, segment naming, `.open` → fsync → rename, and rotation on the
// minute or at 1 MiB. `airprompterd` uploads what lands in `dir`. No
// dependencies; `conformance/run.mjs` drives it through vectors/spool.json.
//
//   const spool = new SpoolWriter({ dir: `${stateDir}/airprompter/${agentId}/${target}/spool/telemetry`, instanceId, sdk: "acme-logger/1.0" });
//   spool.observe({ tag, artifactId, versionId, arm, model, status: "ok", latencyMs: 812, tokens: { input: 400, output: 90 } }); // a one-call run
//   spool.recordRun({ dimensions, status: "ok", errorClass: null, usageSource: "reported", agentRun: 1, modelCalls: 5, latencyMs: 4200, tokens, tools });
//   spool.feedback({ tag, artifactId, versionId, arm, model, outcomes: { accepted: true } });
//   process.on("beforeExit", () => spool.close());

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";

export const LATENCY_BUCKET_EDGES_MS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576, 2097152, 3600000];
export const STEP_BOUNDS = { maxLength: 64, maxPerRun: 32 };
export const SEGMENT_MAX_BYTES = 1024 * 1024;
const OUTCOME_NAME = /^[a-z][a-zA-Z0-9]{0,31}$/;
const OUTCOME_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z$/;
const validAudienceIds = (value) => Array.isArray(value) && value.length <= 8 && value.every((id, i) => typeof id === "string" && /^aud_[A-Za-z0-9_-]{22}$/.test(id) && (i === 0 || value[i - 1] < id));
const validOutcomeRunMinute = (value) => {
  if (typeof value !== "string" || !OUTCOME_MINUTE.test(value) || value.startsWith("0000-") || !Number.isFinite(Date.parse(value))) return false;
  const date = value.slice(0, 10);
  const midnight = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(midnight) && new Date(midnight).toISOString().slice(0, 10) === date && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60;
};
const validStep = (value) => typeof value === "string" && [...value].length >= 1 && [...value].length <= STEP_BOUNDS.maxLength && !/[\u0000-\u001f\u007f]/u.test(value);
const hasValidOutcome = (outcomes) => Object.entries(outcomes).some(([name, value]) => OUTCOME_NAME.test(name) && (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value * value))));
const countOf = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value))) : 0);
const roundedMs = (value) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);

export const latencyBucketIndex = (ms) => {
  const index = LATENCY_BUCKET_EDGES_MS.findIndex((edge) => ms <= edge);
  return index === -1 ? LATENCY_BUCKET_EDGES_MS.length - 1 : index;
};
export const epochMinute = (epochMs) => Math.floor(epochMs / 60000);
export const minuteOf = (epochMs) => new Date(epochMinute(epochMs) * 60000).toISOString().replace(".000Z", "Z");
export const segmentName = (instanceId, minute, n) => `seg-${instanceId}-${minute}-${n}.ndjson`;

function checkDimensions(d, at) {
  if (typeof d.artifactId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(d.artifactId)) throw new Error("telemetry_artifact_id_invalid");
  if (d.audienceIds !== undefined && !validAudienceIds(d.audienceIds)) throw new Error("telemetry_audience_ids_invalid");
  if (d.outcomeRunMinute !== undefined && (!validOutcomeRunMinute(d.outcomeRunMinute) || d.outcomeRunMinute > minuteOf(at))) throw new Error("telemetry_outcome_run_minute_invalid");
}

export class SpoolWriter {
  constructor({ dir = null, instanceId, instanceClass = "resident", sdk = "spool-writer-example/1.0", now = Date.now }) {
    Object.assign(this, { dir, instanceId, instanceClass, sdk, now, open: new Map(), openSteps: new Map(), stepNames: new Map(), openMinute: null, segMinute: null, segBytes: 0, segN: -1, sealed: false, emitted: [] });
    if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** One run's totals: the only place `count` rises. Moments are over the run's totals, never per model call. */
  recordRun({ dimensions, status, errorClass = null, usageSource = "reported", agentRun, modelCalls, latencyMs, tokens, tools, checks = null }, at = this.now()) {
    const row = this.window(at, { ...dimensions, status, errorClass, usageSource });
    if (row.outcomeRunMinute === row.minute) delete row.outcomeRunMinute;
    row.count += 1;
    row.agentRun += agentRun;
    row.modelCalls += countOf(modelCalls);
    row.tools.calls += countOf(tools.calls);
    row.tools.errors += countOf(tools.errors);
    row.latencyMs.buckets[latencyBucketIndex(latencyMs)] += 1;
    row.latencyMs.sum += roundedMs(latencyMs);
    const [input, cachedInput, output] = [tokens.input, tokens.cachedInput, tokens.output].map(countOf);
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
    if (checks) row.checks = { passed: (row.checks?.passed ?? 0) + checks.passed, failed: (row.checks?.failed ?? 0) + checks.failed };
    return row;
  }

  /** One step's totals: a row of its own, never a window. Past either cap in STEP_BOUNDS the name is written as `other`. */
  recordStep({ dimensions, step, status, errorClass = null, usageSource = "reported", latency, tokens, tools }, at = this.now()) {
    const d = dimensions;
    checkDimensions(d, at);
    const minute = this.turnMinute(at);
    const scope = JSON.stringify([d.tag, d.artifactId, d.versionId, d.arm, d.model, d.audienceIds ?? null]);
    if (!this.stepNames.has(scope)) this.stepNames.set(scope, new Set());
    const names = this.stepNames.get(scope);
    let name = validStep(step) ? step : "other";
    if (name !== "other" && !names.has(name)) {
      if (names.size >= STEP_BOUNDS.maxPerRun) name = "other";
      else names.add(name);
    }
    const key = JSON.stringify([scope, name, status, errorClass]);
    let row = this.openSteps.get(key);
    if (!row) {
      row = { type: "step", v: 1, artifactId: d.artifactId, minute, instanceId: this.instanceId, instanceClass: this.instanceClass, tag: d.tag, versionId: d.versionId, arm: d.arm, model: d.model, step: name, status, errorClass, usageSource, modelCalls: 0, latencyMs: { buckets: new Array(LATENCY_BUCKET_EDGES_MS.length).fill(0), sum: 0 }, tokens: { input: 0, output: 0 }, tools: { calls: 0, errors: 0 }, sdk: this.sdk };
      if (d.audienceIds !== undefined) row.audienceIds = [...d.audienceIds];
      this.openSteps.set(key, row);
    }
    latency.buckets.forEach((n, i) => {
      row.latencyMs.buckets[i] += countOf(n);
      row.modelCalls += countOf(n); // the histogram counts the model calls: the validator holds the two equal
    });
    row.latencyMs.sum += roundedMs(latency.sum);
    row.tokens.input += countOf(tokens.input);
    row.tokens.output += countOf(tokens.output);
    if (countOf(tokens.cachedInput)) row.tokens.cachedInput = (row.tokens.cachedInput ?? 0) + countOf(tokens.cachedInput);
    row.tools.calls += countOf(tools.calls);
    row.tools.errors += countOf(tools.errors);
  }

  /** A one-call run: latency, tokens, status and error class, never text, ids or messages. A step row only when it names a step. */
  observe({ tag: givenTag, artifactId, versionId, arm = "none", model, status = "ok", errorClass = null, usageSource = "reported", audienceIds, latencyMs, tokens = {}, toolCalls = {}, step: givenStep, checks = null, outcomes = null }, at = this.now()) {
    const tag = givenTag;
    const step = givenStep;
    const dimensions = { tag, artifactId, versionId, arm, model, ...(audienceIds !== undefined ? { audienceIds } : {}) };
    const totals = { input: tokens.input ?? 0, cachedInput: tokens.cachedInput ?? 0, output: tokens.output ?? 0 };
    const tools = { calls: toolCalls.calls ?? 0, errors: toolCalls.errors ?? 0 };
    const row = this.recordRun({ dimensions, status, errorClass, usageSource, agentRun: 1, modelCalls: 1, latencyMs, tokens: totals, tools, ...(checks ? { checks: { passed: checks.passed ?? 0, failed: checks.failed ?? 0 } } : {}) }, at);
    if (outcomes) mergeOutcomes(row, outcomes);
    if (step !== undefined) {
      const buckets = new Array(LATENCY_BUCKET_EDGES_MS.length).fill(0);
      buckets[latencyBucketIndex(latencyMs)] = 1;
      this.recordStep({ dimensions, step, status: status === "ok" ? "ok" : "error", errorClass, usageSource, modelCalls: 1, latency: { buckets, sum: roundedMs(latencyMs) }, tokens: totals, tools }, at);
    }
  }

  /** Feedback filed against a run: rides on the run's `ok` window for this minute, never adds to count or latency. */
  feedback({ tag, artifactId, versionId, arm = "none", model, audienceIds, outcomeRunMinute, outcomes }, at = this.now()) {
    if (!hasValidOutcome(outcomes) || artifactId === undefined) return;
    if (audienceIds !== undefined && !validAudienceIds(audienceIds)) return;
    if (outcomeRunMinute !== undefined && (!validOutcomeRunMinute(outcomeRunMinute) || outcomeRunMinute > minuteOf(at))) return;
    if (outcomeRunMinute === undefined) {
      const minute = minuteOf(at);
      if (this.openMinute !== minute) return;
      const key = JSON.stringify([tag, artifactId, versionId, arm, model, "ok", null, audienceIds ?? null, null]);
      const existing = this.open.get(key);
      if (!existing || existing.count === 0) return;
      mergeOutcomes(existing, outcomes);
      return;
    }
    mergeOutcomes(this.window(at, { tag, artifactId, versionId, arm, model, status: "ok", errorClass: null, usageSource: "reported", audienceIds, outcomeRunMinute }), outcomes);
  }

  turnMinute(at) {
    const minute = minuteOf(at);
    if (this.openMinute !== null && this.openMinute !== minute) this.close(at);
    this.openMinute = minute;
    return minute;
  }

  window(at, d) {
    checkDimensions(d, at);
    const minute = this.turnMinute(at);
    const outcomeRunMinute = d.outcomeRunMinute === minute ? null : d.outcomeRunMinute ?? null;
    const key = JSON.stringify([d.tag, d.artifactId, d.versionId, d.arm, d.model, d.status, d.errorClass ?? null, d.audienceIds ?? null, outcomeRunMinute]);
    let row = this.open.get(key);
    if (!row) {
      row = {
        type: "window",
        v: 4,
        artifactId: d.artifactId,
        minute,
        instanceId: this.instanceId,
        instanceClass: this.instanceClass,
        tag: d.tag,
        versionId: d.versionId,
        arm: d.arm,
        model: d.model,
        status: d.status,
        errorClass: d.errorClass ?? null,
        usageSource: d.usageSource ?? "reported",
        count: 0,
        modelCalls: 0,
        agentRun: 0,
        tools: { calls: 0, errors: 0 },
        latencyMs: { buckets: new Array(LATENCY_BUCKET_EDGES_MS.length).fill(0), sum: 0 },
        tokens: { input: 0, output: 0 },
        sdk: this.sdk,
      };
      if (d.audienceIds !== undefined) row.audienceIds = [...d.audienceIds];
      if (d.outcomeRunMinute !== undefined) row.outcomeRunMinute = d.outcomeRunMinute;
      this.open.set(key, row);
    }
    return row;
  }

  /** Writes the open minute's rows to a segment (`.open`, fsync, rename) and starts a new minute. */
  close(at = this.now()) {
    const rows = [...this.open.values(), ...this.openSteps.values()];
    this.open.clear();
    this.openSteps.clear();
    this.stepNames.clear();
    this.openMinute = null;
    for (const row of rows) this.append(JSON.stringify(row) + "\n", at);
    this.emitted.push(...rows);
    if (this.fd !== undefined) this.sealSegment();
  }

  /** Which segment a line lands in: a new one on a new minute or when this line would push past 1 MiB. */
  planSegment(epochMs, lineBytes) {
    const minute = epochMinute(epochMs);
    const rotated = this.sealed || this.segMinute !== minute || this.segBytes + lineBytes > SEGMENT_MAX_BYTES;
    this.sealed = false;
    if (rotated) {
      this.segN = this.segMinute === minute ? this.segN + 1 : 0;
      this.segMinute = minute;
      this.segBytes = 0;
    }
    this.segBytes += lineBytes;
    return { segment: segmentName(this.instanceId, this.segMinute, this.segN), rotated };
  }

  append(line, at) {
    const bytes = Buffer.byteLength(line, "utf8");
    const { segment, rotated } = this.planSegment(at, bytes);
    if (!this.dir) return;
    if (rotated && this.fd !== undefined) this.sealSegment();
    if (this.fd === undefined) (this.segPath = join(this.dir, segment)), (this.fd = openSync(this.segPath + ".open", "a", 0o600));
    writeSync(this.fd, line);
  }

  sealSegment() {
    fsyncSync(this.fd);
    closeSync(this.fd);
    renameSync(this.segPath + ".open", this.segPath);
    this.fd = undefined;
    this.sealed = true; // a later line in the same minute opens the next segment, never this sealed one
  }
}

function mergeOutcomes(row, outcomes) {
  for (const [name, value] of Object.entries(outcomes)) {
    const numeric = typeof value === "boolean" ? (value ? 1 : 0) : value;
    if (!OUTCOME_NAME.test(name) || typeof numeric !== "number" || !Number.isFinite(numeric)) continue;
    const current = row.outcomes?.[name] ?? { n: 0, sum: 0, sumSq: 0 };
    const merged = { n: current.n + 1, sum: current.sum + numeric, sumSq: current.sumSq + numeric * numeric };
    if (!Number.isFinite(merged.sum) || !Number.isFinite(merged.sumSq)) continue; // null in a row would cost the whole segment
    (row.outcomes ??= {})[name] = merged;
  }
}
