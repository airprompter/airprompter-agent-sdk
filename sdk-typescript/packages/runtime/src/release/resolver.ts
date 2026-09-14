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
 */

import { assignArm, effectiveArms, mintRunRef, orderedSteps, renderTemplate, type Delimiters, type Directive, type ExperimentArm, type LoadedRelease, type Manifest, type ManifestSlot, type ReleaseSlot, type RunRefFacts, type Target } from "@airprompter/agent-core";

export interface Rendered {
  text: string;
  model: string;
  versionId: string;
  arm: string;
  generation: number;
  runRef: string;
  tag: string;
}

export interface Disabled {
  agent: boolean;
  slots: string[];
  arms: string[];
}

export interface ResolverInput {
  release: LoadedRelease;
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

export type ResolveOutcome = ({ ok: true } & ReleaseSlot) | { ok: false; reason: "disabled" | "no_slot"; tag: string | null };

/** What `disable` directives say, as data. */
export function disabledFrom(directives: readonly Directive[]): Disabled {
  const slots: string[] = [];
  const arms: string[] = [];
  let agent = false;
  for (const directive of directives) {
    if (directive.kind !== "disable") continue;
    if (directive.scope === "agent") agent = true;
    else if (directive.scope === "arm" && directive.arm) arms.push(directive.arm);
    else if (directive.tag) slots.push(directive.tag);
  }
  return { agent, slots, arms };
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

  /**
   * S9: the arms as they stand now — the signed plan walked on this host's clock, then any disabled arm's share handed
   * to the control. Null when there is no experiment, or when every arm is disabled (a freeze for that tag).
   */
  arms(): ExperimentArm[] | null {
    const experiment = this.payload.experiment;
    if (!experiment) return null;
    return effectiveArms({ arms: experiment.arms, ramp: experiment.ramp, disabledArms: new Set(this.disabled().arms), nowMs: this.input.nowMs() });
  }

  /** The slot a subject gets for a tag, or why not. Refusals are data: the facade records them. */
  resolve(tag: string, subject?: string): ResolveOutcome {
    const payload = this.payload;
    const disabled = this.disabled();
    if (disabled.agent) return { ok: false, reason: "disabled", tag: null };
    if (disabled.slots.includes(tag)) return { ok: false, reason: "disabled", tag };
    let slot = payload.slots.find((entry) => entry.tag === tag);
    if (!slot) return { ok: false, reason: "no_slot", tag };
    if (!payload.experiment) return { ok: true, slot, arm: "none", bucket: null };
    const subjectValue = payload.experiment.subjectKey === "instance" || subject === undefined ? this.input.instanceId : subject;
    const arms = this.arms();
    if (!arms) return { ok: false, reason: "disabled", tag };
    const assigned = assignArm({ salt: payload.experiment.salt, subject: subjectValue, arms });
    const override = assigned.arm.overrides.find((entry) => entry.tag === tag);
    if (override) slot = override;
    return { ok: true, slot, arm: assigned.arm.arm, bucket: assigned.bucket };
  }

  /** A slot's verified payload as text. */
  textOf(slot: Pick<ManifestSlot, "contentHash">): string {
    const bytes = this.input.release.payloads.get(slot.contentHash);
    if (!bytes) throw new Error(`payload ${slot.contentHash} not loaded`);
    return Buffer.from(bytes).toString("utf8");
  }

  /** Render a prompt slot the resolver already resolved. */
  render(resolved: ReleaseSlot, values: Record<string, string | number | boolean | null | undefined> = {}): Rendered {
    const { slot, arm, bucket } = resolved;
    const generation = this.input.release.generation;
    const text = renderTemplate({ tag: slot.tag, text: this.textOf(slot), variables: slot.variables, values, ...(this.input.delimiters ? { delimiters: this.input.delimiters } : {}) });
    const facts: RunRefFacts = { agentId: this.input.agentId, target: this.input.target, tag: slot.tag, versionId: slot.versionId, arm, generation, bucket };
    return { text, model: slot.model, versionId: slot.versionId, arm, generation, runRef: mintRunRef(facts, Buffer.from(this.input.runRefKey)), tag: slot.tag };
  }

  /** A workflow slot's steps in ordinal order, each with its prompt text and run reference. */
  workflow(resolved: ReleaseSlot): { model: string; arm: string; steps: Array<{ stepId: string; ordinal: number; versionId: string; text: string; runRef: string }>; variables: ManifestSlot["variables"] } {
    const { slot, arm, bucket } = resolved;
    if (slot.kind !== "workflow" || !slot.steps) throw new Error(`${slot.tag} is not a workflow slot`);
    const generation = this.input.release.generation;
    const steps = orderedSteps(slot.tag, slot.steps).map((step) => ({
      stepId: step.stepId,
      ordinal: step.ordinal,
      versionId: step.promptVersionId,
      text: (() => {
        const bytes = this.input.release.payloads.get(step.contentHash);
        return bytes ? Buffer.from(bytes).toString("utf8") : "";
      })(),
      runRef: mintRunRef({ agentId: this.input.agentId, target: this.input.target, tag: step.stepId, versionId: step.promptVersionId, arm, generation, bucket }, Buffer.from(this.input.runRefKey)),
    }));
    return { model: slot.model, arm, steps, variables: slot.variables };
  }
}
