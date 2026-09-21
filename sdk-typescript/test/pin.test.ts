/**
 * 0.3.5 pins.md: a pinned runtime renders the named seal while the pointer moves on; live control (directives,
 * lease, onLeaseExpiry) still reaches it from the environment's live manifest; the platform's five seal refusals
 * surface as `pin_refused`; `unpin()` re-bases without a false rollback refusal. Beside `test/pointer.test.ts`:
 * together they pin "the pointer decides by default, the pin decides when named, and control always comes from
 * the pointer's manifest." Two-slot fixtures throughout, so "did everything" is distinguishable from "did nothing
 * more".
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent, RenderRefusedError, isAgentStartError } from "../packages/sdk/src/agent.js";
import { publicJwkOf } from "../packages/core/src/protocol/trust.js";
import { sealIdOf } from "../packages/core/src/protocol/seal.js";
import { mergeLiveControl, readPinFile } from "../packages/sync/src/sync/pin.js";
import { nodeFs } from "../packages/core/src/ports/node.js";
import { FakeControlPlane } from "../packages/core/src/testing/index.js";

const scope = { organizationId: "org_1", agentId: "agt_pin", target: "prod" as const };
const tempDir = () => mkdtempSync(join(tmpdir(), "ap-pin-"));

/** Two slots, their text carrying `marker` so two promotions are distinguishable by their rendered output. */
function slots(plane: FakeControlPlane, marker: string) {
  return [
    plane.slot({ tag: "support.triage", text: `Triage ${marker} {{ticket}}.`, variables: [{ name: "ticket", required: true, trust: "operator" }] }),
    plane.slot({ tag: "support.reply", text: `Reply ${marker} to {{name}}.`, variables: [{ name: "name", required: false, trust: "operator" }], model: "gpt-5" }),
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
    telemetry: { upload: false },
    ...extra,
  });
}

