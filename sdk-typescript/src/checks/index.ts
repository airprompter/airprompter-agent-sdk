/**
 * Declared output checks (T29 / 5-E, checks.md): deterministic, on the host,
 * on the output the SDK already sees; the result is two counters on the
 * window (`checks.passed` / `checks.failed`) and never leaves the process.
 * A port of `conformance/checks.mjs`; `vectors/checks.json` pins the two.
 *
 * Kinds: `json_schema` (a documented JSON Schema subset), `enum` (the string
 * at a dotted path is one of the allowed values), `length` (an output-token
 * band — the provider's count when reported, else ceil(UTF-8 bytes / 4)),
 * `must_match` / `must_not_match` (a pattern that must / must not occur).
 *
 * Regex safety rule: RE2-class syntax only — no backreferences, no
 * lookaround, no atomic or possessive groups, no quantified group whose body
 * is itself quantified — patterns of at most 256 characters, and an output
 * over 64 KiB fails a pattern check closed rather than being scanned in
 * part. A refused pattern is refused at declaration and fails closed here.
 */

import type { OutputCheck } from "../protocol/types.js";

export const CHECK_BOUNDS = Object.freeze({
  maxChecks: 8,
  nameMaxLength: 64,
  patternMaxLength: 256,
  subjectMaxBytes: 65536,
  schemaMaxBytes: 16384,
  enumMaxValues: 64,
  enumValueMaxLength: 128,
  pathMaxLength: 128,
  maxTokens: 1_000_000,
});

/** A declared check as the console stores it: the pin projection plus `enabled`. */
export type DeclaredCheck = OutputCheck & { enabled?: boolean };

export type CheckResult = { name: string; kind: OutputCheck["kind"]; verdict: "pass" | "fail"; reason?: string };
export type CheckOutcome = { passed: number; failed: number; results: CheckResult[] };

const NAME = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const encoder = new TextEncoder();

export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/** ceil(bytes / 4): the estimate when the provider reported no output tokens. */
export function estimateTokens(text: string): number {
  return Math.ceil(utf8Bytes(text) / 4);
}

/** Why a pattern is refused, or null when it is RE2-class and inside the cap. */
export function patternRefusal(pattern: unknown): string | null {
  if (typeof pattern !== "string" || pattern.length === 0) return "empty";
  if (pattern.length > CHECK_BOUNDS.patternMaxLength) return "too_long";
  if (/\\[1-9]/.test(pattern) || /\\k</.test(pattern)) return "backreference";
  if (/\(\?<?[=!]/.test(pattern)) return "lookaround";
  if (/\(\?>/.test(pattern) || /[*+?}]\+/.test(pattern)) return "possessive_or_atomic";
  let depth = 0;
  const bodies: Array<{ quantified: boolean }> = [];
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[") {
      let j = i + 1;
      if (pattern[j] === "^") j += 1;
      if (pattern[j] === "]") j += 1;
      while (j < pattern.length && pattern[j] !== "]") {
        if (pattern[j] === "\\") j += 1;
        j += 1;
      }
      i = j;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      bodies.push({ quantified: false });
      continue;
    }
    if (ch === ")") {
      const body = bodies.pop();
      depth -= 1;
      const groupQuantified = /^(?:[*+?]|\{\d+(?:,\d*)?\})/.test(pattern.slice(i + 1));
      if (groupQuantified && body?.quantified) return "nested_quantifier";
      if (groupQuantified && bodies.length > 0) bodies[bodies.length - 1]!.quantified = true;
      continue;
    }
    if (ch === "{") {
      const counted = /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(i));
      if (!counted) return "invalid";
      if (bodies.length > 0) bodies[bodies.length - 1]!.quantified = true;
      i += counted[0].length - 1;
      continue;
    }
    if (ch === "}") return "invalid";
    if ((ch === "*" || ch === "+") && bodies.length > 0) bodies[bodies.length - 1]!.quantified = true;
  }
  if (depth !== 0) return "unbalanced";
  try {
    new RegExp(pattern, "u");
  } catch {
    return "invalid";
  }
  return null;
}

function schemaPatternRefusal(schema: unknown): string | null {
  if (typeof schema !== "object" || schema === null) return null;
  if (Array.isArray(schema)) {
    for (const entry of schema) {
      const bad = schemaPatternRefusal(entry);
      if (bad) return bad;
    }
    return null;
  }
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "pattern" && typeof value === "string") {
      const bad = patternRefusal(value);
      if (bad) return bad;
      continue;
    }
    const bad = schemaPatternRefusal(value);
    if (bad) return bad;
  }
  return null;
}

