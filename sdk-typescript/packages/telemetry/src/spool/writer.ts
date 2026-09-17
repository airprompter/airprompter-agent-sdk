/**
 * The spool writer (`protocol/spool-format.md`, D52/D66).
 *
 * Minute windows accumulate in memory per dimension set
 * `(tag, versionId, arm, model, status, errorClass)` and are written as
 * `window` rows when the minute closes. Segments are append-only NDJSON
 * under `<store>/spool/telemetry/`, open as `seg-<inst>-<epochMinute>-<n>.ndjson.open`,
 * closed by fsync + rename; rotated at the minute boundary or 1 MiB. Nothing
 * here can carry prompt text, output, or an end-user identifier — the row
 * shape has no field for them. Serverless hosts use the memory sink and
 * flush at invocation end.
 *
 * @example
 * ```ts
 * const identity = { instanceId, instanceClass: "ephemeral" as const, sdk: "my-service/1.4.0" };
 * const sink = new MemorySink(identity); // serverless; a resident host uses new DirectorySink(dir, instanceId)
 * const writer = new SpoolWriter(sink, identity);
 * writer.observe({ tag: "support.triage", versionId, arm: "none", model: "gpt-5", status: "ok", latencyMs: 412, tokens: { input: 120, output: 40 } }, Date.now());
 * writer.closeWindows(Date.now()); // invocation end: the minute's windows become rows
 * const rows = sink.drain(Date.now()); // the rows, then one `dropped` row if the 256 KiB buffer evicted any
 * ```
 */

import { join } from "node:path";

import { nodeFs, fsFailureCode, latencyBucketIndex, minuteOf, epochMinute, LATENCY_BUCKET_EDGES_MS, type FsPort, type ErrorClass, type Observation, type WindowRow, type RefusalRow, type DroppedRow, type SpoolRow } from "@airprompter/agent-core";

export { LATENCY_BUCKET_EDGES_MS, latencyBucketIndex, minuteOf, epochMinute } from "@airprompter/agent-core";
export type { ErrorClass, Observation, WindowRow, RefusalRow, DroppedRow, SpoolRow } from "@airprompter/agent-core";

export const SEGMENT_MAX_BYTES = 1024 * 1024;
/** A host keeps this much closed, unsent spool before the oldest segments are evicted (spool-format.md). */
export const HOST_SPOOL_BUDGET_BYTES = 100 * 1024 * 1024;
/** A serverless invocation keeps this much in memory; beyond it the oldest rows go and a `dropped` row says so. */
export const SERVERLESS_BUFFER_BYTES = 256 * 1024;

export function segmentName(instanceId: string, minute: number, n: number): string {
  return `seg-${instanceId}-${minute}-${n}.ndjson`;
}

/** Which segment an appended line lands in: a new one on a new minute, or when the line would push past 1 MiB. Pure; `protocol/vectors/spool.json` pins it. */
export class SegmentPlanner {
  openMinute: number | null = null;
  openBytes = 0;
  n = 0;
  constructor(readonly instanceId: string) {}
  append(epochMs: number, lineBytes: number): { segment: string; rotated: boolean } {
    const minute = epochMinute(epochMs);
    const rotated = this.openMinute === null || minute !== this.openMinute || this.openBytes + lineBytes > SEGMENT_MAX_BYTES;
    if (rotated) {
      this.n = minute === this.openMinute ? this.n + 1 : 0;
      this.openMinute = minute;
      this.openBytes = 0;
    }
    this.openBytes += lineBytes;
    return { segment: segmentName(this.instanceId, this.openMinute!, this.n), rotated };
  }
}

/** Where rows go: a directory of segments, or memory (serverless). */
export interface SpoolSink {
  /** What the sink is, as data: `"directory"` (segments on disk) or `"memory"` (the serverless buffer). Never branch on the class. */
  readonly kind: "directory" | "memory" | (string & {});
  append(row: SpoolRow, nowMs: number): void;
  /** Close the open segment (or return the buffered rows). */
  flush(nowMs: number): void;
  /** A buffered sink hands its rows back for the host's uploader (invocation end); absent on a sink that persists them. */
  drain?(nowMs: number): SpoolRow[];
  /** A persisting sink reports what waits on disk; absent on a buffered sink. */
  depth?(): { segments: number; bytes: number };
}

/**
 * The serverless buffer: rows in memory up to `budgetBytes` (256 KiB by
 * default). When a row would push past the budget the OLDEST rows are
 * evicted and counted; the next flush (invocation end) hands back the
 * surviving rows followed by one `dropped` row carrying the count and the
 * bytes lost, so an over-chatty invocation is reported, never silent.
 */
