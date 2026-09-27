/**
 * The release datastore (T40): the customer's own database, bucket or
 * config service as the fleet's copy of what AirPrompter sealed. The SDK
 * owns no connection: the application hands in a `ReleaseDatastore` — a DAO
 * over its Postgres table, its DynamoDB item, its Redis hash — and the
 * puller writes through it (`pullToDatastore`) while every runtime hydrates
 * from it (`AirPrompterAgent.start({ datastore })`, `ap.hydrate()`).
 *
 * What a row holds is the sealed `.apbundle` — ciphertext to the fleet's
 * distribution key, signed end to end — so the datastore is a carrier, never
 * a root of trust: a runtime verifies every row through the same chain as
 * OTA before a byte is served. Beside it the row keeps a content-free
 * `rollout` summary (the arms, their dial-up percentages and ramp steps, the
 * disabled scopes) for the customer's own queries and dashboards; hydration
 * never reads it — the signed manifest inside the bundle is what serves, so
 * a ramp keeps walking on each host's clock exactly as signed.
 *
 * Two things live only here, because they are the fleet's and not the
 * control plane's:
 *
 *   - the ROLLBACK in force (`ReleaseControl`): serve an older row, held
 *     until the fleet moves past the generation it stepped down from — the
 *     host-local `rollback()` made fleet-wide;
 *   - the REGION: every row and every control is keyed by
 *     `{ organizationId, agentId, target, region }`. A region with rows of its
 *     own (a regional puller) serves them; a region with none reads the global
 *     rows (`region: null`). A rollback set for a region binds that region
 *     only; one set globally binds every region without one of its own.
 *
 * Most applications never implement `ReleaseDatastore` themselves: `kvReleaseDatastore(kv)` implements it over a
 * `KvStore` (four operations; `@airprompter/datastore-s3`, `-postgres` and `-redis` ship three) in the shared format
 * of `protocol/datastore-format.md`, so a Python puller and a TypeScript runtime read each other's rows. Implement
 * the interface directly only for a schema of your own (real columns to query the rollout by).
 *
 * @example
 * ```ts
 * import { postgresKvStore } from "@airprompter/datastore-postgres";
 * const datastore = kvReleaseDatastore(postgresKvStore({ pool })); // or MemoryReleaseDatastore in tests
 * await pullToDatastore({ datastore, region: "eu-west-1", client, scope, trustedRoot, fetchRoot, now, distributionPublicKey });
 * const ap = await AirPrompterAgent.start({ ...scope, root, distributionKey, datastore: { store: datastore, region: "eu-west-1" } });
 * ```
 */

import { experimentsOf } from "@airprompter/agent-core";
import type { ApplyPolicy, Manifest, Target } from "@airprompter/agent-core";
import type { PullEdgeState } from "../sync/pullBundle.js";
import { datastoreKeys, decodeDatastoreRecord, encodeDatastoreRecord, generationOfReleaseKey, type DatastoreRecord } from "./datastoreRecords.js";
import { MemoryKvStore, type KvStore } from "./kvStore.js";

/** Where a row lives: the signed scope, and the region the customer deploys to (`null`: every region without its own). */
export interface ReleaseKey {
  organizationId: string;
  agentId: string;
  target: Target;
  region: string | null;
}

/** S9/S16 as data: one experiment's arms, their base weights (the dial-up percentages) and the signed ramp plan. */
export interface RolloutExperiment {
  experimentId: string;
  /** The slot it splits; null on the legacy single experiment. */
  tag: string | null;
  arms: Array<{ arm: string; weightBps: number }>;
  ramp: Array<{ notBefore: string; weightBps: number[] }>;
}

/** A content-free copy of what the signed manifest says about rollout — for the customer's queries, never for serving. */
export interface ReleaseRollout {
  applyPolicy: ApplyPolicy;
  experiments: RolloutExperiment[];
  disabled: { agent: boolean; slots: string[]; arms: Array<{ arm: string; experimentId: string | null }> };
}

