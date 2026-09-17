/**
 * Variable sources: values a prompt needs, filled from the application's own system at render time.
 *
 * Every rule the design pins, against the fake control plane: precedence (call site → source → missing), a
 * source consulted only for a declared variable the version uses (or requires), a sourced `end_user` value fenced,
 * a source stricter than the prompt's declaration fenced and said once, sync `render()` refusing a callable source,
 * a timeout / a throw / an empty required answer as a named failure plus one content-free error row, the slot
 * captured before an await so an activation mid-await cannot mix generations, `needs()` and `status().variables`
 * across arms, a workflow step rendered with its own scan, and the managed client filling before it posts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent } from "../packages/sdk/src/agent.js";
import { publicJwkOf } from "../packages/core/src/protocol/trust.js";
import { ManagedAgent } from "../packages/runtime/src/managed/client.js";
import { VariableSourceRegistry, isVariableSourceError, isVariableSourceRequiredError } from "../packages/runtime/src/variables/sources.js";
import { fillAsync, fillSync, planFill, stricterSources, unsourced } from "../packages/runtime/src/variables/fill.js";
import { releaseDigest } from "../packages/core/src/protocol/trust.js";
import type { WindowRow } from "../packages/telemetry/src/spool/writer.js";
import { FakeControlPlane } from "./helpers/controlPlane.js";

const scope = { organizationId: "org_1", agentId: "agt_1", target: "prod" as const };
const tempDir = () => mkdtempSync(join(tmpdir(), "ap-variables-"));

/** A slot whose text uses `team` and `ticket`; `customer_tier` is declared optional and NOT used by this version. */
function slots(plane: FakeControlPlane, options: { tierInText?: boolean; tierRequired?: boolean } = {}) {
  const tier = options.tierInText ? " The customer is on the {{customer_tier}} plan." : "";
  return [
    plane.slot({
      tag: "support.triage",
      text: `You are a triage assistant for {{team}}.${tier}\nTicket:\n{{ticket}}\nClassify it.`,
      model: "gpt-5",
      variables: [
        { name: "team", required: true, trust: "operator" },
        { name: "ticket", required: true, trust: "end_user" },
        { name: "customer_tier", required: options.tierRequired ?? false, trust: "operator" },
      ],
      versionId: options.tierInText ? "ver_2" : "ver_1",
    }),
  ];
}

async function start(plane: FakeControlPlane, stateDir: string, extra: Partial<Parameters<typeof AirPrompterAgent.start>[0]> = {}) {
  return AirPrompterAgent.start({
    ...scope,
    apiKey: plane.apiKey,
    baseUrl: "https://api.test",
    stateDir,
    root: { pinned: publicJwkOf(plane.rootKey) },
    sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" },
    fetch: plane.fetch(),
    telemetry: { sink: "memory" },
    ...extra,
  });
}

test("the registry: a literal is operator trust; a source names its trust and is bounded; names are content-free", () => {
  const registry = new VariableSourceRegistry({ brand: "Acme" });
  registry.provide("customer_tier", { resolve: async () => "gold", trust: "operator", timeoutMs: 50 });
  assert.deepEqual(registry.names(), ["brand", "customer_tier"]);
  assert.equal(registry.get("brand")?.kind, "literal");
  const source = registry.get("customer_tier");
  assert.equal(source?.kind === "source" && source.timeoutMs, 50);
  assert.throws(() => registry.provide("bad", { resolve: async () => "x" } as never), /trust must be/);
  assert.throws(() => registry.provide("bad name!", "x"), /not a variable name/);
  assert.throws(() => registry.provide("x", { resolve: async () => "x", trust: "operator", timeoutMs: 0 }), /positive/);
  assert.equal(registry.revoke("brand"), true);
  assert.deepEqual(registry.names(), ["customer_tier"]);
});

