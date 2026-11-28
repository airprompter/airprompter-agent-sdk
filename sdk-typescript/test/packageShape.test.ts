/**
 * The one package and what sits beside it. The rules, each with its vector:
 *
 *   1. The direction inside the package is core → sync, runtime, telemetry →
 *      agent, frameworks → steps, and a layer is reached only through its barrel:
 *      `scripts/lint-imports.mjs` pins the edge set, and a planted upward or
 *      deep import fails it.
 *   2. Two copies of the SDK in one process agree: an error, a release and a
 *      sink from copy A are recognised by copy B (S1's discriminant rule).
 *   3. `/runtime` alone renders and assigns over a bundle the customer loads:
 *      no store, no daemon, no network.
 *   4. The exports map is exactly what is pinned here, each layer's subpath is
 *      its curated entry (the names: `test/publicSurface.test.ts`), and the
 *      tarball carries each declared subpath and nothing past it.
 *   5. Every package publishes under its size budget, the packages carry one
 *      version with the SDK as an exact-pinned peer, and `SDK_VERSION` is that
 *      version. No removed package name is left anywhere in the repository.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createPlaintextBundle } from "../packages/sdk/src/core/bundle/apbundle.js";
import { AssignmentError, isAssignmentError } from "../packages/sdk/src/core/protocol/assignment.js";
import { publicJwkOf, trustedRootFromPinnedKey, releaseDigest } from "../packages/sdk/src/core/protocol/trust.js";
import { SDK_VERSION } from "../packages/sdk/src/core/protocol/version.js";
import type { Bundle } from "../packages/sdk/src/core/protocol/types.js";
import { BundleRelease } from "../packages/sdk/src/core/release/bundleRelease.js";
import { FakeControlPlane } from "../packages/sdk/src/core/testing/index.js";
import { ReleaseResolver } from "../packages/sdk/src/runtime/release/resolver.js";
import { StoreError, isStoreError } from "../packages/sdk/src/sync/store/slotStore.js";
import { MemorySink, SpoolWriter } from "../packages/sdk/src/telemetry/spool/writer.js";

const root = process.cwd();
const scope = { organizationId: "org_1", agentId: "agt_split", target: "prod" as const };
const SATELLITES = ["agent-otel", "datastore-s3", "datastore-postgres", "datastore-redis"] as const;
const PACKAGES = ["sdk", ...SATELLITES] as const;
const SUBPATHS = [".", "./core", "./sync", "./runtime", "./telemetry", "./testing", "./frameworks/contract", "./frameworks/openai", "./frameworks/anthropic", "./frameworks/ai-sdk", "./frameworks/langchain", "./frameworks/steps"];
/** Rule 4 of section 3.2: the facade's line count after AIR-2231's deletions. A change that grows it moves this number on purpose. */
const AGENT_TS_LINES = 2498;
type Manifest = { name: string; version: string; private?: boolean; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }>; devDependencies?: Record<string, string>; exports: Record<string, { import: { types: string; default: string }; require: { types: string; default: string } }>; typesVersions: Record<string, Record<string, string[]>>; airprompter: { sizeBudgetBytes: number | Record<string, number> } };
const manifestOf = (name: string): Manifest => JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8")) as Manifest;

function ensureBuilt(): void {
  // The last file the build writes, the same sentinel as test/publicSurface.test.ts: a half-built dist rebuilds.
  if (!existsSync(join(root, "packages", "datastore-redis", "dist", "cjs", "index.d.ts"))) execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], { stdio: "ignore" });
}

