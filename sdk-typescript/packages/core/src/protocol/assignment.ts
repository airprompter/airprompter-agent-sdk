/**
 * Sticky assignment (`protocol/assignment-hash.md`): SHA-256(salt ‖ subject), first 8 bytes big-endian mod 10000,
 * cumulative weights. The same subject lands in the same bucket on every host and in every SDK, so an A/B is one A/B
 * wherever it runs; the signed ramp plan (S9) only moves the weights the bucket is read against.
 *
 * @example
 * ```ts
 * const arms = effectiveArms({ arms: experiment.arms, ramp: experiment.ramp, disabledArms, nowMs: Date.now() });
 * if (arms === null) return refuse("disabled"); // every arm disabled: the slot is frozen
 * const { arm, bucket } = assignArm({ salt: experiment.salt, subject: userId, arms }); // bucket in 0…9999, arm by cumulative weight
 * ```
 */

import { createHash } from "node:crypto";

import type { ExperimentArm, RampStep } from "./types.js";

export const ASSIGNMENT_MODULUS = 10000;
// 128 bits of salt: a bucket that leaks cannot be reversed by hashing candidate subjects.
const MIN_SALT_BYTES = 16;
/** S9: ramp steps are at least this far apart, and at most this many. */
export const RAMP_MIN_STEP_MS = 60 * 60 * 1000;
export const RAMP_MAX_STEPS = 8;

export type AssignmentRefusal = "salt_invalid" | "too_few_arms" | "weight_invalid" | "weights_not_10000" | "ramp_invalid";

export class AssignmentError extends Error {
  constructor(readonly reason: AssignmentRefusal) {
    super(reason);
    this.name = "AssignmentError";
  }
}

/** `AssignmentError` by name — true for one thrown by another copy of this package too (S1). */
export function isAssignmentError(error: unknown): error is AssignmentError {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AssignmentError" && typeof (error as { reason?: unknown }).reason === "string";
}

export function validateArms(arms: readonly Pick<ExperimentArm, "arm" | "weightBps">[]): void {
  if (arms.length < 2) throw new AssignmentError("too_few_arms");
  let total = 0;
  for (const arm of arms) {
    if (!Number.isInteger(arm.weightBps) || arm.weightBps < 0) throw new AssignmentError("weight_invalid");
    total += arm.weightBps;
  }
  if (total !== ASSIGNMENT_MODULUS) throw new AssignmentError("weights_not_10000");
}

export function subjectHash(salt: string, subject: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(salt)) throw new AssignmentError("salt_invalid");
  const saltBytes = Buffer.from(salt, "base64url");
  if (saltBytes.length < MIN_SALT_BYTES) throw new AssignmentError("salt_invalid");
  return createHash("sha256").update(saltBytes).update(Buffer.from(subject, "utf8")).digest("hex");
}

export function bucketFromHash(hex: string): number {
  return Number(BigInt(`0x${hex.slice(0, 16)}`) % BigInt(ASSIGNMENT_MODULUS));
}

export function armForBucket<A extends Pick<ExperimentArm, "arm" | "weightBps">>(bucket: number, arms: readonly A[]): A {
  let cumulative = 0;
  for (const arm of arms) {
    cumulative += arm.weightBps;
    if (bucket < cumulative) return arm;
  }
  return arms[arms.length - 1]!;
}

export function assignArm<A extends Pick<ExperimentArm, "arm" | "weightBps">>(input: { salt: string; subject: string; arms: readonly A[] }): { subjectHash: string; bucket: number; arm: A } {
  validateArms(input.arms);
  const hash = subjectHash(input.salt, input.subject);
  const bucket = bucketFromHash(hash);
  return { subjectHash: hash, bucket, arm: armForBucket(bucket, input.arms) };
}

// ---------------------------------------------------------------------------
// S9: the signed ramp plan (assignment-hash.md › The ramp plan)
// ---------------------------------------------------------------------------

