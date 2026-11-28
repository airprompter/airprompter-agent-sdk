# @airprompter/datastore-postgres

The AirPrompter release datastore over one PostgreSQL table: a `KvStore`
for `kvReleaseDatastore` (`@airprompter/agent-sdk/sync`). The puller writes
sealed releases through it; every runtime hydrates from it — the release,
its dial-up and ramp, the fleet's rollback, the region
([docs/datastore.md](https://github.com/airprompter/airprompter-agent-sdk/blob/main/docs/datastore.md)).
Rows are in the shared format (`protocol/datastore-format.md`), so a Python
puller and a TypeScript runtime read each other's.

## Install

```bash
npm install --save-exact @airprompter/agent-sdk@1.0.0-rc.5 @airprompter/datastore-postgres@1.0.0-rc.5 pg
```

The SDK is a peer (exactly this version on a release candidate, this version or later within the major
from 1.0.0), so one copy resolves.

<!-- release-candidate -->
This is a release candidate for 1.0.0. Pin it exactly, as above: npm's default
range on a candidate also matches later candidates, and an unpinned install
takes the `latest` tag, the 0.x line.
<!-- /release-candidate -->

## Use

```ts
import pg from "pg";
import { AirPrompterAgent } from "@airprompter/agent-sdk";
import { kvReleaseDatastore } from "@airprompter/agent-sdk/sync";
import { postgresKvStore } from "@airprompter/datastore-postgres";

const kv = postgresKvStore({ client: new pg.Pool({ connectionString: process.env.DATABASE_URL }) });
await kv.ensureSchema(); // or put postgresKvSchema() in your migrations
const ap = await AirPrompterAgent.start({ organizationId, agentId, target: "prod", root, distributionKey, datastore: { store: kvReleaseDatastore(kv), region: "eu-west-1" } });
```

- **No driver bundled.** `client` is anything with `query(text, values)` →
  `{ rows, rowCount }`: a `pg` Pool or Client, `@neondatabase/serverless`,
  your query builder's raw escape hatch.
- **One table** (`airprompter_kv` unless `table: "schema.name"`):
  `key text primary key, value text, version bigint, updated_at`, plus a
  `text_pattern_ops` index for prefix listing. Postgres 11+.
- **Conditional writes in SQL:** `INSERT … ON CONFLICT DO NOTHING`
  (`ifAbsent`), `UPDATE … WHERE version = $n` (`ifVersion`). No transaction
  and no lock is ever held.
- **Checked against a live database** by `checkKvStore` in this repository's
  CI — run it against yours: `await checkKvStore(kv)` → `{ ok, failures }`.
