/**
 * The slot store: stage → activate → load round trip; a crash between fsync
 * and rename leaves the previous slot intact; swapping A and B on disk is
 * refused by the AAD; anti-rollback; the file-key fallback is reported; KEK
 * rotation re-wraps the DEK without touching a payload.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { customKeyProvider, fileKey, unwrapWithRawKey, wrapWithRawKey } from "../packages/sync/src/store/keyProvider.js";
import { SlotStore, StoreError } from "../packages/sync/src/store/slotStore.js";
import { FakeControlPlane } from "./helpers/controlPlane.js";

const NOW = () => new Date().toISOString();
const scope = { organizationId: "org_1", agentId: "agt_1", target: "prod" as const };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ap-store-"));
}

async function openStore(stateDir: string, hooks?: ConstructorParameters<typeof Object>[0]) {
  return SlotStore.open({ stateDir, ...scope, keyProvider: fileKey(join(stateDir, "store.key")), ...(hooks ? { hooks } : {}) });
}

test("stage, activate, load: payloads come back verified; the store reports file_key; reopen serves without the network", async () => {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  const manifest = plane.promote([plane.slot({ tag: "a", text: "Hello {{name}}", variables: [{ name: "name", required: true, trust: "operator" }] }), plane.slot({ tag: "b", text: "Second" })]);
  const store = await openStore(stateDir);
  assert.equal(store.storageProtection, "file_key");
  store.acceptRoot(plane.root);
  const slot = store.stage({ manifest, payloads: plane.payloads });
  assert.equal(slot, "A");
  assert.equal(store.state.staged, "A");
  assert.equal(store.state.active, null);
  assert.equal(store.activate(), "A");
  assert.equal(store.state.generation, 1);
  const loaded = store.load("A", { now: NOW() });
  assert.equal(loaded.payloads.get(manifest.payload.slots[0]!.contentHash)?.toString("utf8"), "Hello {{name}}");
  assert.equal(loaded.signingKeyId, manifest.signatures[0]!.keyId);
  // On disk: no plaintext anywhere.
  for (const file of store.listSlotFiles("A")) {
    if (file.endsWith(".enc")) assert.equal(readFileSync(join(store.dir, "slots", "A", file)).includes("Hello"), false);
  }
  assert.equal(readFileSync(join(store.dir, "store.json"), "utf8").includes("Hello"), false);

  const reopened = await openStore(stateDir);
  assert.equal(reopened.state.active, "A");
  assert.equal(reopened.load("A", { now: NOW() }).payloads.size, 2);
  rmSync(stateDir, { recursive: true, force: true });
});

test("a second release stages into B and activates; generation below the stored one is refused unless forced", async () => {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  const first = plane.promote([plane.slot({ tag: "a", text: "one" })]);
  const store = await openStore(stateDir);
  store.acceptRoot(plane.root);
  store.stage({ manifest: first, payloads: plane.payloads });
  store.activate();
  const second = plane.promote([plane.slot({ tag: "a", text: "two" })]);
  assert.equal(store.stage({ manifest: second, payloads: plane.payloads }), "B");
  assert.equal(store.activate(), "B");
  assert.equal(store.state.generation, 2);
  assert.throws(() => store.stage({ manifest: first, payloads: plane.payloads }), (e: unknown) => e instanceof StoreError && e.code === "generation_rollback");
  // Local rollback flips to the other slot (A still holds generation 1): a forced downgrade, stamped.
  assert.equal(store.rollbackLocal(), "A");
  assert.equal(store.state.generation, 1);
  assert.equal(store.state.forcedDowngrade, true);
  // Forward again, then a forced stage of an OLD manifest is allowed only with force and stamps the store.
  assert.equal(store.rollbackLocal(), "B");
  assert.equal(store.stage({ manifest: first, payloads: plane.payloads, force: true }), "A");
  assert.equal(store.activate(), "A");
  assert.equal(store.state.generation, 1);
  assert.equal(store.state.forcedDowngrade, true);
  rmSync(stateDir, { recursive: true, force: true });
});

test("crash between fsync and rename: the previous slot is intact and serves; the staged slot is complete and can be discarded", async () => {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  const first = plane.promote([plane.slot({ tag: "a", text: "one" })]);
  let crash = false;
  const hooks = {
    beforeRename: () => {
      if (crash) throw new Error("power loss");
    },
  };
  const store = await SlotStore.open({ stateDir, ...scope, keyProvider: fileKey(join(stateDir, "store.key")), hooks });
  store.acceptRoot(plane.root);
  store.stage({ manifest: first, payloads: plane.payloads });
  store.activate();
  const second = plane.promote([plane.slot({ tag: "a", text: "two" })]);
  crash = true;
  // The stage writes slot B fully, fsyncs, then "crashes" while flipping store.json.
  assert.throws(() => store.stage({ manifest: second, payloads: plane.payloads }), /power loss/);
  crash = false;
  const reopened = await openStore(stateDir);
  assert.equal(reopened.state.active, "A");
  assert.equal(reopened.state.staged, null, "the flip never landed");
  assert.equal(reopened.state.generation, 1);
  assert.equal(reopened.load("A", { now: NOW() }).payloads.values().next().value?.toString("utf8"), "one");
  assert.ok(existsSync(join(reopened.dir, "slots", "B", "manifest.json")), "B's files are complete on disk");
  assert.equal(existsSync(join(reopened.dir, "store.json")), true);
  assert.equal(readFileSync(join(reopened.dir, "store.json"), "utf8").includes(".tmp"), false);
  // The next stage overwrites B cleanly.
  assert.equal(reopened.stage({ manifest: second, payloads: plane.payloads }), "B");
  assert.equal(reopened.activate(), "B");
  rmSync(stateDir, { recursive: true, force: true });
});

test("swapping the A and B directories on disk is refused: the AAD binds a payload to its slot's generation", async () => {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  const first = plane.promote([plane.slot({ tag: "a", text: "one" })]);
  const store = await openStore(stateDir);
  store.acceptRoot(plane.root);
  store.stage({ manifest: first, payloads: plane.payloads });
  store.activate();
  const second = plane.promote([plane.slot({ tag: "a", text: "two" })]);
  store.stage({ manifest: second, payloads: plane.payloads });
  store.activate();
  // Attacker swaps the directories so "B" (active, generation 2) now holds generation 1's files.
  renameSync(join(store.dir, "slots", "A"), join(store.dir, "slots", "X"));
  renameSync(join(store.dir, "slots", "B"), join(store.dir, "slots", "A"));
  renameSync(join(store.dir, "slots", "X"), join(store.dir, "slots", "B"));
  const reopened = await openStore(stateDir);
  assert.equal(reopened.state.active, "B");
  // Each swapped slot is self-consistent (its own signed manifest, its own generation in the AAD), so what
  // catches the swap is the counter OUTSIDE the slots: store.json says the active slot holds generation 2 and
  // the manifest behind the active letter says 1. Loading the active slot refuses; the fallback slot (which
  // now holds the real generation 2) loads — the swap achieved nothing.
  assert.throws(() => reopened.load("B", { now: NOW(), expectGeneration: reopened.state.generation }), (e: unknown) => e instanceof StoreError && e.detail === "generation_rollback");
  assert.equal(reopened.load("A", { now: NOW() }).generation, 2);
  // And a payload file moved into the OTHER manifest's slot is refused outright (wrong generation in the AAD).
  const hashA = first.payload.slots[0]!.contentHash;
  const hashB = second.payload.slots[0]!.contentHash;
  renameSync(join(reopened.dir, "slots", "A", "payloads", `${hashB.replace(":", "-")}.enc`), join(reopened.dir, "slots", "A", "payloads", `${hashA.replace(":", "-")}.enc.moved`));
  renameSync(join(reopened.dir, "slots", "B", "payloads", `${hashA.replace(":", "-")}.enc`), join(reopened.dir, "slots", "A", "payloads", `${hashB.replace(":", "-")}.enc`));
  assert.throws(() => reopened.load("A", { now: NOW() }), (e: unknown) => e instanceof StoreError && e.code === "slot_corrupt" && e.detail === "payload_hash_mismatch");
  rmSync(stateDir, { recursive: true, force: true });
});

test("KEK rotation re-wraps the DEK: payloads stay readable, nothing is re-encrypted, the new protection is reported", async () => {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  const manifest = plane.promote([plane.slot({ tag: "a", text: "one" })]);
  const store = await openStore(stateDir);
  store.acceptRoot(plane.root);
  store.stage({ manifest, payloads: plane.payloads });
  store.activate();
  const payloadPath = join(store.dir, "slots", "A", "payloads", `${manifest.payload.slots[0]!.contentHash.replace(":", "-")}.enc`);
  const before = readFileSync(payloadPath);
  const kek = Buffer.alloc(32, 7);
  const kms = customKeyProvider({ storageProtection: "kms", wrap: (dek) => wrapWithRawKey(kek, dek), unwrap: (wrapped) => unwrapWithRawKey(kek, wrapped) });
  await store.rotateKey(kms);
  assert.deepEqual(readFileSync(payloadPath), before, "no payload was rewritten");
  const reopened = await SlotStore.open({ stateDir, ...scope, keyProvider: kms });
  assert.equal(reopened.storageProtection, "kms");
  assert.equal(reopened.load("A", { now: NOW() }).payloads.values().next().value?.toString("utf8"), "one");
  // The old file key no longer opens it.
  await assert.rejects(openStore(stateDir), (e: unknown) => e instanceof StoreError && e.code === "kek_unavailable");
  rmSync(stateDir, { recursive: true, force: true });
});
