/**
 * The runtime over a verified release (S10): which slot a subject gets,
 * under which arm — the signed ramp plan walked on this host's clock (S9),
 * a disabled arm's share handed to the control, a disabled agent or slot
 * refused — and the rendered text with its run reference. Pure over a
 * `LoadedRelease`: the slot store, a daemon, and a bundle the customer
 * loaded all look the same from here, and nothing here touches a file, a
 * socket or a clock it was not handed.
 *
 * The lease, the spool's refusal rows and the daemon's contact are the
 * facade's (`@airprompter/agent-sdk`): this class says *what* would be
 * refused and why; the facade decides what to record.
 *
 * @example
 * ```ts
 * const runtime = new ReleaseResolver({ release, runRefKey, agentId, target: "prod", instanceId, nowMs: Date.now });
 * const resolved = runtime.resolve("support.triage", userId); // sticky: the same user gets the same arm on every host
 * if (!resolved.ok) return refuse(resolved.reason); // "disabled" (a directive) | "no_slot"
 * const r = runtime.render(resolved, { team: "Billing", ticket: userMessage }); // ticket is end_user: fenced in the text
 * const flow = runtime.resolve("onboarding.flow");
 * if (flow.ok) runtime.workflow(flow).steps; // in ordinal order, each with its own text and runRef
 * ```
 */

import { randomBytes } from "node:crypto";
import { frozenExperiment, slotHashes, snapshotInference, disabledFrom, matchesAudience, capturedAudienceIds, minuteOf, assignArm, effectiveArms, mintRunRef, newRunId, orderedSteps, renderTemplate, servableExperiments, servableSlots, type Delimiters, type Directive, type Experiment, type ExperimentArm, type LoadedRelease, type Manifest, type ManifestSlot, type ReleaseSlot, type RunRefFacts, type SlotInference, type SlotVariable, type Target } from "../../core/index.js";

export interface Rendered {
  text: string;
  model: string;
  /** How the model is called for this slot, as the version declared it: the wrappers apply it. */
  inference?: SlotInference;
  artifactId: string;
  versionId: string;
  arm: string;
  generation: number;
  runRef: string;
  tag: string;
  /** Original cohort, frozen at render. */
  audienceIds?: readonly string[];
  runMinute?: string;
}

export interface Disabled {
  agent: boolean;
  slots: string[];
  /** S16: the arm names disabled per experiment id. */
  armsByExperiment: Record<string, string[]>;
}

/** S16: the arms disabled for one experiment. */
export function disabledArmsFor(disabled: Disabled, experimentId: string): Set<string> {
  return new Set(disabled.armsByExperiment[experimentId] ?? []);
}

export interface ResolverInput {
  release: LoadedRelease;
  tags?: () => Readonly<Record<string,string>>;
  /** The run reference key (`runRefKeyFrom`), so a ref minted on one instance parses on another. */
  runRefKey: Uint8Array;
  agentId: string;
  target: Target;
  /** The subject only when the experiment says `subjectKey: "instance"`. */
  instanceId: string;
  nowMs: () => number;
  delimiters?: Delimiters;
  /**
   * Directives that outrank the release's own: the facade keeps the latest verified manifest's directives standing
   * across a downgrade, so a `disable` issued on generation N still binds a host serving N-1.
   */
  standingDirectives?: { generation: number; directives: readonly Directive[] } | null;
}

export type ResolveOutcome = ({ ok: true; audienceIds?: readonly string[]; runMinute?: string } & ReleaseSlot) | { ok: false; reason: "disabled" | "no_slot"; tag: string | null };

export { disabledFrom } from "../../core/index.js";

/** An absent subject is a fresh id per call: hashing the instance would split instances, not users. */
export function newSubject(): string {
  return randomBytes(16).toString("hex");
}

export class ReleaseResolver {
  constructor(private readonly input: ResolverInput) {}

  get release(): LoadedRelease {
    return this.input.release;
  }

  private get payload(): Manifest["payload"] {
    return this.input.release.manifest.payload;
  }

  /** The directives in force: the standing set when it is as new as this release, else the release's own. */
  directives(): readonly Directive[] {
    const standing = this.input.standingDirectives;
    if (standing && standing.generation >= this.payload.generation) return standing.directives;
    return this.payload.directives;
  }

