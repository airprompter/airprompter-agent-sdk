/**
 * The puller with the customer's datastore around it (T40): `pullBundle`
 * reading its memory (the edge state, the newest generation held) from the
 * datastore and writing what it sealed back through it — the row first, then
 * the edge state, never the edge before the row. The Agent key
 * lives here and nowhere else; every runtime hydrates from the rows.
 *
 * A regional puller (`region: "eu-west-1"`) keeps its own rows and its own
 * edge state; a global one (`region: null`, the default) writes the rows
 * every region without its own reads.
 *
 * @example
 * ```ts
 * let unchangedStreak = 0;
 * const tick = async () => {
 *   const result = await pullToDatastore({ datastore, region: process.env.REGION ?? null, client, scope, trustedRoot, fetchRoot, now: () => new Date().toISOString(), distributionPublicKey: fleetPublicRaw });
 *   unchangedStreak = result.status === "unchanged" ? unchangedStreak + 1 : 0;
 *   setTimeout(tick, nextPullDelayMs({ outcome: result.status, unchangedStreak, intervalMs: 30_000 }));
 * };
 * ```
 */

import { pullBundle, type PullBundleInput, type PullBundleResult } from "./pullBundle.js";
import { rolloutOf, type ReleaseDatastore, type ReleaseKey, type StoredReleaseRow } from "../store/releaseDatastore.js";

export interface PullToDatastoreInput extends Omit<PullBundleInput, "edge" | "minimumGeneration"> {
  datastore: ReleaseDatastore;
  /** The region these rows are for; null (the default) writes the global rows. */
  region?: string | null;
}

export type PullToDatastoreResult =
  | (PullBundleResult & { key: ReleaseKey; stored: boolean })
  | { status: "datastore_unavailable"; key: ReleaseKey; stage: "read" | "write"; detail: string; stored: false };

export async function pullToDatastore(input: PullToDatastoreInput): Promise<PullToDatastoreResult> {
  const { datastore, region, ...pull } = input;
  const key: ReleaseKey = { ...input.scope, region: region ?? null };
  let edge: Awaited<ReturnType<ReleaseDatastore["edge"]>>;
  let held: StoredReleaseRow | null;
  try {
    [edge, held] = await Promise.all([datastore.edge(key), datastore.latest(key)]);
  } catch (error) {
    return { status: "datastore_unavailable", key, stage: "read", detail: String((error as Error).message ?? error).slice(0, 240), stored: false };
  }
  const result = await pullBundle({ ...pull, edge, minimumGeneration: held?.generation ?? 0 });
  try {
    if (result.status === "ok") {
      const row: StoredReleaseRow = {
        generation: result.generation,
        releaseDigest: result.releaseDigest,
        bundle: JSON.stringify(result.bundle),
        createdAt: result.createdAt,
        notAfter: result.notAfter,
        rollout: rolloutOf(result.manifest),
      };
      // The row, then its edge state — in that order, never together: an edge saved before its row could hide it.
      await datastore.putRelease(key, row);
      await datastore.putEdge(key, result.edge);
      return { ...result, key, stored: true };
    }
    // Nothing written: the edge moves only when the origin confirmed nothing moved (the pointer's ETag, the contact).
    if (result.status === "unchanged" || result.status === "nothing_promoted") await datastore.putEdge(key, result.edge);
  } catch (error) {
    return { status: "datastore_unavailable", key, stage: "write", detail: String((error as Error).message ?? error).slice(0, 240), stored: false };
  }
  return { ...result, key, stored: false };
}
