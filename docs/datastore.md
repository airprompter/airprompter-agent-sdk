# Your datastore carries the release

The fleet pattern without glue code: hand the SDK a datastore you already
run — an S3 bucket, a Postgres table, a Redis, a directory — and the puller
writes every sealed release into it while every runtime **hydrates** from
it: the release, its dial-up percentages and ramp, the fleet's rollback, and
the region. The SDK opens no connection of its own; the client is yours.

```
AirPrompter ──pull (Agent key)──▶ pullToDatastore ──release, then edge──▶ your datastore
                                                                            │
                           runtimes (no Agent key) ◀──hydrate (verify)──────┘
```

## Pick a backend

Two layers, so any datastore can join:

1. **`KvStore`** — four operations every backend already has: `get` (a value
   and an opaque version), a **conditional** `put` (`ifAbsent`, or
   `ifVersion` — the version last read), `list` by prefix, `delete`. No
   transactions.
2. **`kvReleaseDatastore(kv)`** (`kv_release_datastore`) — the SDK's
   `ReleaseDatastore` over any `KvStore`, in one shared format
   ([`protocol/datastore-format.md`](../protocol/datastore-format.md)): the
   same keys and the same canonical records from every SDK and every
   adapter, so a Python puller and a TypeScript runtime share one bucket.

| Backend | TypeScript | Python | Conditional writes |
|---|---|---|---|
| S3 (and MinIO, R2) | `@airprompter/datastore-s3` → `s3KvStore({ client, bucket })` | `airprompter-datastore-s3` → `s3_kv_store(client=, bucket=)` | `If-None-Match: *`, `If-Match: <ETag>` |
| PostgreSQL 11+ | `@airprompter/datastore-postgres` → `postgresKvStore({ client })` | `airprompter-datastore-postgres` → `postgres_kv_store(connection=)` | `INSERT … ON CONFLICT DO NOTHING`, `UPDATE … WHERE version = $n` |
| Redis 6.2+ / Valkey | `@airprompter/datastore-redis` → `redisKvStore({ command })` | `airprompter-datastore-redis` → `redis_kv_store(client=)` | one Lua `EVAL` per write |
| A directory | `fsKvStore(dir)` (in `agent-sync`) | `FileKvStore(dir)` | single writer per directory |
| Tests | `MemoryKvStore`, `MemoryReleaseDatastore` | the same names | — |

The adapters bundle no client library: pass the `S3Client`, `pg.Pool`,
`redis` / `ioredis` client (TypeScript) or boto3, psycopg / psycopg2, redis-py
client (Python) you already configure.

**Another backend** (DynamoDB, GCS, etcd, Consul, MySQL…) is a `KvStore` of a
few dozen lines. Prove it with the suite this repository runs against every
adapter: `await checkKvStore(kv)` / `check_kv_store(kv)` → `{ ok, failures }`.
It checks conditional writes, exact prefix listing (no `%`, `_`, `*`, `?` or
`[` is a wildcard), non-ASCII and large values, and — what a hand-rolled
adapter gets wrong — racing writers: of N concurrent `ifAbsent` puts, or N
puts on one version, exactly one wins.

Implement `ReleaseDatastore` directly only for a schema of your own (real
columns to query the rollout by); rows written that way are yours alone.

## What a release holds

| Field | What it is |
|---|---|
| `generation` | the signed generation; one record per generation per key, immutable once written |
| `releaseDigest` | the release's digest, for your own queries |
| `bundle` | the `.apbundle` — **ciphertext** to the fleet's distribution key off the dev target, signed end to end |
| `createdAt`, `notAfter` | when it was sealed; how long it stays usable as a fallback |
| `rollout` | a content-free copy of what the signed manifest says: each experiment's arms and base weights (the dial-up percentages), its ramp steps, the apply policy and the `disable` directives — for your dashboards; **never read when serving** |

The datastore is a carrier, never a root of trust: a runtime verifies every
release (root, signatures, scope, every payload's hash) before a byte is
served. The ramp keeps walking on each host's clock exactly as the signed
manifest says, so a release written once still dials up on schedule.

Beside the releases the datastore keeps a `latest.json` pointer (moved
forward only), the puller's **edge state** (the pointer URL and ETags,
[change-notification.md](change-notification.md)) — written **after** the
release it describes, never before, so it can never hide a release that was
not written — and one **control** per key: the rollback in force. A record
from a newer format is refused (`datastore_record_newer`), never served.

