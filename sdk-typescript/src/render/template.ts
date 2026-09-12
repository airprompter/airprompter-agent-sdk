/**
 * Rendering a slot's text with its declared variables.
 *
 * `{{name}}` placeholders are the only substitution. A variable declared
 * `end_user` (D55) is never dropped into the text raw: it is wrapped in the
 * delimiters declared for it — by default an XML-style element named after
 * the variable — so the model sees where untrusted input starts and stops,
 * and the assurance lens can find it. A missing required variable throws:
 * that is the customer's bug and silence would ship a broken prompt.
 * Sync and telemetry failures degrade; render contract failures throw.
 */

import type { SlotVariable } from "../protocol/types.js";

export class MissingVariableError extends Error {
  constructor(
    readonly tag: string,
    readonly missing: string[],
  ) {
    super(`render ${tag}: missing required variable${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`);
    this.name = "MissingVariableError";
  }
}

export class UnknownVariableError extends Error {
  constructor(
    readonly tag: string,
    readonly unknown: string[],
  ) {
    super(`render ${tag}: variable${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} not declared on this slot`);
    this.name = "UnknownVariableError";
  }
}

export interface Delimiters {
  open(name: string): string;
  close(name: string): string;
}

/** `<name>…</name>`: visible to the model, easy to find in the text, and never confusable with `{{name}}`. */
export const xmlDelimiters: Delimiters = {
  open: (name) => `<${name}>`,
  close: (name) => `</${name}>`,
};

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.-]{1,64})\s*\}\}/g;

export interface RenderInput {
  tag: string;
  text: string;
  variables: readonly SlotVariable[];
  values: Readonly<Record<string, string | number | boolean | null | undefined>>;
  delimiters?: Delimiters;
  /** Refuse values for variables the slot did not declare (default: true — a typo is a bug, not an optional). */
  strictVariables?: boolean;
}

export function renderTemplate(input: RenderInput): string {
  const declared = new Map(input.variables.map((variable) => [variable.name, variable]));
  const delimiters = input.delimiters ?? xmlDelimiters;
  const present = new Set(Object.entries(input.values).filter(([, value]) => value !== undefined && value !== null).map(([name]) => name));
  const missing = input.variables.filter((variable) => variable.required && !present.has(variable.name)).map((variable) => variable.name);
  if (missing.length) throw new MissingVariableError(input.tag, missing);
  if (input.strictVariables !== false) {
    const unknown = [...present].filter((name) => !declared.has(name));
    if (unknown.length) throw new UnknownVariableError(input.tag, unknown);
  }
  return input.text.replace(PLACEHOLDER, (whole, name: string) => {
    const variable = declared.get(name);
    if (!variable) return whole; // an undeclared placeholder in the text is left for the author to see
    const value = input.values[name];
    if (value === undefined || value === null) return "";
    const rendered = String(value);
    // End-user text is fenced; a value that carries the closing fence cannot break out of it.
    return variable.trust === "end_user" ? `${delimiters.open(name)}${escapeFence(rendered, delimiters.close(name))}${delimiters.close(name)}` : rendered;
  });
}

function escapeFence(value: string, close: string): string {
  return close ? value.split(close).join(close.replace("<", "&lt;")) : value;
}
