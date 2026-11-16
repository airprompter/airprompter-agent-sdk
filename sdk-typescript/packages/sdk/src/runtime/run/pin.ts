/**
 * Rule 2 as a pure function: what the current reductions do to a slot a run
 * has already pinned. Every `place`, pinned or not, asks this. Only a
 * reduction reaches a pinned slot; ramp steps and rollbacks wait for the next
 * run.
 *
 * @example
 * ```ts
 * const verdict = pinVerdict({ slot: "support.reply", arm: "candidate", disabled: resolver.disabled(), frozen: resolver.frozen(slot, tags), experimentId: "exp_1" });
 * if (verdict.kind === "replace") rePlace(); // the pinned arm was disabled, and its share went to control
 * ```
 */

import { disabledArmsFor, type Disabled } from "../release/resolver.js";

export type PinVerdict =
  /** The agent or the slot is disabled, or the experiment is frozen: pass through, keep the pin for the row. `stampTag` null means the whole agent. */
  | { kind: "disabled"; stampTag: string | null }
  /** The pinned arm is disabled: place again. */
  | { kind: "replace" }
  | { kind: "stands" };

export function pinVerdict(input: { slot: string; arm: string | undefined; disabled: Disabled; frozen: boolean; experimentId: string | null }): PinVerdict {
  const { slot, arm, disabled, frozen, experimentId } = input;
  if (disabled.agent) return { kind: "disabled", stampTag: null };
  if (disabled.slots.includes(slot) || frozen) return { kind: "disabled", stampTag: slot };
  if (!arm || arm === "none" || experimentId === null) return { kind: "stands" };
  return disabledArmsFor(disabled, experimentId).has(arm) ? { kind: "replace" } : { kind: "stands" };
}