function lint(args: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(root, "scripts", "lint-imports.mjs"), ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function planted(path: string, source: string): { status: number | null; stderr: string } {
  writeFileSync(path, source);
  try {
    return lint();
  } finally {
    unlinkSync(path);
  }
}

test("the direction is core → sync, runtime, telemetry → agent, frameworks → steps → integrations; the edge set is pinned; a planted upward or deep import fails the lint", () => {
  const clean = lint(["--json"]);
  assert.equal(clean.status, 0, clean.stderr);
  const { edges } = JSON.parse(clean.stdout.slice(0, clean.stdout.lastIndexOf("}") + 1)) as { edges: string[] };
  assert.deepEqual(edges, ["agent-otel→core", "agent→core", "agent→runtime", "agent→sync", "agent→telemetry", "cli→agent", "cli→agent-otel", "cli→core", "cli→sync", "cli→telemetry", "datastore-postgres→sync", "datastore-redis→sync", "datastore-s3→sync", "frameworks→core", "frameworks→runtime", "n8n→steps", "runtime→core", "steps→agent", "steps→core", "steps→sync", "sync→core", "telemetry→core", "zapier→steps"], "the middle layers never import each other; core imports nothing of ours; the exporter uses core alone and the datastores sync alone; Steps drives the agent and the integrations reach the SDK only through Steps");
  const src = join(root, "packages", "sdk", "src");
  const upward = planted(join(src, "telemetry", "_lintProbe.ts"), 'import { SlotStore } from "../sync/index.js";\nexport const probe = typeof SlotStore;\n');
  assert.equal(upward.status, 1, "a sideways import is refused");
  assert.match(upward.stderr, /telemetry \(layer 1\) may not import sync \(layer 1\)/);
  const deep = planted(join(src, "sync", "_lintProbe.ts"), 'import { canonicalJson } from "../core/protocol/canonicalJson.js";\nexport const probe = typeof canonicalJson;\n');
  assert.equal(deep.status, 1, "a path past the barrel is refused even when the direction is right");
  assert.match(deep.stderr, /reaches into core by path/);
  const deepType = planted(join(src, "frameworks", "_lintProbe.ts"), 'export type { Manifest } from "../core/protocol/types.js";\n');
  assert.equal(deepType.status, 1, "a type-only import past the barrel is refused too");
  const byName = planted(join(src, "runtime", "_lintProbe.ts"), 'import { canonicalJson } from "@airprompter/agent-sdk/core";\nexport const probe = typeof canonicalJson;\n');
  assert.equal(byName.status, 1, "the package never imports itself by name");
  assert.match(byName.stderr, /imports @airprompter\/agent-sdk\/core by name/);
  const adapterUp = planted(join(src, "frameworks", "_lintProbe.ts"), 'import { AirPrompterAgent } from "../agent.js";\nexport const probe = typeof AirPrompterAgent;\n');
  assert.equal(adapterUp.status, 1, "an adapter never imports the composition root");
  const coreUp = planted(join(src, "core", "_lintProbe.ts"), 'import { SlotStore } from "../sync/index.js";\nexport const probe = typeof SlotStore;\n');
  assert.equal(coreUp.status, 1, "core imports nothing of ours");
  const satellite = planted(join(root, "packages", "agent-otel", "src", "_lintProbe.ts"), 'import { AirPrompterAgent } from "@airprompter/agent-sdk";\nexport const probe = typeof AirPrompterAgent;\n');
  assert.equal(satellite.status, 1, "a satellite imports a layer subpath, never the root");
  const stepsDeep = planted(join(src, "frameworks", "steps", "_lintProbe.ts"), 'import { AirPrompterAgent } from "../../agent.js";\nexport const probe = typeof AirPrompterAgent;\n');
  assert.equal(stepsDeep.status, 1, "Steps reaches the agent through the root barrel only");
  assert.match(stepsDeep.stderr, /reaches into agent by path/);
  const intoSteps = planted(join(src, "frameworks", "_lintProbe.ts"), 'import { createAutomationClient } from "./steps/index.js";\nexport const probe = typeof createAutomationClient;\n');
  assert.equal(intoSteps.status, 1, "nothing below Steps imports it");
  assert.match(intoSteps.stderr, /frameworks \(layer 2\) may not import steps \(layer 3\)/);
  // Decision L (AIR-2231, AIR-2405): a platform package reaches the SDK only as the Steps subpath, never another layer.
  const integration = join(root, "..", "integrations", "zapier", "src", "_lintProbe.ts");
  const platformLayer = planted(integration, 'import { MemoryKvStore } from "@airprompter/agent-sdk/sync";\nexport const probe = typeof MemoryKvStore;\n');
  assert.equal(platformLayer.status, 1, "an integration importing /sync fails the lint");
  assert.match(platformLayer.stderr, /integrations[\\/]zapier[\\/]src[\\/]_lintProbe\.ts:\d+: @airprompter\/agent-sdk\/sync: an integration imports the SDK only as @airprompter\/agent-sdk\/frameworks\/steps/);
  const platformRoot = planted(join(root, "..", "integrations", "n8n", "src", "_lintProbe.ts"), 'import { AirPrompterAgent } from "@airprompter/agent-sdk";\nexport const probe = typeof AirPrompterAgent;\n');
  assert.equal(platformRoot.status, 1, "an integration importing the root fails the lint");
  const platformPath = planted(integration, 'import { usageFrom } from "../../../sdk-typescript/packages/sdk/src/frameworks/steps/index.js";\nexport const probe = typeof usageFrom;\n');
  assert.equal(platformPath.status, 1, "an integration reaching the SDK's sources by path fails the lint");
  assert.match(platformPath.stderr, /leaves integrations[\\/]zapier/);
  const platformOk = planted(integration, 'import { usageFrom } from "@airprompter/agent-sdk/frameworks/steps";\nexport const probe = typeof usageFrom;\n');
  assert.equal(platformOk.status, 0, `the Steps subpath is allowed: ${platformOk.stderr}`);
});

test("adapters (AIR-2231): an adapter imports only the contract, its own folder and its framework; the layers below import no framework; the contract imports three barrels and is the only one to reach runtime/adapter", () => {
  const src = join(root, "packages", "sdk", "src");
  const unlisted = planted(join(src, "frameworks", "_lintProbe.ts"), 'import { chooseModel } from "./contract.js";\nexport const probe = typeof chooseModel;\n');
  assert.equal(unlisted.status, 1, "an adapter with no allowlist entry fails");
  assert.match(unlisted.stderr, /frameworks\/_lintProbe\.ts has no entry in ADAPTERS/);
  // Only new files are planted, so nothing another test imports is ever edited. A folder `frameworks/openai/` is the openai adapter too.
  const probe = join(src, "frameworks", "openai", "_lintProbe.ts");
  mkdirSync(dirname(probe), { recursive: true });
  try {
    for (const [source, message] of [
      ['import { normalizeUsage } from "../../runtime/index.js";\nexport const probe = normalizeUsage;\n', /openai[\\/]_lintProbe\.ts:\d+: an adapter imports only the contract, its own folder and its framework, not \.\.\/\.\.\/runtime\/index\.js/],
      ['import { airprompterMiddleware } from "../ai-sdk.js";\nexport const probe = airprompterMiddleware;\n', /an adapter imports only the contract, its own folder and its framework, not \.\.\/ai-sdk\.js/],
      ['import Anthropic from "@anthropic-ai/sdk";\nexport const probe = Anthropic;\n', /@anthropic-ai\/sdk is not in frameworks\/openai's allowlist/],
      ['import { acquireRun } from "../../runtime/adapter/index.js";\nexport const probe = acquireRun;\n', /an adapter imports only the contract/],
      // Every form the AST names, however it is quoted or laid out.
      ["import { x } from '../../runtime/wrap/proxy.js';\nexport const probe = x;\n", /not \.\.\/\.\.\/runtime\/wrap\/proxy\.js/],
      ['import "../../runtime/index.js";\n', /not \.\.\/\.\.\/runtime\/index\.js/],
      ['import p = require("../../runtime/index.js");\nexport const probe = p;\n', /not \.\.\/\.\.\/runtime\/index\.js/],
      ['export const a = 1; const m = require("ai");\nexport const b = m;\n', /ai is not in frameworks\/openai's allowlist/],
      ['const name = "openai";\nexport const probe = import(name);\n', /a dynamic import of a computed specifier cannot be checked/],
    ] as const) {
      const result = planted(probe, source);
      assert.equal(result.status, 1, source);
      assert.match(result.stderr, message);
    }
    const ok = planted(probe, 'import { chooseModel } from "../contract.js";\nimport type OpenAI from "openai";\nexport type Probe = OpenAI;\nexport const probe = chooseModel;\n');
    assert.equal(ok.status, 0, `a folder adapter may import the contract and its framework: ${ok.stderr}`);
  } finally {
    rmSync(dirname(probe), { recursive: true, force: true });
  }
  const barrel = planted(join(src, "_lintProbe.ts"), 'import { acquireRun } from "./runtime/adapter/index.js";\nexport const probe = acquireRun;\n');
  assert.match(barrel.stderr, /runtime\/adapter is the adapters' internal barrel; only frameworks\/contract\.ts imports it/);
  const runtimeFramework = planted(join(src, "runtime", "_lintProbe.ts"), 'import OpenAI from "openai";\nexport const probe = typeof OpenAI;\n');
  assert.equal(runtimeFramework.status, 1, "the runtime imports no framework package");
  assert.match(runtimeFramework.stderr, /runtime imports the framework package openai/);
  const agentFramework = planted(join(src, "_lintProbe.ts"), 'import { createAgent } from "langchain";\nexport const probe = typeof createAgent;\n');
  assert.match(agentFramework.stderr, /agent imports the framework package langchain/);
  const runTelemetry = planted(join(src, "runtime", "run", "_lintProbe.ts"), 'import { SpoolWriter } from "../../telemetry/index.js";\nexport const probe = typeof SpoolWriter;\n');
  assert.match(runTelemetry.stderr, /runtime \(layer 1\) may not import telemetry/, "runtime/run imports neither telemetry nor sync");
  const contractFolder = join(src, "frameworks", "contract", "_lintProbe.ts");
  mkdirSync(dirname(contractFolder), { recursive: true });
  try {
    assert.match(planted(contractFolder, 'export { SpoolWriter } from "../../telemetry/index.js";\n').stderr, /frameworks\/contract imports only the runtime, core and runtime\/adapter barrels/);
  } finally {
    rmSync(dirname(contractFolder), { recursive: true, force: true });
  }
});

test("rule 4: agent.ts is pinned at its line count, and no adapter file passes 300 lines", () => {
  assert.equal(readFileSync(join(root, "packages", "sdk", "src", "agent.ts"), "utf8").trimEnd().split("\n").length, AGENT_TS_LINES, "agent.ts grew or shrank: move AGENT_TS_LINES on purpose");
  for (const entry of readdirSync(join(root, "packages", "sdk", "src", "frameworks"))) {
    if (!entry.endsWith(".ts")) continue;
    assert.ok(readFileSync(join(root, "packages", "sdk", "src", "frameworks", entry), "utf8").trimEnd().split("\n").length <= 300, `frameworks/${entry} is over 300 lines`);
  }
  // A folder adapter is counted whole: plant one past the cap and the size check fails.
  ensureBuilt(); // first: a build with the probe in place would carry it into dist
  const folder = join(root, "packages", "sdk", "src", "frameworks", "_sizeProbe");
  mkdirSync(folder, { recursive: true });
  try {
    writeFileSync(join(folder, "a.ts"), "export const a = 1;\n".repeat(160));
    writeFileSync(join(folder, "b.ts"), "export const b = 1;\n".repeat(160));
    const size = spawnSync(process.execPath, [join(root, "scripts", "size-budget.mjs")], { encoding: "utf8" });
    assert.equal(size.status, 1);
    assert.match(size.stderr, /src\/frameworks\/_sizeProbe: 320 lines, over 300/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("two copies agree: an error, a release and a sink from one copy are recognised by the other (no instanceof coupling)", async () => {
  // A second copy: the built dist beside the source is a different module instance of every class, which is exactly
  // what two versions of the SDK in one lockfile look like at run time.
  ensureBuilt();
  const dist = (layer: string) => import(new URL(`../packages/sdk/dist/esm/${layer}/index.js`, import.meta.url).href) as Promise<unknown>;
  const coreB = (await dist("core")) as typeof import("../packages/sdk/src/core/index.js");
  const syncB = (await dist("sync")) as typeof import("../packages/sdk/src/sync/index.js");
  const telemetryB = (await dist("telemetry")) as typeof import("../packages/sdk/src/telemetry/index.js");
  assert.notEqual(coreB.AssignmentError, AssignmentError, "two module instances");
  assert.ok(coreB.isAssignmentError(new AssignmentError("ramp_invalid")), "copy B recognises copy A's error by name and shape");
  assert.ok(isAssignmentError(new coreB.AssignmentError("ramp_invalid")), "copy A recognises copy B's error");
  assert.ok(syncB.isStoreError(new StoreError("no_release", "x")), "copy B recognises copy A's store error");
  assert.ok(isStoreError(new syncB.StoreError("no_release", "x")), "copy A recognises copy B's store error");
  // A release verified by copy A is served by a runtime holding copy B's types: structural, never a class.
  const plane = new FakeControlPlane(scope);
  plane.promote([plane.slot({ tag: "support.reply", text: "Hello {{name}}", versionId: "v1", variables: [{ name: "name", required: true, trust: "operator" }] })]);
  const bundle = bundleOf(plane);
  const loadedA = BundleRelease.load({ bundle, root: trustedRootFromPinnedKey({ purpose: "platform", environment: "prod", pinnedRoot: publicJwkOf(plane.rootKey) }), scope, now: new Date().toISOString() });
  assert.ok(loadedA.ok, JSON.stringify(loadedA));
  const loadedB = coreB.BundleRelease.load({ bundle, root: coreB.trustedRootFromPinnedKey({ purpose: "platform", environment: "prod", pinnedRoot: publicJwkOf(plane.rootKey) }), scope, now: new Date().toISOString() });
  assert.ok(loadedB.ok, JSON.stringify(loadedB));
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

test("/runtime alone renders and assigns over a bundle the customer loads — verified like OTA, no store, no daemon, no network; a relabelled or tampered bundle is refused", () => {
  const plane = new FakeControlPlane(scope);
  const control = plane.slot({ tag: "support.reply", text: "Reply A to {{name}}", versionId: "v1", variables: [{ name: "name", required: true, trust: "operator" }] });
  const candidate = plane.slot({ tag: "support.reply", text: "Reply B to {{name}}", versionId: "v2", variables: [{ name: "name", required: true, trust: "operator" }] });
  plane.promote([control], {
    experiments: [{ tag: "support.reply", experimentId: "exp_1", salt: "c2FsdHNhbHRzYWx0c2FsdHNhbHQ", subjectKey: "request", arms: [{ arm: "control", weightBps: 5000, releaseDigest: releaseDigest([control]), overrides: [] }, { arm: "candidate", weightBps: 5000, releaseDigest: ("sha256:" + "1".repeat(64)) as `sha256:${string}`, overrides: [candidate] }] }],
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
    assert.ok(outcome.ok, JSON.stringify(outcome));
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

test("the runtime walks the protocol's ramp vectors over a bundle release — every case, every host clock, the retreat — with no facade", () => {
  const vectors = JSON.parse(readFileSync(new URL("../../protocol/vectors/ramp.json", import.meta.url), "utf8")) as {
    cases: Array<{ name: string; now?: string; salt: string; arms: Array<{ arm: string; weightBps: number }>; ramp: Array<{ notBefore: string; weightBps: number[] }>; directives: Array<Record<string, unknown>>; hosts?: { hostA: { now: string }; hostB: { now: string } }; expected: { assignments: Array<{ subject: string; bucket: number; arm?: string; hostA?: string; hostB?: string }> } }>;
  };
  for (const c of vectors.cases) {
    const plane = new FakeControlPlane(scope);
    const control = plane.slot({ tag: "support.reply", text: "A", versionId: "v1", variables: [] });
    const candidate = plane.slot({ tag: "support.reply", text: "B", versionId: "v2", variables: [] });
    const controlDigest = releaseDigest([control]);
    plane.promote([control], {
      experiments: [{ tag: "support.reply", experimentId: "exp_ramp", salt: c.salt, subjectKey: "request", arms: c.arms.map((arm) => ({ arm: arm.arm, weightBps: arm.weightBps, releaseDigest: controlDigest, overrides: arm.arm === "candidate" ? [candidate] : [] })), ramp: c.ramp }],
      directives: c.directives as never,
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

test("the exports map and the type map are exactly these, each layer's subpath is its curated entry, and nothing past a subpath resolves", () => {
  const sdk = manifestOf("sdk");
  assert.deepEqual(Object.keys(sdk.exports), SUBPATHS, "the SDK's exports map");
  for (const [subpath, entry] of Object.entries(sdk.exports)) {
    assert.deepEqual(Object.keys(entry), ["import", "require"], `${subpath}: one entry per module system`);
    for (const condition of [entry.import, entry.require]) assert.deepEqual(Object.keys(condition), ["types", "default"], `${subpath}: types first, then the module`);
    if (subpath !== ".") assert.deepEqual(sdk.typesVersions["*"]![subpath.slice(2)], [entry.import.types.slice(2)], `${subpath}: a consumer that reads no exports map still finds the types`);
  }
  assert.deepEqual(Object.keys(sdk.typesVersions["*"]!).sort(), SUBPATHS.slice(1).map((subpath) => subpath.slice(2)).sort());
  // A layer's subpath is its curated entry, never the barrel the other layers import (test/publicSurface.test.ts pins the names).
  for (const layer of ["core", "sync", "runtime", "telemetry"]) assert.equal(sdk.exports[`./${layer}`]!.import.default, `./dist/esm/${layer}/public.js`, `./${layer} is the curated entry`);
  assert.deepEqual(Object.keys(manifestOf("agent-otel").exports), ["./exporter"], "the exporter is the first subpath; a processor or baggage subpath adds to it");
  ensureBuilt();
  const resolve = (spec: string) => spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(spec)});`], { cwd: root, encoding: "utf8" });
  assert.equal(resolve("@airprompter/agent-sdk/core").status, 0, "a declared subpath resolves");
  const past = resolve("@airprompter/agent-sdk/dist/esm/core/protocol/trust.js");
  assert.notEqual(past.status, 0, "a path past the exports map does not resolve");
  assert.match(past.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
  assert.match(resolve("@airprompter/agent-sdk/core/index.js").stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/, "the layer's barrel is no subpath");
});

test("the tarball carries every declared subpath in both module systems, and speaks the protocol this repository is at", () => {
  ensureBuilt();
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const packed = JSON.parse(execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: join(root, "packages", "sdk"), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: process.platform === "win32" })) as Record<string, { files: Array<{ path: string }> }>;
  // npm 11 prints an array of one; npm 12 prints an object keyed by package name.
  const files = new Set(Object.values(packed)[0]!.files.map((file) => file.path));
  for (const [subpath, entry] of Object.entries(manifestOf("sdk").exports)) for (const target of [entry.import.types, entry.import.default, entry.require.types, entry.require.default]) assert.ok(files.has(target.slice(2)), `${subpath}: the tarball carries ${target}`);
  assert.ok(files.has("LICENSE") && files.has("README.md"), "the tarball carries its licence and README");
  const stray = [...files].filter((path) => !/^(dist\/|LICENSE$|README\.md$|package\.json$)/.test(path));
  assert.deepEqual(stray, [], "only the build, the licence and the README");
  const version = readFileSync(join(root, "packages", "sdk", "dist", "esm", "core", "protocol", "version.js"), "utf8");
  assert.ok(version.includes(`PROTOCOL_VERSION = "${readFileSync(join(root, "..", "protocol", "VERSION"), "utf8").trim()}"`), "the build carries protocol/VERSION");
});

test("every package carries one version and SDK_VERSION is it; satellites peer on the SDK (exactly on a candidate, ^ after); every subpath publishes under its budget", () => {
  const manifests = Object.fromEntries(PACKAGES.map((name) => [name, manifestOf(name)]));
  const versions = new Set(PACKAGES.map((name) => manifests[name]!.version));
  assert.equal(versions.size, 1, "one version");
  const version = [...versions][0]!;
  assert.equal(manifests.sdk!.name, "@airprompter/agent-sdk");
  // The version the heartbeat and store.json report is the version that shipped: SDK_VERSION never drifts from package.json (it did, 0.1.0 → 0.2.0).
  assert.equal(SDK_VERSION, version, "SDK_VERSION is written from packages/sdk/package.json");
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, version, "the workspace root moves with the packages");
  const cli = JSON.parse(readFileSync(join(root, "..", "cli", "package.json"), "utf8")) as Manifest;
  // A candidate moves the CLI with it; from 1.0.0 the CLI may ship a patch of its own, so only a candidate pins it.
  if (version.includes("-")) assert.equal(cli.version, version, "the CLI is on the release candidate too");
  else assert.ok(!cli.version.includes("-"), "a final SDK leaves no CLI on a candidate (version-lockstep --set moved it)");
  assert.equal(cli.private, true, "the CLI ships as signed executables, never on npm");
  assert.deepEqual(manifests.sdk!.dependencies ?? {}, {}, "the SDK has no runtime dependency");
  const peers = manifests.sdk!.peerDependencies ?? {};
  assert.deepEqual(Object.keys(peers).sort(), ["@anthropic-ai/sdk", "@langchain/core", "ai", "langchain", "openai", "zod"]);
  for (const peer of Object.keys(peers)) assert.equal(manifests.sdk!.peerDependenciesMeta?.[peer]?.optional, true, `${peer} is an optional peer`);
  for (const name of SATELLITES) {
    const manifest = manifests[name]!;
    assert.equal(manifest.name, `@airprompter/${name}`);
    assert.deepEqual(manifest.dependencies ?? {}, {}, `${name} has no dependency: an app never installs a second SDK copy`);
    assert.equal(manifest.peerDependencies?.["@airprompter/agent-sdk"], version.includes("-") ? version : `^${version}`, `${name} peers on the SDK: exactly on a candidate, from the version on after (a 1.1.0 SDK beside a 1.0.0 datastore)`);
    assert.equal(manifest.devDependencies?.["@airprompter/agent-sdk"], version, `${name} builds against the workspace SDK`);
    assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}).sort(), name === "datastore-s3" ? ["@airprompter/agent-sdk", "@aws-sdk/client-s3"] : ["@airprompter/agent-sdk"], `${name}: the client library is the application's`);
  }
  ensureBuilt();
  const sizes = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "size-budget.mjs"), "--json"], { encoding: "utf8" })) as Record<string, { bytes: number; budget: number }>;
  assert.deepEqual(Object.keys(sizes).sort(), ["agent-otel", "datastore-postgres", "datastore-redis", "datastore-s3", "sdk", "sdk/core", "sdk/frameworks/ai-sdk", "sdk/frameworks/anthropic", "sdk/frameworks/contract", "sdk/frameworks/langchain", "sdk/frameworks/openai", "sdk/frameworks/steps", "sdk/runtime", "sdk/sync", "sdk/telemetry", "sdk/testing"]);
  for (const [name, { bytes, budget }] of Object.entries(sizes)) {
    assert.ok(bytes > 0, `${name} built`);
    assert.ok(bytes <= budget, `${name}: ${bytes} bytes over its ${budget}-byte budget`);
  }
  // BSD-3-Clause travels with every redistribution: each package carries the licence text npm always packs.
  const licence = readFileSync(join(root, "..", "LICENSE"), "utf8");
  for (const name of PACKAGES) assert.equal(readFileSync(join(root, "packages", name, "LICENSE"), "utf8"), licence, `packages/${name}/LICENSE is the repository's LICENSE`);
  // Every source the CLI bundles from must reach the sidecar image's build stage: a package added here and not there
  // builds everywhere but the Dockerfile (S13 found it in CI).
  const dockerfile = readFileSync(join(root, "..", "deploy", "docker", "Dockerfile"), "utf8");
  for (const name of ["sdk", "agent-otel"]) assert.ok(dockerfile.includes(`COPY sdk-typescript/packages/${name}/src sdk-typescript/packages/${name}/src`), `deploy/docker/Dockerfile copies packages/${name}/src`);
});

test("every install line in the READMEs pins the current version, the npm pages included, so a version bump fails here until the docs follow", () => {
  const version = manifestOf("sdk").version;
  for (const page of [join(root, "README.md"), ...PACKAGES.map((name) => join(root, "packages", name, "README.md"))]) {
    const lines = readFileSync(page, "utf8").split("\n").filter((line) => /\bnpm install\b/.test(line) && line.includes("@airprompter/"));
    assert.ok(lines.some((line) => line.includes(`@airprompter/agent-sdk@${version}`)), `${page} installs @airprompter/agent-sdk@${version}`);
    for (const line of lines) {
      assert.match(line, /--save-exact/, `an exact pin: npm's default range matches later candidates: ${line}`);
      for (const [spec] of line.matchAll(/@airprompter\/[a-z0-9-]+(@[^\s`]*)?/g)) assert.ok(spec.endsWith(`@${version}`), `${page}: ${spec} is not pinned to ${version}`);
    }
  }
});

test("version-lockstep --set: a candidate pins exactly and keeps its advice; a final version peers with ^, drops the advice, and frees the CLI", () => {
  // A copy of what the tool reads and writes, so the test changes nothing here, whatever version this tree is at.
  const scratch = mkdtempSync(join(tmpdir(), "ap-lockstep-"));
  const copy = (path: string) => {
    mkdirSync(dirname(join(scratch, path)), { recursive: true });
    writeFileSync(join(scratch, path), readFileSync(join(root, "..", path)));
  };
  try {
    for (const path of ["README.md", "protocol/VERSION", "cli/package.json", "cli/package-lock.json", "sdk-typescript/package.json", "sdk-typescript/README.md", "sdk-typescript/scripts/version-lockstep.mjs", "sdk-typescript/scripts/build.mjs", "sdk-typescript/packages/sdk/src/core/protocol/version.ts"]) copy(path);
    for (const name of PACKAGES) for (const file of ["package.json", "README.md"]) copy(`sdk-typescript/packages/${name}/${file}`);
    for (const example of readdirSync(join(root, "..", "examples"))) if (existsSync(join(root, "..", "examples", example, "package.json"))) copy(`examples/${example}/package.json`);
    const lockstep = (...args: string[]) => spawnSync(process.execPath, [join(scratch, "sdk-typescript", "scripts", "version-lockstep.mjs"), ...args], { encoding: "utf8" });
    const at = (path: string) => readFileSync(join(scratch, path), "utf8");
    const pages = ["README.md", "sdk-typescript/README.md", ...PACKAGES.map((name) => `sdk-typescript/packages/${name}/README.md`)];
    const peerOf = (name: string) => (JSON.parse(at(`sdk-typescript/packages/${name}/package.json`)) as Manifest).peerDependencies?.["@airprompter/agent-sdk"];
    const cliVersion = () => (JSON.parse(at("cli/package.json")) as Manifest).version;
    // From whatever this tree is, to a candidate: the advice stays, the peers are exact, the CLI moves with it.
    writeFileSync(join(scratch, "cli", "package.json"), JSON.stringify({ ...JSON.parse(at("cli/package.json")), version: manifestOf("sdk").version }));
    const blocks = (page: string) => at(page).split("<!-- release-candidate -->").length - 1;
    const before = pages.map(blocks);
    assert.equal(lockstep("--set", "1.0.0-rc.99").status, 0);
    // On a candidate tree (every rc) the advice is there and stays; a final tree has none to keep.
    assert.deepEqual(pages.map(blocks), before, "a candidate keeps the advice it has");
    writeFileSync(join(scratch, "README.md"), at("README.md") + "\nNeighbours: 1.0.0-rc.990, 11.0.0-rc.99, 1.0.0-rc.99.1\n");
    if (manifestOf("sdk").version.includes("-")) assert.ok(before.every((count) => count > 0), "every README on a candidate carries the candidate's advice");
    for (const page of pages) assert.ok(at(page).includes("1.0.0-rc.99"), `${page} names the candidate`);
    for (const name of SATELLITES) assert.equal(peerOf(name), "1.0.0-rc.99", `${name}: exact on a candidate`);
    assert.equal(cliVersion(), "1.0.0-rc.99", "the CLI moves with a candidate");
    // To 1.0.0: what AIR-2245 runs.
    const set = lockstep("--set", "1.0.0");
    assert.equal(set.status, 0, set.stderr);
    for (const name of SATELLITES) {
      assert.equal(peerOf(name), "^1.0.0", `${name}: a final version peers from itself on`);
      assert.equal((JSON.parse(at(`sdk-typescript/packages/${name}/package.json`)) as Manifest).devDependencies?.["@airprompter/agent-sdk"], "1.0.0", `${name}: the workspace link stays exact`);
    }
    for (const page of pages) {
      const text = at(page).replace("Neighbours: 1.0.0-rc.990, 11.0.0-rc.99, 1.0.0-rc.99.1", "");
      assert.ok(!text.includes("release-candidate") && text.includes("1.0.0") && !text.includes("rc.99"), `${page}: 1.0.0, without the candidate's advice`);
    }
    assert.equal(cliVersion(), "1.0.0");
    const lock = JSON.parse(at("cli/package-lock.json")) as { version: string; packages: Record<string, { version?: string }> };
    assert.deepEqual([lock.version, lock.packages[""]?.version], ["1.0.0", "1.0.0"], "the CLI's lockfile moves with it, both fields");
    assert.equal(lockstep().status, 0, "the check passes on what --set wrote");
    assert.ok(at("README.md").includes("Neighbours: 1.0.0-rc.990, 11.0.0-rc.99, 1.0.0-rc.99.1"), "--set moves the version as a whole token only");
    // A page --set missed still says the candidate, and "1.0.0" inside "1.0.0-rc.99" does not count as naming 1.0.0.
    const missed = "sdk-typescript/packages/datastore-s3/README.md";
    const good = at(missed);
    writeFileSync(join(scratch, missed), good.split("@1.0.0").join("@1.0.0-rc.99"));
    assert.match(lockstep().stderr, /datastore-s3[\\/]README\.md does not name 1\.0\.0/);
    writeFileSync(join(scratch, missed), good);
    // After 1.0.0 the CLI is released on its own: an SDK patch leaves it where it is, even at the same version.
    assert.equal(lockstep("--set", "1.0.2").status, 0);
    assert.equal(cliVersion(), "1.0.0", "--set leaves a CLI released on its own");
    // A CLI patch of its own, then the next candidate: the candidate ties them again.
    writeFileSync(join(scratch, "cli", "package.json"), JSON.stringify({ ...JSON.parse(at("cli/package.json")), version: "1.0.3" }));
    assert.equal(lockstep("--set", "1.1.0-rc.0").status, 0);
    assert.equal(cliVersion(), "1.1.0-rc.0", "a candidate moves the CLI with it");
    assert.equal(lockstep("--set", "1.0.2").status, 0);
    assert.equal(peerOf("datastore-s3"), "^1.0.2");
    writeFileSync(join(scratch, "sdk-typescript", "README.md"), at("sdk-typescript/README.md") + "<!-- release-candidate -->x<!-- /release-candidate -->\n");
    assert.match(lockstep().stderr, /a release-candidate block on 1\.0\.2/, "a final version refuses a candidate's advice");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("no removed package name is left in the repository, outside the changelogs", () => {
  // Assembled here so this file does not match itself.
  const removed = new RegExp(["@airprompter/agent-(core|sync|runtime|telemetry)", "airprompter_agent_(core|sync|runtime|telemetry)", "airprompter-agent-(core|sync|runtime|telemetry)", "otel" + "-bridge", "otel" + "_bridge"].join("|"));
  const repository = join(root, "..");
  const skip = new Set(["node_modules", "dist", ".git", ".venv", "__pycache__", "cdk.out", ".pytest_cache"]);
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry !== "CHANGELOG.md" && /\.(ts|mts|mjs|js|json|py|toml|ya?ml|md|txt)$|^Dockerfile$/.test(entry) && removed.test(readFileSync(path, "utf8"))) offenders.push(path.slice(repository.length + 1));
    }
  };
  walk(repository);
  assert.deepEqual(offenders, []);
});