/** One generation as the datastore carries it. */
export interface StoredReleaseRow {
  generation: number;
  releaseDigest: string;
  /** The `.apbundle`, as JSON text: sealed to the fleet's distribution key off the dev target. */
  bundle: string;
  createdAt: string;
  notAfter: string;
  rollout: ReleaseRollout;
}

/**
 * The fleet's rollback in force: serve `generation` while the newest row is at or below `heldBackBelow`. A promotion
 * past `heldBackBelow` ends it on every host, as a host-local rollback ends when the control plane moves past it.
 */
export interface ReleaseControl {
  generation: number;
  heldBackBelow: number;
  setAt: string;
  reason?: string;
  setBy?: string;
}

/**
 * What the puller writes and every runtime reads. Every method may throw (the datastore is down): the puller reports
 * it, a runtime keeps serving what it holds. No method needs a transaction: the puller writes the row
 * (`putRelease`), then the edge state (`putEdge`) — an edge is never saved before its row, so an ETag can never hide a
 * row that was not written. A row is immutable once written.
 */
export interface ReleaseDatastore {
  /** The newest row for exactly this key (no region fallback here — `resolveHydration` does that). */
  latest(key: ReleaseKey): Promise<StoredReleaseRow | null>;
  get(key: ReleaseKey, generation: number): Promise<StoredReleaseRow | null>;
  /** Every generation held for exactly this key, newest first. */
  generations(key: ReleaseKey): Promise<number[]>;
  /** Write a row; a generation already held is left as it is. The newest generation only ever moves forward. */
  putRelease(key: ReleaseKey, row: StoredReleaseRow): Promise<void>;
  /** The puller's memory between pulls; null before the first. */
  edge(key: ReleaseKey): Promise<PullEdgeState | null>;
  /** Written after the row it describes; never moves back past a later `lastOriginAt` another puller wrote. */
  putEdge(key: ReleaseKey, edge: PullEdgeState): Promise<void>;
  control(key: ReleaseKey): Promise<ReleaseControl | null>;
  /**
   * `null` clears the rollback for exactly this key. With `expected` (what the caller read, `null` for none) the write
   * happens only if the control is still that — `false` when another operator changed it first.
   */
  setControl(key: ReleaseKey, control: ReleaseControl | null, expected?: ReleaseControl | null): Promise<boolean>;
  /** Optional: delete all but the newest `keep` rows, never the one a rollback names. Returns how many went. */
  prune?(key: ReleaseKey, keep: number): Promise<number>;
}

/** The rollout summary of a manifest — what the signed payload says, copied as data. */
export function rolloutOf(manifest: Manifest): ReleaseRollout {
  const payload = manifest.payload;
  const experiments: RolloutExperiment[] = experimentsOf(payload).map((experiment) => ({
    experimentId: experiment.experimentId,
    tag: experiment.tag ?? null,
    arms: experiment.arms.map((arm) => ({ arm: arm.arm, weightBps: arm.weightBps })),
    ramp: (experiment.ramp ?? []).map((step) => ({ notBefore: step.notBefore, weightBps: [...step.weightBps] })),
  }));
  const disabled: ReleaseRollout["disabled"] = { agent: false, slots: [], arms: [] };
  for (const directive of payload.directives) {
    if (directive.kind !== "disable") continue;
    if (directive.scope === "agent") disabled.agent = true;
    else if (directive.scope === "slot" && directive.tag) disabled.slots.push(directive.tag);
    else if (directive.scope === "arm" && directive.arm) disabled.arms.push({ arm: directive.arm, experimentId: directive.experimentId ?? null });
  }
  return { applyPolicy: payload.applyPolicy, experiments, disabled };
}

/** The global key a regional one falls back to. */
export function globalKeyOf(key: ReleaseKey): ReleaseKey {
  return { ...key, region: null };
}

/** What a runtime should serve, read from the datastore: the row, why it is that row, and the rollback in force. */
export interface HydrationPlan {
  /** The row to serve; null when the datastore holds none for this key or its global fallback. */
  row: StoredReleaseRow | null;
  /** The newest generation held (the row itself unless a rollback is in force); 0 when none. */
  newest: number;
  /** The rollback in force, and whether it came from this region or the global key. */
  control: (ReleaseControl & { scope: "region" | "global" }) | null;
  /** Where the rows came from: this region's own, or the global ones. */
  rowsFrom: "region" | "global" | null;
  /** A rollback named a generation the datastore does not hold: the newest row serves and this says why. */
  missingRollbackGeneration?: number;
}

