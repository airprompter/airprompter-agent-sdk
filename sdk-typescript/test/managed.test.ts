/**
 * Managed mode (T23): the catalogue read, then runs over a recorded SSE
 * response. The subject never appears on the wire (the request body is
 * asserted byte for byte); `subjectHash` is the salted client-mode hash;
 * `run()` assembles the done frame; `stream()` yields the deltas in order;
 * refusals are typed with their status; a 429 is retried once per
 * Retry-After and then surfaced; an error frame after the head rejects
 * `result`; a workflow step carries its stepId.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { ManagedAgent, ManagedRunError, parseSse, subjectHash } from "../packages/sdk/src/index.js";

const SALT = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64url");

// Recorded from a dev run on 2026-09-12 (contract 0.2.5 + the next tag's fields).
const CATALOGUE = {
  agentId: "agent-1",
  target: "prod",
  generation: 3,
  releaseDigest: `sha256:${"a".repeat(64)}`,
  slots: [
    { tag: "support.triage", kind: "prompt", model: "anthropic.claude-sonnet-5", variables: [{ name: "team", required: true, trust: "operator" }, { name: "ticket", required: true, trust: "end_user" }], steps: null },
    { tag: "onboarding.flow", kind: "workflow", model: "anthropic.claude-haiku-4-5", variables: [{ name: "name", required: true, trust: "operator" }], steps: [{ stepId: "welcome#1" }, { stepId: "verify#2" }] },
  ],
  experiment: { salt: SALT, subjectKey: "request", arms: ["control", "warmer"] },
};
const DONE = {
  runId: "run_0f3a",
  runRef: "YWdlbnQtMcK3cHJvZMK3c3VwcG9ydC50cmlhZ2XCt3Jldi01wrdub25lwrczwrctwrdydW5fMGYzYQ" + "ABCDEFGHIJKLMNOPQRSTUV",
  output: "Priority: P2. The customer was charged twice; refund and apologise.",
  model: "anthropic.claude-sonnet-5",
  versionId: "rev-5",
  arm: "warmer",
  generation: 3,
  usage: { inputTokens: 412, cachedInputTokens: 256, outputTokens: 37 },
  latencyMs: 812,
  priceMicros: 3200,
  priceBookRevision: "apb-2026-09-11",
  stopReason: "end_turn",
  source: "executed",
};
const sse = (frames: Array<[string, unknown]>) => frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
const RUN_SSE = sse([["delta", { delta: "Priority: P2. " }], ["delta", { delta: "The customer was charged twice; refund and apologise." }], ["done", DONE]]);

function streamOf(text: string, chunkSize = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

type Call = { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } };
function fakeFetch(script: Array<(call: Call) => { status: number; headers?: Record<string, string>; body?: string; stream?: boolean }>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: Call["init"] = {}) => {
    const call = { url, init };
    calls.push(call);
    const step = script.shift();
    if (!step) throw new Error(`unexpected call ${init.method ?? "GET"} ${url}`);
    const reply = step(call);
    const headers = new Map(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: reply.status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      body: reply.stream ? streamOf(reply.body ?? "") : null,
      text: async () => reply.body ?? "",
    };
  };
  return { fetch, calls };
}
const catalogueReply = () => ({ status: 200, headers: { "x-agent-generation": "3" }, body: JSON.stringify(CATALOGUE) });

async function startWith(script: Parameters<typeof fakeFetch>[0]) {
  const { fetch, calls } = fakeFetch([catalogueReply, ...script]);
  const agent = await ManagedAgent.start({ agentId: "agent-1", target: "prod", apiKey: "apr_run_key", baseUrl: "https://run.example/", fetch, sleep: async () => {} });
  return { agent, calls };
}

test("start reads the catalogue with the run key; run() sends the salted subjectHash and never the subject; the recorded stream assembles into the done frame", async () => {
  const { agent, calls } = await startWith([() => ({ status: 200, body: RUN_SSE, stream: true })]);
  assert.equal(calls[0]!.url, "https://run.example/v1/agents/agent-1/targets/prod/slots");
  assert.equal(calls[0]!.init.headers?.authorization, "Bearer apr_run_key");
  assert.deepEqual(agent.slots.slots.map((s) => s.tag), ["support.triage", "onboarding.flow"]);

  const result = await agent.run("support.triage", { team: "Billing", ticket: "charged twice" }, { subject: "user-42", metadata: { trace: "t-1" } });
  assert.deepEqual(result, DONE);
  const run = calls[1]!;
  assert.equal(run.url, "https://run.example/v1/agents/agent-1/targets/prod/run");
  assert.equal(run.init.method, "POST");
  assert.equal(run.init.headers?.accept, "text/event-stream");
  const expectedHash = subjectHash(SALT, "user-42");
  assert.equal(expectedHash, createHash("sha256").update(Buffer.from(SALT, "base64url")).update("user-42").digest("hex"), "the client-mode formula");
  // The wire body, exactly: no subject, the salted hash, streaming on.
  assert.deepEqual(JSON.parse(run.init.body!), { tag: "support.triage", variables: { team: "Billing", ticket: "charged twice" }, stream: true, subjectHash: expectedHash, metadata: { trace: "t-1" } });
  assert.equal(run.init.body!.includes("user-42"), false, "the subject never leaves the process");
});

test("stream() yields deltas in order and resolves result; an error frame after the head rejects result with the route's code", async () => {
  const { agent } = await startWith([() => ({ status: 200, body: RUN_SSE, stream: true }), () => ({ status: 200, body: sse([["delta", { delta: "Prio" }], ["error", { error: "the model is unavailable right now; retry", code: "model_unavailable", retryAfterSeconds: 5 }]]), stream: true })]);
  const stream = await agent.stream("support.triage", { team: "Billing", ticket: "x" });
  const deltas: string[] = [];
  for await (const delta of stream) deltas.push(delta);
  assert.deepEqual(deltas, ["Priority: P2. ", "The customer was charged twice; refund and apologise."]);
  assert.equal((await stream.result).runId, "run_0f3a");

  const failing = await agent.stream("support.triage", { team: "Billing", ticket: "x" });
  const seen: string[] = [];
  for await (const delta of failing) seen.push(delta);
  assert.deepEqual(seen, ["Prio"]);
  await assert.rejects(failing.result, (error: unknown) => error instanceof ManagedRunError && error.code === "model_unavailable" && error.retryAfterSeconds === 5);
});

test("refusals are typed with their status; a 429 retries per Retry-After and then surfaces; nothing else retries", async () => {
  const { agent, calls } = await startWith([
    () => ({ status: 402, body: JSON.stringify({ error: "allowance exhausted", code: "allowance_exhausted" }) }),
    () => ({ status: 429, headers: { "retry-after": "2" }, body: JSON.stringify({ error: "organization runs per minute reached", code: "rate_limited", retryAfterSeconds: 2 }) }),
    () => ({ status: 200, body: RUN_SSE, stream: true }),
    () => ({ status: 429, body: JSON.stringify({ error: "x", code: "agent_rate_limited", retryAfterSeconds: 1 }) }),
    () => ({ status: 429, body: JSON.stringify({ error: "x", code: "agent_rate_limited", retryAfterSeconds: 1 }) }),
    () => ({ status: 429, body: JSON.stringify({ error: "x", code: "agent_rate_limited", retryAfterSeconds: 1 }) }),
    () => ({ status: 400, body: JSON.stringify({ error: "render support.triage: missing required variable ticket", code: "render_missing_variable", detail: "ticket" }) }),
  ]);
  await assert.rejects(agent.run("support.triage", { team: "Billing", ticket: "x" }), (e: unknown) => e instanceof ManagedRunError && e.code === "allowance_exhausted" && e.status === 402);
  const after = await agent.run("support.triage", { team: "Billing", ticket: "x" });
  assert.equal(after.runId, "run_0f3a", "one 429 then success");
  await assert.rejects(agent.run("support.triage", { team: "Billing", ticket: "x" }), (e: unknown) => e instanceof ManagedRunError && e.code === "agent_rate_limited" && e.status === 429, "two retries, then the refusal");
  await assert.rejects(agent.run("support.triage", { team: "Billing" }), (e: unknown) => e instanceof ManagedRunError && e.code === "render_missing_variable" && e.detail === "ticket");
  assert.equal(calls.length, 1 + 1 + 2 + 3 + 1, "no retry on anything but 429");
});

test("a workflow step carries its stepId; the catalogue lists the steps; start() refuses a target that is not hosted", async () => {
  const { agent, calls } = await startWith([() => ({ status: 200, body: RUN_SSE, stream: true })]);
  const flow = agent.workflow("onboarding.flow", { subject: "user-42" });
  assert.deepEqual(flow.steps.map((s) => s.stepId), ["welcome#1", "verify#2"]);
  await flow.step("welcome#1", { name: "Ada" });
  const body = JSON.parse(calls[1]!.init.body!) as Record<string, unknown>;
  assert.equal(body.tag, "onboarding.flow");
  assert.equal(body.stepId, "welcome#1");
  assert.equal(typeof body.subjectHash, "string");

  const { fetch } = fakeFetch([() => ({ status: 403, body: JSON.stringify({ error: "this environment runs on your systems; hosted runs are not enabled for it", code: "target_not_hosted", detail: "dev" }) })]);
  await assert.rejects(ManagedAgent.start({ agentId: "agent-1", target: "dev", apiKey: "k", baseUrl: "https://run.example", fetch }), (e: unknown) => e instanceof ManagedRunError && e.code === "target_not_hosted" && e.status === 403);
});

test("SSE parsing survives arbitrary chunk boundaries and multi-line data", async () => {
  const text = "event: delta\ndata: {\"delta\":\"a\\nb\"}\n\nevent: done\ndata: {\"x\":1}\n\n";
  for (const size of [1, 3, 5, 64]) {
    const chunks = (async function* () {
      for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
    })();
    const frames: Array<{ event: string; data: string }> = [];
    for await (const frame of parseSse(chunks)) frames.push(frame);
    assert.deepEqual(frames, [{ event: "delta", data: '{"delta":"a\\nb"}' }, { event: "done", data: '{"x":1}' }], `chunk ${size}`);
  }
});

// T30: feedback against a hosted run's runRef, from any process holding the run key.
test("feedback(runRef, signals) posts to the run surface's feedback route and returns what landed; a bad ref is a typed refusal", async () => {
  const { agent, calls } = await startWith([
    (call) => {
      const body = JSON.parse(call.init.body ?? "{}") as { runRef: string; signals: Record<string, unknown> };
      assert.equal(body.runRef, DONE.runRef);
      assert.deepEqual(body.signals, { accepted: true, rating: 4, note: "text" });
      return { status: 202, body: JSON.stringify({ accepted: true, attributedTo: { tag: "support.triage", versionId: "rev-5", arm: "none", minute: "2026-09-12T10:03:00Z" }, rejected: { note: "unknown_signal" } }) };
    },
    () => ({ status: 400, body: JSON.stringify({ error: "the runRef does not verify", code: "invalid_run_ref" }) }),
  ]);
  const answer = await agent.feedback(DONE.runRef, { accepted: true, rating: 4, note: "text" });
  assert.deepEqual({ accepted: answer.accepted, arm: answer.attributedTo?.arm, rejected: answer.rejected }, { accepted: true, arm: "none", rejected: { note: "unknown_signal" } });
  const call = calls[1]!;
  assert.equal(call.url, "https://run.example/v1/agents/agent-1/targets/prod/feedback");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers?.authorization, "Bearer apr_run_key");
  await assert.rejects(agent.feedback("forged", { accepted: true }), (e: unknown) => e instanceof ManagedRunError && e.code === "invalid_run_ref" && e.status === 400);
});

test("S17: per-prompt experiments — a run on each slot hashes the subject with THAT slot's salt; a slot outside every experiment sends no hash; the legacy single experiment still covers every slot", async () => {
  const SALT_B = "EBESExQVFhcYGRobHB0eHyAhIiMkJSYn";
  const perPrompt = { ...CATALOGUE, experiment: { salt: SALT, subjectKey: "request", arms: ["control", "candidate"] }, experiments: [{ experimentId: "exp_a", tag: "support.triage", salt: SALT, subjectKey: "request", arms: ["control", "candidate"] }, { experimentId: "exp_b", tag: "onboarding.flow", salt: SALT_B, subjectKey: "request", arms: ["control", "candidate"] }] };
  const { fetch, calls } = fakeFetch([() => ({ status: 200, headers: { "x-agent-generation": "3" }, body: JSON.stringify(perPrompt) }), () => ({ status: 200, body: RUN_SSE, stream: true }), () => ({ status: 200, body: RUN_SSE, stream: true })]);
  const agent = await ManagedAgent.start({ agentId: "agent-1", target: "prod", apiKey: "apr_run_key", baseUrl: "https://run.example/", fetch, sleep: async () => {} });
  await agent.run("support.triage", { team: "Billing", ticket: "x" }, { subject: "user-42" });
  await agent.run("onboarding.flow", { name: "Ada" }, { subject: "user-42", stepId: "welcome#1" });
  assert.equal(JSON.parse(calls[1]!.init.body!).subjectHash, subjectHash(SALT, "user-42"));
  assert.equal(JSON.parse(calls[2]!.init.body!).subjectHash, subjectHash(SALT_B, "user-42"), "own salt per slot");
  assert.equal(agent.experimentFor("docs.missing"), null, "a slot outside every experiment");
  assert.equal(agent.subjectHashFor("user-42", "docs.missing"), undefined);
  assert.deepEqual(agent.experimentFor("onboarding.flow")?.arms, ["control", "candidate"]);
  // The legacy catalogue (one `experiment`, no list): every slot hashes on it.
  const { agent: legacy } = await startWith([]);
  assert.equal(legacy.subjectHashFor("user-42", "onboarding.flow"), subjectHash(SALT, "user-42"));
});