test("a pinned runtime renders the named seal while the pointer moves on", async () => {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  const [ta, ra] = slots(plane, "A");
  const manifestA = plane.promote([ta!, ra!]);
  const digestA = manifestA.payload.releaseDigest;
  const sealA = sealIdOf(digestA);

  const ap = await start(plane, stateDir, { release: sealA });
  try {
    assert.equal(ap.prompt("support.triage").render({ ticket: "t1" }).text, "Triage A t1.", "renders A's text");
    assert.deepEqual(ap.releaseInfo(), { sealId: sealA, releaseDigest: digestA, generation: manifestA.payload.generation, pinned: true });

    // The fake seals at 0.3.5 by default: the heartbeat carries pinnedReleaseDigest.
    await ap.heartbeatNow();
    const hb1 = plane.heartbeats.at(-1)!;
    assert.equal(hb1.pinnedReleaseDigest, digestA, "0.3.5-sealed: pinnedReleaseDigest is reported");

    // Promote B (the pointer moves) and tick: the pin still renders A.
    const [tb, rb] = slots(plane, "B");
    plane.promote([tb!, rb!]);
    await ap.syncNow();
    assert.equal(ap.prompt("support.triage").render({ ticket: "t2" }).text, "Triage A t2.", "still A after B is promoted");
    assert.equal(ap.status().pinnedRelease, sealA);

    // Promote C and tick again: the pointer moves a second time, the pin still holds.
    const [tc, rc] = slots(plane, "C");
    plane.promote([tc!, rc!]);
    await ap.syncNow();
    assert.equal(ap.prompt("support.triage").render({ ticket: "t3" }).text, "Triage A t3.", "still A after C is promoted");
    assert.equal(ap.status().pinnedRelease, sealA);
  } finally {
    await ap.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a pinned runtime sealed at 0.3.4 does not report pinnedReleaseDigest (the gate an older service would refuse over)", async () => {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  const [ta, ra] = slots(plane, "A");
  const manifestA = plane.promote([ta!, ra!], { protocol: "0.3.4" });
  const sealA = sealIdOf(manifestA.payload.releaseDigest);
  const ap = await start(plane, stateDir, { release: sealA });
  try {
    await ap.heartbeatNow();
    const hb = plane.heartbeats.at(-1)!;
    assert.equal(hb.pinnedReleaseDigest, undefined, "0.3.4-sealed: no pinnedReleaseDigest");
  } finally {
    await ap.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("live control reaches a pinned runtime: a live disable directive refuses render while the pin still names A; a live lease and onLeaseExpiry halt after it lapses", async () => {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  const [ta, ra] = slots(plane, "A");
  const manifestA = plane.promote([ta!, ra!]);
  const sealA = sealIdOf(manifestA.payload.releaseDigest);
  let clock = Date.parse("2026-09-21T00:00:00Z");
  const ap = await start(plane, stateDir, { release: sealA, now: () => clock });
  try {
    assert.equal(ap.prompt("support.triage").render({ ticket: "t1" }).text, "Triage A t1.");

    // A live promotion carrying a `disable` directive (scope agent) — the pointer moves, so the pass adopts it.
    const [tb, rb] = slots(plane, "B");
    plane.promote([tb!, rb!], { directives: [{ kind: "disable", scope: "agent", issuedAt: new Date(clock).toISOString() }] });
    await ap.syncNow();
    assert.throws(() => ap.prompt("support.triage").render({ ticket: "t2" }), RenderRefusedError, "disabled by the live directive");
    assert.equal(ap.releaseInfo()?.sealId, sealA, "the pin still names A even while disabled");

    // A live promotion with a short lease and onLeaseExpiry: halt.
    const [tc, rc] = slots(plane, "C");
    plane.promote([tc!, rc!], { leaseSeconds: 1, onLeaseExpiry: "halt" });
    await ap.syncNow();
    clock += 2000;
    const health = ap.healthz();
    assert.equal(health.ok, false);
    assert.equal(health.status, "failing");
    assert.ok(health.reasons.includes("lease_expired_halt"), `expected lease_expired_halt, got ${JSON.stringify(health.reasons)}`);
  } finally {
    await ap.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("pin refusals: an invalid grammar is seal_invalid; an unknown but well-formed digest is release_unknown", async () => {
  const stateDir1 = tempDir();
  const plane1 = new FakeControlPlane(scope);
  const [t1, r1] = slots(plane1, "A");
  plane1.promote([t1!, r1!]);
  const events1: Array<Record<string, unknown>> = [];
  await assert.rejects(
    () => start(plane1, stateDir1, { release: "abc", logger: (e) => events1.push(e) }),
    (error: unknown) => isAgentStartError(error) && error.code === "no_verified_release",
    "too short to be a seal: never activates",
  );
  assert.ok(events1.some((e) => e.event === "pin_refused" && e.code === "seal_invalid"), `expected pin_refused seal_invalid, got ${JSON.stringify(events1.map((e) => e.event))}`);
  rmSync(stateDir1, { recursive: true, force: true });

  const stateDir2 = tempDir();
  const plane2 = new FakeControlPlane(scope);
  const [t2, r2] = slots(plane2, "A");
  plane2.promote([t2!, r2!]);
  const events2: Array<Record<string, unknown>> = [];
  const unknownDigest = "0".repeat(12);
  await assert.rejects(
    () => start(plane2, stateDir2, { release: unknownDigest, logger: (e) => events2.push(e) }),
    (error: unknown) => isAgentStartError(error) && error.code === "no_verified_release",
    "well-formed but never sealed: never activates",
  );
  assert.ok(events2.some((e) => e.event === "pin_refused" && e.code === "release_unknown"), `expected pin_refused release_unknown, got ${JSON.stringify(events2.map((e) => e.event))}`);
  rmSync(stateDir2, { recursive: true, force: true });
});

test("unpin re-bases: pinned to A while the store's own counter was already at C's generation (from before the pin); unpin() activates the pointer's release without a false generation_rollback; pin.json is gone", async () => {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  const [ta, ra] = slots(plane, "A");
  const manifestA = plane.promote([ta!, ra!]);
  const sealA = sealIdOf(manifestA.payload.releaseDigest);
  const [tb, rb] = slots(plane, "B");
  plane.promote([tb!, rb!]);
  const [tc, rc] = slots(plane, "C");
  const manifestC = plane.promote([tc!, rc!]);

  // First, unpinned: sync all the way to C — the store's own generation counter is now C's.
  const ap1 = await start(plane, stateDir);
  await ap1.syncNow();
  assert.equal(ap1.status().generation, manifestC.payload.generation);
  await ap1.stop();

  // Restart the SAME store, pinned to A (older than what the store's counter holds) — the first pinned sync
  // forces past it (`forcedDowngrade`).
  const ap2 = await start(plane, stateDir, { release: sealA });
  await ap2.syncNow();
  assert.equal(ap2.prompt("support.triage").render({ ticket: "t" }).text, "Triage A t.", "pinned to A over a store that held C");
  assert.equal(ap2.status().forcedDowngrade, true, "the store recorded the forced downgrade past C");
  await ap2.stop();

  // Restart once more, unpinned (as `unpin()` would leave it) — the pointer's current release (C) activates, and
  // it must never be refused as a rollback merely because A was below it.
  const ap3 = await start(plane, stateDir);
  // `start()` fires an initial heartbeat in the background, whose answer can trigger its own auto-sync
  // (`pointer_behind`) still under the resumed pin; let any such pass settle before unpinning, so the explicit
  // `unpin()` below is never raced by one already in flight under the old pin.
  await ap3.syncNow();
  await ap3.unpin();
  await ap3.syncNow();
  try {
    assert.equal(ap3.prompt("support.triage").render({ ticket: "t" }).text, "Triage C t.", "unpinned: renders the pointer's current release (C)");
    assert.equal(ap3.status().generation, manifestC.payload.generation);
    assert.equal(ap3.releaseInfo()?.pinned, false);
    assert.equal(ap3.status().lastRefusal, null, "no generation_rollback on the first unpinned pass");
    assert.equal(readPinFile(nodeFs, stateDir, scope.agentId, scope.target), null, "pin.json is gone");
  } finally {
    await ap3.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("mergeLiveControl: control (directives, lease, onLeaseExpiry, requireCountersign, unlockWindow) comes from live; content (slots, generation, releaseDigest) stays pinned", () => {
  const plane = new FakeControlPlane(scope);
  const [ta, ra] = slots(plane, "A");
  const pinned = plane.promote([ta!, ra!], { leaseSeconds: 111, onLeaseExpiry: "degrade" });
  const [tb, rb] = slots(plane, "B");
  const live = plane.promote([tb!, rb!], { leaseSeconds: 222, onLeaseExpiry: "halt", directives: [{ kind: "disable", scope: "agent", issuedAt: new Date().toISOString() }] });

  const merged = mergeLiveControl(pinned, live);
  assert.deepEqual(merged.payload.slots, pinned.payload.slots, "content stays pinned's");
  assert.equal(merged.payload.generation, pinned.payload.generation, "generation stays pinned's");
  assert.equal(merged.payload.releaseDigest, pinned.payload.releaseDigest, "releaseDigest stays pinned's");
  assert.equal(merged.payload.leaseSeconds, 222, "lease comes from live");
  assert.equal(merged.payload.onLeaseExpiry, "halt", "onLeaseExpiry comes from live");
  assert.deepEqual(merged.payload.directives, live.payload.directives, "directives come from live");
  assert.equal(merged.signatures, pinned.signatures, "the signature is the pinned envelope's own — this view is never re-verified or stored");
});