/**
 * Read what a runtime in `key.region` should serve. Rows: the region's own when it has any, else the global ones.
 * Rollback: the region's own control, else the global one — in force while the newest row is at or below its
 * `heldBackBelow`; a promotion past that ends it.
 */
export async function resolveHydration(datastore: ReleaseDatastore, key: ReleaseKey): Promise<HydrationPlan> {
  const regional = key.region !== null;
  let rowsKey = key;
  let rowsFrom: HydrationPlan["rowsFrom"] = regional ? "region" : "global";
  let newestRow = await datastore.latest(key);
  if (!newestRow && regional) {
    rowsKey = globalKeyOf(key);
    rowsFrom = "global";
    newestRow = await datastore.latest(rowsKey);
  }
  if (!newestRow) return { row: null, newest: 0, control: null, rowsFrom: null };
  let control: HydrationPlan["control"] = null;
  const own = await datastore.control(key);
  if (own) control = { ...own, scope: regional ? "region" : "global" };
  else if (regional) {
    const global = await datastore.control(globalKeyOf(key));
    if (global) control = { ...global, scope: "global" };
  }
  if (!control || newestRow.generation > control.heldBackBelow) return { row: newestRow, newest: newestRow.generation, control: null, rowsFrom };
  if (control.generation === newestRow.generation) return { row: newestRow, newest: newestRow.generation, control, rowsFrom };
  const target = await datastore.get(rowsKey, control.generation);
  if (!target) return { row: newestRow, newest: newestRow.generation, control: null, rowsFrom, missingRollbackGeneration: control.generation };
  return { row: target, newest: newestRow.generation, control, rowsFrom };
}

export type DatastoreRollbackResult = { ok: true; control: ReleaseControl } | { ok: false; reason: "no_release" | "no_previous_release" | "generation_missing" | "not_a_rollback" | "conflict" };

/**
 * Roll the fleet in `key.region` (or every region, with `region: null`) back to an older row. Without `toGeneration`
 * it steps one row down from what is served now. Every runtime that hydrates next serves that row — verified through
 * the same chain as any other — and holds it until a generation above the newest one today is promoted, or
 * `clearDatastoreRollback` ends it. The rows it reads are this key's own, else the global ones (as hydration reads them).
 */
export async function rollbackDatastore(input: { datastore: ReleaseDatastore; key: ReleaseKey; toGeneration?: number; reason?: string; setBy?: string; now?: () => string }): Promise<DatastoreRollbackResult> {
  const { datastore, key } = input;
  // Read first: the write below goes through only if nobody changed this key's rollback in between.
  const before = await datastore.control(key);
  const plan = await resolveHydration(datastore, key);
  if (!plan.row) return { ok: false, reason: "no_release" };
  const rowsKey = plan.rowsFrom === "global" ? globalKeyOf(key) : key;
  const held = (await datastore.generations(rowsKey)).sort((a, b) => b - a);
  const serving = plan.row.generation;
  const toGeneration = input.toGeneration ?? held.find((generation) => generation < serving);
  if (toGeneration === undefined) return { ok: false, reason: "no_previous_release" };
  if (!held.includes(toGeneration)) return { ok: false, reason: "generation_missing" };
  if (toGeneration >= plan.newest) return { ok: false, reason: "not_a_rollback" };
  const control: ReleaseControl = {
    generation: toGeneration,
    heldBackBelow: plan.newest,
    setAt: input.now?.() ?? new Date().toISOString(),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.setBy ? { setBy: input.setBy } : {}),
  };
  if (!(await datastore.setControl(key, control, before))) return { ok: false, reason: "conflict" };
  return { ok: true, control };
}