/** Why a declared check is refused, or null when it is well-formed. */
export function checkRefusal(check: unknown): string | null {
  if (typeof check !== "object" || check === null) return "not_an_object";
  const c = check as Record<string, unknown>;
  if (typeof c.name !== "string" || !NAME.test(c.name) || c.name.length > CHECK_BOUNDS.nameMaxLength) return "bad_name";
  switch (c.kind) {
    case "json_schema": {
      if (typeof c.schema !== "object" || c.schema === null || Array.isArray(c.schema)) return "schema_not_an_object";
      if (utf8Bytes(JSON.stringify(c.schema)) > CHECK_BOUNDS.schemaMaxBytes) return "schema_too_large";
      const bad = schemaPatternRefusal(c.schema);
      return bad ? `schema_pattern_${bad}` : null;
    }
    case "enum": {
      if (typeof c.path !== "string" || c.path.length > CHECK_BOUNDS.pathMaxLength) return "bad_path";
      const values = c.values;
      if (!Array.isArray(values) || values.length === 0 || values.length > CHECK_BOUNDS.enumMaxValues) return "bad_values";
      if (!values.every((v) => typeof v === "string" && v.length > 0 && v.length <= CHECK_BOUNDS.enumValueMaxLength)) return "bad_values";
      if (new Set(values).size !== values.length) return "duplicate_values";
      return null;
    }
    case "length": {
      const okInt = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= CHECK_BOUNDS.maxTokens;
      if (c.minTokens === undefined && c.maxTokens === undefined) return "no_bound";
      if (c.minTokens !== undefined && !okInt(c.minTokens)) return "bad_bound";
      if (c.maxTokens !== undefined && !okInt(c.maxTokens)) return "bad_bound";
      if (c.minTokens !== undefined && c.maxTokens !== undefined && (c.minTokens as number) > (c.maxTokens as number)) return "inverted_bounds";
      return null;
    }
    case "must_match":
    case "must_not_match": {
      const refusal = patternRefusal(c.pattern);
      if (refusal) return `pattern_${refusal}`;
      if (c.flags !== undefined && c.flags !== "i") return "bad_flags";
      return null;
    }
    default:
      return "unknown_kind";
  }
}

/** Every refusal of a declared list; empty when all pass. */
export function checksRefusals(checks: unknown): Array<{ name: string | null; reason: string }> {
  const refusals: Array<{ name: string | null; reason: string }> = [];
  if (!Array.isArray(checks)) return [{ name: null, reason: "not_a_list" }];
  if (checks.length > CHECK_BOUNDS.maxChecks) refusals.push({ name: null, reason: "too_many" });
  const names = new Set<string>();
  for (const check of checks) {
    const reason = checkRefusal(check);
    const name = typeof (check as { name?: unknown })?.name === "string" ? ((check as { name: string }).name) : null;
    if (reason) refusals.push({ name, reason });
    if (name !== null) {
      if (names.has(name)) refusals.push({ name, reason: "duplicate_name" });
      names.add(name);
    }
  }
  return refusals;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    const starts = ["{", "["].map((c) => text.indexOf(c)).filter((i) => i >= 0);
    const start = starts.length ? Math.min(...starts) : -1;
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (start < 0 || end <= start) return { ok: false };
    try {
      return { ok: true, value: JSON.parse(text.slice(start, end + 1)) };
    } catch {
      return { ok: false };
    }
  }
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** The JSON Schema subset checks.md names; unknown keywords are ignored. */
export function validateJsonSchema(schema: unknown, value: unknown): boolean {
  if (typeof schema !== "object" || schema === null) return true;
  const s = schema as Record<string, unknown>;
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const actual = typeOf(value);
    if (!types.some((t) => t === actual || (t === "number" && actual === "integer"))) return false;
  }
  if (Array.isArray(s.enum) && !s.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) return false;
  if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(value)) return false;
  if (Array.isArray(s.anyOf) && !s.anyOf.some((sub) => validateJsonSchema(sub, value))) return false;
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof s.minLength === "number" && length < s.minLength) return false;
    if (typeof s.maxLength === "number" && length > s.maxLength) return false;
    if (typeof s.pattern === "string") {
      if (patternRefusal(s.pattern) || utf8Bytes(value) > CHECK_BOUNDS.subjectMaxBytes) return false;
      if (!new RegExp(s.pattern, "u").test(value)) return false;
    }
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) return false;
    if (typeof s.maximum === "number" && value > s.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) return false;
    if (typeof s.maxItems === "number" && value.length > s.maxItems) return false;
    if (s.items !== undefined && !value.every((item) => validateJsonSchema(s.items, item))) return false;
  }
  if (typeOf(value) === "object") {
    const record = value as Record<string, unknown>;
    const properties = typeof s.properties === "object" && s.properties !== null ? (s.properties as Record<string, unknown>) : {};
    for (const key of Array.isArray(s.required) ? s.required : []) if (!(key in record)) return false;
    for (const [key, sub] of Object.entries(properties)) if (key in record && !validateJsonSchema(sub, record[key])) return false;
    if (s.additionalProperties === false) for (const key of Object.keys(record)) if (!(key in properties)) return false;
  }
  return true;
}

/** A dotted path into parsed JSON; "" is the whole value. */
export function valueAtPath(value: unknown, path: string): { found: true; value: unknown } | { found: false } {
  if (path === "") return { found: true, value };
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)];
    else if (typeof current === "object" && current !== null && part in (current as Record<string, unknown>)) current = (current as Record<string, unknown>)[part];
    else return { found: false };
    if (current === undefined) return { found: false };
  }
  return { found: true, value: current };
}

