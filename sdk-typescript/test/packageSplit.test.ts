/**
 * S10 — the package split. The rules, each with its vector:
 *
 *   1. The direction is core → clients → sdk → binary, and a sibling is
 *      reached only through its barrel: `scripts/lint-imports.mjs` pins the
 *      edge set, and a planted upward import fails it.
 *   2. Two copies of a package in one lockfile agree: an error, a release
 *      and a sink from copy A are recognised by copy B (S1's discriminant
 *      rule, now across package copies rather than classes).
 *   3. `agent-runtime` alone renders and assigns over a bundle the customer
 *      loads — no store, no daemon, no network; `agent-telemetry` alone
 *      writes the spool; `agent-sync` alone pulls and verifies.
 *   4. Every package publishes under its size budget, and the five carry
 *      one version with exact-pinned siblings.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createPlaintextBundle } from "../packages/core/src/bundle/apbundle.js";
import { AssignmentError, isAssignmentError } from "../packages/core/src/protocol/assignment.js";
import { publicJwkOf, trustedRootFromPinnedKey } from "../packages/core/src/protocol/trust.js";
import { SDK_VERSION } from "../packages/core/src/protocol/version.js";
import type { Bundle } from "../packages/core/src/protocol/types.js";
import { BundleRelease } from "../packages/core/src/release/bundleRelease.js";
import { FakeControlPlane } from "../packages/core/src/testing/index.js";
import { ReleaseResolver } from "../packages/runtime/src/release/resolver.js";
import { StoreError, isStoreError } from "../packages/sync/src/store/slotStore.js";
import { MemorySink, SpoolWriter } from "../packages/telemetry/src/spool/writer.js";

const root = process.cwd();
const scope = { organizationId: "org_1", agentId: "agt_split", target: "prod" as const };
const PACKAGES = ["core", "sync", "runtime", "telemetry", "otel-bridge", "sdk"] as const;

function ensureBuilt(): void {
  if (!existsSync(join(root, "packages", "sdk", "dist", "esm", "index.js"))) execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], { stdio: "ignore" });
}

function lint(args: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(root, "scripts", "lint-imports.mjs"), ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("S10: the direction is core → clients → sdk → binary; the edge set is pinned; a planted upward import fails the lint", () => {
  const clean = lint(["--json"]);
  assert.equal(clean.status, 0, clean.stderr);
  const { edges } = JSON.parse(clean.stdout.slice(0, clean.stdout.lastIndexOf("}") + 1)) as { edges: string[] };
  assert.deepEqual(edges, ["cli→core", "cli→otel-bridge", "cli→runtime", "cli→sdk", "cli→sync", "cli→telemetry", "otel-bridge→core", "runtime→core", "sdk→core", "sdk→runtime", "sdk→sync", "sdk→telemetry", "sync→core", "telemetry→core"], "the clients never import each other; core imports nothing of ours; the bridge is a client of core alone");
  const probe = join(root, "packages", "telemetry", "src", "_lintProbe.ts");
  writeFileSync(probe, 'import { SlotStore } from "@airprompter/agent-sync";\nexport const probe = typeof SlotStore;\n');
  try {
    const planted = lint();
    assert.equal(planted.status, 1, "an upward import is refused");
    assert.match(planted.stderr, /telemetry \(layer 1\) may not import sync \(layer 1\)/);
  } finally {
    unlinkSync(probe);
  }
  const byPath = join(root, "packages", "runtime", "src", "_lintProbe.ts");
  writeFileSync(byPath, 'import { canonicalJson } from "../../core/src/protocol/canonicalJson.js";\nexport const probe = typeof canonicalJson;\n');
  try {
    const planted = lint();
    assert.equal(planted.status, 1, "a relative path into a sibling is refused even when the direction is right");
    assert.match(planted.stderr, /reaches into core by path/);
  } finally {
    unlinkSync(byPath);
  }
});

test("S10: two copies of a package agree — an error, a release and a sink from one copy are recognised by the other (no instanceof coupling)", async () => {
  // A second copy of each package: the built dist beside the source is a different module instance of every class,
  // which is exactly what two versions of core in one lockfile look like at run time.
  ensureBuilt();
  const dist = (name: string) => import(new URL(`../packages/${name}/dist/esm/index.js`, import.meta.url).href) as Promise<unknown>;
  const coreB = (await dist("core")) as typeof import("../packages/core/src/index.js");
  const syncB = (await dist("sync")) as typeof import("../packages/sync/src/index.js");
  const telemetryB = (await dist("telemetry")) as typeof import("../packages/telemetry/src/index.js");
  assert.notEqual(coreB.AssignmentError, AssignmentError, "two module instances");
  assert.ok(coreB.isAssignmentError(new AssignmentError("ramp_invalid")), "copy B recognises copy A's error by name and shape");
  assert.ok(isAssignmentError(new coreB.AssignmentError("ramp_invalid")));
  assert.ok(syncB.isStoreError(new StoreError("no_release", "x")));
  assert.ok(isStoreError(new syncB.StoreError("no_release", "x")));
  // A release verified by copy A is served by a runtime holding copy B's types: structural, never a class.
  const plane = new FakeControlPlane(scope);
  plane.promote([plane.slot({ tag: "support.reply", text: "Hello {{name}}", versionId: "v1", variables: [{ name: "name", required: true, trust: "operator" }] })]);
  const bundle = bundleOf(plane);
  const loadedA = BundleRelease.load({ bundle, root: trustedRootFromPinnedKey({ purpose: "platform", environment: "prod", pinnedRoot: publicJwkOf(plane.rootKey) }), scope, now: new Date().toISOString() });
  assert.ok(loadedA.ok, JSON.stringify(loadedA));
  const loadedB = coreB.BundleRelease.load({ bundle, root: coreB.trustedRootFromPinnedKey({ purpose: "platform", environment: "prod", pinnedRoot: publicJwkOf(plane.rootKey) }), scope, now: new Date().toISOString() });
  assert.ok(loadedB.ok);
  assert.deepEqual(loadedA.release.current().manifest, loadedB.release.current().manifest);
  // A sink from copy B drives copy A's writer: the sink is what its kind and capabilities say.
  const sinkB = new telemetryB.MemorySink({ instanceId: "i-1" });
  const writer = new SpoolWriter(sinkB as unknown as MemorySink, { instanceId: "i-1", instanceClass: "ephemeral", sdk: "test/0" });
  writer.refusal({ at: new Date().toISOString(), reason: "lease_expired", generation: 1, tag: null }, Date.now());
  assert.equal(sinkB.drain(Date.now()).length, 1);
});

function bundleOf(plane: FakeControlPlane, notAfter = "2027-01-01T00:00:00Z"): Bundle {
  return createPlaintextBundle({ createdAt: new Date().toISOString(), notAfter, manifest: plane.manifest!, keySet: plane.root, payloads: [...plane.payloads].map(([contentHash, bytes]) => ({ contentHash: contentHash as `sha256:${string}`, byteLength: bytes.length, bytes: bytes.toString("base64url") })) });
}

test("S10 core flow: agent-runtime alone renders and assigns over a bundle the customer loads — verified like OTA, no store, no daemon, no network; a relabelled or tampered bundle is refused", () => {
  const plane = new FakeControlPlane(scope);
  const control = plane.slot({ tag: "support.reply", text: "Reply A to {{name}}", versionId: "v1", variables: [{ name: "name", required: true, trust: "operator" }] });
  const candidate = plane.slot({ tag: "support.reply", text: "Reply B to {{name}}", versionId: "v2", variables: [{ name: "name", required: true, trust: "operator" }] });
  plane.promote([control], {
    experiment: { experimentId: "exp_1", salt: "c2FsdHNhbHRzYWx0c2FsdHNhbHQ", subjectKey: "request", arms: [{ arm: "control", weightBps: 5000, releaseDigest: plane.manifest?.payload.releaseDigest ?? ("sha256:" + "0".repeat(64) as `sha256:${string}`), overrides: [] }, { arm: "candidate", weightBps: 5000, releaseDigest: ("sha256:" + "1".repeat(64)) as `sha256:${string}`, overrides: [candidate] }] },
  });
  const bundle = bundleOf(plane);
  const pinned = trustedRootFromPinnedKey({ purpose: "platform", environment: "prod", pinnedRoot: publicJwkOf(plane.rootKey) });
  const loaded = BundleRelease.load({ bundle, root: pinned, scope, now: new Date().toISOString() });
  assert.ok(loaded.ok, JSON.stringify(loaded));
  assert.equal(loaded.release.kind, "bundle");
  const resolver = new ReleaseResolver({ release: loaded.release.current(), runRefKey: Buffer.alloc(32, 7), agentId: scope.agentId, target: scope.target, instanceId: "host-1", nowMs: () => Date.now() });
  const seen = new Set<string>();
  for (let i = 0; i < 100; i += 1) {
    const outcome = resolver.resolve("support.reply", `user-${i}`);
    assert.ok(outcome.ok);
    const rendered = resolver.render(outcome, { name: "Ada" });
    assert.match(rendered.text, /^Reply [AB] to Ada$/);
    assert.equal(rendered.arm === "candidate", rendered.text.startsWith("Reply B"), "the arm's override is the text");
    seen.add(rendered.arm);
  }
  assert.deepEqual([...seen].sort(), ["candidate", "control"], "a 50/50 split lands on both arms");
  assert.deepEqual(resolver.resolve("nope"), { ok: false, reason: "no_slot", tag: "nope" });
  // The chain still stands: another agent's bundle, a stranger's root, a tampered payload.
  assert.deepEqual(BundleRelease.load({ bundle, root: pinned, scope: { ...scope, agentId: "agt_other" }, now: new Date().toISOString() }), { ok: false, reason: "bundle_relabelled" });
  const stranger = new FakeControlPlane(scope);
  const strangerRoot = trustedRootFromPinnedKey({ purpose: "platform", environment: "prod", pinnedRoot: publicJwkOf(stranger.rootKey) });
  const refused = BundleRelease.load({ bundle, root: strangerRoot, scope, now: new Date().toISOString() });
  assert.ok(!refused.ok && refused.reason === "unknown_signing_key", JSON.stringify(refused));
  const tampered = JSON.parse(JSON.stringify(bundle)) as Bundle;
  if (tampered.encryption.scheme === "none") tampered.encryption.contents.payloads[0]!.bytes = Buffer.from("Reply Z to {{name}}").toString("base64url");
  const bad = BundleRelease.load({ bundle: tampered, root: pinned, scope, now: new Date().toISOString() });
  assert.ok(!bad.ok && bad.reason === "payload_hash_mismatch", JSON.stringify(bad));
});

test("S10: the runtime walks the protocol's ramp vectors over a bundle release — every case, every host clock, the retreat — with no facade", () => {
  const vectors = JSON.parse(readFileSync(new URL("../../protocol/vectors/ramp.json", import.meta.url), "utf8")) as {
    cases: Array<{ name: string; now?: string; salt: string; arms: Array<{ arm: string; weightBps: number }>; ramp: Array<{ notBefore: string; weightBps: number[] }>; directives: Array<Record<string, unknown>>; hosts?: { hostA: { now: string }; hostB: { now: string } }; expected: { assignments: Array<{ subject: string; bucket: number; arm?: string; hostA?: string; hostB?: string }> } }>;
  };
  for (const c of vectors.cases) {
    const plane = new FakeControlPlane(scope);
    const control = plane.slot({ tag: "support.reply", text: "A", versionId: "v1", variables: [] });
    const candidate = plane.slot({ tag: "support.reply", text: "B", versionId: "v2", variables: [] });
    const controlDigest = ("sha256:" + "0".repeat(64)) as `sha256:${string}`;
    plane.promote([control], {
      experiment: { experimentId: "exp_ramp", salt: c.salt, subjectKey: "request", arms: c.arms.map((arm) => ({ arm: arm.arm, weightBps: arm.weightBps, releaseDigest: controlDigest, overrides: arm.arm === "candidate" ? [candidate] : [] })), ramp: c.ramp },
      directives: c.directives.map((d) => ({ ...d, issuedAt: d.issuedAt ?? "2026-09-14T00:00:00Z" })) as never,
    });
    const loaded = BundleRelease.load({ bundle: bundleOf(plane), root: trustedRootFromPinnedKey({ purpose: "platform", environment: "prod", pinnedRoot: publicJwkOf(plane.rootKey) }), scope, now: "2026-09-13T00:00:00Z" });
    assert.ok(loaded.ok, `${c.name}: ${JSON.stringify(loaded)}`);
    const at = (now: string, field: "arm" | "hostA" | "hostB") => {
      const resolver = new ReleaseResolver({ release: loaded.release.current(), runRefKey: Buffer.alloc(32, 1), agentId: scope.agentId, target: scope.target, instanceId: "host", nowMs: () => Date.parse(now) });
      for (const entry of c.expected.assignments) {
        const outcome = resolver.resolve("support.reply", entry.subject);
        assert.ok(outcome.ok, `${c.name}: ${entry.subject}`);
        assert.deepEqual({ bucket: outcome.bucket, arm: outcome.arm }, { bucket: entry.bucket, arm: entry[field] }, `${c.name}: ${entry.subject} at ${now}`);
      }
    };
    if (c.hosts) {
      at(c.hosts.hostA.now, "hostA");
      at(c.hosts.hostB.now, "hostB");
    } else at(c.now!, "arm");
  }
});

test("S10: the five packages carry one version, exact-pinned siblings, the lockstep direction in their dependencies, and each publishes under its size budget", () => {
  const manifests = Object.fromEntries(PACKAGES.map((name) => [name, JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8")) as { name: string; version: string; dependencies?: Record<string, string>; airprompter: { sizeBudgetBytes: number } }]));
  const versions = new Set(PACKAGES.map((name) => manifests[name]!.version));
  assert.equal(versions.size, 1, "one version");
  const version = [...versions][0]!;
  for (const name of PACKAGES) {
    assert.equal(manifests[name]!.name, name === "otel-bridge" ? "@airprompter/otel-bridge" : `@airprompter/agent-${name}`);
    for (const [dep, range] of Object.entries(manifests[name]!.dependencies ?? {})) {
      assert.match(dep, /^@airprompter\/agent-(core|sync|runtime|telemetry)$/, `${name} depends only on siblings below it`);
      assert.equal(range, version, `${name} → ${dep} is exact-pinned to the lockstep version`);
    }
  }
  // The version the heartbeat and store.json report is the version that shipped: SDK_VERSION never drifts from package.json (it did, 0.1.0 → 0.2.0).
  assert.equal(SDK_VERSION, version, "SDK_VERSION is the lockstep version");
  assert.deepEqual(Object.keys(manifests.core!.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(manifests.sdk!.dependencies ?? {}).sort(), ["@airprompter/agent-core", "@airprompter/agent-runtime", "@airprompter/agent-sync", "@airprompter/agent-telemetry"], "the facade never pulls the bridge in: a collector is optional");
  assert.deepEqual(Object.keys(manifests["otel-bridge"]!.dependencies ?? {}), ["@airprompter/agent-core"]);
  ensureBuilt();
  const sizes = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "size-budget.mjs"), "--json"], { encoding: "utf8" })) as Record<string, { bytes: number; budget: number }>;
  for (const name of PACKAGES) {
    assert.ok(sizes[name]!.bytes > 0, `${name} built`);
    assert.ok(sizes[name]!.bytes <= sizes[name]!.budget, `${name}: ${sizes[name]!.bytes} bytes over its ${sizes[name]!.budget}-byte budget`);
  }
  // Every source the CLI bundles from must reach the sidecar image's build stage: a package added here and not there
  // builds everywhere but the Dockerfile (S13 found it in CI).
  const dockerfile = readFileSync(join(root, "..", "deploy", "docker", "Dockerfile"), "utf8");
  for (const name of PACKAGES) assert.ok(dockerfile.includes(`COPY sdk-typescript/packages/${name}/src sdk-typescript/packages/${name}/src`), `deploy/docker/Dockerfile copies packages/${name}/src`);
});