/** End the rollback set for exactly this key: the newest row serves again on the next hydrate. */
export async function clearDatastoreRollback(input: { datastore: ReleaseDatastore; key: ReleaseKey }): Promise<void> {
  await input.datastore.setControl(input.key, null);
}

/** Delete all but the newest `keep` rows for exactly this key (never the one a rollback names). */
export async function pruneDatastore(input: { datastore: ReleaseDatastore; key: ReleaseKey; keep: number }): Promise<number> {
  if (!Number.isInteger(input.keep) || input.keep < 1) throw new Error("keep must be a positive integer");
  if (!input.datastore.prune) throw new Error("this datastore does not prune");
  return input.datastore.prune(input.key, input.keep);
}

const MAX_CAS_ATTEMPTS = 8;

type ReleaseRecord = Extract<DatastoreRecord, { kind: "release" }>;

const rowOf = (record: ReleaseRecord): StoredReleaseRow => ({
  generation: record.generation,
  releaseDigest: record.releaseDigest,
  bundle: JSON.stringify(record.bundle),
  createdAt: record.createdAt,
  notAfter: record.notAfter,
  rollout: record.rollout as unknown as ReleaseRollout,
});

const controlOf = (record: Extract<DatastoreRecord, { kind: "control" }>): ReleaseControl => ({
  generation: record.generation,
  heldBackBelow: record.heldBackBelow,
  setAt: record.setAt,
  ...(record.reason !== undefined ? { reason: record.reason } : {}),
  ...(record.setBy !== undefined ? { setBy: record.setBy } : {}),
});

const sameControl = (a: ReleaseControl | null, b: ReleaseControl | null): boolean =>
  a === null || b === null ? a === b : encodeDatastoreRecord({ kind: "control", ...a }) === encodeDatastoreRecord({ kind: "control", ...b });

/**
 * `ReleaseDatastore` over any `KvStore`, in the shared format (`protocol/datastore-format.md`): what one SDK writes,
 * every other reads. Writes are ordered, never transactional: the release (`ifAbsent`), then `latest.json` moved
 * forward only (compare-and-set), then the edge state (compare-and-set, never back past a later `lastOriginAt`).
 */
export class KvReleaseDatastore implements ReleaseDatastore {
  constructor(
    readonly kv: KvStore,
    readonly prefix: string = "airprompter/",
  ) {}

  private keys(key: ReleaseKey) {
    return datastoreKeys(this.prefix, key);
  }

  async latest(key: ReleaseKey): Promise<StoredReleaseRow | null> {
    const keys = this.keys(key);
    const pointer = await this.kv.get(keys.latest);
    if (pointer) {
      const { generation } = decodeDatastoreRecord(pointer.value, "latest");
      const row = await this.get(key, generation);
      // A newer release written after the pointer was read is found on the next read; one the pointer names but
      // nobody holds any more (pruned by hand) falls through to the listing.
      if (row) return row;
    }
    // No pointer (a crash between the release and its pointer, or a store written by hand): the highest release.
    const newest = (await this.generations(key))[0];
    return newest === undefined ? null : this.get(key, newest);
  }

  async get(key: ReleaseKey, generation: number): Promise<StoredReleaseRow | null> {
    const entry = await this.kv.get(this.keys(key).release(generation));
    return entry ? rowOf(decodeDatastoreRecord(entry.value, "release", generation)) : null;
  }

  async generations(key: ReleaseKey): Promise<number[]> {
    const keys = this.keys(key);
    const generations = (await this.kv.list(keys.releasesPrefix)).map((name) => generationOfReleaseKey(keys.releasesPrefix, name)).filter((generation): generation is number => generation !== null);
    return [...new Set(generations)].sort((a, b) => b - a);
  }

  async putRelease(key: ReleaseKey, row: StoredReleaseRow): Promise<void> {
    const keys = this.keys(key);
    const text = encodeDatastoreRecord({ kind: "release", generation: row.generation, releaseDigest: row.releaseDigest, createdAt: row.createdAt, notAfter: row.notAfter, bundle: JSON.parse(row.bundle) as Record<string, unknown>, rollout: row.rollout as unknown as Record<string, unknown> });
    await this.kv.put(keys.release(row.generation), text, { ifAbsent: true }); // false: already held — immutable
    await this.advanceLatest(keys.latest, row.generation);
  }