export class MemorySink implements SpoolSink {
  readonly kind = "memory" as const;
  readonly rows: SpoolRow[] = [];
  private bytes = 0;
  private droppedRows = 0;
  private droppedBytes = 0;

  constructor(
    private readonly identity: { instanceId: string } | null = null,
    private readonly budgetBytes: number = SERVERLESS_BUFFER_BYTES,
  ) {}

  append(row: SpoolRow): void {
    const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    this.rows.push(row);
    this.bytes += size;
    // The newest row always survives: one row past the budget is kept rather than the buffer emptied.
    while (this.bytes > this.budgetBytes && this.rows.length > 1) {
      const oldest = this.rows.shift()!;
      const lost = Buffer.byteLength(JSON.stringify(oldest), "utf8") + 1;
      this.bytes -= lost;
      this.droppedRows += 1;
      this.droppedBytes += lost;
    }
  }
  flush(_nowMs?: number): void {}
  /** The buffered rows, then a `dropped` row when eviction happened since the last drain. */
  drain(nowMs: number = Date.now()): SpoolRow[] {
    const rows = this.rows.splice(0, this.rows.length);
    this.bytes = 0;
    if (this.droppedRows > 0 && this.identity) {
      rows.push({ type: "dropped", v: 1, at: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z"), instanceId: this.identity.instanceId, segments: this.droppedRows, bytes: this.droppedBytes });
      this.droppedRows = 0;
      this.droppedBytes = 0;
    }
    return rows;
  }
  get dropped(): { rows: number; bytes: number } {
    return { rows: this.droppedRows, bytes: this.droppedBytes };
  }
}

/**
 * What a `DirectorySink` could not keep: rows it failed to write, counted by
 * the filesystem code that refused them. Reported as a `dropped` row the
 * moment a write succeeds again, so the loss is visible in the spool itself.
 */
export interface SinkFaults {
  /** Rows the sink could not write (disk full, I/O error), not yet reported in a `dropped` row. */
  pendingRows: number;
  pendingBytes: number;
  /** Every failure by code, for status and the heartbeat. */
  byCode: Record<string, number>;
  /** The last failure, as a sentence a customer can act on. */
  last: string | null;
}

/**
 * Segments on disk, through an `FsPort`. Never throws: the request path calls
 * `append`, and a full disk, an I/O error or a file a sibling process took
 * away are counted, reported as a `dropped` row when writing works again,
 * and surfaced on `faults` — never surfaced to the caller as an exception.
 */
export class DirectorySink implements SpoolSink {
  readonly kind = "directory" as const;
  private fd: number | null = null;
  private openPath: string | null = null;
  private readonly planner: SegmentPlanner;
  private readonly fs: FsPort;
  readonly faults: SinkFaults = { pendingRows: 0, pendingBytes: 0, byCode: {}, last: null };

  constructor(
    readonly dir: string,
    private readonly instanceId: string,
    private readonly budgetBytes: number = HOST_SPOOL_BUDGET_BYTES,
    fs: FsPort = nodeFs,
  ) {
    this.fs = fs;
    this.planner = new SegmentPlanner(instanceId);
    this.guard("open_spool", () => {
      this.fs.mkdirp(join(dir, "exported"), 0o700);
      this.fs.mkdirp(join(dir, "quarantine"), 0o700);
    });
    this.recoverOpenSegments();
  }

  /** Run a filesystem step; on failure count it by code and return false. The sink never throws. */
  private guard(step: string, run: () => void): boolean {
    try {
      run();
      return true;
    } catch (error) {
      const code = fsFailureCode(error);
      this.faults.byCode[code] = (this.faults.byCode[code] ?? 0) + 1;
      this.faults.last = `${step}: ${code}`;
      return false;
    }
  }

  /** A writer that crashed left `.open` files; the same writer closes them on its next start (a partial last line is the daemon's to skip). */
  private recoverOpenSegments(): void {
    let names: string[] = [];
    this.guard("list_spool", () => void (names = this.fs.list(this.dir)));
    for (const name of names) {
      if (name.startsWith(`seg-${this.instanceId}-`) && name.endsWith(".ndjson.open")) {
        const path = join(this.dir, name);
        this.guard("recover_open_segment", () => {
          const fd = this.fs.open(path, "r+");
          try {
            this.fs.fsync(fd);
          } finally {
            this.fs.close(fd);
          }
          this.fs.rename(path, path.slice(0, -".open".length));
        });
      }
    }
  }

  append(row: SpoolRow, nowMs: number): void {
    const line = Buffer.from(`${JSON.stringify(row)}\n`, "utf8");
    const plan = this.planner.append(nowMs, line.length);
    if (plan.rotated || this.fd === null) {
      this.flush(nowMs);
      const opened = this.guard("open_segment", () => {
        // A name already on disk (a previous process of the same instance in the same minute) is skipped, never appended to.
        let name = plan.segment;
        while (this.fs.exists(join(this.dir, name)) || this.fs.exists(join(this.dir, `${name}.open`))) {
          this.planner.n += 1;
          name = segmentName(this.instanceId, this.planner.openMinute!, this.planner.n);
        }
        const openPath = join(this.dir, `${name}.open`);
        this.fd = this.fs.open(openPath, "a", 0o600);
        this.openPath = openPath;
      });
      if (!opened) {
        this.fd = null;
        this.openPath = null;
        this.lose(1, line.length);
        return;
      }
      this.reportPendingLoss(nowMs);
      if (this.fd === null) {
        // The loss could not even be said (still no space): this row joins it.
        this.lose(1, line.length);
        return;
      }
    }
    const fd = this.fd;
    if (!this.guard("write_row", () => this.fs.write(fd, line))) {
      // What was written before this row is good; close the segment (a partial last line is the daemon's to skip) and count the row.
      this.closeOpen();
      this.lose(1, line.length);
    }
  }

  /** A row the sink could not keep. Counted now; said in a `dropped` row when a write succeeds again. */
  private lose(rows: number, bytes: number): void {
    this.faults.pendingRows += rows;
    this.faults.pendingBytes += bytes;
  }

  /** Rows lost to failures become one `dropped` row (rows counted as `segments`, as the memory sink does) in the segment just opened. */
  private reportPendingLoss(nowMs: number): void {
    if (this.faults.pendingRows === 0 || this.fd === null) return;
    const rows = this.faults.pendingRows;
    const bytes = this.faults.pendingBytes;
    const line = Buffer.from(`${JSON.stringify({ type: "dropped", v: 1, at: isoSeconds(nowMs), instanceId: this.instanceId, segments: rows, bytes })}\n`, "utf8");
    const fd = this.fd;
    if (this.guard("write_dropped_row", () => this.fs.write(fd, line))) {
      this.faults.pendingRows = 0;
      this.faults.pendingBytes = 0;
    } else {
      this.closeOpen();
    }
  }

  flush(nowMs?: number): void {
    if (this.fd === null || !this.openPath) return;
    this.closeOpen();
    // Over budget after this close: evict the oldest, then write the loss as its own small closed segment, at once.
    const evicted = this.enforceBudget();
    if (evicted) {
      const at = nowMs ?? Date.now();
      this.append({ type: "dropped", v: 1, at: isoSeconds(at), instanceId: this.instanceId, segments: evicted.segments, bytes: evicted.bytes }, at);
      this.closeOpen();
    }
  }

  private closeOpen(): void {
    if (this.fd === null || !this.openPath) return;
    const fd = this.fd;
    const openPath = this.openPath;
    this.fd = null;
    this.openPath = null;
    const synced = this.guard("fsync_segment", () => this.fs.fsync(fd));
    this.guard("close_segment", () => this.fs.close(fd));
    // A segment that did not fsync is not closed: it stays `.open` for the next start to recover (its bytes are on disk or they are not).
    if (synced) this.guard("close_segment", () => this.fs.rename(openPath, openPath.slice(0, -".open".length)));
  }

  /** Over the host budget: evict the OLDEST closed, unsent segments and say how much went (spool-format.md). A file a sibling took away is skipped. */
  private enforceBudget(): { segments: number; bytes: number } | null {
    const sizes: Array<{ name: string; size: number }> = [];
    let total = 0;
    for (const name of this.closedSegments()) {
      this.guard("stat_segment", () => {
        const size = this.fs.stat(join(this.dir, name)).size;
        sizes.push({ name, size });
        total += size;
      });
    }
    let evicted = 0;
    let evictedBytes = 0;
    for (const { name, size } of sizes) {
      if (total <= this.budgetBytes) break;
      // Gone already (the daemon or a sibling evicted it): it no longer counts, and nothing was lost here.
      const removed = this.guard("evict_segment", () => this.fs.unlink(join(this.dir, name)));
      total -= size;
      if (!removed) continue;
      evicted += 1;
      evictedBytes += size;
    }
    return evicted > 0 ? { segments: evicted, bytes: evictedBytes } : null;
  }

  closedSegments(): string[] {
    let names: string[] = [];
    this.guard("list_spool", () => void (names = this.fs.list(this.dir)));
    return names.filter((name) => name.startsWith("seg-") && name.endsWith(".ndjson")).sort();
  }

  depth(): { segments: number; bytes: number } {
    const segments = this.closedSegments();
    let bytes = 0;
    for (const name of segments) this.guard("stat_segment", () => void (bytes += this.fs.stat(join(this.dir, name)).size));
    return { segments: segments.length, bytes };
  }
}

/** ISO-8601 to the second, the spool's timestamp form. */
function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

type WindowKey = string;

/** Accumulates observations into minute windows and hands closed windows to the sink. */
export class SpoolWriter {
  private readonly open = new Map<WindowKey, WindowRow>();
  private openMinute: string | null = null;

  constructor(
    private readonly sink: SpoolSink,
    private readonly identity: { instanceId: string; instanceClass: "resident" | "ephemeral"; sdk: string },
  ) {}

  private window(dimensions: Pick<Observation, "tag" | "versionId" | "arm" | "model" | "status"> & { errorClass?: ErrorClass | null; usageSource?: Observation["usageSource"] }, nowMs: number): WindowRow {
    const minute = minuteOf(nowMs);
    if (this.openMinute !== null && this.openMinute !== minute) this.closeWindows(nowMs);
    this.openMinute = minute;
    const errorClass = dimensions.errorClass ?? null;
    const key = [dimensions.tag, dimensions.versionId, dimensions.arm, dimensions.model, dimensions.status, errorClass ?? ""].join("\u0000");
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
        latencyMs: { buckets: new Array<number>(LATENCY_BUCKET_EDGES_MS.length).fill(0), sum: 0 },
        tokens: { input: 0, output: 0 },
        sdk: this.identity.sdk,
      };
      this.open.set(key, row);
    }
    return row;
  }

