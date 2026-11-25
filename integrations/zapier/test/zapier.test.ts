/**
 * The Zapier app through `zapier-platform-core`'s app tester, against the local registry (`airprompter dev`'s code):
 * the connection test, the slot dropdown and variable fields, Get prompt (approved version, sticky A/B), the copy kept
 * in `z.cache` serving while the registry is down, a tampered copy and a lapsed lease refused, the trigger's dedupe,
 * and Report run with Zapier's retry on an undeliverable report.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import zapier from "zapier-platform-core";
import App from "../src/zapier/app.js";
import { VARIABLE_PREFIX } from "../src/zapier/steps.js";
import { hostedEnvironmentOf, PRODUCTION_API } from "../src/zapier/connection.js";
import { DEV_API_KEY, SCOPE, abRelease, startRegistry, type Registry } from "../../../sdk-typescript/test/frameworks/steps/registry.js";

const PROMPTS = {
  "support/triage.md": "---\nvariables: team!, ticket?\nversion: triage_v1\n---\nRoute this ticket for {{team}}: {{ticket}}",
  "sales/reply.md": "---\nvariables: name, tone=friendly\nversion: reply_v1\n---\nReply to {{name}} in a {{tone}} tone.",
};

const authOf = (registry: Registry, extra: Record<string, string> = {}) => ({ agentId: SCOPE.agentId, updateKey: DEV_API_KEY, environment: SCOPE.target, baseUrl: registry.baseUrl, rootKey: JSON.stringify(registry.root), ...extra });

type Perform = (z: unknown, bundle: unknown) => Promise<unknown>;
const perform = (step: { operation: { perform: unknown } }) => step.operation.perform as Perform;
const getPrompt = perform(App.creates.get_prompt);
const reportRun = perform(App.creates.report_run);
const slotList = perform(App.triggers.slot_list);
const rollout = perform(App.triggers.rollout_changed);

test("the production API is verified against the production root; anything else names its stage", () => {
  assert.equal(hostedEnvironmentOf(PRODUCTION_API, "prod"), "prod");
  assert.equal(hostedEnvironmentOf(`${PRODUCTION_API}/`, "staging"), "prod");
  assert.equal(hostedEnvironmentOf("http://127.0.0.1:4180", "dev"), "dev");
  assert.equal(hostedEnvironmentOf("https://api.staging.example", "staging"), "staging");
});

test("connection test, slot dropdown, variable fields, Get prompt", async () => {
  const registry = await startRegistry(PROMPTS);
  const appTester = zapier.createAppTester(App);
  try {
    const authData = authOf(registry);
    assert.deepEqual(await appTester(App.authentication.test as Perform, { authData }), { ok: true, agentId: SCOPE.agentId, environment: SCOPE.target });
    await assert.rejects(appTester(App.authentication.test as Perform, { authData: authOf(registry, { updateKey: "apa_wrong" }) }), /reconnect|refused the Update key/i);

    const slots = (await appTester(slotList, { authData })) as Array<{ id: string; name: string }>;
    assert.deepEqual(slots.map((s) => s.id), ["sales.reply", "support.triage"]);
    assert.match(slots[0]!.name, /reply_v1/);

    const dynamic = App.creates.get_prompt.operation.inputFields[1] as unknown as Perform;
    const fields = (await appTester(dynamic, { authData, inputData: { slot: "support.triage" } })) as Array<{ key: string; required: boolean }>;
    assert.deepEqual(fields.map((f) => [f.key, f.required]), [[`${VARIABLE_PREFIX}team`, true], [`${VARIABLE_PREFIX}ticket`, true]]);

    const served = (await appTester(getPrompt, { authData, inputData: { slot: "support.triage", [`${VARIABLE_PREFIX}team`]: "Billing", [`${VARIABLE_PREFIX}ticket`]: "refund please" } })) as Record<string, unknown>;
    assert.equal(served.version_id, "triage_v1");
    assert.equal(served.model, "claude-sonnet-5");
    assert.equal(served.served_from, "network");
    assert.match(String(served.prompt), /^Route this ticket for Billing: /);
    assert.match(String(served.prompt), /refund please/);
    assert.equal(served.id, served.run_ref);

    // A missing required variable fails the step with what to fix (not a retry).
    await assert.rejects(appTester(getPrompt, { authData, inputData: { slot: "support.triage" } }), (e: Error) => e.name !== "ThrottledError" && /team/.test(e.message));
  } finally {
    await registry.close();
  }
});

test("A/B through the app: a Subject is sticky", async () => {
  const registry = await startRegistry(PROMPTS);
  const appTester = zapier.createAppTester(App);
  try {
    const ab = abRelease(registry, { tag: "sales.reply", control: "A {{name}}", candidate: "B {{name}}", weights: [5000, 5000], variables: [{ name: "name", required: false, trust: "operator" }] });
    registry.promote([ab.control], { experiments: [ab.experiment] });
    const authData = authOf(registry);
    const arms = new Set<string>();
    for (let i = 0; i < 4; i += 1) arms.add(String(((await appTester(getPrompt, { authData, inputData: { slot: "sales.reply", subject: "ticket-7", [`${VARIABLE_PREFIX}name`]: "x" } })) as Record<string, unknown>).arm));
    assert.equal(arms.size, 1);
  } finally {
    await registry.close();
  }
});

test("z.cache keeps the signed copy: served while the registry is down; tampered or past the lease it is refused", async () => {
  const registry = await startRegistry(PROMPTS, { leaseSeconds: 3600 });
  const appTester = zapier.createAppTester(App);
  try {
    const authData = authOf(registry);
    const input = { slot: "sales.reply", [`${VARIABLE_PREFIX}name`]: "Ada" };
    assert.equal(((await appTester(getPrompt, { authData, inputData: input })) as Record<string, unknown>).served_from, "network");
    const cache = appTester.zcacheTestObj as Record<string, string>;
    const releaseKey = Object.keys(cache).find((k) => /releases\//.test(k));
    assert.ok(releaseKey, Object.keys(cache).join(", "));
    assert.doesNotMatch(cache[releaseKey!]!, /Reply to/, "ciphertext only in Zapier's storage");

    await registry.down();
    const offline = (await appTester(getPrompt, { authData, inputData: input })) as Record<string, unknown>;
    assert.deepEqual([offline.served_from, offline.prompt], ["stored", "Reply to Ada in a friendly tone."]);

    // Tampered: one character of the sealed release changed in z.cache.
    const original = cache[releaseKey!]!;
    cache[releaseKey!] = original.replace(/(\\"ciphertext\\":\\")(.)/, (_m, head: string, c: string) => `${head}${c === "A" ? "B" : "A"}`);
    assert.notEqual(cache[releaseKey!], original);
    await assert.rejects(appTester(getPrompt, { authData, inputData: input }), /failed verification/);
    cache[releaseKey!] = original;

    // Past the lease (one hour since the last contact): refused, and Zapier is told to retry later.
    // Two hours on the clock with the registry still down.
    const realNow = Date.now;
    Date.now = () => realNow() + 2 * 3600_000;
    try {
      await assert.rejects(appTester(getPrompt, { authData, inputData: input }), (e: Error) => e.name === "ThrottledError" && /lease/.test(e.message));
    } finally {
      Date.now = realNow;
    }
  } finally {
    await registry.close();
  }
});

test("Rollout changed: dedupes by id, emits one item per slot change", async () => {
  const registry = await startRegistry(PROMPTS);
  const appTester = zapier.createAppTester(App);
  try {
    const bundle = { authData: authOf(registry), meta: { zap: { id: 101 } } };
    const first = (await appTester(rollout, bundle)) as Array<{ id: string; change: string }>;
    assert.deepEqual(first.map((e) => e.change), ["current", "current"]);
    assert.deepEqual(await appTester(rollout, bundle), [], "nothing moved");
    registry.edit("sales/reply.md", "---\nvariables: name\nversion: reply_v2\n---\nHi {{name}}");
    const second = (await appTester(rollout, bundle)) as Array<{ id: string; slot: string; change: string; version_id: string }>;
    assert.deepEqual(second.map((e) => [e.slot, e.change, e.version_id]), [["sales.reply", "new_version", "reply_v2"]]);
    assert.match(second[0]!.id, /^sales\.reply:[0-9a-f]{12}:new_version$/);
    // Another Zap on the same connection has its own memory.
    const other = (await appTester(rollout, { ...bundle, meta: { zap: { id: 202 } } })) as Array<{ change: string }>;
    assert.deepEqual(other.map((e) => e.change), ["current", "current"]);
    // Loading a sample does not move the live Zap's memory.
    registry.edit("sales/reply.md", "---\nvariables: name\nversion: reply_v3\n---\nHey {{name}}");
    await appTester(rollout, { ...bundle, meta: { zap: { id: 101 }, isLoadingSample: true } });
    const third = (await appTester(rollout, bundle)) as Array<{ change: string; version_id: string }>;
    assert.deepEqual(third.map((e) => [e.change, e.version_id]), [["new_version", "reply_v3"]]);
  } finally {
    await registry.close();
  }
});

test("Report run: delivered, or a ThrottledError so Zapier retries", async () => {
  const registry = await startRegistry(PROMPTS);
  const appTester = zapier.createAppTester(App);
  try {
    const authData = authOf(registry);
    const served = (await appTester(getPrompt, { authData, inputData: { slot: "sales.reply", [`${VARIABLE_PREFIX}name`]: "Ada" } })) as Record<string, unknown>;
    const before = registry.plane.uploads.length;
    const result = await appTester(reportRun, { authData, inputData: { run_ref: served.run_ref, input_tokens: 812, output_tokens: 96, rating: "5", thumbs: "up" } });
    assert.deepEqual(result, { id: served.run_ref, run_ref: served.run_ref, reported: true });
    assert.equal(registry.plane.uploads.length, before + 1);
    await assert.rejects(appTester(reportRun, { authData, inputData: { run_ref: "forged", input_tokens: 1 } }), (e: Error) => e.name !== "ThrottledError" && /does not verify/.test(e.message));
    await registry.down();
    await assert.rejects(appTester(reportRun, { authData, inputData: { run_ref: served.run_ref, input_tokens: 1, output_tokens: 1 } }), (e: Error) => e.name === "ThrottledError" && /not recorded/.test(e.message));
  } finally {
    await registry.close();
  }
});

test("the API base URL is an https origin (a local registry may use http)", async () => {
  const { baseUrlOf } = await import("../src/zapier/connection.js");
  assert.equal(baseUrlOf("https://api.airprompter.com/"), "https://api.airprompter.com");
  assert.equal(baseUrlOf("http://127.0.0.1:4180"), "http://127.0.0.1:4180");
  assert.throws(() => baseUrlOf("http://api.airprompter.com"), /https/);
  assert.throws(() => baseUrlOf("https://user:pw@api.airprompter.com"), /origin only/);
  assert.throws(() => baseUrlOf("https://api.airprompter.com/v1?x=1"), /origin only/);
});
