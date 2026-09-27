# airprompter-datastore-redis

The AirPrompter release datastore over Redis (6.2+) or Valkey: a `KvStore`
for `kv_release_datastore` (`airprompter-agent-sync`)
([docs/datastore.md](https://github.com/airprompter/airprompter-agent-sdk/blob/main/docs/datastore.md)).
The keys, hashes, index and Lua scripts are `@airprompter/datastore-redis`'s,
so Python and TypeScript share one namespace.

```python
import redis
from airprompter_agent import kv_release_datastore
from airprompter_datastore_redis import redis_kv_store

releases = kv_release_datastore(redis_kv_store(client=redis.Redis.from_url(os.environ["REDIS_URL"])))
```

- `client` is anything with `execute_command(*args)`; bytes or decoded replies both work.
- Each conditional write is one atomic `EVAL`; `list` is an exact range over
  a sorted-set index (never a `SCAN` glob); every key is `{namespace}:…`, one
  cluster slot.
- Durability is Redis's: run with AOF, or accept that a restart loses the
  rows (runtimes keep serving; the next pull writes the release again).
