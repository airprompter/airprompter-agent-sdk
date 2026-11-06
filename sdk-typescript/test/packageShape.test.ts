/**
 * The one package and what sits beside it. The rules, each with its vector:
 *
 *   1. The direction inside the package is core → sync, runtime, telemetry →
 *      agent, frameworks, and a layer is reached only through its barrel:
 *      `scripts/lint-imports.mjs` pins the edge set, and a planted upward or
 *      deep import fails it.
 *   2. Two copies of the SDK in one process agree: an error, a release and a
 *      sink from copy A are recognised by copy B (S1's discriminant rule).
 *   3. `/runtime` alone renders and assigns over a bundle the customer loads:
 *      no store, no daemon, no network.
 *   4. The exports map and the root's names are exactly what is pinned here,
 *      and the tarball carries each declared subpath and nothing past it.
 *   5. Every package publishes under its size budget, the packages carry one
 *      version with the SDK as an exact-pinned peer, and `SDK_VERSION` is that
 *      version. No removed package name is left anywhere in the repository.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
const SUBPATHS = [".", "./core", "./sync", "./runtime", "./telemetry", "./testing", "./frameworks/langchain"];
type Manifest = { name: string; version: string; private?: boolean; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }>; devDependencies?: Record<string, string>; exports: Record<string, { types: string; import: string; require: string }>; typesVersions: Record<string, Record<string, string[]>>; airprompter: { sizeBudgetBytes: number | Record<string, number> } };
const manifestOf = (name: string): Manifest => JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8")) as Manifest;

function ensureBuilt(): void {
  if (!existsSync(join(root, "packages", "sdk", "dist", "esm", "index.js"))) execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], { stdio: "ignore" });
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

test("the direction is core → sync, runtime, telemetry → agent, frameworks; the edge set is pinned; a planted upward or deep import fails the lint", () => {
  const clean = lint(["--json"]);
  assert.equal(clean.status, 0, clean.stderr);
  const { edges } = JSON.parse(clean.stdout.slice(0, clean.stdout.lastIndexOf("}") + 1)) as { edges: string[] };
  assert.deepEqual(edges, ["agent-otel→core", "agent→core", "agent→runtime", "agent→sync", "agent→telemetry", "cli→agent", "cli→agent-otel", "cli→core", "cli→runtime", "cli→sync", "cli→telemetry", "datastore-postgres→sync", "datastore-redis→sync", "datastore-s3→sync", "frameworks→core", "frameworks→runtime", "runtime→core", "sync→core", "telemetry→core"], "the middle layers never import each other; core imports nothing of ours; the exporter uses core alone and the datastores sync alone");
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

test("the exports map, the type map and the root's names are exactly these; nothing past a subpath resolves", async () => {
  const sdk = manifestOf("sdk");
  assert.deepEqual(Object.keys(sdk.exports), SUBPATHS, "the SDK's exports map");
  for (const [subpath, entry] of Object.entries(sdk.exports)) {
    assert.deepEqual(Object.keys(entry), ["types", "import", "require"], `${subpath}: types first, then both module systems`);
    if (subpath !== ".") assert.deepEqual(sdk.typesVersions["*"]![subpath.slice(2)], [entry.types.slice(2)], `${subpath}: a consumer that reads no exports map still finds the types`);
  }
  assert.deepEqual(Object.keys(sdk.typesVersions["*"]!).sort(), SUBPATHS.slice(1).map((subpath) => subpath.slice(2)).sort());
  assert.deepEqual(Object.keys(manifestOf("agent-otel").exports), ["./exporter"], "the exporter is the first subpath; a processor or baggage subpath adds to it");
  const surface = (await import("../packages/sdk/src/index.js")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(surface).sort(), ["AgentStartError", "AirPrompterAgent", "ManagedAgent", "ManagedRunError", "PROTOCOL_VERSION", "RenderRefusedError", "SDK_NAME", "SDK_VERSION", "VENDORED_BUNDLE_EXPIRY_WARNING_DAYS", "healthzOf", "healthzResponse", "isAgentStartError", "isManagedRunError"], "the root is the agent, its results and the hosted client; everything else is a subpath");
  const index = readFileSync(join(root, "packages", "sdk", "src", "index.ts"), "utf8");
  assert.doesNotMatch(index, /^export \*/m, "no star export: a layer's new name is not public by accident");
  assert.doesNotMatch(index, /^export \{[^}]*\btype\s/m, "no inline `export { type X }`: the type pin below reads `export type { … }` only");
  const typeNames = [...index.matchAll(/^export type \{([^}]*)\}/gm)].flatMap((match) => match[1]!.split(",").map((name) => name.trim())).filter(Boolean).sort();
  assert.deepEqual(typeNames, ["AgentRampStatus", "AgentStatus", "BundleOutcome", "DatastoreStatus", "Healthz", "HeartbeatSdkName", "HydrateOutcome", "ManagedRunOptions", "ManagedRunResult", "ManagedRunStream", "ManagedStartOptions", "ReleaseChange", "ReleaseSource", "Rendered", "SpoolReport", "StartOptions", "SyncMode", "TelemetryPlacement"], "the root's type names are a promise too");
  ensureBuilt();
  const resolve = (spec: string) => spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(spec)});`], { cwd: root, encoding: "utf8" });
  assert.equal(resolve("@airprompter/agent-sdk/core").status, 0, "a declared subpath resolves");
  const past = resolve("@airprompter/agent-sdk/dist/esm/core/protocol/trust.js");
  assert.notEqual(past.status, 0, "a path past the exports map does not resolve");
  assert.match(past.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
});

test("the tarball carries every declared subpath in both module systems, and speaks the protocol this repository is at", () => {
  ensureBuilt();
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const packed = JSON.parse(execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: join(root, "packages", "sdk"), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: process.platform === "win32" })) as Record<string, { files: Array<{ path: string }> }>;
  // npm 11 prints an array of one; npm 12 prints an object keyed by package name.
  const files = new Set(Object.values(packed)[0]!.files.map((file) => file.path));
  for (const [subpath, entry] of Object.entries(manifestOf("sdk").exports)) for (const target of Object.values(entry)) assert.ok(files.has(target.slice(2)), `${subpath}: the tarball carries ${target}`);
  assert.ok(files.has("LICENSE") && files.has("README.md"), "the tarball carries its licence and README");
  const stray = [...files].filter((path) => !/^(dist\/|LICENSE$|README\.md$|package\.json$)/.test(path));
  assert.deepEqual(stray, [], "only the build, the licence and the README");
  const version = readFileSync(join(root, "packages", "sdk", "dist", "esm", "core", "protocol", "version.js"), "utf8");
  assert.ok(version.includes(`PROTOCOL_VERSION = "${readFileSync(join(root, "..", "protocol", "VERSION"), "utf8").trim()}"`), "the build carries protocol/VERSION");
});

test("every package carries one version and SDK_VERSION is it; satellites peer on the SDK, exact-pinned; every subpath publishes under its budget", () => {
  const manifests = Object.fromEntries(PACKAGES.map((name) => [name, manifestOf(name)]));
  const versions = new Set(PACKAGES.map((name) => manifests[name]!.version));
  assert.equal(versions.size, 1, "one version");
  const version = [...versions][0]!;
  assert.equal(manifests.sdk!.name, "@airprompter/agent-sdk");
  // The version the heartbeat and store.json report is the version that shipped: SDK_VERSION never drifts from package.json (it did, 0.1.0 → 0.2.0).
  assert.equal(SDK_VERSION, version, "SDK_VERSION is written from packages/sdk/package.json");
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, version, "the workspace root moves with the packages");
  const cli = JSON.parse(readFileSync(join(root, "..", "cli", "package.json"), "utf8")) as Manifest;
  assert.equal(cli.version, version, "the CLI is on the release candidate too");
  assert.equal(cli.private, true, "the CLI ships as signed executables, never on npm");
  assert.deepEqual(manifests.sdk!.dependencies ?? {}, {}, "the SDK has no runtime dependency");
  const peers = manifests.sdk!.peerDependencies ?? {};
  assert.deepEqual(Object.keys(peers).sort(), ["@anthropic-ai/sdk", "@langchain/core", "ai", "langchain", "openai", "zod"]);
  for (const peer of Object.keys(peers)) assert.equal(manifests.sdk!.peerDependenciesMeta?.[peer]?.optional, true, `${peer} is an optional peer`);
  for (const name of SATELLITES) {
    const manifest = manifests[name]!;
    assert.equal(manifest.name, `@airprompter/${name}`);
    assert.deepEqual(manifest.dependencies ?? {}, {}, `${name} has no dependency: an app never installs a second SDK copy`);
    assert.equal(manifest.peerDependencies?.["@airprompter/agent-sdk"], version, `${name} peers on the SDK at the lockstep version`);
    assert.equal(manifest.devDependencies?.["@airprompter/agent-sdk"], version, `${name} builds against the workspace SDK`);
    assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}).sort(), name === "datastore-s3" ? ["@airprompter/agent-sdk", "@aws-sdk/client-s3"] : ["@airprompter/agent-sdk"], `${name}: the client library is the application's`);
  }
  ensureBuilt();
  const sizes = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "size-budget.mjs"), "--json"], { encoding: "utf8" })) as Record<string, { bytes: number; budget: number }>;
  assert.deepEqual(Object.keys(sizes).sort(), ["agent-otel", "datastore-postgres", "datastore-redis", "datastore-s3", "sdk", "sdk/core", "sdk/frameworks/langchain", "sdk/runtime", "sdk/sync", "sdk/telemetry", "sdk/testing"]);
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

test("every install line in the README pins the current version, so a version bump fails here until the docs follow", () => {
  const version = manifestOf("sdk").version;
  const lines = readFileSync(join(root, "README.md"), "utf8").split("\n").filter((line) => /\bnpm install\b/.test(line) && line.includes("@airprompter/"));
  assert.ok(lines.some((line) => line.includes(`@airprompter/agent-sdk@${version}`)), `the README installs @airprompter/agent-sdk@${version}`);
  for (const line of lines) {
    assert.match(line, /--save-exact/, `an exact pin: npm's default range matches later candidates: ${line}`);
    for (const [spec] of line.matchAll(/@airprompter\/[a-z0-9-]+(@[^\s`]*)?/g)) assert.ok(spec.endsWith(`@${version}`), `${spec} is not pinned to ${version}`);
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
