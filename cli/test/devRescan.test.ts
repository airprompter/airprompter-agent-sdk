/**
 * `airprompter dev`'s hot reload when fs.watch misses events (AIR-2268): the directory is re-read every 500 ms, a read
 * that differs is handled as a watch event would be, and an unchanged fingerprint never promotes. These drive
 * `watchDevRelease` itself with the watcher stubbed out, so what they assert does not depend on the platform's watcher:
 * a silenced watcher (every event dropped) and a hand-fired one (an event exactly when the test says).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { DEV_RESCAN_MS, readDevRelease, watchDevRelease, type DevRelease, type DevWatcher } from "../src/commands/dev.js";

const until = async (check: () => boolean, what: string | (() => string), timeoutMs = 10_000): Promise<void> => {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${typeof what === "function" ? what() : what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

interface Harness {
  dir: string;
  watcher: DevWatcher;
  promoted: DevRelease[];
  events: Array<Record<string, unknown>>;
  /** Fire the stubbed watcher, as fs.watch would for `name`. */
  fire: (name: string) => void;
  done: () => void;
}

/** A served directory with two prompts, and the reload loop on it. The watcher never fires on its own; `fire` fires it.
 * `defaults`: the real rescan and debounce intervals, else short ones so the tests run quickly. */
function harness(defaults = false): Harness {
  const work = mkdtempSync(join(tmpdir(), "ap-dev-rescan-"));
  const dir = join(work, "prompts");
  mkdirSync(join(dir, "support"), { recursive: true });
  writeFileSync(join(dir, "support", "triage.md"), "Triage {{ticket}}.\n");
  writeFileSync(join(dir, "support", "reply.txt"), "Reply to {{name}}.");
  let served = readDevRelease(dir);
  const promoted: DevRelease[] = [];
  const events: Array<Record<string, unknown>> = [];
  let listener: ((name: string | null) => void) | null = null;
  const watcher = watchDevRelease({
    dir,
    initial: served,
    served: () => served.fingerprint,
    promote: (next) => {
      served = next;
      promoted.push(next);
    },
    log: (event) => events.push(event),
    // The watcher is there and never fires on its own: every fs.watch event is dropped.
    watch: (_dir, fn) => {
      listener = fn;
      return { close: () => (listener = null) };
    },
    ...(defaults ? {} : { rescanMs: 50, debounceMs: 30 }),
  });
  return {
    dir,
    watcher,
    promoted,
    events,
    fire: (name) => listener?.(name),
    done: () => {
      watcher.close();
      rmSync(work, { recursive: true, force: true });
    },
  };
}

test("with fs.watch silenced, an in-place save is still a generation, within a rescan or two (the defaults)", async () => {
  const h = harness(true);
  try {
    assert.equal(DEV_RESCAN_MS, 500);
    const start = performance.now();
    writeFileSync(join(h.dir, "support", "reply.txt"), "Reply warmly to {{name}}."); // in place: truncate, then write
    await until(() => h.promoted.length > 0, () => `the save promoted with no watch event (rescans ${h.watcher.stats.rescans})`, 5_000);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 2 * DEV_RESCAN_MS + 1_000, `picked up in ${Math.round(elapsed)} ms`);
    assert.deepEqual(h.promoted.map((r) => r.slots.map((s) => [s.tag, s.text])), [[["support.reply", "Reply warmly to {{name}}."], ["support.triage", "Triage {{ticket}}."]]], "one promotion, the whole save");
  } finally {
    h.done();
  }
});

test("an unchanged save never promotes: on a watch event, and on rescans with the watcher silenced", async () => {
  const h = harness();
  try {
    // The same bytes again, with a watch event for it: the reload runs and promotes nothing.
    writeFileSync(join(h.dir, "support", "reply.txt"), "Reply to {{name}}.");
    const reloads = h.watcher.stats.reloads;
    h.fire("support/reply.txt");
    await until(() => h.watcher.stats.reloads > reloads, "the reload for the unchanged save");
    // The same bytes again with no event: several rescans read it and promote nothing.
    writeFileSync(join(h.dir, "support", "reply.txt"), "Reply to {{name}}.");
    const rescans = h.watcher.stats.rescans;
    await until(() => h.watcher.stats.rescans >= rescans + 4, "four rescans after the unchanged save");
    assert.deepEqual(h.promoted, [], "an unchanged fingerprint is never a generation");
    assert.deepEqual(h.events, [], "and nothing is logged for it");
  } finally {
    h.done();
  }
});

test("with fs.watch silenced, a bad file is reported once (not on every rescan) and promotes nothing; removing it logs nothing new", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.dir, "Bad Name.md"), "oops");
    await until(() => h.events.some((e) => e.event === "problem"), "the problem reported with no watch event");
    const rescans = h.watcher.stats.rescans;
    await until(() => h.watcher.stats.rescans >= rescans + 4, "four more rescans");
    assert.equal(h.events.filter((e) => e.event === "problem").length, 1, JSON.stringify(h.events));
    rmSync(join(h.dir, "Bad Name.md"));
    const reloads = h.watcher.stats.reloads;
    await until(() => h.watcher.stats.reloads > reloads, "the reload after the bad file went");
    assert.deepEqual(h.promoted, [], "neither the bad file nor its removal is a generation");
    assert.equal(h.events.filter((e) => e.event === "problem").length, 1);
  } finally {
    h.done();
  }
});

test("a watch event still drives the reload: one debounced read for a burst of events, then the promotion", async () => {
  const h = harness();
  try {
    const reloads = h.watcher.stats.reloads;
    writeFileSync(join(h.dir, "support", "triage.md"), "Triage {{ticket}} now.\n");
    for (let i = 0; i < 5; i++) h.fire("support/triage.md");
    h.fire(".airprompter-dev/generation"); // the server's own counter is ignored
    await until(() => h.promoted.length === 1, "the promotion");
    assert.equal(h.watcher.stats.reloads, reloads + 1, "a burst is one reload");
    // No second promotion from the rescans that follow: they read what was just promoted.
    const rescans = h.watcher.stats.rescans;
    await until(() => h.watcher.stats.rescans >= rescans + 3, "three rescans after it");
    assert.equal(h.promoted.length, 1);
  } finally {
    h.done();
  }
});
