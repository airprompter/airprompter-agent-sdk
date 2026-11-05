/**
 * The open runs of one agent. `open` is get-or-create on a resume id, so a
 * hook can always ask for the run it belongs to. With no live run it opens a
 * new one with the same id: a repeat resume then finds it, and the subject
 * hashes the same, so a resume after a sweep keeps its arm and counts as a
 * new run. An idle sweep ends what no hook will end, such as a model error
 * LangChain gives no hook for. A scope held by `withRun` keeps a run alive.
 *
 * @example
 * ```ts
 * const runs = new RunRegistry(host);
 * const run = runs.open({ subject: userId });
 * await runs.withRun(run, () => doWork()); // runs.current() is `run` in here, across awaits
 * runs.sweep(); // on a timer; ends runs idle past host.idleTimeoutMs
 * ```
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { RunHost } from "./ports.js";
import { Session } from "./session.js";
import type { RunInput, RunSession } from "./types.js";

export const DEFAULT_RUN_IDLE_TIMEOUT_MS = 15 * 60_000;

export class RunRegistry {
  private readonly live = new Map<string, Session>();
  private readonly scope = new AsyncLocalStorage<Session>();

  constructor(private readonly host: RunHost) {}

  open(input: RunInput = {}): RunSession {
    this.sweep();
    const existing = input.resume === undefined ? undefined : this.live.get(input.resume);
    if (existing) return existing;
    const session = new Session(input.resume ?? `run_${randomUUID()}`, input, this.host, (ended) => {
      if (this.live.get(ended.id) === ended) this.live.delete(ended.id);
    });
    this.live.set(session.id, session);
    return session;
  }

  /** Only an open run: work a scope left running after `end` must not write to a run that has already been counted. */
  current(): RunSession | undefined {
    const session = this.scope.getStore();
    return session && this.live.get(session.id) === session ? session : undefined;
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

  sweep(): void {
    const nowMs = this.host.now();
    for (const session of [...this.live.values()]) if (session.idle(nowMs)) session.endIdle();
  }

  endAll(): void {
    for (const session of [...this.live.values()]) session.endIdle();
  }
}
