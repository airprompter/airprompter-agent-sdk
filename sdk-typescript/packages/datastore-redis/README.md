# @airprompter/datastore-redis

The AirPrompter release datastore over Redis (6.2+) or Valkey: a `KvStore`
for `kvReleaseDatastore` (`@airprompter/agent-sdk/sync`). The puller writes
sealed releases through it; every runtime hydrates from it
([docs/datastore.md](https://github.com/airprompter/airprompter-agent-sdk/blob/main/docs/datastore.md)).

## Install

```bash
npm install --save-exact @airprompter/agent-sdk@1.0.0-rc.5 @airprompter/datastore-redis@1.0.0-rc.5 redis
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
import { createClient } from "redis";
import { kvReleaseDatastore } from "@airprompter/agent-sdk/sync";
import { redisKvStore, fromNodeRedis } from "@airprompter/datastore-redis";

const client = await createClient({ url: process.env.REDIS_URL }).connect();
const datastore = kvReleaseDatastore(redisKvStore({ command: fromNodeRedis(client) }));
// ioredis: redisKvStore({ command: fromIoRedis(new Redis(url)) })
```

- **No client bundled.** `command` sends one raw command; `fromNodeRedis`
  and `fromIoRedis` adapt the two common clients.
- **Atomic conditional writes:** each is one `EVAL` of a short Lua script.
  Each key is a hash (`value`, `version`); a sorted set indexes the keys, so
  `list` is an exact lexicographic range — never a `SCAN` glob.
- **Cluster-safe:** every key is `{namespace}:…` (one hash tag, one slot);
  `namespace` defaults to `airprompter`.
- **Durability is Redis's.** Run with AOF, or accept that a restart loses
  the rows: runtimes keep serving from their own stores and the next pull
  writes the release again. A rollback set only in a lost Redis is lost too.