const parseInstant = (text: string): number => {
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new AssignmentError("ramp_invalid");
  return ms;
};

/** The plan's shape: 1–8 steps, strictly increasing, ≥ 1 h apart, one integer weight per arm each summing to 10000. */
export function validateRamp(ramp: readonly RampStep[] | undefined, armCount: number): void {
  if (ramp === undefined) return;
  if (!Array.isArray(ramp) || ramp.length < 1 || ramp.length > RAMP_MAX_STEPS) throw new AssignmentError("ramp_invalid");
  let previous: number | null = null;
  for (const step of ramp) {
    if (!step || typeof step !== "object" || typeof step.notBefore !== "string" || !Array.isArray(step.weightBps)) throw new AssignmentError("ramp_invalid");
    const at = parseInstant(step.notBefore);
    if (previous !== null && at - previous < RAMP_MIN_STEP_MS) throw new AssignmentError("ramp_invalid");
    previous = at;
    if (step.weightBps.length !== armCount) throw new AssignmentError("ramp_invalid");
    let total = 0;
    for (const weight of step.weightBps) {
      if (!Number.isInteger(weight) || weight < 0) throw new AssignmentError("ramp_invalid");
      total += weight;
    }
    if (total !== ASSIGNMENT_MODULUS) throw new AssignmentError("ramp_invalid");
  }
}

/** The weights in force at `nowMs`: the last step whose `notBefore` has passed (inclusive), else the arms' own. */
export function rampWeightsAt(arms: readonly Pick<ExperimentArm, "weightBps">[], ramp: readonly RampStep[] | undefined, nowMs: number): number[] {
  let weights = arms.map((arm) => arm.weightBps);
  for (const step of ramp ?? []) {
    if (parseInstant(step.notBefore) <= nowMs) weights = [...step.weightBps];
  }
  return weights;
}

/**
 * The arms as they stand at `nowMs`: the plan's weights, then any disabled arm's share handed to the first arm in manifest
 * order that is not disabled (the control). Every arm disabled is the caller's agent-level refusal (null).
 */
export function effectiveArms<A extends Pick<ExperimentArm, "arm" | "weightBps">>(input: { arms: readonly A[]; ramp?: readonly RampStep[] | undefined; disabledArms?: ReadonlySet<string> | undefined; nowMs: number }): A[] | null {
  const weights = rampWeightsAt(input.arms, input.ramp, input.nowMs);
  const disabled = input.disabledArms ?? new Set<string>();
  const firstLive = input.arms.findIndex((arm) => !disabled.has(arm.arm));
  if (firstLive === -1) return null;
  let reassigned = 0;
  const effective = input.arms.map((arm, index) => {
    if (!disabled.has(arm.arm)) return { ...arm, weightBps: weights[index]! };
    reassigned += weights[index]!;
    return { ...arm, weightBps: 0 };
  });
  effective[firstLive] = { ...effective[firstLive]!, weightBps: effective[firstLive]!.weightBps + reassigned };
  return effective;
}

export class StepError extends Error {
  constructor(readonly reason: "slot_tag_grammar" | "step_ordinal_gap" | "step_tag_mismatch") {
    super(reason);
    this.name = "StepError";
  }
}

/** Workflow steps: 1-based, contiguous, tagged `<tag>#<ordinal>`; yielded in ordinal order. */
export function orderedSteps<S extends { stepId: string; ordinal: number }>(slotTag: string, steps: readonly S[]): S[] {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(slotTag)) throw new StepError("slot_tag_grammar");
  const sorted = [...steps].sort((a, b) => a.ordinal - b.ordinal);
  sorted.forEach((step, index) => {
    if (step.ordinal !== index + 1) throw new StepError("step_ordinal_gap");
    if (step.stepId !== `${slotTag}#${step.ordinal}`) throw new StepError("step_tag_mismatch");
  });
  return sorted;
}
