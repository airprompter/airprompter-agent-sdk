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

import { snapshotInference, disabledFrom, matchesAudience, capturedAudienceIds, minuteOf, assignArm, effectiveArms, experimentForTag, experimentsOf, mintRunRef, orderedSteps, renderTemplate, type Delimiters, type Directive, type Experiment, type ExperimentArm, type LoadedRelease, type Manifest, type ManifestSlot, type ReleaseSlot, type RunRefFacts, type SlotInference, type SlotVariable, type Target } from "@airprompter/agent-core";

/**
 * Where the content a render (or a workflow step) came from — the facade's own store, its vendored fallback, the
 * host daemon, or (0.3.5, pins.md) the customer's own mirror once one is registered and its cached copy is
 * readable. Defined here (not in `@airprompter/agent-sdk`) because `Rendered.resolutionSource` carries it and this
 * package must not import the facade (S10, the layer rule); the facade's own `ReleaseSource` re-exports this type.
 */
export type ReleaseSource = "store" | "vendored_bundle" | "daemon" | "customer_store";

export interface Rendered {
  text: string;
  model: string;
  /** 0.3.1: how the model is called for this slot, as the version declared it — the wrappers apply it. */
  inference?: SlotInference;
  versionId: string;
  arm: string;
  generation: number;
  runRef: string;
  tag: string;
  /** 0.3.5: where this render's text and settings came from — the facade sets it; a resolver built directly (without the facade) never sets it. */
  resolutionSource?: ReleaseSource;
  /** Original cohort, frozen at render. */
  audienceIds?: readonly string[];
  runMinute?: string;
}

export interface Disabled {
  agent: boolean;
  slots: string[];
  /** Arm names disabled by directives that name no experiment (the legacy single experiment) — the heartbeat's shape. */
  arms: string[];
}

/** S16: `Disabled` plus the arm names disabled per experiment id (a directive without an id counts for every experiment). */
export interface DisabledDetail extends Disabled {
  armsByExperiment: Record<string, string[]>;
}

/** S16: the arms disabled for one experiment — those named with its id, plus any named without one. */
export function disabledArmsFor(disabled: DisabledDetail, experimentId: string): Set<string> {
  return new Set([...disabled.arms, ...(disabled.armsByExperiment[experimentId] ?? [])]);
}

export interface ResolverInput {
  release: LoadedRelease;
  tags?: () => Readonly<Record<string,string>>;
  /** The run reference key (an HMAC key derived from the store's id, so run refs stay stable across processes). */
  runRefKey: Uint8Array;
  agentId: string;
  target: Target;
  /** The subject when the experiment is keyed by instance, or the caller gave none. */
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

export { disabledFrom } from "@airprompter/agent-core";

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

  disabled(): DisabledDetail {
    return disabledFrom(this.directives());
  }

  /** S16: every experiment this release carries — one per slot, or the legacy single one. */
  experiments(): Experiment[] {
    return experimentsOf(this.payload);
  }

  /** S16: the experiment that decides a slot, by tag — the entry naming it, else the legacy single one, else null. */
  experimentFor(tag: string): Experiment | null {
    return experimentForTag(this.payload, tag);
  }

