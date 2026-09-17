/**
 * @fileoverview Filling a render's variables: the call site first, then the application's sources, then nothing.
 *
 * Pure functions over a slot's declarations, the text about to be rendered, the values the call site passed and
 * the registry of sources. The precedence is fixed and visible: a call-site value always wins (the caller knows
 * more than a source); a source is consulted only for a declared variable the render actually needs — required,
 * or present in the text — and only when the call site did not pass it; what is still missing is the render's
 * problem, and `renderTemplate` says so loudly. Trust comes out stricter than it went in: the effective declaration
 * a render uses is the prompt's, tightened to `end_user` wherever the source that filled it said so.
 *
 * @example
 * ```ts
 * const plan = planFill({ tag, variables: slot.variables, text, values, registry });
 * // plan.literal  — names a literal fills (synchronous)
 * // plan.async    — names a callable source must fill (renderAsync)
 * // plan.missing  — required names nobody fills: the render will throw MissingVariableError
 * const filled = await fillAsync(plan, { tag, subject, versionId, arm }, registry);
 * renderTemplate({ tag, text, variables: filled.variables, values: filled.values });
 * ```
 */

import { placeholdersOf, type SlotVariable } from "@airprompter/agent-core";
import { VariableSourceError, VariableSourceRequiredError, isVariableSourceError, type VariableSourceContext, type VariableSourceRegistry } from "./sources.js";

export type RenderValues = Readonly<Record<string, string | number | boolean | null | undefined>>;

/** What a render needs from where — decided before anything is looked up. */
export interface FillPlan {
  tag: string;
  variables: readonly SlotVariable[];
  values: RenderValues;
  /** Declared variables the call site left unfilled that a literal supplies. */
  literal: string[];
  /** Declared variables the call site left unfilled that a callable source must supply. */
  async: string[];
  /** Required variables nobody supplies; `renderTemplate` will refuse the render. */
  missing: string[];
}

export interface FilledRender {
  /** The call site's values plus every filled one; a literal or a source never overrides a caller. */
  values: RenderValues;
  /** The slot's declarations, tightened to `end_user` where the filling source said so. */
  variables: readonly SlotVariable[];
  /** Variables a source filled and, for each, whether the source's trust was stricter than the prompt's. */
  filled: Array<{ name: string; from: "literal" | "source"; stricter: boolean }>;
}

const supplied = (values: RenderValues, name: string): boolean => values[name] !== undefined && values[name] !== null;

/**
 * Which declared variables a render must fill from a source: required ones, and any the text uses — never one the
 * current version dropped (a source is not called for a variable no longer in the prompt). `text` is null in
 * managed mode, where only the declarations are known; then the required ones are the whole set.
 */
export function planFill(input: { tag: string; variables: readonly SlotVariable[]; text: string | null; values: RenderValues; registry: VariableSourceRegistry }): FillPlan {
  const used = input.text === null ? null : placeholdersOf(input.text);
  const literal: string[] = [];
  const async: string[] = [];
  const missing: string[] = [];
  for (const variable of input.variables) {
    if (supplied(input.values, variable.name)) continue;
    const needed = variable.required || (used !== null && used.has(variable.name));
    if (!needed) continue;
    const entry = input.registry.get(variable.name);
    if (!entry) {
      if (variable.required) missing.push(variable.name);
      continue;
    }
    (entry.kind === "literal" ? literal : async).push(variable.name);
  }
  return { tag: input.tag, variables: input.variables, values: input.values, literal, async, missing };
}

/** The effective declarations: the prompt's, with `end_user` wherever the filling source is stricter. */
function tighten(variables: readonly SlotVariable[], stricterNames: ReadonlySet<string>): readonly SlotVariable[] {
  if (stricterNames.size === 0) return variables;
  return variables.map((variable) => (stricterNames.has(variable.name) && variable.trust !== "end_user" ? { ...variable, trust: "end_user" as const } : variable));
}

/** Literals only — the synchronous path. A plan with callable sources refuses here; that is what `renderAsync` is for. */
export function fillSync(plan: FillPlan, registry: VariableSourceRegistry): FilledRender {
  if (plan.async.length > 0) throw new VariableSourceRequiredError(plan.tag, plan.async);
  const values: Record<string, RenderValues[string]> = { ...plan.values };
  const filled: FilledRender["filled"] = [];
  for (const name of plan.literal) {
    const entry = registry.get(name);
    if (entry?.kind !== "literal") continue; // revoked between plan and fill: the render decides (missing or optional)
    values[name] = entry.value;
    filled.push({ name, from: "literal", stricter: false });
  }
  return { values, variables: plan.variables, filled };
}

/** Literals and callable sources — every source runs concurrently, each under its own timeout and byte bound. */
export async function fillAsync(plan: FillPlan, context: Omit<VariableSourceContext, "name">, registry: VariableSourceRegistry): Promise<FilledRender> {
  const base = fillSync({ ...plan, async: [] }, registry);
  const values: Record<string, RenderValues[string]> = { ...base.values };
  const filled = [...base.filled];
  const stricter = new Set<string>();
  const byName = new Map(plan.variables.map((variable) => [variable.name, variable]));
  const results = await Promise.all(
    plan.async.map(async (name) => {
      const entry = registry.get(name);
      if (entry?.kind !== "source") return { name, value: undefined as string | undefined };
      const value = await resolveOne(plan.tag, name, entry, { ...context, name });
      return { name, value, trust: entry.trust };
    }),
  );
  for (const result of results) {
    const variable = byName.get(result.name);
    if (result.value === undefined) {
      if (variable?.required) throw new VariableSourceError(plan.tag, result.name, "empty");
      continue; // optional and unanswered: the render leaves it empty, as a call site would have
    }
    values[result.name] = result.value;
    const isStricter = result.trust === "end_user" && variable?.trust !== "end_user";
    if (isStricter) stricter.add(result.name);
    filled.push({ name: result.name, from: "source", stricter: isStricter });
  }
  return { values, variables: tighten(plan.variables, stricter), filled };
}

/** One lookup: bounded in time and size; a throw, a timeout or an oversize answer is the render's failure, named. */
async function resolveOne(tag: string, name: string, entry: Extract<ReturnType<VariableSourceRegistry["get"]>, { kind: "source" }>, context: VariableSourceContext): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new VariableSourceError(tag, name, "timeout")), entry.timeoutMs);
  });
  try {
    const value = await Promise.race([entry.source.resolve(context), timeout]);
    if (value === undefined || value === null) return undefined;
    const text = String(value);
    if (Buffer.byteLength(text, "utf8") > entry.maxBytes) throw new VariableSourceError(tag, name, "too_large");
    return text;
  } catch (error) {
    if (isVariableSourceError(error)) throw error;
    throw new VariableSourceError(tag, name, "threw", error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The names a render would still have to fill after the call site's values and the registered sources — what an
 * application checks at start-up so an uncoverable version fails there, not on the first customer request.
 */
export function uncovered(input: { variables: readonly SlotVariable[]; text: string | null; values: RenderValues; registry: VariableSourceRegistry }): string[] {
  return planFill({ tag: "", ...input }).missing;
}
