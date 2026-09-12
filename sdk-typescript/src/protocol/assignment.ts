/** Sticky assignment (`protocol/assignment-hash.md`): SHA-256(salt ‖ subject), first 8 bytes big-endian mod 10000, cumulative weights. */

import { createHash } from "node:crypto";

import type { ExperimentArm } from "./types.js";

export const ASSIGNMENT_MODULUS = 10000;
const MIN_SALT_BYTES = 16;

export type AssignmentRefusal = "salt_invalid" | "too_few_arms" | "weight_invalid" | "weights_not_10000";

export class AssignmentError extends Error {
  constructor(readonly reason: AssignmentRefusal) {
    super(reason);
    this.name = "AssignmentError";
  }
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
