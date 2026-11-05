/**
 * The run: one user request to an agent, from its first model call to its
 * last, across tools, steps and sub-agents. One run holds one version per
 * slot and counts once, however many model calls it made. An adapter sees
 * only these types; it never renders, assigns, reads a manifest or writes a
 * row.
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
 * }); // writes one window row with count 1
 * ```
 */

import type { ErrorClass, SlotInference } from "@airprompter/agent-core";
import type { UsageNormalized } from "../observe.js";

export interface RunInput {
  subject?: string;
  conversationId?: string;
  tags?: Readonly<Record<string, string>>;
  variables?: Readonly<Record<string, string | number | boolean | null>>;
  /** A run id. `openRun` is get-or-create on it: a live run comes back, and with none a new run opens with this id. */
  resume?: string;
}

export type UnavailableReason = "no_verified_release" | "awaiting_unlock" | "slot_disabled" | "no_slot" | "slot_kind_unsupported" | "variables_unfilled";

export type Placement =
  | { kind: "approved"; slot: string; instructions: string; model: string; settings: Readonly<SlotInference> }
  | { kind: "passthrough"; slot: string; reason: UnavailableReason };

export interface ModelCallRecord {
  model: string;
  latencyMs: number;
  usage?: UsageNormalized;
  errorClass?: ErrorClass;
}

export interface ToolCallRecord {
  ok: boolean;
}

export interface RunSession {
  /** Fixed at open, and available before the first `place`. */
  readonly id: string;
  /** The first placed slot's run reference, undefined until a slot is placed. */
  readonly runRef: string | undefined;
  /** Never throws for unavailability: it answers `passthrough`, and the framework's own prompt and model run. */
  place(slot: string): Promise<Placement>;
  recordModelCall(slot: string, call: ModelCallRecord): void;
  recordToolCall(slot: string, call: ToolCallRecord): void;
  /** Idempotent. With no class given, the last model call's error class decides, so a truncated reply counts. */
  end(result?: { errorClass?: ErrorClass }): void;
}

export interface AgentRuntime {
  openRun(input?: RunInput): RunSession;
  currentRun(): RunSession | undefined;
  withRun<T>(run: RunSession, fn: () => T): T;
  log(event: Record<string, unknown>): void;
}
