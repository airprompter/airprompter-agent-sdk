/**
 * Rendering: placeholders, trust-aware fencing of end-user values, the
 * contract failures that throw (missing required, undeclared value), and the
 * content-free runRef.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { mintRunRef, newRunId, parseRunRef, type RunRefFacts } from "../packages/sdk/src/core/render/runRef.js";
import { MissingVariableError, UnknownVariableError, renderTemplate, xmlDelimiters } from "../packages/sdk/src/core/render/template.js";

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

test("an optional operator variable renders its declared default when nothing fills it; a default elsewhere is ignored", () => {
  const withDefaults = [
    { name: "team", required: true, trust: "operator" as const, default: "never used" },
    { name: "ticket", required: true, trust: "end_user" as const },
    { name: "tone", required: false, trust: "operator" as const, default: "warm", source: "runtime" as const },
    { name: "note", required: false, trust: "end_user" as const, default: "ignored" },
  ];
  assert.equal(renderTemplate({ tag: "t", text: "[{{tone}}][{{note}}]", variables: withDefaults, values: { team: "x", ticket: "y" } }), "[warm][]", "the default is the last resort for an optional operator variable; an end-user one never has one");
  assert.equal(renderTemplate({ tag: "t", text: "[{{tone}}]", variables: withDefaults, values: { team: "x", ticket: "y", tone: "curt" } }), "[curt]", "a value wins over the default");
  assert.equal(renderTemplate({ tag: "t", text: "[{{tone}}]", variables: withDefaults, values: { team: "x", ticket: "y", tone: null } }), "[warm]", "null is not a value");
  assert.throws(() => renderTemplate({ tag: "t", text: "", variables: withDefaults, values: { ticket: "y" } }), (e: unknown) => e instanceof MissingVariableError && e.missing.join() === "team", "a default on a required variable does not excuse it");
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

test("runRef: a two-entry token round-trips, a forged entry fails the MAC, and runId survives a re-mint with one more entry", () => {
  const key = randomBytes(32);
  const entry = { tag: "support.triage", artifactId: "prm_9", versionId: "ver_9", model: "gpt-5", arm: "none", bucket: null, runMinute: "2026-09-12T14:03:00Z" };
  const second = { ...entry, tag: "support.reply", artifactId: "prm_2" };
  const runId = newRunId();
  const one: RunRefFacts = { agentId: "agt_1", target: "prod", runId, entries: [entry] };
  const two = { ...one, entries: [entry, second] };
  const token = mintRunRef(two, key);
  assert.deepEqual(parseRunRef(token, key), two);
  const grown = parseRunRef(mintRunRef({ ...parseRunRef(mintRunRef(one, key), key)!, entries: [entry, second] }, key), key)!;
  assert.equal(grown.runId, runId, "a token that grows keeps the run's identity");
  const [body, mac] = token.split(".") as [string, string];
  const forged = Buffer.from(body, "base64url").toString("utf8").replace('"arm":"none"', '"arm":"gold"');
  assert.equal(parseRunRef(`${Buffer.from(forged).toString("base64url")}.${mac}`, key), null, "the body is what the MAC covers");
  assert.deepEqual(parseRunRef(token, [randomBytes(32), key]), two, "each key is tried");
  assert.equal(parseRunRef(token, []), null);
});

test("runRef: past either minting bound the mint throws, and the reader still takes it", () => {
  const key = randomBytes(32);
  const entries = Array.from({ length: 9 }, (_, i) => ({ tag: `slot.${i}`, artifactId: "prm_9", versionId: "ver_9", model: "gpt-5", arm: "none", bucket: null, runMinute: "2026-09-12T14:03:00Z" }));
  const facts: RunRefFacts = { agentId: "agt_1", target: "prod", runId: newRunId(), entries };
  assert.throws(() => mintRunRef(facts, key), /run_ref_facts_invalid/);
  assert.throws(() => mintRunRef({ ...facts, entries: entries.slice(0, 2).map((entry) => ({ ...entry, tag: "same" })) }, key), /run_ref_facts_invalid/, "tags are unique");
  assert.throws(() => mintRunRef({ ...facts, entries: entries.slice(0, 1), extra: ["x".repeat(12288)] }, key), /run_ref_facts_invalid/, "the length bound");
});

test("runRef: round-trips its facts, carries no text, and a forged or re-keyed token parses to null", () => {
  const key = randomBytes(32);
  const entry = { tag: "support.triage", artifactId: "prm_9", versionId: "ver_9", model: "gpt-5", arm: "candidate", bucket: 4321, runMinute: "2026-09-12T14:03:00Z" };
  const facts: RunRefFacts = { agentId: "agt_1", target: "prod", runId: newRunId(), entries: [entry] };
  const token = mintRunRef(facts, key);
  assert.deepEqual(parseRunRef(token, key), facts);
  assert.deepEqual(parseRunRef(mintRunRef({ ...facts, entries: [{ ...entry, bucket: null }] }, key), key), { ...facts, entries: [{ ...entry, bucket: null }] });
  assert.equal(parseRunRef(token, randomBytes(32)), null);
  assert.equal(parseRunRef(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`, key), null);
  assert.equal(parseRunRef("not.a.token", key), null);
  assert.equal(parseRunRef("", key), null);
  assert.equal(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/.test(token), true, "opaque, URL-safe");
});
