/**
 * S3 (AIR-1971): the pointer never extends trust.
 *
 * The edge pointer is unsigned and cacheable; a party between the fleet and
 * the edge can pin it. These cases prove that a pinned pointer cannot keep
 * a fleet on the last release: its silence does not renew the lease, the
 * heartbeat's `latestGeneration` sends the runtime past it to the signed
 * manifest, and a Freeze (`disable`) behind a pinned pointer lands within
 * one heartbeat.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent, RenderRefusedError } from "../src/agent.js";
import { publicJwkOf } from "../src/protocol/trust.js";
import { FakeControlPlane } from "../src/testing/index.js";

const scope = { organizationId: "org_1", agentId: "agt_pointer", target: "prod" as const };

function triageSlots(plane: FakeControlPlane) {
  return [
    plane.slot({ tag: "support.triage", text: "Classify {{ticket}}", variables: [{ name: "ticket", required: true, trust: "end_user" }] }),
    plane.slot({ tag: "support.reply", text: "Reply politely to {{name}}", variables: [{ name: "name", required: false, trust: "operator" }] }),
  ];
}

async function start(plane: FakeControlPlane, stateDir: string, now: () => number, logger?: (e: Record<string, unknown>) => void) {
  return AirPrompterAgent.start({
    ...scope,
    apiKey: plane.apiKey,
    baseUrl: "https://api.test",
    stateDir,
    root: { pinned: publicJwkOf(plane.rootKey) },
    sync: { mode: "resident", pollSeconds: 3600, edgePointerUrl: "https://edge.test/g/token/generation.json", rootUrl: "https://edge.test/roots/prod/root.json" },
    fetch: plane.fetch(),
    now,
    telemetry: { sink: "memory" },
    ...(logger ? { logger } : {}),
  });
}

test("a pinned pointer does not renew the lease: the runtime expires honestly, and the origin's authenticated answers are what bring it back", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-pointer-"));
  const plane = new FakeControlPlane(scope);
  const [triage, reply] = triageSlots(plane);
  plane.promote([triage!, reply!], { leaseSeconds: 600 });
  let clock = Date.parse("2026-09-13T12:00:00Z");
  const ap = await start(plane, stateDir, () => clock);
  const leaseAtStart = ap.status().leaseExpiresAt!;
  plane.pinnedPointer = { generation: 1 }; // from here the edge answers the same thing forever
  for (let i = 0; i < 5; i += 1) {
    clock += 100_000;
    await ap.syncNow();
    assert.equal(ap.status().lastSyncOutcome, "pointer_unchanged");
    assert.equal(ap.status().leaseExpiresAt, leaseAtStart, `pass ${i}: the pinned pointer moved nothing`);
  }
  clock += 200_000; // 700 s since the last contact: the lease is gone
  assert.equal(ap.status().leaseExpired, true, "a runtime that only ever hears the pointer expires");
  ap.prompt("support.reply").render({});
  assert.deepEqual(ap.drainMemorySink().filter((r) => (r as { type: string }).type === "refusal").map((r) => (r as { reason: string }).reason), ["lease_expired"]);
  // The heartbeat is authenticated: it is contact, and it renews.
  await ap.heartbeatNow();
  assert.equal(ap.status().leaseExpired, false);
  assert.equal(ap.status().leaseExpiresAt, new Date(clock + 600_000).toISOString());
  await ap.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

test("latestGeneration bypasses a lagging pointer: a promotion behind a pinned pointer lands after one heartbeat, and a Freeze does too", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-pointer-"));
  const plane = new FakeControlPlane(scope);
  const [triage, reply] = triageSlots(plane);
  plane.promote([triage!, reply!]);
  let clock = Date.parse("2026-09-13T12:00:00Z");
  const events: Record<string, unknown>[] = [];
  const ap = await start(plane, stateDir, () => clock, (e) => events.push(e));
  assert.equal(ap.generation, 1);
  plane.pinnedPointer = { generation: 1 };
  // Generation 2 is promoted at the origin; the pinned pointer never says so.
  plane.promote([triage!, plane.slot({ tag: "support.reply", text: "v2 {{name}}", versionId: "ver_2", variables: [{ name: "name", required: false, trust: "operator" }] })]);
  clock += 60_000;
  await ap.syncNow();
  assert.equal(ap.status().lastSyncOutcome, "pointer_unchanged");
  assert.equal(ap.generation, 1, "the pointer alone hides the promotion");
  // The heartbeat names generation 2: the runtime skips the pointer and fetches the signed manifest.
  await ap.heartbeatNow();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(events.some((e) => e.event === "pointer_behind" && e.latestGeneration === 2), "the runtime said the pointer was behind");
  assert.equal(ap.generation, 2);
  assert.equal(ap.prompt("support.reply").render({ name: "x" }).text, "v2 x");
  // The pointer is trusted again once a pass reached the origin; a second heartbeat at the same generation changes nothing.
  await ap.heartbeatNow();
  assert.equal(events.filter((e) => e.event === "pointer_behind").length, 1);
  // A Freeze behind the pinned pointer: generation 3 carries disable(agent); it lands the same way.
  plane.promote([triage!, reply!], { directives: [{ kind: "disable", scope: "agent", issuedAt: new Date(clock).toISOString().replace(/\.\d{3}Z$/, "Z"), reason: "incident" }] });
  await ap.syncNow();
  assert.equal(ap.status().lastSyncOutcome, "pointer_unchanged");
  await ap.heartbeatNow();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ap.generation, 3);
  assert.throws(() => ap.prompt("support.reply").render({ name: "x" }), (e: unknown) => e instanceof RenderRefusedError && e.reason === "disabled", "the freeze reached a fleet whose pointer was pinned");
  await ap.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

test("an older origin that does not name latestGeneration changes nothing: the runtime keeps the pointer and the lease rule alone", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-pointer-"));
  const plane = new FakeControlPlane(scope);
  plane.heartbeatLatestGeneration = false;
  const [triage, reply] = triageSlots(plane);
  plane.promote([triage!, reply!]);
  let clock = Date.parse("2026-09-13T12:00:00Z");
  const events: Record<string, unknown>[] = [];
  const ap = await start(plane, stateDir, () => clock, (e) => events.push(e));
  plane.pinnedPointer = { generation: 1 };
  plane.promote([triage!, reply!]);
  clock += 60_000;
  await ap.heartbeatNow();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.filter((e) => e.event === "pointer_behind").length, 0);
  assert.equal(ap.generation, 1);
  await ap.stop();
  rmSync(stateDir, { recursive: true, force: true });
});
