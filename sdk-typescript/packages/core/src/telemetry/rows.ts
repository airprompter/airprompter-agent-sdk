/**
 * The telemetry row schemas (`protocol/spool-format.md`, D52/D66): what a
 * spool segment carries, and nothing else. There is no field for prompt
 * text, output, or an end-user identifier — the shape is the privacy rule.
 * Pure: the spool writer (`@airprompter/agent-telemetry`) and the wrap
 * adapters (`@airprompter/agent-runtime`) both build on these without
 * importing each other.
 *
 * @example
 * ```ts
 * const observation: Observation = { tag: "support.triage", versionId, arm: "none", model: "gpt-5", status: "ok", latencyMs: 412, tokens: { input: 120, output: 40 }, usageSource: "reported" };
 * minuteOf(Date.now()); // "2026-09-17T14:03:00Z" — the window a row lands in
 * latencyBucketIndex(412); // 9: the 512 ms bucket; anything past the last edge lands in it
 * ```
 */

export const LATENCY_BUCKET_EDGES_MS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 65536] as const;

export type ErrorClass =
  | "render_missing_variable"
  | "context_length_exceeded"
  | "output_schema_invalid"
  | "truncated"
  | "content_filter"
  | "provider_error"
  | "provider_timeout"
  | "provider_rate_limited";

export interface Observation {
  tag: string;
  versionId: string;
  arm: string;
  model: string;
  status: "ok" | "error" | "refused";
  errorClass?: ErrorClass | null;
  latencyMs: number;
  tokens?: { input?: number; cachedInput?: number; output?: number };
  usageSource?: "reported" | "measured" | "estimated" | "unavailable";
  checks?: { passed?: number; failed?: number };
  outcomes?: Record<string, number | boolean>;
}

export interface WindowRow {
  type: "window";
  v: 1;
  minute: string;
  instanceId: string;
  instanceClass: "resident" | "ephemeral";
  tag: string;
  versionId: string;
  arm: string;
  model: string;
  status: "ok" | "error" | "refused";
  errorClass: ErrorClass | null;
  usageSource: "reported" | "measured" | "estimated" | "unavailable";
  count: number;
  latencyMs: { buckets: number[]; sum: number };
  tokens: { input: number; cachedInput?: number; output: number };
  checks?: { passed: number; failed: number };
  outcomes?: Record<string, { n: number; sum: number }>;
  sdk: string;
}

export interface RefusalRow {
  type: "refusal";
  v: 1;
  at: string;
  instanceId: string;
  reason: "disabled" | "lease_expired" | "payload_verification_failed" | "forced_downgrade" | "model_unavailable" | "unlock_refused";
  generation: number;
  tag: string | null;
}

/** Segments (or buffered rows) evicted by a budget: the loss is reported, never silent. */
export interface DroppedRow {
  type: "dropped";
  v: 1;
  at: string;
  instanceId: string;
  segments: number;
  bytes: number;
}

export type SpoolRow = WindowRow | RefusalRow | DroppedRow;

export function latencyBucketIndex(latencyMs: number): number {
  const index = LATENCY_BUCKET_EDGES_MS.findIndex((edge) => latencyMs <= edge);
  return index === -1 ? LATENCY_BUCKET_EDGES_MS.length - 1 : index;
}

export function minuteOf(epochMs: number): string {
  const date = new Date(epochMs);
  date.setUTCSeconds(0, 0);
  return date.toISOString().replace(".000Z", "Z");
}

export function epochMinute(epochMs: number): number {
  return Math.floor(epochMs / 60000);
}
