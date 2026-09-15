/**
 * S16: one experiment per prompt. Two slots split independently on their own salts (the protocol's perTag vectors,
 * then the runtime end to end); a candidate may be another prompt under the same key (D79); an arm-scoped disable
 * retreats one experiment and leaves the other alone; the conflicts are refused whole at verification (M15); a
 * 0.2-shaped manifest (one `experiment`) still verifies and splits every slot it overrides.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent } from "../packages/sdk/src/agent.js";
import { assignArm } from "../packages/core/src/protocol/assignment.js";
import { publicJwkOf, releaseDigest, verifyManifest } from "../packages/core/src/protocol/trust.js";
import { experimentConflict, experimentForTag, experimentsOf, type Experiment, type Manifest, type ManifestPayload } from "../packages/core/src/protocol/types.js";
import { FakeControlPlane } from "../packages/core/src/testing/index.js";

const vectors = JSON.parse(readFileSync(new URL("../../protocol/vectors/assignment.json", import.meta.url), "utf8")) as {
  perTag: {
    cases: Array<{ name: string; subject: string; experiments: Array<{ experimentId: string; tag: string; salt: string; arms: Array<{ arm: string; weightBps: number }> }>; tags: string[]; expected: Record<string, { experimentId: string | null; bucket: number | null; arm: string }> }>;
    refused: Array<{ name: string; reason: string }>;
  };
};

test("the protocol's perTag vectors: each experiment assigns on its own salt; a tag outside every experiment is arm none", () => {
  assert.ok(vectors.perTag.cases.length >= 3);
  for (const c of vectors.perTag.cases) {
    const payload = { experiments: c.experiments.map((e) => ({ ...e, subjectKey: "request" as const, arms: e.arms.map((a) => ({ ...a, releaseDigest: `sha256:${"0".repeat(64)}` as const, overrides: [] })) })) };
    for (const tag of c.tags) {
      const experiment = experimentForTag(payload, tag);
      const expected = c.expected[tag]!;
      if (!experiment) {
        assert.deepEqual({ experimentId: null, bucket: null, arm: "none" }, expected, `${c.name}: ${tag}`);
        continue;
      }
      const assigned = assignArm({ salt: experiment.salt, subject: c.subject, arms: experiment.arms });
      assert.deepEqual({ experimentId: experiment.experimentId, bucket: assigned.bucket, arm: assigned.arm.arm }, expected, `${c.name}: ${tag}`);
    }
  }
  assert.deepEqual(vectors.perTag.refused.map((r) => r.reason), ["experiment_conflict", "experiment_conflict", "experiment_conflict"]);
});

test("M15: the conflicts are refused whole at verification; a legacy single experiment still verifies", () => {
  const scope = { organizationId: "org_1", agentId: "agt_pp", target: "prod" as const };
  const plane = new FakeControlPlane(scope);
  const triage = plane.slot({ tag: "support.triage", text: "Triage A", versionId: "a", variables: [] });
  const reply = plane.slot({ tag: "support.reply", text: "Reply A", versionId: "a", variables: [] });
  const triageB = plane.slot({ tag: "support.triage", text: "Triage B", versionId: "b", variables: [] });
  const base = releaseDigest([triage, reply]);
  const exp = (experimentId: string, tag: string, overrides: typeof triageB[] = []): Experiment => ({ experimentId, tag, salt: "AAECAwQFBgcICQoLDA0ODw", subjectKey: "request", arms: [{ arm: "control", weightBps: 9000, releaseDigest: base, overrides: [] }, { arm: "candidate", weightBps: 1000, releaseDigest: releaseDigest([triageB, reply]), overrides }] });
  const untagged = (experiment: Experiment): Experiment => {
    const { tag: _tag, ...rest } = experiment;
    return rest;
  };
  const verify = (manifest: Manifest) => verifyManifest({ manifest, root: plane.root, now: new Date().toISOString(), scope, storedGeneration: 0, payloads: null, countersignRoot: null, requireCountersign: false });
  const conflict = (patch: Partial<ManifestPayload>) => experimentConflict({ ...plane.promote([triage, reply], { generation: 1 }).payload, ...patch });

  assert.equal(conflict({ experiments: [exp("exp_a", "support.triage", [triageB]), exp("exp_b", "support.reply")] }), null);
  assert.equal(conflict({ experiment: untagged(exp("exp_legacy", "x")), experiments: [exp("exp_b", "support.reply")] }), "experiment_conflict", "both keys");
  assert.equal(conflict({ experiments: [exp("exp_a", "support.triage"), exp("exp_b", "support.triage")] }), "experiment_conflict", "a slot twice");
  assert.equal(conflict({ experiments: [exp("exp_a", "support.triage", [reply])] }), "experiment_conflict", "an override for another slot");
  assert.equal(conflict({ experiments: [exp("exp_a", "docs.missing")] }), "experiment_conflict", "a slot the release does not carry");
  assert.equal(conflict({ experiments: [exp("exp_a", "support.triage")], directives: [{ kind: "disable", scope: "arm", arm: "candidate", issuedAt: "2026-09-14T00:00:00Z" }] }), "experiment_conflict", "an arm disable without its experiment");
  assert.equal(conflict({ experiments: [exp("exp_a", "support.triage")], directives: [{ kind: "disable", scope: "arm", arm: "candidate", experimentId: "exp_a", issuedAt: "2026-09-14T00:00:00Z" }] }), null);

  const good = plane.promote([triage, reply], { experiments: [exp("exp_a", "support.triage", [triageB]), exp("exp_b", "support.reply")] });
  assert.equal(verify(good).ok, true);
  const bad = plane.promote([triage, reply], { experiments: [exp("exp_a", "support.triage"), exp("exp_b", "support.triage")] });
  assert.deepEqual(verify(bad), { ok: false, reason: "experiment_conflict" });
  // 0.2's shape: one experiment, no tag, every slot it overrides splits.
  const legacy = plane.promote([triage, reply], { experiment: untagged(exp("exp_legacy", "support.triage", [triageB])) });
  assert.equal(verify(legacy).ok, true);
  assert.equal(experimentsOf(legacy.payload).length, 1);
  assert.equal(experimentForTag(legacy.payload, "support.reply")?.experimentId, "exp_legacy", "the legacy split decides every slot");
});

test("two prompts split independently, a candidate may be another prompt under the same key, and an arm disable retreats one experiment only", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-perprompt-"));
  const scope = { organizationId: "org_1", agentId: "agt_pp2", target: "prod" as const };
  const plane = new FakeControlPlane(scope);
  const triage = plane.slot({ tag: "support.triage", text: "Triage A", versionId: "a", variables: [] });
  const triageB = plane.slot({ tag: "support.triage", text: "Triage B", versionId: "b", variables: [] });
  const reply = plane.slot({ tag: "support.reply", text: "Reply A", versionId: "a", variables: [] });
  // D79: the reply candidate is ANOTHER prompt (its own artifact) served under the reply key.
  const retention = { ...plane.slot({ tag: "support.reply", text: "Retention script", versionId: "r1", variables: [] }), artifactId: "prm_retention" };
  const base = releaseDigest([triage, reply]);
  const experiments: Experiment[] = [
    { experimentId: "exp_triage", tag: "support.triage", salt: "AAECAwQFBgcICQoLDA0ODw", subjectKey: "request", arms: [{ arm: "control", weightBps: 5000, releaseDigest: base, overrides: [] }, { arm: "candidate", weightBps: 5000, releaseDigest: releaseDigest([triageB, reply]), overrides: [triageB] }] },
    { experimentId: "exp_reply", tag: "support.reply", salt: "EBESExQVFhcYGRobHB0eHw", subjectKey: "request", arms: [{ arm: "control", weightBps: 5000, releaseDigest: base, overrides: [] }, { arm: "candidate", weightBps: 5000, releaseDigest: releaseDigest([triage, retention]), overrides: [retention] }] },
  ];
  plane.promote([triage, reply], { applyPolicy: "auto", experiments });
  const ap = await AirPrompterAgent.start({ ...scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" }, fetch: plane.fetch(), telemetry: { sink: "memory" } });
  try {
    const subjects = Array.from({ length: 400 }, (_, i) => `user-${i}`);
    const armOf = (tag: string, s: string) => ap.prompt(tag, { subject: s }).render({});
    // Each key splits about in half…
    const triageCandidates = subjects.filter((s) => armOf("support.triage", s).arm === "candidate");
    const replyCandidates = subjects.filter((s) => armOf("support.reply", s).arm === "candidate");
    assert.ok(triageCandidates.length > 150 && triageCandidates.length < 250, `triage ~50 %: ${triageCandidates.length}`);
    assert.ok(replyCandidates.length > 150 && replyCandidates.length < 250, `reply ~50 %: ${replyCandidates.length}`);
    // …independently: being on the triage candidate says nothing about the reply arm (own salts).
    const both = triageCandidates.filter((s) => replyCandidates.includes(s)).length;
    assert.ok(both > 60 && both < 140, `independent splits: ${both} of ${triageCandidates.length} on both`);
    // The reply candidate IS the other prompt: same key, different text and version.
    const onRetention = armOf("support.reply", replyCandidates[0]!);
    assert.equal(onRetention.text, "Retention script");
    assert.equal(onRetention.versionId, "r1");
    assert.equal(armOf("support.reply", subjects.find((s) => !replyCandidates.includes(s))!).text, "Reply A");
    // Both ramps are reported, by slot.
    assert.deepEqual(ap.status().ramps.map((r) => [r.experimentId, r.tag, r.weightBps]), [["exp_triage", "support.triage", [5000, 5000]], ["exp_reply", "support.reply", [5000, 5000]]]);
    assert.equal(ap.status().ramp?.experimentId, "exp_triage", "ramp is the first, for older readers");

    // The retreat on ONE experiment: the reply candidate's share goes back to its control; triage is untouched.
    plane.promote([triage, reply], { applyPolicy: "auto", experiments, directives: [{ kind: "disable", scope: "arm", experimentId: "exp_reply", arm: "candidate", issuedAt: "2026-09-14T00:00:00Z" }] });
    await ap.syncNow();
    assert.equal(subjects.filter((s) => armOf("support.reply", s).arm === "candidate").length, 0, "nobody on the reply candidate");
    assert.equal(subjects.filter((s) => armOf("support.triage", s).arm === "candidate").length, triageCandidates.length, "the triage split did not move");
    assert.deepEqual(ap.status().ramps.map((r) => r.weightBps), [[5000, 5000], [10000, 0]]);
    assert.deepEqual(ap.status().disabled.arms, ["candidate"]);
  } finally {
    await ap.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