/** One check on one output; never throws. `outputTokens` null = estimate. */
export function evaluateCheck(check: OutputCheck, input: { text: string; outputTokens: number | null }): CheckResult {
  const text = typeof input.text === "string" ? input.text : "";
  const fail = (reason: string): CheckResult => ({ name: check.name, kind: check.kind, verdict: "fail", reason });
  const pass = (): CheckResult => ({ name: check.name, kind: check.kind, verdict: "pass" });
  switch (check.kind) {
    case "json_schema": {
      const parsed = parseJson(text);
      if (!parsed.ok) return fail("not_json");
      return validateJsonSchema(check.schema, parsed.value) ? pass() : fail("schema_mismatch");
    }
    case "enum": {
      let candidate: unknown;
      if (check.path === "") {
        const trimmed = text.trim();
        const parsed = parseJson(trimmed);
        candidate = parsed.ok && typeof parsed.value === "string" ? parsed.value : trimmed;
      } else {
        const parsed = parseJson(text);
        if (!parsed.ok) return fail("not_json");
        const at = valueAtPath(parsed.value, check.path);
        if (!at.found) return fail("path_missing");
        candidate = at.value;
      }
      if (typeof candidate !== "string") return fail("not_a_string");
      return check.values.includes(candidate) ? pass() : fail("not_in_enum");
    }
    case "length": {
      const tokens = Number.isInteger(input.outputTokens) && (input.outputTokens as number) >= 0 ? (input.outputTokens as number) : estimateTokens(text);
      if (check.minTokens !== undefined && tokens < check.minTokens) return fail("too_short");
      if (check.maxTokens !== undefined && tokens > check.maxTokens) return fail("too_long");
      return pass();
    }
    case "must_match":
    case "must_not_match": {
      if (patternRefusal(check.pattern)) return fail("pattern_refused");
      if (utf8Bytes(text) > CHECK_BOUNDS.subjectMaxBytes) return fail("subject_too_long");
      const matched = new RegExp(check.pattern, check.flags === "i" ? "iu" : "u").test(text);
      if (check.kind === "must_match") return matched ? pass() : fail("no_match");
      return matched ? fail("matched") : pass();
    }
    default:
      return fail("unknown_kind");
  }
}

/** Every enabled check on one output: the window's counters and the per-check results. */
export function evaluateChecks(checks: readonly DeclaredCheck[] | undefined, input: { text: string; outputTokens: number | null }): CheckOutcome {
  const results: CheckResult[] = [];
  for (const check of checks ?? []) {
    if (check && check.enabled === false) continue;
    results.push(evaluateCheck(check, input));
  }
  return { passed: results.filter((r) => r.verdict === "pass").length, failed: results.filter((r) => r.verdict === "fail").length, results };
}

/** The pin / manifest projection: enabled checks only, sorted by name, the kind's own members only. */
export function projectChecks(checks: readonly DeclaredCheck[] | undefined): OutputCheck[] {
  return (checks ?? [])
    .filter((check) => check && check.enabled !== false)
    .map((check): OutputCheck => {
      switch (check.kind) {
        case "json_schema":
          return { kind: "json_schema", name: check.name, schema: check.schema };
        case "enum":
          return { kind: "enum", name: check.name, path: check.path, values: [...check.values] };
        case "length":
          return { kind: "length", name: check.name, ...(check.minTokens !== undefined ? { minTokens: check.minTokens } : {}), ...(check.maxTokens !== undefined ? { maxTokens: check.maxTokens } : {}) };
        default:
          return { kind: check.kind, name: check.name, pattern: check.pattern, ...(check.flags ? { flags: check.flags } : {}) };
      }
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The output text of whatever the provider answered, for the checks: a
 * plain string; OpenAI `choices[0].message.content` (a string or content
 * parts); Anthropic `content[].text`; Bedrock Converse
 * `output.message.content[].text`. Null when nothing recognisable — then the
 * checks are not run (never a failure invented from an unknown shape).
 */
export function outputTextOf(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (typeof result !== "object" || result === null) return null;
  const root = result as Record<string, unknown>;
  const partsText = (parts: unknown): string | null => {
    if (typeof parts === "string") return parts;
    if (!Array.isArray(parts)) return null;
    const texts = parts.map((part) => (typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : null)).filter((t): t is string => t !== null);
    return texts.length ? texts.join("") : null;
  };
  const choice = Array.isArray(root.choices) ? (root.choices[0] as Record<string, unknown> | undefined) : undefined;
  const message = choice && typeof choice.message === "object" && choice.message !== null ? (choice.message as Record<string, unknown>) : null;
  if (message) return partsText(message.content);
  if (root.content !== undefined) return partsText(root.content);
  const output = typeof root.output === "object" && root.output !== null ? (root.output as Record<string, unknown>) : null;
  const outMessage = output && typeof output.message === "object" && output.message !== null ? (output.message as Record<string, unknown>) : null;
  if (outMessage) return partsText(outMessage.content);
  if (typeof root.output_text === "string") return root.output_text;
  return null;
}