  disabled(): Disabled {
    return disabledFrom(this.directives());
  }

  /** S16: every experiment this host acts on: one per slot it can serve. */
  experiments(): readonly Experiment[] {
    return servableExperiments(this.payload);
  }

  /** A run this experiment would decide, with every arm disabled: refused, on a host that sits the experiment out too. */
  frozen(tag: string, tags: Readonly<Record<string, string>>): boolean {
    return frozenExperiment(this.payload, (experimentId) => disabledArmsFor(this.disabled(), experimentId), tag, tags);
  }

  /** S16: the experiment that decides a slot, by tag, else null. */
  experimentFor(tag: string): Experiment | null {
    return this.experiments().find((experiment) => experiment.tag === tag) ?? null;
  }

  /**
   * S9: an experiment's arms as they stand now — the signed plan walked on this host's clock, then any disabled arm's
   * share handed to the control. Null when there is no such experiment, or when every arm is disabled (a freeze for
   * that slot). Without an argument: the first of `experiments[]`.
   */
  arms(experimentOrTag?: Experiment | string): ExperimentArm[] | null {
    const experiment = typeof experimentOrTag === "string" ? this.experimentFor(experimentOrTag) : (experimentOrTag ?? this.experiments()[0] ?? null);
    if (!experiment) return null;
    return effectiveArms({ arms: experiment.arms, ramp: experiment.ramp, disabledArms: disabledArmsFor(this.disabled(), experiment.experimentId), nowMs: this.input.nowMs() });
  }

  /** The slot a subject gets for a tag, or why not. Refusals are data: the facade records them. */
  resolve(tag: string, subject?: string, tagsOverride?: Readonly<Record<string,string>>): ResolveOutcome {
    const payload = this.payload;
    const now = this.input.nowMs();
    const tags = tagsOverride ?? this.input.tags?.() ?? {};
    const cohort = { runMinute: minuteOf(now), ...(payload.observations ? { audienceIds: Object.freeze(capturedAudienceIds(payload.observations,tag,tags,now)) } : {}) };
    const disabled = this.disabled();
    if (disabled.agent) return { ok: false, reason: "disabled", tag: null };
    if (disabled.slots.includes(tag)) return { ok: false, reason: "disabled", tag };
    // A slot carrying `requires` whose payload this release does not hold is absent (trust-chain.md M9).
    const present = (entry: ManifestSlot) => {
      if (entry.requires === undefined) return true;
      const hashes = [...slotHashes(entry).keys()];
      return hashes.length > 0 && hashes.every((hash) => this.input.release.payloads.has(hash));
    };
    let slot = servableSlots(payload).find((entry) => entry.tag === tag);
    if (!slot || !present(slot)) return { ok: false, reason: "no_slot", tag };
    // S16: the experiment for this slot — its own salt and arms, so two slots split independently.
    const experiment = this.experimentFor(tag);
    if (this.frozen(tag, tags)) return { ok: false, reason: "disabled", tag };
    // An own-tag override this release does not hold: sit out before assignment, so control runs here keep no candidate share.
    if (experiment?.arms.some((arm) => arm.overrides.some((entry) => entry.tag === tag && !present(entry)))) return { ok: true, slot, arm: "none", bucket: null, ...cohort };
    if (!experiment || (experiment.audience && !matchesAudience(experiment.audience.selector,tags))) return { ok: true, slot, arm: "none", bucket: null, ...cohort };
    const subjectValue = experiment.subjectKey === "instance" ? this.input.instanceId : subject ?? newSubject();
    const arms = this.arms(experiment);
    if (!arms) return { ok: false, reason: "disabled", tag };
    const assigned = assignArm({ salt: experiment.salt, subject: subjectValue, arms });
    const override = assigned.arm.overrides.find((entry) => entry.tag === tag);
    if (override) slot = override;
    return { ok: true, slot, arm: assigned.arm.arm, bucket: assigned.bucket, ...cohort };
  }

  /** A slot's verified payload as text. */
  textOf(slot: Pick<ManifestSlot, "contentHash">): string {
    const bytes = this.input.release.payloads.get(slot.contentHash);
    if (!bytes) throw new Error(`payload ${slot.contentHash} not loaded`);
    return Buffer.from(bytes).toString("utf8");
  }

