/**
 * Capabilities at the edges of the trust chain, end to end. A puller without a capability carries what a newer
 * runtime needs. A slot stored without its payload is absent, so a host that gains the capability comes up serving
 * and picks the slot up at the same generation. A release refused for a capability still delivers its disables, and
 * only ever reduces what runs. A store holding an older major upgrades in place.
 *
 * @example
 * ```sh
 * TSX_DISABLE_CACHE=1 node --import tsx --test test/capabilityCarry.test.ts
 * ```
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent, AgentStartError, RenderRefusedError } from "../packages/sdk/src/agent.js";
import { ManagedAgent, ManagedRunError } from "../packages/sdk/src/index.js";
import { createEncryptedBundle, createPlaintextBundle, openBundle } from "../packages/sdk/src/core/bundle/apbundle.js";
import { generateX25519KeyPair } from "../packages/sdk/src/core/bundle/hpke.js";
import { SUPPORTED_CAPABILITIES } from "../packages/sdk/src/core/protocol/capabilities.js";
import { carriedPayloads, optionalPayloads, publicJwkOf, referencedPayloads, releaseDigest, trustedRootFromPinnedKey, verifyManifest } from "../packages/sdk/src/core/protocol/trust.js";
import { experimentConflict, type Manifest, type ManifestSlot, type RootMetadata } from "../packages/sdk/src/core/protocol/types.js";
import { canonicalBytes, sha256Prefixed } from "../packages/sdk/src/core/protocol/canonicalJson.js";
import { SyncClient } from "../packages/sdk/src/core/control/client.js";
import { parseRunRef, runRefKeyFrom } from "../packages/sdk/src/core/render/runRef.js";
import { BundleRelease } from "../packages/sdk/src/core/release/bundleRelease.js";
import { observeCall } from "../packages/sdk/src/runtime/observe.js";
import { fileKey } from "../packages/sdk/src/sync/store/keyProvider.js";
import { encryptPayload, payloadAad } from "../packages/sdk/src/sync/store/payloadCrypto.js";
import { SlotStore } from "../packages/sdk/src/sync/store/slotStore.js";
import { syncOnce } from "../packages/sdk/src/sync/sync/loop.js";
import { pullBundle } from "../packages/sdk/src/sync/sync/pullBundle.js";
import { FakeControlPlane, newKey } from "./helpers/controlPlane.js";

const scope = { organizationId: "org_1", agentId: "agt_1", target: "prod" as const };
const FUTURE = "future_slots";
const tempDir = () => mkdtempSync(join(tmpdir(), "ap-carry-"));

/** Runs `fn` as an SDK that implements FUTURE. */
async function gaining<T>(fn: () => Promise<T> | T): Promise<T> {
  const set = SUPPORTED_CAPABILITIES as Set<string>;
  set.add(FUTURE);
  try {
    return await fn();
  } finally {
    set.delete(FUTURE);
  }
}

function release(plane: FakeControlPlane) {
  const base = plane.slot({ tag: "support.reply", text: "Reply politely." });
  const future = { ...plane.slot({ tag: "support.future", text: "From the future." }), requires: [FUTURE] } as ManifestSlot;
  return { base, future };
}

const pullOf = (plane: FakeControlPlane, distributionPublicKey: Uint8Array) => {
  const client = new SyncClient({ baseUrl: "https://api.test", agentId: scope.agentId, target: scope.target, apiKey: plane.apiKey, fetch: plane.fetch() });
  const trustedRoot = trustedRootFromPinnedKey({ purpose: "platform", environment: "prod", pinnedRoot: publicJwkOf(plane.rootKey) });
  const fetchRoot = async () => JSON.parse(await (await plane.fetch()("https://edge.test/roots/prod/root.json", {})).text());
  return pullBundle({ client, scope, trustedRoot, fetchRoot, now: () => new Date().toISOString(), distributionPublicKey });
};

