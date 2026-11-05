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

import { SUPPORTED_CAPABILITIES } from "./capabilities.js";
import type { Experiment, ExperimentArm, ManifestPayload, RampStep } from "./types.js";

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

/** Audience targeting (`protocol/audiences.md`): a condition tree evaluated locally. Values never leave this process. */
export type AudienceCondition =
  | { all: readonly AudienceCondition[] }
  | { any: readonly AudienceCondition[] }
  | { not: AudienceCondition }
  | { key: string; is: string }
  | { key: string; contains: string }
  | { key: string; in: readonly string[] }
  | { key: string; range: { gte?: number; lt?: number } };
export type AudienceSelector = { mode: "all" } | { mode: "when"; when: AudienceCondition };
export interface AudienceSnapshot { audienceId: string; selector: AudienceSelector }
export interface AudienceObservation extends AudienceSnapshot { tag: string; observeFrom: string }
/** A leaf alone is depth 1; each `all`, `any` or `not` adds one. */
export const AUDIENCE_LIMITS = { maxDepth: 4, maxLeaves: 32, maxGroupItems: 16, maxInValues: 64 } as const;
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
const AUDIENCE_DECIMAL = /^-?[0-9]+(?:\.[0-9]+)?$/;
const own = (v: object, key: string) => Object.prototype.hasOwnProperty.call(v, key);
function validAudienceCondition(c: unknown, depth: number, leaves: { count: number }): boolean {
  if (!audienceObject(c) || depth > AUDIENCE_LIMITS.maxDepth) return false;
  const names = Object.keys(c);
  if (names.length === 1 && (names[0] === "all" || names[0] === "any")) {
    const items = c[names[0]];
    return Array.isArray(items) && items.length >= 1 && items.length <= AUDIENCE_LIMITS.maxGroupItems && items.every((item) => validAudienceCondition(item, depth + 1, leaves));
  }
  if (names.length === 1 && names[0] === "not") return validAudienceCondition(c.not, depth + 1, leaves);
  if (names.length !== 2 || !validAudienceKey(c.key)) return false;
  leaves.count += 1;
  if (own(c, "is")) return audienceString(c.is, 256);
  if (own(c, "contains")) return audienceString(c.contains, 256) && (c.contains as string).length > 0;
  if (own(c, "in")) return Array.isArray(c.in) && c.in.length >= 1 && c.in.length <= AUDIENCE_LIMITS.maxInValues && c.in.every((value) => audienceString(value, 256)) && new Set(c.in).size === c.in.length;
  if (!own(c, "range") || !audienceObject(c.range) || !audienceKeys(c.range, ["gte", "lt"])) return false;
  const bounds = Object.values(c.range);
  return bounds.length >= 1 && bounds.every((bound) => Number.isSafeInteger(bound));
}
export function validAudienceSelector(v: unknown): v is AudienceSelector {
  if (!audienceObject(v)) return false;
  if (v.mode === "all") return audienceKeys(v, ["mode"]);
  if (v.mode !== "when" || !audienceKeys(v, ["mode", "when"])) return false;
  const leaves = { count: 0 };
  return validAudienceCondition(v.when, 1, leaves) && leaves.count <= AUDIENCE_LIMITS.maxLeaves;
}
function conditionMatches(c: AudienceCondition, tags: Readonly<Record<string, string>>): boolean {
  if ("all" in c) return c.all.every((item) => conditionMatches(item, tags));
  if ("any" in c) return c.any.some((item) => conditionMatches(item, tags));
  if ("not" in c) return !conditionMatches(c.not, tags);
  // A missing key is false for every leaf.
  if (!own(tags, c.key) || !audienceString(tags[c.key], 256)) return false;
  const value = tags[c.key]!;
  if ("is" in c) return value === c.is;
  if ("contains" in c) return value.includes(c.contains);
  if ("in" in c) return c.in.includes(value);
  if (!AUDIENCE_DECIMAL.test(value)) return false;
  const number = Number(value);
  return Number.isFinite(number) && (c.range.gte === undefined || number >= c.range.gte) && (c.range.lt === undefined || number < c.range.lt);
}
/** Invalid/missing values never broaden targeting. Values never leave this local operation. */
export function matchesAudience(selector: AudienceSelector, tags: Readonly<Record<string,string>>): boolean {
  if (!validAudienceSelector(selector)) return false;
  return selector.mode === "all" || conditionMatches(selector.when, tags);
}
export function copyAudienceTags(tags: Readonly<Record<string,string>>): Readonly<Record<string,string>> {
  if (!audienceObject(tags) || Object.keys(tags).length > 64 || Object.entries(tags).some(([k,v]) => !validAudienceKey(k) || !audienceString(v,256))) throw new Error("audience_tags_invalid");
  return Object.freeze(Object.fromEntries(Object.entries(tags)));
}
const capabilitiesMet = (entry: { requires?: readonly string[] }) => entry.requires === undefined || (Array.isArray(entry.requires) && entry.requires.every((name) => SUPPORTED_CAPABILITIES.has(name)));
/**
 * A slot whose `requires` this SDK does not fully implement is absent: skipped, not validated, its payload not fetched
 * (`protocol/trust-chain.md` › Slots a reader cannot serve). Every read of `payload.slots` for serving goes through this.
 */