test("planFill: the call site wins; a source is consulted for a declared variable that is required or in the text, never for one the version dropped; what nobody fills is missing", () => {
  const registry = new VariableSourceRegistry({ team: "Billing", customer_tier: { resolve: async () => "gold", trust: "operator" } });
  const variables = [
    { name: "team", required: true, trust: "operator" as const },
    { name: "ticket", required: true, trust: "end_user" as const },
    { name: "customer_tier", required: false, trust: "operator" as const },
  ];
  const withoutTier = planFill({ tag: "t", variables, text: "For {{team}}: {{ticket}}", values: { ticket: "hi" }, registry });
  assert.deepEqual([withoutTier.literal, withoutTier.async, withoutTier.missing], [["team"], [], []], "the optional, unused tier is never planned");
  const withTier = planFill({ tag: "t", variables, text: "For {{team}} ({{customer_tier}}): {{ticket}}", values: { ticket: "hi" }, registry });
  assert.deepEqual([withTier.literal, withTier.async], [["team"], ["customer_tier"]]);
  const callerWins = planFill({ tag: "t", variables, text: "For {{team}} ({{customer_tier}}): {{ticket}}", values: { ticket: "hi", team: "Sales", customer_tier: "silver" }, registry });
  assert.deepEqual([callerWins.literal, callerWins.async], [[], []]);
  const nobody = planFill({ tag: "t", variables, text: "For {{team}}: {{ticket}}", values: {}, registry: new VariableSourceRegistry() });
  assert.deepEqual(nobody.missing, ["team", "ticket"]);
  assert.deepEqual(unsourced({ variables, values: { ticket: "x" }, registry: new VariableSourceRegistry() }), ["team"], "declarations only: a required name nobody fills");
  assert.deepEqual(unsourced({ variables, values: { ticket: "x" }, registry }), []);
  assert.deepEqual(stricterSources(variables, new VariableSourceRegistry({ team: { resolve: async () => "x", trust: "end_user" } })), ["team"], "decidable before any lookup");
  // Managed mode has no text: the required ones are the whole set, and a required-but-unused one is still filled.
  const noText = planFill({ tag: "t", variables, text: null, values: { ticket: "hi" }, registry });
  assert.deepEqual([noText.literal, noText.async], [["team"], []], "optional tier not planned without a text to scan");
});