const start = (plane: FakeControlPlane, stateDir: string, extra: Partial<Parameters<typeof AirPrompterAgent.start>[0]> = {}) =>
  AirPrompterAgent.start({ ...scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" }, fetch: plane.fetch(), ...extra });

const noNetwork = async () => { throw new Error("no network here"); };

const rootOf = async (plane: FakeControlPlane): Promise<RootMetadata> => JSON.parse(await (await plane.fetch()("https://edge.test/roots/prod/root.json", {})).text());

/** A slot with a golden set whose one case fails on any answer but "ok". */
function goldenSlot(plane: FakeControlPlane): ManifestSlot {
  const set = { format: "airprompter-golden-set", version: 1, setId: "set_1", minPassBps: 10000, cases: [{ caseId: "a", variables: {}, expect: [{ kind: "must_match", name: "ok", pattern: "ok" }] }] };
  const bytes = canonicalBytes(set);
  const contentHash = sha256Prefixed(bytes);
  plane.payloads.set(contentHash, Buffer.from(bytes));
  return { ...plane.slot({ tag: "support.reply", text: "Reply." }), goldenSet: { setId: "set_1", cases: 1, contentHash, byteLength: bytes.length, minPassBps: 10000 } } as ManifestSlot;
}

test("a puller without the capability carries a slot it cannot serve: 2 of 2 payloads, and a runtime with the capability applies the bundle", async () => {
  const plane = new FakeControlPlane(scope);
  const { base, future } = release(plane);
  const manifest = plane.promote([base, future]);
  assert.equal(referencedPayloads(manifest.payload).size, 1, "this SDK serves one of them");
  assert.equal(carriedPayloads(manifest.payload).size, 2, "and carries both");
  const key = generateX25519KeyPair();
  const pulled = await pullOf(plane, key.publicRaw);
  assert.equal(pulled.status, "ok", JSON.stringify(pulled));
  if (pulled.status !== "ok") throw new Error("unreachable");
  const distributionKey = { privateKey: key.privateKey, publicRaw: key.publicRaw };
  const contents = openBundle(pulled.bundle, scope, distributionKey);
  assert.deepEqual(contents.payloads.map((payload) => payload.contentHash).sort(), [base.contentHash, future.contentHash].sort());
  await gaining(async () => {
    const dir = tempDir();
    const ap = await AirPrompterAgent.start({ ...scope, stateDir: dir, root: { pinned: publicJwkOf(plane.rootKey) }, fetch: noNetwork, distributionKey, vendoredBundle: { bundle: pulled.bundle } });
    try {
      assert.equal(ap.prompt("support.future").render({}).text, "From the future.");
      assert.equal(ap.prompt("support.reply").render({}).text, "Reply politely.");
    } finally {
      await ap.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("the walk reaches a pin no reader of this release knows, and a top-level capability does not stop a puller", async () => {
  const plane = new FakeControlPlane(scope);
  const { base, future } = release(plane);
  const pin = plane.slot({ tag: "support.variant", text: "A variant nobody here can read." });
  const open = { ...future, variants: [{ name: "b", pin: { contentHash: pin.contentHash, byteLength: pin.byteLength } }] } as ManifestSlot;
  const manifest = plane.promote([base, open], { requiredCapabilities: [FUTURE] });
  assert.deepEqual([...carriedPayloads(manifest.payload).keys()].sort(), [base.contentHash, future.contentHash, pin.contentHash].sort());
  const key = generateX25519KeyPair();
  const pulled = await pullOf(plane, key.publicRaw);
  assert.equal(pulled.status, "ok", JSON.stringify(pulled));
  if (pulled.status !== "ok") throw new Error("unreachable");
  assert.equal(openBundle(pulled.bundle, scope, { privateKey: key.privateKey, publicRaw: key.publicRaw }).payloads.length, 3);
  const trustedRoot = trustedRootFromPinnedKey({ purpose: "platform", environment: "prod", pinnedRoot: publicJwkOf(plane.rootKey) });
  const root = JSON.parse(await (await plane.fetch()("https://edge.test/roots/prod/root.json", {})).text());
  assert.equal(verifyManifest({ manifest, root: root ?? trustedRoot, now: new Date().toISOString(), scope, storedGeneration: 0, payloads: null }).ok, false, "the runtime still refuses it at apply");
});

test("a carrier refuses a tampered payload and a missing one a release needs; a `requires` payload that was never served is absent", async () => {
  const plane = new FakeControlPlane(scope);
  const { base, future } = release(plane);
  plane.promote([base, future]);
  const key = generateX25519KeyPair();
  plane.payloads.delete(future.contentHash);
  const absent = await pullOf(plane, key.publicRaw);
  assert.equal(absent.status, "ok", JSON.stringify(absent));
  if (absent.status !== "ok") throw new Error("unreachable");
  assert.equal(openBundle(absent.bundle, scope, { privateKey: key.privateKey, publicRaw: key.publicRaw }).payloads.length, 1);
  plane.payloads.set(future.contentHash, Buffer.alloc(future.byteLength, 1));
  const tampered = await pullOf(plane, key.publicRaw);
  assert.deepEqual([tampered.status, tampered.status === "refused" ? tampered.reason : null], ["refused", "payload_hash_mismatch"], "bytes this SDK cannot serve are still checked");
  plane.payloads.delete(future.contentHash);
  plane.payloads.delete(base.contentHash);
  const missing = await pullOf(plane, key.publicRaw);
  assert.deepEqual([missing.status, missing.status === "refused" ? missing.reason : null, missing.status === "refused" ? missing.contentHash : null], ["refused", "payload_missing", base.contentHash]);
});

test("M9 is strict by default: only a store or a carrier goes without a payload named only under requires", async () => {
  const plane = new FakeControlPlane(scope);
  const { base, future } = release(plane);
  const manifest = plane.promote([base, future]);
  const root = await rootOf(plane);
  const verify = (payloads: Map<string, Uint8Array>, absentRequires: boolean) => verifyManifest({ manifest, root, now: new Date().toISOString(), scope, storedGeneration: 0, payloads, absentRequires });
  assert.deepEqual([...optionalPayloads(manifest.payload)], [future.contentHash]);
  const baseBytes = plane.payloads.get(base.contentHash)!;
  await gaining(() => {
    assert.equal(referencedPayloads(manifest.payload).size, 2);
    assert.deepEqual(verify(new Map([[base.contentHash, baseBytes]]), false), { ok: false, reason: "payload_missing" }, "strict for every other caller");
    assert.equal(verify(new Map([[base.contentHash, baseBytes]]), true).ok, true);
    assert.deepEqual(verify(new Map([[future.contentHash, plane.payloads.get(future.contentHash)!]]), true), { ok: false, reason: "payload_missing" });
    const bundle = createPlaintextBundle({ createdAt: new Date().toISOString(), notAfter: "2027-01-01T00:00:00Z", manifest, keySet: plane.root, payloads: [{ contentHash: base.contentHash as `sha256:${string}`, byteLength: baseBytes.length, bytes: baseBytes.toString("base64url") }] });
    assert.deepEqual(BundleRelease.load({ bundle, root, scope, now: new Date().toISOString() }), { ok: false, reason: "payload_missing" }, "a bundle release stays strict");
  });
});

test("a requires slot sharing a hash with an ordinary slot serves no empty step", async () => {
  const plane = new FakeControlPlane(scope);
  const base = plane.slot({ tag: "support.reply", text: "Reply politely." });
  const stepOnly = plane.slot({ tag: "support.step", text: "A step this host never stored." });
  const workflow = { ...base, tag: "support.flow", kind: "workflow", requires: [FUTURE], steps: [{ stepId: "support.flow#1", ordinal: 1, promptArtifactId: "prm_s", promptVersionId: "ver_s", contentHash: stepOnly.contentHash, byteLength: stepOnly.byteLength }] } as ManifestSlot;
  plane.promote([base, workflow]);
  const dir = tempDir();
  (await start(plane, dir)).stop();
  plane.payloads.delete(stepOnly.contentHash);
  await gaining(async () => {
    const ap = await start(plane, dir, { fetch: noNetwork });
    try {
      assert.equal(ap.generation, 1);
      assert.throws(() => ap.workflow("support.flow"), /no slot support\.flow/, "the main hash is held; the step is not");
      assert.equal(ap.prompt("support.reply").render({}).text, "Reply politely.");
    } finally {
      await ap.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a pull refuses a missing payload unless it is named only under requires, and reads no payload for a forged manifest", async () => {
  const plane = new FakeControlPlane(scope);
  const base = plane.slot({ tag: "support.reply", text: "Reply politely." });
  const pin = plane.slot({ tag: "support.pin", text: "A pin outside any requires." });
  plane.promote([{ ...base, variants: [{ pin: { contentHash: pin.contentHash, byteLength: pin.byteLength } }] } as ManifestSlot]);
  const key = generateX25519KeyPair();
  plane.payloads.delete(pin.contentHash);
  const missing = await pullOf(plane, key.publicRaw);
  assert.deepEqual([missing.status, missing.status === "refused" ? missing.reason : null], ["refused", "payload_missing"], "not ok: nothing excuses it");
  plane.requests.length = 0;
  plane.promote([base], { signWith: newKey() });
  const forged = await pullOf(plane, key.publicRaw);
  assert.equal(forged.status, "refused");
  assert.equal(plane.requests.some((url) => url.includes("/payloads/")), false, "the envelope comes before the walk");
});

test("the stranded host: generation 1 skipped a slot, the SDK gains the capability, it restarts on the same store serving generation 1, then picks up the slot", async () => {
  const plane = new FakeControlPlane(scope);
  const { base, future } = release(plane);
  plane.promote([base, future]);
  const dir = tempDir();
  const before = await start(plane, dir);
  assert.equal(before.generation, 1);
  assert.throws(() => before.prompt("support.future").render({}), /no slot support\.future/);
  await before.stop();

  await gaining(async () => {
    const events: Record<string, unknown>[] = [];
    // The first boot has no network: it serves from the store, with no slot to show for what it never stored.
    const offline = await start(plane, dir, { fetch: noNetwork, logger: (event) => events.push(event) });
    assert.equal(offline.generation, 1, "serving, not generation 0");
    assert.equal(offline.prompt("support.reply").render({}).text, "Reply politely.");
    assert.throws(() => offline.prompt("support.future").render({}), /no slot support\.future/, "absent, not corrupt");
    assert.equal(events.some((event) => event.event === "slot_unusable"), false, JSON.stringify(events));
    await offline.stop();

    // The edge pointer and an ETag would both say nothing moved; a stranded host asks the origin anyway.
    const online = await start(plane, dir, { sync: { mode: "resident", pollSeconds: 3600, edgePointerUrl: "https://edge.test/g/token/generation.json", rootUrl: "https://edge.test/roots/prod/root.json" } });
    try {
      await online.syncNow();
      assert.equal(online.generation, 1, "the same generation");
      assert.equal(online.prompt("support.future").render({}).text, "From the future.");
      assert.equal(online.prompt("support.reply").render({}).text, "Reply politely.");
    } finally {
      await online.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a sync pass holding the ETag of a stranded release still reads the manifest", async () => {
  const plane = new FakeControlPlane(scope);
  const { base, future } = release(plane);
  const manifest = plane.promote([base, future]);
  const dir = tempDir();
  const first = await start(plane, dir);
  await first.stop();
  await gaining(async () => {
    const store = await SlotStore.open({ stateDir: dir, ...scope, keyProvider: fileKey(join(SlotStore.path({ stateDir: dir, ...scope }), "store.key")) });
    const root = JSON.parse(await (await plane.fetch()("https://edge.test/roots/prod/root.json", {})).text());
    const active = store.load(store.state.active!, { now: new Date().toISOString(), root });
    const client = new SyncClient({ baseUrl: "https://api.test", agentId: scope.agentId, target: scope.target, apiKey: plane.apiKey, fetch: plane.fetch() });
    const fetched = await client.manifest({});
    assert.equal(fetched.status, "ok");
    const etag = fetched.status === "ok" ? fetched.etag : null;
    assert.notEqual(etag, null);
    const pass = await syncOnce({ store, client, now: () => new Date().toISOString(), scope, trustedRoot: root, active, etag, applyPolicy: () => "activated" });
    assert.deepEqual([pass.outcome, pass.generation], ["activated", manifest.payload.generation]);
    assert.equal(pass.active?.payloads.has(future.contentHash), true);
  });
  rmSync(dir, { recursive: true, force: true });
});

test("a stranded host with an unobtainable payload tries once, then returns to the idle path", async () => {
  const plane = new FakeControlPlane(scope);
  const { base, future } = release(plane);
  plane.promote([base, future]);
  const dir = tempDir();
  await (await start(plane, dir)).stop();
  plane.payloads.delete(future.contentHash);
  await gaining(async () => {
    const ap = await start(plane, dir, { sync: { mode: "resident", pollSeconds: 3600, edgePointerUrl: "https://edge.test/g/token/generation.json" } });
    try {
      await ap.syncNow();
      assert.equal(ap.generation, 1);
      await ap.syncNow();
      plane.requests.length = 0;
      await ap.syncNow();
      await ap.syncNow();
      assert.equal(plane.requests.some((url) => new URL(url).pathname.endsWith("/manifest")), false, plane.requests.join(" "));
      assert.equal(ap.prompt("support.reply").render({}).text, "Reply politely.");
    } finally {
      await ap.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a bundle host picks a stranded slot up at its next generation, not from a same-generation bundle", async () => {
  const plane = new FakeControlPlane(scope);
  const { base, future } = release(plane);
  plane.promote([base, future]);
  const key = generateX25519KeyPair();
  const distributionKey = { privateKey: key.privateKey, publicRaw: key.publicRaw };
  const whole = await pullOf(plane, key.publicRaw);
  if (whole.status !== "ok") throw new Error("the pull must work");
  const dir = tempDir();
  const options = { ...scope, stateDir: dir, root: { pinned: publicJwkOf(plane.rootKey) }, fetch: noNetwork, distributionKey };
  const contents = openBundle(whole.bundle, scope, distributionKey);
  const store = await SlotStore.open({ stateDir: dir, ...scope, keyProvider: fileKey(join(SlotStore.path({ stateDir: dir, ...scope }), "store.key")) });
  store.acceptRoot(await rootOf(plane));
  store.stage({ manifest: contents.manifest, payloads: new Map([[base.contentHash, plane.payloads.get(base.contentHash)!]]) });
  store.activate();
  plane.promote([base, future]);
  const next = await pullOf(plane, key.publicRaw);
  if (next.status !== "ok") throw new Error("the pull must work");
  await gaining(async () => {
    const ap = await AirPrompterAgent.start(options);
    try {
      assert.equal((await ap.applyBundle(whole.bundle)).outcome, "unchanged");
      assert.throws(() => ap.prompt("support.future").render({}), /no slot support\.future/);
      await ap.applyBundle(next.bundle);
      assert.equal(ap.generation, 2);
      assert.equal(ap.prompt("support.future").render({}).text, "From the future.");
    } finally {
      await ap.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("store.load excuses a missing payload and nothing else: a tampered or undecryptable optional payload is corrupt", async () => {
  const plane = new FakeControlPlane(scope);
  const { base, future } = release(plane);
  const manifest = plane.promote([base, future]);
  const dir = tempDir();
  const store = await SlotStore.open({ stateDir: dir, ...scope, keyProvider: fileKey(join(SlotStore.path({ stateDir: dir, ...scope }), "store.key")) });
  const root = await rootOf(plane);
  store.acceptRoot(root);
  store.stage({ manifest, payloads: new Map(plane.payloads) });
  const slot = store.activate();
  const file = join(store.dir, "slots", slot, "payloads", `${future.contentHash.replace(":", "-")}.enc`);
  const dek = (store as unknown as { dek: Uint8Array }).dek;
  await gaining(() => {
    const corrupt = (error: unknown) => (error as { code?: string }).code === "slot_corrupt";
    writeFileSync(file, encryptPayload(dek, Buffer.from("sealed, and not those bytes"), payloadAad({ ...scope, generation: 1, contentHash: future.contentHash })));
    assert.throws(() => store.load(slot, { now: new Date().toISOString(), root }), corrupt, "tampered");
    writeFileSync(file, "not ciphertext");
    assert.throws(() => store.load(slot, { now: new Date().toISOString(), root }), corrupt, "undecryptable");
    rmSync(file);
    assert.equal(store.load(slot, { now: new Date().toISOString(), root }).payloads.has(future.contentHash), false, "missing is absent");
  });
  rmSync(dir, { recursive: true, force: true });
});

test("store.stage refuses any entry, referenced or not, that is not named for its bytes", async () => {
  const plane = new FakeControlPlane(scope);
  const { base, future } = release(plane);
  const manifest = plane.promote([base, future]);
  const dir = tempDir();
  const store = await SlotStore.open({ stateDir: dir, ...scope, keyProvider: fileKey(join(SlotStore.path({ stateDir: dir, ...scope }), "store.key")) });
  const held = plane.payloads.get(base.contentHash)!;
  const entries = (name: string, bytes: Uint8Array) => new Map<string, Uint8Array>([[base.contentHash, held], [name, bytes]]);
  const corrupt = (error: unknown) => (error as { code?: string }).code === "slot_corrupt";
  assert.throws(() => store.stage({ manifest, payloads: entries(future.contentHash, Buffer.from("wrong bytes")) }), corrupt, "wrong bytes for a slot this SDK skips");
  const traversal = "../../../escape";
  assert.throws(() => store.stage({ manifest, payloads: entries(traversal, Buffer.from("x")) }), corrupt, "a path for a name");
  assert.deepEqual(readdirSync(join(store.dir)).filter((name) => name.includes("escape")), []);
  assert.equal(existsSync(join(store.dir, "slots", "A", "manifest.json")), false, "nothing was written");
  assert.equal(store.state.staged ?? null, null);
  rmSync(dir, { recursive: true, force: true });
});

test("a bundle with wrong bytes for a skipped slot is refused at stage, the active release keeps serving, and gaining the capability strands nothing", async () => {
  const plane = new FakeControlPlane(scope);
  const { base, future } = release(plane);
  const key = generateX25519KeyPair();
  const distributionKey = { privateKey: key.privateKey, publicRaw: key.publicRaw };
  plane.promote([base]);
  const first = await pullOf(plane, key.publicRaw);
  if (first.status !== "ok") throw new Error("the pull must work");
  const dir = tempDir();
  const options = { ...scope, stateDir: dir, root: { pinned: publicJwkOf(plane.rootKey) }, fetch: noNetwork, distributionKey };
  const ap = await AirPrompterAgent.start({ ...options, vendoredBundle: { bundle: first.bundle } });
  const manifest = plane.promote([base, future]);
  const held = plane.payloads.get(base.contentHash)!;
  const wrong = Buffer.alloc(future.byteLength, 1);
  const bundle = createEncryptedBundle({ createdAt: new Date().toISOString(), notAfter: "2030-01-01T00:00:00Z", manifest, keySet: plane.root, payloads: [{ contentHash: base.contentHash as `sha256:${string}`, byteLength: held.length, bytes: held.toString("base64url") }, { contentHash: future.contentHash as `sha256:${string}`, byteLength: wrong.length, bytes: wrong.toString("base64url") }] }, key.publicRaw);
  assert.equal((await ap.applyBundle(bundle)).outcome, "refused");
  assert.equal(ap.generation, 1, "the active release stands");
  assert.equal(ap.prompt("support.reply").render({}).text, "Reply politely.");
  await ap.stop();
  await gaining(async () => {
    const after = await AirPrompterAgent.start(options);
    assert.equal(after.generation, 1, "no slot holds the wrong bytes to come up on");
    await after.stop();
  });
  rmSync(dir, { recursive: true, force: true });
});

test("a capability-refused bundle delivers its disables to a bundle host, and a later refused bundle without them lifts them", async () => {
  const plane = new FakeControlPlane(scope);
  const a = plane.slot({ tag: "support.a", text: "A" });
  const b = plane.slot({ tag: "support.b", text: "B" });
  const key = generateX25519KeyPair();
  const distributionKey = { privateKey: key.privateKey, publicRaw: key.publicRaw };
  const bundleOf = async () => {
    const pulled = await pullOf(plane, key.publicRaw);
    if (pulled.status !== "ok") throw new Error(`the pull must work: ${JSON.stringify(pulled)}`);
    return pulled.bundle;
  };
  plane.promote([a, b]);
  const first = await bundleOf();
  plane.promote([a, b], { requiredCapabilities: [FUTURE], directives: [{ kind: "disable", scope: "slot", tag: "support.a", issuedAt: "2026-09-12T11:00:00Z" }] });
  const disabling = await bundleOf();
  plane.promote([a, b], { requiredCapabilities: [FUTURE], directives: [] });
  const lifting = await bundleOf();
  const dir = tempDir();
  const ap = await AirPrompterAgent.start({ ...scope, stateDir: dir, root: { pinned: publicJwkOf(plane.rootKey) }, fetch: noNetwork, distributionKey, vendoredBundle: { bundle: first } });
  try {
    assert.equal(ap.prompt("support.a").render({}).text, "A");
    assert.equal((await ap.applyBundle(disabling)).outcome, "refused");
    assert.equal(ap.generation, 1);
    assert.throws(() => ap.prompt("support.a").render({}), RenderRefusedError, "the disable reached a bundle host");
    assert.equal((await ap.applyBundle(lifting)).outcome, "refused");
    assert.equal(ap.prompt("support.a").render({}).text, "A", "and a lift lands");
  } finally {
    await ap.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refused generation delivers its disables, each refused manifest replaces the last, and a lift undoes only what a refused generation added", async () => {
  const plane = new FakeControlPlane(scope);
  const a = plane.slot({ tag: "support.a", text: "A" });
  const b = plane.slot({ tag: "support.b", text: "B" });
  const dir = tempDir();
  plane.promote([a, b], { directives: [{ kind: "disable", scope: "slot", tag: "support.a", issuedAt: "2026-09-12T10:00:00Z" }] });
  const ap = await start(plane, dir);
  try {
    assert.throws(() => ap.prompt("support.a").render({}), RenderRefusedError);
    // The new generation lifts A's disable and disables B. This SDK cannot read it, so only the second half stands.
    plane.promote([a, b], { requiredCapabilities: [FUTURE], directives: [{ kind: "disable", scope: "slot", tag: "support.b", issuedAt: "2026-09-12T11:00:00Z" }] });
    await ap.syncNow();
    assert.equal(ap.generation, 1, "the release itself is refused");
    assert.throws(() => ap.prompt("support.b").render({}), RenderRefusedError, "the new disable reached the host");
    assert.throws(() => ap.prompt("support.a").render({}), RenderRefusedError, "the active release's own disable is not lifted");
    assert.deepEqual([...ap.status().disabled.slots].sort(), ["support.a", "support.b"]);
    // The next refused generation lifts B: it replaces the last one and leaves the active release's own.
    plane.promote([a, b], { requiredCapabilities: [FUTURE], directives: [] });
    await ap.syncNow();
    assert.equal(ap.prompt("support.b").render({}).text, "B", "a lift lifts");
    assert.throws(() => ap.prompt("support.a").render({}), RenderRefusedError, "the active release's own disable stands");
    assert.deepEqual([...ap.status().disabled.slots], ["support.a"]);
    // A non-object beside a disable, on a generation refused for a capability.
    plane.promote([a, b], { requiredCapabilities: [FUTURE], directives: [null, { kind: "disable", scope: "slot", tag: "support.b", issuedAt: "2026-09-12T12:00:00Z" }] as never });
    await ap.syncNow();
    assert.equal(ap.generation, 1);
    assert.throws(() => ap.prompt("support.b").render({}), RenderRefusedError, "a disable beside a non-object stands");
    plane.promote([a, b], { directives: [{ kind: "later_kind" }, { kind: "disable", scope: "slot", tag: "support.a", issuedAt: "2026-09-12T13:00:00Z" }] as never });
    await ap.syncNow();
    assert.equal(ap.status().lastRefusal, "directive_unknown");
  } finally {
    await ap.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a first release waiting for unlock costs one fetch, one onStaged and then 304s", async () => {
  const plane = new FakeControlPlane(scope);
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply." })], { applyPolicy: "unlock_required" });
  const staged: number[] = [];
  const dir = tempDir();
  const ap = await start(plane, dir, { apply: { onStaged: (entry: { generation: number }) => void staged.push(entry.generation) } as never });
  try {
    await ap.syncNow();
    await ap.syncNow();
    await ap.syncNow();
    assert.deepEqual(staged, [1], "one onStaged");
    assert.equal(plane.requests.filter((url) => url.includes("/payloads/")).length, 1, "one payload fetch");
    assert.equal(ap.status().generation, 0, "the store's generation stays 0 while a first release is only staged");
  } finally {
    await ap.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed golden set on a first release runs once and then sees 304s; a host with nothing promoted still uses the pointer", async () => {
  const plane = new FakeControlPlane(scope);
  const slot = goldenSlot(plane);
  plane.promote([slot]);
  let invoked = 0;
  const dir = tempDir();
  const events: Record<string, unknown>[] = [];
  const ap = await start(plane, dir, { root: plane.root, golden: { invoke: async () => { invoked += 1; return "wrong"; }, concurrency: 1 }, logger: (event) => events.push(event) });
  try {
    const after = invoked;
    assert.ok(after >= 1, `the set ran: ${JSON.stringify(events)}`);
    await ap.syncNow();
    await ap.syncNow();
    assert.equal(invoked, after, "one golden run");
    assert.equal(plane.requests.filter((url) => url.includes("/payloads/")).length, 2, "the slot and its set, once each");
  } finally {
    await ap.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  const empty = new FakeControlPlane(scope);
  const idle = await start(empty, tempDir(), { sync: { mode: "resident", pollSeconds: 3600, edgePointerUrl: "https://edge.test/g/token/generation.json" } });
  empty.requests.length = 0;
  await idle.syncNow();
  assert.equal(empty.requests.some((url) => url.endsWith("/generation.json")), true, "nothing active, nothing stored: the pointer still answers");
  await idle.stop();
});

test("an arm that loses the override of its own tag: the host sits the experiment out, base text, arm none, bucket null", async () => {
  const plane = new FakeControlPlane(scope);
  const base = plane.slot({ tag: "support.reply", text: "Base" });
  const candidate = plane.slot({ tag: "support.reply", text: "Candidate", versionId: "ver_candidate" });
  const experiment = { tag: "support.reply", experimentId: "exp_1", salt: "AAECAwQFBgcICQoLDA0ODw", subjectKey: "request" as const, arms: [{ arm: "control", weightBps: 0, releaseDigest: releaseDigest([base]), overrides: [] }, { arm: "candidate", weightBps: 10000, releaseDigest: releaseDigest([candidate]), overrides: [{ ...candidate, requires: [FUTURE] }] }] };
  plane.promote([base], { experiments: [experiment] as never, directives: [{ kind: "disable", scope: "arm", arm: "candidate", experimentId: "exp_1", issuedAt: "2026-09-12T10:00:00Z" }] });
  const dir = tempDir();
  const ap = await start(plane, dir, { runRefSecret: "s" });
  try {
    assert.equal(ap.generation, 1, "an arm disable naming the experiment still loads");
    const rendered = ap.prompt("support.reply", { subject: "u1" }).render({});
    const entry = parseRunRef(rendered.runRef, Buffer.from(runRefKeyFrom("s", scope.agentId, scope.target)))?.entries[0];
    assert.deepEqual([rendered.text, rendered.arm, entry?.arm, entry?.bucket], ["Base", "none", "none", null]);
  } finally {
    await ap.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a frozen experiment stops a host that sits it out, and a pinned run, with or without the capability", async () => {
  const build = () => {
    const plane = new FakeControlPlane(scope);
    const base = plane.slot({ tag: "support.reply", text: "Base" });
    const candidate = plane.slot({ tag: "support.reply", text: "Candidate", versionId: "ver_candidate" });
    const experiment = { tag: "support.reply", experimentId: "exp_1", salt: "AAECAwQFBgcICQoLDA0ODw", subjectKey: "request" as const, arms: [{ arm: "control", weightBps: 5000, releaseDigest: releaseDigest([base]), overrides: [] }, { arm: "candidate", weightBps: 5000, releaseDigest: releaseDigest([candidate]), overrides: [{ ...candidate, requires: [FUTURE] }] }] };
    return { plane, base, experiment };
  };
  const off = (arm: string) => ({ kind: "disable" as const, scope: "arm" as const, arm, experimentId: "exp_1", issuedAt: "2026-09-12T10:00:00Z" });
  const refused = (ap: AirPrompterAgent) => assert.throws(() => ap.prompt("support.reply", { subject: "u1" }).render({}), RenderRefusedError);
  const sitting = build();
  sitting.plane.promote([sitting.base], { experiments: [sitting.experiment] as never, directives: [off("control"), off("candidate")] });
  const dir = tempDir();
  const ap = await start(sitting.plane, dir);
  refused(ap);
  await ap.stop();
  await gaining(async () => {
    const capable = await start(sitting.plane, tempDir());
    refused(capable);
    await capable.stop();
  });
  // One arm off is no freeze: a host that sits the experiment out serves base.
  const partly = build();
  partly.plane.promote([partly.base], { experiments: [partly.experiment] as never, directives: [off("candidate")] });
  const one = await start(partly.plane, tempDir());
  assert.equal(one.prompt("support.reply", { subject: "u1" }).render({}).text, "Base");
  await one.stop();
  // A run pinned before the freeze stops at its next place.
  const pinned = build();
  pinned.plane.promote([pinned.base], { experiments: [pinned.experiment] as never });
  const host = await start(pinned.plane, tempDir());
  const run = host.openRun();
  assert.equal((await run.place("support.reply")).kind, "approved");
  pinned.plane.promote([pinned.base], { experiments: [pinned.experiment] as never, directives: [off("control"), off("candidate")] });
  await host.syncNow();
  assert.deepEqual([(await run.place("support.reply")).kind], ["passthrough"]);
  run.end();
  await host.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("a frozen experiment with an audience stops only the runs in that audience", async () => {
  const plane = new FakeControlPlane(scope);
  const base = plane.slot({ tag: "support.reply", text: "Base" });
  const candidate = plane.slot({ tag: "support.reply", text: "Candidate", versionId: "ver_candidate" });
  const audienceId = "aud_AAAAAAAAAAAAAAAAAAAAAA";
  const selector = { mode: "when", when: { key: "region", is: "west" } };
  plane.promote([base], {
    experiments: [{ tag: "support.reply", experimentId: "exp_1", salt: "AAECAwQFBgcICQoLDA0ODw", subjectKey: "request", audience: { audienceId, selector }, arms: [{ arm: "control", weightBps: 5000, releaseDigest: releaseDigest([base]), overrides: [] }, { arm: "candidate", weightBps: 5000, releaseDigest: releaseDigest([candidate]), overrides: [{ ...candidate, requires: [FUTURE] }] }] }] as never,
    observations: [{ audienceId, selector, tag: "support.reply", observeFrom: "2026-01-01T00:00:00Z" }] as never,
    directives: ["control", "candidate"].map((arm) => ({ kind: "disable" as const, scope: "arm" as const, arm, experimentId: "exp_1", issuedAt: "2026-09-12T10:00:00Z" })),
  });
  const ap = await start(plane, tempDir());
  ap.setTags({ region: "east" });
  assert.equal(ap.prompt("support.reply").render({}).text, "Base", "outside the audience");
  assert.throws(() => ap.prompt("support.reply", { tags: { region: "west" } }).render({}), RenderRefusedError, "inside it");
  await ap.stop();
});

test("a stranded own-tag override sits out before assignment: no run takes a label, control included", async () => {
  const plane = new FakeControlPlane(scope);
  const base = plane.slot({ tag: "support.reply", text: "Base" });
  const candidate = plane.slot({ tag: "support.reply", text: "Candidate", versionId: "ver_candidate" });
  const experiment = { tag: "support.reply", experimentId: "exp_1", salt: "AAECAwQFBgcICQoLDA0ODw", subjectKey: "request" as const, arms: [{ arm: "control", weightBps: 9000, releaseDigest: releaseDigest([base]), overrides: [] }, { arm: "candidate", weightBps: 1000, releaseDigest: releaseDigest([candidate]), overrides: [{ ...candidate, requires: [FUTURE] }] }] };
  plane.promote([base], { experiments: [experiment] as never });
  const dir = tempDir();
  await (await start(plane, dir, { runRefSecret: "s" })).stop();
  await gaining(async () => {
    const ap = await start(plane, dir, { fetch: noNetwork, runRefSecret: "s" });
    try {
      const key = Buffer.from(runRefKeyFrom("s", scope.agentId, scope.target));
      for (let i = 0; i < 40; i += 1) {
        const rendered = ap.prompt("support.reply", { subject: `u${i}` }).render({});
        const entry = parseRunRef(rendered.runRef, key)?.entries[0];
        assert.deepEqual([rendered.text, rendered.arm, entry?.arm, entry?.bucket], ["Base", "none", "none", null], `u${i}`);
      }
    } finally {
      await ap.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("an unknown subject key: the host sits the experiment out and never hashes by run", async () => {
  const plane = new FakeControlPlane(scope);
  const base = plane.slot({ tag: "support.reply", text: "Base" });
  const candidate = plane.slot({ tag: "support.reply", text: "Candidate", versionId: "ver_candidate" });
  plane.promote([base], { experiments: [{ tag: "support.reply", experimentId: "exp_1", salt: "AAECAwQFBgcICQoLDA0ODw", subjectKey: "later_key", arms: [{ arm: "control", weightBps: 0, releaseDigest: releaseDigest([base]), overrides: [] }, { arm: "candidate", weightBps: 10000, releaseDigest: releaseDigest([candidate]), overrides: [candidate] }] }] as never });
  const ap = await start(plane, tempDir());
  const rendered = ap.prompt("support.reply", { subject: "u1" }).render({});
  assert.deepEqual([rendered.text, rendered.arm], ["Base", "none"]);
  await ap.stop();
});

test("an outage does not use a stranded host's one try: only an answered miss does", async () => {
  const plane = new FakeControlPlane(scope);
  const { base, future } = release(plane);
  plane.promote([base, future]);
  const dir = tempDir();
  await (await start(plane, dir)).stop();
  await gaining(async () => {
    const real = plane.fetch();
    let down = true;
    const fetch: typeof real = async (url, init) => {
      if (down && String(url).includes(future.contentHash)) throw new Error("ECONNRESET");
      return real(url, init);
    };
    const ap = await start(plane, dir, { fetch });
    try {
      await ap.syncNow();
      await ap.syncNow();
      assert.throws(() => ap.prompt("support.future").render({}), /no slot support\.future/);
      down = false;
      await ap.syncNow();
      assert.equal(ap.prompt("support.future").render({}).text, "From the future.");
    } finally {
      await ap.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a telemetry failure never replaces what the caller is doing, on any path that writes a row", async () => {
  const plane = new FakeControlPlane(scope);
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply to {{name}}", variables: [{ name: "name", required: true, trust: "operator" }] })]);
  const events: Record<string, unknown>[] = [];
  const ap = await start(plane, tempDir(), { logger: (event) => events.push(event) });
  (ap as unknown as { spool: { observe: () => void } }).spool.observe = () => {
    throw new Error("disk full");
  };
  assert.throws(() => ap.prompt("support.reply").render({}), (error: unknown) => (error as Error).name === "MissingVariableError", "the caller's error stays the caller's");
  assert.equal(events.filter((event) => event.event === "observation_dropped").length, 1);
  ap.variables.provide("name", { resolve: async () => { throw new Error("source down"); }, trust: "operator" });
  await assert.rejects(ap.prompt("support.reply").renderAsync({}), (error: unknown) => (error as Error).message !== "disk full", "a failed source stays that failure");
  ap.variables.revoke("name");
  const run = ap.openRun({ variables: { name: "a" } });
  assert.equal((await run.place("support.reply")).kind, "approved");
  run.recordModelCall("support.reply", { usage: { input: 1, cachedInput: 0, output: 1, source: "reported" } } as never);
  const before = events.filter((event) => event.event === "observation_dropped").length;
  assert.doesNotThrow(() => run.end(), "a run ends without telemetry");
  assert.equal(events.filter((event) => event.event === "observation_dropped").length, before + 1);
  await ap.stop();
});

test("an audience this reader cannot read: the manifest loads, the run takes arm none, no cohort is captured, a disable stands", async () => {
  const plane = new FakeControlPlane(scope);
  const base = plane.slot({ tag: "support.reply", text: "Base" });
  const other = plane.slot({ tag: "support.other", text: "Other" });
  const candidate = plane.slot({ tag: "support.reply", text: "Candidate", versionId: "ver_candidate" });
  const audienceId = "aud_AAAAAAAAAAAAAAAAAAAAAA";
  const selector = { mode: "when", when: { not: { key: "region", later: "west" } } };
  plane.promote([base, other], {
    experiments: [{ tag: "support.reply", experimentId: "exp_1", salt: "AAECAwQFBgcICQoLDA0ODw", subjectKey: "request", audience: { audienceId, selector }, arms: [{ arm: "control", weightBps: 0, releaseDigest: releaseDigest([base, other]), overrides: [] }, { arm: "candidate", weightBps: 10000, releaseDigest: releaseDigest([candidate, other]), overrides: [candidate] }] }] as never,
    observations: [{ audienceId, selector, tag: "support.reply", observeFrom: "2026-01-01T00:00:00Z" }] as never,
    directives: [{ kind: "disable", scope: "slot", tag: "support.other", issuedAt: "2026-09-12T10:00:00Z" }],
  });
  const dir = tempDir();
  const ap = await start(plane, dir, { tags: { region: "east" } } as never);
  try {
    assert.equal(ap.generation, 1, "unknown is not malformed");
    const rendered = ap.prompt("support.reply", { subject: "u1" }).render({});
    assert.deepEqual([rendered.text, rendered.arm], ["Base", "none"]);
    assert.equal(rendered.audienceIds?.length ?? 0, 0, "no cohort");
    assert.throws(() => ap.prompt("support.other").render({}), RenderRefusedError);
  } finally {
    await ap.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a store holding a major-2 manifest at generation 1 upgrades to the 3.0.0 manifest of the same generation", async () => {
  const plane = new FakeControlPlane(scope);
  const slot = plane.slot({ tag: "support.reply", text: "Reply politely." });
  const manifest = plane.promote([slot]);
  const dir = tempDir();
  const store = await SlotStore.open({ stateDir: dir, ...scope, keyProvider: fileKey(join(SlotStore.path({ stateDir: dir, ...scope }), "store.key")) });
  const older: Manifest = { ...manifest, payload: { ...manifest.payload, protocol: "2.9.0" } };
  store.stage({ manifest: older, payloads: new Map(plane.payloads) });
  store.activate();
  assert.equal(store.state.generation, 1);
  const ap = await start(plane, dir);
  try {
    assert.equal(ap.generation, 1);
    assert.equal(ap.prompt("support.reply").render({}).text, "Reply politely.");
    assert.equal(ap.status().applyState, "active");
  } finally {
    await ap.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("arms of a shape this reader cannot read do not throw in the conflict check", () => {
  const payload = { slots: [{ tag: "a" }], directives: [], experiments: [{ tag: "a", experimentId: "exp_1", arms: 5 }] };
  assert.equal(experimentConflict(payload as never), null);
});

test("a target that is not a slug never reaches the filesystem, in either start", async () => {
  const dir = tempDir();
  for (const agentId of ["../../escape", "a/b", "", ".hidden", "a".repeat(129), undefined]) {
    await assert.rejects(AirPrompterAgent.start({ ...scope, agentId: agentId as string, stateDir: dir, root: { pinned: publicJwkOf(new FakeControlPlane(scope).rootKey) }, fetch: noNetwork }), (error: unknown) => error instanceof AgentStartError && error.code === "invalid_options", String(agentId));
    await assert.rejects(ManagedAgent.start({ agentId: agentId as string, target: "prod", apiKey: "apr_run_key", baseUrl: "https://run.example", fetch: noNetwork as never }), (error: unknown) => error instanceof ManagedRunError && error.code === "invalid_options", String(agentId));
  }
  for (const target of ["../../escape", "Prod", "", "a".repeat(33), "with/slash"]) {
    await assert.rejects(AirPrompterAgent.start({ ...scope, target: target as "prod", stateDir: dir, root: { pinned: publicJwkOf(new FakeControlPlane(scope).rootKey) }, fetch: noNetwork }), (error: unknown) => error instanceof AgentStartError && error.code === "invalid_options", target);
    await assert.rejects(ManagedAgent.start({ agentId: "agent-1", target: target as "prod", apiKey: "apr_run_key", baseUrl: "https://run.example", fetch: noNetwork as never }), (error: unknown) => error instanceof ManagedRunError && error.code === "invalid_options", target);
  }
  assert.deepEqual(readdirSync(dir), [], "nothing was written");
  rmSync(dir, { recursive: true, force: true });
});

test("telemetry never replaces a model result: a failed record is logged and the result returned; a provider's error stays the provider's", async () => {
  const events: Record<string, unknown>[] = [];
  const target = { tag: "a.b", artifactId: "prm_1", versionId: "v1", arm: "none", model: "m" };
  const broken = () => { throw new Error("disk full"); };
  assert.equal(await observeCall(target, async () => "the answer", broken, { log: (event) => events.push(event) }), "the answer");
  assert.equal(events.length, 1, "logged once");
  const provider = new Error("rate limited");
  await assert.rejects(observeCall(target, async () => { throw provider; }, broken), (error: unknown) => error === provider);
  const plane = new FakeControlPlane(scope);
  plane.promote([plane.slot({ tag: "support.reply", text: "Hi" })]);
  const dir = tempDir();
  const logged: Record<string, unknown>[] = [];
  const ap = await start(plane, dir, { logger: (event) => logged.push(event) });
  try {
    const bad = { tag: "support.reply", artifactId: "prm 1 not valid", versionId: "v", arm: "none", model: "m", status: "ok", latencyMs: 1 } as never;
    assert.doesNotThrow(() => ap.report(bad), "report logs and drops");
    assert.equal(ap.feedback(undefined as never, { thumbs: "up" }), false, "no token, no feedback");
    assert.equal(logged.some((event) => event.event === "observation_dropped"), true, JSON.stringify(logged.map((event) => event.event)));
  } finally {
    await ap.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
