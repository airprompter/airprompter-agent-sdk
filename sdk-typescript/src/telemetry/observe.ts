/**
 * `ap.observe(rendered, () => llm.call(...))` (T11, D52/D66): time the
 * model call, read `usage` off whatever the provider answered — OpenAI,
 * Anthropic Messages, Bedrock Converse / InvokeModel — and classify a
 * failure into the protocol's closed `errorClass` set. The observation is a
 * content-free window increment: no text, no ids, no error message.
 *
 * Usage shapes recognised (all optional, first match wins per field):
 *   OpenAI       usage.prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens
 *   Anthropic    usage.input_tokens / output_tokens / cache_read_input_tokens
 *   Bedrock      usage.inputTokens / outputTokens / cacheReadInputTokens (Converse);
 *                InvokeModel with an Anthropic body reads as Anthropic
 * Truncation     choices[0].finish_reason === "length" | stop_reason === "max_tokens" | stopReason === "max_tokens"
 * Content filter choices[0].finish_reason === "content_filter" | stopReason === "content_filtered"
 *
 * A result with no usage is reported as `usageSource: "unavailable"` with
 * zero tokens — the window still counts the run and its latency.
 */

import type { ErrorClass, Observation } from "../spool/writer.js";

export type UsageNormalized = { input: number; cachedInput: number; output: number; source: "reported" | "unavailable" };

const int = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);
const obj = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null);

/** Provider token counts, or "unavailable". Never throws on an unexpected shape. */
export function normalizeUsage(result: unknown): UsageNormalized {
  const root = obj(result);
  const usage = obj(root?.usage) ?? obj(obj(root?.response)?.usage) ?? obj(obj(root?.output)?.usage);
  if (!usage) return { input: 0, cachedInput: 0, output: 0, source: "unavailable" };
  const openaiCached = int(obj(usage.prompt_tokens_details)?.cached_tokens);
  const input = int(usage.prompt_tokens) ?? int(usage.input_tokens) ?? int(usage.inputTokens);
  const output = int(usage.completion_tokens) ?? int(usage.output_tokens) ?? int(usage.outputTokens);
  const cachedInput = openaiCached ?? int(usage.cache_read_input_tokens) ?? int(usage.cacheReadInputTokens) ?? 0;
  if (input === null && output === null) return { input: 0, cachedInput: 0, output: 0, source: "unavailable" };
  // OpenAI counts cached tokens inside prompt_tokens; Anthropic and Bedrock count them beside input. Windows carry
  // input as the UNCACHED count plus cachedInput, so the OpenAI shape is split here.
  const uncachedInput = openaiCached !== null && input !== null ? Math.max(0, input - openaiCached) : (input ?? 0);
  return { input: uncachedInput, cachedInput, output: output ?? 0, source: "reported" };
}

/** A completed call that still counts as an error class: truncation and content filtering. */
export function classifyResult(result: unknown): ErrorClass | null {
  const root = obj(result);
  if (!root) return null;
  const choice = obj(Array.isArray(root.choices) ? root.choices[0] : null);
  const finish = String(choice?.finish_reason ?? root.stop_reason ?? root.stopReason ?? "");
  if (finish === "length" || finish === "max_tokens") return "truncated";
  if (finish === "content_filter" || finish === "content_filtered" || finish === "guardrail_intervened") return "content_filter";
  return null;
}

/** A thrown failure into the closed set; anything unrecognised is `provider_error`. Reads codes and statuses, never messages' free text into the window. */
export function classifyError(error: unknown): ErrorClass {
  const e = obj(error);
  const name = String(e?.name ?? "");
  const code = String(e?.code ?? e?.type ?? obj(e?.error)?.code ?? obj(e?.error)?.type ?? "");
  const status = int(e?.status) ?? int(e?.statusCode) ?? int(obj(e?.$metadata)?.httpStatusCode) ?? int(obj(e?.response)?.status);
  const message = String(e?.message ?? "").toLowerCase();
  if (name === "AbortError" || name === "TimeoutError" || code === "ETIMEDOUT" || code === "ECONNABORTED" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "timeout" || status === 408 || status === 504 || /timed? ?out/.test(message)) return "provider_timeout";
  if (status === 429 || code === "rate_limit_exceeded" || code === "rate_limit_error" || name === "ThrottlingException" || code === "ThrottlingException" || code === "insufficient_quota") return "provider_rate_limited";
  if (code === "context_length_exceeded" || /context (length|window)|too many tokens|prompt is too long|input is too long|maximum context/.test(message)) return "context_length_exceeded";
  if (code === "content_filter" || code === "content_policy_violation" || /content (filter|policy)|guardrail/.test(message)) return "content_filter";
  if (name === "MissingVariableError" || code === "render_missing_variable") return "render_missing_variable";
  if (code === "output_schema_invalid" || name === "OutputSchemaError") return "output_schema_invalid";
  return "provider_error";
}

export interface ObserveTarget {
  tag: string;
  versionId: string;
  arm: string;
  model: string;
}

export interface ObserveOptions {
  /** Output checks already run (T29): counted on the same window. */
  checks?: { passed?: number; failed?: number };
  /** Override the model the window names (a router that picked another model than the slot's). */
  model?: string;
}

/**
 * Time `call`, then hand one observation to `record`. The result is returned
 * unchanged; a thrown error is re-thrown after it is observed. Nothing about
 * the result but its usage and finish reason is read.
 */
export async function observeCall<T>(target: ObserveTarget, call: () => Promise<T> | T, record: (observation: Observation) => void, options: ObserveOptions & { now?: () => number } = {}): Promise<T> {
  const now = options.now ?? (() => Date.now());
  const started = now();
  const model = options.model ?? target.model;
  try {
    const result = await call();
    const usage = normalizeUsage(result);
    const errorClass = classifyResult(result);
    record({
      tag: target.tag,
      versionId: target.versionId,
      arm: target.arm,
      model,
      status: errorClass ? "error" : "ok",
      errorClass,
      latencyMs: Math.max(0, now() - started),
      tokens: { input: usage.input, cachedInput: usage.cachedInput, output: usage.output },
      usageSource: usage.source,
      ...(options.checks ? { checks: options.checks } : {}),
    });
    return result;
  } catch (error) {
    record({
      tag: target.tag,
      versionId: target.versionId,
      arm: target.arm,
      model,
      status: "error",
      errorClass: classifyError(error),
      latencyMs: Math.max(0, now() - started),
      usageSource: "unavailable",
      ...(options.checks ? { checks: options.checks } : {}),
    });
    throw error;
  }
}
