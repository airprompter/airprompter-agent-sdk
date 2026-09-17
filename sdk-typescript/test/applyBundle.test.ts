/**
 * T39: the fleet pattern. One puller (`pullBundle`, no store, the only Agent key) writes each release into a
 * customer's own store; every runtime holds no key, boots from the newest row, and hands the next row to
 * `applyBundle()` when the generation rises. A dial is a new generation and lands on every runtime the same way; an
 * older row (a restored backup, a stale replica) is refused; a restart serves the applied generation from the
 * host's store with no network; `unlock_required` stages instead of activating.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent } from "../packages/sdk/src/agent.js";
import { generateX25519KeyPair } from "../packages/core/src/bundle/hpke.js";
import { createEncryptedBundle } from "../packages/core/src/bundle/apbundle.js";
import { AgentStartError } from "../packages/sdk/src/agent.js";
import { SyncClient } from "../packages/core/src/control/client.js";
import { publicJwkOf, trustedRootFromPinnedKey } from "../packages/core/src/protocol/trust.js";
import { pullBundle, nextPullDelayMs } from "../packages/sync/src/sync/pullBundle.js";
import { FakeControlPlane, newKey } from "./helpers/controlPlane.js";

const scope: { organizationId: string; agentId: string; target: "dev" | "staging" | "prod" } = { organizationId: "org_1", agentId: "agt_1", target: "prod" };
const tempDir = () => mkdtempSync(join(tmpdir(), "ap-apply-bundle-"));

/** The customer's store: one row per generation, newest wins — a table, a bucket, a config entry. */
class ReleaseTable {
  rows = new Map<number, { bundle: string; releaseDigest: string }>();
  newest() {
    const generation = Math.max(0, ...this.rows.keys());
    return generation ? { generation, ...this.rows.get(generation)! } : null;
  }
}

function puller(plane: FakeControlPlane, table: ReleaseTable, distributionPublicKey: Uint8Array, pullScope: typeof scope = scope) {
  const client = new SyncClient({ baseUrl: "https://api.test", agentId: pullScope.agentId, target: pullScope.target, apiKey: plane.apiKey, fetch: plane.fetch() });
  const trustedRoot = trustedRootFromPinnedKey({ purpose: "platform", environment: "prod", pinnedRoot: publicJwkOf(plane.rootKey) });
  // A pinned key alone does not name the signing keys: the puller reads the environment's root document beside the manifest.
  const fetchRoot = async () => JSON.parse(await (await plane.fetch()("https://edge.test/roots/prod/root.json", {})).text());
  return async () => {
    const result = await pullBundle({ client, scope: pullScope, trustedRoot, fetchRoot, now: () => new Date().toISOString(), distributionPublicKey });
    assert.equal(result.status, "ok", `pull: ${JSON.stringify(result)}`);
    if (result.status !== "ok") throw new Error("unreachable");
    if (!table.rows.has(result.generation)) table.rows.set(result.generation, { bundle: JSON.stringify(result.bundle), releaseDigest: result.releaseDigest });
    return result.generation;
  };
}