  /** Render a resolved prompt. `fenced` can tighten declared trust; `text` avoids decoding a payload twice. */
  render(resolved: ReleaseSlot & {audienceIds?: readonly string[];runMinute?: string}, values: Record<string, string | number | boolean | null | undefined> = {}, options: { fenced?: ReadonlySet<string>; text?: string } = {}): Rendered {
    const { slot, arm, bucket } = resolved;
    const generation = this.input.release.generation;
    if (resolved.audienceIds && !resolved.runMinute) throw new Error("audience_cohort_invalid");
    const cohort = {runMinute: resolved.runMinute ?? minuteOf(this.input.nowMs()), ...(resolved.audienceIds ? {audienceIds: resolved.audienceIds} : {})};
    const text = this.renderText({ tag: slot.tag, text: options.text ?? this.textOf(slot), variables: slot.variables, values, fenced: options.fenced });
    const facts: RunRefFacts = { agentId: this.input.agentId, target: this.input.target, runId: newRunId(), entries: [{ tag: slot.tag, artifactId: slot.artifactId, versionId: slot.versionId, model: slot.model, arm, bucket, ...cohort }] };
    return { text, model: slot.model, ...(slot.inference ? { inference: snapshotInference(slot.inference) } : {}), artifactId: slot.artifactId, versionId: slot.versionId, arm, generation, runRef: mintRunRef(facts, Buffer.from(this.input.runRefKey)), tag: slot.tag, ...cohort };
  }

  /** Render prompt or workflow text with the slot declarations and configured delimiters. */
  renderText(input: { tag: string; text: string; variables: readonly SlotVariable[]; values: Record<string, string | number | boolean | null | undefined>; fenced?: ReadonlySet<string> | undefined }): string {
    const variables = input.fenced && input.fenced.size > 0 ? input.variables.map((variable) => (input.fenced!.has(variable.name) && variable.trust !== "end_user" ? { ...variable, trust: "end_user" as const } : variable)) : input.variables;
    return renderTemplate({ tag: input.tag, text: input.text, variables, values: input.values, ...(this.input.delimiters ? { delimiters: this.input.delimiters } : {}) });
  }

  /** A workflow slot's steps in ordinal order, each with its prompt text and run reference. */
  workflow(resolved: ReleaseSlot & {audienceIds?: readonly string[];runMinute?: string}): { model: string; arm: string; steps: Array<{ stepId: string; ordinal: number; artifactId: string; versionId: string; text: string; runRef: string; model: string; inference?: SlotInference; audienceIds?: readonly string[]; runMinute?: string }>; variables: ManifestSlot["variables"] } {
    const { slot, arm, bucket } = resolved;
    if (slot.kind !== "workflow" || !slot.steps) throw new Error(`${slot.tag} is not a workflow slot`);
    if (resolved.audienceIds && !resolved.runMinute) throw new Error("audience_cohort_invalid");
    const cohort = {runMinute: resolved.runMinute ?? minuteOf(this.input.nowMs()), ...(resolved.audienceIds ? {audienceIds: resolved.audienceIds} : {})};
    // One ref per step, one entry each, sharing one run id. The entry's tag is the slot's: rows never carry a step in `tag`.
    const runId = newRunId();
    const steps = orderedSteps(slot.tag, slot.steps).map((step) => ({
      stepId: step.stepId,
      ordinal: step.ordinal,
      artifactId: step.promptArtifactId,
      versionId: step.promptVersionId,
      text: (() => {
        const bytes = this.input.release.payloads.get(step.contentHash);
        return bytes ? Buffer.from(bytes).toString("utf8") : "";
      })(),
      runRef: mintRunRef({ agentId: this.input.agentId, target: this.input.target, runId, entries: [{ tag: slot.tag, artifactId: step.promptArtifactId, versionId: step.promptVersionId, model: slot.model, arm, bucket, ...cohort }] }, Buffer.from(this.input.runRefKey)),
      ...cohort,
      // The workflow's pinned model (every step runs on it), and the step's own settings for it.
      model: slot.model,
      ...(step.inference ? { inference: snapshotInference(step.inference) } : {}),
    }));
    return { model: slot.model, arm, steps, variables: slot.variables };
  }
}
