/**
 * `airprompter dev`'s hot reload when fs.watch misses events (AIR-2268): the directory is re-read every 500 ms, a read
 * that differs starts the same debounce a watch event does, only two agreeing reads are acted on, and an unchanged
 * fingerprint never promotes. These drive `watchDevRelease` itself with the watcher stubbed out, so what they assert
 * does not depend on the platform's watcher: a silenced watcher (every event dropped), a hand-fired one, one that fails
 * after it starts, and one that cannot start.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, openSync, closeSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { DEV_RESCAN_MS, readDevRelease, watchDevRelease, type DevRelease, type DevWatcher, type WatchFn } from "../src/commands/dev.js";

const until = async (check: () => boolean, what: string | (() => string), timeoutMs = 10_000): Promise<void> => {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${typeof what === "function" ? what() : what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  work: string;
  dir: string;
  watcher: DevWatcher;
  promoted: DevRelease[];
  events: Array<Record<string, unknown>>;
  of: (event: string) => Array<Record<string, unknown>>;
  /** Fire the stubbed watcher, as fs.watch would for `name`. */
  fire: (name: string) => void;
  /** Fail the stubbed watcher, as fs.watch's `error` event would. */
  fail: (error: Error) => void;
  /** Wait for `n` more rescans than now. */
  rescans: (n: number) => Promise<void>;
  done: () => void;
}

interface HarnessOptions {
  /** The real rescan and debounce intervals; otherwise short ones so the tests run quickly. */
  defaults?: boolean;
  debounceMs?: number;
  /** A watcher of the test's own (one that throws, say); otherwise a stub that never fires on its own. */
  watch?: WatchFn;
  /** Make the first promotion throw. */
  promoteThrowsOnce?: boolean;
}

/** A served directory with two prompts, and the reload loop on it. */
function harness(options: HarnessOptions = {}): Harness {
  const work = mkdtempSync(join(tmpdir(), "ap-dev-rescan-"));
  const dir = join(work, "prompts");
  mkdirSync(join(dir, "support"), { recursive: true });
  writeFileSync(join(dir, "support", "triage.md"), "Triage {{ticket}}.\n");
  writeFileSync(join(dir, "support", "reply.txt"), "Reply to {{name}}.");
  let served = readDevRelease(dir);
  const promoted: DevRelease[] = [];
  const events: Array<Record<string, unknown>> = [];
  let listener: ((name: string | null) => void) | null = null;
  let onError: ((error: Error) => void) | null = null;
  let throwOnce = options.promoteThrowsOnce ?? false;
  const watcher = watchDevRelease({
    dir,
    initial: served,
    served: () => served.fingerprint,
    promote: (next) => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error("EACCES: the counter is read-only");
      }
      served = next;
      promoted.push(next);
    },
    log: (event) => events.push(event),
    // By default the watcher is there and never fires on its own: every fs.watch event is dropped.
    watch:
      options.watch ??
      ((_dir, fn, err) => {
        listener = fn;
        onError = err;
        return { close: () => (listener = null) };
      }),
    ...(options.defaults ? {} : { rescanMs: 50, debounceMs: options.debounceMs ?? 30 }),
  });
  return {
    work,
    dir,
    watcher,
    promoted,
    events,
    of: (event) => events.filter((e) => e.event === event),
    fire: (name) => listener?.(name),
    fail: (error) => onError?.(error),
    rescans: async (n) => {
      const target = watcher.stats.rescans + n;
      await until(() => watcher.stats.rescans >= target, `${n} more rescans`);
    },
    done: () => {
      watcher.close();
      rmSync(work, { recursive: true, force: true });
    },
  };
}

const texts = (release: DevRelease) => release.slots.map((s) => [s.tag, s.text]);