test("puller → your store → applyBundle: a dial lands on every runtime, an older row is refused, a restart serves without network", async () => {
  const plane = new FakeControlPlane(scope);
  const control = plane.slot({ tag: "support.reply", text: "Reply politely to {{name}}.", variables: [{ name: "name", required: false, trust: "operator" }], versionId: "ver_1" });
  plane.promote([control]);
  const fleetKey = generateX25519KeyPair();
  const distributionKey = { privateKey: fleetKey.privateKey, publicRaw: fleetKey.publicRaw };
  const table = new ReleaseTable();
  const pull = puller(plane, table, fleetKey.publicRaw);
  assert.equal(await pull(), 1);
  assert.equal(table.newest()!.bundle.includes("Reply politely"), false, "the row is ciphertext");

  // Two runtimes, no Agent key, no network: boot from the newest row.
  const noNetwork = async () => { throw new Error("runtimes never reach the control plane"); };
  const boot = (stateDir: string) =>
    AirPrompterAgent.start({ ...scope, stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, fetch: noNetwork, distributionKey, vendoredBundle: { bundle: JSON.parse(table.newest()!.bundle) } });
  const dirA = tempDir();
  const dirB = tempDir();
  const a = await boot(dirA);
  const b = await boot(dirB);
  assert.equal(a.generation, 1);
  assert.equal(b.prompt("support.reply").render({ name: "Ann" }).text, "Reply politely to Ann.");

  // A dial-up on the board: generation 2 carries an experiment. The puller writes the row; each runtime applies it.
  const candidate = plane.slot({ tag: "support.reply", text: "Reply warmly to {{name}}.", variables: [{ name: "name", required: false, trust: "operator" }], versionId: "ver_2" });
  plane.promote([control], { experiment: { experimentId: "exp_1", salt: "AAECAwQFBgcICQoLDA0ODw", subjectKey: "request", arms: [{ arm: "control", weightBps: 5000, releaseDigest: `sha256:${"0".repeat(64)}`, overrides: [] }, { arm: "candidate", weightBps: 5000, releaseDigest: `sha256:${"1".repeat(64)}`, overrides: [candidate] }] } });
  assert.equal(await pull(), 2);
  const changes: number[] = [];
  a.onChange((change) => { if (change.generation !== undefined) changes.push(change.generation); });
  const appliedA = await a.applyBundle(table.newest()!.bundle);
  const appliedB = await b.applyBundle(JSON.parse(table.newest()!.bundle));
  assert.deepEqual(appliedA, { outcome: "activated", generation: 2 });
  assert.deepEqual(appliedB, { outcome: "activated", generation: 2 });
  assert.deepEqual(changes, [2], "the swap is announced");
  // Both runtimes now assign from the same salt: the same subject lands on the same arm on both hosts.
  const armA = a.prompt("support.reply", { subject: "customer-42" }).render({ name: "Ann" });
  const armB = b.prompt("support.reply", { subject: "customer-42" }).render({ name: "Ann" });
  assert.equal(armA.text, armB.text, "one subject, one arm, on every host");
  assert.deepEqual(await a.applyBundle(table.newest()!.bundle), { outcome: "unchanged", generation: 2 }, "the same row again does nothing");

  // A restored backup: the generation-1 row handed to a host holding 2 is refused, and the host keeps serving 2.
  const stale = await a.applyBundle(table.rows.get(1)!.bundle);
  assert.equal(stale.outcome, "refused");
  assert.equal((stale as { reason: string }).reason, "generation_rollback");
  assert.equal(a.generation, 2);

  // A bundle for another target cannot be relabelled for this one.
  const other = new FakeControlPlane({ ...scope, target: "staging" }, "apa_live_testkey", {}, { hostedEnvironment: "prod" });
  other.promote([other.slot({ tag: "support.reply", text: "staging text", versionId: "ver_s" })]);
  const otherTable = new ReleaseTable();
  await puller(other, otherTable, fleetKey.publicRaw, { ...scope, target: "staging" })();
  const relabelled = await a.applyBundle(otherTable.newest()!.bundle);
  assert.equal(relabelled.outcome, "refused");
  assert.match((relabelled as { detail?: string }).detail ?? "", /relabel|recipient|target/i);

  // A restart on the host's store serves generation 2 with no network and no row read.
  await a.stop();
  const again = await AirPrompterAgent.start({ ...scope, stateDir: dirA, root: { pinned: publicJwkOf(plane.rootKey) }, fetch: noNetwork, distributionKey });
  assert.equal(again.generation, 2);
  assert.equal(again.status().source, "store");
  await again.stop();
  await b.stop();
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

test("applyBundle under unlock_required stages and waits; unlock() makes it live; the pull refuses plaintext off dev", async () => {
  const plane = new FakeControlPlane(scope);
  const slot = plane.slot({ tag: "support.reply", text: "v1", versionId: "ver_1" });
  plane.promote([slot]);
  const fleetKey = generateX25519KeyPair();
  const distributionKey = { privateKey: fleetKey.privateKey, publicRaw: fleetKey.publicRaw };
  const table = new ReleaseTable();
  const pull = puller(plane, table, fleetKey.publicRaw);
  await pull();
  const dir = tempDir();
  const staged: number[] = [];
  const ap = await AirPrompterAgent.start({ ...scope, stateDir: dir, root: { pinned: publicJwkOf(plane.rootKey) }, fetch: async () => { throw new Error("offline"); }, distributionKey, vendoredBundle: { bundle: JSON.parse(table.newest()!.bundle) }, apply: { onStaged: (s) => void staged.push(s.generation) } });
  plane.promote([plane.slot({ tag: "support.reply", text: "v2", versionId: "ver_2" })], { applyPolicy: "unlock_required" });
  await pull();
  assert.deepEqual(await ap.applyBundle(table.newest()!.bundle), { outcome: "staged", generation: 2 });
  assert.deepEqual(staged, [2]);
  assert.equal(ap.generation, 1, "still serving 1");
  assert.equal(ap.status().applyState, "awaiting_unlock");
  assert.deepEqual(await ap.unlock(), { generation: 2 });
  assert.equal(ap.prompt("support.reply").render({}).text, "v2");
  await ap.stop();

  const client = new SyncClient({ baseUrl: "https://api.test", agentId: scope.agentId, target: scope.target, apiKey: plane.apiKey, fetch: plane.fetch() });
  const plaintext = await pullBundle({ client, scope, trustedRoot: trustedRootFromPinnedKey({ purpose: "platform", environment: "prod", pinnedRoot: publicJwkOf(plane.rootKey) }), now: () => new Date().toISOString(), distributionPublicKey: null });
  assert.deepEqual(plaintext, { status: "refused", reason: "plaintext_not_allowed", edge: { pointerUrl: null, pointerEtag: null, manifestEtag: null, lastOriginAt: null } });
  rmSync(dir, { recursive: true, force: true });
});

/** A bundle re-sealed to the fleet's public key (no secret) around a manifest the trusted root did not sign. */
function forged(plane: FakeControlPlane, publicRaw: Uint8Array, generation: number, notAfter = "2027-01-01T00:00:00Z") {
  const rogue = new FakeControlPlane(scope, "apa_live_testkey", { rootKey: plane.rootKey });
  const manifest = rogue.promote([rogue.slot({ tag: "support.reply", text: "forged", versionId: "ver_x" })], { generation });
  return JSON.stringify(createEncryptedBundle({ createdAt: new Date().toISOString(), notAfter, manifest, keySet: plane.root, payloads: [...rogue.payloads].map(([contentHash, bytes]) => ({ contentHash: contentHash as `sha256:${string}`, byteLength: bytes.length, bytes: bytes.toString("base64url") })) }, publicRaw));
}

test("a compromised store cannot poison a runtime: a forged bundle is refused before a byte is staged, in both branches", async () => {
  const plane = new FakeControlPlane(scope);
  plane.promote([plane.slot({ tag: "support.reply", text: "v1", versionId: "ver_1" })]);
  const fleetKey = generateX25519KeyPair();
  const distributionKey = { privateKey: fleetKey.privateKey, publicRaw: fleetKey.publicRaw };
  const table = new ReleaseTable();
  const pull = puller(plane, table, fleetKey.publicRaw);
  await pull();
  const noNetwork = async () => { throw new Error("offline"); };

  // Fresh host, forged row first (the fallback branch): refused, and store.json is NOT advanced — the real row still boots.
  const dir = tempDir();
  const events: string[] = [];
  const poisoned = await AirPrompterAgent.start({ ...scope, stateDir: dir, root: { pinned: publicJwkOf(plane.rootKey) }, fetch: noNetwork, distributionKey, logger: (e) => void events.push(`${e.event}:${e.reason ?? ""}`), vendoredBundle: { bundle: JSON.parse(forged(plane, fleetKey.publicRaw, 999)) } }).catch((e: unknown) => e);
  assert.ok(poisoned instanceof AgentStartError, "nothing verified: start refuses rather than serving the forgery");
  assert.ok(events.some((e) => e.startsWith("vendored_bundle_refused:")), `refused, not 'unusable': ${events.join(",")}`);
  const real = await AirPrompterAgent.start({ ...scope, stateDir: dir, root: { pinned: publicJwkOf(plane.rootKey) }, fetch: noNetwork, distributionKey, vendoredBundle: { bundle: JSON.parse(table.newest()!.bundle) } });
  assert.equal(real.generation, 1, "the legitimate generation-1 row boots on the same store: the forgery left no generation behind");

  // Serving host (the update branch): a forged generation 2 is refused, generation stays 1, and the next real row applies.
  const forgedApply = await real.applyBundle(forged(plane, fleetKey.publicRaw, 2));
  assert.equal(forgedApply.outcome, "refused");
  assert.match((forgedApply as { reason: string }).reason, /^(signature_invalid|unknown_signing_key)$/, "the chain refuses it by name");
  assert.equal(real.generation, 1);
  plane.promote([plane.slot({ tag: "support.reply", text: "v2", versionId: "ver_2" })]);
  await pull();
  assert.deepEqual(await real.applyBundle(table.newest()!.bundle), { outcome: "activated", generation: 2 });

  // Sealed to another fleet's key: unusable, named.
  const other = generateX25519KeyPair();
  const otherTable = new ReleaseTable();
  await puller(plane, otherTable, other.publicRaw)();
  const wrongKey = await real.applyBundle(otherTable.newest()!.bundle);
  assert.equal(wrongKey.outcome, "refused");
  assert.match((wrongKey as { detail?: string }).detail ?? "", /another distribution key|recipient|decrypt/i);

  // Past its notAfter: refused as an update.
  const expired = await real.applyBundle(forged(plane, fleetKey.publicRaw, 3, "2020-01-01T00:00:00Z"));
  assert.equal((expired as { reason: string }).reason, "expired");
  await real.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("a first release staged under unlock_required is a held generation: applyBundle of the same row is unchanged, not an activation around the unlock", async () => {
  const plane = new FakeControlPlane(scope);
  plane.promote([plane.slot({ tag: "support.reply", text: "v1", versionId: "ver_1" })], { applyPolicy: "unlock_required" });
  const fleetKey = generateX25519KeyPair();
  const table = new ReleaseTable();
  await puller(plane, table, fleetKey.publicRaw)();
  const dir = tempDir();
  // Booted over the air: nothing active, generation 1 staged (SDK 0.2.4).
  const ap = await AirPrompterAgent.start({ ...scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir: dir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" }, fetch: plane.fetch(), distributionKey: { privateKey: fleetKey.privateKey, publicRaw: fleetKey.publicRaw } });
  assert.equal(ap.status().applyState, "awaiting_unlock");
  assert.deepEqual(await ap.applyBundle(table.newest()!.bundle), { outcome: "unchanged", generation: 1 });
  assert.equal(ap.generation, 0, "still nothing served: the unlock is the customer's act");
  assert.equal(ap.status().applyState, "awaiting_unlock");
  assert.deepEqual(await ap.unlock(), { generation: 1 });
  assert.equal(ap.status().applyState, "active");
  await ap.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("concurrent applyBundle calls and a local rollback: one pass at a time, and a rolled-back generation stays held back", async () => {
  const plane = new FakeControlPlane(scope);
  plane.promote([plane.slot({ tag: "support.reply", text: "v1", versionId: "ver_1" })]);
  const fleetKey = generateX25519KeyPair();
  const distributionKey = { privateKey: fleetKey.privateKey, publicRaw: fleetKey.publicRaw };
  const table = new ReleaseTable();
  const pull = puller(plane, table, fleetKey.publicRaw);
  await pull();
  const dir = tempDir();
  const ap = await AirPrompterAgent.start({ ...scope, stateDir: dir, root: { pinned: publicJwkOf(plane.rootKey) }, fetch: async () => { throw new Error("offline"); }, distributionKey, vendoredBundle: { bundle: JSON.parse(table.newest()!.bundle) } });
  plane.promote([plane.slot({ tag: "support.reply", text: "v2", versionId: "ver_2" })]);
  await pull();
  const row = table.newest()!.bundle;
  const outcomes = await Promise.all([ap.applyBundle(row), ap.applyBundle(row), ap.applyBundle(row)]);
  assert.deepEqual(outcomes.map((o) => o.outcome).sort(), ["activated", "unchanged", "unchanged"], `serialised: ${JSON.stringify(outcomes)}`);
  assert.equal(ap.generation, 2);

  assert.deepEqual(await ap.rollback(), { generation: 1, forced: true });
  const heldBack = await ap.applyBundle(row);
  assert.equal(heldBack.outcome, "held_back", "the generation this host rolled away from is not re-applied by a row");
  plane.promote([plane.slot({ tag: "support.reply", text: "v3", versionId: "ver_3" })]);
  await pull();
  assert.deepEqual(await ap.applyBundle(table.newest()!.bundle), { outcome: "activated", generation: 3 }, "a newer generation ends the hold");
  await ap.stop();
  rmSync(dir, { recursive: true, force: true });
});


test("an applyBundle chained behind an in-flight sync keeps the store to one pass at a time, and stop() waits for it", async () => {
  const plane = new FakeControlPlane(scope);
  plane.promote([plane.slot({ tag: "support.reply", text: "v1", versionId: "ver_1" })]);
  const fleetKey = generateX25519KeyPair();
  const table = new ReleaseTable();
  const pull = puller(plane, table, fleetKey.publicRaw);
  await pull();
  const dir = tempDir();
  // A slow control plane: the sync in flight takes a while to answer.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let gated = false; // only after boot: the start's own sync must not park
  const slowFetch = plane.fetch();
  const fetchImpl: typeof slowFetch = async (url, init) => { if (gated && String(url).includes("/manifest")) await gate; return slowFetch(url, init); };
  const ap = await AirPrompterAgent.start({ ...scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir: dir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" }, fetch: fetchImpl, distributionKey: { privateKey: fleetKey.privateKey, publicRaw: fleetKey.publicRaw } });
  assert.equal(ap.generation, 1);
  plane.promote([plane.slot({ tag: "support.reply", text: "v2", versionId: "ver_2" })]);
  await pull();
  gated = true;
  const syncing = ap.syncNow(); // parks on the gate
  const applying = ap.applyBundle(table.newest()!.bundle); // chained behind the sync
  let applied = false;
  void applying.then(() => { applied = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(applied, false, "the apply waits for the sync in flight");
  release();
  await syncing;
  const outcome = await applying;
  assert.ok(outcome.outcome === "activated" || outcome.outcome === "unchanged", `after the sync: ${JSON.stringify(outcome)}`);
  assert.equal(ap.generation, 2);
  // A second sync started while the apply held the guard would have been the apply's own promise, not a new pass.
  await ap.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("a puller that hands its edge state back polls the CDN pointer, not the origin: a 304 or a held generation ends the pull at the edge; a moved pointer reaches the API once, conditionally; the interval stretches while nothing changes", async () => {
  const plane = new FakeControlPlane(scope);
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply politely.", versionId: "ver_1" })]);
  const fleetKey = generateX25519KeyPair();
  const client = new SyncClient({ baseUrl: "https://api.test", agentId: scope.agentId, target: scope.target, apiKey: plane.apiKey, fetch: plane.fetch() });
  const trustedRoot = trustedRootFromPinnedKey({ purpose: "platform", environment: "prod", pinnedRoot: publicJwkOf(plane.rootKey) });
  const fetchRoot = async () => JSON.parse(await (await plane.fetch()("https://edge.test/roots/prod/root.json", {})).text());
  const originCalls = () => plane.requests.filter((u) => u.includes("/manifest")).length;
  const pointerCalls = () => plane.requests.filter((u) => u.endsWith("/generation.json")).length;
  const base = { client, scope, trustedRoot, fetchRoot, now: () => new Date().toISOString(), distributionPublicKey: fleetKey.publicRaw };

  // First pull: no edge state, the origin answers and names the pointer.
  const first = await pullBundle(base);
  assert.equal(first.status, "ok");
  if (first.status !== "ok") throw new Error("unreachable");
  assert.equal(first.edge.pointerUrl, "https://edge.test/g/target-token/generation.json", "the origin named the pointer");
  assert.ok(first.edge.manifestEtag, "the manifest's ETag is remembered");
  assert.equal(pointerCalls(), 0);
  let edge = first.edge;
  let held = first.generation;

  // Nothing moved: the pointer (fresh: 200 with the held generation; then 304 on its ETag) — the origin is never asked.
  const before = originCalls();
  const second = await pullBundle({ ...base, edge, minimumGeneration: held });
  assert.deepEqual([second.status, (second as { via?: string }).via], ["unchanged", "pointer"]);
  edge = second.edge;
  assert.ok(edge.pointerEtag, "the pointer's ETag is remembered");
  const third = await pullBundle({ ...base, edge, minimumGeneration: held });
  assert.deepEqual([third.status, (third as { via?: string }).via], ["unchanged", "pointer"]);
  assert.equal(originCalls(), before, "two idle pulls, zero origin calls");
  assert.equal(pointerCalls(), 2);

  // A promotion moves the pointer: one origin read, a new row.
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply warmly.", versionId: "ver_2" })]);
  const fourth = await pullBundle({ ...base, edge: third.edge, minimumGeneration: held });
  assert.equal(fourth.status, "ok");
  if (fourth.status !== "ok") throw new Error("unreachable");
  assert.equal(fourth.generation, held + 1);
  assert.equal(originCalls(), before + 1);
  held = fourth.generation;

  // skipPointer (a nudge said "check now"): the origin, conditionally — a 304 is "unchanged via origin".
  const nudged = await pullBundle({ ...base, edge: fourth.edge, minimumGeneration: held, skipPointer: true });
  assert.deepEqual([nudged.status, (nudged as { via?: string }).via], ["unchanged", "origin"]);
  assert.equal(originCalls(), before + 2);

  // The interval stretches while nothing changes and snaps back on anything else.
  assert.equal(nextPullDelayMs({ outcome: "unchanged", unchangedStreak: 0, intervalMs: 10_000 }), 10_000);
  assert.equal(nextPullDelayMs({ outcome: "unchanged", unchangedStreak: 3, intervalMs: 10_000 }), 80_000);
  assert.equal(nextPullDelayMs({ outcome: "unchanged", unchangedStreak: 12, intervalMs: 10_000 }), 300_000, "capped at five minutes");
  assert.equal(nextPullDelayMs({ outcome: "unchanged", unchangedStreak: 12, intervalMs: 10_000, capMs: 60_000 }), 60_000);
  assert.equal(nextPullDelayMs({ outcome: "ok", unchangedStreak: 12, intervalMs: 10_000 }), 10_000);
  assert.equal(nextPullDelayMs({ outcome: "unavailable", unchangedStreak: 12, intervalMs: 10_000 }), 10_000);

  // A deployment with no edge: the origin every time, still conditional.
  plane.edgePointerUrl = null;
  const bare = await pullBundle(base);
  assert.equal(bare.status, "ok");
  if (bare.status !== "ok") throw new Error("unreachable");
  assert.equal(bare.edge.pointerUrl, null);
  const bareAgain = await pullBundle({ ...base, edge: bare.edge, minimumGeneration: held });
  assert.deepEqual([bareAgain.status, (bareAgain as { via?: string }).via], ["unchanged", "origin"]);
});

test("the pointer can hide nothing for long: an origin failure after a moved pointer keeps the old ETag; a stuck (pinned) pointer is overridden after maxPointerAgeMs; a CDN outage or a malformed pointer falls through to the origin", async () => {
  const plane = new FakeControlPlane(scope);
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply politely.", versionId: "ver_1" })]);
  const fleetKey = generateX25519KeyPair();
  let clock = Date.parse("2026-09-17T10:00:00Z");
  const now = () => new Date(clock).toISOString();
  const fetchImpl = plane.fetch();
  let failOrigin = false;
  let pointerMode: "ok" | "outage" | "garbage" = "ok";
  const fetchWith: typeof fetchImpl = async (url, init) => {
    if (url.endsWith("/generation.json") && pointerMode === "outage") throw new Error("cdn unreachable");
    if (url.endsWith("/generation.json") && pointerMode === "garbage") return { status: 200, headers: { get: () => null }, text: async () => "<html>not json</html>" } as unknown as Awaited<ReturnType<typeof fetchImpl>>;
    if (url.includes("/payloads/") && failOrigin) throw new Error("origin blip");
    return fetchImpl(url, init);
  };
  const client = new SyncClient({ baseUrl: "https://api.test", agentId: scope.agentId, target: scope.target, apiKey: plane.apiKey, fetch: fetchWith });
  const trustedRoot = trustedRootFromPinnedKey({ purpose: "platform", environment: "prod", pinnedRoot: publicJwkOf(plane.rootKey) });
  const fetchRoot = async () => JSON.parse(await (await fetchImpl("https://edge.test/roots/prod/root.json", {})).text());
  const base = { client, scope, trustedRoot, fetchRoot, now, distributionPublicKey: fleetKey.publicRaw };
  const originCalls = () => plane.requests.filter((u) => u.includes("/manifest")).length;

  const first = await pullBundle(base);
  assert.equal(first.status, "ok");
  if (first.status !== "ok") throw new Error("unreachable");
  let edge = first.edge;
  let held = first.generation;
  assert.ok(edge.lastOriginAt, "the origin's answer is stamped");

  // 1. The pointer moves, the origin blips mid-pull: the returned edge is the one handed in — the next pull sees the move again.
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply warmly.", versionId: "ver_2" })]);
  failOrigin = true;
  const blip = await pullBundle({ ...base, edge, minimumGeneration: held });
  assert.equal(blip.status, "unavailable");
  assert.deepEqual(blip.edge, edge, "nothing advanced past an answer the origin never confirmed");
  failOrigin = false;
  const recovered = await pullBundle({ ...base, edge: blip.edge, minimumGeneration: held });
  assert.equal(recovered.status, "ok", "the promotion is seen on the very next pull, not the one after the next promotion");
  if (recovered.status !== "ok") throw new Error("unreachable");
  edge = recovered.edge;
  held = recovered.generation;

  // 2. A stuck pointer (pinned by a party between the fleet and the edge) hides a promotion only until maxPointerAgeMs.
  plane.pinnedPointer = { generation: held };
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply briefly.", versionId: "ver_3" })]);
  const before = originCalls();
  for (let i = 0; i < 5; i += 1) {
    clock += 60_000;
    const r = await pullBundle({ ...base, edge, minimumGeneration: held });
    assert.deepEqual([r.status, (r as { via?: string }).via], ["unchanged", "pointer"]);
    edge = r.edge;
  }
  assert.equal(originCalls(), before, "within the bound the pinned pointer is believed");
  clock += 60 * 60_000 + 1;
  const bounded = await pullBundle({ ...base, edge, minimumGeneration: held });
  assert.equal(bounded.status, "ok", "past the bound the origin is asked and the hidden promotion lands");
  if (bounded.status !== "ok") throw new Error("unreachable");
  assert.equal(bounded.generation, held + 1);
  edge = bounded.edge;
  held = bounded.generation;
  plane.pinnedPointer = null;
  // A shorter bound is the caller's to set.
  clock += 10 * 60_000;
  plane.pinnedPointer = { generation: held };
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply.", versionId: "ver_4" })]);
  const short = await pullBundle({ ...base, edge, minimumGeneration: held, maxPointerAgeMs: 5 * 60_000 });
  assert.equal(short.status, "ok");
  if (short.status !== "ok") throw new Error("unreachable");
  edge = short.edge;
  held = short.generation;
  plane.pinnedPointer = null;

  // 3. A CDN outage, or a pointer that is not JSON, is not an answer: the origin is asked (conditionally: 304 → unchanged via origin).
  pointerMode = "outage";
  const outage = await pullBundle({ ...base, edge, minimumGeneration: held });
  assert.deepEqual([outage.status, (outage as { via?: string }).via], ["unchanged", "origin"]);
  pointerMode = "garbage";
  const garbage = await pullBundle({ ...base, edge: outage.edge, minimumGeneration: held });
  assert.deepEqual([garbage.status, (garbage as { via?: string }).via], ["unchanged", "origin"]);
  pointerMode = "ok";
});
