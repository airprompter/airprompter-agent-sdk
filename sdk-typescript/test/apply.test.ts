/**
 * T9 (AIR-1939): apply control on the runtime — the update window (parsing,
 * boundaries, wrap, named days, a DST night), a staged release activating
 * inside the window and waiting outside it; the local window winning over
 * the manifest's; the hook that rejects keeping the release staged; a
 * Freeze honoured from a manifest that is otherwise left staged (directives
 * before the apply decision); the heartbeat body (the protocol's shape,
 * content-free, the cadence adopted from the answer, the open request
 * reported as seen); halt without a way home degrading.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent, RenderRefusedError } from "../packages/sdk/src/agent.js";
import { parseWindow, windowState } from "../packages/sync/src/apply/window.js";
import { publicJwkOf, releaseDigest } from "../packages/core/src/protocol/trust.js";
import { requiredModelsMissing } from "../packages/sync/src/sync/loop.js";
import { FakeControlPlane } from "./helpers/controlPlane.js";

const scope = { organizationId: "org_1", agentId: "agt_1", target: "prod" as const };
const tempDir = () => mkdtempSync(join(tmpdir(), "ap-apply-"));

function slots(plane: FakeControlPlane) {
  return [
    plane.slot({ tag: "support.triage", text: "Triage {{ticket}}.", variables: [{ name: "ticket", required: true, trust: "end_user" }] }),
    plane.slot({ tag: "support.reply", text: "Reply to {{name}}.", variables: [{ name: "name", required: false, trust: "operator" }], model: "gpt-5" }),
  ];
}

async function start(plane: FakeControlPlane, stateDir: string, extra: Partial<Parameters<typeof AirPrompterAgent.start>[0]> = {}) {
  return AirPrompterAgent.start({
    ...scope,
    apiKey: plane.apiKey,
    baseUrl: "https://api.test",
    stateDir,
    root: { pinned: publicJwkOf(plane.rootKey) },
    sync: { mode: "resident", pollSeconds: 3600, edgePointerUrl: "https://edge.test/g/token/generation.json", rootUrl: "https://edge.test/roots/prod/root.json" },
    fetch: plane.fetch(),
    ...extra,
  });
}

test("the window: parsing, half-open boundaries in the zone, wrap past midnight, named days, and a DST night", () => {
  const berlin = parseWindow("02:00-04:00 Europe/Berlin");
  assert.deepEqual(berlin, { timezone: "Europe/Berlin", start: "02:00", end: "04:00" });
  const at = (iso: string) => Date.parse(iso);
  assert.equal(windowState(berlin, at("2026-09-12T00:00:00Z")).open, true, "02:00 CEST, the first minute");
  assert.equal(windowState(berlin, at("2026-09-11T23:59:59Z")).open, false);
  const closed = windowState(berlin, at("2026-09-12T02:00:00Z"));
  assert.equal(closed.open, false, "04:00 is outside");
  assert.equal(new Date(closed.opensAtMs).toISOString(), "2026-09-13T00:00:00.000Z", "next opening tomorrow");
  const night = parseWindow("22:00-04:00 Europe/Berlin");
  assert.equal(windowState(night, at("2026-09-12T01:00:00Z")).open, true, "03:00 CEST inside the window that opened the evening before");
  const weekend = parseWindow("14:00-15:00 Asia/Tokyo sat,sun");
  assert.deepEqual(weekend.days, ["sat", "sun"]);
  assert.equal(windowState(weekend, at("2026-09-12T05:30:00Z")).open, true, "Saturday");
  assert.equal(windowState(weekend, at("2026-09-14T05:30:00Z")).open, false, "Monday");
  assert.equal(new Date(windowState(weekend, at("2026-09-14T05:30:00Z")).opensAtMs).toISOString(), "2026-09-19T05:00:00.000Z");
  // Fall back 2026-10-25: 02:00 CEST = 00:00Z, 04:00 CET = 03:00Z — three hours of wall clock.
  const fall = windowState(berlin, at("2026-10-25T00:30:00Z"));
  assert.equal(fall.open, true);
  assert.equal(new Date(fall.closesAtMs).toISOString(), "2026-10-25T03:00:00.000Z");
  // Spring forward 2026-03-29: 02:00 does not exist; the window opens where the clock lands (03:00 CEST = 01:00Z).
  const spring = windowState(berlin, at("2026-03-29T01:30:00Z"));
  assert.equal(spring.open, true);
  assert.equal(new Date(spring.closesAtMs).toISOString(), "2026-03-29T02:00:00.000Z");
  assert.throws(() => parseWindow("02:00-02:00 Europe/Berlin"), /a window has a length/);
  assert.throws(() => parseWindow("02:00-04:00 Mars/Olympus_Mons"), /unknown time zone/);
  assert.throws(() => parseWindow("2-4 Europe/Berlin"), /expected/);
  assert.throws(() => parseWindow("02:00-04:00 Europe/Berlin mon,funday"), /unknown day/);
});

test("unlock_required + window: staged outside the window, activated on its own when it opens; inside the window it activates on stage; a local window wins over the manifest's", async () => {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  const [triage, reply] = slots(plane);
  plane.promote([triage!, reply!]);
  // 2026-09-12 01:00 CEST (23:00Z the day before): outside a 02:00–04:00 Berlin window; it opens in an hour.
  let clock = Date.parse("2026-09-11T23:00:00Z");
  const ap = await start(plane, stateDir, { now: () => clock, apply: { window: "02:00-04:00 Europe/Berlin" } });
  const reply2 = plane.slot({ tag: "support.reply", text: "Reply warmly to {{name}}.", variables: [{ name: "name", required: false, trust: "operator" }], versionId: "ver_reply_2" });
  plane.promote([triage!, reply2], { applyPolicy: "unlock_required" });
  await ap.syncNow();
  assert.equal(ap.status().applyState, "awaiting_unlock");
  assert.deepEqual({ open: ap.status().window?.open, source: ap.status().window?.source, opensAt: ap.status().window?.opensAt }, { open: false, source: "local", opensAt: "2026-09-12T00:00:00.000Z" });
  // The clock reaches the window: the timer (real time, so we drive it by hand through the same path) activates the staged release.
  clock = Date.parse("2026-09-12T00:00:30Z");
  await (ap as unknown as { scheduleWindowUnlock: () => void }).scheduleWindowUnlock();
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal(ap.generation, 2, "activated when the window opened");
  assert.equal(ap.status().applyState, "active");
  // Inside the window, a new staged release activates on stage.
  const reply3 = plane.slot({ tag: "support.reply", text: "Reply thrice to {{name}}.", variables: [{ name: "name", required: false, trust: "operator" }], versionId: "ver_reply_3" });
  plane.promote([triage!, reply3], { applyPolicy: "unlock_required" });
  await ap.syncNow();
  assert.equal(ap.generation, 3, "window open on stage: live at once");
  await ap.stop();
  rmSync(stateDir, { recursive: true, force: true });

  // The manifest's window governs when there is no local one; a local one wins (narrower) when both exist.
  const dir2 = tempDir();
  const plane2 = new FakeControlPlane(scope);
  const [t2, r2] = slots(plane2);
  plane2.promote([t2!, r2!]);
  let clock2 = Date.parse("2026-09-12T00:30:00Z"); // 02:30 CEST
  const carried = await start(plane2, dir2, { now: () => clock2 });
  plane2.promote([t2!, plane2.slot({ tag: "support.reply", text: "R2 {{name}}.", variables: [{ name: "name", required: false, trust: "operator" }], versionId: "v2" })], { applyPolicy: "unlock_required", unlockWindow: { timezone: "Europe/Berlin", start: "02:00", end: "04:00" } });
  await carried.syncNow();
  assert.equal(carried.generation, 2, "the manifest's window was open: activated");
  assert.equal(carried.status().window?.source, "manifest");
  await carried.stop();
  // The same store (generation 2 active) with a narrower local window: the manifest's open window does not widen it.
  const narrower = await start(plane2, dir2, { now: () => clock2, apply: { window: "03:00-04:00 Europe/Berlin" } });
  plane2.promote([t2!, plane2.slot({ tag: "support.reply", text: "R3 {{name}}.", variables: [{ name: "name", required: false, trust: "operator" }], versionId: "v3" })], { applyPolicy: "unlock_required", unlockWindow: { timezone: "Europe/Berlin", start: "02:00", end: "04:00" } });
  await narrower.syncNow();
  assert.equal(narrower.status().applyState, "awaiting_unlock", "the local 03:00 window is not open at 02:30, whatever the manifest says");
  assert.equal(narrower.status().window?.source, "local");
  await narrower.stop();
  rmSync(dir2, { recursive: true, force: true });
});

test("the hook: rejecting keeps the release staged; activating inside it goes live; the console's open request is handed to it and reported as seen", async () => {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  const [triage, reply] = slots(plane);
  plane.promote([triage!, reply!]);
  const seen: Array<{ generation: number; request: string | null }> = [];
  let approve = false;
  const ap = await start(plane, stateDir, {
    apply: {
      onStaged: async (staged) => {
        seen.push({ generation: staged.generation, request: staged.unlockRequest?.note ?? null });
        if (!approve) throw new Error("change control said no");
        staged.activate();
      },
    },
  });
  const reply2 = plane.slot({ tag: "support.reply", text: "R2 {{name}}.", variables: [{ name: "name", required: false, trust: "operator" }], versionId: "v2" });
  const requested = plane.promote([triage!, reply2], { applyPolicy: "unlock_required" });
  plane.promote([triage!, reply2], { applyPolicy: "unlock_required", directives: [{ kind: "request_unlock", releaseDigest: requested.payload.releaseDigest, requestedBy: "usr_ops", requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), note: "CHG0042" }] });
  await ap.syncNow();
  assert.deepEqual(seen, [{ generation: 3, request: "CHG0042" }]);
  assert.equal(ap.status().applyState, "awaiting_unlock", "a rejecting hook leaves it staged");
  assert.equal(ap.generation, 1);
  assert.deepEqual(ap.status().unlockRequests.map((r) => r.note), ["CHG0042"]);
  await ap.heartbeatNow();
  assert.deepEqual(plane.heartbeats.at(-1)?.unlockRequestsSeen, [requested.payload.releaseDigest], "the fleet view learns who saw the request");
  assert.equal(plane.heartbeats.at(-1)?.applyState, "awaiting_unlock");
  // Change control approves the next one: the hook activates.
  approve = true;
  plane.promote([triage!, plane.slot({ tag: "support.reply", text: "R4 {{name}}.", variables: [{ name: "name", required: false, trust: "operator" }], versionId: "v4" })], { applyPolicy: "unlock_required" });
  await ap.syncNow();
  assert.equal(ap.generation, 4, "the hook activated it");
  assert.equal(ap.status().applyState, "active");
  await ap.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

test("a Freeze is honoured from a manifest the runtime leaves staged (directives before the apply decision), and lifted by the next verified one", async () => {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  const [triage, reply] = slots(plane);
  plane.promote([triage!, reply!]);
  const ap = await start(plane, stateDir, { telemetry: { sink: "memory" } });
  // Same release, unlock_required, carrying disable(agent): the runtime stages it (nobody unlocks) — and must still stop serving.
  plane.promote([triage!, reply!], { applyPolicy: "unlock_required", directives: [{ kind: "disable", scope: "agent", issuedAt: new Date().toISOString(), reason: "Frozen from the console" }] });
  await ap.syncNow();
  assert.equal(ap.generation, 1, "still on generation 1 — the frozen manifest was staged, not activated");
  assert.equal(ap.status().applyState, "awaiting_unlock");
  assert.deepEqual(ap.status().disabled, { agent: true, slots: [], arms: [] }, "…and yet the Freeze took effect");
  assert.throws(() => ap.prompt("support.reply").render({}), (e: unknown) => e instanceof RenderRefusedError && e.reason === "disabled");
  await ap.heartbeatNow();
  assert.deepEqual(plane.heartbeats.at(-1)?.disabled, { agent: true, slots: [] });
  // Lifting the freeze: another generation, still unlock_required, no directive — serving resumes on the old release.
  plane.promote([triage!, reply!], { applyPolicy: "unlock_required" });
  await ap.syncNow();
  assert.deepEqual(ap.status().disabled, { agent: false, slots: [], arms: [] });
  assert.equal(ap.prompt("support.reply").render({}).generation, 1);
  await ap.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

test("the heartbeat: the protocol's body, content-free; the cadence is adopted from the answer; a refusal is reported, never thrown; a runtime without a key sends none", async () => {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  const [triage, reply] = slots(plane);
  plane.promote([triage!, reply!]);
  plane.heartbeatIntervalSeconds = 60;
  const ap = await start(plane, stateDir, { models: { "gpt-5": { provider: "openai" }, "claude-sonnet-5": { provider: "anthropic" } }, heartbeatSeconds: 45 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(plane.heartbeats.length >= 1, "the first heartbeat goes out right after boot");
  assert.equal(plane.heartbeats[0]?.heartbeatIntervalSeconds, 45, "the runtime declares its cadence…");
  const body = ap.heartbeatBody();
  assert.equal(body.protocol, "0.2.5");
  assert.deepEqual(body.sdk, { name: "agent-sdk-typescript", version: "0.1.0" });
  assert.equal(body.syncMode, "resident");
  assert.equal(body.heartbeatIntervalSeconds, 60, "…and holds to what the server answered");
  assert.deepEqual(body.generation, { active: 1 });
  assert.equal(body.applyState, "active");
  assert.equal(body.storageProtection, "file_key");
  assert.deepEqual((body.catalog as { models: string[] }).models, ["gpt-5", "claude-sonnet-5"]);
  assert.equal(JSON.stringify(body).includes("Triage"), false, "no prompt text on the wire");
  plane.heartbeatIntervalSeconds = 120;
  await ap.heartbeatNow();
  assert.equal(ap.status().heartbeat.intervalSeconds, 120, "the server's cadence is adopted");
  assert.ok(ap.status().heartbeat.lastAt);
  plane.heartbeatRefusal = { status: 403, code: "instance_cap_reached" };
  await ap.heartbeatNow();
  assert.equal(ap.status().heartbeat.lastRefusal, "instance_cap_reached");
  await ap.stop();
  rmSync(stateDir, { recursive: true, force: true });

  // Offline: no key, no heartbeat, and halt degrades with one log line instead of an outage the runtime cannot end.
  const dir2 = tempDir();
  const plane2 = new FakeControlPlane(scope);
  const [t2, r2] = slots(plane2);
  plane2.promote([t2!, r2!], { leaseSeconds: 60, onLeaseExpiry: "halt" });
  // The fake stamps issuedAt with the real clock; the lease-from-issue fallback is measured against it.
  let clock = Date.now();
  const online = await start(plane2, dir2, { now: () => clock });
  await online.stop();
  const events: string[] = [];
  const offline = await AirPrompterAgent.start({ ...scope, stateDir: dir2, root: { pinned: publicJwkOf(plane2.rootKey) }, sync: { mode: "offline" }, now: () => clock, logger: (e) => void events.push(String(e.event)) });
  clock += 120_000;
  assert.equal(offline.status().leaseExpired, true);
  assert.equal(offline.prompt("support.reply").render({}).text, "Reply to .", "halt without a way home degrades");
  assert.ok(events.includes("halt_without_contact_degraded"));
  assert.equal(offline.heartbeatBody().syncMode, "offline");
  await offline.stop();
  assert.equal(plane2.heartbeats.length, 1, "only the online start heart-beat");
  rmSync(dir2, { recursive: true, force: true });
});

// T15: a required model this runtime cannot call is a local refusal after the chain verified — the release stays
// unactivated, nothing is fetched, the heartbeat says which model; a runtime that declared nothing is never refused over one.
test("a required model outside the declared catalog refuses the release locally (model_unavailable) and the heartbeat names it; the flag rides the digest only when true", async () => {
  const plane = new FakeControlPlane(scope);
  const [triage, reply] = slots(plane);
  assert.equal(releaseDigest([{ ...triage!, modelRequired: false }]), releaseDigest([triage!]), "false is the absence of the flag");
  assert.notEqual(releaseDigest([{ ...triage!, modelRequired: true }]), releaseDigest([triage!]), "a required model is a different release");
  assert.deepEqual(requiredModelsMissing(plane.promote([{ ...triage!, model: "claude-haiku-4-5", modelRequired: true }, reply!]).payload, ["gpt-5"]), ["claude-haiku-4-5"]);
  assert.deepEqual(requiredModelsMissing(plane.promote([{ ...triage!, model: "claude-haiku-4-5", modelRequired: true }, reply!]).payload, null), [], "nothing declared, nothing refused");

  const stateDir = tempDir();
  const plane2 = new FakeControlPlane(scope);
  const [t2, r2] = slots(plane2);
  plane2.promote([t2!, r2!]);
  const events: Array<Record<string, unknown>> = [];
  const ap = await start(plane2, stateDir, { models: { "gpt-5": { provider: "openai" }, "claude-sonnet-5": { provider: "anthropic" } }, logger: (e) => void events.push(e) });
  assert.equal(ap.generation, 1);
  // Generation 2 requires a model this process cannot call: refused, generation 1 keeps serving.
  plane2.promote([{ ...t2!, model: "claude-haiku-4-5", modelRequired: true }, r2!]);
  await ap.syncNow();
  assert.equal(ap.generation, 1, "the release stays unactivated");
  assert.equal(ap.status().lastSyncOutcome, "refused");
  assert.equal(ap.status().lastRefusal, "model_unavailable");
  const body = ap.heartbeatBody();
  assert.equal(body.applyState, "refused");
  assert.equal(body.refusal, "model_unavailable");
  assert.deepEqual(body.unavailableModels, ["claude-haiku-4-5"]);
  assert.equal(events.some((e) => e.event === "sync_refused" && e.reason === "model_unavailable"), true);
  // The same model without the requirement activates: the app decides what to do with a model it did not declare.
  plane2.promote([{ ...t2!, model: "claude-haiku-4-5" }, r2!]);
  await ap.syncNow();
  assert.equal(ap.generation, 3);
  assert.equal(ap.heartbeatBody().unavailableModels, undefined, "cleared once a release activates");
  assert.equal(ap.prompt("support.triage").render({ ticket: "x" }).model, "claude-haiku-4-5");
  await ap.stop();
  rmSync(stateDir, { recursive: true, force: true });
});
