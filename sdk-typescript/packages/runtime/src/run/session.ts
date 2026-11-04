/**
 * One open run. A slot pins once, on its first `place`, and the rendered
 * placement stays in memory, because a release swap drops the old payload and
 * a pin could not be rendered again. Reductions are the exception: every
 * `place` reads the current disables, so a disable applies at the next call
 * even to a pinned slot. Ramp steps and rollbacks reach the next run.
 *
 * Counters only add up here. `end` writes one observation per slot that made a
 * model call, so `count` on a v3 row means runs.
 *
 * @example
 * ```ts
 * const run = new Session("run_1", {}, host, () => registry.forget("run_1"));
 * const placed = await run.place("support.reply"); // pins the arm for this run
 * run.recordModelCall("support.reply", { model: "gpt-5", latencyMs: 300, usage });
 * run.end(); // one row with count 1, however many calls were recorded
 * ```
 */

import type { ErrorClass } from "@airprompter/agent-core";
import { disabledArmsFor, type Rendered, type ReleaseResolver, type ResolveOutcome } from "../release/resolver.js";
import { fillAsync, planFill } from "../variables/fill.js";
import type { RunHost } from "./ports.js";
import type { ModelCallRecord, Placement, RunInput, RunSession, ToolCallRecord, UnavailableReason } from "./types.js";

type Pin = { placement: Placement; rendered?: Rendered };

interface SlotTotals {
  /** The pin of the first recorded call. A re-placed arm's run stays on the arm it started on. */
  rendered: Rendered;
  input: number;
  cachedInput: number;
  output: number;
  allReported: boolean;
}

export class Session implements RunSession {
  /** Single flight: the promise is stored before anything is awaited, so concurrent calls render once. */
  private readonly pins = new Map<string, Promise<Pin>>();
  private readonly placed = new Map<string, Pin>();
  private readonly totals = new Map<string, SlotTotals>();
  private readonly stamped = new Set<string>();
  private readonly subject: string;
  private readonly openedAt: number;
  private lastErrorClass: ErrorClass | null = null;
  private lastActiveAt: number;
  private firstRunRef: string | undefined;
  private openScopes = 0;
  private ended = false;

  constructor(
    readonly id: string,
    private readonly input: RunInput,
    private readonly host: RunHost,
    private readonly forget: (session: Session) => void,
  ) {
    this.subject = input.subject ?? input.conversationId ?? id;
    this.openedAt = host.now();
    this.lastActiveAt = this.openedAt;
  }

  get runRef(): string | undefined {
    return this.firstRunRef;
  }

  async place(slot: string): Promise<Placement> {
    this.touch();
    let pending = this.pins.get(slot);
    if (!pending) {
      pending = this.firstPlacement(slot);
      this.pins.set(slot, pending);
    }
    const pin = await pending;
    this.touch();
    const current = this.reduced(slot, pin);
    if (current === "replace") {
      if (this.pins.get(slot) === pending) this.pins.set(slot, this.firstPlacement(slot));
      return this.settle(slot, await this.pins.get(slot)!);
    }
    return current ?? this.settle(slot, pin);
  }

  recordModelCall(slot: string, call: ModelCallRecord): void {
    if (this.ended) return;
    this.touch();
    const rendered = this.placed.get(slot)?.rendered;
    if (!rendered) return;
    const totals = this.totals.get(slot) ?? { rendered, input: 0, cachedInput: 0, output: 0, allReported: true };
    totals.input += call.usage?.input ?? 0;
    totals.cachedInput += call.usage?.cachedInput ?? 0;
    totals.output += call.usage?.output ?? 0;
    totals.allReported &&= call.usage?.source === "reported";
    this.totals.set(slot, totals);
    this.lastErrorClass = call.errorClass ?? null;
  }

  /** Tool counts have no row until protocol 3.0.0. A tool call only keeps the run from looking idle. */
  recordToolCall(_slot: string, _call: ToolCallRecord): void {
    if (!this.ended) this.touch();
  }

  end(result: { errorClass?: ErrorClass } = {}): void {
    if (this.ended) return;
    this.ended = true;
    this.forget(this);
    const errorClass = result.errorClass ?? this.lastErrorClass;
    const nowMs = this.host.now();
    for (const { rendered, input, cachedInput, output, allReported } of this.totals.values()) {
      this.host.recordRun({
        ...(rendered.audienceIds ? { audienceIds: rendered.audienceIds } : {}),
        ...(rendered.runMinute ? { runMinute: rendered.runMinute } : {}),
        artifactId: rendered.artifactId,
        tag: rendered.tag,
        versionId: rendered.versionId,
        arm: rendered.arm,
        model: rendered.model,
        status: errorClass ? "error" : "ok",
        errorClass,
        latencyMs: Math.max(0, nowMs - this.openedAt),
        tokens: { input, cachedInput, output },
        usageSource: allReported ? "reported" : "unavailable",
      }, nowMs);
    }
  }