`pruneDatastore({ datastore, key, keep })` (`prune_datastore`) deletes all
but the newest `keep` releases, never the one a rollback names.

## The puller

```ts
const result = await pullToDatastore({ datastore, region: "eu-west-1", client, scope, trustedRoot, fetchRoot, now, distributionPublicKey: fleetPublicRaw });
// result.status: "ok" (result.stored: true) | "unchanged" | "nothing_promoted" | "refused" | "unavailable" | "datastore_unavailable"
```

```python
result = pull_to_datastore(datastore=releases, region="eu-west-1", client=client, scope=scope, trusted_root=root,
                           fetch_root=fetch_root, now=now_iso, distribution_public_key=fleet_public_raw)
```

It reads the edge state and the newest generation from the datastore, pulls
(`pullBundle` / `pull_bundle`: an older answer from the control plane is
`generation_rollback`, never a quiet row), and writes the release, then its
edge state. A datastore that cannot be read or written is `datastore_unavailable`
with `stage: "read" | "write"`; nothing is half-written.

## The runtime

```ts
const ap = await AirPrompterAgent.start({ organizationId, agentId, target: "prod", root, distributionKey, datastore: { store: datastore, region: "eu-west-1", pollSeconds: 30 } });
await ap.hydrate(); // on your LISTEN / bus event; → { outcome: "activated" | "staged" | "unchanged" | "rolled_back" | "held_back" | "refused" | "empty" | "unavailable", generation }
ap.status().datastore; // { region, lastHydrateAt, lastOutcome, newestGeneration, rowsFrom: "region" | "global", rollback }
```

```python
ap = AirPrompterAgent.start(..., distribution_key=fleet_key, datastore={"store": releases, "region": "eu-west-1", "poll_seconds": 30})
ap.hydrate()
```

At start the runtime reads its own store first, then hydrates from the
datastore, then the vendored bundle, then (with a key) the network. A
newer row is an update like any `applyBundle`: verified, then the apply
policy decides (`auto` activates, `unlock_required` stages). An **older**
row is never applied on its own — a stale replica or a restored backup
cannot move a host backwards. The datastore being down is `unavailable`:
the host keeps serving what it holds, and a restart serves from its own
store.

## Rollback, fleet-wide

```ts
await rollbackDatastore({ datastore, key: { ...scope, region: null }, reason: "INC-4312" }); // one row down from what serves
await rollbackDatastore({ datastore, key, toGeneration: 41 });
await clearDatastoreRollback({ datastore, key });
```

A control `{ generation, heldBackBelow }` says: serve `generation` while the
newest row is at or below `heldBackBelow` (the newest generation when the
rollback was set). Every runtime that hydrates next steps down — the older
row verified through the whole chain, the step stamped as a forced
downgrade (`forcedDowngrade`, a `forced_downgrade` spool row, `healthz`
degraded) — and holds the newer generations back. It ends when you clear
it, or when a generation **above** `heldBackBelow` is promoted: the fleet
moves past it on its own, as a host-local `rollback()` does.

Two operators at once cannot overwrite each other: the rollback is written
only if the control is still what was read, and the loser gets
`{ ok: false, reason: "conflict" }` — read again and decide.

Who can write the control can move the fleet down to any older release the
datastore holds (still signed, still verified, stamped as a forced
downgrade). Give runtimes read-only access to the datastore; only the puller
and your operators need to write.

With a datastore configured the datastore is the fleet's word on rollback:
a host-local `ap.rollback()` holds until the next hydrate, which releases
the local hold when the datastore names no rollback. Roll the fleet back
through the datastore.

## Regions

Every row and control is keyed by region (`null`: global).

- **Rows** — a region with rows of its own (a regional puller,
  `region: "eu-west-1"`) serves them; a region with none reads the global
  rows. `status().datastore.rowsFrom` says which.
- **Rollback** — a region's own control binds that region; a global control
  binds every region without one of its own. Clearing a region's control
  leaves the global one (if any) in force there.

Regions are the customer's notion, not the protocol's: every region's rows
carry the same signed scope (`organizationId`, `agentId`, `target`), so a
row cannot be relabelled for another target by moving it between keys.
