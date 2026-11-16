/**
 * Usage for a run rendered in ANOTHER invocation: the one place token counts and the error class are attached to a
 * `runRef`. The model ran on the platform (its own AI step), so the run is reported afterwards from what the step
 * saw — never prompt text or output, only counts and a class.
 *
 * >>> SWITCH POINT: the SDK is getting `ap.reportRun(runRef, { inputTokens, outputTokens, error, latencyMs, … })`
 * >>> for exactly this (airprompter-agent-sdk#92, not merged when this was written). `attachUsage` calls it when the
 * >>> installed SDK has it (a feature check) and otherwise falls back to reading the run's facts back from the signed
 * >>> `runRef` (`ap.explain`) and filing one observation per slot entry through `ap.report`. Once #92 ships in the
 * >>> version this package depends on, delete the fallback; nothing else in this package sends usage. Either way it is
 * >>> the run's ONLY count: Get prompt renders outside any `ap.run`, so a render writes no run row.
 *
 * @example
 * ```ts
 * const filed = attachUsage(ap, runRef, { inputTokens: 812, outputTokens: 96, error: "upstream timed out" });
 * // filed === 0 → the runRef does not verify under this connection
 * ```
 */

import type { AirPrompterAgent } from "@airprompter/agent-sdk";
import type { ErrorClass } from "@airprompter/agent-sdk/core";

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

const count = (value: number | undefined): number | undefined => (value === undefined || !Number.isFinite(value) || value < 0 ? undefined : Math.round(value));

type ReportRun = (runRef: string, usage: { inputTokens?: number; outputTokens?: number; error?: string; latencyMs?: number }) => boolean;

/** Returns how many slot entries the usage was filed on (0: the runRef does not verify here, or the SDK refused it). */
export function attachUsage(ap: AirPrompterAgent, runRef: string, usage: UsageInput): number {
  const reportRun = (ap as unknown as { reportRun?: ReportRun }).reportRun;
  if (typeof reportRun === "function") {
    const given = {
      ...(count(usage.inputTokens) !== undefined ? { inputTokens: count(usage.inputTokens)! } : {}),
      ...(count(usage.outputTokens) !== undefined ? { outputTokens: count(usage.outputTokens)! } : {}),
      ...(usage.error ? { error: errorClassOf(usage.error) } : {}),
      ...(count(usage.latencyMs) !== undefined ? { latencyMs: count(usage.latencyMs)! } : {}),
    };
    return reportRun.call(ap, runRef, given) ? (ap.explain(runRef)?.length ?? 1) : 0;
  }
  const entries = ap.explain(runRef);
  if (!entries) return 0;
  const input = count(usage.inputTokens);
  const output = count(usage.outputTokens);
  const tokens = input !== undefined || output !== undefined ? { ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}) } : undefined;
  for (const entry of entries) {
    ap.report({
      tag: entry.tag,
      artifactId: entry.artifactId,
      versionId: entry.versionId,
      arm: entry.arm,
      model: entry.model,
      runMinute: entry.runMinute,
      ...(entry.audienceIds ? { audienceIds: entry.audienceIds } : {}),
      status: usage.error ? "error" : "ok",
      ...(usage.error ? { errorClass: errorClassOf(usage.error) } : {}),
      // The platform's step time when it was given; 0 otherwise (the run and its tokens still count).
      latencyMs: count(usage.latencyMs) ?? 0,
      ...(tokens ? { tokens } : {}),
      usageSource: tokens ? "reported" : "unavailable",
    });
  }
  return entries.length;
}
