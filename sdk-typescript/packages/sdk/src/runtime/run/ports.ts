/**
 * What a run needs from the facade. `runtime/run` decides; `agent.ts` wires
 * the active release, the lease, the refusal stamp and the spool through this
 * port, because the runtime never imports the telemetry package.
 *
 * @example
 * ```ts
 * const runs = new RunRegistry({ release: () => ({ resolver }), recordRun: (row, at) => spool.observe(row, at), ...rest });
 * ```
 */

import type { Observation } from "../../core/index.js";
import type { ReleaseResolver } from "../release/resolver.js";
import type { VariableSourceRegistry } from "../variables/sources.js";

export interface RunHost {
  release(): { resolver: ReleaseResolver } | { unavailable: "no_verified_release" | "awaiting_unlock" };
  tagsFor(overrides?: Readonly<Record<string, string>>): Readonly<Record<string, string>>;
  registerLabel(tag: string): void;
  variables: VariableSourceRegistry;
  /** Stamps a lapsed lease. A lapsed lease never stops rendering. */
  stampLease(): void;
  stampDisabled(generation: number, tag: string | null): void;
  recordRun(observation: Observation, nowMs: number): void;
  log(event: Record<string, unknown>): void;
  now(): number;
  idleTimeoutMs: number;
}
