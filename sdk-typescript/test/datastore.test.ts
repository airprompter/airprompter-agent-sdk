/**
 * T40: the customer's datastore as the fleet's copy. The puller writes each sealed release through a DAO
 * (`pullToDatastore`) — the row and its edge state together, with a content-free rollout summary beside it; every
 * runtime hydrates from the datastore at start and on `hydrate()`: the dial-up percentages and ramp walk as signed, a
 * rollback set in the datastore moves the whole fleet down (verified, forced, held) and clearing it moves it back,
 * and a region reads its own rows and rollback before the global ones.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent } from "../packages/sdk/src/agent.js";
import { generateX25519KeyPair } from "../packages/core/src/bundle/hpke.js";
import { SyncClient } from "../packages/core/src/control/client.js";
import { publicJwkOf, trustedRootFromPinnedKey } from "../packages/core/src/protocol/trust.js";
import { pullToDatastore } from "../packages/sync/src/sync/pullToDatastore.js";
import { MemoryReleaseDatastore, clearDatastoreRollback, resolveHydration, rollbackDatastore, type ReleaseKey } from "../packages/sync/src/store/releaseDatastore.js";
import { FakeControlPlane } from "./helpers/controlPlane.js";

const scope: { organizationId: string; agentId: string; target: "dev" | "staging" | "prod" } = { organizationId: "org_1", agentId: "agt_1", target: "prod" };
const tempDir = () => mkdtempSync(join(tmpdir(), "ap-datastore-"));
const noNetwork = async () => {
  throw new Error("runtimes never reach the control plane");
};

function puller(plane: FakeControlPlane, datastore: MemoryReleaseDatastore, distributionPublicKey: Uint8Array, region: string | null = null) {
  const client = new SyncClient({ baseUrl: "https://api.test", agentId: scope.agentId, target: scope.target, apiKey: plane.apiKey, fetch: plane.fetch() });
  const trustedRoot = trustedRootFromPinnedKey({ purpose: "platform", environment: "prod", pinnedRoot: publicJwkOf(plane.rootKey) });
  const fetchRoot = async () => JSON.parse(await (await plane.fetch()("https://edge.test/roots/prod/root.json", {})).text());
  return () => pullToDatastore({ datastore, region, client, scope, trustedRoot, fetchRoot, now: () => new Date().toISOString(), distributionPublicKey });
}

function setup() {
  const plane = new FakeControlPlane(scope);
  const fleetKey = generateX25519KeyPair();
  const distributionKey = { privateKey: fleetKey.privateKey, publicRaw: fleetKey.publicRaw };
  const datastore = new MemoryReleaseDatastore();
  return { plane, fleetKey, distributionKey, datastore };
}

test("the puller writes sealed rows and its edge state through the DAO; a runtime hydrates from it with no network, the ramp and dial-up as signed", async () => {
  const { plane, fleetKey, distributionKey, datastore } = setup();
  const control = plane.slot({ tag: "support.reply", text: "Reply politely.", versionId: "ver_1" });
  plane.promote([control]);
  const pull = puller(plane, datastore, fleetKey.publicRaw);
  const first = await pull();
  assert.equal(first.status, "ok");
  assert.equal(first.stored, true);
  const key: ReleaseKey = { ...scope, region: null };
  const row1 = (await datastore.latest(key))!;
  assert.equal(row1.generation, 1);
  assert.equal(row1.bundle.includes("Reply politely"), false, "the row is ciphertext");
  assert.notEqual(await datastore.edge(key), null, "the edge state rides with the row");

  // A dial-up with a signed ramp: 10 % now, 50 % from an hour ago's step.
  const candidate = plane.slot({ tag: "support.reply", text: "Reply warmly.", versionId: "ver_2" });
  const past = new Date(Date.now() - 2 * 3600_000).toISOString();
  const later = new Date(Date.now() - 3600_000).toISOString();
  plane.promote([control], { experiment: { experimentId: "exp_1", salt: "AAECAwQFBgcICQoLDA0ODw", subjectKey: "request", arms: [{ arm: "control", weightBps: 9000, releaseDigest: `sha256:${"0".repeat(64)}`, overrides: [] }, { arm: "candidate", weightBps: 1000, releaseDigest: `sha256:${"1".repeat(64)}`, overrides: [candidate] }], ramp: [{ notBefore: past, weightBps: [7500, 2500] }, { notBefore: later, weightBps: [5000, 5000] }] } });
  assert.equal((await pull()).status, "ok");
  const row2 = (await datastore.latest(key))!;
  assert.deepEqual(row2.rollout.experiments[0]!.arms, [{ arm: "control", weightBps: 9000 }, { arm: "candidate", weightBps: 1000 }], "the dial-up percentages, queryable");
  assert.equal(row2.rollout.experiments[0]!.ramp.length, 2);
  // Nothing moved: the pull writes no row; a second pull of the same generation is not a second row.
  assert.equal((await pull()).stored, false);
  assert.deepEqual(await datastore.generations(key), [2, 1]);

  const dir = tempDir();
  const ap = await AirPrompterAgent.start({ ...scope, stateDir: dir, root: { pinned: publicJwkOf(plane.rootKey) }, fetch: noNetwork, distributionKey, datastore: { store: datastore } });
  assert.equal(ap.generation, 2);
  const status = ap.status();
  assert.deepEqual(status.ramp!.weightBps, [5000, 5000], "the ramp walks on this host's clock, as signed");
  assert.equal(status.ramp!.step, 1);
  assert.equal(status.datastore!.lastOutcome, "activated");
  assert.equal(status.datastore!.newestGeneration, 2);
  assert.equal(status.datastore!.rollback, null);
  assert.deepEqual(await ap.hydrate(), { outcome: "unchanged", generation: 2 });
  await ap.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("a rollback in the datastore moves every runtime down, verified and held; a newer promotion or clearing it moves them back", async () => {
  const { plane, fleetKey, distributionKey, datastore } = setup();
  const pull = puller(plane, datastore, fleetKey.publicRaw);
  for (const text of ["v1", "v2", "v3"]) {
    plane.promote([plane.slot({ tag: "support.reply", text, versionId: `ver_${text}` })]);
    await pull();
  }
  const key: ReleaseKey = { ...scope, region: null };
  const dirA = tempDir();
  const dirB = tempDir();
  const boot = (stateDir: string) => AirPrompterAgent.start({ ...scope, stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, fetch: noNetwork, distributionKey, datastore: { store: datastore } });
  const a = await boot(dirA);
  const b = await boot(dirB);
  assert.equal(a.generation, 3);

  // Fleet rollback: one step down from what serves.
  const rolled = await rollbackDatastore({ datastore, key, reason: "bad release" });
  assert.equal(rolled.ok, true);
  assert.deepEqual(rolled.ok && { generation: rolled.control.generation, heldBackBelow: rolled.control.heldBackBelow }, { generation: 2, heldBackBelow: 3 });
  assert.deepEqual(await a.hydrate(), { outcome: "rolled_back", generation: 2, heldBackBelow: 3 });
  assert.deepEqual(await b.hydrate(), { outcome: "rolled_back", generation: 2, heldBackBelow: 3 });
  assert.equal(a.prompt("support.reply").render({}).text, "v2");
  assert.equal(a.status().forcedDowngrade, true);
  assert.equal(a.status().datastore!.rollback!.generation, 2);
  assert.deepEqual(await a.hydrate(), { outcome: "unchanged", generation: 2 }, "a rollback is applied once");

  // A restart during the rollback serves the rolled-back generation (the store and the datastore agree).
  await b.stop();
  const b2 = await boot(dirB);
  assert.equal(b2.generation, 2);

  // Clearing it: the newest row serves again — the hold is released.
  await clearDatastoreRollback({ datastore, key });
  assert.deepEqual(await a.hydrate(), { outcome: "activated", generation: 3 });
  assert.equal(a.prompt("support.reply").render({}).text, "v3");

  // Roll back again, then a promotion past the hold ends it on every host without clearing anything.
  await rollbackDatastore({ datastore, key, toGeneration: 1 });
  assert.deepEqual(await b2.hydrate(), { outcome: "rolled_back", generation: 1, heldBackBelow: 3 });
  plane.promote([plane.slot({ tag: "support.reply", text: "v4", versionId: "ver_v4" })]);
  await pull();
  assert.deepEqual(await b2.hydrate(), { outcome: "activated", generation: 4 });
  assert.equal((await resolveHydration(datastore, key)).control, null);

  // An older row with no rollback in the datastore (a restored backup) never moves a host backwards.
  const refusedDown = await rollbackDatastore({ datastore, key, toGeneration: 9 });
  assert.deepEqual(refusedDown, { ok: false, reason: "generation_missing" });
  await a.stop();
  await b2.stop();
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

test("regions: a region with rows of its own serves them; one without reads the global rows; a regional rollback binds that region only", async () => {
  const { plane, fleetKey, distributionKey, datastore } = setup();
  const globalPull = puller(plane, datastore, fleetKey.publicRaw, null);
  const euPull = puller(plane, datastore, fleetKey.publicRaw, "eu-west-1");
  plane.promote([plane.slot({ tag: "support.reply", text: "v1", versionId: "ver_1" })]);
  await globalPull();
  await euPull();
  plane.promote([plane.slot({ tag: "support.reply", text: "v2", versionId: "ver_2" })]);
  await globalPull();
  await euPull();

  const boot = (stateDir: string, region: string | null) => AirPrompterAgent.start({ ...scope, stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, fetch: noNetwork, distributionKey, datastore: { store: datastore, region } });
  const dirs = [tempDir(), tempDir()];
  const eu = await boot(dirs[0]!, "eu-west-1");
  const us = await boot(dirs[1]!, "us-east-1");
  assert.equal(eu.status().datastore!.rowsFrom, "region");
  assert.equal(us.status().datastore!.rowsFrom, "global", "no rows of its own: the global ones");
  assert.equal(eu.generation, 2);
  assert.equal(us.generation, 2);

  // Roll back eu only.
  const rolled = await rollbackDatastore({ datastore, key: { ...scope, region: "eu-west-1" } });
  assert.equal(rolled.ok, true);
  assert.deepEqual(await eu.hydrate(), { outcome: "rolled_back", generation: 1, heldBackBelow: 2 });
  assert.deepEqual(await us.hydrate(), { outcome: "unchanged", generation: 2 });
  assert.equal(eu.status().datastore!.rollback!.scope, "region");

  // A global rollback binds us-east-1 (no rollback of its own) and leaves eu-west-1 on its own.
  await rollbackDatastore({ datastore, key: { ...scope, region: null }, toGeneration: 1 });
  assert.deepEqual(await us.hydrate(), { outcome: "rolled_back", generation: 1, heldBackBelow: 2 });
  assert.equal(us.status().datastore!.rollback!.scope, "global");
  // Clearing eu's own rollback leaves eu with none of its own: the global one binds it now.
  await clearDatastoreRollback({ datastore, key: { ...scope, region: "eu-west-1" } });
  assert.deepEqual(await eu.hydrate(), { outcome: "unchanged", generation: 1 });
  assert.equal(eu.status().datastore!.rollback!.scope, "global");
  await clearDatastoreRollback({ datastore, key: { ...scope, region: null } });
  assert.deepEqual(await eu.hydrate(), { outcome: "activated", generation: 2 }, "eu's own rows once no rollback binds it");
  assert.deepEqual(await us.hydrate(), { outcome: "activated", generation: 2 });

  await eu.stop();
  await us.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("a datastore that cannot be read leaves the runtime serving what it holds; the puller reports it without writing", async () => {
  const { plane, fleetKey, distributionKey, datastore } = setup();
  plane.promote([plane.slot({ tag: "support.reply", text: "v1", versionId: "ver_1" })]);
  await puller(plane, datastore, fleetKey.publicRaw)();
  const dir = tempDir();
  let down = false;
  const flaky = new Proxy(datastore, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => (down ? Promise.reject(new Error("connection refused")) : value.apply(target, args));
    },
  });
  const ap = await AirPrompterAgent.start({ ...scope, stateDir: dir, root: { pinned: publicJwkOf(plane.rootKey) }, fetch: noNetwork, distributionKey, datastore: { store: flaky } });
  down = true;
  const outcome = await ap.hydrate();
  assert.equal(outcome.outcome, "unavailable");
  assert.equal(ap.generation, 1);
  assert.equal(ap.status().datastore!.lastOutcome, "unavailable");
  const pulled = await puller(plane, flaky, fleetKey.publicRaw)();
  assert.equal(pulled.status, "datastore_unavailable");
  await ap.stop();

  // Restart with the datastore down: the host's own store serves.
  const again = await AirPrompterAgent.start({ ...scope, stateDir: dir, root: { pinned: publicJwkOf(plane.rootKey) }, fetch: noNetwork, distributionKey, datastore: { store: flaky } });
  assert.equal(again.generation, 1);
  await again.stop();
  rmSync(dir, { recursive: true, force: true });
});