  /** `withRun` holds a scope open, so a long tool never looks idle to the sweep. */
  enter(): () => void {
    this.openScopes += 1;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.openScopes -= 1;
      this.touch();
    };
  }

  idle(nowMs: number): boolean {
    return this.openScopes === 0 && nowMs - this.lastActiveAt >= this.host.idleTimeoutMs;
  }

  private touch(): void {
    this.lastActiveAt = this.host.now();
  }

  private settle(slot: string, pin: Pin): Placement {
    this.placed.set(slot, pin);
    if (pin.rendered) this.firstRunRef ??= pin.rendered.runRef;
    return pin.placement;
  }

  /** The reductions a later `place` honours: a passthrough, `replace` for a disabled arm, or null when the pin stands. */
  private reduced(slot: string, pin: Pin): Placement | "replace" | null {
    const release = this.host.release();
    if (!("resolver" in release)) return null;
    const disabled = release.resolver.disabled();
    if (disabled.agent || disabled.slots.includes(slot)) {
      this.stampDisabled(release.resolver, disabled.agent ? null : slot);
      return { kind: "passthrough", slot, reason: "slot_disabled" };
    }
    const arm = pin.rendered?.arm;
    if (!arm || arm === "none") return null;
    const experiment = release.resolver.experimentFor(slot);
    return experiment && disabledArmsFor(disabled, experiment.experimentId).has(arm) ? "replace" : null;
  }

  private stampDisabled(resolver: ReleaseResolver, tag: string | null): void {
    const generation = resolver.release.generation;
    const key = `${generation}\u0000${tag ?? ""}`;
    if (this.stamped.has(key)) return;
    this.stamped.add(key);
    this.host.stampDisabled(generation, tag);
  }

  private passthrough(slot: string, reason: UnavailableReason, detail: Record<string, unknown> = {}): Pin {
    this.host.log({ event: "run_passthrough", runId: this.id, slot, reason, ...detail });
    return { placement: { kind: "passthrough", slot, reason } };
  }

  /** The data path, never the facade's throwing `resolveSlot`: a refusal is a passthrough. */
  private async firstPlacement(slot: string): Promise<Pin> {
    const release = this.host.release();
    if (!("resolver" in release)) return this.passthrough(slot, release.unavailable);
    const { resolver } = release;
    this.host.registerLabel(slot);
    const outcome = resolver.resolve(slot, this.subject, this.tags());
    if (!outcome.ok) {
      if (outcome.reason === "no_slot") return this.passthrough(slot, "no_slot");
      this.stampDisabled(resolver, outcome.tag);
      return this.passthrough(slot, "slot_disabled");
    }
    if (outcome.slot.kind !== "prompt") return this.passthrough(slot, "slot_kind_unsupported");
    if (this.host.leaseHalted(slot)) return this.passthrough(slot, "lease_expired");
    return this.render(slot, resolver, outcome);
  }

  private async render(slot: string, resolver: ReleaseResolver, resolved: Extract<ResolveOutcome, { ok: true }>): Promise<Pin> {
    try {
      const text = resolver.textOf(resolved.slot);
      const plan = planFill({ tag: slot, variables: resolved.slot.variables, text, values: this.input.variables ?? {}, registry: this.host.variables });
      const filled = await fillAsync(plan, { tag: slot, subject: this.input.subject, versionId: resolved.slot.versionId, arm: resolved.arm }, this.host.variables);
      const rendered = resolver.render(resolved, filled.values, { fenced: filled.fenced, text });
      return {
        rendered,
        placement: { kind: "approved", slot, instructions: rendered.text, model: rendered.model, settings: rendered.inference ?? {} },
      };
    } catch (error) {
      return this.passthrough(slot, "variables_unfilled", { error: (error as Error).name });
    }
  }

  /** Bad request data must not crash a served call. */
  private tags(): Readonly<Record<string, string>> {
    try {
      return this.host.tagsFor(this.input.tags);
    } catch {
      this.host.log({ event: "run_tags_invalid", runId: this.id });
      return this.host.tagsFor();
    }
  }
}
