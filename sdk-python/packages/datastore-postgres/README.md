# airprompter-datastore-postgres

The AirPrompter release datastore over one PostgreSQL table: a `KvStore` for
`kv_release_datastore` (`airprompter-agent-sync`). The puller writes sealed
releases through it; every runtime hydrates from it
([docs/datastore.md](https://github.com/airprompter/airprompter-agent-sdk/blob/main/docs/datastore.md)).
The table is the one `@airprompter/datastore-postgres` uses, so Python and
TypeScript share it.

```python
import psycopg
from airprompter_agent import kv_release_datastore
from airprompter_datastore_postgres import postgres_kv_store

kv = postgres_kv_store(connection=psycopg.connect(os.environ["DATABASE_URL"], autocommit=True))
kv.ensure_schema()   # or postgres_kv_schema() in your migrations
releases = kv_release_datastore(kv)
```

- `connection=` a DB-API connection (psycopg 3 or psycopg2; operations take
  turns on it) or `pool=` a `psycopg_pool.ConnectionPool`.
- `INSERT … ON CONFLICT DO NOTHING` and `UPDATE … WHERE version = %s`: no
  transaction or lock is ever held across calls. Postgres 11+.
- Prove it against your database: `check_kv_store(kv)` → `KvStoreReport(ok, passed, failures)`.