  /**
   * S9: an experiment's arms as they stand now — the signed plan walked on this host's clock, then any disabled arm's
   * share handed to the control. Null when there is no such experiment, or when every arm is disabled (a freeze for
   * that slot). Without an argument: the legacy single experiment, or the first of `experiments[]`.
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
    const cohort = payload.observations ? { audienceIds: Object.freeze(capturedAudienceIds(payload.observations,tag,tags,now)), runMinute: minuteOf(now) } : {};
    const disabled = this.disabled();
    if (disabled.agent) return { ok: false, reason: "disabled", tag: null };
    if (disabled.slots.includes(tag)) return { ok: false, reason: "disabled", tag };
    let slot = payload.slots.find((entry) => entry.tag === tag);
    if (!slot) return { ok: false, reason: "no_slot", tag };
    // S16: the experiment for this slot — its own salt and arms, so two slots split independently.
    const experiment = this.experimentFor(tag);
    if (!experiment || (experiment.audience && !matchesAudience(experiment.audience.selector,tags))) return { ok: true, slot, arm: "none", bucket: null, ...cohort };
    const subjectValue = experiment.subjectKey === "instance" || subject === undefined ? this.input.instanceId : subject;
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

  /**
   * Render a prompt slot the resolver already resolved. `fenced` names variables a source of `end_user` trust filled:
   * they are rendered as end-user text whatever the slot declared — the declaration can be tightened here, never
   * loosened (the set is applied on top of the slot's own list). `text` is the slot's payload when the caller has
   * already read it (one decode per render, not two).
   */
  render(resolved: ReleaseSlot & {audienceIds?: readonly string[];runMinute?: string}, values: Record<string, string | number | boolean | null | undefined> = {}, options: { fenced?: ReadonlySet<string>; text?: string } = {}): Rendered {
    const { slot, arm, bucket } = resolved;
    const generation = this.input.release.generation;
    if (resolved.audienceIds && !resolved.runMinute) throw new Error("audience_cohort_invalid");
    const cohort = resolved.audienceIds ? {audienceIds: resolved.audienceIds,runMinute: resolved.runMinute!} : {};
    const text = this.renderText({ tag: slot.tag, text: options.text ?? this.textOf(slot), variables: slot.variables, values, fenced: options.fenced });
    const facts: RunRefFacts = { agentId: this.input.agentId, target: this.input.target, tag: slot.tag, versionId: slot.versionId, arm, generation, bucket, ...cohort };
    return { text, model: slot.model, ...(slot.inference ? { inference: snapshotInference(slot.inference) } : {}), versionId: slot.versionId, arm, generation, runRef: mintRunRef(facts, Buffer.from(this.input.runRefKey)), tag: slot.tag, ...cohort };
  }

  /**
   * One text with the slot's declarations and this resolver's delimiters — the prompt path and a workflow step share
   * it, so both fence the same way. `fenced` tightens declarations to `end_user`; nothing here can loosen one.
   */
  renderText(input: { tag: string; text: string; variables: readonly SlotVariable[]; values: Record<string, string | number | boolean | null | undefined>; fenced?: ReadonlySet<string> | undefined }): string {
    const variables = input.fenced && input.fenced.size > 0 ? input.variables.map((variable) => (input.fenced!.has(variable.name) && variable.trust !== "end_user" ? { ...variable, trust: "end_user" as const } : variable)) : input.variables;
    return renderTemplate({ tag: input.tag, text: input.text, variables, values: input.values, ...(this.input.delimiters ? { delimiters: this.input.delimiters } : {}) });
  }

  /** A workflow slot's steps in ordinal order, each with its prompt text and run reference. */
  workflow(resolved: ReleaseSlot & {audienceIds?: readonly string[];runMinute?: string}): { model: string; arm: string; steps: Array<{ stepId: string; ordinal: number; versionId: string; text: string; runRef: string; model: string; inference?: SlotInference; audienceIds?: readonly string[]; runMinute?: string }>; variables: ManifestSlot["variables"] } {
    const { slot, arm, bucket } = resolved;
    if (slot.kind !== "workflow" || !slot.steps) throw new Error(`${slot.tag} is not a workflow slot`);
    const generation = this.input.release.generation;
    if (resolved.audienceIds && !resolved.runMinute) throw new Error("audience_cohort_invalid");
    const cohort = resolved.audienceIds ? {audienceIds: resolved.audienceIds,runMinute: resolved.runMinute!} : {};
    const steps = orderedSteps(slot.tag, slot.steps).map((step) => ({
      stepId: step.stepId,
      ordinal: step.ordinal,
      versionId: step.promptVersionId,
      text: (() => {
        const bytes = this.input.release.payloads.get(step.contentHash);
        return bytes ? Buffer.from(bytes).toString("utf8") : "";
      })(),
      runRef: mintRunRef({ agentId: this.input.agentId, target: this.input.target, tag: step.stepId, versionId: step.promptVersionId, arm, generation, bucket, ...cohort }, Buffer.from(this.input.runRefKey)),
      ...cohort,
      // The workflow's pinned model (every step runs on it), and — 0.3.2 — the step's own settings for it.
      model: slot.model,
      ...(step.inference ? { inference: snapshotInference(step.inference) } : {}),
    }));
    return { model: slot.model, arm, steps, variables: slot.variables };
  }
}
