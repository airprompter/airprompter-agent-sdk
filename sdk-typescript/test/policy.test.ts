/**
 * S4 (AIR-1972): the apply policy is the customer's.
 *
 * A control plane that is compromised or mis-edited could flip Production
 * from `unlock_required` to `auto`, and the next verified release would
 * activate with no local act. These cases prove it cannot: the first
 * verified manifest pins the host's policy in store.json (trust-on-first-
 * use), a later manifest may tighten the pin and never loosen it, only an
 * operator's act loosens it, the set of directive kinds honoured without a
 * local act is closed (`disable` only acts; `request_unlock` only asks),
 * and a manifest carrying a kind this runtime does not know is refused
 * whole and counted.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent, RenderRefusedError } from "../packages/sdk/src/agent.js";
import { publicJwkOf } from "../packages/core/src/protocol/trust.js";
import type { Directive } from "../packages/core/src/protocol/types.js";
import { SlotStore } from "../packages/sync/src/store/slotStore.js";
import { FakeControlPlane } from "../packages/core/src/testing/index.js";

const scope = { organizationId: "org_1", agentId: "agt_policy", target: "prod" as const };

function slots(plane: FakeControlPlane, versionId = "v1") {
  return [plane.slot({ tag: "support.reply", text: `Reply ${versionId} to {{name}}`, versionId, variables: [{ name: "name", required: false, trust: "operator" }] })];
}

async function start(plane: FakeControlPlane, stateDir: string, now: () => number, options: { logger?: (e: Record<string, unknown>) => void; apply?: { policy?: "auto" | "unlock_required" } } = {}) {
  return AirPrompterAgent.start({
    ...scope,
    apiKey: plane.apiKey,
    baseUrl: "https://api.test",
    stateDir,
    root: { pinned: publicJwkOf(plane.rootKey) },
    sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" },
    fetch: plane.fetch(),
    now,
    telemetry: { sink: "memory" },
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.apply ? { apply: options.apply } : {}),
  });
}

const storeFile = (stateDir: string) => JSON.parse(readFileSync(join(SlotStore.path({ stateDir, ...scope }), "store.json"), "utf8")) as { applyPolicyPin?: { value: string; source: string; generation: number } };

test("trust-on-first-use, tighten, never loosen: the console's flip to auto is advisory on a host pinned to unlock_required; an operator's act loosens it; the next unlock_required tightens it again", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-policy-"));
  const plane = new FakeControlPlane(scope);
  let clock = Date.parse("2026-09-13T12:00:00Z");
  const events: Record<string, unknown>[] = [];
  plane.promote(slots(plane), { applyPolicy: "auto" });
  const ap = await start(plane, stateDir, () => clock, { logger: (e) => events.push(e) });
  // The first verified manifest pinned the host: trust on first use.
  assert.equal(ap.generation, 1);
  const pin = () => storeFile(stateDir).applyPolicyPin!;
  assert.deepEqual({ value: pin().value, source: pin().source, generation: pin().generation }, { value: "auto", source: "manifest", generation: 1 });
  assert.ok(events.some((e) => e.event === "apply_policy_pinned" && e.policy === "auto" && e.generation === 1), JSON.stringify(events));
  assert.deepEqual(ap.status().applyPolicy, { effective: "auto", source: "pinned", manifestSaid: "auto" });

  // The console tightens Production: the pin follows, and the release waits.
  plane.promote(slots(plane, "v2"), { applyPolicy: "unlock_required" });
  clock += 1000;
  await ap.syncNow();
  assert.equal(ap.status().lastSyncOutcome, "staged");
  assert.deepEqual({ value: pin().value, source: pin().source, generation: pin().generation }, { value: "unlock_required", source: "manifest", generation: 2 });
  assert.ok(events.some((e) => e.event === "apply_policy_tightened" && e.from === "auto" && e.to === "unlock_required" && e.generation === 2));
  assert.deepEqual(await ap.unlock(), { generation: 2 });

  // The console flips Production back to auto (compromised, or mis-edited) and promotes. The runtime stays pinned: staged, not live.
  plane.promote(slots(plane, "v3"), { applyPolicy: "auto" });
  clock += 1000;
  await ap.syncNow();
  assert.equal(ap.status().lastSyncOutcome, "staged", "auto from the manifest did not activate anything");
  assert.equal(ap.generation, 2);
  assert.equal(ap.status().stagedGeneration, 3);
  assert.deepEqual(ap.status().applyPolicy, { effective: "unlock_required", source: "pinned", manifestSaid: "auto" });
  assert.deepEqual(ap.heartbeatBody().applyPolicy, { effective: "unlock_required", source: "pinned" }, "the fleet view learns the console's setting is advisory here");
  const advisory = () => events.filter((e) => e.event === "apply_policy_manifest_advisory");
  assert.equal(advisory().length, 1);
  assert.deepEqual({ manifestSaid: advisory()[0]!.manifestSaid, pinned: advisory()[0]!.pinned, generation: advisory()[0]!.generation }, { manifestSaid: "auto", pinned: "unlock_required", generation: 3 });
  // The same generation again is not logged again.
  clock += 1000;
  await ap.syncNow();
  assert.equal(advisory().length, 1, "one line per generation, not per pass");
  assert.equal(pin().value, "unlock_required", "the manifest never loosened the pin");
  await ap.unlock();
  assert.equal(ap.generation, 3);

  // An operator loosens the host on purpose — the one way. The next release applies automatically.
  const loosened = await ap.setApplyPolicy("auto", { by: "seth" });
  assert.deepEqual(loosened, { effective: "auto", source: "operator", manifestSaid: "auto" });
  assert.deepEqual({ value: pin().value, source: pin().source }, { value: "auto", source: "operator" });
  assert.ok(events.some((e) => e.event === "apply_policy_set" && e.policy === "auto" && e.previous === "unlock_required" && e.by === "seth"));
  plane.promote(slots(plane, "v4"), { applyPolicy: "auto" });
  clock += 1000;
  await ap.syncNow();
  assert.equal(ap.status().lastSyncOutcome, "activated");
  assert.equal(ap.generation, 4);
  assert.equal(ap.prompt("support.reply").render({ name: "x" }).text, "Reply v4 to x");

  // A manifest may always tighten: the console's unlock_required takes the pin back, even over the operator's auto.
  plane.promote(slots(plane, "v5"), { applyPolicy: "unlock_required" });
  clock += 1000;
  await ap.syncNow();
  assert.equal(ap.status().lastSyncOutcome, "staged");
  assert.deepEqual({ value: pin().value, source: pin().source, generation: pin().generation }, { value: "unlock_required", source: "manifest", generation: 5 });
  assert.ok(events.some((e) => e.event === "apply_policy_tightened" && e.from === "auto" && e.previousSource === "operator" && e.generation === 5));
  await ap.unlock();
  // …and auto again from the console changes nothing.
  plane.promote(slots(plane, "v6"), { applyPolicy: "auto" });
  clock += 1000;
  await ap.syncNow();
  assert.equal(ap.status().lastSyncOutcome, "staged");
  assert.equal(ap.generation, 5);

  // The pin survives a restart: a fresh process on this host reads store.json before any manifest.
  await ap.stop();
  const again = await start(plane, stateDir, () => clock);
  assert.deepEqual(again.status().applyPolicy, { effective: "unlock_required", source: "pinned", manifestSaid: null });
  assert.equal(again.status().stagedGeneration, 6, "the staged release is still staged, still waiting");
  await again.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

test("a local apply.policy of unlock_required sits on top of the pin; a local auto is not a loosening", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-policy-"));
  const plane = new FakeControlPlane(scope);
  let clock = Date.parse("2026-09-13T12:00:00Z");
  plane.promote(slots(plane), { applyPolicy: "auto" });
  const first = await start(plane, stateDir, () => clock);
  assert.equal(first.generation, 1, "pinned auto on first use");
  await first.stop();
  // This process says unlock_required: every release waits, whatever the pin (auto) or the manifest (auto) say.
  const strict = await start(plane, stateDir, () => clock, { apply: { policy: "unlock_required" } });
  assert.deepEqual(strict.status().applyPolicy, { effective: "unlock_required", source: "local", manifestSaid: null });
  plane.promote(slots(plane, "v2"), { applyPolicy: "auto" });
  clock += 1000;
  await strict.syncNow();
  assert.equal(strict.status().lastSyncOutcome, "staged");
  assert.deepEqual(strict.status().applyPolicy, { effective: "unlock_required", source: "local", manifestSaid: "auto" });
  assert.equal(storeFile(stateDir).applyPolicyPin!.value, "auto", "the local option is this process's, not the host's pin");
  await strict.unlock();
  await strict.stop();
  // The console tightens; the pin follows. A later process that says `auto` locally does not loosen it.
  plane.promote(slots(plane, "v3"), { applyPolicy: "unlock_required" });
  clock += 1000;
  const lax = await start(plane, stateDir, () => clock, { apply: { policy: "auto" } });
  await lax.syncNow(); // the boot heartbeat's latestGeneration may already have staged it (S3); either way it is staged, not live
  assert.equal(lax.generation, 2);
  assert.equal(lax.status().stagedGeneration, 3);
  assert.deepEqual(lax.status().applyPolicy, { effective: "unlock_required", source: "pinned", manifestSaid: "unlock_required" });
  await lax.unlock();
  plane.promote(slots(plane, "v4"), { applyPolicy: "auto" });
  clock += 1000;
  await lax.syncNow();
  assert.equal(lax.status().lastSyncOutcome, "staged", "a local auto does not override the pinned unlock_required");
  await lax.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

test("the pushable set is closed: a manifest with a directive kind this runtime does not know is refused whole and counted — its disable is not obeyed either; disable alone lands without a local act; request_unlock only asks", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-policy-"));
  const plane = new FakeControlPlane(scope);
  let clock = Date.parse("2026-09-13T12:00:00Z");
  const events: Record<string, unknown>[] = [];
  plane.promote(slots(plane), { applyPolicy: "auto" });
  const ap = await start(plane, stateDir, () => clock, { logger: (e) => events.push(e) });
  // Pinned auto on first use; the console tightens, so from here every release waits for a local act.
  plane.promote(slots(plane, "v1b"), { applyPolicy: "unlock_required" });
  clock += 1000;
  await ap.syncNow();
  await ap.unlock();
  assert.equal(ap.generation, 2);
  assert.equal(ap.status().applyPolicy.effective, "unlock_required");

  // An unknown kind beside a Freeze: the whole manifest is refused, so the Freeze does not land by halves.
  const unknown = [{ kind: "reboot", issuedAt: "2026-09-13T12:00:00Z" } as unknown as Directive, { kind: "disable", scope: "agent", issuedAt: "2026-09-13T12:00:00Z" } as Directive];
  plane.promote(slots(plane, "v2"), { applyPolicy: "unlock_required", directives: unknown });
  clock += 1000;
  await ap.syncNow();
  assert.equal(ap.status().lastSyncOutcome, "refused");
  assert.equal(ap.status().lastRefusal, "directive_unknown");
  assert.equal(ap.status().applyState, "refused");
  assert.equal(ap.heartbeatBody().refusal, "directive_unknown", "counted on the heartbeat");
  assert.equal(ap.generation, 2);
  assert.equal(ap.status().stagedGeneration, null, "nothing staged");
  assert.deepEqual(ap.status().disabled, { agent: false, slots: [], arms: [] }, "the disable beside the unknown kind was not obeyed");
  assert.equal(ap.prompt("support.reply").render({ name: "x" }).text, "Reply v1b to x");
  assert.ok(events.some((e) => e.event === "sync_refused" && e.reason === "directive_unknown" && e.generation === 3));

  // `disable` alone is the reduction the cloud may push: it lands on a pinned unlock_required host with no local act.
  plane.promote(slots(plane, "v3"), { applyPolicy: "unlock_required", directives: [{ kind: "disable", scope: "agent", issuedAt: "2026-09-13T12:00:00Z", reason: "incident" }] });
  clock += 1000;
  await ap.syncNow();
  assert.equal(ap.status().lastSyncOutcome, "staged", "the release itself still waits");
  assert.equal(ap.generation, 2);
  assert.deepEqual(ap.status().disabled, { agent: true, slots: [], arms: [] });
  assert.throws(() => ap.prompt("support.reply").render({ name: "x" }), (error: unknown) => error instanceof RenderRefusedError && error.reason === "disabled");

  // `request_unlock` asks; it never activates. The staged release is still staged after it arrives.
  const digest = plane.manifest!.payload.releaseDigest;
  plane.promote(slots(plane, "v3"), { applyPolicy: "unlock_required", directives: [{ kind: "request_unlock", releaseDigest: digest, requestedBy: "usr_console", requestedAt: "2026-09-13T12:00:00Z", expiresAt: "2026-09-14T12:00:00Z", note: "please" }] });
  clock += 1000;
  await ap.syncNow();
  assert.equal(ap.generation, 2, "a request is not an act");
  assert.equal(ap.status().unlockRequests.length, 1);
  assert.deepEqual(ap.status().disabled, { agent: false, slots: [], arms: [] }, "the newer manifest lifted the Freeze");
  await ap.stop();
  rmSync(stateDir, { recursive: true, force: true });
});
