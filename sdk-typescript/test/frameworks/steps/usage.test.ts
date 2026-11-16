/**
 * The Steps usage pieces: token counts read from the shapes model steps return (`usageFrom`), and a platform's
 * usage turned into what `ap.reportRun` takes (`runReportOf`) — whole counts, the error as its class, never text.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { errorClassOf, runReportOf, usageFrom } from "../../../packages/sdk/src/frameworks/steps/index.js";

test("usage is read from the shapes model steps return", () => {
  assert.deepEqual(usageFrom({ usage: { prompt_tokens: 812, completion_tokens: 96 } }), { inputTokens: 812, outputTokens: 96 });
  assert.deepEqual(usageFrom({ usage: { input_tokens: 10, output_tokens: 2 } }), { inputTokens: 10, outputTokens: 2 });
  assert.deepEqual(usageFrom({ response: { generations: [], llmOutput: { tokenUsage: { promptTokens: 5, completionTokens: 6 } } } }), { inputTokens: 5, outputTokens: 6 });
  assert.deepEqual(usageFrom({ usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 8 } }), { inputTokens: 7, outputTokens: 8 });
  assert.deepEqual(usageFrom({ output: [{ usage: { inputTokens: 1, outputTokens: 3 } }] }), { inputTokens: 1, outputTokens: 3 });
  assert.equal(usageFrom({ text: "no usage here" }), null);
  assert.equal(usageFrom("string"), null);
});

test("a platform's usage becomes ap.reportRun's report: whole counts, a bad count left out, the error as its class only", () => {
  assert.deepEqual(runReportOf({ inputTokens: 812.4, outputTokens: 96, latencyMs: 1499.6 }), { inputTokens: 812, outputTokens: 96, latencyMs: 1500 });
  assert.deepEqual(runReportOf({ inputTokens: -1, outputTokens: Number.NaN }), {});
  assert.deepEqual(runReportOf({ error: "429 Too Many Requests" }), { error: "provider_rate_limited" });
  assert.equal(errorClassOf("upstream timed out"), "provider_timeout");
  assert.equal(errorClassOf("maximum context length exceeded"), "context_length_exceeded");
  assert.equal(errorClassOf("something else"), "provider_error");
});
