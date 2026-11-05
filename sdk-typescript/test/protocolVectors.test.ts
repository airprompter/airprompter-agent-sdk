/** Every protocol vector, through the SDK's own implementations. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { carriedPayloads, optionalPayloads, releaseDigest as digestOf } from "../packages/core/src/protocol/trust.js";

import { assignArm, AssignmentError, orderedSteps, StepError } from "../packages/core/src/protocol/assignment.js";
import { canonicalJson, CanonicalJsonError, sha256Prefixed } from "../packages/core/src/protocol/canonicalJson.js";
import { referencedPayloads, trustedRootFromPinnedKey, verifyManifest, verifyRootMetadata } from "../packages/core/src/protocol/trust.js";
import { disabledFrom, frozenExperiment, servableExperiments, servableSlots } from "../packages/core/src/protocol/assignment.js";
import { mintRunRef, parseRunRef, runRefKeyFrom, RUN_REF_MAX_ENTRIES, RUN_REF_MAX_TOKEN_LENGTH, RUN_REF_READ_MAX_ENTRIES, RUN_REF_READ_MAX_TOKEN_LENGTH } from "../packages/core/src/render/runRef.js";
import { checksRefusals, evaluateChecks, patternRefusal, projectChecks, type DeclaredCheck } from "../packages/core/src/checks/index.js";

const vector = (name: string) => JSON.parse(readFileSync(new URL(`../../protocol/vectors/${name}`, import.meta.url), "utf8"));

test("canonical-json.json", () => {
  const file = vector("canonical-json.json") as { vectors: Array<{ name: string; input: unknown; canonical: string; sha256: string }>; refused: Array<{ name: string; input?: unknown; reason: string }> };
  for (const v of file.vectors) {
    const text = canonicalJson(v.input);
    assert.equal(text, v.canonical, v.name);
    assert.equal(sha256Prefixed(Buffer.from(text, "utf8")), v.sha256, v.name);
  }
  const refusedInputs: Record<string, unknown> = {
    undefined_value: { a: undefined },
    non_integer_number: { n: 1.5 },
    non_finite_number: { n: Number.POSITIVE_INFINITY },
    unsafe_integer: { n: Number.MAX_SAFE_INTEGER + 2 },
    unsupported_type: { d: new Date(0) },
    cycle: (() => {
      const o: Record<string, unknown> = {};
      o.self = o;
      return o;
    })(),
  };
  for (const r of file.refused) {
    assert.throws(() => canonicalJson("input" in r ? r.input : refusedInputs[r.reason]), (error: unknown) => error instanceof CanonicalJsonError && error.reason === r.reason, r.name);
  }
});

test("workflow-steps.json", () => {
  const file = vector("workflow-steps.json") as { vectors: Array<{ name: string; slotTag: string; steps: Array<{ stepId: string; ordinal: number }>; expectedOrder?: string[]; refuse?: string }> };
  for (const v of file.vectors) {
    if (v.refuse) assert.throws(() => orderedSteps(v.slotTag, v.steps), (error: unknown) => error instanceof StepError && error.reason === v.refuse, v.name);
    else assert.deepEqual(orderedSteps(v.slotTag, v.steps).map((s) => s.stepId), v.expectedOrder, v.name);
  }
});

test("assignment.json", () => {
  const file = vector("assignment.json") as { cases: Array<{ name: string; salt: string; subject: string; arms: Array<{ arm: string; weightBps: number }>; expected: { subjectHash: string; bucket: number; arm: string } }>; refused: Array<{ name: string; salt: string; arms: Array<{ arm: string; weightBps: number }>; reason: string }> };
  assert.ok(file.cases.length >= 30);
  for (const c of file.cases) {
    const result = assignArm({ salt: c.salt, subject: c.subject, arms: c.arms });
    assert.deepEqual({ subjectHash: result.subjectHash, bucket: result.bucket, arm: result.arm.arm }, c.expected, c.name);
  }
  for (const r of file.refused) {
    assert.throws(() => assignArm({ salt: r.salt, subject: "user-1", arms: r.arms }), (error: unknown) => error instanceof AssignmentError && error.reason === r.reason, r.name);
  }
});

test("manifest-verify.json", () => {
  const file = vector("manifest-verify.json") as { rootMetadata: Array<Record<string, any>>; manifests: Array<Record<string, any>> };
  assert.ok(file.rootMetadata.length >= 10 && file.manifests.length >= 30);
  for (const c of file.rootMetadata) {
    const trusted = c.trustedRoot ?? trustedRootFromPinnedKey({ purpose: c.purpose, environment: c.environment, pinnedRoot: c.pinnedRoot });
    const result = verifyRootMetadata({ candidate: c.candidate, trusted, now: c.now });
    assert.equal(result.ok, c.expected.ok, c.name);
    if (!result.ok) assert.equal(result.reason, c.expected.reason, c.name);
  }
  for (const c of file.manifests) {
    const payloads = c.payloads ? new Map<string, Uint8Array>(c.payloads.map((p: { contentHash: string; bytes: string }) => [p.contentHash, Buffer.from(p.bytes, "base64url")])) : null;
    const result = verifyManifest({ manifest: c.manifest, root: c.root, now: c.now, scope: c.scope, storedGeneration: c.storedGeneration, payloads, carrying: c.carrying === true, absentRequires: c.absentRequires === true, countersignRoot: c.countersignRoot ?? null, requireCountersign: c.requireCountersign ?? false });
    assert.equal(result.ok, c.expected.ok, `${c.name}: ${JSON.stringify(result)}`);
    if (result.ok) {
      assert.equal(result.signingKeyId, c.expected.signingKeyId, c.name);
      assert.equal(result.generation, c.expected.generation, c.name);
    } else {
      assert.equal(result.reason, c.expected.reason, c.name);
      assert.equal(result.directivesStand === true, c.expected.directivesStand === true, `${c.name}: directives stand`);
    }
  }
  for (const c of (file as unknown as { digests: Array<{ name: string; slots: never; releaseDigest: string }> }).digests) assert.equal(digestOf(c.slots), c.releaseDigest, c.name);
  for (const c of (file as unknown as { carriers: Array<{ name: string; payload: never; carried: Array<[string, number]>; optional: string[] }> }).carriers) {
    assert.deepEqual([...carriedPayloads(c.payload)].sort(([a], [b]) => (a < b ? -1 : 1)), c.carried, c.name);
    assert.deepEqual([...optionalPayloads(c.payload)].sort(), c.optional, c.name);
  }
  for (const c of file.manifests.filter((entry) => entry.frozenTags)) {
    const payload = c.manifest.payload;
    const off = (id: string) => new Set<string>(disabledFrom(payload.directives).armsByExperiment[id] ?? []);
    assert.deepEqual(payload.experiments.filter((experiment: { tag: string }) => frozenExperiment(payload, off, experiment.tag, {})).map((experiment: { tag: string }) => experiment.tag), c.frozenTags, c.name);
  }
  const runs = file.manifests.filter((entry) => entry.frozenRuns);
  assert.ok(runs.length >= 3, "the vector carries the audience cases");
  for (const c of runs) {
    const payload = c.manifest.payload;
    const off = (id: string) => new Set<string>(disabledFrom(payload.directives).armsByExperiment[id] ?? []);
    for (const run of c.frozenRuns) assert.deepEqual(payload.experiments.filter((experiment: { tag: string }) => frozenExperiment(payload, off, experiment.tag, run.tags)).map((experiment: { tag: string }) => experiment.tag), run.frozenTags, `${c.name}: ${run.name}`);
  }
});

test("manifest-verify.json: an override with an unmet requires goes alone", () => {
  const file = vector("manifest-verify.json") as { manifests: Array<Record<string, any>> };
  const cases = file.manifests.filter((c) => c.servableOverrides);
  assert.ok(cases.length >= 2, "the vector carries the cases");
  for (const c of cases) {
    const overrides = Object.fromEntries(servableExperiments(c.manifest.payload).map((experiment) => [experiment.experimentId, Object.fromEntries(experiment.arms.map((arm) => [arm.arm, arm.overrides.map((override) => override.tag)]))]));
    assert.deepEqual(overrides, c.servableOverrides, c.name);
  }
});

test("manifest-verify.json: a slot with an unmet requires is absent and everything else loads, disables included", () => {
  const file = vector("manifest-verify.json") as { manifests: Array<Record<string, any>> };
  const cases = file.manifests.filter((c) => c.servableTags);
  assert.ok(cases.length >= 1, "the vector carries the case");
  for (const c of cases) {
    const payload = c.manifest.payload;
    assert.deepEqual((servableSlots(payload) as Array<{ tag: string }>).map((slot) => slot.tag), c.servableTags, c.name);
    assert.equal(servableExperiments(payload).some((experiment) => c.skippedTags.includes(experiment.tag)), false, `${c.name}: its experiment is ignored`);
    assert.equal([...referencedPayloads(payload).keys()].some((hash) => payload.slots.filter((slot: { tag: string }) => c.skippedTags.includes(slot.tag)).some((slot: { contentHash: string }) => slot.contentHash === hash)), false, `${c.name}: its payload is not required`);
    assert.deepEqual(disabledFrom(payload.directives).slots, c.disabledSlots, `${c.name}: a disable still applies`);
  }
});

test("feedback.json: the one run reference form, the same in every language", () => {
  const rr = vector("feedback.json").runRef as Record<string, any>;
  assert.deepEqual([RUN_REF_MAX_ENTRIES, RUN_REF_MAX_TOKEN_LENGTH, RUN_REF_READ_MAX_ENTRIES, RUN_REF_READ_MAX_TOKEN_LENGTH], [rr.bounds.maxEntries, rr.bounds.maxTokenLength, rr.bounds.readMaxEntries, rr.bounds.readMaxTokenLength]);
  for (const c of rr.keys) assert.equal(Buffer.from(runRefKeyFrom(c.secret, c.agentId, c.target)).toString("hex"), c.keyHex, c.name);
  const key = Buffer.from(rr.keyHex, "hex");
  for (const c of rr.tokens) {
    assert.deepEqual(parseRunRef(c.token, key), c.facts, `parse: ${c.name}`);
    if (c.mintRefused) assert.throws(() => mintRunRef(c.facts, key), /run_ref_facts_invalid/, c.name);
    else {
      assert.equal(mintRunRef(c.facts, key), c.token, `mint: ${c.name}`);
      assert.ok(c.token.length <= RUN_REF_MAX_TOKEN_LENGTH, c.name);
      // What this SDK did not write survives a re-mint: a host grows a ref a later SDK wrote.
      assert.deepEqual(parseRunRef(mintRunRef(parseRunRef(c.token, key)!, key), key), c.facts, `re-mint: ${c.name}`);
    }
  }
  for (const c of rr.mintRefused) assert.throws(() => mintRunRef(c.facts, key), /run_ref_facts_invalid/, c.name);
  const previous = Buffer.from(rr.rotation.previousKeyHex, "hex");
  assert.deepEqual(parseRunRef(rr.rotation.token, [Buffer.from(rr.rotation.currentKeyHex, "hex"), previous]), rr.rotation.facts, rr.rotation.name);
  assert.equal(parseRunRef(rr.rotation.token, key), null, "without the previous key it does not parse");
  for (const c of rr.refused) assert.equal(parseRunRef(c.token, key), null, c.name);
});

// T29: the output-check evaluator agrees with the reference on every vector — verdicts and reasons, the regex safety
// rule, the declaration refusals, and the pin projection.
test("checks.json: evaluations, patterns, declarations and the projection", () => {
  const file = vector("checks.json") as {
    evaluations: Array<{ name: string; checks: DeclaredCheck[]; input: { text: string; outputTokens: number | null }; expected: unknown }>;
    patterns: Array<{ pattern: string; refusal: string | null }>;
    declarations: Array<{ name: string; checks: unknown; refusals: unknown }>;
    projection: { checks: DeclaredCheck[]; expected: unknown };
  };
  for (const v of file.evaluations) assert.deepEqual(evaluateChecks(v.checks, v.input), v.expected, v.name);
  for (const v of file.patterns) assert.equal(patternRefusal(v.pattern), v.refusal, JSON.stringify(v.pattern).slice(0, 40));
  for (const v of file.declarations) assert.deepEqual(checksRefusals(v.checks), v.refusals, v.name);
  assert.deepEqual(projectChecks(file.projection.checks), file.projection.expected);
  assert.ok(file.evaluations.length >= 20);
});

test("a variable's default and source are in the release digest only when present; a null is unset", () => {
  const slot = { tag: "a", kind: "prompt" as const, artifactId: "prm_1", versionId: "v1", versionOrdinal: 1, contentHash: `sha256:${"a".repeat(64)}` as const, byteLength: 1, model: "gpt-5", variables: [{ name: "tone", required: false, trust: "operator" as const }] };
  const plain = digestOf([slot]);
  assert.equal(digestOf([{ ...slot, variables: [{ ...slot.variables[0]!, default: null as unknown as string, source: null as unknown as "caller" }] }]), plain, "a null is unset");
  assert.notEqual(digestOf([{ ...slot, variables: [{ ...slot.variables[0]!, default: "warm" }] }]), plain, "a default changes the digest");
  assert.notEqual(digestOf([{ ...slot, variables: [{ ...slot.variables[0]!, source: "runtime" }] }]), plain, "a source changes the digest");
});

test("a slot's requires is in the release digest when present", () => {
  const slot = { tag: "a", kind: "prompt" as const, artifactId: "prm_1", versionId: "v1", versionOrdinal: 1, contentHash: `sha256:${"a".repeat(64)}` as const, byteLength: 1, model: "gpt-5", variables: [] };
  assert.notEqual(digestOf([{ ...slot, requires: ["rubric_slots"] }]), digestOf([slot]));
});

// One shared input corpus proves exact matching and refusal parity across languages.
import { matchesAudience, validAudienceSelector, validAudienceKey, validAudienceLabel, validAudienceInstant } from "../packages/core/src/protocol/assignment.js";
test("audiences.json: exact local audience predicates", () => {
  for (const c of vector("audiences.json").cases) {
    assert.equal(validAudienceSelector(c.selector), c.valid, c.name);
    assert.equal(matchesAudience(c.selector,c.tags), c.matches, c.name);
  }
  for (const c of vector("audiences.json").validators) {
    const actual=c.kind === "key" ? validAudienceKey(c.value) : c.kind === "label" ? validAudienceLabel(c.value) : validAudienceInstant(c.value);
    assert.equal(actual,c.valid,c.name);
  }
});

test("audiences.json: signed major version, capability refusal and selector tampering", () => {
  for (const c of vector("audiences.json").manifests) {
    const verdict=verifyManifest(c);
    assert.equal(verdict.ok,c.expected.ok,c.name);
    if (!verdict.ok) assert.equal(verdict.reason,c.expected.reason,c.name);
    if (c.disabledSlots) assert.deepEqual(disabledFrom(c.manifest.payload.directives).slots, c.disabledSlots, c.name);
  }
});
