/**
 * Waiting on observable state with a deadline, on the monotonic clock (a wall-clock step never stretches or cuts it).
 * `what` may be a function, read only on a timeout, so a failure message can carry the state at that moment (a
 * server's log, a client's status).
 */

import { performance } from "node:perf_hooks";

export async function until(check: () => boolean | Promise<boolean>, what: string | (() => string), timeoutMs = 15_000, everyMs = 50): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${typeof what === "function" ? what() : what}`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
