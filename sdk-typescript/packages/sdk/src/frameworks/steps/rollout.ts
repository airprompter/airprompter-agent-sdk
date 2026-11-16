/**
 * What a verified manifest says about each slot, and what changed since the last look. Read-only: every decision here
 * was made in AirPrompter and signed; this only names it — a new approved version, a rollback (a lower version
 * ordinal), an A/B split starting or ending, a dial-up step (the signed ramp walks on the clock, so a step can arrive
 * without a new generation), a slot disabled or enabled.
 *
 * Event ids are `slot:digest:state`. The digest covers the slot's served state AND the generation that carries it, so
 * a rollback to a version seen before is still a new id (a rollback is always a new generation) while a poll that
 * sees nothing new produces the same ids and the platform drops them. A ramp step inside one generation changes the
 * weights, so it changes the digest too.
 *
 * @example
 * ```ts
 * const slots = slotsOf(manifest.payload, Date.now());           // dropdown rows: slot, model, version, split, disabled
 * const { events, cursor } = rolloutChanges(manifest.payload, previousCursor, Date.now());
 * // first poll (previousCursor null): one "current" event per slot, the baseline
 * ```
 */

import { createHash } from "node:crypto";
import { diffReleases, effectiveArms, servableExperiments, servableSlots } from "../../core/index.js";
import type { ManifestPayload, ManifestSlot, SlotVariable } from "../../core/index.js";
import type { RolloutCursor, RolloutEvent, RolloutState, SlotInfo, VariableInfo } from "./types.js";

/** Only prompt slots: one slot per step, and a workflow slot is several steps. */
const servablePrompts = (payload: ManifestPayload): ManifestSlot[] => servableSlots(payload).filter((slot) => slot.kind === "prompt");

function disabledSlot(payload: ManifestPayload, tag: string): boolean {
  return payload.directives.some((d) => d.kind === "disable" && (d.scope === "agent" || (d.scope === "slot" && d.tag === tag)));
}

function disabledArms(payload: ManifestPayload, experimentId: string): Set<string> {
  return new Set(payload.directives.flatMap((d) => (d.kind === "disable" && d.scope === "arm" && d.arm && (d.experimentId === undefined || d.experimentId === experimentId) ? [d.arm] : [])));
}

export function slotsOf(payload: ManifestPayload, nowMs: number): SlotInfo[] {
  const experiments = servableExperiments(payload);
  return servablePrompts(payload).map((slot) => {
    const experiment = experiments.find((e) => e.tag === slot.tag);
    let split: SlotInfo["experiment"] = null;
    if (experiment) {
      // The weights in force now: the signed ramp walked on this clock, a disabled arm's share back to the control.
      const live = effectiveArms({ arms: experiment.arms, ramp: experiment.ramp, disabledArms: disabledArms(payload, experiment.experimentId), nowMs });
      const weightOf = new Map((live ?? []).map((arm) => [arm.arm, arm.weightBps]));
      split = {
        experimentId: experiment.experimentId,
        arms: experiment.arms.map((arm) => ({ arm: arm.arm, versionId: arm.overrides.find((o) => o.tag === slot.tag)?.versionId ?? slot.versionId, weightBps: weightOf.get(arm.arm) ?? 0 })),
      };
    }
    return { slot: slot.tag, kind: slot.kind, model: slot.model, versionId: slot.versionId, experiment: split, disabled: disabledSlot(payload, slot.tag) };
  });
}

