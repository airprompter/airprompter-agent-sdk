/**
 * `@airprompter/agent-sdk/frameworks/steps` against the local registry (`airprompter dev`'s code), with no platform package loaded:
 * connection test, the approved version rendered, sticky and weighted A/B, serving from the stored copy while the
 * registry is down, refusing a tampered copy and a lapsed lease, rollout events and their dedupe, Report run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryReleaseDatastore } from "../../../packages/sdk/src/sync/index.js";
import { AutomationError, createAutomationClient, type AutomationDatastore, type AutomationClientOptions } from "../../../packages/sdk/src/frameworks/steps/index.js";
import { DEV_API_KEY, SCOPE, abRelease, startRegistry, type Registry } from "./registry.js";

const PROMPTS = {
  "support/triage.md": "---\nmodel: claude-sonnet-5\nvariables: team!, ticket?\nversion: triage_v1\n---\nRoute this ticket for {{team}}: {{ticket}}",
  "sales/reply.md": "---\nvariables: name, tone=friendly\nversion: reply_v1\n---\nReply to {{name}} in a {{tone}} tone.",
};

function memoryDatastore(): AutomationDatastore & { notes: Map<string, string> } {
  const notes = new Map<string, string>();
  const datastore = new MemoryReleaseDatastore() as unknown as AutomationDatastore & { notes: Map<string, string> };
  datastore.notes = notes;
  datastore.readNote = async (name) => notes.get(name) ?? null;
  datastore.writeNote = async (name, value) => void notes.set(name, value);
  return datastore;
}

function clientOf(registry: Registry, datastore: AutomationDatastore, extra: Partial<AutomationClientOptions> = {}) {
  return createAutomationClient({ agentId: SCOPE.agentId, updateKey: DEV_API_KEY, baseUrl: registry.baseUrl, environment: SCOPE.target, hostedEnvironment: "dev", root: registry.root, datastore, requestTimeoutMs: 2000, ...extra });
}

const rejectsWith = (code: string) => (error: unknown) => error instanceof AutomationError && error.code === code;

test("connection test: fetch and verify the manifest; a wrong key or an unpinned root says why", async () => {
  const registry = await startRegistry(PROMPTS);
  try {
    assert.deepEqual(await clientOf(registry, memoryDatastore()).testConnection(), { ok: true, agentId: SCOPE.agentId, environment: SCOPE.target });
    const wrongKey = await clientOf(registry, memoryDatastore(), { updateKey: "apa_wrong" }).testConnection();
    assert.equal(wrongKey.ok, false);
    assert.match((wrongKey as { reason: string }).reason, /refused the Update key/);
    const noRoot = createAutomationClient({ agentId: SCOPE.agentId, updateKey: DEV_API_KEY, baseUrl: registry.baseUrl, environment: SCOPE.target, hostedEnvironment: "staging", datastore: memoryDatastore() });
    assert.match(((await noRoot.testConnection()) as { reason: string }).reason, /No AirPrompter root key is pinned/);
    // A root that did not sign this registry: the manifest does not verify, so the connection is not OK.
    const otherRoot = { ...registry.root, x: (await startRegistry(PROMPTS).then(async (r) => { await r.close(); return r.root; })).x };
    assert.equal((await clientOf(registry, memoryDatastore(), { root: { ...registry.root, ...otherRoot } }).testConnection()).ok, false);
  } finally {
    await registry.close();
  }
});

test("Get prompt renders the approved version with the slot's model; dropdown and variables come from the manifest", async () => {
  const registry = await startRegistry(PROMPTS);
  try {
    const datastore = memoryDatastore();
    const client = clientOf(registry, datastore);
    const slots = await client.listSlots();
    assert.deepEqual(slots.map((s) => [s.slot, s.versionId, s.model]), [["sales.reply", "reply_v1", "claude-sonnet-5"], ["support.triage", "triage_v1", "claude-sonnet-5"]]);
    assert.deepEqual(await client.slotVariables("sales.reply"), [{ name: "name", required: false, trust: "operator" }, { name: "tone", required: false, trust: "operator", default: "friendly" }]);
    const served = await client.getPrompt({ slot: "sales.reply", variables: { name: "Ada", tone: "" } });
    assert.equal(served.prompt, "Reply to Ada in a friendly tone.");
    assert.deepEqual([served.slot, served.versionId, served.arm, served.servedFrom, served.generation], ["sales.reply", "reply_v1", "none", "network", 1]);
    assert.ok(served.runRef.length > 20);
    assert.equal(datastore.notes.get("organizationId"), SCOPE.organizationId, "the organization is remembered for offline steps");
    // An approved edit is a new generation; the next step serves it.
    registry.edit("sales/reply.md", "---\nvariables: name, tone=friendly\nversion: reply_v2\n---\nHi {{name}}, ({{tone}})");
    const next = await client.getPrompt({ slot: "sales.reply", variables: { name: "Ada" } });
    assert.deepEqual([next.versionId, next.prompt, next.generation], ["reply_v2", "Hi Ada, (friendly)", 2]);
    await assert.rejects(client.getPrompt({ slot: "support.triage", variables: {} }), rejectsWith("invalid_input"), "a required variable missing");
    await assert.rejects(client.getPrompt({ slot: "nope.none", variables: {} }), rejectsWith("unknown_slot"));
  } finally {
    await registry.close();
  }
});

test("A/B: sticky for a Subject, split roughly by the approved weights without one", async () => {
  const registry = await startRegistry(PROMPTS);
  try {
    const ab = abRelease(registry, { tag: "sales.reply", control: "A {{name}}", candidate: "B {{name}}", weights: [7000, 3000], variables: [{ name: "name", required: false, trust: "operator" }] });
    registry.promote([ab.control], { experiments: [ab.experiment] });
    const client = clientOf(registry, memoryDatastore());
    const first = await client.getPrompt({ slot: "sales.reply", variables: { name: "x" }, subject: "customer-42" });
    for (let i = 0; i < 5; i += 1) {
      const again = await client.getPrompt({ slot: "sales.reply", variables: { name: "x" }, subject: "customer-42" });
      assert.equal(again.arm, first.arm, "the same subject always gets the same arm");
      assert.equal(again.prompt, first.prompt);
    }
    const subjects = await Promise.all(Array.from({ length: 12 }, (_, i) => client.getPrompt({ slot: "sales.reply", variables: { name: "x" }, subject: `customer-${i}` })));
    assert.ok(new Set(subjects.map((s) => s.arm)).size === 2, "different subjects land in both arms");
    let candidate = 0;
    const runs = 200;
    for (let i = 0; i < runs; i += 1) {
      const served = await client.getPrompt({ slot: "sales.reply", variables: { name: "x" } });
      if (served.arm === "candidate") {
        candidate += 1;
        assert.equal(served.versionId, "sales.reply_v2");
        assert.equal(served.prompt, "B x");
      }
    }
    const share = candidate / runs;
    assert.ok(share > 0.2 && share < 0.4, `~30 % on the candidate: ${share}`);
  } finally {
    await registry.close();
  }
});

test("served from the stored copy while the registry is down, until the lease runs out", async () => {
  const registry = await startRegistry(PROMPTS, { leaseSeconds: 3600 });
  try {
    const datastore = memoryDatastore();
    let clock = Date.now();
    const client = clientOf(registry, datastore, { now: () => clock });
    assert.equal((await client.getPrompt({ slot: "sales.reply", variables: { name: "Ada" } })).servedFrom, "network");
    await registry.down();
    clock += 30 * 60 * 1000;
    const offline = await client.getPrompt({ slot: "sales.reply", variables: { name: "Ada" } });
    assert.deepEqual([offline.servedFrom, offline.prompt, offline.versionId], ["stored", "Reply to Ada in a friendly tone.", "reply_v1"]);
    assert.ok(offline.leaseExpiresAt && Date.parse(offline.leaseExpiresAt) > clock);
    assert.equal((await client.listSlots()).length, 2, "the dropdown works offline too");
    clock += 31 * 60 * 1000;
    await assert.rejects(client.getPrompt({ slot: "sales.reply", variables: { name: "Ada" } }), (e: unknown) => e instanceof AutomationError && e.code === "lease_expired" && e.retryable);
    await registry.up();
    assert.equal((await client.getPrompt({ slot: "sales.reply", variables: { name: "Ada" } })).servedFrom, "network", "the next successful contact renews it");
    // Nothing stored and the registry down: a clear, retryable error.
    await registry.down();
    await assert.rejects(clientOf(registry, memoryDatastore()).getPrompt({ slot: "sales.reply", variables: {} }), (e: unknown) => e instanceof AutomationError && e.code === "unreachable" && e.retryable);
  } finally {
    await registry.close();
  }
});

test("a tampered stored copy is refused, never served", async () => {
  const registry = await startRegistry(PROMPTS);
  try {
    const datastore = memoryDatastore();
    const client = clientOf(registry, datastore);
    await client.getPrompt({ slot: "sales.reply", variables: { name: "Ada" } });
    const kv = (datastore as unknown as MemoryReleaseDatastore).kv;
    const releaseKeys = (await kv.list("airprompter/")).filter((k) => /releases\//.test(k));
    assert.equal(releaseKeys.length, 1);
    const entry = (await kv.get(releaseKeys[0]!))!;
    const record = JSON.parse(entry.value) as { bundle: { encryption: { ciphertext?: string } } };
    const sealed = JSON.stringify(record.bundle);
    assert.doesNotMatch(sealed, /Reply to/, "the stored copy holds no prompt text in clear");
    // Flip one character of the sealed payload.
    const tampered = entry.value.replace(/("ciphertext":")(.)/, (_m, head: string, c: string) => `${head}${c === "A" ? "B" : "A"}`);
    assert.notEqual(tampered, entry.value);
    assert.equal(await kv.put(releaseKeys[0]!, tampered, { ifVersion: entry.version }), true);
    await registry.down();
    await assert.rejects(client.getPrompt({ slot: "sales.reply", variables: { name: "Ada" } }), rejectsWith("refused"));
    // With the registry back, a fresh fetch serves; the tampered row is never used.
    await registry.up();
    const served = await client.getPrompt({ slot: "sales.reply", variables: { name: "Ada" } });
    assert.equal(served.prompt, "Reply to Ada in a friendly tone.");
  } finally {
    await registry.close();
  }
});

test("rollout events: one per change, ids stable across polls (slot:digest:state)", async () => {
  const registry = await startRegistry(PROMPTS);
  try {
    const client = clientOf(registry, memoryDatastore());
    const first = await client.rolloutEvents(null);
    assert.deepEqual(first.events.map((e) => e.state), ["current", "current"]);
    for (const event of first.events) assert.match(event.id, /^[a-z.]+:[0-9a-f]{12}:current$/);
    assert.deepEqual((await client.rolloutEvents(first.cursor)).events, [], "nothing changed, nothing emitted");
    const again = await client.rolloutEvents(null);
    assert.deepEqual(again.events.map((e) => e.id), first.events.map((e) => e.id), "the same state is the same id: the platform dedupes");

    // A new approved version.
    const triage1 = registry.plane.slot({ tag: "support.triage", text: "T1 {{team}}", versionId: "triage_v1", variables: [{ name: "team", required: true, trust: "operator" }] });
    const reply1 = registry.plane.slot({ tag: "sales.reply", text: "R1", versionId: "reply_v1" });
    const reply2 = registry.plane.slot({ tag: "sales.reply", text: "R2", versionId: "reply_v2" });
    triage1.versionOrdinal = 1;
    reply1.versionOrdinal = 1;
    reply2.versionOrdinal = 2;
    registry.promote([triage1, reply2]);
    const second = await client.rolloutEvents(first.cursor);
    assert.deepEqual(second.events.map((e) => [e.slot, e.state, e.versionId, e.previousVersionId]), [["sales.reply", "new_version", "reply_v2", "reply_v1"]]);

    // An A/B split starts, then dials up, then ends.
    // Each arm's digest is the whole release as that arm serves it.
    const ab = abRelease(registry, { tag: "sales.reply", control: "R2", candidate: "R3", weights: [9000, 1000] });
    const armsAt = (weights: [number, number]) => [
      { ...ab.experiment.arms[0]!, weightBps: weights[0], releaseDigest: registry.releaseDigest([triage1, reply2]) },
      { ...ab.experiment.arms[1]!, weightBps: weights[1], releaseDigest: registry.releaseDigest([triage1, ab.candidate]) },
    ];
    registry.promote([triage1, reply2], { experiments: [{ ...ab.experiment, arms: armsAt([9000, 1000]) }] });
    const third = await client.rolloutEvents(second.cursor);
    assert.deepEqual(third.events.map((e) => [e.slot, e.state]), [["sales.reply", "ab_started"]]);
    registry.promote([triage1, reply2], { experiments: [{ ...ab.experiment, arms: armsAt([5000, 5000]) }] });
    const fourth = await client.rolloutEvents(third.cursor);
    assert.deepEqual(fourth.events.map((e) => [e.slot, e.state]), [["sales.reply", "dial:50-50"]]);

    // A rollback: a new generation naming the older version (a lower ordinal).
    registry.promote([triage1, reply1]);
    const fifth = await client.rolloutEvents(fourth.cursor);
    assert.deepEqual(fifth.events.map((e) => [e.slot, e.state, e.versionId]), [["sales.reply", "rolled_back", "reply_v1"]]);
    assert.ok(!first.events.some((e) => e.id === fifth.events[0]!.id), "a rollback to a version seen before is still a new id");

    // A slot disabled from the console.
    registry.promote([triage1, reply1], { directives: [{ kind: "disable", scope: "slot", tag: "support.triage", issuedAt: new Date().toISOString(), reason: "incident" }] });
    const sixth = await client.rolloutEvents(fifth.cursor);
    assert.deepEqual(sixth.events.map((e) => [e.slot, e.state]), [["support.triage", "disabled"]]);
    await assert.rejects(client.getPrompt({ slot: "support.triage", variables: { team: "x" } }), rejectsWith("refused"));
  } finally {
    await registry.close();
  }
});

test("Report run: usage and quality land on the run's version and arm; undeliverable is a retryable error", async () => {
  const registry = await startRegistry(PROMPTS);
  try {
    const datastore = memoryDatastore();
    const client = clientOf(registry, datastore);
    const served = await client.getPrompt({ slot: "sales.reply", variables: { name: "Ada" } });
    const before = registry.plane.uploads.length;
    await client.reportRun({ runRef: served.runRef, inputTokens: 812, outputTokens: 96, rating: 4, thumbs: "up", latencyMs: 1500 });
    assert.equal(registry.plane.uploads.length, before + 1, "one segment uploaded under this invocation's grant");
    const rows = [...registry.plane.objects.values()].map((b) => b.toString("utf8")).join("\n").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const windows = rows.filter((row) => row.type === "window" && row.tag === "sales.reply");
    assert.ok(windows.length >= 1, JSON.stringify(rows));
    assert.ok(windows.every((w) => w.versionId === "reply_v1" && w.arm === "none"));
    const text = JSON.stringify(windows);
    assert.match(text, /812/, "input tokens");
    assert.match(text, /96/, "output tokens");
    assert.match(text, /rating/, "the rating");
    assert.doesNotMatch(text, /Ada|Reply to/, "no prompt text, no variable values");

    await assert.rejects(client.reportRun({ runRef: "not-a-run-ref", inputTokens: 1 }), rejectsWith("invalid_input"));
    await assert.rejects(client.reportRun({ runRef: served.runRef, rating: 9 as 5 }), rejectsWith("invalid_input"));
    // A runRef from another connection (another Update key) does not verify here.
    const other = clientOf(registry, memoryDatastore(), { updateKey: "apa_other" });
    await assert.rejects(other.reportRun({ runRef: served.runRef, inputTokens: 1 }), (e: unknown) => e instanceof AutomationError && (e.code === "invalid_input" || e.code === "unauthorized"));

    await registry.down();
    await assert.rejects(client.reportRun({ runRef: served.runRef, inputTokens: 5, outputTokens: 5 }), (e: unknown) => e instanceof AutomationError && e.code === "unreachable" && e.retryable, "not delivered: retried, never dropped silently");
  } finally {
    await registry.close();
  }
});

test("a signed ramp step is a dial-up event when its time comes, with no new generation", async () => {
  const registry = await startRegistry(PROMPTS);
  try {
    const ab = abRelease(registry, { tag: "sales.reply", control: "A", candidate: "B", weights: [10000, 0] });
    const step = new Date(Date.now() + 2 * 3600_000).toISOString();
    registry.promote([ab.control], { experiments: [{ ...ab.experiment, ramp: [{ notBefore: step, weightBps: [7500, 2500] }] }] });
    let clock = Date.now();
    const client = clientOf(registry, memoryDatastore(), { now: () => clock });
    const baseline = await client.rolloutEvents(null);
    assert.deepEqual(baseline.events[0]!.experiment!.arms.map((a) => a.weightBps), [10000, 0]);
    clock = Date.parse(step) + 1000;
    const later = await client.rolloutEvents(baseline.cursor);
    assert.deepEqual(later.events.map((e) => [e.state, e.generation]), [["dial:75-25", baseline.events[0]!.generation]]);
  } finally {
    await registry.close();
  }
});

test("Steps imports no platform package: Zapier and n8n build on it, never the other way round", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../../../packages/sdk/src/frameworks/steps/", import.meta.url);
  for (const file of readdirSync(dir)) {
    const source = readFileSync(new URL(file, dir), "utf8");
    assert.doesNotMatch(source, /from\s+["'](zapier-platform-[\w-]+|n8n-[\w-]+|@n8n\/[\w-]+)["']/, file);
  }
});
