/**
 * Reference implementation of declared output checks (checks.md, T29 / 5-E).
 * Deterministic, on the host, on the output the SDK already sees; every
 * SDK's `checks` module must agree with `vectors/checks.json`, which this
 * file generates through `tools/gen_check_vectors.mjs`.
 *
 * Kinds: json_schema (a documented JSON Schema subset), enum (a value at a
 * dotted path is one of the allowed strings), length (an output-token band,
 * from the provider's usage when reported, else ceil(utf8 bytes / 4)),
 * must_match / must_not_match (a pattern that must / must not occur).
 *
 * Regex safety rule: RE2-class syntax only — no backreferences, no
 * lookaround, no atomic or possessive groups, no quantified group whose
 * body is itself quantified (the catastrophic-backtracking shape) — and a
 * subject cap: an output longer than SUBJECT_MAX_BYTES fails the check
 * closed instead of being scanned in part. A pattern the rule refuses is
 * refused at declaration and fails closed at evaluation.
 */

export const CHECK_BOUNDS = Object.freeze({
  maxChecks: 8,
  nameMaxLength: 64,
  patternMaxLength: 256,
  /** 64 KiB: a longer output fails a pattern check closed (never a partial scan). */
  subjectMaxBytes: 65536,
  schemaMaxBytes: 16384,
  enumMaxValues: 64,
  enumValueMaxLength: 128,
  pathMaxLength: 128,
  /** The ceiling either token bound may name. */
  maxTokens: 1_000_000,
});

const NAME = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/** Why a pattern is refused, or null when it is RE2-class and inside the cap. */
export function patternRefusal(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) return "empty";
  if (pattern.length > CHECK_BOUNDS.patternMaxLength) return "too_long";
  if (/\\[1-9]/.test(pattern) || /\\k</.test(pattern)) return "backreference";
  if (/\(\?<?[=!]/.test(pattern)) return "lookaround";
  if (/\(\?>/.test(pattern) || /[*+?}]\+/.test(pattern)) return "possessive_or_atomic";
  // A quantified group whose body carries an unbounded quantifier: (a+)+, (a*)*, (a+){2,}, ((ab)*c)+ …
  let depth = 0;
  const bodies = [];
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[") {
      // A character class: skip to its end (a `]` right after `[` or `[^` is literal).
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
      const next = pattern.slice(i + 1);
      const groupQuantified = /^(?:[*+?]|\{\d+(?:,\d*)?\})/.test(next);
      if (groupQuantified && body?.quantified) return "nested_quantifier";
      if (groupQuantified && bodies.length > 0) bodies[bodies.length - 1].quantified = true;
      continue;
    }
    if (ch === "{") {
      // Only the counted forms are quantifiers; a bare `{` is a syntax error under strict (unicode) syntax everywhere.
      const counted = /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(i));
      if (!counted) return "invalid";
      if (bodies.length > 0) bodies[bodies.length - 1].quantified = true;
      i += counted[0].length - 1;
      continue;
    }
    if (ch === "}") return "invalid";
    if (ch === "*" || ch === "+") {
      if (bodies.length > 0) bodies[bodies.length - 1].quantified = true;
    }
  }
  if (depth !== 0) return "unbalanced";
  try {
    new RegExp(pattern, "u");
  } catch {
    return "invalid";
  }
  return null;
}

/** Why a declared check is refused, or null when it is well-formed. */
export function checkRefusal(check) {
  if (typeof check !== "object" || check === null) return "not_an_object";
  if (typeof check.name !== "string" || !NAME.test(check.name) || check.name.length > CHECK_BOUNDS.nameMaxLength) return "bad_name";
  switch (check.kind) {
    case "json_schema": {
      if (typeof check.schema !== "object" || check.schema === null || Array.isArray(check.schema)) return "schema_not_an_object";
      if (utf8Bytes(JSON.stringify(check.schema)) > CHECK_BOUNDS.schemaMaxBytes) return "schema_too_large";
      const bad = schemaPatternRefusal(check.schema);
      return bad ? `schema_pattern_${bad}` : null;
    }
    case "enum": {
      if (typeof check.path !== "string" || check.path.length > CHECK_BOUNDS.pathMaxLength) return "bad_path";
      if (!Array.isArray(check.values) || check.values.length === 0 || check.values.length > CHECK_BOUNDS.enumMaxValues) return "bad_values";
      if (!check.values.every((v) => typeof v === "string" && v.length > 0 && v.length <= CHECK_BOUNDS.enumValueMaxLength)) return "bad_values";
      if (new Set(check.values).size !== check.values.length) return "duplicate_values";
      return null;
    }
    case "length": {
      const min = check.minTokens;
      const max = check.maxTokens;
      const okInt = (v) => Number.isInteger(v) && v >= 0 && v <= CHECK_BOUNDS.maxTokens;
      if (min === undefined && max === undefined) return "no_bound";
      if (min !== undefined && !okInt(min)) return "bad_bound";
      if (max !== undefined && !okInt(max)) return "bad_bound";
      if (min !== undefined && max !== undefined && min > max) return "inverted_bounds";
      return null;
    }
    case "must_match":
    case "must_not_match": {
      const refusal = patternRefusal(check.pattern);
      if (refusal) return `pattern_${refusal}`;
      if (check.flags !== undefined && check.flags !== "i") return "bad_flags";
      return null;
    }
    default:
      return "unknown_kind";
  }
}

