/**
 * The run: one user request to an agent, from its first model call to its
 * last, across tools, steps, sub-agents and several prompts. One run holds one
 * version per slot, chosen at that slot's first `place`, and one run
 * reference that grows an entry per slot. An adapter sees only these types; it
 * never renders, assigns, reads a manifest or writes a row.
 *
 * @example
 * ```ts
 * await ap.run({ subject: userId }, async (run) => {
 *   const placed = await run.place("support.reply");
 *   if (placed.kind === "passthrough") return callModel(ownPrompt, ownModel); // the framework's own prompt runs
 *   const started = Date.now();
 *   const reply = await callModel(placed.instructions, placed.model);
 *   run.recordModelCall("support.reply", { model: placed.model, latencyMs: Date.now() - started, usage: normalizeUsage(reply) });
 *   return reply;
 * }); // one run row per slot the run pinned, `agentRun` 1 on the first only
 * ```
 */

import type { ErrorClass, SlotInference } from "../../core/index.js";
import type { UsageNormalized } from "../observe.js";

export interface RunInput {
  subject?: string;
  conversationId?: string;
  tags?: Readonly<Record<string, string>>;
  variables?: Readonly<Record<string, string | number | boolean | null>>;
  /** A run reference. `openRun` is get-or-create on its `runId`: a live run comes back, and with none a new run opens with that id. */
  resume?: string;
}

export type UnavailableReason =
  | "no_verified_release"
  | "awaiting_unlock"
  | "slot_disabled"
  | "no_slot"
  | "slot_kind_unsupported"
  | "model_unresolved"
  | "variables_unfilled";

export type Placement =
  | { kind: "approved"; slot: string; instructions: string; model: string; settings: Readonly<SlotInference> }
  | { kind: "passthrough"; slot: string; reason: UnavailableReason };

export type TokenUsage = UsageNormalized;

export interface ModelCallRecord {
  /** An opaque step name, such as a framework node. Past `STEP_BOUNDS` it is written as `other`. */
  step?: string;
  model: string;
  latencyMs: number;
  usage?: TokenUsage;
  errorClass?: ErrorClass;
  /** Read once for the slot's declared output checks, then dropped: never kept, never recorded. Absent when the call only asked for tools. */
  outputText?: string;
  /**
   * The caller sees every tool call this slot's requests make, so a run with none recorded reports zero tools, not
   * unknown. Once true on a slot in a run, its run row and step rows carry `toolsReported: true`.
   */
  toolsObserved?: boolean;
}

export interface ToolCallRecord {
  step?: string;
  ok: boolean;
}

export interface RunSession {
  /** A getter, re-minted when a new slot pins: re-read it, never cache it. It carries the run id from the start. */
  readonly runRef: string;
  /** Merge tags for slots not yet placed. A pinned slot never changes, and the subject stays fixed. Values never leave the process. */
  setTags(tags: Readonly<Record<string, string>>): void;
  /** The slot a framework name maps to, `default` allowed, else undefined. A miss is logged once per name and counted. */
  slotFor(slots: string | Readonly<Record<string, string>>, name?: string): string | undefined;
  /** Never throws for unavailability: it answers `passthrough`, and the framework's own prompt and model run. */
  place(slot: string): Promise<Placement>;
  /** The adapter could not build the released model: the slot passes through for the rest of the run, with one error row. */
  decline(slot: string, reason: "model_unresolved"): Placement;
  recordModelCall(slot: string, call: ModelCallRecord): void;
  recordToolCall(slot: string, call: ToolCallRecord): void;
  /**
   * Idempotent. With no class given, the last model call's error class decides, so a truncated reply counts.
   * `interrupted: true` parks the run: it stays open and writes nothing until a resume picks it up and ends it, or the
   * idle sweep does. A plain `end()` on a parked run does nothing.
   */
  end(result?: { errorClass?: ErrorClass; interrupted?: boolean }): void;
}

export interface AgentRuntime {
  openRun(input?: RunInput): RunSession;
  currentRun(): RunSession | undefined;
  withRun<T>(run: RunSession, fn: () => T): T;
  log(event: Record<string, unknown>): void;
}

/** Maps a release's model id onto the framework's model object, or returns the id for the adapter to build. */
export type ModelResolver<TModel> = (releaseModelId: string, callerModel: TModel) => TModel | string;