export function servableSlots<S extends { requires?: readonly string[] }>(payload: { slots: readonly S[] }): readonly S[] {
  return payload.slots.filter((slot) => audienceObject(slot) && capabilitiesMet(slot));
}
/** An arm's overrides this SDK can serve. An unmet override of another tag goes alone; one of the experiment's own tag takes the experiment with it (`servableExperiments`). */
export function servableOverrides<O extends { requires?: readonly string[] }>(arm: { overrides?: readonly O[] }): readonly O[] {
  return Array.isArray(arm.overrides) ? arm.overrides.filter((override) => audienceObject(override) && capabilitiesMet(override)) : [];
}
/**
 * An arm that loses the override of the experiment's own tag has nothing to serve. Relabelling its share as control, or
 * keeping the candidate label over base text, would skew gate and SRM evidence on a mixed fleet, so the host sits the
 * experiment out: base text, arm none, bucket null, never evidence. A subject key it does not know does the same.
 */
function sitsOut(experiment: Experiment): boolean {
  // A subject key this reader does not know: it must not guess, and it must never hash by run.
  if (experiment.subjectKey !== "request" && experiment.subjectKey !== "instance") return true;
  return Array.isArray(experiment.arms) && experiment.arms.some((arm) => audienceObject(arm) && Array.isArray(arm.overrides) && arm.overrides.some((override) => audienceObject(override) && override.tag === experiment.tag && !capabilitiesMet(override)));
}
/** The experiments this SDK acts on: those naming a servable slot it does not sit out, each arm holding its servable overrides. */
export function servableExperiments(payload: Pick<ManifestPayload, "slots" | "experiments">): readonly Experiment[] {
  const tags = new Set(servableSlots(payload).map((slot) => slot.tag));
  const listed = Array.isArray(payload.experiments) ? payload.experiments : [];
  return listed.filter((experiment) => audienceObject(experiment) && tags.has(experiment.tag) && !sitsOut(experiment)).map((experiment) => (Array.isArray(experiment.arms) ? { ...experiment, arms: experiment.arms.map((arm) => (audienceObject(arm) ? { ...arm, overrides: [...servableOverrides(arm)] } : arm)) } : experiment));
}
/**
 * Every arm of the experiment naming this tag is disabled and this run is in its audience. Read from the raw list, so a
 * freeze stops a host that sits the experiment out too. An audience this reader cannot read matches nothing.
 */
