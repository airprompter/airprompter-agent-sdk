/**
 * @fileoverview Variable sources: values a prompt needs, filled from the customer's own system at render time.
 *
 * A prompt author declares `{{customer_tier}}` in AirPrompter; the application that runs the prompt registers,
 * once, how to get a customer's tier from its own database. From then on every version that uses the variable is
 * filled without a change at the call site — and a version that does not use it never causes the lookup. This
 * module is the registry of those sources and the rules for one of them; `fill.ts` applies them to a render.
 *
 * Trust is the load-bearing rule: a callable source is text nobody in AirPrompter reviewed (a CRM notes field, a
 * CMS row another team writes), so registering one names its trust, and a render fences the value when EITHER the
 * prompt's declaration or the source says `end_user`. A literal value is the application's own and defaults to
 * `operator`. Values never leave the host: nothing here is logged or reported but a variable's name.
 *
 * @example
 * ```ts
 * const sources = new VariableSourceRegistry();
 * sources.provide("brand", "Acme");                                   // a literal: operator trust, synchronous
 * sources.provide("customer_tier", {                                  // a source: async, trust named, bounded
 *   resolve: async ({ subject }) => crm.tierOf(subject),
 *   trust: "operator",
 *   timeoutMs: 500,
 * });
 * sources.provide("last_ticket", { resolve: async ({ subject }) => tickets.latest(subject), trust: "end_user" });
 * sources.names();                                                    // ["brand", "customer_tier", "last_ticket"]
 * ```
 */

import { errorNamed, type SlotVariable } from "@airprompter/agent-core";

/** What a source is told about the render that needs it. Never the prompt text, never other values. */
export interface VariableSourceContext {
  /** The slot's tag (a workflow step's step id when a step is rendered). */
  tag: string;
  /** The variable being filled. */
  name: string;
  /** The subject the caller rendered for (sticky A/B assignment), when it gave one. */
  subject: string | undefined;
  /** The prompt version and the experiment arm the render resolved to; null in managed mode, where the run route resolves them. */
  versionId: string | null;
  arm: string | null;
}

/** A callable source: how the application fills one variable from its own system. */
export interface VariableSource {
  /** Returns the value, or `undefined` for "I have none" (a required variable then fails the render). */
  resolve: (context: VariableSourceContext) => Promise<string | undefined>;
  /**
   * Whose text this is. `end_user` fences the value in the prompt's delimiters whatever the prompt declared;
   * `operator` inserts it raw — only when the prompt's own declaration is `operator` too. Required: a source with
   * no stated trust is a source nobody thought about.
   */
  trust: SlotVariable["trust"];
  /** How long one lookup may take before the render fails; 2 s unless told otherwise. */
  timeoutMs?: number;
  /** The most bytes (UTF-8) a value may be; a runaway row fails the render instead of flooding the context. 64 KiB unless told otherwise. */
  maxBytes?: number;
}

/** A registered source, or a literal value the application always supplies. */
export type VariableSourceInput = string | VariableSource;

export const DEFAULT_SOURCE_TIMEOUT_MS = 2000;
export const DEFAULT_SOURCE_MAX_BYTES = 64 * 1024;

/** A registered entry, normalised: a literal keeps its text; a source keeps its bounds filled in. */
export type RegisteredSource =
  | { kind: "literal"; value: string; trust: "operator" }
  | { kind: "source"; source: VariableSource; trust: SlotVariable["trust"]; timeoutMs: number; maxBytes: number };

/** A render needed a callable source but was asked synchronously: use `renderAsync()`. Identified by name and `code`, never `instanceof` (two copies of a package may be loaded). */
export class VariableSourceRequiredError extends Error {
  readonly code = "variable_source_required";
  constructor(
    readonly tag: string,
    readonly names: string[],
  ) {
    super(`render ${tag}: ${names.join(", ")} ${names.length > 1 ? "come" : "comes"} from a source that must be awaited — use renderAsync()`);
    this.name = "VariableSourceRequiredError";
  }
}

const REASON_TEXT = {
  threw: "threw",
  timeout: "timed out",
  empty: "returned nothing for a required variable",
  too_large: "returned more than its byte bound",
  not_text: "returned something other than text",
  unfenceable: "is end_user trust but the slot declares operator, and a hosted run cannot fence it — declare the variable end_user in AirPrompter",
} as const;

/** A source threw, timed out, answered nothing for a required variable, answered more than its byte bound or not text — or cannot be fenced where it is going. */
export class VariableSourceError extends Error {
  readonly code = "variable_source";
  constructor(
    readonly tag: string,
    readonly variable: string,
    readonly reason: "threw" | "timeout" | "empty" | "too_large" | "not_text" | "unfenceable",
    cause?: unknown,
  ) {
    super(`render ${tag}: source for ${variable} ${REASON_TEXT[reason]}`, cause === undefined ? undefined : { cause });
    this.name = "VariableSourceError";
  }
}

/**
 * The application's sources by variable name. One registry per agent; the facade exposes it as `ap.variables`.
 * Names are keys, not scopes: a source that must answer differently for two prompts reads `context.tag`.
 */
export class VariableSourceRegistry {
  private readonly entries = new Map<string, RegisteredSource>();

  constructor(initial?: Record<string, VariableSourceInput>) {
    for (const [name, input] of Object.entries(initial ?? {})) this.provide(name, input);
  }

  /** Register (or replace) how a variable is filled. */
  provide(name: string, input: VariableSourceInput): void {
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(name)) throw new Error(`variable source: ${JSON.stringify(name)} is not a variable name`);
    if (typeof input === "string") {
      this.entries.set(name, { kind: "literal", value: input, trust: "operator" });
      return;
    }
    if (typeof input?.resolve !== "function") throw new Error(`variable source ${name}: resolve must be a function`);
    if (input.trust !== "operator" && input.trust !== "end_user") throw new Error(`variable source ${name}: trust must be "operator" or "end_user"`);
    const timeoutMs = input.timeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
    const maxBytes = input.maxBytes ?? DEFAULT_SOURCE_MAX_BYTES;
    if (!(timeoutMs > 0) || !(maxBytes > 0)) throw new Error(`variable source ${name}: timeoutMs and maxBytes must be positive`);
    this.entries.set(name, { kind: "source", source: input, trust: input.trust, timeoutMs, maxBytes });
  }

  /** Forget a source; renders that need the variable fail from now on unless the call site supplies it. */
  revoke(name: string): boolean {
    return this.entries.delete(name);
  }

  /** The fill's view (the value or the callable itself); an application reads `describe()`. */
  get(name: string): RegisteredSource | undefined {
    return this.entries.get(name);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** What is registered under a name, without the value or the callable: fit to print. */
  describe(name: string): { kind: "literal" | "source"; trust: SlotVariable["trust"] } | undefined {
    const entry = this.entries.get(name);
    return entry ? { kind: entry.kind, trust: entry.trust } : undefined;
  }

  /** The variable names this application can fill — content-free, fit for a log line or a heartbeat. */
  names(): string[] {
    return [...this.entries.keys()].sort();
  }
}

/** The checks callers use in place of `instanceof` (an error may come from another copy of this package). */
export const isVariableSourceError = (error: unknown): error is VariableSourceError => errorNamed(error, "VariableSourceError");
export const isVariableSourceRequiredError = (error: unknown): error is VariableSourceRequiredError => errorNamed(error, "VariableSourceRequiredError");
