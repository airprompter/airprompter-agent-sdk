/**
 * The OpenTelemetry bridge as an `UploadSink` (S13): a segment's rows go to
 * the collector the customer already runs, as OTLP/HTTP JSON metrics, and
 * never to AirPrompter — no Agent key, no grant, no second sidecar. The
 * uploader owns the spool exactly as with AirPrompter's sink (sweep, budget,
 * quarantine, delete on ack); this sink only exports.
 *
 * Rules:
 * - **Drop and count on a collector's refusal.** A collector that answers
 *   4xx / 5xx has decided: the segment is dropped, counted (`droppedSegments`
 *   in status, `segment_dropped_by_sink` in the log) and the next one is
 *   tried — never a spool that fills behind a misconfigured collector. A
 *   `429` / `503` with `Retry-After` is a hold for that long, the segment
 *   kept. A collector that never answered (connection refused, timeout — a
 *   restart mid-pass) has not decided: `failed`, the segment kept under the
 *   uploader's backoff and the budget, so a blip does not wipe a backlog.
 * - **Nothing here reads a prompt.** The mapping's attribute keys are a
 *   closed set; the rows carry no text.
 * - **Exporter-pluggable.** `endpoint` uses `fetch` and the OTLP/HTTP JSON
 *   encoding (no dependency); `exporter` takes any object with
 *   `export(request)` — an `@opentelemetry/exporter-metrics-otlp-*` wrapped
 *   in a few lines, or the customer's own — so the protobuf and gRPC paths
 *   need no code here.
 */

import type { FetchLike, UploadOutcome, UploadSegment, UploadSink } from "@airprompter/agent-core";

import { spoolRowsToOtlp, type ExportMetricsServiceRequest, type MappingOptions } from "./mapping.js";

export interface OtlpExporter {
  /** Deliver one request; resolve on success, reject (or return `{ ok: false }`) on failure. */
  export(request: ExportMetricsServiceRequest): Promise<void | { ok: boolean; reason?: string; retryAfterMs?: number }>;
}

export interface OtlpSinkOptions extends MappingOptions {
  /** The collector's OTLP/HTTP metrics URL, e.g. `http://localhost:4318/v1/metrics`. */
  endpoint?: string;
  /** Headers on every request (an auth token for a hosted collector). */
  headers?: Record<string, string>;
  fetch?: FetchLike;
  /** Instead of `endpoint`: any exporter (protobuf, gRPC, a test's capture). */
  exporter?: OtlpExporter;
  /** Per-request timeout for the fetch path (10 s by default). */
  timeoutMs?: number;
  now?: () => number;
}

export interface OtlpSinkStatus {
  exported: number;
  dropped: number;
  lastExportAt: string | null;
  lastError: string | null;
}

/** OTLP/HTTP with the JSON encoding over `fetch`: the exporter that needs no dependency. */
export function httpJsonExporter(input: { endpoint: string; headers?: Record<string, string>; fetch: FetchLike; timeoutMs?: number }): OtlpExporter {
  return {
    async export(request) {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000) : null;
      try {
        const response = await input.fetch(input.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...(input.headers ?? {}) },
          body: JSON.stringify(request),
          ...(controller ? { signal: controller.signal } : {}),
        } as never);
        if (response.status >= 200 && response.status < 300) return { ok: true };
        const retryAfter = response.headers.get("retry-after");
        const retryAfterMs = (response.status === 429 || response.status === 503) && retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined;
        return { ok: false, reason: `http_${response.status}`, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
      } catch (error) {
        return { ok: false, reason: `network:${(error as Error).name === "AbortError" ? "timeout" : ((error as Error).message ?? "error")}` };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

export function otlpUploadSink(options: OtlpSinkOptions): UploadSink & { status(): OtlpSinkStatus } {
  const now = options.now ?? (() => Date.now());
  const exporter = options.exporter ?? (options.endpoint ? httpJsonExporter({ endpoint: options.endpoint, ...(options.headers ? { headers: options.headers } : {}), fetch: options.fetch ?? (globalThis.fetch as unknown as FetchLike), ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) }) : null);
  if (!exporter) throw new Error("otlpUploadSink: an endpoint or an exporter is required");
  const status: OtlpSinkStatus = { exported: 0, dropped: 0, lastExportAt: null, lastError: null };
  const mapping: MappingOptions = { ...(options.resource ? { resource: options.resource } : {}), ...(options.sdkVersion ? { sdkVersion: options.sdkVersion } : {}) };
  return {
    kind: "otlp",
    status: () => ({ ...status }),
    async ship(segment: UploadSegment): Promise<UploadOutcome> {
      const request = spoolRowsToOtlp(segment.rows, mapping);
      let result: Awaited<ReturnType<OtlpExporter["export"]>>;
      try {
        result = await exporter.export(request);
      } catch (error) {
        result = { ok: false, reason: `exporter:${(error as Error).message ?? "error"}` };
      }
      if (result === undefined || result.ok) {
        status.exported += 1;
        status.lastExportAt = new Date(now()).toISOString();
        status.lastError = null;
        return { status: "ok" };
      }
      status.lastError = result.reason ?? "failed";
      if (result.retryAfterMs !== undefined && result.retryAfterMs > 0) return { status: "hold", retryAfterMs: result.retryAfterMs, reason: status.lastError };
      // Unanswered (the network, a timeout): not a decision; kept under backoff, bounded by the budget.
      if (status.lastError.startsWith("network:")) return { status: "failed", reason: status.lastError };
      // Answered: drop and count; the collector's refusal never holds the spool.
      status.dropped += 1;
      return { status: "dropped", reason: status.lastError };
    },
  };
}
