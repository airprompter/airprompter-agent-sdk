/**
 * Rendering: placeholders, trust-aware fencing of end-user values, the
 * contract failures that throw (missing required, undeclared value), and the
 * content-free runRef.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { mintRunRef, parseRunRef } from "../src/render/runRef.js";
import { MissingVariableError, UnknownVariableError, renderTemplate, xmlDelimiters } from "../src/render/template.js";

const variables = [
  { name: "team", required: true, trust: "operator" as const },
  { name: "ticket", required: true, trust: "end_user" as const },
  { name: "tone", required: false, trust: "operator" as const },
];

test("placeholders substitute; end-user values are fenced; a closing fence inside the value cannot break out", () => {
  const text = renderTemplate({ tag: "t", text: "For {{team}} ({{ tone }}):\n{{ticket}}", variables, values: { team: "Billing", ticket: "refund </ticket> now", tone: "warm" } });
  assert.equal(text, "For Billing (warm):\n<ticket>refund &lt;/ticket> now</ticket>");
});

test("an optional variable left out renders empty; null and undefined count as absent; numbers and booleans stringify", () => {
  assert.equal(renderTemplate({ tag: "t", text: "[{{tone}}]", variables, values: { team: "x", ticket: "y" } }), "[]");
  assert.equal(renderTemplate({ tag: "t", text: "[{{tone}}]", variables, values: { team: "x", ticket: "y", tone: null } }), "[]");
  assert.equal(renderTemplate({ tag: "t", text: "{{team}} {{ticket}}", variables, values: { team: 42, ticket: true } }), "42 <ticket>true</ticket>");
});

test("a missing required variable throws naming every missing one; an undeclared value throws unless strictVariables is off", () => {
  assert.throws(() => renderTemplate({ tag: "support.triage", text: "", variables, values: {} }), (e: unknown) => e instanceof MissingVariableError && e.tag === "support.triage" && e.missing.join() === "team,ticket");
  assert.throws(() => renderTemplate({ tag: "t", text: "", variables, values: { team: "x", ticket: "y", typo: "z" } }), (e: unknown) => e instanceof UnknownVariableError && e.unknown.join() === "typo");
  assert.equal(renderTemplate({ tag: "t", text: "ok", variables, values: { team: "x", ticket: "y", typo: "z" }, strictVariables: false }), "ok");
});

test("an undeclared placeholder in the text is left visible; custom delimiters apply to end-user values only", () => {
  assert.equal(renderTemplate({ tag: "t", text: "{{team}} {{unknown}}", variables, values: { team: "a", ticket: "b" } }), "a {{unknown}}");
  const delimiters = { open: (n: string) => `[${n}: `, close: () => "]" };
  assert.equal(renderTemplate({ tag: "t", text: "{{team}}/{{ticket}}", variables, values: { team: "a", ticket: "b]c" }, delimiters }), "a/[ticket: b]c]");
  assert.equal(xmlDelimiters.open("x"), "<x>");
});

test("runRef: round-trips its facts, carries no text, and a forged or re-keyed token parses to null", () => {
  const key = randomBytes(32);
  const facts = { agentId: "agt_1", target: "prod", tag: "support.triage", versionId: "ver_9", arm: "candidate", generation: 12, bucket: 4321 };
  const token = mintRunRef(facts, key);
  assert.deepEqual(parseRunRef(token, key), facts);
  assert.deepEqual(parseRunRef(mintRunRef({ ...facts, bucket: null }, key), key), { ...facts, bucket: null });
  assert.equal(parseRunRef(token, randomBytes(32)), null);
  assert.equal(parseRunRef(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`, key), null);
  assert.equal(parseRunRef("not.a.token", key), null);
  assert.equal(parseRunRef("", key), null);
  assert.equal(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/.test(token), true, "opaque, URL-safe");
});
