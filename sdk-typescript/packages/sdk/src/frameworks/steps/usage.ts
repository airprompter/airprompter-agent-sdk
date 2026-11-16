/**
 * Usage for a run rendered in ANOTHER invocation, in the shape `ap.reportRun` takes. The model ran on the platform (its
 * own AI step), so the run is reported afterwards from what the step saw — never prompt text or output, only counts
 * and an error class. `ap.reportRun` is the run's ONLY count: Get prompt renders outside any `ap.run`, so a render
 * writes no run row.
 *
 * @example
 * ```ts
 * const report = runReportOf({ inputTokens: 812.4, outputTokens: 96, error: "upstream timed out" });
 * // { inputTokens: 812, outputTokens: 96, error: "provider_timeout" }
 * const counted = ap.reportRun(runRef, report); // false → the runRef does not verify under this connection
 * ```
 */

import type { ErrorClass } from "../../core/index.js";
import type { RunReport } from "../../index.js";

export interface UsageInput {
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
  latencyMs?: number;
}

/** A platform's error text reduced to the protocol's closed set of classes; the text itself never leaves. */
export function errorClassOf(error: string): ErrorClass {
  const text = error.toLowerCase();
  if (/rate.?limit|429|too many requests|quota/.test(text)) return "provider_rate_limited";
  if (/time.?out|timed out|deadline/.test(text)) return "provider_timeout";
  if (/context.?length|too long|maximum context|token limit/.test(text)) return "context_length_exceeded";
  if (/content.?filter|safety|blocked|policy/.test(text)) return "content_filter";
  if (/truncat|max.?tokens|length limit/.test(text)) return "truncated";
  return "provider_error";
}

// A platform field can carry a fraction or a negative by mistake: a bad count is left out, not sent and refused.
const count = (value: number | undefined): number | undefined => (value === undefined || !Number.isFinite(value) || value < 0 ? undefined : Math.round(value));

/** What a platform step saw, as `ap.reportRun` takes it: whole counts only, the error as its class. */
export function runReportOf(usage: UsageInput): RunReport {
  const inputTokens = count(usage.inputTokens);
  const outputTokens = count(usage.outputTokens);
  const latencyMs = count(usage.latencyMs);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(usage.error ? { error: errorClassOf(usage.error) } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
  };
}
