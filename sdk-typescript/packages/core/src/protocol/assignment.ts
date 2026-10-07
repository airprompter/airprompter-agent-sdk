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

/** 1.1.x: local predicates. Missing operator is legacy `is`; new manifests write it explicitly. */
export type AudienceCondition = { key: string; operator?: "is" | "contains"; value: string };
export type AudienceSelector = { mode: "all" } | { mode: "tags"; match: "all" | "any"; conditions: AudienceCondition[] };
export interface AudienceSnapshot { audienceId: string; selector: AudienceSelector }
export interface AudienceObservation extends AudienceSnapshot { tag: string; observeFrom: string }
export const AUDIENCE_CAPABILITY = "audience_v2";
export const AUDIENCE_PROTOCOL_VERSION = "1.1.1";
export const PREVIOUS_AUDIENCE_PROTOCOL_VERSION = "1.1.0";
export const LEGACY_AUDIENCE_CAPABILITY = "audience_v1";
export const LEGACY_AUDIENCE_PROTOCOL_VERSION = "1.0.0";
const audienceObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const audienceKeys = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const audienceString = (v: unknown, max: number) => typeof v === "string" && [...v].length <= max && !/[\u0000-\u001f\u007f]/u.test(v) && !/[\uD800-\uDFFF]/u.test(v);
/** RFC 3339 calendar validity: Date.parse alone normalizes impossible dates. */
export function validAudienceInstant(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) || v.startsWith("0000-") || !Number.isFinite(Date.parse(v))) return false;
  const offset = /[+-](\d{2}):(\d{2})$/.exec(v);
  if (offset && (Number(offset[1]) > 23 || Number(offset[2]) > 59)) return false;
  const date = v.slice(0,10), midnight = Date.parse(date+"T00:00:00Z");
  return Number.isFinite(midnight) && new Date(midnight).toISOString().slice(0,10) === date && Number(v.slice(11,13)) < 24 && Number(v.slice(14,16)) < 60 && Number(v.slice(17,19)) < 60;
}
export const validAudienceMinute = (v:unknown):v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z$/.test(v) && validAudienceInstant(v);
export const validAudienceKey = (v: unknown): v is string => audienceString(v,64) && (v as string).trim().length > 0;
export const validAudienceLabel = (v: unknown): v is string => audienceString(v,128) && (v as string).trim().length > 0;
export const validAudienceIds = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 8 && v.every((id,i) => typeof id === "string" && /^aud_[A-Za-z0-9_-]{22}$/.test(id) && (i === 0 || v[i-1] < id));
export function validAudienceSelector(v: unknown): v is AudienceSelector {
  if (!audienceObject(v)) return false;
  if (v.mode === "all") return audienceKeys(v,["mode"]);
  if (v.mode !== "tags" || !audienceKeys(v,["mode","match","conditions"]) || !["all","any"].includes(String(v.match)) || !Array.isArray(v.conditions) || v.conditions.length < 1 || v.conditions.length > 16) return false;
  const pairs = new Set<string>();
  return v.conditions.every(c => {
    if (!audienceObject(c) || !audienceKeys(c,["key","operator","value"]) || !validAudienceKey(c.key) || (c.operator !== undefined && c.operator !== "is" && c.operator !== "contains") || !audienceString(c.value,256) || (c.operator === "contains" && (c.value as string).length === 0)) return false;
    const pair = JSON.stringify([c.key,c.operator ?? "is",c.value]);
    if (pairs.has(pair)) return false;
    pairs.add(pair); return true;
  });
}
/** Invalid/missing values never broaden targeting. Values never leave this local operation. */
export function matchesAudience(selector: AudienceSelector, tags: Readonly<Record<string,string>>): boolean {
  if (!validAudienceSelector(selector)) return false;
  if (selector.mode === "all") return true;
  const matches = (c: AudienceCondition) => {
    if (!Object.prototype.hasOwnProperty.call(tags,c.key) || !audienceString(tags[c.key],256)) return false;
    return c.operator === "contains" ? tags[c.key]!.includes(c.value) : tags[c.key] === c.value;
  };
  return selector.match === "all" ? selector.conditions.every(matches) : selector.conditions.some(matches);
}
export function copyAudienceTags(tags: Readonly<Record<string,string>>): Readonly<Record<string,string>> {
  if (!audienceObject(tags) || Object.keys(tags).length > 64 || Object.entries(tags).some(([k,v]) => !validAudienceKey(k) || !audienceString(v,256))) throw new Error("audience_tags_invalid");
  return Object.freeze(Object.fromEntries(Object.entries(tags)));
}
/** Refuse an unknown/malformed targeted wire before applying payloads; preserve legacy manifests. */
export function validAudienceManifest(p: import("./types.js").ManifestPayload): boolean {
  if (p.experiments !== undefined && !Array.isArray(p.experiments)) return false;
  const experiments = p.experiments ?? [];
  if (experiments.some(e => !audienceObject(e))) return false;
  const targeted = p.requiredCapabilities !== undefined || p.observations !== undefined || experiments.some(e => e.audience !== undefined) || (audienceObject(p.experiment) && p.experiment.audience !== undefined);
  // Major 0 remains legacy-compatible. Major 1 always requires its frozen audience negotiation envelope.
  if (!targeted) return Number(String(p.protocol).split(".")[0]) !== 1;
  const supportedEnvelope = ((p.protocol === AUDIENCE_PROTOCOL_VERSION || p.protocol === PREVIOUS_AUDIENCE_PROTOCOL_VERSION) && JSON.stringify(p.requiredCapabilities) === JSON.stringify([AUDIENCE_CAPABILITY])) || (p.protocol === LEGACY_AUDIENCE_PROTOCOL_VERSION && JSON.stringify(p.requiredCapabilities) === JSON.stringify([LEGACY_AUDIENCE_CAPABILITY]));
  if (!supportedEnvelope || p.experiment !== undefined || !Array.isArray(p.observations) || p.observations.length < 1 || p.observations.length > 8 || !Array.isArray(p.slots) || experiments.length > 32) return false;
  const selectors = [...p.observations, ...experiments.map((entry) => entry.audience)].map((entry) => audienceObject(entry) ? entry.selector : null);
  // v1 has no operator. v2 is the approved minimal model: implicit AND, with every condition explicit.
  if (p.protocol === LEGACY_AUDIENCE_PROTOCOL_VERSION && selectors.some((selector) => {
    const candidate = selector as unknown;
    return audienceObject(candidate) && Array.isArray(candidate.conditions) && candidate.conditions.some((condition: unknown) => audienceObject(condition) && condition.operator !== undefined);
  })) return false;
  if ((p.protocol === AUDIENCE_PROTOCOL_VERSION || p.protocol === PREVIOUS_AUDIENCE_PROTOCOL_VERSION) && selectors.some((selector) => audienceObject(selector) && selector.mode === "tags" && (selector.match !== "all" || !Array.isArray(selector.conditions) || selector.conditions.some((condition: unknown) => !audienceObject(condition) || condition.operator === undefined)))) return false;
  const ids = new Set<string>();
  for (const o of p.observations) {
    if (!audienceObject(o) || !audienceKeys(o,["audienceId","selector","tag","observeFrom"]) || !validAudienceIds([o.audienceId]) || !validAudienceSelector(o.selector) || ids.has(o.audienceId) || !p.slots.some(s => audienceObject(s) && s.tag === o.tag) || !validAudienceInstant(o.observeFrom)) return false;
    ids.add(o.audienceId);
  }
  const fingerprint = (s: AudienceSelector) => JSON.stringify(s);
  return experiments.every(e => {
    if (!Array.isArray(e.arms) || e.arms.some(arm => !audienceObject(arm) || !Number.isInteger(arm.weightBps) || arm.weightBps < 0 || arm.weightBps > 10000 || typeof arm.arm !== "string" || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(arm.arm) || arm.arm.length > 32 || !Array.isArray(arm.overrides))) return false;
    const a = e.audience;
    if (!a || !audienceObject(a) || !audienceKeys(a,["audienceId","selector"]) || !validAudienceSelector(a.selector)) return false;
    const o = p.observations!.find(o => o.audienceId === a.audienceId && o.tag === e.tag);
    return !!o && fingerprint(o.selector) === fingerprint(a.selector) && e.arms.length >= 2 && e.arms.length <= 8 && e.arms.reduce((sum,arm)=>sum+arm.weightBps,0) === 10000 && new Set(e.arms.map(arm=>arm.arm)).size === e.arms.length && e.arms[0]!.releaseDigest === p.releaseDigest && e.arms[0]!.overrides.length === 0 && e.arms.every(arm => arm.overrides.every(pin => audienceObject(pin) && pin.tag === e.tag) && arm.overrides.length <= 1);
  });
}
/** Multiple memberships annotate one run; fleet folding must not add them together. */
export function capturedAudienceIds(observations: readonly AudienceObservation[], tag: string, tags: Readonly<Record<string,string>>, nowMs: number): string[] {
  return observations.filter(o => o.tag === tag && Date.parse(o.observeFrom) <= nowMs && matchesAudience(o.selector,tags)).map(o=>o.audienceId).sort();
}

