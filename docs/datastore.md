# Your datastore carries the release

The fleet pattern without glue code: hand the SDK a **`ReleaseDatastore`** —
a small DAO over a datastore you already run (a Postgres table, a DynamoDB
item, a Redis hash, a config service) — and the puller writes every sealed
release through it while every runtime **hydrates** from it: the release,
its dial-up percentages and ramp, the fleet's rollback, and the region.
The SDK opens no connection of its own; the DAO is yours.

```
AirPrompter ──pull (Agent key)──▶ pullToDatastore ──put(row + edge)──▶ your datastore
                                                                          │
                          runtimes (no Agent key) ◀──hydrate (verify)─────┘
```

## What a row holds

| Field | What it is |
|---|---|
| `generation` | the signed generation; one row per generation per key, immutable once written |
| `releaseDigest` | the release's digest, for your own queries |
| `bundle` | the `.apbundle` as JSON text — **ciphertext** to the fleet's distribution key off the dev target, signed end to end |
| `createdAt`, `notAfter` | when it was sealed; how long it stays usable as a fallback |
| `rollout` | a content-free copy of what the signed manifest says: each experiment's arms and base weights (the dial-up percentages), its ramp steps, the apply policy and the `disable` directives — for your dashboards; **never read when serving** |

The datastore is a carrier, never a root of trust: a runtime verifies every
row (root, signatures, scope, every payload's hash) before a byte is served.
The ramp keeps walking on each host's clock exactly as the signed manifest
says, so a row written once still dials up on schedule.

Beside the rows the DAO keeps the puller's **edge state** (the pointer URL
and ETags, [change-notification.md](change-notification.md)) — written in
the **same transaction** as the row, never before it — and one **control**
per key: the rollback in force.

## The DAO

TypeScript (`@airprompter/agent-sync`, async) and Python
(`airprompter_agent_sync`, sync) take the same eight methods:

| Method | Does |
|---|---|
| `latest(key)` | the newest row for exactly this key |
| `get(key, generation)` | one row |
| `generations(key)` | every generation held, newest first |
| `put(key, row, edge)` | the row **and** the edge state, one transaction; a generation already held is a no-op |
| `edge(key)` / `putEdge(key, edge)` (`put_edge`) | the puller's memory; `putEdge` alone only for a pull that wrote no row |
| `control(key)` / `setControl(key, control \| null)` (`set_control`) | the rollback in force; `null` clears it |

`key` is `{ organizationId, agentId, target, region }`. `MemoryReleaseDatastore`
is the reference implementation (and what the tests use).

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
`generation_rollback`, never a quiet row), and writes the row with its
edge. A datastore that cannot be read or written is `datastore_unavailable`
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