export function frozenExperiment(payload: Pick<ManifestPayload, "experiments">, arms: (experimentId: string) => ReadonlySet<string>, tag: string, tags: Readonly<Record<string, string>>): boolean {
  const raw = (Array.isArray(payload.experiments) ? payload.experiments : []).find((experiment) => audienceObject(experiment) && experiment.tag === tag);
  if (!raw || !Array.isArray(raw.arms) || raw.arms.length === 0) return false;
  const off = arms(raw.experimentId);
  if (!raw.arms.every((arm) => audienceObject(arm) && off.has(arm.arm))) return false;
  return raw.audience === undefined || matchesAudience(raw.audience?.selector, tags);
}
/** Every capability a manifest asks for is one this SDK implements (`capabilities.md`). */
export function capabilitiesImplemented(payload: Pick<ManifestPayload, "requiredCapabilities">): boolean {
  return (payload.requiredCapabilities ?? []).every((name) => SUPPORTED_CAPABILITIES.has(name));
}
/** The arms as this SDK will assign over them: well-formed weights, one control first, one override at most. */
function validArms(e: Experiment, p: ManifestPayload): boolean {
  if (!Array.isArray(e.arms) || e.arms.some(arm => !audienceObject(arm) || !Number.isInteger(arm.weightBps) || arm.weightBps < 0 || arm.weightBps > 10000 || typeof arm.arm !== "string" || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(arm.arm) || arm.arm.length > 32 || !Array.isArray(arm.overrides))) return false;
  return e.arms.length >= 2 && e.arms.length <= 8 && e.arms.reduce((sum,arm)=>sum+arm.weightBps,0) === 10000 && new Set(e.arms.map(arm=>arm.arm)).size === e.arms.length && e.arms[0]!.releaseDigest === p.releaseDigest && e.arms[0]!.overrides.length === 0 && e.arms.every(arm => arm.overrides.length <= 1);
}
/** The envelope: well-formed audiences and arms on the slots this SDK can serve. A manifest asking for a capability it lacks is refused after the signature instead. */
export function validAudienceManifest(p: ManifestPayload): boolean {
  if (p.experiments !== undefined && (!Array.isArray(p.experiments) || p.experiments.length > 32 || p.experiments.some(e => !audienceObject(e)))) return false;
  if (!Array.isArray(p.slots) || p.observations !== undefined && (!Array.isArray(p.observations) || p.observations.length < 1 || p.observations.length > 8)) return false;
  const served = servableSlots(p);
  // An observation on a skipped slot is skipped with it; one naming no slot at all is refused below.
  const observations = (p.observations ?? []).filter((o) => !audienceObject(o) || served.some((s) => s.tag === o.tag) || !p.slots.some((s) => audienceObject(s) && s.tag === o.tag));
  const ids = new Set<string>();
  for (const o of observations) {
    if (!audienceObject(o) || !validAudienceIds([o.audienceId]) || ids.has(o.audienceId) || !served.some(s => s.tag === o.tag) || !validAudienceInstant(o.observeFrom)) return false;
    ids.add(o.audienceId);
  }
  // A selector this reader cannot read loads and matches nothing (`matchesAudience`): unknown is not malformed. The id and the fingerprint stay integrity checks.
  const fingerprint = (s: AudienceSelector) => JSON.stringify(s);
  return servableExperiments(p).every(e => {
    if (!validArms(e, p)) return false;
    if (e.audience === undefined) return true;
    const a = e.audience;
    if (!a || !audienceObject(a)) return false;
    const o = observations.find(o => o.audienceId === a.audienceId && o.tag === e.tag);
    return !!o && fingerprint(o.selector) === fingerprint(a.selector);
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

/** What `disable` directives say, as data. An arm-scoped disable always names its experiment (M15). */
export function disabledFrom(directives: readonly import("./types.js").Directive[]): {agent:boolean;slots:string[];armsByExperiment:Record<string,string[]>} {
  const slots: string[] = [];
  const armsByExperiment: Record<string, string[]> = {};
  let agent = false;
  for (const directive of directives) {
    if (directive.kind !== "disable") continue;
    if (directive.scope === "agent") agent = true;
    else if (directive.scope === "arm") {
      if (directive.arm && directive.experimentId) (armsByExperiment[directive.experimentId] ??= []).push(directive.arm);
    } else if (directive.tag) slots.push(directive.tag);
  }
  return { agent, slots, armsByExperiment };
}


/** The block as handed out: a copy, frozen — a caller that edits it edits nothing the runtime holds. */
export function snapshotInference(inference: import("./types.js").SlotInference): import("./types.js").SlotInference {
  return Object.freeze({ ...inference, ...(inference.stopSequences ? { stopSequences: Object.freeze([...inference.stopSequences]) } : {}) }) as import("./types.js").SlotInference;
}