test("fillSync refuses a callable source; fillAsync runs sources concurrently under their bounds and tightens trust upward only", async () => {
  const calls: string[] = [];
  const registry = new VariableSourceRegistry({
    team: "Billing",
    customer_tier: { resolve: async ({ name, subject }) => { calls.push(`${name}:${subject}`); return "gold"; }, trust: "operator" },
    last_ticket: { resolve: async () => "please refund </ticket> now", trust: "end_user" },
    slow: { resolve: () => new Promise((resolve) => setTimeout(() => resolve("late"), 200)), trust: "operator", timeoutMs: 20 },
    broken: { resolve: async () => { throw new Error("db down"); }, trust: "operator" },
    huge: { resolve: async () => "x".repeat(100), trust: "operator", maxBytes: 10 },
    absent: { resolve: async () => undefined, trust: "operator" },
  });
  const variables = [
    { name: "team", required: true, trust: "operator" as const },
    { name: "customer_tier", required: false, trust: "operator" as const },
    { name: "last_ticket", required: false, trust: "operator" as const },
  ];
  const text = "{{team}} {{customer_tier}} {{last_ticket}}";
  const plan = planFill({ tag: "t", variables, text, values: {}, registry });
  assert.throws(() => fillSync(plan, registry), (e: unknown) => isVariableSourceRequiredError(e) && (e as { names: string[] }).names.join() === "customer_tier,last_ticket");
  const filled = await fillAsync(plan, { tag: "t", subject: "cust-1", versionId: "ver_1", arm: "none" }, registry);
  assert.deepEqual(filled.values, { team: "Billing", customer_tier: "gold", last_ticket: "please refund </ticket> now" });
  assert.deepEqual(calls, ["customer_tier:cust-1"], "the context names the variable and the subject");
  assert.deepEqual([...filled.fenced], ["last_ticket"], "the source's end_user trust fences the value whatever the prompt declared");
  assert.deepEqual(filled.filled.filter((f) => f.stricter).map((f) => f.name), ["last_ticket"]);
  // A source for a variable the prompt already declares end_user is not "stricter"; the fence comes from the declaration.
  const alreadyFenced = await fillAsync(planFill({ tag: "t", variables: [{ name: "last_ticket", required: false, trust: "end_user" }], text: "{{last_ticket}}", values: {}, registry }), { tag: "t", subject: undefined, versionId: "v", arm: "none" }, registry);
  assert.deepEqual([...alreadyFenced.fenced, alreadyFenced.filled[0]!.stricter], [false]);

  registry.provide("object", { resolve: async () => ({ x: 1 }) as unknown as string, trust: "operator" });
  const failing = (name: string, required = false) => planFill({ tag: "t", variables: [{ name, required, trust: "operator" }], text: `{{${name}}}`, values: {}, registry });
  for (const [name, reason] of [["slow", "timeout"], ["broken", "threw"], ["huge", "too_large"], ["object", "not_text"]] as const) {
    await assert.rejects(fillAsync(failing(name), { tag: "t", subject: undefined, versionId: "v", arm: "none" }, registry), (e: unknown) => isVariableSourceError(e) && (e as { reason: string }).reason === reason, name);
  }
  await assert.rejects(fillAsync(failing("absent", true), { tag: "t", subject: undefined, versionId: "v", arm: "none" }, registry), (e: unknown) => isVariableSourceError(e) && (e as { reason: string }).reason === "empty");
  const optionalAbsent = await fillAsync(failing("absent", false), { tag: "t", subject: undefined, versionId: "v", arm: "none" }, registry);
  assert.equal("absent" in optionalAbsent.values, false, "an optional variable a source has no answer for is left for the render (empty)");

  // Re-registered between plan and fill: a literal that became a source is refused by the sync path and looked up by
  // the async one; a source that became a literal is used as one.
  const swapping = new VariableSourceRegistry({ team: "Billing", customer_tier: { resolve: async () => "gold", trust: "operator" } });
  const swapPlan = planFill({ tag: "t", variables, text: "{{team}} {{customer_tier}}", values: {}, registry: swapping });
  swapping.provide("team", { resolve: async () => "Sales", trust: "operator" });
  swapping.provide("customer_tier", "silver");
  assert.throws(() => fillSync(swapPlan, swapping), (e: unknown) => isVariableSourceRequiredError(e) && (e as { names: string[] }).names.join() === "customer_tier,team");
  const swapped = await fillAsync(swapPlan, { tag: "t", subject: undefined, versionId: "v", arm: "none" }, swapping);
  assert.deepEqual(swapped.values, { team: "Sales", customer_tier: "silver" });
  assert.deepEqual(swapped.filled.map((f) => [f.name, f.from]), [["team", "source"], ["customer_tier", "literal"]]);
});

