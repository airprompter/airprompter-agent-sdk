# @airprompter/datastore-redis

The AirPrompter release datastore over Redis (6.2+) or Valkey: a `KvStore`
for `kvReleaseDatastore` (`@airprompter/agent-sync`). The puller writes
sealed releases through it; every runtime hydrates from it
([docs/datastore.md](https://github.com/airprompter/airprompter-agent-sdk/blob/main/docs/datastore.md)).

```ts
import { createClient } from "redis";
import { kvReleaseDatastore } from "@airprompter/agent-sdk";
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
