/**
 * T40: the three datastore adapters. Against live backends — Postgres (`AIRPROMPTER_TEST_POSTGRES_URL`), Redis
 * (`AIRPROMPTER_TEST_REDIS_URL`, through both `redis` and `ioredis`) and S3 (`AIRPROMPTER_TEST_S3_ENDPOINT`, e.g. MinIO
 * or moto) — each keeps the `KvStore` contract (`checkKvStore`: conditional writes, exact prefixes, racing writers),
 * stores the shared records byte for byte, and carries a release from the puller to a runtime that hydrates from it
 * and rolls back through it. Without a backend configured those suites skip and say so; the unit tests below them
 * (SQL shape, error mapping) always run.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";
import { createClient } from "redis";
import { Redis as IORedis } from "ioredis";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";

import { postgresKvStore, postgresKvSchema } from "../packages/datastore-postgres/src/index.js";
import { fromIoRedis, fromNodeRedis, redisKvStore } from "../packages/datastore-redis/src/index.js";
import { s3KvStore } from "../packages/datastore-s3/src/index.js";
import { checkKvStore, type KvStore } from "../packages/sync/src/store/kvStore.js";
import { kvReleaseDatastore, rollbackDatastore, type ReleaseKey } from "../packages/sync/src/store/releaseDatastore.js";
import { datastoreKeys, decodeDatastoreRecord } from "../packages/sync/src/store/datastoreRecords.js";
import { pullToDatastore } from "../packages/sync/src/sync/pullToDatastore.js";
import { AirPrompterAgent } from "../packages/sdk/src/agent.js";
import { generateX25519KeyPair } from "../packages/core/src/bundle/hpke.js";
import { SyncClient } from "../packages/core/src/control/client.js";
import { publicJwkOf, trustedRootFromPinnedKey } from "../packages/core/src/protocol/trust.js";
import { FakeControlPlane } from "./helpers/controlPlane.js";

const scope: { organizationId: string; agentId: string; target: "dev" | "staging" | "prod" } = { organizationId: "org_1", agentId: "agt_1", target: "prod" };

/** The fleet over one KvStore: pull three releases, boot a runtime on the rows, roll the fleet back, and read the raw records. */
async function fleetOver(kv: KvStore, prefix: string): Promise<void> {
  const datastore = kvReleaseDatastore(kv, { prefix });
  const plane = new FakeControlPlane(scope);
  const fleet = generateX25519KeyPair();
  const client = new SyncClient({ baseUrl: "https://api.test", agentId: scope.agentId, target: scope.target, apiKey: plane.apiKey, fetch: plane.fetch() });
  const trustedRoot = trustedRootFromPinnedKey({ purpose: "platform", environment: "prod", pinnedRoot: publicJwkOf(plane.rootKey) });
  const fetchRoot = async () => JSON.parse(await (await plane.fetch()("https://edge.test/roots/prod/root.json", {})).text());
  for (const text of ["v1", "v2", "v3"]) {
    plane.promote([plane.slot({ tag: "support.reply", text, versionId: `ver_${text}` })]);
    const pulled = await pullToDatastore({ datastore, client, scope, trustedRoot, fetchRoot, now: () => new Date().toISOString(), distributionPublicKey: fleet.publicRaw });
    assert.equal(pulled.status, "ok", JSON.stringify(pulled));
  }
  const key: ReleaseKey = { ...scope, region: null };
  const keys = datastoreKeys(prefix, key);
  // The shared records, as any other SDK would read them.
  assert.equal(decodeDatastoreRecord((await kv.get(keys.latest))!.value, "latest").generation, 3);
  assert.equal(decodeDatastoreRecord((await kv.get(keys.release(2)))!.value, "release", 2).generation, 2);
  assert.ok(decodeDatastoreRecord((await kv.get(keys.edge))!.value, "edge").lastOriginAt);

  const dir = mkdtempSync(join(tmpdir(), "ap-adapter-"));
  try {
    const ap = await AirPrompterAgent.start({ ...scope, stateDir: dir, root: { pinned: publicJwkOf(plane.rootKey) }, fetch: async () => { throw new Error("offline"); }, distributionKey: { privateKey: fleet.privateKey, publicRaw: fleet.publicRaw }, datastore: { store: datastore } });
    assert.equal(ap.generation, 3);
    assert.equal((await rollbackDatastore({ datastore, key, reason: "adapter test" })).ok, true);
    assert.deepEqual(await ap.hydrate(), { outcome: "rolled_back", generation: 2, heldBackBelow: 3 });
    assert.equal(ap.prompt("support.reply").render({}).text, "v2");
    await ap.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const name of await kv.list(prefix)) await kv.delete(name);
}

const run = `run-${Date.now().toString(36)}`;

const postgresUrl = process.env.AIRPROMPTER_TEST_POSTGRES_URL;
test("postgres: the KvStore contract and the fleet, on a live database", { skip: postgresUrl ? false : "AIRPROMPTER_TEST_POSTGRES_URL is not set" }, async () => {
  const pool = new pg.Pool({ connectionString: postgresUrl, max: 12 });
  try {
    const kv = postgresKvStore({ client: pool, table: `ap_kv_test_${process.pid}` });
    await kv.ensureSchema();
    await kv.ensureSchema(); // idempotent
    const report = await checkKvStore(kv, { racers: 12 });
    assert.deepEqual(report.failures, []);
    await fleetOver(kv, `${run}/`);
    await pool.query(`DROP TABLE ${kv.table}`);
  } finally {
    await pool.end();
  }
});

