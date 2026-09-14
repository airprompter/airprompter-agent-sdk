/**
 * S8 (AIR-1976): store.json joins the protocol with an N/N-1 rule.
 *
 * The daemon binary writes store.json and the application's SDK reads it,
 * and they deploy on different days. A reader at format N accepts N and
 * N-1, writes N, migrates an N-1 file forward on its first write — never on
 * open, so a writer rolled back before its first write still finds the file
 * it can read — and refuses N+1 with `store_newer` naming the writer. The
 * protocol's examples (`protocol/examples/store.v1.json`, `store.v2.json`)
 * are the files a reader meets; this suite opens them.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent, AgentStartError, SDK_VERSION } from "../packages/sdk/src/agent.js";
import { publicJwkOf } from "../packages/core/src/protocol/trust.js";
import { fileKey } from "../packages/sync/src/store/keyProvider.js";
import { isStoreError, SlotStore, STORE_FORMAT_VERSION, STORE_FORMATS_READ } from "../packages/sync/src/store/slotStore.js";
import { FakeControlPlane } from "../packages/core/src/testing/index.js";

const scope = { organizationId: "org_1", agentId: "agt_store", target: "prod" as const };
const example = (name: string) => JSON.parse(readFileSync(new URL(`../../protocol/examples/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;

/** A store.json in the given format, wrapping a real DEK under a real file key so the store opens. */
async function writeStore(stateDir: string, shape: Record<string, unknown>): Promise<{ dir: string; keyProvider: ReturnType<typeof fileKey> }> {
  const dir = SlotStore.path({ stateDir, ...scope });
  mkdirSync(join(dir, "slots", "A", "payloads"), { recursive: true });
  const keyProvider = fileKey(join(dir, "store.key"));
  const dek = Buffer.alloc(32, 7);
  const wrapped = await keyProvider.wrap(dek);
  writeFileSync(join(dir, "store.json"), JSON.stringify({ ...shape, agentId: scope.agentId, target: scope.target, wrappedDek: Buffer.from(wrapped).toString("base64url"), storageProtection: keyProvider.storageProtection, root: null }, null, 2));
  return { dir, keyProvider };
}

test("N-1 is read: a format-1 store.json (what 0.2.5 wrote) opens, is not rewritten on open, and migrates forward to format 2 with the writer on its first write", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-storefmt-"));
  const v1 = example("store.v1.json");
  const { dir, keyProvider } = await writeStore(stateDir, { ...v1, active: null, staged: null, generation: 0 });
  const store = await SlotStore.open({ stateDir, ...scope, keyProvider });
  assert.equal(store.state.version, 1, "read as it was written");
  assert.equal(store.state.writer, undefined);
  assert.equal(store.state.applyPolicyPin, undefined, "the v2 field is simply absent on an N-1 file");
  assert.equal((JSON.parse(readFileSync(join(dir, "store.json"), "utf8")) as { version: number }).version, 1, "opening never rewrites: the rollback window");
  // The first write migrates forward: format 2, and the writer named.
  store.pinApplyPolicy({ value: "unlock_required", source: "manifest", generation: 1, setAt: "2026-09-13T12:00:00.000Z" });
  const written = JSON.parse(readFileSync(join(dir, "store.json"), "utf8")) as { version: number; writer: { name: string; version: string }; applyPolicyPin: { value: string }; instanceId: string };
  assert.equal(written.version, STORE_FORMAT_VERSION);
  assert.deepEqual(written.writer, { name: "agent-sdk-typescript", version: SDK_VERSION });
  assert.equal(written.applyPolicyPin.value, "unlock_required");
  assert.equal(written.instanceId, v1.instanceId, "everything the N-1 file said is kept");
  // A writer that names itself (the daemon) is recorded as such.
  const daemon = await SlotStore.open({ stateDir, ...scope, keyProvider, hooks: { writer: { name: "airprompterd", version: "0.1.0" } } });
  daemon.pinApplyPolicy({ value: "auto", source: "operator", generation: 1, setAt: "2026-09-13T12:01:00.000Z" });
  assert.deepEqual((JSON.parse(readFileSync(join(dir, "store.json"), "utf8")) as { writer: unknown }).writer, { name: "airprompterd", version: "0.1.0" });
  rmSync(stateDir, { recursive: true, force: true });
});

test("N is read as written: the format-2 example opens with its writer and pin; a fresh store is written at format 2", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-storefmt-"));
  const v2 = example("store.v2.json");
  const { keyProvider } = await writeStore(stateDir, { ...v2, active: null, staged: null, generation: 0 });
  const store = await SlotStore.open({ stateDir, ...scope, keyProvider });
  assert.equal(store.state.version, 2);
  assert.deepEqual(store.state.writer, { name: "airprompterd", version: "0.1.0" });
  assert.deepEqual(store.state.applyPolicyPin, { value: "unlock_required", source: "manifest", generation: 41, setAt: "2026-09-12T10:03:00Z" });
  rmSync(stateDir, { recursive: true, force: true });
  const fresh = mkdtempSync(join(tmpdir(), "ap-storefmt-"));
  const created = await SlotStore.open({ stateDir: fresh, ...scope, keyProvider: fileKey(join(SlotStore.path({ stateDir: fresh, ...scope }), "store.key")) });
  assert.equal(created.state.version, STORE_FORMAT_VERSION);
  assert.deepEqual(created.state.writer, { name: "agent-sdk-typescript", version: SDK_VERSION });
  assert.deepEqual([...STORE_FORMATS_READ], [1, 2], "N and N-1");
  rmSync(fresh, { recursive: true, force: true });
});

test("N+1 is refused with store_newer naming the writer — the store, and the runtime's start — never guessed at, never rewritten", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-storefmt-"));
  const v2 = example("store.v2.json");
  const { dir, keyProvider } = await writeStore(stateDir, { ...v2, version: 3, writer: { name: "airprompterd", version: "0.9.0" }, active: null, staged: null, generation: 0, someFutureField: { a: 1 } });
  await assert.rejects(SlotStore.open({ stateDir, ...scope, keyProvider }), (error: unknown) => {
    assert.ok(isStoreError(error));
    assert.equal(error.code, "store_newer");
    assert.equal(error.detail, "airprompterd 0.9.0", "the writer is named");
    assert.match(error.message, /format 3, written by airprompterd 0[.]9[.]0; this runtime reads formats 1 and 2/);
    return true;
  });
  assert.equal((JSON.parse(readFileSync(join(dir, "store.json"), "utf8")) as { version: number }).version, 3, "untouched");
  const plane = new FakeControlPlane(scope);
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply." })]);
  await assert.rejects(AirPrompterAgent.start({ ...scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, fetch: plane.fetch() }), (error: unknown) => error instanceof AgentStartError && error.code === "store_newer" && /airprompterd 0[.]9[.]0/.test(error.message));
  // A file with no writer at all (hand-edited) is still named as unknown, still refused.
  await writeStore(stateDir, { ...v2, version: 3, writer: undefined, active: null, staged: null, generation: 0 });
  await assert.rejects(SlotStore.open({ stateDir, ...scope, keyProvider }), (error: unknown) => isStoreError(error) && error.code === "store_newer" && error.detail === "an unknown writer");
  rmSync(stateDir, { recursive: true, force: true });
});
