/**
 * What changed between two looks at a release, slot by slot: a pure function over two content-free snapshots, so a
 * poller that keeps only the last snapshot (a no-code trigger's cursor, a dashboard, a CI check) names a change the
 * same way everywhere (AIR-2405). Every decision it names was made in AirPrompter and signed; this only compares.
 *
 * The rules, in order, for a slot present in both snapshots:
 *
 * - the same `digest` is no change (the caller's digest covers whatever it treats as the slot's served state);
 * - `disabled` flipped → `disabled` / `enabled`;
 * - another `versionId` → `rolled_back` when both ordinals are known and the new one is lower, else `new_version`;
 * - another `experimentId` → `ab_started` (one now) / `ab_ended` (none now);
 * - otherwise the split's weights moved inside one experiment → `dial:<w1%>-<w2%>…` (a signed ramp step).
 *
 * With no previous snapshot every slot is `current` (the baseline). A slot only in `next` is `new_version`; a slot
 * only in `previous` is `removed`, listed after the others.
 *
 * @example
 * ```ts
 * import { diffReleases } from "@airprompter/agent-sdk/core";
 * const before = { "support.triage": { digest: "a1", versionId: "v1", ordinal: 1, experimentId: null, weights: [], disabled: false } };
 * const after = { "support.triage": { digest: "b2", versionId: "v2", ordinal: 2, experimentId: null, weights: [], disabled: false } };
 * diffReleases(before, after); // [{ slot: "support.triage", change: "new_version", previous: before["support.triage"], next: after["support.triage"] }]
 * ```
 */

/** One slot's served state as a poll records it. Content-free: ids, numbers and a digest the caller computes. */
export interface SlotReleaseState {
  /** Changes whenever the caller considers the slot's served state changed; equal digests are no change. */
  digest: string;
  versionId: string;
  /** The version's ordinal when the release carries one: a lower ordinal is a rollback. */
  ordinal: number | null;
  experimentId: string | null;
  /** The split's weights in force, in basis points, arm order; empty without a split. */
  weights: number[];
  disabled: boolean;
}

/** A snapshot of a release: slot tag → its served state. */
export type ReleaseSnapshot = Readonly<Record<string, SlotReleaseState>>;

export type SlotReleaseChange = "current" | "new_version" | "rolled_back" | "ab_started" | "ab_ended" | `dial:${string}` | "disabled" | "enabled" | "removed";

export interface ReleaseSlotDiff {
  slot: string;
  change: SlotReleaseChange;
  /** The slot as the previous snapshot had it; null for a baseline or a new slot. */
  previous: SlotReleaseState | null;
  /** The slot as it is now; null when it was removed. */
  next: SlotReleaseState | null;
}

/** The changes from `previous` to `next`; an unchanged slot is left out. Pure: same inputs, same list, same order. */
export function diffReleases(previous: ReleaseSnapshot | null, next: ReleaseSnapshot): ReleaseSlotDiff[] {
  const out: ReleaseSlotDiff[] = [];
  for (const [slot, now] of Object.entries(next)) {
    const before = previous ? (previous[slot] ?? null) : null;
    const change = changeOf(previous !== null, before, now);
    if (change !== null) out.push({ slot, change, previous: before, next: now });
  }
  if (previous) {
    for (const [slot, before] of Object.entries(previous)) {
      if (!Object.prototype.hasOwnProperty.call(next, slot)) out.push({ slot, change: "removed", previous: before, next: null });
    }
  }
  return out;
}

function changeOf(hadPrevious: boolean, before: SlotReleaseState | null, now: SlotReleaseState): SlotReleaseChange | null {
  if (!hadPrevious) return "current";
  if (!before) return "new_version";
  if (before.digest === now.digest) return null;
  if (before.disabled !== now.disabled) return now.disabled ? "disabled" : "enabled";
  // A rollback is a lower ordinal; without both ordinals a different version can only be called new.
  if (before.versionId !== now.versionId) return before.ordinal !== null && now.ordinal !== null && now.ordinal < before.ordinal ? "rolled_back" : "new_version";
  if (before.experimentId !== now.experimentId) return now.experimentId ? "ab_started" : "ab_ended";
  return `dial:${now.weights.map((w) => `${w / 100}`).join("-")}`;
}
