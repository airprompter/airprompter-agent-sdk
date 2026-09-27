/**
 * T40: the datastore format (`protocol/datastore-format.md`) and the `KvStore` port under it. The layout and the
 * records match the protocol's vectors byte for byte; the memory and filesystem stores pass `checkKvStore`; the
 * KV-backed datastore orders its writes (release → latest → edge), never moves `latest.json` or the edge state
 * backwards, repairs a missing pointer, refuses a newer record, prunes without touching a rollback, and loses a
 * racing rollback instead of overwriting it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkKvStore, fsKvStore, MemoryKvStore } from "../packages/sync/src/store/kvStore.js";
import { datastoreKeys, decodeDatastoreRecord, encodeDatastoreRecord, isDatastoreRecordError, type DatastoreRecord } from "../packages/sync/src/store/datastoreRecords.js";
import { KvReleaseDatastore, rollbackDatastore, pruneDatastore, resolveHydration, type ReleaseKey, type StoredReleaseRow } from "../packages/sync/src/store/releaseDatastore.js";

const vectors = JSON.parse(readFileSync(new URL("../../protocol/vectors/datastore.json", import.meta.url), "utf8")) as {
  keys: Array<{ name: string; prefix: string; key: ReleaseKey; generation: number; expect: Record<string, string> }>;
  records: Array<{ name: string; fields: DatastoreRecord; text: string }>;
  refused: Array<{ name: string; kind: DatastoreRecord["kind"]; text: string; code: string; keyGeneration?: number }>;
};

test("the layout and the records match the protocol's vectors byte for byte; every refusal is refused with its code", () => {
  for (const c of vectors.keys) {
    const keys = datastoreKeys(c.prefix, c.key);
    assert.deepEqual({ releasesPrefix: keys.releasesPrefix, release: keys.release(c.generation), latest: keys.latest, edge: keys.edge, control: keys.control }, c.expect, c.name);
  }
  for (const c of vectors.records) {
    assert.equal(encodeDatastoreRecord(c.fields), c.text, c.name);
    const decoded = decodeDatastoreRecord(c.text, c.fields.kind, c.fields.kind === "release" ? c.fields.generation : undefined);
    assert.deepEqual(decoded, c.fields, c.name);
  }
  for (const c of vectors.refused) {
    assert.throws(() => decodeDatastoreRecord(c.text, c.kind, c.keyGeneration), (error: unknown) => isDatastoreRecordError(error) && error.code === c.code, c.name);
  }
});

test("the memory and filesystem stores keep the KvStore contract", async () => {
  const memory = await checkKvStore(new MemoryKvStore());
  assert.deepEqual(memory.failures, []);
  assert.ok(memory.passed.length >= 15);
  const dir = mkdtempSync(join(tmpdir(), "ap-kv-"));
  try {
    const fs = await checkKvStore(fsKvStore(dir), { globCharacters: process.platform !== "win32" });
    assert.deepEqual(fs.failures, []);
    await assert.rejects(fsKvStore(dir).get("../escape.json"), /not a relative key/, "a key never leaves the directory");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const key: ReleaseKey = { organizationId: "org_1", agentId: "agt_1", target: "prod", region: null };
const row = (generation: number): StoredReleaseRow => ({
  generation,
  releaseDigest: `sha256:${String(generation).padStart(2, "0").repeat(32)}`,
  bundle: JSON.stringify({ format: "apbundle", version: 1, generation }),
  createdAt: "2026-09-20T01:00:00.000Z",
  notAfter: "2026-12-19T01:00:00.000Z",
  rollout: { applyPolicy: "auto", experiments: [], disabled: { agent: false, slots: [], arms: [] } },
});
const edge = (lastOriginAt: string | null, manifestEtag: string | null = null) => ({ pointerUrl: null, pointerEtag: null, manifestEtag, lastOriginAt });

test("the KV datastore writes the shared records in order; latest and the edge state only move forward; a missing pointer is repaired by the listing", async () => {
  const kv = new MemoryKvStore();
  const datastore = new KvReleaseDatastore(kv);
  const keys = datastoreKeys("airprompter/", key);
  await datastore.putRelease(key, row(2));
  await datastore.putRelease(key, row(1)); // a late writer with an older generation
  assert.equal(decodeDatastoreRecord((await kv.get(keys.latest))!.value, "latest").generation, 2, "latest never moves back");
  assert.equal((await datastore.latest(key))!.generation, 2);
  assert.deepEqual(await datastore.generations(key), [2, 1]);
  // The row is the shared record: canonical, with the bundle as a document.
  const stored = (await kv.get(keys.release(2)))!.value;
  assert.equal(stored, encodeDatastoreRecord({ kind: "release", ...row(2), bundle: JSON.parse(row(2).bundle) as Record<string, unknown>, rollout: row(2).rollout as unknown as Record<string, unknown> }));
  // Immutable: a second write of generation 2 changes nothing.
  await datastore.putRelease(key, { ...row(2), releaseDigest: `sha256:${"ff".repeat(32)}` });
  assert.equal((await datastore.get(key, 2))!.releaseDigest, row(2).releaseDigest);

  await datastore.putEdge(key, edge("2026-09-20T02:00:00.000Z", "g2"));
  await datastore.putEdge(key, edge("2026-09-20T01:00:00.000Z", "g1")); // a slower puller's older answer
  assert.equal((await datastore.edge(key))!.manifestEtag, "g2", "the edge state never moves back");

  // A crash between the release and its pointer: the listing finds generation 3.
  await kv.put(keys.release(3), encodeDatastoreRecord({ kind: "release", ...row(3), bundle: JSON.parse(row(3).bundle) as Record<string, unknown>, rollout: row(3).rollout as unknown as Record<string, unknown> }), { ifAbsent: true });
  await kv.delete(keys.latest);
  assert.equal((await datastore.latest(key))!.generation, 3);
});

test("a record from a newer writer is refused, never served; hydration reports it", async () => {
  const kv = new MemoryKvStore();
  const datastore = new KvReleaseDatastore(kv);
  await datastore.putRelease(key, row(1));
  const keys = datastoreKeys("airprompter/", key);
  const latest = (await kv.get(keys.latest))!;
  await kv.put(keys.latest, '{"format":2,"generation":1,"kind":"latest"}', { ifVersion: latest.version });
  await assert.rejects(resolveHydration(datastore, key), (error: unknown) => isDatastoreRecordError(error) && error.code === "datastore_record_newer");
});

test("pruning keeps the newest rows and the one a rollback names; a racing rollback loses instead of overwriting", async () => {
  const datastore = new KvReleaseDatastore(new MemoryKvStore());
  for (const generation of [1, 2, 3, 4, 5]) await datastore.putRelease(key, row(generation));
  const rolled = await rollbackDatastore({ datastore, key, toGeneration: 1 });
  assert.equal(rolled.ok, true);
  assert.equal(await pruneDatastore({ datastore, key, keep: 2 }), 2);
  assert.deepEqual(await datastore.generations(key), [5, 4, 1]);

  // Two operators read the same control; the second write finds it changed.
  const read = await datastore.control(key);
  assert.equal(await datastore.setControl(key, { generation: 4, heldBackBelow: 5, setAt: "2026-09-20T04:00:00.000Z" }, read), true);
  assert.equal(await datastore.setControl(key, { generation: 1, heldBackBelow: 5, setAt: "2026-09-20T04:00:01.000Z" }, read), false);
  assert.equal((await datastore.control(key))!.generation, 4);
  assert.equal(await datastore.setControl(key, null, { generation: 4, heldBackBelow: 5, setAt: "2026-09-20T04:00:00.000Z" }), true);
  assert.equal(await datastore.control(key), null);
});

test("checkKvStore has teeth: a check-then-write adapter loses the race checks, a glob-matching one loses the prefix checks", async () => {
  const inner = new MemoryKvStore();
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  // Reads, yields, then writes unconditionally: the classic hand-rolled adapter.
  const racy = {
    get: (key: string) => inner.get(key),
    list: (prefix: string) => inner.list(prefix),
    delete: (key: string) => inner.delete(key),
    async put(key: string, value: string, condition: { ifAbsent: true } | { ifVersion: string }) {
      const current = await inner.get(key);
      await tick();
      if ("ifAbsent" in condition ? current : current?.version !== condition.ifVersion) return false;
      const now = await inner.get(key);
      return inner.put(key, value, now ? { ifVersion: now.version } : { ifAbsent: true }).then(() => true);
    },
  };
  const racyReport = await checkKvStore(racy);
  assert.ok(racyReport.failures.some((failure) => failure.includes("racing ifAbsent")), racyReport.failures.join("\n"));
  assert.ok(racyReport.failures.some((failure) => failure.includes("racing writes on one version")), racyReport.failures.join("\n"));

  // Treats `_` as a single-character wildcard, as an unescaped SQL LIKE does.
  const globby = {
    get: (key: string) => inner.get(key),
    put: (key: string, value: string, condition: { ifAbsent: true } | { ifVersion: string }) => inner.put(key, value, condition),
    delete: (key: string) => inner.delete(key),
    async list(prefix: string) {
      const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, ".")}`);
      return (await inner.list("")).filter((key) => pattern.test(key));
    },
  };
  const globReport = await checkKvStore(globby);
  assert.ok(globReport.failures.some((failure) => failure.startsWith("list returns exactly the keys under a prefix")), globReport.failures.join("\n"));
});
