/**
 * The spool → OTLP mapping (S13), pure: a segment's validated rows become
 * one OTLP/HTTP JSON `ExportMetricsServiceRequest` — the resource from the
 * writer (instance, class, SDK) plus what the customer adds (`service.name`),
 * one scope, and the metrics the windows carry:
 *
 *   gen_ai.client.operation.duration   histogram (s), the spool's fixed buckets, last bucket = overflow
 *   airprompter.tokens                 sum {token} by gen_ai.token.type: input | cached_input | output
 *   airprompter.checks                 sum {check} by airprompter.check.outcome: passed | failed
 *   airprompter.feedback.count / .sum  sum by airprompter.feedback.signal (a rate is sum / count)
 *   airprompter.refusals               sum {refusal} by reason and generation
 *   airprompter.spool.dropped_segments / .dropped_bytes   the loss a budget caused, reported
 *
 * Sums are delta and monotonic (feedback.sum is not monotonic); a window's
 * points span its minute. Nothing here can carry prompt text, output or an
 * end-user identifier — the rows have no field for them, and the attribute
 * keys are a closed set the conformance runner pins.
 * `protocol/vectors/otel-mapping.json` is the vector every bridge must match.
 */

import { LATENCY_BUCKET_EDGES_MS, type SpoolRow, type WindowRow } from "@airprompter/agent-core";

export const OTLP_SCOPE_NAME = "airprompter";
const DELTA = 1;

export type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
export interface OtlpAttribute {
  key: string;
  value: OtlpValue;
}
export interface OtlpNumberPoint {
  attributes: OtlpAttribute[];
  startTimeUnixNano: string;
  timeUnixNano: string;
  asInt?: string;
  asDouble?: number;
}
export interface OtlpHistogramPoint {
  attributes: OtlpAttribute[];
  startTimeUnixNano: string;
  timeUnixNano: string;
  count: string;
  sum: number;
  bucketCounts: string[];
  explicitBounds: number[];
}
export type OtlpMetric =
  | { name: string; description: string; unit: string; histogram: { aggregationTemporality: number; dataPoints: OtlpHistogramPoint[] } }
  | { name: string; description: string; unit: string; sum: { aggregationTemporality: number; isMonotonic: boolean; dataPoints: OtlpNumberPoint[] } };
export interface ExportMetricsServiceRequest {
  resourceMetrics: Array<{ resource: { attributes: OtlpAttribute[] }; scopeMetrics: Array<{ scope: { name: string; version: string }; metrics: OtlpMetric[] }> }>;
}

export interface MappingOptions {
  /** Resource attributes the customer adds (`service.name`, `deployment.environment`); sorted by key in the request. */
  resource?: Record<string, string | number | boolean>;
  /** The scope version: the bridge's own. */
  sdkVersion?: string;
}

export function otlpAttribute(key: string, value: string | number | boolean): OtlpAttribute {
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") return Number.isInteger(value) ? { key, value: { intValue: String(value) } } : { key, value: { doubleValue: value } };
  return { key, value: { stringValue: String(value) } };
}

const nanos = (iso: string): string => `${Math.floor(Date.parse(iso) / 1000)}000000000`;
const minuteEnd = (start: string): string => String(BigInt(start) + 60_000_000_000n);

function windowAttributes(row: WindowRow): OtlpAttribute[] {
  const attrs = [
    otlpAttribute("gen_ai.request.model", row.model),
    otlpAttribute("airprompter.prompt.tag", row.tag),
    otlpAttribute("airprompter.prompt.version", row.versionId),
    otlpAttribute("airprompter.prompt.arm", row.arm),
    otlpAttribute("airprompter.status", row.status),
    otlpAttribute("airprompter.usage.source", row.usageSource),
  ];
  if (row.errorClass) attrs.push(otlpAttribute("error.type", row.errorClass));
  return attrs;
}

const point = (value: number, attributes: OtlpAttribute[], start: string, end: string): OtlpNumberPoint => ({ attributes, startTimeUnixNano: start, timeUnixNano: end, asInt: String(Math.trunc(value)) });
const sumMetric = (name: string, unit: string, dataPoints: OtlpNumberPoint[], description: string, isMonotonic = true): OtlpMetric => ({ name, description, unit, sum: { aggregationTemporality: DELTA, isMonotonic, dataPoints } });

