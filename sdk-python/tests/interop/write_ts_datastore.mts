/**
 * Cross-language interop fixture (T40): the TypeScript SDK's puller writes three sealed releases and a fleet
 * rollback through a TypeScript `KvStore` — a directory, or a live Postgres / Redis / S3 through the TypeScript
 * adapter — and prints what the Python SDK, reading through ITS adapter for the same backend, must hydrate. Run from
 * sdk-typescript (where tsx and the client libraries are installed):
 *
 *   node --import tsx ../sdk-python/tests/interop/write_ts_datastore.mts file:<dir> | redis:<url> | postgres:<url> | s3:<endpoint>|<bucket>  <prefix>
 */

import { createRequire } from "node:module";

import { generateX25519KeyPair } from "../../../sdk-typescript/packages/core/src/bundle/hpke.js";
import { SyncClient } from "../../../sdk-typescript/packages/core/src/control/client.js";
import { publicJwkOf, trustedRootFromPinnedKey } from "../../../sdk-typescript/packages/core/src/protocol/trust.js";
import { fsKvStore, type KvStore } from "../../../sdk-typescript/packages/sync/src/store/kvStore.js";
import { kvReleaseDatastore, rollbackDatastore } from "../../../sdk-typescript/packages/sync/src/store/releaseDatastore.js";
import { pullToDatastore } from "../../../sdk-typescript/packages/sync/src/sync/pullToDatastore.js";
import { postgresKvStore } from "../../../sdk-typescript/packages/datastore-postgres/src/index.js";
import { fromNodeRedis, redisKvStore } from "../../../sdk-typescript/packages/datastore-redis/src/index.js";
import { s3KvStore } from "../../../sdk-typescript/packages/datastore-s3/src/index.js";
import { FakeControlPlane } from "../../../sdk-typescript/test/helpers/controlPlane.js";

// The client libraries are the TypeScript workspace's dev dependencies: resolve them from there, not from this file.
const fromTs = createRequire(new URL("../../../sdk-typescript/package.json", import.meta.url));
const pg = fromTs("pg") as typeof import("pg");
const { createClient } = fromTs("redis") as typeof import("redis");
const { CreateBucketCommand, S3Client } = fromTs("@aws-sdk/client-s3") as typeof import("@aws-sdk/client-s3");

const [target, prefix] = process.argv.slice(2);
if (!target || !prefix) throw new Error("usage: write_ts_datastore.mts <backend> <prefix>");
const [kind, ...rest] = target.split(":");
const spec = rest.join(":");
const closers: Array<() => Promise<unknown>> = [];

async function kvFor(): Promise<KvStore> {
  if (kind === "file") return fsKvStore(spec);
  if (kind === "postgres") {
    const pool = new pg.Pool({ connectionString: spec });
    closers.push(() => pool.end());
    const kv = postgresKvStore({ client: pool, table: "ap_kv_interop" });
    await kv.ensureSchema();
    return kv;
  }
  if (kind === "redis") {
    const client = await createClient({ url: spec }).connect();
    closers.push(() => client.quit());
    return redisKvStore({ command: fromNodeRedis(client), namespace: "ap-interop" });
  }
  if (kind === "s3") {
    const [endpoint, bucket] = spec.split("|");
    const client = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test" } });
    await client.send(new CreateBucketCommand({ Bucket: bucket! })).catch(() => undefined);
    closers.push(async () => client.destroy());
    return s3KvStore({ client, bucket: bucket! });
  }
  throw new Error(`unknown backend ${kind}`);
}

const scope = { organizationId: "org_1", agentId: "agt_1", target: "prod" as const };
const kv = await kvFor();
const datastore = kvReleaseDatastore(kv, { prefix });
const plane = new FakeControlPlane(scope);
const fleet = generateX25519KeyPair();
const client = new SyncClient({ baseUrl: "https://api.test", agentId: scope.agentId, target: scope.target, apiKey: plane.apiKey, fetch: plane.fetch() });
const trustedRoot = trustedRootFromPinnedKey({ purpose: "platform", environment: "prod", pinnedRoot: publicJwkOf(plane.rootKey) });
const fetchRoot = async () => JSON.parse(await (await plane.fetch()("https://edge.test/roots/prod/root.json", {})).text());
for (const text of ["v1 from typescript", "v2 from typescript", "v3 from typescript"]) {
  plane.promote([plane.slot({ tag: "support.reply", text, versionId: `ver_${text.slice(0, 2)}` })]);
  const pulled = await pullToDatastore({ datastore, client, scope, trustedRoot, fetchRoot, now: () => new Date().toISOString(), distributionPublicKey: fleet.publicRaw });
  if (pulled.status !== "ok") throw new Error(JSON.stringify(pulled));
}
const rolled = await rollbackDatastore({ datastore, key: { ...scope, region: null }, reason: "written by typescript", setBy: "interop" });
if (!rolled.ok) throw new Error(JSON.stringify(rolled));
for (const close of closers) await close();
process.stdout.write(
  JSON.stringify({
    pinnedRoot: publicJwkOf(plane.rootKey),
    // The raw 32-byte X25519 private key (the JWK's `d`), which the Python SDK loads with x25519_private_key_from_raw.
    distributionPrivateKey: (fleet.privateKey.export({ format: "jwk" }) as { d: string }).d,
    distributionPublicKey: fleet.publicRaw.toString("base64url"),
    generation: 2,
    heldBackBelow: 3,
    text: "v2 from typescript",
  }),
);