test("on the agent: a version without the placeholder never calls the source; the next version does with no call-site change; sync render refuses; a sourced end_user value is fenced; the stricter-trust line is said once", async () => {
  const events: Record<string, unknown>[] = [];
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  plane.promote(slots(plane));
  const calls: string[] = [];
  const ap = await start(plane, stateDir, {
    logger: (e) => void events.push(e),
    variables: {
      team: "Billing",
      customer_tier: { resolve: async ({ subject, versionId }) => { calls.push(`${subject}@${versionId}`); return "gold"; }, trust: "end_user" },
    },
  });
  // Version 1 does not use customer_tier: the source is never called, sync render works (only a literal is needed).
  const one = ap.prompt("support.triage", { subject: "cust-1" }).render({ ticket: "printer on fire" });
  assert.match(one.text, /for Billing\./);
  assert.doesNotMatch(one.text, /gold/);
  assert.deepEqual(calls, []);
  const oneAsync = await ap.prompt("support.triage", { subject: "cust-1" }).renderAsync({ ticket: "printer on fire" });
  assert.equal(oneAsync.text, one.text);
  assert.deepEqual(calls, [], "renderAsync does not call a source for a variable the version does not use");

  // Version 2 uses it: sync render refuses (a callable source is needed), renderAsync fills it with no change at the call site.
  plane.promote(slots(plane, { tierInText: true }));
  await ap.syncNow();
  assert.throws(() => ap.prompt("support.triage", { subject: "cust-1" }).render({ ticket: "printer on fire" }), (e: unknown) => isVariableSourceRequiredError(e));
  const two = await ap.prompt("support.triage", { subject: "cust-1" }).renderAsync({ ticket: "printer on fire" });
  assert.deepEqual(calls, ["cust-1@ver_2"]);
  // The source said end_user; the prompt declared operator: the value is fenced, and the runtime says so once.
  assert.match(two.text, /on the <customer_tier>gold<\/customer_tier> plan/);
  await ap.prompt("support.triage", { subject: "cust-2" }).renderAsync({ ticket: "hi" });
  assert.equal(events.filter((e) => e.event === "variable_source_trust_stricter").length, 1);
  assert.deepEqual(events.find((e) => e.event === "variable_source_trust_stricter"), { sdk: "agent-sdk-ts", agentId: "agt_1", target: "prod", event: "variable_source_trust_stricter", tag: "support.triage", name: "customer_tier", declared: "operator" });
  // A call-site value wins over the source, and is fenced by the declaration alone.
  const caller = await ap.prompt("support.triage", { subject: "cust-3" }).renderAsync({ ticket: "hi", customer_tier: "silver" });
  assert.match(caller.text, /on the silver plan/);
  assert.equal(calls.length, 2);
  // An operator source for a variable the prompt declares end_user: the declaration fences it — a source never loosens.
  ap.variables.provide("ticket", { resolve: async () => "sourced </ticket> ticket", trust: "operator" });
  const sourcedTicket = await ap.prompt("support.triage", { subject: "cust-4" }).renderAsync({});
  assert.match(sourcedTicket.text, /<ticket>sourced &lt;\/ticket> ticket<\/ticket>/);
  ap.variables.revoke("ticket");
  // No prompt text or value ever reaches the log.
  for (const e of events) assert.equal(JSON.stringify(e).includes("gold") || JSON.stringify(e).includes("printer"), false);
  await ap.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

test("a failing source is a named error and one content-free error row; needs() and status().variables report what the call site must pass, across arms", async () => {
  const events: Record<string, unknown>[] = [];
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  plane.promote(slots(plane, { tierInText: true, tierRequired: true }));
  let clock = Date.parse("2026-09-17T10:00:10Z");
  const ap = await start(plane, stateDir, { now: () => clock, logger: (e) => void events.push(e), variables: { team: "Billing" } });
  // Nothing fills the required customer_tier: needs() says so before any render; status() lists every required name the call site must pass.
  assert.deepEqual(ap.prompt("support.triage").needs({ ticket: "x" }), ["customer_tier"]);
  assert.deepEqual(ap.status().variables, { sources: ["team"], unsourced: [{ tag: "support.triage", arm: "none", names: ["ticket", "customer_tier"] }] });
  assert.throws(() => ap.prompt("support.triage").render({ ticket: "x" }), /missing required variable customer_tier/);
  clock += 60_000; // the minute closes on the next observation
  ap.report({ tag: "support.triage", versionId: "ver_2", arm: "none", model: "gpt-5", status: "ok", latencyMs: 1 });
  const missingRows = (ap.drainMemorySink().filter((r) => (r as { type: string }).type === "window") as WindowRow[]).filter((r) => r.status === "error");
  assert.deepEqual(missingRows.map((r) => [r.status, r.errorClass, r.count]), [["error", "render_missing_variable", 1]], "the board sees a version this host cannot render");
  assert.equal(JSON.stringify(missingRows).includes("customer_tier"), false, "never a name in a row");

  // A source that fails: the error names the variable and the reason; the log names them too; another error row.
  ap.variables.provide("customer_tier", { resolve: async () => { throw new Error("crm down: token abc123"); }, trust: "operator" });
  assert.deepEqual(ap.prompt("support.triage").needs({ ticket: "x" }), []);
  assert.deepEqual(ap.status().variables.unsourced.map((u) => u.names), [["ticket"]]);
  await assert.rejects(ap.prompt("support.triage").renderAsync({ ticket: "x" }), (e: unknown) => isVariableSourceError(e) && (e as { variable: string; reason: string }).variable === "customer_tier" && (e as { reason: string }).reason === "threw");
  const failed = events.find((e) => e.event === "variable_source_failed");
  assert.deepEqual([failed?.tag, failed?.name, failed?.reason], ["support.triage", "customer_tier", "threw"]);
  assert.equal(JSON.stringify(events).includes("abc123"), false, "the cause never reaches the log");
  clock += 60_000;
  ap.report({ tag: "support.triage", versionId: "ver_2", arm: "none", model: "gpt-5", status: "ok", latencyMs: 1 });
  const rows = (ap.drainMemorySink().filter((r) => (r as { type: string }).type === "window") as WindowRow[]).filter((r) => r.status === "error");
  assert.deepEqual(rows.map((r) => r.errorClass), ["render_missing_variable"]);
  // Revoked: unsourced again.
  ap.variables.revoke("customer_tier");
  assert.deepEqual(ap.status().variables.unsourced.map((u) => u.names), [["ticket", "customer_tier"]]);

  // An experiment whose candidate arm declares one more required variable: status names the arm; a render that lands
  // on the candidate writes its error row with the candidate's version and arm.
  const control = slots(plane, { tierInText: true, tierRequired: true })[0]!;
  const candidate = plane.slot({ tag: "support.triage", text: "Candidate for {{team}} in {{region}}: {{ticket}}", model: "gpt-5", variables: [...control.variables, { name: "region", required: true, trust: "operator" }], versionId: "ver_c" });
  plane.promote([control], { experiment: { experimentId: "exp_1", salt: "AAECAwQFBgcICQoLDA0ODw", subjectKey: "request", arms: [{ arm: "control", weightBps: 0, releaseDigest: releaseDigest([control]), overrides: [] }, { arm: "candidate", weightBps: 10000, releaseDigest: releaseDigest([candidate]), overrides: [candidate] }] } });
  await ap.syncNow();
  assert.deepEqual(ap.status().variables.unsourced, [
    { tag: "support.triage", arm: "candidate", names: ["ticket", "customer_tier", "region"] },
    { tag: "support.triage", arm: "none", names: ["ticket", "customer_tier"] },
  ]);
  ap.variables.provide("customer_tier", "gold");
  assert.throws(() => ap.prompt("support.triage", { subject: "anyone" }).render({ ticket: "x" }), /missing required variable region/);
  clock += 60_000;
  ap.report({ tag: "support.triage", versionId: "ver_2", arm: "none", model: "gpt-5", status: "ok", latencyMs: 1 });
  const candidateRows = (ap.drainMemorySink().filter((r) => (r as { type: string }).type === "window") as WindowRow[]).filter((r) => r.status === "error");
  assert.deepEqual(candidateRows.map((r) => [r.versionId, r.arm, r.errorClass]), [["ver_c", "candidate", "render_missing_variable"]], "the override's version and arm");
  await ap.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

test("the slot is captured before a source is awaited: an activation mid-await renders the generation the render began on, with its run reference", async () => {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  plane.promote(slots(plane, { tierInText: true }));
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ap = await start(plane, stateDir, { variables: { team: "Billing", customer_tier: { resolve: async () => { await gate; return "gold"; }, trust: "operator" } } });
  const generationBefore = ap.generation;
  const pending = ap.prompt("support.triage").renderAsync({ ticket: "x" });
  // A new release lands while the source is still out.
  plane.promote([plane.slot({ tag: "support.triage", text: "Version three for {{team}}: {{ticket}}", model: "gpt-5", variables: [{ name: "team", required: true, trust: "operator" }, { name: "ticket", required: true, trust: "end_user" }], versionId: "ver_3" })]);
  await ap.syncNow();
  assert.equal(ap.generation, generationBefore + 1);
  release!();
  const rendered = await pending;
  assert.equal(rendered.versionId, "ver_2", "the version the render began on");
  assert.equal(rendered.generation, generationBefore);
  assert.match(rendered.text, /on the gold plan/);
  await ap.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

test("a workflow step is rendered with its own scan: the source is called for the step that uses the variable and not for the one that does not", async () => {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  const wf = plane.slot({ tag: "docs.flow", text: "flow", model: "gpt-5", steps: [{ text: "Summarise {{doc}}" }, { text: "Translate for the {{customer_tier}} tier: {{doc}}" }], variables: [{ name: "doc", required: true, trust: "end_user" }, { name: "customer_tier", required: false, trust: "operator" }] });
  plane.promote([wf]);
  const calls: string[] = [];
  const ap = await start(plane, stateDir, { variables: { customer_tier: { resolve: async ({ tag }) => { calls.push(tag); return "gold"; }, trust: "operator" } } });
  const flow = ap.workflow("docs.flow");
  const first = await flow.renderStepAsync("docs.flow#1", { doc: "the doc" });
  assert.equal(first, "Summarise <doc>the doc</doc>");
  assert.deepEqual(calls, []);
  const second = await flow.renderStepAsync("docs.flow#2", { doc: "the doc" });
  assert.equal(second, "Translate for the gold tier: <doc>the doc</doc>");
  assert.deepEqual(calls, ["docs.flow#2"], "the step id is the tag a source sees");
  // A source that fails on a step: the error row names the workflow slot (a step id is not a spool tag), so the
  // segment it lands in stays valid for the uploader.
  ap.variables.provide("customer_tier", { resolve: async () => { throw new Error("no"); }, trust: "operator" });
  await assert.rejects(flow.renderStepAsync("docs.flow#2", { doc: "the doc" }), (e: unknown) => isVariableSourceError(e));
  await ap.stop();
  const stepRows = (ap.drainMemorySink().filter((r) => (r as { type: string }).type === "window") as WindowRow[]).filter((r) => r.status === "error");
  assert.deepEqual(stepRows.map((r) => [r.tag, r.errorClass]), [["docs.flow", "render_missing_variable"]]);
  rmSync(stateDir, { recursive: true, force: true });
});

test("the managed client fills required declared variables from its sources before it posts, and refuses to send an end_user-sourced value the slot declares operator", async () => {
  const plane = new FakeControlPlane(scope);
  plane.promote(slots(plane, { tierInText: true, tierRequired: true }));
  const posted: Array<Record<string, unknown>> = [];
  const inner = plane.fetch();
  const fetchImpl: typeof inner = async (url, init) => {
    if (url.endsWith("/run")) {
      posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return { status: 200, headers: { get: (name: string) => (name === "content-type" ? "text/event-stream" : null) }, text: async () => "", body: null } as unknown as Awaited<ReturnType<typeof inner>>;
    }
    return inner(url, init);
  };
  const agent = await ManagedAgent.start({ agentId: scope.agentId, target: scope.target, apiKey: plane.apiKey, baseUrl: "https://api.test", fetch: fetchImpl as never, variables: { team: "Billing", customer_tier: { resolve: async () => "gold", trust: "operator" } } });
  assert.deepEqual(agent.needs("support.triage", { ticket: "x" }), []);
  assert.deepEqual(agent.needs("support.triage"), ["ticket"]);
  await agent.stream("support.triage", { ticket: "x" }).catch(() => undefined);
  assert.deepEqual(posted[0]?.variables, { ticket: "x", team: "Billing", customer_tier: "gold" });
  // A stricter source is refused before any lookup, as a named error.
  let looked = 0;
  agent.variables.provide("customer_tier", { resolve: async () => { looked += 1; return "gold"; }, trust: "end_user" });
  await assert.rejects(agent.stream("support.triage", { ticket: "x" }), (e: unknown) => isVariableSourceError(e) && (e as { reason: string }).reason === "unfenceable");
  assert.equal(looked, 0, "the customer's system is not called for a value that cannot be sent");
  // A call-site value for that variable makes the source irrelevant, so the run goes.
  await agent.stream("support.triage", { ticket: "x", customer_tier: "gold" }).catch(() => undefined);
  assert.deepEqual(posted.at(-1)?.variables, { ticket: "x", customer_tier: "gold", team: "Billing" });
  // An aborted run is not filled.
  agent.variables.provide("customer_tier", { resolve: async () => { looked += 1; return "gold"; }, trust: "operator" });
  const controller = new AbortController();
  controller.abort(new Error("caller gave up"));
  await assert.rejects(agent.stream("support.triage", { ticket: "x" }, { signal: controller.signal }), /caller gave up/);
  assert.equal(looked, 0);
});