test("with fs.watch silenced, an in-place save is still a generation, within two rescans (the real 500 ms interval)", async () => {
  const h = harness({ defaults: true });
  try {
    assert.equal(DEV_RESCAN_MS, 500);
    const rescansAtSave = h.watcher.stats.rescans;
    writeFileSync(join(h.dir, "support", "reply.txt"), "Reply warmly to {{name}}."); // in place: truncate, then write
    await until(() => h.promoted.length > 0, () => `the save promoted with no watch event (rescans ${h.watcher.stats.rescans})`, 10_000);
    // One rescan finds it; the two settling reads run while rescans wait. Counted in rescans, not milliseconds, so a
    // slow runner does not fail it.
    assert.ok(h.watcher.stats.rescans - rescansAtSave <= 2, `promoted after ${h.watcher.stats.rescans - rescansAtSave} rescans`);
    assert.deepEqual(h.promoted.map(texts), [[["support.reply", "Reply warmly to {{name}}."], ["support.triage", "Triage {{ticket}}."]]], "one promotion, the whole save");
  } finally {
    h.done();
  }
});

test("a save written in bursts is promoted once, whole: two reads one debounce apart must agree", async () => {
  // A slow in-place writer: truncate, then the text in chunks 50 ms apart, with the watcher silenced so only rescans
  // see it. Every read while it writes differs from the one before, so nothing is promoted until it is done.
  const h = harness({ debounceMs: 150 });
  try {
    const full = "Reply, slowly and warmly, to {{name}}.";
    const fd = openSync(join(h.dir, "support", "reply.txt"), "w");
    for (let i = 0; i < full.length; i += 6) {
      writeSync(fd, full.slice(i, i + 6));
      await pause(50);
    }
    closeSync(fd);
    await until(() => h.promoted.length > 0, "the promotion");
    await h.rescans(4);
    assert.deepEqual(h.promoted.map(texts), [[["support.reply", full], ["support.triage", "Triage {{ticket}}."]]], "one promotion, never a half-written one");
    assert.deepEqual(h.of("problem"), [], "the empty file seen mid-write was never reported either");
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
    await h.rescans(4);
    assert.deepEqual(h.promoted, [], "an unchanged fingerprint is never a generation");
    assert.deepEqual(h.events, [], "and nothing is logged for it");
  } finally {
    h.done();
  }
});

test("with fs.watch silenced, a bad file is reported once (not on every rescan) and promotes nothing; nor does removing it", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.dir, "Bad Name.md"), "oops");
    await until(() => h.of("problem").length > 0, "the problem reported with no watch event");
    await h.rescans(4);
    assert.equal(h.of("problem").length, 1, JSON.stringify(h.events));
    rmSync(join(h.dir, "Bad Name.md"));
    const reloads = h.watcher.stats.reloads;
    await until(() => h.watcher.stats.reloads > reloads, "the reload after the bad file went");
    assert.deepEqual(h.promoted, [], "neither the bad file nor its removal is a generation");
    assert.equal(h.of("problem").length, 1);
  } finally {
    h.done();
  }
});

test("a folder with no prompt files left keeps serving and says so once, not on every rescan", async () => {
  const h = harness();
  try {
    rmSync(join(h.dir, "support"), { recursive: true });
    await until(() => h.of("kept").length > 0, "kept");
    await h.rescans(4);
    assert.equal(h.of("kept").length, 1, JSON.stringify(h.events));
    assert.deepEqual(h.promoted, []);
  } finally {
    h.done();
  }
});

test("a served folder that is gone is logged once as read_failed; back with the same files, nothing is promoted", async () => {
  const h = harness();
  try {
    renameSync(h.dir, join(h.work, "away"));
    await until(() => h.of("read_failed").length > 0, "read_failed");
    await h.rescans(4);
    assert.equal(h.of("read_failed").length, 1, JSON.stringify(h.events));
    renameSync(join(h.work, "away"), h.dir);
    await h.rescans(4);
    assert.deepEqual(h.promoted, [], "the same release is not a generation");
    assert.equal(h.of("read_failed").length, 1);
  } finally {
    h.done();
  }
});

