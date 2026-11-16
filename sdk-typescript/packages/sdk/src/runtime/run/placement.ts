/**
 * A slot's first placement: resolve on the data path (never the facade's
 * throwing `resolveSlot`), then render with the run's variables. Every
 * refusal is data: a passthrough with its reason. A render failure keeps the
 * version it failed on, so the run writes one error row against it and the
 * gates see a broken candidate.
 *
 * @example
 * ```ts
 * const pin = await placeSlot("support.reply", { host, subject, tags, values, resolved: undefined });
 * if (pin.placement.kind === "approved") pin.entry; // the slot's run reference entry
 * ```
 */

import type { ErrorClass, ReleaseSlot, RunDimensions, RunRefEntry } from "../../core/index.js";
import type { ReleaseResolver } from "../release/resolver.js";
import { fillAsync, planFill } from "../variables/fill.js";
import type { RunHost } from "./ports.js";
import type { Placement, UnavailableReason } from "./types.js";

/** A resolved slot: what `resolver.resolve` answers when it serves, and what the facade's `resolveSlot` returns. */
export type Resolved = ReleaseSlot & { audienceIds?: readonly string[]; runMinute?: string };

export interface SlotPin {
  placement: Placement;
  /** The version the slot's run row is written against. Absent for a passthrough that never chose a version. */
  dims?: RunDimensions;
  /** The run reference entry, for an approved prompt. */
  entry?: RunRefEntry;
  /** What `resolve` chose, so the direct path and `place` share one pin. */
  resolved?: Resolved;
  /** A row error fixed at placement: the render failed on this version. */
  rowError?: ErrorClass;
  /** Pinned by the direct path (`ap.prompt`, `ap.workflow`): `place` has not rendered it. */
  direct?: true;
  /** Why the passthrough came about, for the log. Never a value. */
  detail?: Record<string, unknown>;
}

export const passthroughPin = (slot: string, reason: UnavailableReason, extra: Partial<SlotPin> = {}): SlotPin => ({ placement: { kind: "passthrough", slot, reason }, ...extra });

export function dimensionsOf(slot: string, resolved: Resolved): RunDimensions {
  return {
    tag: slot,
    artifactId: resolved.slot.artifactId,
    versionId: resolved.slot.versionId,
    arm: resolved.arm,
    model: resolved.slot.model,
    ...(resolved.audienceIds ? { audienceIds: resolved.audienceIds } : {}),
    ...(resolved.runMinute ? { runMinute: resolved.runMinute } : {}),
  };
}

export function entryOf(slot: string, resolved: Resolved, runMinute: string): RunRefEntry {
  return {
    tag: slot,
    artifactId: resolved.slot.artifactId,
    versionId: resolved.slot.versionId,
    model: resolved.slot.model,
    arm: resolved.arm,
    bucket: resolved.bucket,
    runMinute: resolved.runMinute ?? runMinute,
    ...(resolved.audienceIds ? { audienceIds: resolved.audienceIds } : {}),
  };
}

export interface PlaceContext {
  host: RunHost;
  subject: string;
  /** Read at this slot's first placement, so a late tag reaches it. */
  tags: () => Readonly<Record<string, string>>;
  values: Readonly<Record<string, string | number | boolean | null>>;
  /** A version the direct path already chose for this slot in this run. */
  resolved: Resolved | undefined;
}

/** Resolve and render one slot. Never throws. */
export async function placeSlot(slot: string, context: PlaceContext): Promise<SlotPin> {
  const { host } = context;
  const release = host.release();
  if (!("resolver" in release)) return passthroughPin(slot, release.unavailable);
  const { resolver } = release;
  let resolved = context.resolved;
  if (!resolved) {
    const outcome = resolver.resolve(slot, context.subject, context.tags());
    if (!outcome.ok) {
      if (outcome.reason === "no_slot") return passthroughPin(slot, "no_slot");
      host.stampDisabled(resolver.release.generation, outcome.tag);
      return passthroughPin(slot, "slot_disabled");
    }
    const { ok: _ok, ...served } = outcome;
    resolved = served;
  }
  if (resolved.slot.kind !== "prompt") return passthroughPin(slot, "slot_kind_unsupported");
  return render(slot, resolver, resolved, context);
}

async function render(slot: string, resolver: ReleaseResolver, resolved: Resolved, context: PlaceContext): Promise<SlotPin> {
  const dims = dimensionsOf(slot, resolved);
  try {
    const text = resolver.textOf(resolved.slot);
    const plan = planFill({ tag: slot, variables: resolved.slot.variables, text, values: context.values, registry: context.host.variables });
    const filled = await fillAsync(plan, { tag: slot, subject: context.subject, versionId: resolved.slot.versionId, arm: resolved.arm }, context.host.variables);
    const rendered = resolver.render(resolved, filled.values, { fenced: filled.fenced, text });
    return {
      placement: { kind: "approved", slot, instructions: rendered.text, model: rendered.model, settings: rendered.inference ?? {} },
      dims: { ...dims, ...(rendered.runMinute ? { runMinute: rendered.runMinute } : {}) },
      entry: entryOf(slot, resolved, rendered.runMinute ?? ""),
      resolved,
    };
  } catch (error) {
    return passthroughPin(slot, "variables_unfilled", { dims, resolved, rowError: "render_missing_variable", detail: { error: (error as Error).name } });
  }
}
