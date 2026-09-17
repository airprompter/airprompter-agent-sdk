/**
 * @fileoverview Filling a render's variables: the call site first, then the application's sources, then nothing.
 *
 * Pure functions over a slot's declarations, the text about to be rendered, the values the call site passed and
 * the registry of sources. The precedence is fixed and visible: a call-site value always wins (the caller knows
 * more than a source); a source is consulted only for a declared variable the render actually needs — required,
 * or present in the text — and only when the call site did not pass it; what is still missing is the render's
 * problem, and `renderTemplate` says so loudly. Trust comes out stricter than it went in: a value a source of
 * `end_user` trust filled is named in `fenced`, and the resolver renders it fenced whatever the prompt declared.
 *
 * @example
 * ```ts
 * const plan = planFill({ tag, variables: slot.variables, text, values, registry });
 * // plan.literal  — names a literal fills (synchronous)
 * // plan.async    — names a callable source must fill (renderAsync)
 * // plan.missing  — required names nobody fills: the render will throw MissingVariableError
 * const filled = await fillAsync(plan, { tag, subject, versionId, arm }, registry);
 * resolver.render(resolved, filled.values, { fenced: filled.fenced, text });
 * ```
 */

import { placeholdersOf, type SlotVariable } from "@airprompter/agent-core";
import { VariableSourceError, VariableSourceRequiredError, isVariableSourceError, type RegisteredSource, type VariableSourceContext, type VariableSourceRegistry } from "./sources.js";

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
  /** Names whose value came from an `end_user` source though the prompt declared `operator`: the resolver fences them. */
  fenced: ReadonlySet<string>;
  /** Variables a source filled and, for each, whether the source's trust was stricter than the prompt's. */
  filled: Array<{ name: string; from: "literal" | "source"; stricter: boolean }>;
}

/** A value the call site did pass: `undefined` and `null` are "not passed", everything else is a value. */
export const supplied = (values: RenderValues, name: string): boolean => values[name] !== undefined && values[name] !== null;

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

/**
 * The declared variables whose registered source is stricter than the declaration (`end_user` over `operator`).
 * Decidable before any lookup — a hosted run, which cannot fence, refuses these at plan time instead of after
 * calling the customer's system.
 */
export function stricterSources(variables: readonly SlotVariable[], registry: VariableSourceRegistry): string[] {
  return variables.filter((variable) => variable.trust !== "end_user" && registry.get(variable.name)?.trust === "end_user").map((variable) => variable.name);
}

/**
 * Literals only — the synchronous path. A plan with callable sources refuses here; that is what `renderAsync` is
 * for. The registry is re-read at fill time: a source registered since the plan is refused the same way, so a
 * revoke-and-provide between the two never turns into a quiet MissingVariableError.
 */
export function fillSync(plan: FillPlan, registry: VariableSourceRegistry): FilledRender {
  const values: Record<string, RenderValues[string]> = { ...plan.values };
  const filled: FilledRender["filled"] = [];
  const nowAsync = [...plan.async];
  for (const name of plan.literal) {
    const entry = registry.get(name);
    if (entry?.kind === "source") nowAsync.push(name);
    if (entry?.kind !== "literal") continue; // revoked between plan and fill: the render decides (missing or optional)
    values[name] = entry.value;
    filled.push({ name, from: "literal", stricter: false });
  }
  if (nowAsync.length > 0) throw new VariableSourceRequiredError(plan.tag, nowAsync);
  return { values, fenced: new Set(), filled };
}

/** Literals and callable sources — every source runs concurrently, each under its own timeout and byte bound. */
export async function fillAsync(plan: FillPlan, context: Omit<VariableSourceContext, "name">, registry: VariableSourceRegistry): Promise<FilledRender> {
  const values: Record<string, RenderValues[string]> = { ...plan.values };
  const filled: FilledRender["filled"] = [];
  const fenced = new Set<string>();
  const byName = new Map(plan.variables.map((variable) => [variable.name, variable]));
  // Everything the plan named, re-read now: a literal that became a source is looked up; a source that became a
  // literal is used as one; anything revoked is left to the render.
  const results = await Promise.all(
    [...plan.literal, ...plan.async].map(async (name) => {
      const entry = registry.get(name);
      if (!entry) return { name, value: undefined as string | undefined, from: "source" as const, trust: "operator" as const };
      if (entry.kind === "literal") return { name, value: entry.value, from: "literal" as const, trust: entry.trust };
      return { name, value: await resolveOne(plan.tag, name, entry, { ...context, name }), from: "source" as const, trust: entry.trust };
    }),
  );
  for (const result of results) {
    const variable = byName.get(result.name);
    if (result.value === undefined) {
      if (variable?.required) throw new VariableSourceError(plan.tag, result.name, "empty");
      continue; // optional and unanswered: the render leaves it empty, as a call site would have
    }
    values[result.name] = result.value;
    const stricter = result.trust === "end_user" && variable?.trust !== "end_user";
    if (stricter) fenced.add(result.name);
    filled.push({ name: result.name, from: result.from, stricter });
  }
  return { values, fenced, filled };
}

/**
 * One lookup: bounded in time and size, text only. A throw, a timeout, an oversize answer or a value that is not a
 * string is the render's failure, named — `[object Object]` never reaches a prompt.
 */
async function resolveOne(tag: string, name: string, entry: Extract<RegisteredSource, { kind: "source" }>, context: VariableSourceContext): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new VariableSourceError(tag, name, "timeout")), entry.timeoutMs);
  });
  try {
    const value = await Promise.race([entry.source.resolve(context), timeout]);
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new VariableSourceError(tag, name, "not_text");
    if (Buffer.byteLength(value, "utf8") > entry.maxBytes) throw new VariableSourceError(tag, name, "too_large");
    return value;
  } catch (error) {
    if (isVariableSourceError(error)) throw error;
    throw new VariableSourceError(tag, name, "threw", error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The required names a render would still lack after these values and the registered sources — what a call site
 * checks at start-up so an uncoverable version fails there, not on the first customer request. Only declarations
 * matter here (a required variable is needed whether or not the text uses it), so no payload is read.
 */
export function unsourced(input: { variables: readonly SlotVariable[]; values: RenderValues; registry: VariableSourceRegistry }): string[] {
  return input.variables.filter((variable) => variable.required && !supplied(input.values, variable.name) && !input.registry.has(variable.name)).map((variable) => variable.name);
}
