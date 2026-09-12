/**
 * T11 (AIR-1941): `observe()` — usage read off OpenAI, Anthropic and Bedrock
 * shapes (OpenAI's cached tokens split out of prompt_tokens), a completed
 * call that truncated or was filtered counted as its error class, thrown
 * failures classified into the closed set by code and status (never by
 * carrying the message), the result returned unchanged and the error
 * re-thrown; the serverless buffer evicting its oldest rows past 256 KiB and
 * reporting a `dropped` row on drain; the host spool evicting its oldest
 * closed segments past the budget and writing a `dropped` row into the next
 * segment; every row still content-free.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DirectorySink, MemorySink, SpoolWriter, type SpoolRow, type WindowRow } from "../src/spool/writer.js";
import { classifyError, classifyResult, normalizeUsage, observeCall } from "../src/telemetry/observe.js";

const target = { tag: "support.triage", versionId: "ver_1", arm: "none", model: "gpt-5" };

test("usage: OpenAI (cached split out of prompt_tokens), Anthropic, Bedrock Converse, nested response shapes, and none", () => {
  assert.deepEqual(normalizeUsage({ usage: { prompt_tokens: 500, completion_tokens: 90, prompt_tokens_details: { cached_tokens: 300 } } }), { input: 200, cachedInput: 300, output: 90, source: "reported" });
  assert.deepEqual(normalizeUsage({ usage: { prompt_tokens: 500, completion_tokens: 90 } }), { input: 500, cachedInput: 0, output: 90, source: "reported" });
  assert.deepEqual(normalizeUsage({ usage: { input_tokens: 400, output_tokens: 70, cache_read_input_tokens: 100 } }), { input: 400, cachedInput: 100, output: 70, source: "reported" });
  assert.deepEqual(normalizeUsage({ usage: { inputTokens: 380, outputTokens: 60, cacheReadInputTokens: 20 } }), { input: 380, cachedInput: 20, output: 60, source: "reported" });
  assert.deepEqual(normalizeUsage({ response: { usage: { input_tokens: 1, output_tokens: 2 } } }), { input: 1, cachedInput: 0, output: 2, source: "reported" });
  assert.deepEqual(normalizeUsage({ text: "hello" }), { input: 0, cachedInput: 0, output: 0, source: "unavailable" });
  assert.deepEqual(normalizeUsage(null), { input: 0, cachedInput: 0, output: 0, source: "unavailable" });
  assert.deepEqual(normalizeUsage({ usage: { prompt_tokens: -4, completion_tokens: "x" } }), { input: 0, cachedInput: 0, output: 0, source: "unavailable" }, "nonsense is unavailable, never negative");
});

test("a completed call still classifies: truncation and content filtering across providers; a clean finish is null", () => {
  assert.equal(classifyResult({ choices: [{ finish_reason: "length" }] }), "truncated");
  assert.equal(classifyResult({ stop_reason: "max_tokens" }), "truncated");
  assert.equal(classifyResult({ stopReason: "max_tokens" }), "truncated");
  assert.equal(classifyResult({ choices: [{ finish_reason: "content_filter" }] }), "content_filter");
  assert.equal(classifyResult({ stopReason: "guardrail_intervened" }), "content_filter");
  assert.equal(classifyResult({ choices: [{ finish_reason: "stop" }] }), null);
  assert.equal(classifyResult({ stop_reason: "end_turn" }), null);
  assert.equal(classifyResult("text"), null);
});

test("thrown failures classify by code and status into the closed set; the unknown is provider_error", () => {
  assert.equal(classifyError(Object.assign(new Error("Request timed out"), { code: "ETIMEDOUT" })), "provider_timeout");
  assert.equal(classifyError(Object.assign(new Error("aborted"), { name: "AbortError" })), "provider_timeout");
  assert.equal(classifyError({ status: 504 }), "provider_timeout");
  assert.equal(classifyError({ status: 429 }), "provider_rate_limited");
  assert.equal(classifyError({ error: { type: "rate_limit_error" } }), "provider_rate_limited");
  assert.equal(classifyError(Object.assign(new Error("Too many requests"), { name: "ThrottlingException", $metadata: { httpStatusCode: 400 } })), "provider_rate_limited");
  assert.equal(classifyError({ code: "context_length_exceeded" }), "context_length_exceeded");
  assert.equal(classifyError(new Error("prompt is too long: 210000 tokens > 200000 maximum")), "context_length_exceeded");
  assert.equal(classifyError({ code: "content_policy_violation" }), "content_filter");
  assert.equal(classifyError(Object.assign(new Error("missing team"), { name: "MissingVariableError" })), "render_missing_variable");
  assert.equal(classifyError(new Error("something odd")), "provider_error");
  assert.equal(classifyError(undefined), "provider_error");
});

test("observeCall: times the call, returns the result unchanged, re-throws an error after counting it, and the observation carries no text", async () => {
  let clock = 1_000;
  const observations: Array<Parameters<Parameters<typeof observeCall>[2]>[0]> = [];
  const record = (o: (typeof observations)[number]) => void observations.push(o);
  const result = await observeCall(target, async () => {
    clock += 812;
    return { choices: [{ message: { content: "the secret answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 400, completion_tokens: 90, prompt_tokens_details: { cached_tokens: 100 } } };
  }, record, { now: () => clock, checks: { passed: 1 } });
  assert.equal(result.choices[0]!.message.content, "the secret answer", "returned unchanged");
  assert.deepEqual(observations[0], { ...target, status: "ok", errorClass: null, latencyMs: 812, tokens: { input: 300, cachedInput: 100, output: 90 }, usageSource: "reported", checks: { passed: 1 } });
  assert.equal(JSON.stringify(observations[0]).includes("secret"), false);
  await assert.rejects(
    () => observeCall(target, async () => { clock += 30_000; throw Object.assign(new Error("Rate limit reached for gpt-5: the secret prompt"), { status: 429 }); }, record, { now: () => clock, model: "gpt-5-mini" }),
    /Rate limit reached/,
  );
  assert.deepEqual(observations[1], { ...target, model: "gpt-5-mini", status: "error", errorClass: "provider_rate_limited", latencyMs: 30_000, usageSource: "unavailable" });
  const truncated = await observeCall(target, () => ({ stop_reason: "max_tokens", usage: { input_tokens: 10, output_tokens: 4096 } }), record, { now: () => clock });
  assert.equal(truncated.stop_reason, "max_tokens");
  assert.equal(observations[2]!.status, "error");
  assert.equal(observations[2]!.errorClass, "truncated");
  assert.equal(observations[2]!.tokens?.output, 4096);
});

test("the serverless buffer: past its budget the oldest rows go and one dropped row reports the loss on drain; under it nothing is lost", () => {
  const sink = new MemorySink({ instanceId: "i-7f3aQx9kLmN2pQ" }, 2048);
  const writer = new SpoolWriter(sink, { instanceId: "i-7f3aQx9kLmN2pQ", instanceClass: "ephemeral", sdk: "agent-sdk-ts/0.1.0" });
  let now = Date.parse("2026-09-12T14:03:00Z");
  // Twenty distinct dimension sets a minute → twenty windows of ~300 bytes: well past 2 KiB.
  for (let i = 0; i < 20; i += 1) writer.observe({ tag: `slot.${i}`, versionId: "v", arm: "none", model: "m", status: "ok", latencyMs: 10 + i, tokens: { input: 1, output: 1 } }, now);
  now += 60_000;
  writer.closeWindows(now);
  const rows = sink.drain(now) as SpoolRow[];
  const windows = rows.filter((r): r is WindowRow => r.type === "window");
  const dropped = rows.filter((r) => r.type === "dropped");
  assert.equal(dropped.length, 1, "one dropped row");
  assert.equal(windows.length + (dropped[0] as { segments: number }).segments, 20, "every window is either kept or counted as dropped");
  assert.ok(windows.length >= 1 && windows.length < 20);
  assert.equal(windows[windows.length - 1]!.tag, "slot.19", "the newest survive; the oldest went");
  assert.ok((dropped[0] as { bytes: number }).bytes > 0);
  assert.deepEqual(sink.drain(now), [], "drained, and the loss is not reported twice");
  const roomy = new MemorySink({ instanceId: "i-7f3aQx9kLmN2pQ" });
  const w2 = new SpoolWriter(roomy, { instanceId: "i-7f3aQx9kLmN2pQ", instanceClass: "ephemeral", sdk: "agent-sdk-ts/0.1.0" });
  for (let i = 0; i < 20; i += 1) w2.observe({ tag: `slot.${i}`, versionId: "v", arm: "none", model: "m", status: "ok", latencyMs: 10, tokens: { input: 1, output: 1 } }, now);
  w2.closeWindows(now + 60_000);
  assert.equal(roomy.drain().filter((r) => r.type === "dropped").length, 0);
});

test("the host spool: past its budget the oldest closed segments are evicted and the loss is written at once as its own closed segment", () => {
  const dir = mkdtempSync(join(tmpdir(), "ap-spool-budget-"));
  try {
    const sink = new DirectorySink(dir, "i-7f3aQx9kLmN2pQ", 1500);
    const writer = new SpoolWriter(sink, { instanceId: "i-7f3aQx9kLmN2pQ", instanceClass: "resident", sdk: "agent-sdk-ts/0.1.0" });
    let now = Date.parse("2026-09-12T14:03:00Z");
    // Six minutes, one ~300-byte window each: the third close crosses 1.5 KiB and the oldest segments go.
    for (let minute = 0; minute < 6; minute += 1) {
      writer.observe({ tag: "support.triage", versionId: "v", arm: "none", model: "m", status: "ok", latencyMs: 100, tokens: { input: 10, output: 5 } }, now);
      now += 60_000;
      writer.closeWindows(now);
    }
    const segments = readdirSync(dir).filter((n) => n.startsWith("seg-") && n.endsWith(".ndjson")).sort();
    assert.ok(segments.length < 6 && segments.length >= 3, `oldest segments evicted (${segments.length} left)`);
    const rows = segments.flatMap((name) => readFileSync(join(dir, name), "utf8").trim().split("\n").map((line) => JSON.parse(line) as SpoolRow));
    const dropped = rows.filter((r): r is Extract<SpoolRow, { type: "dropped" }> => r.type === "dropped");
    assert.ok(dropped.length >= 1, "the loss is reported");
    const windowsKept = rows.filter((r) => r.type === "window").length;
    assert.ok(windowsKept + dropped.reduce((s, r) => s + r.segments, 0) >= 6, "every minute's window is kept or counted in an eviction (an evicted dropped-row segment counts too)");
    assert.ok(windowsKept < 6, "some windows went");
    for (const row of dropped) {
      assert.ok(row.bytes > 0);
      assert.match(row.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.deepEqual(Object.keys(row).sort(), ["at", "bytes", "instanceId", "segments", "type", "v"]);
    }
    const bytes = segments.reduce((s, n) => s + readFileSync(join(dir, n)).length, 0);
    assert.ok(bytes <= 1500 + 400, `within the budget plus one segment (${bytes})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
