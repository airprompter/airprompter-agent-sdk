/**
 * One open run. A slot pins once, on its first `place` (or its first direct
 * `ap.prompt` / `ap.workflow` inside the run), and the rendered placement stays
 * in memory, because a release swap drops the old payload and a pin could not
 * be rendered again. Reductions are the exception: every `place` reads the
 * current disables (rule 2, `pin.ts`). Ramp steps and rollbacks reach the next
 * run.
 *
 * Records only add to counters here. Nothing reaches the writer until the run
 * ends: then, for every slot with a pin, one run row and its step rows, all at
 * one instant, `agentRun` 1 on the first row only. Tag values, prompt text and
 * output text are never kept in a field that outlives a call, logged or
 * written.
 *
 * @example
 * ```ts
 * const run = registry.open({ subject: userId });
 * const placed = await run.place("support.reply"); // pins the arm for this run
 * run.recordModelCall("support.reply", { step: "agent", model: "gpt-5", latencyMs: 300, usage });
 * run.recordToolCall("support.reply", { step: "tools", ok: true });
 * run.end(); // one run row with count 1, however many calls; one step row per step
 * ```
 */

import { evaluateChecks, latencyBucketIndex, LATENCY_BUCKET_EDGES_MS, RUN_REF_MAX_ENTRIES, stepName, type ErrorClass, type RunDimensions, type RunRefEntry, type UsageSource } from "../../core/index.js";
import { pinVerdict } from "./pin.js";
import { dimensionsOf, entryOf, placeSlot, type Resolved, type SlotPin } from "./placement.js";
import type { RunHost, RunRecorder } from "./ports.js";
import type { ModelCallRecord, Placement, RunInput, RunSession, ToolCallRecord, UnavailableReason } from "./types.js";

interface Counts {
  modelCalls: number;
  input: number;
  cachedInput: number;
  output: number;
  allReported: boolean;
  tools: { calls: number; errors: number };
}

interface StepCounts extends Counts {
  step: string;
  status: "ok" | "error";
  errorClass: ErrorClass | null;
  buckets: number[];
  latencySum: number;
}

/** A pinned slot's counters, against the version it pinned. */
interface SlotState extends Counts {
  pin: SlotPin;
  dims: RunDimensions;
  checks?: { passed: number; failed: number };
  steps: Map<string, StepCounts>;
}

/** What the session needs from its registry. */
export interface RegistryHooks {
  recorder: RunRecorder;
  forget(session: Session): void;
  /** True the first time a process sees this key (bounded), so a name is logged once. */
  firstTime(kind: string, key: string): boolean;
}

const emptyCounts = (): Counts => ({ modelCalls: 0, input: 0, cachedInput: 0, output: 0, allReported: true, tools: { calls: 0, errors: 0 } });
const usageOf = (counts: Counts): UsageSource => (counts.modelCalls > 0 && counts.allReported ? "reported" : "unavailable");

export class Session implements RunSession {
  readonly subject: string;
  /** Single flight: the promise is stored before anything is awaited, so concurrent calls render once. */
  private readonly pins = new Map<string, Promise<SlotPin>>();
  /** The settled pin per slot. A decline or a disabled reduction replaces what `place` answers, not the row's version. */
  private readonly answers = new Map<string, Placement>();
  /** Slots with a version, in pin order: the order of rows and of run reference entries. */
  private readonly states = new Map<string, SlotState>();
  /** What the direct path or `place` chose per slot, so both serve one version. */
  private readonly resolved = new Map<string, Resolved>();
  private readonly settled = new WeakSet<SlotPin>();
  private readonly counted = new Set<string>();
  private readonly logged = new Set<string>();
  private readonly stepNames = new Set<string>();
  private readonly lateTags: Record<string, string> = {};
  private readonly openedAt: number;
  private lastErrorClass: ErrorClass | null = null;
  private lastActiveAt: number;
  private minted: string | undefined;
  private openScopes = 0;
  private parked = false;
  private ended = false;

  constructor(
    readonly runId: string,
    private readonly input: RunInput,
    private readonly host: RunHost,
    private readonly hooks: RegistryHooks,
  ) {
    this.subject = input.subject ?? input.conversationId ?? runId;
    this.openedAt = host.now();
    this.lastActiveAt = this.openedAt;
    if (input.tags) this.setTags(input.tags);
  }