/** The slot's variables, across every arm: a step must be able to fill whichever version the split assigns. */
export function variablesOf(payload: ManifestPayload, tag: string): VariableInfo[] | null {
  const slot = servablePrompts(payload).find((s) => s.tag === tag);
  if (!slot) return null;
  const pins: ManifestSlot[] = [slot, ...servableExperiments(payload).filter((e) => e.tag === tag).flatMap((e) => e.arms.flatMap((arm) => arm.overrides.filter((o) => o.tag === tag)))];
  const byName = new Map<string, VariableInfo>();
  for (const variable of pins.flatMap((pin) => pin.variables as SlotVariable[])) {
    const held = byName.get(variable.name);
    // Required in any arm is required for the step; the first default seen is shown.
    byName.set(variable.name, {
      name: variable.name,
      required: (held?.required ?? false) || variable.required,
      trust: held?.trust === "end_user" || variable.trust === "end_user" ? "end_user" : "operator",
      ...(held?.default !== undefined ? { default: held.default } : variable.default !== undefined ? { default: variable.default } : {}),
    });
  }
  return [...byName.values()];
}

const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);

export function rolloutChanges(payload: ManifestPayload, previous: RolloutCursor | null, nowMs: number): { events: RolloutEvent[]; cursor: RolloutCursor } {
  const at = new Date(nowMs).toISOString();
  const ordinals = new Map(servablePrompts(payload).map((slot) => [slot.tag, slot.versionOrdinal]));
  const cursor: RolloutCursor = { generation: payload.generation, slots: {} };
  const seen = new Map<string, { info: SlotInfo; content: { versionId: string; experiment: SlotInfo["experiment"]; disabled: boolean } }>();
  for (const info of slotsOf(payload, nowMs)) {
    const weights = info.experiment?.arms.map((arm) => arm.weightBps) ?? [];
    const content = { versionId: info.versionId, experiment: info.experiment, disabled: info.disabled };
    cursor.slots[info.slot] = { digest: sha(content), versionId: info.versionId, ordinal: ordinals.get(info.slot) ?? null, experimentId: info.experiment?.experimentId ?? null, weights, disabled: info.disabled };
    seen.set(info.slot, { info, content });
  }
  // The comparison is the SDK's (`diffReleases`); what is platform-facing here is the event id, the sentence and the split.
  const events = diffReleases(previous?.slots ?? null, cursor.slots).map((diff): RolloutEvent => {
    const prev = diff.previous;
    if (diff.change === "removed") {
      return { id: `${diff.slot}:${sha({ removed: prev!.digest, generation: payload.generation })}:removed`, slot: diff.slot, state: "removed", summary: `${diff.slot} is no longer in the release`, generation: payload.generation, versionId: null, previousVersionId: prev?.versionId ?? null, experiment: null, at };
    }
    const { info, content } = seen.get(diff.slot)!;
    return {
      id: `${info.slot}:${sha({ content, generation: payload.generation })}:${diff.change}`,
      slot: info.slot,
      state: diff.change,
      summary: summaryOf(info, diff.change, prev?.versionId ?? null),
      generation: payload.generation,
      versionId: info.versionId,
      previousVersionId: prev?.versionId ?? null,
      experiment: info.experiment,
      at,
    };
  });
  return { events, cursor };
}

function summaryOf(info: SlotInfo, state: RolloutState, previousVersionId: string | null): string {
  const split = info.experiment ? info.experiment.arms.map((arm) => `${arm.arm} ${arm.weightBps / 100}%`).join(", ") : "";
  switch (state) {
    case "current": return `${info.slot} serves ${info.versionId}${split ? ` (A/B: ${split})` : ""}`;
    case "new_version": return `${info.slot}: ${previousVersionId ? `${previousVersionId} → ` : ""}${info.versionId} approved`;
    case "rolled_back": return `${info.slot} rolled back to ${info.versionId}${previousVersionId ? ` from ${previousVersionId}` : ""}`;
    case "ab_started": return `${info.slot}: A/B started (${split})`;
    case "ab_ended": return `${info.slot}: A/B ended, serving ${info.versionId}`;
    case "disabled": return `${info.slot} disabled`;
    case "enabled": return `${info.slot} enabled again, serving ${info.versionId}`;
    default: return `${info.slot}: dial-up now ${split}`;
  }
}
