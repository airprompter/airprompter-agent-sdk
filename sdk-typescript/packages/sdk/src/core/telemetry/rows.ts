/**
 * The telemetry row schemas (`protocol/spool-format.md`, D52/D66): what a
 * spool segment carries, and nothing else. There is no field for prompt
 * text, output, or an end-user identifier — the shape is the privacy rule.
 * Pure: the spool writer (`@airprompter/agent-sdk/telemetry`) and the wrap
 * adapters (`@airprompter/agent-sdk/runtime`) both build on these without
 * importing each other.
 *
 * @example
 * ```ts
 * const observation: Observation = { tag: "support.triage", artifactId, versionId, arm: "none", model: "gpt-5", status: "ok", latencyMs: 412, tokens: { input: 120, output: 40 }, usageSource: "reported" };
 * minuteOf(Date.now()); // "2026-09-17T14:03:00Z": the window a row lands in
 * latencyBucketIndex(412); // 9: the 512 ms bucket; anything past the last edge lands in it
 * stepName("langgraph:plan", seen); // the name, or "other" past either cap in STEP_BOUNDS
 * ```
 */

/** `protocol/schemas/latency-buckets.json`: up to one hour; an idle sweep ends a run at 15 minutes by default. */
export const LATENCY_BUCKET_EDGES_MS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576, 2097152, 3600000] as const;

/** The only two caps on a step name. A name past either is written as `other`. */
export const STEP_BOUNDS = { maxLength: 64, maxPerRun: 32 } as const;

/** The grammar of a slot tag and of an arm. */
export const SLOT_TAG = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
/** What a writer may put in a row, per row type. A reader's list is the same; a later value is skipped, not refused. */
export const WINDOW_STATUSES: readonly string[] = ["ok", "error", "refused", "interrupted"];
export const STEP_STATUSES: readonly string[] = ["ok", "error"];
export const USAGE_SOURCES: readonly string[] = ["reported", "measured", "estimated", "unavailable"];
export const ERROR_CLASSES: readonly string[] = ["render_missing_variable", "context_length_exceeded", "output_schema_invalid", "truncated", "content_filter", "provider_error", "provider_timeout", "provider_rate_limited", "model_unresolved"];

export type ErrorClass =
  | "render_missing_variable"
  | "context_length_exceeded"
  | "output_schema_invalid"
  | "truncated"
  | "content_filter"
  | "provider_error"
  | "provider_timeout"
  | "provider_rate_limited"
  | "model_unresolved";

export type UsageSource = "reported" | "measured" | "estimated" | "unavailable";

export interface Observation {
  /** Internal original run minute; never raw tags. */
  runMinute?: string;
  audienceIds?: readonly string[];
  outcomeRunMinute?: string;
  artifactId: string;
  /** The slot tag. */
  tag: string;
  /** An opaque step name: a `<slotTag>#<ordinal>` step id, or a framework node or agent name. */
  step?: string;
  versionId: string;
  arm: string;
  model: string;
  status: "ok" | "error" | "refused";
  errorClass?: ErrorClass | null;
  latencyMs: number;
  tokens?: { input?: number; cachedInput?: number; output?: number };
  usageSource?: UsageSource;
  toolCalls?: { calls: number; errors: number };
  checks?: { passed?: number; failed?: number };
  outcomes?: Record<string, number | boolean>;
}

export interface RunDimensions {
  tag: string;
  artifactId: string;
  versionId: string;
  arm: string;
  model: string;
  audienceIds?: readonly string[];
  runMinute?: string;
}

export interface TokenTotals {
  input: number;
  cachedInput: number;
  output: number;
}

/** One run's totals on one slot. The only thing that adds to `count`. */
export interface RunTotals {
  dimensions: RunDimensions;
  status: "ok" | "error" | "interrupted";
  errorClass: ErrorClass | null;
  usageSource: UsageSource;
  /** 1 when this is the first slot of its run, so an agent-wide total counts a two-slot run once. */
  agentRun: 0 | 1;
  modelCalls: number;
  /** Run wall-clock. */
  latencyMs: number;
  tokens: TokenTotals;
  tools: { calls: number; errors: number };
  checks?: { passed: number; failed: number };
}