const redisUrl = process.env.AIRPROMPTER_TEST_REDIS_URL;
test("redis: the KvStore contract and the fleet, through node-redis and ioredis", { skip: redisUrl ? false : "AIRPROMPTER_TEST_REDIS_URL is not set" }, async () => {
  const nodeRedis = await createClient({ url: redisUrl! }).connect();
  const ioredis = new IORedis(redisUrl!);
  try {
    for (const [name, command] of [["node-redis", fromNodeRedis(nodeRedis)], ["ioredis", fromIoRedis(ioredis)]] as const) {
      const kv = redisKvStore({ command, namespace: `ap-test-${name}-${process.pid}`, listBatch: 3 }); // a small batch pages the index
      const report = await checkKvStore(kv, { racers: 12 });
      assert.deepEqual(report.failures, [], name);
      await fleetOver(kv, `${run}-${name}/`);
    }
    // Both clients read one namespace the same way.
    const writer = redisKvStore({ command: fromNodeRedis(nodeRedis), namespace: `ap-test-shared-${process.pid}` });
    const reader = redisKvStore({ command: fromIoRedis(ioredis), namespace: `ap-test-shared-${process.pid}` });
    await writer.put("k.json", '{"a":"é"}', { ifAbsent: true });
    assert.equal((await reader.get("k.json"))!.value, '{"a":"é"}');
    await reader.delete("k.json");
  } finally {
    await nodeRedis.quit();
    ioredis.disconnect();
  }
});

const s3Endpoint = process.env.AIRPROMPTER_TEST_S3_ENDPOINT;
test("s3: the KvStore contract and the fleet, on a live endpoint with conditional writes", { skip: s3Endpoint ? false : "AIRPROMPTER_TEST_S3_ENDPOINT is not set" }, async () => {
  const client = new S3Client({ endpoint: s3Endpoint!, region: process.env.AWS_REGION ?? "us-east-1", forcePathStyle: true, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test" } });
  const bucket = process.env.AIRPROMPTER_TEST_S3_BUCKET ?? `ap-kv-test-${process.pid}`;
  await client.send(new CreateBucketCommand({ Bucket: bucket })).catch(() => undefined);
  const kv = s3KvStore({ client, bucket, keyPrefix: `${run}/` });
  const report = await checkKvStore(kv, { racers: 8 });
  assert.deepEqual(report.failures, []);
  await fleetOver(kv, "fleet/");
  client.destroy();
});

// ----------------------------------------------------------------------------- always: no backend needed

test("postgres: the SQL is parameterised, LIKE escapes its wildcards, and a table name is checked before it is quoted", async () => {
  const calls: Array<{ text: string; values: unknown[] | undefined }> = [];
  const kv = postgresKvStore({ client: { query: async (text, values) => (calls.push({ text, values }), { rows: [], rowCount: 0 }) }, table: "ops.releases" });
  await kv.list("a_b%c\\/");
  assert.match(calls[0]!.text, /FROM "ops"\."releases" WHERE key LIKE \$1 ESCAPE '\\'/);
  assert.deepEqual(calls[0]!.values, ["a\\_b\\%c\\\\/%"]);
  assert.equal(await kv.put("k", "v", { ifVersion: "1; DROP TABLE x" }), false, "a version this adapter never issued never reaches SQL");
  assert.equal(calls.length, 1);
  assert.throws(() => postgresKvStore({ client: { query: async () => ({ rows: [], rowCount: 0 }) }, table: 'x"; DROP TABLE y; --' }), /not a table name/);
  assert.match(postgresKvSchema(), /CREATE TABLE IF NOT EXISTS "airprompter_kv"[\s\S]*text_pattern_ops/);
});

test("s3: a lost conditional write is false, a missing object is null, anything else is thrown", async () => {
  const failWith = (name: string, status: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
  const answers: unknown[] = [];
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const kv = s3KvStore({ client: client as never, bucket: "b", keyPrefix: "p/" });
  answers.push(failWith("PreconditionFailed", 412));
  assert.equal(await kv.put("k", "v", { ifAbsent: true }), false);
  assert.equal(sent[0]!.input.IfNoneMatch, "*");
  assert.equal(sent[0]!.input.Key, "p/k");
  answers.push(failWith("ConditionalRequestConflict", 409));
  assert.equal(await kv.put("k", "v", { ifVersion: '"e1"' }), false);
  assert.equal(sent[1]!.input.IfMatch, '"e1"');
  answers.push(failWith("NoSuchKey", 404));
  assert.equal(await kv.get("k"), null);
  answers.push(failWith("AccessDenied", 403));
  await assert.rejects(kv.get("k"), /AccessDenied/);
  answers.push({ Contents: [{ Key: "p/a/1" }], IsTruncated: true, NextContinuationToken: "t" }, { Contents: [{ Key: "p/a/2" }], IsTruncated: false });
  assert.deepEqual(await kv.list("a/"), ["a/1", "a/2"]);
  assert.equal(sent.at(-1)!.input.ContinuationToken, "t");
});

test("redis: every key carries one hash tag, and a namespace is checked", async () => {
  const sent: string[][] = [];
  const kv = redisKvStore({ command: async (args) => (sent.push(args), args[0] === "HMGET" ? [null, null] : 1), namespace: "acme" });
  await kv.get("x/y.json");
  await kv.put("x/y.json", "{}", { ifAbsent: true });
  assert.equal(sent[0]![1], "{acme}:v:x/y.json");
  assert.deepEqual(sent[1]!.slice(3, 5), ["{acme}:v:x/y.json", "{acme}:index"], "one slot in a cluster");
  assert.throws(() => redisKvStore({ command: async () => null, namespace: "a b" }), /not a namespace/);
});
