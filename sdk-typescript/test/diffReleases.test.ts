/**
 * `diffReleases(previous, next)` (core, AIR-2405): the per-slot change between two content-free release snapshots.
 * Pure — the same inputs give the same list in the same order — and the vocabulary a Steps trigger's events use.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { diffReleases, type SlotReleaseState } from "../packages/sdk/src/core/index.js";

const slot = (over: Partial<SlotReleaseState> = {}): SlotReleaseState => ({ digest: "d1", versionId: "v1", ordinal: 1, experimentId: null, weights: [], disabled: false, ...over });

test("no previous snapshot: every slot is the baseline, `current`", () => {
  const next = { a: slot(), b: slot({ versionId: "v9" }) };
  assert.deepEqual(diffReleases(null, next).map((d) => [d.slot, d.change, d.previous]), [["a", "current", null], ["b", "current", null]]);
});

test("an unchanged digest is no change; every other rule in order", () => {
  const before = { same: slot(), off: slot(), on: slot({ disabled: true }), up: slot(), back: slot({ versionId: "v2", ordinal: 2 }), noOrdinal: slot({ ordinal: null }), abStart: slot(), abEnd: slot({ experimentId: "exp", weights: [5000, 5000] }), dial: slot({ experimentId: "exp", weights: [9000, 1000] }), gone: slot() };
  const next = {
    same: slot(),
    off: slot({ digest: "x", disabled: true }),
    on: slot({ digest: "x" }),
    up: slot({ digest: "x", versionId: "v2", ordinal: 2 }),
    back: slot({ digest: "x", versionId: "v1", ordinal: 1 }),
    noOrdinal: slot({ digest: "x", versionId: "v0", ordinal: 0 }),
    abStart: slot({ digest: "x", experimentId: "exp", weights: [5000, 5000] }),
    abEnd: slot({ digest: "x" }),
    dial: slot({ digest: "x", experimentId: "exp", weights: [7500, 2500] }),
    fresh: slot(),
  };
  assert.deepEqual(diffReleases(before, next).map((d) => [d.slot, d.change]), [
    ["off", "disabled"],
    ["on", "enabled"],
    ["up", "new_version"],
    ["back", "rolled_back"],
    ["noOrdinal", "new_version"],
    ["abStart", "ab_started"],
    ["abEnd", "ab_ended"],
    ["dial", "dial:75-25"],
    ["fresh", "new_version"],
    ["gone", "removed"],
  ]);
  const gone = diffReleases(before, next).find((d) => d.slot === "gone")!;
  assert.deepEqual([gone.previous, gone.next], [before.gone, null]);
});

test("pure: the inputs are not touched and the same inputs give the same list", () => {
  const before = { a: slot() };
  const next = { a: slot({ digest: "x", versionId: "v2", ordinal: 2 }) };
  const copy = JSON.stringify([before, next]);
  assert.deepEqual(diffReleases(before, next), diffReleases(before, next));
  assert.equal(JSON.stringify([before, next]), copy);
});