  private async advanceLatest(latestKey: string, generation: number): Promise<void> {
    const text = encodeDatastoreRecord({ kind: "latest", generation });
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.kv.get(latestKey);
      if (current && decodeDatastoreRecord(current.value, "latest").generation >= generation) return;
      if (await this.kv.put(latestKey, text, current ? { ifVersion: current.version } : { ifAbsent: true })) return;
    }
    throw new Error(`latest.json kept moving under ${MAX_CAS_ATTEMPTS} attempts to advance it to ${generation}`);
  }

  async edge(key: ReleaseKey): Promise<PullEdgeState | null> {
    const entry = await this.kv.get(this.keys(key).edge);
    if (!entry) return null;
    const { kind: _kind, ...edge } = decodeDatastoreRecord(entry.value, "edge");
    return edge;
  }

  async putEdge(key: ReleaseKey, edge: PullEdgeState): Promise<void> {
    const edgeKey = this.keys(key).edge;
    const text = encodeDatastoreRecord({ kind: "edge", pointerUrl: edge.pointerUrl, pointerEtag: edge.pointerEtag, manifestEtag: edge.manifestEtag, lastOriginAt: edge.lastOriginAt });
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.kv.get(edgeKey);
      if (current) {
        const held = decodeDatastoreRecord(current.value, "edge");
        // Another puller already recorded a later answer from the origin: this state is older, not newer.
        if ((held.lastOriginAt ?? "") > (edge.lastOriginAt ?? "")) return;
        if (current.value === text) return;
      }
      if (await this.kv.put(edgeKey, text, current ? { ifVersion: current.version } : { ifAbsent: true })) return;
    }
    throw new Error(`edge.json kept moving under ${MAX_CAS_ATTEMPTS} attempts`);
  }

  async control(key: ReleaseKey): Promise<ReleaseControl | null> {
    const entry = await this.kv.get(this.keys(key).control);
    return entry ? controlOf(decodeDatastoreRecord(entry.value, "control")) : null;
  }

  async setControl(key: ReleaseKey, control: ReleaseControl | null, expected?: ReleaseControl | null): Promise<boolean> {
    const controlKey = this.keys(key).control;
    const current = await this.kv.get(controlKey);
    const held = current ? controlOf(decodeDatastoreRecord(current.value, "control")) : null;
    if (expected !== undefined && !sameControl(held, expected)) return false;
    if (control === null) {
      if (current) await this.kv.delete(controlKey);
      return true;
    }
    const text = encodeDatastoreRecord({ kind: "control", ...control });
    return this.kv.put(controlKey, text, current ? { ifVersion: current.version } : { ifAbsent: true });
  }

  async prune(key: ReleaseKey, keep: number): Promise<number> {
    const keys = this.keys(key);
    const generations = await this.generations(key);
    const control = await this.control(key);
    const pointer = await this.kv.get(keys.latest);
    const protectedGenerations = new Set<number>(generations.slice(0, keep));
    if (control) protectedGenerations.add(control.generation);
    if (pointer) protectedGenerations.add(decodeDatastoreRecord(pointer.value, "latest").generation);
    let removed = 0;
    for (const generation of generations) {
      if (protectedGenerations.has(generation)) continue;
      await this.kv.delete(keys.release(generation));
      removed += 1;
    }
    return removed;
  }
}

/** `ReleaseDatastore` over a `KvStore` in the shared format; `prefix` is the deployment's own (`airprompter/` by default). */
export function kvReleaseDatastore(kv: KvStore, options: { prefix?: string } = {}): KvReleaseDatastore {
  return new KvReleaseDatastore(kv, options.prefix ?? "airprompter/");
}

/** A `ReleaseDatastore` in memory — the shared format over a `MemoryKvStore`: tests and dev loops. */
export class MemoryReleaseDatastore extends KvReleaseDatastore {
  constructor(prefix = "airprompter/") {
    super(new MemoryKvStore(), prefix);
  }
}
