/**
 * Golden sets (T34, 5-D): known inputs with the properties a right answer has,
 * run against the pinned model on the customer's own key before a staged
 * release activates (`protocol/golden-sets.md`).
 *
 * The set is a payload the manifest slot references (`goldenSet.contentHash`),
 * encrypted at rest like the prompt it exercises. Each case is a set of
 * variable values and a list of expectations in the output-check grammar
 * (checks.md), so the same evaluator the runtime already runs inside
 * `observe()` decides a case. The customer supplies the model call
 * (`invoke`); nothing here talks to a provider. Only counts leave the host:
 * `goldenPass` on the arm's window, one per case, and the apply decision.
 *
 * @example
 * ```ts
 * const set = parseGoldenSet(release.payloads.get(slot.goldenSet!.contentHash)!, slot.goldenSet);
 * const report = await runGoldenSet({
 *   slot, arm: "none", text: promptText, set,
 *   invoke: async ({ text, model }) => (await openai.chat.completions.create({ model, messages: [{ role: "user", content: text }] })).choices[0]!.message.content ?? "",
 * });
 * if (!goldenReportsMeet([report])) console.log(`${report.passBps} bps < ${report.minPassBps}: the staged release stays staged`);
 * ```
 */

import { evaluateChecks, estimateTokens } from "../checks/index.js";
import { renderTemplate, type Delimiters } from "../render/template.js";
import type { GoldenSetRef, ManifestSlot, OutputCheck, SlotInference } from "../protocol/types.js";

export const GOLDEN_SET_FORMAT = "airprompter-golden-set";
export const GOLDEN_SET_VERSION = 1;
export const GOLDEN_MAX_CASES = 50;
export const GOLDEN_MAX_EXPECTATIONS = 8;
/** Cases run this many at a time by default; the customer's rate limits are the real bound. */
export const GOLDEN_DEFAULT_CONCURRENCY = 4;

export interface GoldenCase {
  caseId: string;
  variables: Record<string, string>;
  expect: OutputCheck[];
}

export interface GoldenSet {
  format: typeof GOLDEN_SET_FORMAT;
  version: typeof GOLDEN_SET_VERSION;
  setId: string;
  /** Pass-rate floor in basis points; below it a staged release is not activated. */
  minPassBps: number;
  cases: GoldenCase[];
}

export class GoldenSetError extends Error {
  constructor(readonly reason: "not_json" | "not_a_golden_set" | "case_invalid" | "reference_mismatch", message: string) {
    super(message);
    this.name = "GoldenSetError";
  }
}

const CASE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const VARIABLE_NAME = /^[a-zA-Z0-9_.-]{1,64}$/;

/** The payload's bytes as a set: shape only (the checks themselves are validated when evaluated). */
export function parseGoldenSet(bytes: Uint8Array, reference?: Pick<GoldenSetRef, "setId" | "cases">): GoldenSet {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new GoldenSetError("not_json", "golden set payload is not JSON");
  }
  const doc = raw as Partial<GoldenSet>;
  if (!doc || typeof doc !== "object" || doc.format !== GOLDEN_SET_FORMAT || doc.version !== GOLDEN_SET_VERSION || typeof doc.setId !== "string" || !Array.isArray(doc.cases)) {
    throw new GoldenSetError("not_a_golden_set", "golden set payload has the wrong shape");
  }
  if (!Number.isInteger(doc.minPassBps) || (doc.minPassBps as number) < 0 || (doc.minPassBps as number) > 10000) throw new GoldenSetError("not_a_golden_set", "minPassBps is not in 0…10000");
  if (doc.cases.length < 1 || doc.cases.length > GOLDEN_MAX_CASES) throw new GoldenSetError("not_a_golden_set", `a golden set carries 1…${GOLDEN_MAX_CASES} cases`);
  const seen = new Set<string>();
  for (const entry of doc.cases as Array<Partial<GoldenCase>>) {
    if (!entry || typeof entry.caseId !== "string" || !CASE_ID.test(entry.caseId) || seen.has(entry.caseId)) throw new GoldenSetError("case_invalid", "a case id is missing, malformed or repeated");
    seen.add(entry.caseId);
    if (!entry.variables || typeof entry.variables !== "object" || Array.isArray(entry.variables)) throw new GoldenSetError("case_invalid", `${entry.caseId}: variables is not an object`);
    for (const [name, value] of Object.entries(entry.variables)) {
      if (!VARIABLE_NAME.test(name) || typeof value !== "string") throw new GoldenSetError("case_invalid", `${entry.caseId}: variable ${name} is not a named string`);
    }
    if (!Array.isArray(entry.expect) || entry.expect.length < 1 || entry.expect.length > GOLDEN_MAX_EXPECTATIONS) throw new GoldenSetError("case_invalid", `${entry.caseId}: 1…${GOLDEN_MAX_EXPECTATIONS} expectations`);
    const names = new Set<string>();
    for (const check of entry.expect as Array<Partial<OutputCheck>>) {
      if (!check || typeof check.name !== "string" || typeof check.kind !== "string" || names.has(check.name)) throw new GoldenSetError("case_invalid", `${entry.caseId}: an expectation is missing its kind or name, or repeats a name`);
      names.add(check.name);
    }
  }
  if (reference && (reference.setId !== doc.setId || reference.cases !== doc.cases.length)) {
    throw new GoldenSetError("reference_mismatch", `the manifest names ${reference.setId} with ${reference.cases} cases; the payload is ${doc.setId} with ${doc.cases.length}`);
  }
  return doc as GoldenSet;
}