function schemaPatternRefusal(schema) {
  if (typeof schema !== "object" || schema === null) return null;
  if (Array.isArray(schema)) {
    for (const entry of schema) {
      const bad = schemaPatternRefusal(entry);
      if (bad) return bad;
    }
    return null;
  }
  for (const [key, value] of Object.entries(schema)) {
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

/** Every refusal of a declared list, by name; empty when all pass. Duplicate names and more than the cap are refused on the list. */
export function checksRefusals(checks) {
  const refusals = [];
  if (!Array.isArray(checks)) return [{ name: null, reason: "not_a_list" }];
  if (checks.length > CHECK_BOUNDS.maxChecks) refusals.push({ name: null, reason: "too_many" });
  const names = new Set();
  for (const check of checks) {
    const reason = checkRefusal(check);
    if (reason) refusals.push({ name: typeof check?.name === "string" ? check.name : null, reason });
    if (check && typeof check.name === "string") {
      if (names.has(check.name)) refusals.push({ name: check.name, reason: "duplicate_name" });
      names.add(check.name);
    }
  }
  return refusals;
}

export function utf8Bytes(text) {
  return Buffer.byteLength(text, "utf8");
}

/** ceil(bytes / 4): the estimate when the provider reported no output tokens. */
export function estimateTokens(text) {
  return Math.ceil(utf8Bytes(text) / 4);
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    // A fenced or prefixed JSON block still counts: the first `{`/`[` to the last `}`/`]`.
    const start = Math.min(...["{", "["].map((c) => text.indexOf(c)).filter((i) => i >= 0));
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (!Number.isFinite(start) || end <= start) return { ok: false };
    try {
      return { ok: true, value: JSON.parse(text.slice(start, end + 1)) };
    } catch {
      return { ok: false };
    }
  }
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/**
 * The JSON Schema subset an output check may use: type (a name or a list; `number` accepts integers),
 * enum, const, properties, required, additionalProperties (boolean), items, minItems, maxItems,
 * minLength, maxLength, minimum, maximum, pattern (the regex rule applies), anyOf. Any other keyword is
 * ignored, so a schema never fails on what the evaluator does not know.
 */
export function validateJsonSchema(schema, value) {
  if (typeof schema !== "object" || schema === null) return true;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!types.some((t) => t === actual || (t === "number" && actual === "integer"))) return false;
  }
  if (schema.enum !== undefined && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) return false;
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => validateJsonSchema(s, value))) return false;
  if (typeof value === "string") {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) return false;
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) return false;
    if (typeof schema.pattern === "string") {
      if (patternRefusal(schema.pattern) || utf8Bytes(value) > CHECK_BOUNDS.subjectMaxBytes) return false;
      if (!new RegExp(schema.pattern, "u").test(value)) return false;
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items !== undefined && !value.every((item) => validateJsonSchema(schema.items, item))) return false;
  }
  if (typeOf(value) === "object") {
    const properties = typeof schema.properties === "object" && schema.properties !== null ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) if (!(key in value)) return false;
    for (const [key, sub] of Object.entries(properties)) if (key in value && !validateJsonSchema(sub, value[key])) return false;
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in properties)) return false;
  }
  return true;
}

/** A dotted path into parsed JSON (`category`, `result.category`, `items.0.kind`); "" is the whole value. */
export function valueAtPath(value, path) {
  if (path === "") return { found: true, value };
  let current = value;
  for (const part of path.split(".")) {
    if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)];
    else if (typeof current === "object" && current !== null && part in current) current = current[part];
    else return { found: false };
    if (current === undefined) return { found: false };
  }
  return { found: true, value: current };
}

/**
 * Evaluate one check on an output. `outputTokens` is the provider's count when reported; null means estimate.
 * Returns { name, kind, verdict: "pass" | "fail", reason? } — never throws.
 */
export function evaluateCheck(check, input) {
  const text = typeof input.text === "string" ? input.text : "";
  const fail = (reason) => ({ name: check.name, kind: check.kind, verdict: "fail", reason });
  const pass = () => ({ name: check.name, kind: check.kind, verdict: "pass" });
  switch (check.kind) {
    case "json_schema": {
      const parsed = parseJson(text);
      if (!parsed.ok) return fail("not_json");
      return validateJsonSchema(check.schema, parsed.value) ? pass() : fail("schema_mismatch");
    }
    case "enum": {
      let candidate;
      if (check.path === "") {
        // The whole output, trimmed; a bare JSON string counts as its value.
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
      const tokens = Number.isInteger(input.outputTokens) && input.outputTokens >= 0 ? input.outputTokens : estimateTokens(text);
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

/** Every enabled check on one output: counts for the window and the per-check results. */
export function evaluateChecks(checks, input) {
  const results = [];
  for (const check of Array.isArray(checks) ? checks : []) {
    if (check && check.enabled === false) continue;
    results.push(evaluateCheck(check, input));
  }
  return { passed: results.filter((r) => r.verdict === "pass").length, failed: results.filter((r) => r.verdict === "fail").length, results };
}

/** The pin / manifest projection: enabled checks only, sorted by name, with only the kind's own members. */
export function projectChecks(checks) {
  return (Array.isArray(checks) ? checks : [])
    .filter((check) => check && check.enabled !== false)
    .map((check) => {
      const base = { kind: check.kind, name: check.name };
      switch (check.kind) {
        case "json_schema":
          return { ...base, schema: check.schema };
        case "enum":
          return { ...base, path: check.path, values: [...check.values] };
        case "length":
          return { ...base, ...(check.minTokens !== undefined ? { minTokens: check.minTokens } : {}), ...(check.maxTokens !== undefined ? { maxTokens: check.maxTokens } : {}) };
        default:
          return { ...base, pattern: check.pattern, ...(check.flags ? { flags: check.flags } : {}) };
      }
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
