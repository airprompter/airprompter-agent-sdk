// A spool writer without the SDK (protocol/spool-format.md, D66): what a team
// instrumenting a provider SDK themselves needs — minute windows per
// (tag, artifactId, versionId, arm, model, status, errorClass, audienceIds,
// outcomeRunMinute), the fixed latency
// buckets, segment naming, `.open` → fsync → rename, and rotation on the
// minute or at 1 MiB. `airprompterd` uploads what lands in `dir`. No
// dependencies; `conformance/run.mjs` drives it through vectors/spool.json.
//
//   const spool = new SpoolWriter({ dir: `${stateDir}/airprompter/${agentId}/${target}/spool/telemetry`, instanceId, sdk: "acme-logger/1.0" });
//   spool.observe({ tag, versionId, arm, model, status: "ok", latencyMs: 812, tokens: { input: 400, output: 90 } });
//   spool.feedback({ tag, versionId, arm, model, outcomes: { accepted: true } });
//   process.on("beforeExit", () => spool.close());

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";

export const LATENCY_BUCKET_EDGES_MS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 65536];
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
const hasValidOutcome = (outcomes) => Object.entries(outcomes).some(([name, value]) => OUTCOME_NAME.test(name) && (typeof value === "boolean" || Number.isFinite(value)));

export const latencyBucketIndex = (ms) => {
  const index = LATENCY_BUCKET_EDGES_MS.findIndex((edge) => ms <= edge);
  return index === -1 ? LATENCY_BUCKET_EDGES_MS.length - 1 : index;
};
export const epochMinute = (epochMs) => Math.floor(epochMs / 60000);
export const minuteOf = (epochMs) => new Date(epochMinute(epochMs) * 60000).toISOString().replace(".000Z", "Z");
export const segmentName = (instanceId, minute, n) => `seg-${instanceId}-${minute}-${n}.ndjson`;

export class SpoolWriter {
  constructor({ dir = null, instanceId, instanceClass = "resident", sdk = "spool-writer-example/1.0", now = Date.now }) {
    Object.assign(this, { dir, instanceId, instanceClass, sdk, now, open: new Map(), openMinute: null, segMinute: null, segBytes: 0, segN: -1, sealed: false, emitted: [] });
    if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** One model call: latency, tokens, status and error class — never text, ids or messages. */
  observe({ tag, artifactId, versionId, arm = "none", model, status = "ok", errorClass = null, usageSource = "reported", audienceIds, runMinute, latencyMs, tokens = {}, checks = null, outcomes = null }, at = this.now()) {
    const row = this.window(at, { tag, artifactId, versionId, arm, model, status, errorClass, usageSource, audienceIds, runMinute });
    if (row.outcomeRunMinute === row.minute) delete row.outcomeRunMinute;
    row.count += 1;
    row.latencyMs.buckets[latencyBucketIndex(latencyMs)] += 1;
    row.latencyMs.sum += Math.max(0, Math.round(latencyMs));
    row.tokens.input += tokens.input ?? 0;
    row.tokens.output += tokens.output ?? 0;
    if (tokens.cachedInput) row.tokens.cachedInput = (row.tokens.cachedInput ?? 0) + tokens.cachedInput;
    if (checks) row.checks = { passed: (row.checks?.passed ?? 0) + (checks.passed ?? 0), failed: (row.checks?.failed ?? 0) + (checks.failed ?? 0) };
    if (outcomes) mergeOutcomes(row, outcomes);
  }

  /** Feedback filed against a run: rides on the run's `ok` window for this minute, never adds to count or latency. */
  feedback({ tag, artifactId, versionId, arm = "none", model, audienceIds, outcomeRunMinute, outcomes }, at = this.now()) {
    if (!hasValidOutcome(outcomes)) return;
    if (audienceIds !== undefined && !validAudienceIds(audienceIds)) return;
    if (outcomeRunMinute !== undefined && ((artifactId === undefined && audienceIds === undefined) || !validOutcomeRunMinute(outcomeRunMinute) || outcomeRunMinute > minuteOf(at))) return;
    if ((audienceIds !== undefined || artifactId !== undefined) && outcomeRunMinute === undefined) {
      const minute = minuteOf(at);
      if (this.openMinute !== minute) return;
      const key = JSON.stringify([tag, artifactId ?? null, versionId, arm, model, "ok", null, audienceIds ?? null, null]);
      const existing = this.open.get(key);
      if (!existing || existing.count === 0) return;
      mergeOutcomes(existing, outcomes);
      return;
    }
    mergeOutcomes(this.window(at, { tag, artifactId, versionId, arm, model, status: "ok", errorClass: null, usageSource: "reported", audienceIds, outcomeRunMinute }), outcomes);
  }

  window(at, d) {
    const minute = minuteOf(at);
    if (d.artifactId !== undefined && (typeof d.artifactId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(d.artifactId))) throw new Error("telemetry_artifact_id_invalid");
    if (d.audienceIds !== undefined && !validAudienceIds(d.audienceIds)) throw new Error("telemetry_audience_ids_invalid");
    if (d.outcomeRunMinute !== undefined && ((d.artifactId === undefined && d.audienceIds === undefined) || !validOutcomeRunMinute(d.outcomeRunMinute) || d.outcomeRunMinute > minute)) throw new Error("telemetry_outcome_run_minute_invalid");
    if (this.openMinute !== null && this.openMinute !== minute) this.close(at);
    this.openMinute = minute;
    const outcomeRunMinute = d.outcomeRunMinute === minute ? null : d.outcomeRunMinute ?? null;
    const key = JSON.stringify([d.tag, d.artifactId ?? null, d.versionId, d.arm, d.model, d.status, d.errorClass ?? null, d.audienceIds ?? null, outcomeRunMinute]);
    let row = this.open.get(key);
    if (!row) {
      row = {
        type: "window",
        v: d.artifactId !== undefined ? 3 : d.audienceIds !== undefined ? 2 : 1,
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
        latencyMs: { buckets: new Array(16).fill(0), sum: 0 },
        tokens: { input: 0, output: 0 },
        sdk: this.sdk,
      };
      if (d.artifactId !== undefined) row.artifactId = d.artifactId;
      if (d.audienceIds !== undefined) row.audienceIds = [...d.audienceIds];
      if (d.outcomeRunMinute !== undefined) row.outcomeRunMinute = d.outcomeRunMinute;
      this.open.set(key, row);
    }
    return row;
  }

  /** Writes the open minute's rows to a segment (`.open`, fsync, rename) and starts a new minute. */
  close(at = this.now()) {
    const rows = [...this.open.values()];
    this.open.clear();
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
  row.outcomes ??= {};
  for (const [name, value] of Object.entries(outcomes)) {
    const numeric = typeof value === "boolean" ? (value ? 1 : 0) : value;
    if (!OUTCOME_NAME.test(name) || typeof numeric !== "number" || !Number.isFinite(numeric)) continue;
    const current = row.outcomes[name] ?? { n: 0, sum: 0 };
    row.outcomes[name] = { n: current.n + 1, sum: current.sum + numeric };
  }
}
