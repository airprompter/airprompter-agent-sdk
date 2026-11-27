/**
 * The open runs of one agent. `open` is get-or-create on a resume reference's
 * run id, so a hook can always ask for the run it belongs to. With no live run
 * it opens a new one with the same id: a repeat resume then finds it, and the
 * subject hashes the same, so a resume after a sweep keeps its arm and counts
 * as a new run. An idle sweep ends what no hook will end, such as a model
 * error a framework gives no hook for. A scope held by `withRun` keeps a run
 * alive. The registry holds the recorder, so rows can be written after a
 * session ends.
 *
 * @example
 * ```ts
 * const runs = new RunRegistry(host, recorder);
 * const run = runs.open({ subject: userId });
 * await runs.withRun(run, () => doWork()); // runs.current() is `run` in here, across awaits
 * runs.open({ resume: run.runRef }) === run; // true while it is live
 * runs.sweep(); // on a timer; ends runs idle past host.idleTimeoutMs
 * ```
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { newRunId, type ErrorClass, type UsageSource } from "../../core/index.js";
import type { Resolved } from "./placement.js";
import type { RunHost, RunRecorder } from "./ports.js";
import { Session, type RegistryHooks } from "./session.js";
import type { RunInput, RunSession } from "./types.js";

export const DEFAULT_RUN_IDLE_TIMEOUT_MS = 15 * 60_000;
/** Past this many open runs, the one idle longest ends by the idle rule. */
export const MAX_OPEN_RUNS = 10_000;
/** Names logged once per process, per kind. */
const MAX_NAMES_SAID = 64;

/** An observation the direct path would write as a one-call run. */
export interface TakenObservation {
  tag: string;
  arm: string;
  step?: string;
  status: string;
  errorClass?: ErrorClass | null;
  latencyMs: number;
  tokens?: { input?: number; cachedInput?: number; output?: number };
  usageSource?: UsageSource;
  toolCalls?: { calls: number; errors: number };
  checks?: { passed?: number; failed?: number };
}

export class RunRegistry {
  private readonly live = new Map<string, Session>();
  private readonly scope = new AsyncLocalStorage<Session>();
  private readonly said = new Map<string, Set<string>>();
  private readonly hooks: RegistryHooks;

  constructor(private readonly host: RunHost, recorder: RunRecorder) {
    this.hooks = {
      recorder,
      forget: (session) => {
        if (this.live.get(session.runId) === session) this.live.delete(session.runId);
      },
      firstTime: (kind, key) => {
        let names = this.said.get(kind);
        if (!names) this.said.set(kind, (names = new Set()));
        if (names.has(key) || names.size >= MAX_NAMES_SAID) return false;
        names.add(key);
        return true;
      },
    };
  }

  open(input: RunInput = {}): RunSession {
    this.sweep();
    let runId: string | undefined;
    if (input.resume !== undefined) {
      runId = typeof input.resume === "string" ? this.host.parseRunRef(input.resume)?.runId : undefined;
      if (runId === undefined) this.host.log({ event: "run_resume_refused" });
    }
    const existing = runId === undefined ? undefined : this.live.get(runId);
    if (existing) {
      existing.resumed(input);
      return existing;
    }
    if (this.live.size >= MAX_OPEN_RUNS) this.endOldest();
    const session = new Session(runId ?? newRunId(), input, this.host, this.hooks);
    this.live.set(session.runId, session);
    return session;
  }

  /**
   * @internal AIR-2231, the adapter contract only: the live run a verified reference names, or undefined. Lookup only: it
   * never opens, extends, resumes or revives a run, and an unknown, ended, idle-expired or badly signed reference answers
   * undefined. The reference verifies only under this agent's own key, so it cannot name another agent's run.
   */
  findLive(runRef: unknown): RunSession | undefined {
    if (typeof runRef !== "string") return undefined;
    const runId = this.host.parseRunRef(runRef)?.runId;
    const session = runId === undefined ? undefined : this.live.get(runId);
    if (!session || session.isEnded || session.idle(this.host.now())) return undefined;
    return session;
  }

  /** Only an open run of this registry: work a scope left running after `end` must not write to a run already counted. */
  current(): Session | undefined {
    const session = this.scope.getStore();
    return session && this.live.get(session.runId) === session ? session : undefined;
  }

  /** A promise `fn` returns holds the scope until it settles. */
  withRun<T>(run: RunSession, fn: () => T): T {
    const session = run as Session;
    const leave = session.enter();
    let result: T;
    try {
      result = this.scope.run(session, fn);
    } catch (error) {
      leave();
      throw error;
    }
    if (result instanceof Promise) result.then(leave, leave);
    else leave();
    return result;
  }

  /** The current run takes an observation of a slot it pinned; false sends it on as a one-call run. */
  take(observation: TakenObservation): boolean {
    return this.current()?.take(observation) ?? false;
  }

  /** A direct-path render failure inside the current run marks that slot's row; false writes the one-call error row. */
  renderFailed(slot: string): boolean {
    return this.current()?.renderFailed(slot) ?? false;
  }

  /** The version the direct path serves inside the current run, pinned there; outside a run, `resolve` decides alone. */
  resolveThrough(slot: string, subject: string, tags: Readonly<Record<string, string>> | undefined, resolve: (subject: string, tags?: Readonly<Record<string, string>>) => Resolved, options: { entry: boolean }): { resolved: Resolved; run: Session | undefined } {
    const run = this.current();
    if (!run) return { resolved: resolve(subject, tags), run: undefined };
    if (tags) run.setTags(tags);
    return { resolved: run.resolveThrough(slot, (runSubject, runTags) => resolve(runSubject, runTags), options), run };
  }

  sweep(): void {
    const nowMs = this.host.now();
    for (const session of [...this.live.values()]) if (session.idle(nowMs)) session.endIdle();
  }

  endAll(): void {
    for (const session of [...this.live.values()]) session.endIdle();
  }

  get openRuns(): number {
    return this.live.size;
  }

  /** By the idle rule: the run idle longest that no `withRun` scope holds, and only when every run is held, the oldest. */
  private endOldest(): void {
    let oldest: Session | undefined;
    let oldestHeld: Session | undefined;
    for (const session of this.live.values()) {
      if (session.busy) {
        if (!oldestHeld || session.lastActive < oldestHeld.lastActive) oldestHeld = session;
      } else if (!oldest || session.lastActive < oldest.lastActive) oldest = session;
    }
    (oldest ?? oldestHeld)?.endIdle();
  }
}