  get runRef(): string {
    if (this.minted === undefined) {
      const entries: RunRefEntry[] = [];
      for (const state of this.states.values()) if (state.pin.entry) entries.push(state.pin.entry);
      if (entries.length > RUN_REF_MAX_ENTRIES) this.once("ref_capped", () => this.host.log({ event: "run_ref_slots_capped", runId: this.runId, slots: entries.length }));
      try {
        this.minted = this.host.mintRunRef(this.runId, entries.slice(0, RUN_REF_MAX_ENTRIES));
      } catch {
        // An entry that cannot be minted is left out rather than losing the reference.
        this.minted = this.host.mintRunRef(this.runId, []);
      }
    }
    return this.minted;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  setTags(tags: Readonly<Record<string, string>>): void {
    const merged = { ...this.lateTags, ...tags };
    try {
      this.host.tagsFor(merged);
    } catch {
      this.host.log({ event: "run_tags_invalid", runId: this.runId });
      return;
    }
    Object.assign(this.lateTags, tags);
  }

  slotFor(slots: string | Readonly<Record<string, string>>, name?: string): string | undefined {
    this.touch();
    if (typeof slots === "string") return this.inRelease(slots);
    const mapped = name !== undefined && Object.prototype.hasOwnProperty.call(slots, name) ? slots[name] : slots.default;
    if (mapped === undefined) {
      const key = name ?? "";
      if (this.hooks.firstTime("unmapped_step", key)) this.host.log({ event: "run_step_unmapped", runId: this.runId, name: key });
      this.countOnce(`unmapped\u0000${key}`, "unmapped_step");
      return undefined;
    }
    return this.inRelease(mapped);
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
    this.settle(slot, pin);
    const remembered = this.answers.get(slot)!;
    if (remembered.kind === "passthrough" && remembered.reason !== "slot_disabled") return remembered;
    const verdict = this.verdict(slot, pin.resolved?.arm);
    if (verdict === "replace") {
      if (this.pins.get(slot) === pending) {
        this.host.log({ event: "run_replaced", runId: this.runId, slot });
        this.resolved.delete(slot);
        this.answers.delete(slot);
        this.pins.set(slot, this.firstPlacement(slot));
      }
      const next = await this.pins.get(slot)!;
      this.settle(slot, next);
      return this.answers.get(slot)!;
    }
    if (verdict === "disabled") return { kind: "passthrough", slot, reason: "slot_disabled" };
    return pin.placement;
  }

  decline(slot: string, reason: "model_unresolved"): Placement {
    this.touch();
    const placement: Placement = { kind: "passthrough", slot, reason };
    const current = this.answers.get(slot);
    if (current?.kind === "passthrough" && current.reason === reason) return current;
    this.answers.set(slot, placement);
    const state = this.states.get(slot);
    if (state) {
      // Feedback on a version that never served would be misfiled, so its entry leaves the reference.
      if (state.pin.entry) this.minted = undefined;
      state.pin = { ...withoutEntry(state.pin), rowError: "model_unresolved" };
    }
    this.countOnce(`${slot}\u0000${reason}`, reason);
    this.host.log({ event: "run_passthrough", runId: this.runId, slot, reason });
    return placement;
  }

  recordModelCall(slot: string, call: ModelCallRecord): void {
    const state = this.recordable(slot);
    if (!state) return;
    this.lastErrorClass = call.errorClass ?? null;
    const reported = call.usage?.source === "reported";
    const tokens = { input: call.usage?.input ?? 0, cachedInput: call.usage?.cachedInput ?? 0, output: call.usage?.output ?? 0 };
    addCall(state, tokens, reported);
    if (call.step !== undefined) {
      const step = this.step(state, call.step, call.errorClass ? "error" : "ok", call.errorClass ?? null);
      addCall(step, tokens, reported);
      step.buckets[latencyBucketIndex(call.latencyMs)]! += 1;
      step.latencySum += Number.isFinite(call.latencyMs) ? Math.max(0, Math.round(call.latencyMs)) : 0;
    }
    if (call.outputText !== undefined && state.pin.placement.kind === "approved") {
      const declared = this.host.checksFor(slot, state.dims.arm);
      if (declared.length > 0) {
        const outcome = evaluateChecks(declared, { text: call.outputText, outputTokens: reported ? tokens.output : null });
        state.checks = { passed: (state.checks?.passed ?? 0) + outcome.passed, failed: (state.checks?.failed ?? 0) + outcome.failed };
      }
    }
  }

  recordToolCall(slot: string, call: ToolCallRecord): void {
    const state = this.recordable(slot);
    if (!state) return;
    addTool(state, call.ok);
    if (call.step !== undefined) addTool(this.step(state, call.step, "ok", null), call.ok);
  }

  end(result: { errorClass?: ErrorClass; interrupted?: boolean } = {}): void {
    if (this.ended || this.parked) return;
    if (result.interrupted) {
      this.parked = true;
      this.touch();
      return;
    }
    const errorClass = result.errorClass ?? this.lastErrorClass;
    this.finish(errorClass ? { status: "error", errorClass } : { status: "ok", errorClass: null }, this.host.now());
  }

  /** The sweep's end, and `stop()`'s: the last record's class, else interrupted. An idle run's latency stops at its last activity. */
  endIdle(): void {
    const status = this.lastErrorClass ? { status: "error" as const, errorClass: this.lastErrorClass } : { status: "interrupted" as const, errorClass: null };
    this.finish(status, this.openScopes > 0 ? this.host.now() : this.lastActiveAt);
  }

  /** A resume of a live run: its tags merge in, the subject stays, and a parked run carries on. */
  resumed(input: RunInput): void {
    this.parked = false;
    this.touch();
    if (input.tags) this.setTags(input.tags);
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

  get lastActive(): number {
    return this.lastActiveAt;
  }

  // ---------------------------------------------------------------- the direct path (`ap.prompt`, `ap.workflow`, `observe`)

  /**
   * The version the direct path serves for a slot in this run: the pin, after rule 2, else what `resolve` chooses now,
   * which then pins. `resolve` is the facade's throwing path, so a refusal throws as `ap.prompt` always has.
   */
  resolveThrough(slot: string, resolve: (subject: string, tags: Readonly<Record<string, string>>) => Resolved, options: { entry: boolean }): Resolved {
    this.touch();
    const pinned = this.resolved.get(slot);
    if (pinned) {
      const verdict = this.verdict(slot, pinned.arm);
      if (verdict === "stands") return pinned;
      this.resolved.delete(slot);
      if (verdict === "replace") {
        this.host.log({ event: "run_replaced", runId: this.runId, slot });
        this.answers.delete(slot);
        this.pins.delete(slot);
      }
    }
    const resolved = resolve(this.subject, this.tags());
    this.resolved.set(slot, resolved);
    if (!this.states.has(slot)) {
      const dims = dimensionsOf(slot, resolved);
      const pin: SlotPin = { placement: { kind: "passthrough", slot, reason: "no_slot" }, direct: true, dims, resolved, ...(options.entry ? { entry: entryOf(slot, resolved, dims.runMinute ?? "") } : {}) };
      this.adopt(slot, pin);
    }
    return resolved;
  }

  /** An observation of a slot this run pinned folds in here, so one request counts once. False when it is not this run's. */
  take(observation: { tag: string; arm: string; step?: string; status: string; errorClass?: ErrorClass | null; latencyMs: number; tokens?: { input?: number; cachedInput?: number; output?: number }; usageSource?: UsageSource; toolCalls?: { calls: number; errors: number }; checks?: { passed?: number; failed?: number } }): boolean {
    if (this.ended) return false;
    const state = this.states.get(observation.tag);
    if (!state || state.dims.arm !== observation.arm) return false;
    this.touch();
    const errorClass = observation.status === "ok" ? null : (observation.errorClass ?? null);
    this.lastErrorClass = errorClass;
    const tokens = { input: observation.tokens?.input ?? 0, cachedInput: observation.tokens?.cachedInput ?? 0, output: observation.tokens?.output ?? 0 };
    const reported = (observation.usageSource ?? "reported") === "reported";
    addCall(state, tokens, reported);
    state.tools.calls += observation.toolCalls?.calls ?? 0;
    state.tools.errors += observation.toolCalls?.errors ?? 0;
    if (observation.checks) state.checks = { passed: (state.checks?.passed ?? 0) + (observation.checks.passed ?? 0), failed: (state.checks?.failed ?? 0) + (observation.checks.failed ?? 0) };
    if (observation.step !== undefined) {
      const step = this.step(state, observation.step, errorClass ? "error" : "ok", errorClass);
      addCall(step, tokens, reported);
      step.tools.calls += observation.toolCalls?.calls ?? 0;
      step.tools.errors += observation.toolCalls?.errors ?? 0;
      step.buckets[latencyBucketIndex(observation.latencyMs)]! += 1;
      step.latencySum += Math.max(0, Math.round(observation.latencyMs));
    }
    return true;
  }

  /** A direct-path render failed on a slot this run pinned: its row becomes the error row, and no one-call run is written. */
  renderFailed(slot: string): boolean {
    if (this.ended) return false;
    const state = this.states.get(slot);
    if (!state) return false;
    state.pin = { ...state.pin, rowError: "render_missing_variable" };
    return true;
  }

  // ---------------------------------------------------------------- internals

  private finish(result: { status: "ok" | "error" | "interrupted"; errorClass: ErrorClass | null }, endedAt: number): void {
    if (this.ended) return;
    this.ended = true;
    this.hooks.forget(this);
    const nowMs = this.host.now();
    const latencyMs = Math.max(0, endedAt - this.openedAt);
    let agentRun: 0 | 1 = 1;
    for (const state of this.states.values()) {
      const rowError = state.pin.rowError;
      const status = rowError ? "error" : result.status;
      const errorClass = rowError ?? result.errorClass;
      try {
        this.hooks.recorder.recordRun({
          dimensions: state.dims,
          status,
          errorClass,
          usageSource: usageOf(state),
          agentRun,
          modelCalls: state.modelCalls,
          latencyMs,
          tokens: { input: state.input, cachedInput: state.cachedInput, output: state.output },
          tools: { ...state.tools },
          ...(state.checks ? { checks: state.checks } : {}),
        }, nowMs);
        agentRun = 0;
      } catch (error) {
        this.host.log({ event: "observation_dropped", runId: this.runId, slot: state.dims.tag, reason: (error as Error).message });
        continue;
      }
      for (const step of state.steps.values()) {
        try {
          this.hooks.recorder.recordStep({
            dimensions: state.dims,
            step: step.step,
            status: step.status,
            errorClass: step.errorClass,
            usageSource: usageOf(step),
            modelCalls: step.modelCalls,
            latency: { buckets: step.buckets, sum: step.latencySum },
            tokens: { input: step.input, cachedInput: step.cachedInput, output: step.output },
            tools: { ...step.tools },
          }, nowMs);
        } catch (error) {
          this.host.log({ event: "observation_dropped", runId: this.runId, slot: state.dims.tag, reason: (error as Error).message });
        }
      }
    }
  }

  private recordable(slot: string): SlotState | undefined {
    if (this.ended) {
      this.once("late", () => this.host.log({ event: "run_late_record", runId: this.runId, slot }));
      return undefined;
    }
    this.touch();
    return this.states.get(slot);
  }

  private step(state: SlotState, name: string, status: "ok" | "error", errorClass: ErrorClass | null): StepCounts {
    const step = stepName(name, this.stepNames);
    const key = [step, status, errorClass ?? ""].join("\u0000");
    let counts = state.steps.get(key);
    if (!counts) state.steps.set(key, (counts = { ...emptyCounts(), step, status, errorClass, buckets: new Array<number>(LATENCY_BUCKET_EDGES_MS.length).fill(0), latencySum: 0 }));
    return counts;
  }

  /** Rule 2 against the release served now. */
  private verdict(slot: string, arm: string | undefined): "stands" | "replace" | "disabled" {
    const release = this.host.release();
    if (!("resolver" in release)) return "stands";
    const { resolver } = release;
    const verdict = pinVerdict({ slot, arm, disabled: resolver.disabled(), frozen: resolver.frozen(slot, this.tags()), experimentId: resolver.experimentFor(slot)?.experimentId ?? null });
    if (verdict.kind === "disabled") {
      this.once(`stamp\u0000${slot}`, () => this.host.stampDisabled(resolver.release.generation, verdict.stampTag));
      this.countOnce(`${slot}\u0000slot_disabled`, "slot_disabled");
      return "disabled";
    }
    const pin = this.states.get(slot)?.pin;
    if (pin && (pin.placement.kind === "approved" || pin.direct)) this.host.stampLease();
    return verdict.kind;
  }

  private firstPlacement(slot: string): Promise<SlotPin> {
    return placeSlot(slot, { host: this.host, subject: this.subject, tags: () => this.tags(), values: this.input.variables ?? {}, resolved: this.resolved.get(slot) });
  }

  /** The first settle of a pin: remember the answer, pin the version, count and log once. A pin settles once, however many callers awaited it. */
  private settle(slot: string, pin: SlotPin): void {
    if (this.settled.has(pin)) return;
    this.settled.add(pin);
    this.answers.set(slot, pin.placement);
    if (pin.resolved) this.resolved.set(slot, pin.resolved);
    if (pin.dims) this.adopt(slot, pin);
    if (pin.placement.kind === "approved") this.registerLabel(slot);
    else {
      this.countOnce(`${slot}\u0000${pin.placement.reason}`, pin.placement.reason);
      this.host.log({ event: "run_passthrough", runId: this.runId, slot, reason: pin.placement.reason, ...(pin.detail ?? {}) });
    }
    this.once(`placed\u0000${slot}`, () => this.host.log({
      event: "run_placed",
      runId: this.runId,
      slot,
      ...(pin.dims ? { versionId: pin.dims.versionId, artifactId: pin.dims.artifactId, arm: pin.dims.arm } : {}),
      ...(pin.placement.kind === "passthrough" ? { reason: pin.placement.reason } : {}),
    }));
  }

  /**
   * Pin a version for the row. The first pin fixes the row's version and the reference entry: a re-placed arm serves
   * the new arm, but the run stays counted, and takes feedback, on the arm it started on. A direct-path pin that
   * `place` then renders keeps its counters.
   */
  private adopt(slot: string, pin: SlotPin): void {
    const existing = this.states.get(slot);
    if (existing) {
      const { entry: _entry, ...rest } = pin;
      const rowError = existing.pin.rowError ?? pin.rowError;
      existing.pin = { ...rest, ...(existing.pin.entry ? { entry: existing.pin.entry } : {}), ...(rowError ? { rowError } : {}) };
    } else {
      this.states.set(slot, { ...emptyCounts(), pin, dims: pin.dims!, steps: new Map() });
    }
    this.minted = undefined;
  }

  /** A slot missing from the release is logged once per process and counted once per run. */
  private inRelease(slot: string): string | undefined {
    const release = this.host.release();
    if (!("resolver" in release) || release.resolver.hasSlot(slot)) return slot;
    if (this.hooks.firstTime("slot_not_in_release", slot)) this.host.log({ event: "run_slot_not_in_release", runId: this.runId, slot });
    this.countOnce(`missing\u0000${slot}`, "slot_not_in_release");
    return undefined;
  }

  private countOnce(key: string, reason: UnavailableReason | "unmapped_step" | "slot_not_in_release"): void {
    if (this.counted.has(key)) return;
    this.counted.add(key);
    this.hooks.recorder.countPassthrough(reason);
  }

  private once(key: string, fn: () => void): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    fn();
  }

  private touch(): void {
    this.lastActiveAt = this.host.now();
  }

  /** A label is only a display name on the heartbeat: a bad one must not stop a served call. */
  private registerLabel(slot: string): void {
    try {
      this.host.registerLabel(slot);
    } catch {
      this.host.log({ event: "run_label_invalid", runId: this.runId, slot });
    }
  }

  /** Read at each slot's first placement, so a late tag reaches a later slot. Bad request data must not crash a served call. */
  private tags(): Readonly<Record<string, string>> {
    try {
      return this.host.tagsFor(this.lateTags);
    } catch {
      this.host.log({ event: "run_tags_invalid", runId: this.runId });
      return this.host.tagsFor();
    }
  }
}

function withoutEntry(pin: SlotPin): SlotPin {
  const { entry: _entry, ...rest } = pin;
  return rest;
}

function addCall(counts: Counts, tokens: { input: number; cachedInput: number; output: number }, reported: boolean): void {
  counts.modelCalls += 1;
  counts.input += tokens.input;
  counts.cachedInput += tokens.cachedInput;
  counts.output += tokens.output;
  counts.allReported &&= reported;
}

function addTool(counts: Counts, ok: boolean): void {
  counts.tools.calls += 1;
  if (!ok) counts.tools.errors += 1;
}