/** What the customer's model call receives: the rendered prompt and the facts around it. Never stored by the SDK. */
export interface GoldenInvocation {
  tag: string;
  caseId: string;
  /** The slot's text rendered with the case's variables — the prompt the pinned model is asked. */
  text: string;
  model: string;
  arm: string;
  variables: Readonly<Record<string, string>>;
  /** 0.3.1: the slot's inference settings — the call is made as production makes it, or the gate measures something else. */
  inference?: SlotInference;
}

/** The customer's model call: the output text, optionally with the provider's output token count (a length band uses it). */
export type GoldenInvoke = (input: GoldenInvocation) => Promise<string | { text: string; outputTokens?: number | null }>;

export interface GoldenCaseResult {
  caseId: string;
  ok: boolean;
  /** The expectations that failed, by name — never the output. */
  failed: string[];
  /** Set when the case could not be rendered or the model call threw; counted as a failure. */
  error?: string;
}

export interface GoldenReport {
  tag: string;
  arm: string;
  setId: string;
  model: string;
  cases: number;
  passed: number;
  failed: number;
  /** floor(passed / cases × 10000). */
  passBps: number;
  minPassBps: number;
  /** passBps ≥ minPassBps. */
  meetsThreshold: boolean;
  results: GoldenCaseResult[];
}

export function passBpsOf(passed: number, cases: number): number {
  return cases > 0 ? Math.floor((passed * 10000) / cases) : 0;
}

/**
 * Run every case: render the slot's text with the case's variables (the same fencing as `prompt().render()`), ask the
 * customer's model, evaluate the case's expectations on the answer. A case whose render or call throws counts as failed
 * with the error's message (a class of failure, not the output). Cases run `concurrency` at a time in order.
 */
export async function runGoldenSet(input: {
  slot: Pick<ManifestSlot, "tag" | "model" | "variables" | "inference">;
  arm: string;
  text: string;
  set: GoldenSet;
  invoke: GoldenInvoke;
  concurrency?: number;
  delimiters?: Delimiters;
  /** Called per case as it completes (progress on the CLI); never with the output. */
  onCase?: (result: GoldenCaseResult) => void;
}): Promise<GoldenReport> {
  const results: GoldenCaseResult[] = new Array<GoldenCaseResult>(input.set.cases.length);
  const width = Math.max(1, Math.min(input.concurrency ?? GOLDEN_DEFAULT_CONCURRENCY, input.set.cases.length));
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= input.set.cases.length) return;
      const entry = input.set.cases[index]!;
      let result: GoldenCaseResult;
      try {
        const text = renderTemplate({ tag: input.slot.tag, text: input.text, variables: input.slot.variables, values: entry.variables, ...(input.delimiters ? { delimiters: input.delimiters } : {}) });
        const answer = await input.invoke({ tag: input.slot.tag, caseId: entry.caseId, text, model: input.slot.model, arm: input.arm, variables: entry.variables, ...(input.slot.inference ? { inference: input.slot.inference } : {}) });
        const output = typeof answer === "string" ? { text: answer, outputTokens: null } : { text: answer.text, outputTokens: answer.outputTokens ?? null };
        const outcome = evaluateChecks(entry.expect, { text: output.text, outputTokens: output.outputTokens ?? estimateTokens(output.text) });
        const failed = outcome.results.filter((r) => r.verdict === "fail").map((r) => r.name);
        result = { caseId: entry.caseId, ok: failed.length === 0, failed };
      } catch (error) {
        result = { caseId: entry.caseId, ok: false, failed: [], error: (error as Error).name ?? "error" };
      }
      results[index] = result;
      input.onCase?.(result);
    }
  };
  await Promise.all(Array.from({ length: width }, () => worker()));
  const passed = results.filter((r) => r.ok).length;
  const passBps = passBpsOf(passed, results.length);
  return {
    tag: input.slot.tag,
    arm: input.arm,
    setId: input.set.setId,
    model: input.slot.model,
    cases: results.length,
    passed,
    failed: results.length - passed,
    passBps,
    minPassBps: input.set.minPassBps,
    meetsThreshold: passBps >= input.set.minPassBps,
    results,
  };
}

/** The runtime's decision over every report of a staged release: all thresholds met. An empty list (no golden sets) meets. */
export function goldenReportsMeet(reports: readonly GoldenReport[]): boolean {
  return reports.every((report) => report.meetsThreshold);
}
