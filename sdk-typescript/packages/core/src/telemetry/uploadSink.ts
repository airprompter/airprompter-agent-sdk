/**
 * Where validated spool segments go (S13): the `UploadSink` port. The
 * uploader in `@airprompter/agent-telemetry` owns the spool — the sweep, the
 * budget, the quarantine, the delete-on-ack — and hands each validated
 * segment to a sink. Two sinks ship: AirPrompter's (a grant per writer from
 * the heartbeat, a PUT to the customer's own prefix) and the OpenTelemetry
 * bridge (`@airprompter/otel-bridge`: the windows as OTLP metrics to the
 * collector the customer already runs, no AirPrompter grant at all). A sink
 * is data, never a class: `kind` says what it is.
 *
 * @example
 * ```ts
 * // A customer's own sink: the validated rows to their pipeline; the uploader still sweeps, budgets and deletes on ok.
 * const sink: UploadSink = {
 *   kind: "my-pipeline",
 *   async ship(segment) {
 *     const response = await pipeline.post(segment.rows);
 *     return response.ok ? { status: "ok" } : { status: "failed", reason: `http_${response.status}` }; // failed: kept, retried under backoff
 *   },
 * };
 * new SpoolUploader({ dir, instanceId, sink });
 * ```
 */

import type { SpoolRow } from "./rows.js";

export interface UploadSegment {
  /** The writer whose segment this is (the instance id in the file name). */
  instanceId: string;
  /** The segment's file name: the object key on AirPrompter's side, a label elsewhere. */
  segment: string;
  /** The validated rows, in order. */
  rows: SpoolRow[];
  /** Exactly the whole lines, as bytes — what AirPrompter's sink posts. */
  bytes: Uint8Array;
}

/**
 * What a sink says about one segment:
 * - `ok`: shipped; the uploader deletes the segment.
 * - `hold`: not now (a grant is throttled, a collector asked for backoff); the uploader keeps the segment and waits.
 * - `failed`: try again later under backoff; the segment stays under the budget.
 * - `dropped`: the sink gave up on this segment for good (the bridge's drop-and-count); the uploader deletes it and counts the loss.
 * - `too_large`: the receiver refused the size; the segment is quarantined.
 */
export type UploadOutcome =
  | { status: "ok" }
  | { status: "hold"; retryAfterMs: number; reason?: string }
  | { status: "failed"; reason: string }
  | { status: "dropped"; reason: string }
  | { status: "too_large"; bytes: number };

export interface UploadSink {
  /** What the sink is, as data: `"airprompter"`, `"otlp"`, or a customer's own. Never branch on a class. */
  readonly kind: "airprompter" | "otlp" | (string & {});
  ship(segment: UploadSegment): Promise<UploadOutcome>;
  /** Live state for `status` (grants held, the collector's last answer); optional. */
  status?(): Record<string, unknown>;
}
