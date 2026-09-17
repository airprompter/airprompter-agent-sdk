#!/usr/bin/env node
// Generates protocol/vectors/checks.json from the reference evaluator (conformance/checks.mjs):
// per kind, outputs that pass and fail with the reason; patterns the regex safety rule refuses;
// the projection a pin carries. Deterministic.
//
//   $ node protocol/tools/gen_check_vectors.mjs protocol/vectors/checks.json
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { CHECK_BOUNDS, checksRefusals, evaluateChecks, patternRefusal, projectChecks } = await import(join(here, "..", "..", "conformance", "checks.mjs"));

const schema = {
  type: "object",
  required: ["category", "confidence"],
  properties: {
    category: { type: "string", enum: ["billing", "shipping", "account", "other"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    tags: { type: "array", maxItems: 3, items: { type: "string", minLength: 1 } },
    ticket: { type: ["string", "null"], pattern: "^[A-Z]{2}-\\d+$" },
  },
  additionalProperties: false,
};

const checks = [
  { kind: "json_schema", name: "triage-v2", enabled: true, schema },
  { kind: "enum", name: "category", enabled: true, path: "category", values: ["billing", "shipping", "account", "other"] },
  { kind: "length", name: "band", enabled: true, minTokens: 40, maxTokens: 400 },
  { kind: "must_not_match", name: "no-guarantee", enabled: true, pattern: "refund guaranteed", flags: "i" },
  { kind: "must_match", name: "signed-off", enabled: false, pattern: "Regards,\\s*\\w+$" },
];

const evaluations = [
  { name: "a well-formed triage answer passes every enabled check", checks, input: { text: JSON.stringify({ category: "billing", confidence: 0.92, tags: ["late"] }), outputTokens: 120 } },
  { name: "json_schema: an unknown property fails (additionalProperties false); the disabled check is not run", checks, input: { text: JSON.stringify({ category: "billing", confidence: 0.5, extra: 1 }), outputTokens: 120 } },
  { name: "json_schema: a fenced JSON block still parses", checks: [checks[0]], input: { text: "Here you go:\n```json\n{\"category\":\"other\",\"confidence\":1}\n```", outputTokens: null } },
  { name: "json_schema: not JSON at all", checks: [checks[0]], input: { text: "Category: Billing", outputTokens: 12 } },
  { name: "json_schema: pattern and nullable type", checks: [checks[0]], input: { text: JSON.stringify({ category: "account", confidence: 0.1, ticket: "AB-12" }), outputTokens: 30 } },
  { name: "json_schema: pattern mismatch fails", checks: [checks[0]], input: { text: JSON.stringify({ category: "account", confidence: 0.1, ticket: "ab-12" }), outputTokens: 30 } },
  { name: "json_schema: an integer satisfies number", checks: [checks[0]], input: { text: JSON.stringify({ category: "other", confidence: 1 }), outputTokens: 30 } },
  { name: "enum: a value outside the set", checks: [checks[1]], input: { text: JSON.stringify({ category: "refund" }), outputTokens: 3 } },
  { name: "enum: the path is missing", checks: [checks[1]], input: { text: JSON.stringify({ kind: "billing" }), outputTokens: 3 } },
  { name: "enum: a nested path and an array index", checks: [{ kind: "enum", name: "first-kind", enabled: true, path: "items.0.kind", values: ["a", "b"] }], input: { text: JSON.stringify({ items: [{ kind: "b" }] }), outputTokens: null } },
  { name: "enum: the whole output, trimmed, when the path is empty", checks: [{ kind: "enum", name: "bare", enabled: true, path: "", values: ["yes", "no"] }], input: { text: "  no\n", outputTokens: null } },
  { name: "enum: the whole output as a bare JSON string", checks: [{ kind: "enum", name: "bare", enabled: true, path: "", values: ["yes", "no"] }], input: { text: "\"yes\"", outputTokens: null } },
  { name: "enum: a non-string at the path", checks: [checks[1]], input: { text: JSON.stringify({ category: 3 }), outputTokens: null } },
  { name: "length: too short on reported tokens", checks: [checks[2]], input: { text: "short", outputTokens: 12 } },
  { name: "length: too long on reported tokens", checks: [checks[2]], input: { text: "x", outputTokens: 401 } },
  { name: "length: the estimate ceil(bytes/4) when nothing was reported — 200 ASCII bytes are 50 tokens", checks: [checks[2]], input: { text: "a".repeat(200), outputTokens: null } },
  { name: "length: the estimate counts UTF-8 bytes — 100 × 'é' (200 bytes) are 50 tokens", checks: [checks[2]], input: { text: "é".repeat(100), outputTokens: null } },
  { name: "length: min only", checks: [{ kind: "length", name: "min", enabled: true, minTokens: 1 }], input: { text: "", outputTokens: null } },
  { name: "must_not_match: forbidden text, case-insensitive", checks: [checks[3]], input: { text: "Your REFUND Guaranteed within 3 days.", outputTokens: null } },
  { name: "must_not_match: absent text passes", checks: [checks[3]], input: { text: "We will look into it.", outputTokens: null } },
  { name: "must_match: present passes", checks: [{ ...checks[4], enabled: true }], input: { text: "Thanks.\nRegards, Ada", outputTokens: null } },
  { name: "must_match: absent fails", checks: [{ ...checks[4], enabled: true }], input: { text: "Thanks.", outputTokens: null } },
  { name: "a subject over the cap fails a pattern check closed", checks: [checks[3]], input: { text: "x".repeat(CHECK_BOUNDS.subjectMaxBytes + 1), outputTokens: null } },
  { name: "a refused pattern fails closed at evaluation", checks: [{ kind: "must_match", name: "bad", enabled: true, pattern: "(a+)+$" }], input: { text: "aaaa", outputTokens: null } },
  { name: "nothing declared: nothing counted", checks: [], input: { text: "anything", outputTokens: null } },
];

const patterns = [
  { pattern: "refund guaranteed", refusal: null },
  { pattern: "^[A-Z]{2}-\\d+$", refusal: null },
  { pattern: "(?:https?://)[^\\s]+", refusal: null },
  { pattern: "[+*?]+", refusal: null, note: "a class of quantifier characters is not a quantifier" },
  { pattern: "(ab)+c{2,}", refusal: null, note: "a quantified group whose body is not quantified is fine" },
  { pattern: "(a+)+", refusal: "nested_quantifier" },
  { pattern: "(a*)*b", refusal: "nested_quantifier" },
  { pattern: "((ab)*c)+", refusal: "nested_quantifier" },
  { pattern: "(x{2,})+", refusal: "nested_quantifier" },
  { pattern: "(a)\\1", refusal: "backreference" },
  { pattern: "(?<n>a)\\k<n>", refusal: "backreference" },
  { pattern: "foo(?=bar)", refusal: "lookaround" },
  { pattern: "(?<!x)y", refusal: "lookaround" },
  { pattern: "a++", refusal: "possessive_or_atomic" },
  { pattern: "(?>ab)", refusal: "possessive_or_atomic" },
  { pattern: "(ab", refusal: "unbalanced" },
  { pattern: "a{2", refusal: "invalid", note: "a bare brace is a syntax error under strict syntax; only {n}, {n,} and {n,m} are quantifiers" },
  { pattern: "a\\{2", refusal: null, note: "an escaped brace is a literal" },
  { pattern: "", refusal: "empty" },
  { pattern: "x".repeat(CHECK_BOUNDS.patternMaxLength + 1), refusal: "too_long" },
];
for (const entry of patterns) {
  const got = patternRefusal(entry.pattern);
  if (got !== entry.refusal) throw new Error(`pattern ${JSON.stringify(entry.pattern)}: expected ${entry.refusal}, got ${got}`);
}

const declarations = [
  { name: "the example list is well-formed", checks, refusals: checksRefusals(checks) },
  { name: "a duplicate name and a bad kind", checks: [checks[1], { ...checks[1] }, { kind: "sentiment", name: "vibes", enabled: true }], refusals: checksRefusals([checks[1], { ...checks[1] }, { kind: "sentiment", name: "vibes", enabled: true }]) },
  { name: "a length check needs a bound and bounds in order", checks: [{ kind: "length", name: "none", enabled: true }, { kind: "length", name: "inverted", enabled: true, minTokens: 5, maxTokens: 1 }], refusals: checksRefusals([{ kind: "length", name: "none", enabled: true }, { kind: "length", name: "inverted", enabled: true, minTokens: 5, maxTokens: 1 }]) },
  { name: "a schema whose pattern the rule refuses is refused", checks: [{ kind: "json_schema", name: "s", enabled: true, schema: { type: "string", pattern: "(a+)+" } }], refusals: checksRefusals([{ kind: "json_schema", name: "s", enabled: true, schema: { type: "string", pattern: "(a+)+" } }]) },
  { name: "an enum with a duplicate value, and a pattern check with unknown flags", checks: [{ kind: "enum", name: "e", enabled: true, path: "k", values: ["a", "a"] }, { kind: "must_match", name: "m", enabled: true, pattern: "a", flags: "g" }], refusals: checksRefusals([{ kind: "enum", name: "e", enabled: true, path: "k", values: ["a", "a"] }, { kind: "must_match", name: "m", enabled: true, pattern: "a", flags: "g" }]) },
  { name: "more than the cap", checks: Array.from({ length: CHECK_BOUNDS.maxChecks + 1 }, (_, i) => ({ kind: "length", name: `c${i}`, enabled: true, minTokens: 1 })), refusals: checksRefusals(Array.from({ length: CHECK_BOUNDS.maxChecks + 1 }, (_, i) => ({ kind: "length", name: `c${i}`, enabled: true, minTokens: 1 }))) },
];

const doc = {
  $comment: "Generated by protocol/tools/gen_check_vectors.mjs from conformance/checks.mjs. See checks.md.",
  bounds: CHECK_BOUNDS,
  evaluations: evaluations.map((entry) => ({ name: entry.name, checks: entry.checks, input: entry.input, expected: evaluateChecks(entry.checks, entry.input) })),
  patterns,
  declarations,
  projection: { name: "enabled checks only, sorted by name, only the kind's own members", checks, expected: projectChecks(checks) },
};
const out = process.argv[2];
if (!out) throw new Error("usage: gen_check_vectors.mjs <out.json>");
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`${doc.evaluations.length} evaluations, ${patterns.length} patterns, ${declarations.length} declarations -> ${out}`);