/** A segment's rows as one OTLP/HTTP JSON request. Empty rows give a request with no metrics. */
export function spoolRowsToOtlp(rows: readonly SpoolRow[], options: MappingOptions = {}): ExportMetricsServiceRequest {
  const first = rows[0];
  const [sdkName, sdkVersion] = String((first as { sdk?: string } | undefined)?.sdk ?? "").split("/");
  const resource: OtlpAttribute[] = first ? [otlpAttribute("service.instance.id", first.instanceId)] : [];
  if (first && "instanceClass" in first && first.instanceClass) resource.push(otlpAttribute("airprompter.instance.class", first.instanceClass));
  if (sdkName) resource.push(otlpAttribute("telemetry.sdk.name", sdkName));
  if (sdkVersion) resource.push(otlpAttribute("telemetry.sdk.version", sdkVersion));
  for (const key of Object.keys(options.resource ?? {}).sort()) resource.push(otlpAttribute(key, options.resource![key]!));
  const duration: OtlpHistogramPoint[] = [];
  const tokens: OtlpNumberPoint[] = [];
  const checks: OtlpNumberPoint[] = [];
  const feedbackCount: OtlpNumberPoint[] = [];
  const feedbackSum: OtlpNumberPoint[] = [];
  const refusals: OtlpNumberPoint[] = [];
  const droppedSegments: OtlpNumberPoint[] = [];
  const droppedBytes: OtlpNumberPoint[] = [];
  for (const row of rows) {
    if (row.type === "window") {
      const start = nanos(row.minute);
      const end = minuteEnd(start);
      const attrs = windowAttributes(row);
      duration.push({ attributes: attrs, startTimeUnixNano: start, timeUnixNano: end, count: String(row.count), sum: row.latencyMs.sum / 1000, bucketCounts: row.latencyMs.buckets.map(String), explicitBounds: LATENCY_BUCKET_EDGES_MS.slice(0, -1).map((edge) => edge / 1000) });
      for (const [kind, value] of [["input", row.tokens.input ?? 0], ["cached_input", row.tokens.cachedInput ?? 0], ["output", row.tokens.output ?? 0]] as const) tokens.push(point(value, [...attrs, otlpAttribute("gen_ai.token.type", kind)], start, end));
      if (row.checks) for (const outcome of ["passed", "failed"] as const) checks.push(point(row.checks[outcome], [...attrs, otlpAttribute("airprompter.check.outcome", outcome)], start, end));
      for (const signal of Object.keys(row.outcomes ?? {}).sort()) {
        const stat = row.outcomes![signal]!;
        feedbackCount.push(point(stat.n, [...attrs, otlpAttribute("airprompter.feedback.signal", signal)], start, end));
        feedbackSum.push({ attributes: [...attrs, otlpAttribute("airprompter.feedback.signal", signal)], startTimeUnixNano: start, timeUnixNano: end, asDouble: Number(stat.sum) });
      }
    } else if (row.type === "refusal") {
      const at = nanos(row.at);
      const attrs = [otlpAttribute("airprompter.refusal.reason", row.reason), otlpAttribute("airprompter.generation", row.generation)];
      if (row.tag) attrs.push(otlpAttribute("airprompter.prompt.tag", row.tag));
      refusals.push(point(1, attrs, at, at));
    } else if (row.type === "dropped") {
      const at = nanos(row.at);
      droppedSegments.push(point(row.segments, [], at, at));
      droppedBytes.push(point(row.bytes, [], at, at));
    }
  }
  const metrics: OtlpMetric[] = [];
  if (duration.length) metrics.push({ name: "gen_ai.client.operation.duration", description: "Model call duration per prompt, version, arm and model; the spool's minute window as a delta histogram.", unit: "s", histogram: { aggregationTemporality: DELTA, dataPoints: duration } });
  if (tokens.length) metrics.push(sumMetric("airprompter.tokens", "{token}", tokens, "Tokens per window by gen_ai.token.type (input, cached_input, output)."));
  if (checks.length) metrics.push(sumMetric("airprompter.checks", "{check}", checks, "Declared output checks per window by outcome."));
  if (feedbackCount.length) {
    metrics.push(sumMetric("airprompter.feedback.count", "{signal}", feedbackCount, "Feedback signals recorded per window."));
    metrics.push(sumMetric("airprompter.feedback.sum", "1", feedbackSum, "The sum of a feedback signal's values per window (a rate is sum / count).", false));
  }
  if (refusals.length) metrics.push(sumMetric("airprompter.refusals", "{refusal}", refusals, "Renders refused, by reason and generation."));
  if (droppedSegments.length) {
    metrics.push(sumMetric("airprompter.spool.dropped_segments", "{segment}", droppedSegments, "Spool segments evicted by a budget: the loss, reported."));
    metrics.push(sumMetric("airprompter.spool.dropped_bytes", "By", droppedBytes, "Bytes evicted by a budget."));
  }
  return { resourceMetrics: [{ resource: { attributes: resource }, scopeMetrics: [{ scope: { name: OTLP_SCOPE_NAME, version: options.sdkVersion ?? "0.1.0" }, metrics }] }] };
}
