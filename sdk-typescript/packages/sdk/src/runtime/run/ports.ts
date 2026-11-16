/**
 * What a run needs from the facade. `runtime/run` decides; `agent.ts` wires
 * the active release, the lease, the refusal stamp, the run reference key and
 * the spool through these ports, because the runtime never imports the
 * telemetry or sync code. The recorder is held by the registry, not by a
 * session, so a row can still be written after a session ends.
 *
 * @example
 * ```ts
 * const recorder: RunRecorder = { recordRun: (t, at) => spool.recordRun(t, at), recordStep: (t, at) => spool.recordStep(t, at), countPassthrough: () => {} };
 * const runs = new RunRegistry(host, recorder);
 * ```
 */

import type { DeclaredCheck, RunRefEntry, RunRefFacts, RunTotals, StepTotals } from "../../core/index.js";
import type { ReleaseResolver } from "../release/resolver.js";
import type { VariableSourceRegistry } from "../variables/sources.js";

export interface RunRecorder {
  recordRun(totals: RunTotals, nowMs: number): void;
  recordStep(totals: StepTotals, nowMs: number): void;
  /** `runCounters.passthrough` on the heartbeat: an open map of reason to count. */
  countPassthrough(reason: string): void;
}

export interface RunHost {
  release(): { resolver: ReleaseResolver } | { unavailable: "no_verified_release" | "awaiting_unlock" };
  /** The process tags merged with these. Throws on tags `copyAudienceTags` refuses; the session catches it. */
  tagsFor(overrides?: Readonly<Record<string, string>>): Readonly<Record<string, string>>;
  registerLabel(tag: string): void;
  variables: VariableSourceRegistry;
  /** Stamps a lapsed lease. A lapsed lease never stops rendering. */
  stampLease(): void;
  stampDisabled(generation: number, tag: string | null): void;
  /** The output checks the active release declares for a slot on an arm. */
  checksFor(tag: string, arm: string): readonly DeclaredCheck[];
  /** Mint a run reference under this agent's key, and read one back (null when it does not verify). */
  mintRunRef(runId: string, entries: readonly RunRefEntry[]): string;
  parseRunRef(runRef: string): RunRefFacts | null;
  log(event: Record<string, unknown>): void;
  now(): number;
  idleTimeoutMs: number;
}