test("a dangling symlink named as a prompt is reported; any other dangling entry (an editor's leftover) is skipped", { skip: process.platform === "win32" ? "symlinks need a privilege on Windows" : false }, () => {
  const work = mkdtempSync(join(tmpdir(), "ap-dev-rescan-"));
  try {
    writeFileSync(join(work, "triage.md"), "Triage {{ticket}}.\n");
    symlinkSync(join(work, "nowhere.md"), join(work, "ghost.md"));
    symlinkSync(join(work, "nowhere"), join(work, "stale-link"));
    const release = readDevRelease(work);
    assert.deepEqual(release.slots.map((s) => s.tag), ["triage"]);
    assert.equal(release.problems.length, 1, release.problems.join("; "));
    assert.match(release.problems[0]!, /ghost\.md|ENOENT/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("a watcher that fails after it starts is logged once and closed; rescans carry on alone", async () => {
  const h = harness();
  try {
    h.fail(new Error("EPERM: operation not permitted, watch"));
    h.fail(new Error("EPERM again"));
    assert.deepEqual(h.of("watch_failed").map((e) => [e.reason, e.rescanMs]), [["EPERM: operation not permitted, watch", 50]]);
    writeFileSync(join(h.dir, "support", "reply.txt"), "Reply after the watcher failed, {{name}}.");
    await until(() => h.promoted.length === 1, "the save promoted by rescans alone");
  } finally {
    h.done();
  }
});

test("a watcher that cannot start is logged; the server serves on rescans alone", async () => {
  const h = harness({
    watch: () => {
      throw new Error("ENOSYS: recursive watch unsupported");
    },
  });
  try {
    assert.deepEqual(h.of("watch_unavailable").map((e) => [e.reason, e.rescanMs]), [["ENOSYS: recursive watch unsupported", 50]]);
    writeFileSync(join(h.dir, "support", "reply.txt"), "Reply without a watcher, {{name}}.");
    await until(() => h.promoted.length === 1, "the save promoted by rescans alone");
  } finally {
    h.done();
  }
});

test("a promotion that throws is logged, not fatal; the next save is promoted", async () => {
  const h = harness({ promoteThrowsOnce: true });
  try {
    writeFileSync(join(h.dir, "support", "reply.txt"), "Reply once, {{name}}.");
    await until(() => h.of("promote_failed").length === 1, "promote_failed");
    assert.match(String(h.of("promote_failed")[0]!.reason), /EACCES/);
    writeFileSync(join(h.dir, "support", "reply.txt"), "Reply twice, {{name}}.");
    await until(() => h.promoted.length === 1, "the next save promoted");
    assert.equal(h.promoted[0]!.slots.find((s) => s.tag === "support.reply")!.text, "Reply twice, {{name}}.");
  } finally {
    h.done();
  }
});

test("a watch event still drives the reload: one settled reload for a burst of events, then the promotion", async () => {
  const h = harness();
  try {
    const reloads = h.watcher.stats.reloads;
    writeFileSync(join(h.dir, "support", "triage.md"), "Triage {{ticket}} now.\n");
    for (let i = 0; i < 5; i++) h.fire("support/triage.md");
    h.fire(".airprompter-dev/generation"); // the server's own counter is ignored
    await until(() => h.promoted.length === 1, "the promotion");
    assert.equal(h.watcher.stats.reloads, reloads + 1, "a burst is one reload");
    // No second promotion from the rescans that follow: they read what was just promoted.
    await h.rescans(3);
    assert.equal(h.promoted.length, 1);
  } finally {
    h.done();
  }
});

test("close() stops the rescans", async () => {
  const h = harness();
  try {
    await h.rescans(2);
    h.watcher.close();
    const at = h.watcher.stats.rescans;
    writeFileSync(join(h.dir, "support", "reply.txt"), "Reply after close, {{name}}.");
    await pause(300); // six rescan intervals: none may read the folder or promote after close()
    assert.equal(h.watcher.stats.rescans, at);
    assert.deepEqual(h.promoted, []);
  } finally {
    h.done();
  }
});
