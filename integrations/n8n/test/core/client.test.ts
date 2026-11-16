/**
 * The shared platform-agnostic core (identical to the Zapier package's `src/core`) against the SDK's fake control
 * plane, as n8n drives it: no n8n package is loaded here.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { publicJwkOf } from "@airprompter/agent-sdk/core";
import { MemoryKvStore } from "@airprompter/agent-sdk/sync";
import { FakeControlPlane } from "@airprompter/agent-sdk/testing";

import { isAutomationError } from "../../src/core";
import type { RolloutCursor } from "../../src/core";
import { automationDatastore } from "../../src/n8n/connect";
import { abTest, harness } from "../helpers";

const code = (expected: string) => (error: unknown) => isAutomationError(error) && error.code === expected;

test("credential test: fetches and verifies the manifest; a wrong key or a wrong root key fails with a reason", async () => {
  const h = harness();
  h.plane.promote([h.triage("Triage: {{ticket}}", "ver_1")]);
  assert.deepEqual(await h.client().testConnection(), { ok: true, agentId: "agt_n8n", environment: "prod" });

  const wrongKey = await h.client({ updateKey: "apa_live_wrong", datastore: automationDatastore(new MemoryKvStore()) }).testConnection();
  assert.equal(wrongKey.ok, false);
  assert.match((wrongKey as { reason: string }).reason, /refused the Update key/);

  const stranger = new FakeControlPlane({ organizationId: "org_test", agentId: "agt_n8n", target: "prod" });
  const wrongRoot = await h.client({ root: publicJwkOf(stranger.rootKey), datastore: automationDatastore(new MemoryKvStore()) }).testConnection();
  assert.equal(wrongRoot.ok, false);
});

test("Get prompt renders the approved version: prompt, pinned model and inference, slot, version, arm, runRef", async () => {
  const h = harness();
  h.plane.promote([h.triage("Team {{team}}. Triage this ticket: {{ticket}}", "ver_1")]);
  const result = await h.client().getPrompt({ slot: "support.triage", variables: { ticket: "Refund please", stale: "dropped" } });
  assert.match(result.prompt, /^Team Support\. Triage this ticket: /);
  assert.match(result.prompt, /Refund please/);
  assert.equal(result.model, "gpt-5-mini");
  assert.deepEqual(result.inference, { temperature: 0.2, maxOutputTokens: 400 });
  assert.equal(result.versionId, "ver_1");
  assert.equal(result.slot, "support.triage");
  assert.equal(result.generation, 1);
  assert.equal(result.servedFrom, "network");
  assert.ok(result.runRef.length > 20);
  assert.ok(result.leaseExpiresAt);

  h.plane.promote([h.triage("v2 triage: {{ticket}}", "ver_2", 2)]);
  const next = await h.client().getPrompt({ slot: "support.triage", variables: { ticket: "x" } });
  assert.equal(next.versionId, "ver_2");
  assert.equal(next.generation, 2);
});

test("Get prompt refuses an unknown slot and a missing required variable", async () => {
  const h = harness();
  h.plane.promote([h.triage("Triage: {{ticket}}", "ver_1")]);
  const c = h.client();
  await assert.rejects(c.getPrompt({ slot: "nope", variables: {} }), code("unknown_slot"));
  await assert.rejects(c.getPrompt({ slot: "support.triage", variables: {} }), (error: unknown) => code("invalid_input")(error) && /ticket/.test((error as Error).message));
});

test("listSlots and slotVariables: the split in force, and the union of variables across A/B arms", async () => {
  const h = harness();
  const control = h.triage("A {{ticket}}", "ver_a");
  const candidate = h.plane.slot({ tag: "support.triage", text: "B {{ticket}} {{tone}}", versionId: "ver_b", variables: [{ name: "ticket", required: true, trust: "end_user" }, { name: "tone", required: false, trust: "operator" }] });
  h.plane.promote([control], { experiments: [abTest(h, control, candidate, [8000, 2000])] });
  const c = h.client();
  const slots = await c.listSlots();
  assert.equal(slots.length, 1);
  assert.deepEqual(slots[0]!.experiment, { experimentId: "exp_triage", arms: [{ arm: "control", versionId: "ver_a", weightBps: 8000 }, { arm: "candidate", versionId: "ver_b", weightBps: 2000 }] });
  assert.deepEqual((await c.slotVariables("support.triage")).map((v) => [v.name, v.required]), [["ticket", true], ["team", false], ["tone", false]]);
});

test("A/B: sticky per Subject across steps and executions; without a Subject, random per run by the signed weights", async () => {
  const h = harness();
  const control = h.triage("A {{ticket}}", "ver_a");
  const candidate = h.plane.slot({ tag: "support.triage", text: "B {{ticket}}", versionId: "ver_b", variables: [{ name: "ticket", required: true, trust: "end_user" }] });
  h.plane.promote([control], { experiments: [abTest(h, control, candidate, [7000, 3000])] });
  const variables = { ticket: "t" };
  for (const subject of ["customer-1", "customer-2", "customer-3", "customer-4"]) {
    const first = await h.client().getPrompt({ slot: "support.triage", variables, subject });
    for (let i = 0; i < 4; i += 1) assert.equal((await h.client().getPrompt({ slot: "support.triage", variables, subject })).arm, first.arm, `${subject} stays on one arm`);
  }
  const counts: Record<string, number> = { control: 0, candidate: 0 };
  const n = 240;
  const c = h.client();
  for (let i = 0; i < n; i += 1) {
    const r = await c.getPrompt({ slot: "support.triage", variables });
    counts[r.arm]! += 1;
    assert.equal(r.versionId, r.arm === "control" ? "ver_a" : "ver_b");
  }
  const share = counts.candidate! / n;
  assert.ok(share > 0.2 && share < 0.4, `candidate share ${share} should be near 0.30`);
});

test("offline: serves the stored copy when AirPrompter is down, until the lease runs out, then refuses (retryable)", async () => {
  const h = harness();
  h.plane.promote([h.triage("Triage: {{ticket}}", "ver_1")], { leaseSeconds: 3600 });
  await h.client().getPrompt({ slot: "support.triage", variables: { ticket: "a" } });

  h.online.value = false;
  const offline = await h.client().getPrompt({ slot: "support.triage", variables: { ticket: "b" } });
  assert.equal(offline.servedFrom, "stored");
  assert.equal(offline.versionId, "ver_1");

  h.clock.now += 59 * 60 * 1000;
  assert.equal((await h.client().getPrompt({ slot: "support.triage", variables: { ticket: "c" } })).servedFrom, "stored");

  h.clock.now += 2 * 60 * 1000;
  await assert.rejects(h.client().getPrompt({ slot: "support.triage", variables: { ticket: "d" } }), (error: unknown) => code("lease_expired")(error) && (error as { retryable: boolean }).retryable === true);

  h.online.value = true;
  assert.equal((await h.client().getPrompt({ slot: "support.triage", variables: { ticket: "e" } })).servedFrom, "network");
});

test("a tampered stored copy is refused, never served", async () => {
  const h = harness();
  h.plane.promote([h.triage("Triage: {{ticket}}", "ver_1")]);
  await h.client().getPrompt({ slot: "support.triage", variables: { ticket: "a" } });
  h.online.value = false;
  const keys = (await h.kv.list("")).filter((key) => key.includes("/releases/"));
  assert.ok(keys.length >= 1, "a release row was stored");
  for (const key of keys) {
    const entry = (await h.kv.get(key))!;
    const record = JSON.parse(entry.value) as { bundle: { encryption: { ciphertext: string } } };
    const value = record.bundle.encryption.ciphertext;
    record.bundle.encryption.ciphertext = value.slice(0, 40) + (value[40] === "A" ? "B" : "A") + value.slice(41);
    assert.equal(await h.kv.put(key, JSON.stringify(record), { ifVersion: entry.version }), true);
  }
  await assert.rejects(h.client().getPrompt({ slot: "support.triage", variables: { ticket: "b" } }), (error: unknown) => isAutomationError(error) && ["refused", "unreachable"].includes(error.code));
});

test("a release signed by anyone but AirPrompter's root is refused at pull and never stored", async () => {
  const h = harness();
  const stranger = new FakeControlPlane({ organizationId: "org_test", agentId: "agt_n8n", target: "prod" }, h.plane.apiKey);
  stranger.promote([stranger.slot({ tag: "support.triage", text: "Evil {{ticket}}", versionId: "evil", variables: [{ name: "ticket", required: true, trust: "end_user" }] })]);
  await assert.rejects(h.client({ fetch: stranger.fetch() }).getPrompt({ slot: "support.triage", variables: { ticket: "x" } }), (error: unknown) => isAutomationError(error));
  assert.deepEqual((await h.kv.list("")).filter((key) => key.includes("/releases/")), []);
});

test("rollout events: baseline, new version, A/B start, dial-up on the signed ramp, A/B end, rollback", async () => {
  const h = harness();
  h.plane.promote([h.triage("v1 {{ticket}}", "ver_1", 1)]);
  const poll = (cursor: RolloutCursor | null) => h.client().rolloutEvents(cursor);

  let { events, cursor } = await poll(null);
  assert.deepEqual(events.map((e) => e.state), ["current"], "the first poll is the baseline");
  ({ events, cursor } = await poll(cursor));
  assert.deepEqual(events, [], "nothing changed, nothing fires");

  const v2 = h.triage("v2 {{ticket}}", "ver_2", 2);
  h.plane.promote([v2]);
  ({ events, cursor } = await poll(cursor));
  assert.deepEqual(events.map((e) => [e.state, e.versionId, e.previousVersionId]), [["new_version", "ver_2", "ver_1"]]);
  assert.match(events[0]!.id, /^support\.triage:[0-9a-f]+:new_version$/);

  const v3 = h.triage("v3 {{ticket}}", "ver_3", 3);
  const step = new Date(h.clock.now + 2 * 3600 * 1000).toISOString();
  h.plane.promote([v2], { experiments: [abTest(h, v2, v3, [9000, 1000], [{ notBefore: step, weightBps: [5000, 5000] }])] });
  ({ events, cursor } = await poll(cursor));
  assert.deepEqual(events.map((e) => [e.state, e.experiment?.arms.map((a) => a.weightBps)]), [["ab_started", [9000, 1000]]]);

  ({ events, cursor } = await poll(cursor));
  assert.deepEqual(events, []);
  h.clock.now += 2 * 3600 * 1000 + 1000;
  ({ events, cursor } = await poll(cursor));
  assert.deepEqual(events.map((e) => [e.state, e.experiment?.arms.map((a) => a.weightBps)]), [["dial:50-50", [5000, 5000]]], "a ramp step arrives with no new generation");

  h.plane.promote([v2]);
  ({ events, cursor } = await poll(cursor));
  assert.deepEqual(events.map((e) => [e.state, e.versionId]), [["ab_ended", "ver_2"]]);

  h.plane.promote([h.triage("v1 {{ticket}}", "ver_1", 1)]);
  ({ events, cursor } = await poll(cursor));
  assert.deepEqual(events.map((e) => [e.state, e.versionId, e.previousVersionId]), [["rolled_back", "ver_1", "ver_2"]]);
});

test("Report run: tokens and the error class on the run's slot, version and arm; rating as feedback; no prompt text leaves", async () => {
  const h = harness();
  h.plane.promote([h.triage("Secret instructions {{ticket}}", "ver_1")]);
  const prompt = await h.client().getPrompt({ slot: "support.triage", variables: { ticket: "private customer words" } });
  await h.client().reportRun({ runRef: prompt.runRef, inputTokens: 812, outputTokens: 96, latencyMs: 1500, rating: 4, thumbs: "up" });
  await h.client().reportRun({ runRef: prompt.runRef, inputTokens: 10, outputTokens: 0, error: "429 Too Many Requests" });
  const uploaded = [...h.plane.objects.values()].map((bytes) => bytes.toString("utf8")).join("\n");
  assert.ok(uploaded.length > 0, "the rows were delivered");
  assert.doesNotMatch(uploaded, /Secret instructions|private customer words|Too Many Requests/);
  assert.match(uploaded, /812/, "input tokens arrived");
  assert.match(uploaded, /provider_rate_limited/, "the error's class arrived");
  assert.match(uploaded, /rating/, "the rating arrived");

  await assert.rejects(h.client().reportRun({ runRef: "forged.ref" }), code("invalid_input"));
  await assert.rejects(h.client().reportRun({ runRef: prompt.runRef, rating: 9 as 1 }), code("invalid_input"));
});

test("Report run with AirPrompter down fails retryably (n8n's Retry On Fail resends it), then lands", async () => {
  const h = harness();
  h.plane.promote([h.triage("Triage {{ticket}}", "ver_1")]);
  const prompt = await h.client().getPrompt({ slot: "support.triage", variables: { ticket: "a" } });
  h.online.value = false;
  await assert.rejects(h.client().reportRun({ runRef: prompt.runRef, inputTokens: 4242, outputTokens: 7 }), (error: unknown) => code("unreachable")(error) && (error as { retryable: boolean }).retryable);
  h.online.value = true;
  await h.client().reportRun({ runRef: prompt.runRef, inputTokens: 4242, outputTokens: 7 });
  assert.match([...h.plane.objects.values()].map((b) => b.toString("utf8")).join("\n"), /4242/);
});

test("the stored copy is ciphertext under a key derived from the Update key", async () => {
  const h = harness();
  h.plane.promote([h.triage("Very recognisable prompt text {{ticket}}", "ver_1")]);
  await h.client().getPrompt({ slot: "support.triage", variables: { ticket: "a" } });
  const stored = await Promise.all((await h.kv.list("")).map(async (key) => (await h.kv.get(key))!.value));
  assert.doesNotMatch(stored.join("\n"), /Very recognisable/);
});
