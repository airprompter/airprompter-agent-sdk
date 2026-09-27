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
 * @example
 * ```ts
 * // A Postgres DAO: one row per (org, agent, target, region, generation); one control row per key.
 * const datastore: ReleaseDatastore = {
 *   latest: async (key) => rowOf(await sql`SELECT * FROM ap_releases WHERE ${keyWhere(key)} ORDER BY generation DESC LIMIT 1`),
 *   get: async (key, generation) => rowOf(await sql`SELECT * FROM ap_releases WHERE ${keyWhere(key)} AND generation = ${generation}`),
 *   generations: async (key) => (await sql`SELECT generation FROM ap_releases WHERE ${keyWhere(key)} ORDER BY generation DESC`).map((r) => r.generation),
 *   put: (key, row, edge) => sql.begin(async (tx) => { await insertRow(tx, key, row); await upsertEdge(tx, key, edge); }), // ONE transaction
 *   edge: async (key) => edgeOf(await sql`SELECT edge FROM ap_release_edges WHERE ${keyWhere(key)}`),
 *   putEdge: (key, edge) => upsertEdge(sql, key, edge),
 *   control: async (key) => controlOf(await sql`SELECT control FROM ap_release_controls WHERE ${keyWhere(key)}`),
 *   setControl: (key, control) => (control ? upsertControl(sql, key, control) : deleteControl(sql, key)),
 * };
 * await pullToDatastore({ datastore, region: "eu-west-1", client, scope, trustedRoot, fetchRoot, now, distributionPublicKey });
 * const ap = await AirPrompterAgent.start({ ...scope, root, distributionKey, datastore: { store: datastore, region: "eu-west-1" } });
 * ```
 */

import { experimentsOf } from "@airprompter/agent-core";
import type { ApplyPolicy, Manifest, Target } from "@airprompter/agent-core";
import type { PullEdgeState } from "../sync/pullBundle.js";

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
 * The DAO the application implements over its own datastore. Every method may throw (the datastore is down): the
 * puller reports it, a runtime keeps serving what it holds. `put` writes the row AND the puller's edge state in one
 * transaction — an edge saved without its row makes the next origin read a 304 and the row is never written. A row
 * is immutable once written: `put` of a generation already held for the key is a no-op.
 */
export interface ReleaseDatastore {
  /** The newest row for exactly this key (no region fallback here — `resolveHydration` does that). */
  latest(key: ReleaseKey): Promise<StoredReleaseRow | null>;
  get(key: ReleaseKey, generation: number): Promise<StoredReleaseRow | null>;
  /** Every generation held for exactly this key, newest first. */
  generations(key: ReleaseKey): Promise<number[]>;
  put(key: ReleaseKey, row: StoredReleaseRow, edge: PullEdgeState): Promise<void>;
  /** The puller's memory between pulls; null before the first. */
  edge(key: ReleaseKey): Promise<PullEdgeState | null>;
  /** The edge state alone, for a pull that wrote no row (`unchanged`, `nothing_promoted`): it moved no ETag past a row. */
  putEdge(key: ReleaseKey, edge: PullEdgeState): Promise<void>;
  control(key: ReleaseKey): Promise<ReleaseControl | null>;
  /** `null` clears the rollback for exactly this key. */
  setControl(key: ReleaseKey, control: ReleaseControl | null): Promise<void>;
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

export type DatastoreRollbackResult = { ok: true; control: ReleaseControl } | { ok: false; reason: "no_release" | "no_previous_release" | "generation_missing" | "not_a_rollback" };

/**
 * Roll the fleet in `key.region` (or every region, with `region: null`) back to an older row. Without `toGeneration`
 * it steps one row down from what is served now. Every runtime that hydrates next serves that row — verified through
 * the same chain as any other — and holds it until a generation above the newest one today is promoted, or
 * `clearDatastoreRollback` ends it. The rows it reads are this key's own, else the global ones (as hydration reads them).
 */
export async function rollbackDatastore(input: { datastore: ReleaseDatastore; key: ReleaseKey; toGeneration?: number; reason?: string; setBy?: string; now?: () => string }): Promise<DatastoreRollbackResult> {
  const { datastore, key } = input;
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
  await datastore.setControl(key, control);
  return { ok: true, control };
}

/** End the rollback set for exactly this key: the newest row serves again on the next hydrate. */
export async function clearDatastoreRollback(input: { datastore: ReleaseDatastore; key: ReleaseKey }): Promise<void> {
  await input.datastore.setControl(input.key, null);
}

const keyString = (key: ReleaseKey): string => JSON.stringify([key.organizationId, key.agentId, key.target, key.region]);

/**
 * A `ReleaseDatastore` in memory: tests, a dev loop, and the reference for what a real DAO must do (immutable rows,
 * the row and its edge together, copies in and out).
 */
export class MemoryReleaseDatastore implements ReleaseDatastore {
  private readonly rows = new Map<string, Map<number, StoredReleaseRow>>();
  private readonly edges = new Map<string, PullEdgeState>();
  private readonly controls = new Map<string, ReleaseControl>();

  async latest(key: ReleaseKey): Promise<StoredReleaseRow | null> {
    const rows = this.rows.get(keyString(key));
    if (!rows || rows.size === 0) return null;
    return structuredClone(rows.get(Math.max(...rows.keys()))!);
  }

  async get(key: ReleaseKey, generation: number): Promise<StoredReleaseRow | null> {
    const row = this.rows.get(keyString(key))?.get(generation);
    return row ? structuredClone(row) : null;
  }

  async generations(key: ReleaseKey): Promise<number[]> {
    return [...(this.rows.get(keyString(key))?.keys() ?? [])].sort((a, b) => b - a);
  }

  async put(key: ReleaseKey, row: StoredReleaseRow, edge: PullEdgeState): Promise<void> {
    const id = keyString(key);
    const rows = this.rows.get(id) ?? new Map<number, StoredReleaseRow>();
    if (!rows.has(row.generation)) rows.set(row.generation, structuredClone(row));
    this.rows.set(id, rows);
    this.edges.set(id, { ...edge });
  }

  async edge(key: ReleaseKey): Promise<PullEdgeState | null> {
    const edge = this.edges.get(keyString(key));
    return edge ? { ...edge } : null;
  }

  async putEdge(key: ReleaseKey, edge: PullEdgeState): Promise<void> {
    this.edges.set(keyString(key), { ...edge });
  }

  async control(key: ReleaseKey): Promise<ReleaseControl | null> {
    const control = this.controls.get(keyString(key));
    return control ? { ...control } : null;
  }

  async setControl(key: ReleaseKey, control: ReleaseControl | null): Promise<void> {
    if (control) this.controls.set(keyString(key), { ...control });
    else this.controls.delete(keyString(key));
  }
}