  observe(observation: Observation, nowMs: number): void {
    const row = this.window(observation, nowMs);
    row.count += 1;
    const bucket = latencyBucketIndex(observation.latencyMs);
    row.latencyMs.buckets[bucket] = (row.latencyMs.buckets[bucket] ?? 0) + 1;
    row.latencyMs.sum += Math.max(0, Math.round(observation.latencyMs));
    row.tokens.input += observation.tokens?.input ?? 0;
    row.tokens.output += observation.tokens?.output ?? 0;
    if (observation.tokens?.cachedInput) row.tokens.cachedInput = (row.tokens.cachedInput ?? 0) + observation.tokens.cachedInput;
    if (observation.checks) {
      row.checks = { passed: (row.checks?.passed ?? 0) + (observation.checks.passed ?? 0), failed: (row.checks?.failed ?? 0) + (observation.checks.failed ?? 0) };
    }
    if (observation.outcomes) mergeOutcomes(row, observation.outcomes);
  }

  /** T29: output-check counts against a run already counted (an app that evaluated after the fact): the run's window, no extra count. */
  checks(dimensions: Pick<Observation, "tag" | "versionId" | "arm" | "model">, counts: { passed: number; failed: number }, nowMs: number): void {
    const row = this.window({ ...dimensions, status: "ok" }, nowMs);
    row.checks = { passed: (row.checks?.passed ?? 0) + counts.passed, failed: (row.checks?.failed ?? 0) + counts.failed };
  }