/** One step's totals. `latency` holds each model call's latency; its bucket total equals `modelCalls`. */
export interface StepTotals {
  dimensions: RunDimensions;
  step: string;
  status: "ok" | "error";
  errorClass: ErrorClass | null;
  usageSource: UsageSource;
  modelCalls: number;
  latency: { buckets: number[]; sum: number };
  tokens: TokenTotals;
  tools: { calls: number; errors: number };
}

/** The second moments of each run's token totals, summed over runs: three squares and three pairwise products. */
export interface TokenMoments {
  input: number;
  cachedInput: number;
  output: number;
  inputOutput: number;
  inputCached: number;
  cachedOutput: number;
}

/**
 * `count` means runs. Told apart by `count`: a run row (`count` above 0) carries the run totals and `tokensSq`; a
 * feedback-only row (`count: 0` with `outcomeRunMinute`) carries outcomes and every measure zero. Never a step.
 */
export interface WindowRow {
  type: "window";
  v: 4;
  artifactId: string;
  audienceIds?: readonly string[];
  outcomeRunMinute?: string;
  minute: string;
  instanceId: string;
  instanceClass: "resident" | "ephemeral";
  /** Always the slot tag. */
  tag: string;
  versionId: string;
  arm: string;
  model: string;
  status: "ok" | "error" | "refused" | "interrupted";
  errorClass: ErrorClass | null;
  usageSource: UsageSource;
  count: number;
  modelCalls: number;
  agentRun: number;
  tools: { calls: number; errors: number };
  latencyMs: { buckets: number[]; sum: number };
  tokens: { input: number; cachedInput?: number; output: number };
  tokensSq?: TokenMoments;
  checks?: { passed: number; failed: number };
  outcomes?: Record<string, { n: number; sum: number; sumSq: number }>;
  sdk: string;
}

/** A step is its own row type, so no fold over windows can count one. No `count`, moments, outcomes or checks. */
export interface StepRow {
  type: "step";
  v: 1;
  artifactId: string;
  audienceIds?: readonly string[];
  minute: string;
  instanceId: string;
  instanceClass: "resident" | "ephemeral";
  tag: string;
  versionId: string;
  arm: string;
  model: string;
  step: string;
  status: "ok" | "error";
  errorClass: ErrorClass | null;
  usageSource: UsageSource;
  modelCalls: number;
  latencyMs: { buckets: number[]; sum: number };
  tokens: { input: number; cachedInput?: number; output: number };
  tools: { calls: number; errors: number };
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
  /** Lines a reader skipped from a later writer. `segments` then stays 0: a line is not a segment. */
  lines?: number;
  bytes: number;
}

export type SpoolRow = WindowRow | StepRow | RefusalRow | DroppedRow;

export function latencyBucketIndex(latencyMs: number): number {
  const index = LATENCY_BUCKET_EDGES_MS.findIndex((edge) => latencyMs <= edge);
  return index === -1 ? LATENCY_BUCKET_EDGES_MS.length - 1 : index;
}

/** A name the step grammar admits: 1 to 64 characters, no control character. */
export function validStepName(name: unknown): name is string {
  if (typeof name !== "string" || /[\u0000-\u001f\u007f]/u.test(name) || /[\uD800-\uDFFF]/u.test(name)) return false;
  const length = [...name].length;
  return length >= 1 && length <= STEP_BOUNDS.maxLength;
}

/** The name to write: itself, or `other` past either cap. `seen` holds the names already counted against `maxPerRun`. */
export function stepName(name: unknown, seen: Set<string>): string {
  if (!validStepName(name)) return "other";
  if (name === "other" || seen.has(name)) return name;
  if (seen.size >= STEP_BOUNDS.maxPerRun) return "other";
  seen.add(name);
  return name;
}

/** A count a row may carry: a non-negative integer, whatever a caller handed in. */
export function countOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value))) : 0;
}

export function minuteOf(epochMs: number): string {
  const date = new Date(epochMs);
  date.setUTCSeconds(0, 0);
  return date.toISOString().replace(".000Z", "Z");
}

export function epochMinute(epochMs: number): number {
  return Math.floor(epochMs / 60000);
}