/** Text-only attribution is unsafe when identical text names distinct original cohorts. */
export function ambiguousAudienceAttribution(previous: {tag:string;artifactId?:string;versionId:string;arm:string;audienceIds?:readonly string[];runMinute?:string} | null | undefined, next: {tag:string;artifactId?:string;versionId:string;arm:string;audienceIds?:readonly string[];runMinute?:string}): boolean {
  if (previous === null) return true;
  if (previous === undefined) return false;
  if (previous.artifactId === undefined && next.artifactId === undefined && previous.audienceIds === undefined && next.audienceIds === undefined) return false;
  return JSON.stringify([previous.tag,previous.artifactId,previous.versionId,previous.arm,previous.audienceIds]) !== JSON.stringify([next.tag,next.artifactId,next.versionId,next.arm,next.audienceIds]);
}

/** What `disable` directives say, as data. */
export function disabledFrom(directives: readonly import("./types.js").Directive[]): {agent:boolean;slots:string[];arms:string[];armsByExperiment:Record<string,string[]>} {
  const slots: string[] = [];
  const arms: string[] = [];
  const armsByExperiment: Record<string, string[]> = {};
  let agent = false;
  for (const directive of directives) {
    if (directive.kind !== "disable") continue;
    if (directive.scope === "agent") agent = true;
    else if (directive.scope === "arm" && directive.arm) {
      if (directive.experimentId) (armsByExperiment[directive.experimentId] ??= []).push(directive.arm);
      else arms.push(directive.arm);
    } else if (directive.tag) slots.push(directive.tag);
  }
  return { agent, slots, arms, armsByExperiment };
}


/** The block as handed out: a copy, frozen — a caller that edits it edits nothing the runtime holds. */
export function snapshotInference(inference: import("./types.js").SlotInference): import("./types.js").SlotInference {
  return Object.freeze({ ...inference, ...(inference.stopSequences ? { stopSequences: Object.freeze([...inference.stopSequences]) } : {}) }) as import("./types.js").SlotInference;
}