  /** Quality signals against a run already counted: they ride on the run's window (status ok) and never add to `count`. */
  outcomes(dimensions: Pick<Observation, "tag" | "versionId" | "arm" | "model">, outcomes: Record<string, number | boolean>, nowMs: number): void {
    mergeOutcomes(this.window({ ...dimensions, status: "ok" }, nowMs), outcomes);
  }

  refusal(row: Omit<RefusalRow, "type" | "v" | "instanceId">, nowMs: number): void {
    this.sink.append({ type: "refusal", v: 1, instanceId: this.identity.instanceId, ...row }, nowMs);
  }

  /** Write every open window and close the segment. Called at the minute boundary, at shutdown, and at invocation end on serverless. */
  closeWindows(nowMs: number): void {
    for (const row of this.open.values()) this.sink.append(row, nowMs);
    this.open.clear();
    this.openMinute = null;
    this.sink.flush(nowMs);
  }

  /** S6: close the windows of a minute that has passed (and the segment with them) without touching the current minute — the runtime's spool timer calls this, so an idle writer never leaves the last minute of a burst parked in an `.open` file. */
  closeStaleWindows(nowMs: number): void {
    if (this.openMinute !== null && this.openMinute !== minuteOf(nowMs)) this.closeWindows(nowMs);
  }

  get openWindowCount(): number {
    return this.open.size;
  }
}

function mergeOutcomes(row: WindowRow, outcomes: Record<string, number | boolean>): void {
  row.outcomes ??= {};
  for (const [name, value] of Object.entries(outcomes)) {
    if (!/^[a-z][a-zA-Z0-9]{0,31}$/.test(name)) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    const current = row.outcomes[name] ?? { n: 0, sum: 0 };
    row.outcomes[name] = { n: current.n + 1, sum: current.sum + (typeof value === "boolean" ? (value ? 1 : 0) : value) };
  }
}
