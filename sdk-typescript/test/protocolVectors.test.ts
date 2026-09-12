/** Every protocol vector, through the SDK's own implementations. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { assignArm, AssignmentError, orderedSteps, StepError } from "../src/protocol/assignment.js";
import { canonicalJson, CanonicalJsonError, sha256Prefixed } from "../src/protocol/canonicalJson.js";
import { trustedRootFromPinnedKey, verifyManifest, verifyRootMetadata } from "../src/protocol/trust.js";

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
    const result = verifyManifest({ manifest: c.manifest, root: c.root, now: c.now, scope: c.scope, storedGeneration: c.storedGeneration, payloads, countersignRoot: c.countersignRoot ?? null, requireCountersign: c.requireCountersign ?? false });
    assert.equal(result.ok, c.expected.ok, `${c.name}: ${JSON.stringify(result)}`);
    if (result.ok) {
      assert.equal(result.signingKeyId, c.expected.signingKeyId, c.name);
      assert.equal(result.generation, c.expected.generation, c.name);
    } else assert.equal(result.reason, c.expected.reason, c.name);
  }
});
