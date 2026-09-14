/**
 * S9 (AIR-1977): the signed ramp plan.
 *
 * Weights used to ride the manifest one step per generation, so on an
 * `unlock_required` environment every step waited for an unlock. Now the
 * plan rides the manifest once (`experiment.ramp`), the customer unlocks it
 * once, and the fleet walks it on its own clock with no check-in; the
 * cloud can only retreat (`disable scope: "arm"`, a reduction that lands
 * without an unlock). The protocol's vectors (`vectors/ramp.json`, from an
 * independent implementation) are the walk; these cases are the runtime.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent, RenderRefusedError } from "../packages/sdk/src/agent.js";
import { AssignmentError, assignArm, effectiveArms, rampWeightsAt, validateRamp } from "../packages/core/src/protocol/assignment.js";
import { publicJwkOf, releaseDigest, verifyManifest } from "../packages/core/src/protocol/trust.js";
import type { Directive, Manifest, RampStep } from "../packages/core/src/protocol/types.js";
import { FakeControlPlane } from "../packages/core/src/testing/index.js";

const vectors = JSON.parse(readFileSync(new URL("../../protocol/vectors/ramp.json", import.meta.url), "utf8")) as {
  cases: Array<{ name: string; now?: string; salt: string; arms: Array<{ arm: string; weightBps: number }>; ramp: RampStep[]; directives: Directive[]; hosts?: Record<"hostA" | "hostB", { now: string; weightBps: number[] }>; expected: { weightBps?: number[]; assignments: Array<{ subject: string; bucket: number; arm?: string; hostA?: string; hostB?: string }>; disagreements?: number } }>;
  refused: Array<{ name: string; arms: Array<{ arm: string; weightBps: number }>; ramp: RampStep[]; reason: string }>;
};

test("the protocol's ramp vectors: the walk on the host clock, two skewed hosts, the retreat, and every refused plan", () => {
  for (const c of vectors.cases) {
    validateRamp(c.ramp, c.arms.length);
    const disabled = new Set(c.directives.filter((d) => d.kind === "disable" && d.scope === "arm").map((d) => (d as { arm: string }).arm));
    const check = (now: string, expectedWeights: number[] | undefined, field: "arm" | "hostA" | "hostB") => {
      const nowMs = Date.parse(now);
      if (expectedWeights) assert.deepEqual(rampWeightsAt(c.arms, c.ramp, nowMs), expectedWeights, `${c.name}: weights at ${now}`);
      const arms = effectiveArms({ arms: c.arms, ramp: c.ramp, disabledArms: disabled, nowMs })!;
      for (const entry of c.expected.assignments) {
        const result = assignArm({ salt: c.salt, subject: entry.subject, arms });
        assert.deepEqual({ bucket: result.bucket, arm: result.arm.arm }, { bucket: entry.bucket, arm: entry[field] }, `${c.name}: ${entry.subject} at ${now}`);
      }
    };
    if (c.hosts) {
      check(c.hosts.hostA.now, c.hosts.hostA.weightBps, "hostA");
      check(c.hosts.hostB.now, c.hosts.hostB.weightBps, "hostB");
      assert.equal(c.expected.assignments.filter((e) => e.hostA !== e.hostB).length, c.expected.disagreements);
      assert.equal(c.expected.assignments.some((e) => e.hostA === "candidate" && e.hostB === "control"), false, "sticky and monotone: nobody moves back");
    } else {
      check(c.now!, c.expected.weightBps, "arm");
    }
  }
  for (const r of vectors.refused) assert.throws(() => validateRamp(r.ramp, r.arms.length), (error: unknown) => error instanceof AssignmentError && error.reason === r.reason, r.name);
  assert.doesNotThrow(() => validateRamp(undefined, 2), "no plan is not a malformed plan");
});

test("a malformed plan refuses the manifest whole at verification (M14), before a byte is fetched", () => {
  const plane = new FakeControlPlane({ organizationId: "org_1", agentId: "agt_ramp", target: "prod" });
  const control = plane.slot({ tag: "support.reply", text: "Reply A to {{name}}", versionId: "a", variables: [{ name: "name", required: false, trust: "operator" }] });
  const candidate = plane.slot({ tag: "support.reply", text: "Reply B to {{name}}", versionId: "b", variables: [{ name: "name", required: false, trust: "operator" }] });
  const experiment = { experimentId: "exp_1", salt: "AAECAwQFBgcICQoLDA0ODw", subjectKey: "request" as const, arms: [{ arm: "control", weightBps: 10000, releaseDigest: releaseDigest([control]), overrides: [] }, { arm: "candidate", weightBps: 0, releaseDigest: releaseDigest([candidate]), overrides: [candidate] }] };
  const good: Manifest = plane.promote([control], { experiment: { ...experiment, ramp: [{ notBefore: "2026-09-14T02:00:00Z", weightBps: [9500, 500] }, { notBefore: "2026-09-14T03:00:00Z", weightBps: [7500, 2500] }] } });
  const scope = { organizationId: "org_1", agentId: "agt_ramp", target: "prod" as const };
  assert.equal(verifyManifest({ manifest: good, root: plane.root, now: "2026-09-13T00:00:00Z", scope, storedGeneration: 0, payloads: null }).ok, true);
  const bad: Manifest = plane.promote([control], { experiment: { ...experiment, ramp: [{ notBefore: "2026-09-14T02:00:00Z", weightBps: [9500, 500] }, { notBefore: "2026-09-14T02:20:00Z", weightBps: [7500, 2500] }] } });
  assert.deepEqual(verifyManifest({ manifest: bad, root: plane.root, now: "2026-09-13T00:00:00Z", scope, storedGeneration: 0, payloads: null }), { ok: false, reason: "ramp_invalid" });
});

test("the runtime walks the plan on its own clock with no check-in, the customer unlocked it once; the retreat lands without an unlock and hands the candidate's share to the control", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-ramp-"));
  const scope = { organizationId: "org_1", agentId: "agt_ramp", target: "prod" as const };
  const plane = new FakeControlPlane(scope);
  const control = plane.slot({ tag: "support.reply", text: "Reply A to {{name}}", versionId: "a", variables: [{ name: "name", required: false, trust: "operator" }] });
  const candidate = plane.slot({ tag: "support.reply", text: "Reply B to {{name}}", versionId: "b", variables: [{ name: "name", required: false, trust: "operator" }] });
  const arms = [{ arm: "control", weightBps: 10000, releaseDigest: releaseDigest([control]), overrides: [] }, { arm: "candidate", weightBps: 0, releaseDigest: releaseDigest([candidate]), overrides: [candidate] }];
  const ramp: RampStep[] = [{ notBefore: "2026-09-14T02:00:00Z", weightBps: [9500, 500] }, { notBefore: "2026-09-14T03:00:00Z", weightBps: [7500, 2500] }, { notBefore: "2026-09-14T05:00:00Z", weightBps: [0, 10000] }];
  const experiment = { experimentId: "exp_1", salt: "AAECAwQFBgcICQoLDA0ODw", subjectKey: "request" as const, arms, ramp };
  plane.promote([control], { applyPolicy: "auto" });
  let clock = Date.parse("2026-09-14T01:00:00Z");
  const events: Record<string, unknown>[] = [];
  const ap = await AirPrompterAgent.start({ ...scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" }, fetch: plane.fetch(), now: () => clock, telemetry: { sink: "memory" }, logger: (e) => events.push(e) });
  try {
    // The console writes the plan into ONE generation, under unlock_required; the customer unlocks it once.
    plane.promote([control], { applyPolicy: "unlock_required", experiment });
    await ap.syncNow();
    assert.equal(ap.status().lastSyncOutcome, "staged");
    assert.deepEqual(await ap.unlock(), { generation: 2 });
    const subjects = Array.from({ length: 200 }, (_, i) => `user-${i}`);
    const share = () => subjects.filter((s) => ap.prompt("support.reply", { subject: s }).render({ name: "x" }).arm === "candidate").length / subjects.length;
    // Before the first step: the arms' own weights — nobody on the candidate.
    assert.equal(share(), 0);
    assert.deepEqual({ step: ap.status().ramp!.step, next: ap.status().ramp!.nextStepAt, weights: ap.status().ramp!.weightBps }, { step: -1, next: "2026-09-14T02:00:00Z", weights: [10000, 0] });
    // The clock moves; the fleet ramps with NO sync — the origin is never asked.
    const fetches = plane.requests.length;
    clock = Date.parse("2026-09-14T02:00:00Z");
    const at5 = share();
    assert.ok(at5 > 0.01 && at5 < 0.12, `~5 %: ${at5}`);
    assert.equal(ap.status().ramp!.step, 0);
    clock = Date.parse("2026-09-14T04:00:00Z");
    const at25 = share();
    assert.ok(at25 > 0.17 && at25 < 0.33, `~25 %: ${at25}`);
    assert.equal(ap.status().ramp!.step, 1);
    clock = Date.parse("2026-09-14T06:00:00Z");
    assert.equal(share(), 1, "the plan's end: everyone on the candidate");
    assert.deepEqual({ step: ap.status().ramp!.step, next: ap.status().ramp!.nextStepAt }, { step: 2, next: null });
    assert.equal(plane.requests.length, fetches, "not one request to the origin while the plan walked");
    // Sticky and monotone: a subject on the candidate at 25 % is on it at 100 %.
    clock = Date.parse("2026-09-14T04:00:00Z");
    const onCandidateAt25 = subjects.filter((s) => ap.prompt("support.reply", { subject: s }).render({ name: "x" }).arm === "candidate");
    clock = Date.parse("2026-09-14T06:00:00Z");
    for (const s of onCandidateAt25) assert.equal(ap.prompt("support.reply", { subject: s }).render({ name: "x" }).arm, "candidate");

    // The retreat: the cloud pushes disable scope:"arm" on the candidate — a reduction, so it lands on this unlock_required
    // host without an unlock (the standing directives of a verified manifest, S3/S4) and everyone is back on the control.
    plane.promote([control], { applyPolicy: "unlock_required", experiment, directives: [{ kind: "disable", scope: "arm", arm: "candidate", issuedAt: "2026-09-14T06:00:00Z", reason: "p95 regressed" }] });
    await ap.syncNow();
    assert.equal(ap.status().lastSyncOutcome, "staged", "the new generation itself waits, as every release does");
    assert.equal(ap.generation, 2);
    assert.deepEqual(ap.status().disabled, { agent: false, slots: [], arms: ["candidate"] });
    assert.equal(share(), 0, "the candidate's share went to the control at once");
    assert.equal(ap.prompt("support.reply", { subject: "user-1" }).render({ name: "x" }).text, "Reply A to x");
    assert.deepEqual(ap.status().ramp!.weightBps, [10000, 0], "what the fleet actually serves");
    assert.deepEqual((ap.heartbeatBody().disabled as { arms?: string[] }).arms, ["candidate"], "the fleet view sees the retreat");
    assert.ok(events.some((e) => e.event === "disabled_by_directive" && Array.isArray(e.arms) && (e.arms as string[]).includes("candidate")));
    // Every arm disabled is a Freeze for the tag.
    plane.promote([control], { applyPolicy: "unlock_required", experiment, directives: [{ kind: "disable", scope: "arm", arm: "candidate", issuedAt: "2026-09-14T06:00:00Z" }, { kind: "disable", scope: "arm", arm: "control", issuedAt: "2026-09-14T06:00:00Z" }] });
    await ap.syncNow();
    assert.throws(() => ap.prompt("support.reply", { subject: "user-1" }).render({ name: "x" }), (e: unknown) => e instanceof RenderRefusedError && e.reason === "disabled");
  } finally {
    await ap.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
