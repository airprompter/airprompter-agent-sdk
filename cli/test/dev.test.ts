/**
 * `airprompter dev` (S12): a directory served as a registry over the
 * protocol's routes. Every save that changes the release is a generation and
 * an unchanged re-read is not; the keys and the generation counter persist
 * across restarts, so a root pinned once verifies later generations and a
 * client never sees a fresh N; the SDK syncs from it exactly as from the
 * hosted service and honours `unlock_required` locally; the live conformance
 * runner passes against it; a resident SDK pointed at it picks up the next
 * save; `--daemon` (the release-serving daemon) is refused since 0.3.0.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent } from "../../sdk-typescript/packages/sdk/src/agent.js";
import type { P256PublicJwk } from "../../sdk-typescript/packages/sdk/src/core/protocol/types.js";
import { parsePromptFile, parseVariables, readDevRelease, tagFromPath, DEV_API_KEY } from "../src/commands/dev.js";
import { childLines, jsonLines } from "./helpers/child.js";
import { saveAtomic, saveInPlace } from "./helpers/save.js";
import { until } from "./helpers/wait.js";

const cliRoot = join(import.meta.dirname, "..");
const skip = process.platform === "win32" ? "unix sockets and recursive watch differ on Windows; the ubuntu lane covers this" : false;

interface DevProcess {
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
  exited: Promise<number | null>;
  facts: () => Record<string, unknown>;
  events: () => Array<Record<string, unknown>>;
  stop: () => Promise<void>;
}

function startDev(dir: string, args: string[] = []): DevProcess {
  const child = spawn(process.execPath, ["--import", "tsx", join(cliRoot, "src", "main.ts"), "dev", dir, "--port", "0", "--json", ...args], { cwd: cliRoot, stdio: ["ignore", "pipe", "pipe"] });
  const lines = childLines(child);
  return {
    child,
    stdout: lines.stdout,
    stderr: lines.stderr,
    exited: lines.closed,
    facts: () => JSON.parse(lines.stdout[0]!) as Record<string, unknown>,
    // A line that is not JSON (a runtime warning) is skipped here and stays in `stderr` for the failure messages.
    events: () => jsonLines(lines.stderr),
    stop: async () => void (await lines.stop()),
  };
}

function fixture(root: string): string {
  const dir = join(root, "prompts");
  mkdirSync(join(dir, "support"), { recursive: true });
  writeFileSync(join(dir, "support", "Triage.md"), "---\nmodel: claude-sonnet-5\nvariables: ticket!, team, customer?\n---\n# Triage\n\nTriage {{ticket}} for {{team}} from {{customer}}.\n");
  writeFileSync(join(dir, "support", "reply.txt"), "Reply to {{name}}.");
  writeFileSync(join(dir, "notes.png"), "not a prompt");
  return dir;
}

test("the directory reads as a release: tags from paths, front matter for model and variables, release.json for the policy; a bad file is a problem, not a crash; the fingerprint follows the release and nothing else", () => {
  assert.equal(tagFromPath("support/Triage.md"), "support.triage");
  assert.equal(tagFromPath("sales/q4/Pitch.prompt"), "sales.q4.pitch");
  assert.deepEqual(parseVariables("ticket!, team, customer?"), [{ name: "ticket", required: true, trust: "operator" }, { name: "team", required: false, trust: "operator" }, { name: "customer", required: true, trust: "end_user" }]);
  // `name=default` and `name~` (filled by the application's source), alone or together.
  assert.deepEqual(parseVariables("tone=warm and brief, customer_tier~, region~=eu-west"), [
    { name: "tone", required: false, trust: "operator", default: "warm and brief" },
    { name: "customer_tier", required: false, trust: "operator", source: "runtime" },
    { name: "region", required: false, trust: "operator", default: "eu-west", source: "runtime" },
  ]);
  assert.throws(() => parseVariables("ticket!=x"), /a default belongs to an optional operator variable only/);
  assert.throws(() => parseVariables("customer?=x"), /a default belongs to an optional operator variable only/);
  assert.deepEqual(parseVariables("ticket!~, customer?~"), [{ name: "ticket", required: true, trust: "operator", source: "runtime" }, { name: "customer", required: true, trust: "end_user", source: "runtime" }], "the markers go in one order");
  assert.throws(() => parseVariables("ticket~!"), /the name must match/, "the other order is not a variable called ticket~");
  assert.throws(() => parseVariables("~"), /the name must match/);
  assert.throws(() => parseVariables("tone="), /a default is never empty/);
  const spec = parsePromptFile("support/Triage.md", "---\nmodel: gpt-5\nversion: rev-3\n---\nHello {{name}}");
  assert.deepEqual({ tag: spec.tag, model: spec.model, versionId: spec.versionId, text: spec.text }, { tag: "support.triage", model: "gpt-5", versionId: "rev-3", text: "Hello {{name}}" });
  assert.throws(() => parsePromptFile("Bad Name.md", "x"), /not a slot tag/);
  const work = mkdtempSync(join(tmpdir(), "ap-dev-"));
  try {
    const dir = fixture(work);
    const first = readDevRelease(dir);
    assert.deepEqual(first.slots.map((s) => s.tag), ["support.reply", "support.triage"], "every prompt file, sorted; the png is not one");
    assert.deepEqual(first.problems, []);
    const same = readDevRelease(dir);
    assert.equal(same.fingerprint, first.fingerprint, "an unchanged directory is the same release");
    writeFileSync(join(dir, "release.json"), JSON.stringify({ applyPolicy: "unlock_required", leaseSeconds: 600 }));
    const policy = readDevRelease(dir);
    assert.notEqual(policy.fingerprint, first.fingerprint, "release.json is part of the release");
    assert.equal(policy.options.applyPolicy, "unlock_required");
    writeFileSync(join(dir, "empty.md"), "   \n");
    writeFileSync(join(dir, "support", "triage.prompt"), "a second file for the same tag");
    const broken = readDevRelease(dir);
    assert.deepEqual(broken.slots.map((s) => s.tag), ["support.reply", "support.triage"], "the broken files are left out");
    assert.equal(broken.problems.length, 2, broken.problems.join("; "));
    assert.match(broken.problems.join("\n"), /empty\.md: empty/);
    assert.match(broken.problems.join("\n"), /already/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("an SDK syncs from airprompter dev as from the hosted service; a save is a generation and an unchanged save is not; the keys and the counter persist across a restart; unlock_required is honoured locally", { skip }, async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-dev-"));
  const dir = fixture(work);
  let dev = startDev(dir);
  try {
    await until(() => dev.stdout.length > 0, () => `the facts (dev said: ${dev.stderr.join(" | ")})`);
    const facts = dev.facts();
    assert.equal(facts.generation, 1);
    assert.equal(facts.apiKey, DEV_API_KEY);
    const rootPath = String(facts.root);
    assert.ok(existsSync(rootPath), "the root to pin is on disk");
    assert.equal((statSync(join(dir, ".airprompter-dev", "keys.json")).mode & 0o777).toString(8), "600", "the dev keys are 0600");
    const pinned = JSON.parse(readFileSync(rootPath, "utf8")) as P256PublicJwk;
    assert.equal(pinned.kty, "EC");
    assert.equal("d" in pinned, false, "the public root carries no private part");
    const baseUrl = String(facts.baseUrl);

    // An SDK client: the same start as against the hosted service.
    const stateDir = join(work, "sdk-state");
    const events: Array<Record<string, unknown>> = [];
    const ap = await AirPrompterAgent.start({ organizationId: "org_dev", agentId: "agt_dev", target: "dev", apiKey: DEV_API_KEY, baseUrl, stateDir, root: { pinned, hostedEnvironment: "dev" }, sync: { mode: "resident", pollSeconds: 1, edgePointerUrl: String(facts.edgePointerUrl), rootUrl: String(facts.rootUrl) }, telemetry: { sink: "memory" }, logger: (e) => events.push(e) });
    try {
      assert.equal(ap.generation, 1);
      const rendered = ap.prompt("support.triage").render({ ticket: "T-1", customer: "Ada" });
      assert.match(rendered.text, /Triage T-1 for  from <customer>Ada<\/customer>/);
      assert.equal(rendered.model, "claude-sonnet-5");
      assert.deepEqual(ap.prompt("support.triage").variables().map((v) => [v.name, v.required, v.trust]), [["ticket", true, "operator"], ["team", false, "operator"], ["customer", true, "end_user"]]);

      // A save that changes the release: generation 2 on the server, then on the client within a poll.
      // (The server sees it through fs.watch, or its 500 ms rescan when fs.watch misses it, AIR-2268. An atomic save,
      // because this test counts generations: a torn in-place write of reply.txt could be one, without the slot.)
      saveAtomic(work, join(dir, "support", "reply.txt"), "Reply warmly to {{name}}.");
      await until(() => dev.events().some((e) => e.event === "generation" && e.generation === 2), () => `generation 2 (dev said: ${dev.stderr.join(" | ")})`);
      await until(() => ap.generation === 2, "the client on generation 2");
      assert.equal(ap.prompt("support.reply").render({ name: "Bo" }).text, "Reply warmly to Bo.");
      // A save that changes nothing (the same bytes again), then a file that does not parse: no generation from either,
      // the problem reported, generation 2 keeps serving. The count is read once the server has stopped and its stderr
      // is drained (below), not after a sleep. (Here the two saves may share one reload; that an unchanged save on its
      // own never promotes, on a watch event and on rescans, is asserted deterministically in devRescan.test.ts.)
      saveAtomic(work, join(dir, "support", "reply.txt"), "Reply warmly to {{name}}.");
      saveAtomic(work, join(dir, "Bad Name.md"), "oops");
      await until(() => dev.events().some((e) => e.event === "problem"), () => `the problem reported (dev said: ${dev.stderr.join(" | ")})`);
      rmSync(join(dir, "Bad Name.md"));
    } finally {
      await ap.stop();
    }

    // Restart: the same keys, the counter continues (a client that holds 2 never sees a fresh 1 or 2).
    await dev.stop();
    const generations = dev.events().filter((e) => e.event === "generation").map((e) => e.generation);
    assert.deepEqual(generations, [2], `one save, one generation: the unchanged save and the bad file are not generations (dev said: ${dev.stderr.join(" | ")})`);
    assert.equal(dev.events().find((e) => e.event === "stopped")?.generation, 2, "the server stopped on generation 2");
    writeFileSync(join(dir, "release.json"), JSON.stringify({ applyPolicy: "unlock_required" }));
    dev = startDev(dir);
    await until(() => dev.stdout.length > 0, "restarted");
    const restarted = dev.facts();
    assert.equal(restarted.generation, 3, "the counter persisted: the restart's release is generation 3");
    assert.equal(restarted.applyPolicy, "unlock_required");
    assert.deepEqual(JSON.parse(readFileSync(String(restarted.root), "utf8")), pinned, "the same root");
    const again = await AirPrompterAgent.start({ organizationId: "org_dev", agentId: "agt_dev", target: "dev", apiKey: DEV_API_KEY, baseUrl: String(restarted.baseUrl), stateDir, root: { pinned, hostedEnvironment: "dev" }, sync: { mode: "resident", pollSeconds: 1, edgePointerUrl: String(restarted.edgePointerUrl), rootUrl: String(restarted.rootUrl) }, telemetry: { sink: "memory" } });
    try {
      // The store held generation 2 under the old policy; generation 3 says unlock_required, so it is staged and waits.
      await until(() => again.status().stagedGeneration === 3, () => `generation 3 staged (status: ${JSON.stringify(again.status())})`);
      assert.equal(again.generation, 2, "the client keeps serving 2 until the unlock");
      assert.equal(again.status().applyState, "awaiting_unlock");
      const unlocked = await again.unlock();
      assert.equal(unlocked?.generation, 3);
      assert.equal(again.generation, 3);
    } finally {
      await again.stop();
    }
  } finally {
    await dev.stop();
    rmSync(work, { recursive: true, force: true });
  }
});

test("the live conformance runner passes against airprompter dev; a resident SDK pointed at it picks up the next save, made in place", { skip }, async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-dev-"));
  const dir = fixture(work);
  // An empty release.json from the start: it does not parse, so it is a problem and the options are the defaults, the
  // same release as no file at all. The save below rewrites it in place.
  saveAtomic(work, join(dir, "release.json"), "");
  const dev = startDev(dir, []);
  try {
    await until(() => dev.stdout.length > 0, () => `the facts (dev said: ${dev.stderr.join(" | ")})`);
    const facts = dev.facts();

    // The runner needs the conformance package's own dependencies (ajv); CI installs them before this suite.
    assert.ok(existsSync(join(cliRoot, "..", "conformance", "node_modules", "ajv")), "conformance/node_modules is installed (npm ci in conformance/)");
    const live = spawn(process.execPath, [join(cliRoot, "..", "conformance", "live.mjs"), "--base-url", String(facts.baseUrl), "--agent", "agt_dev", "--environment", "dev", "--api-key", DEV_API_KEY, "--root", String(facts.root), "--json"], { cwd: join(cliRoot, "..", "conformance"), stdio: ["ignore", "pipe", "pipe"] });
    // `closed` waits for the runner's stdout to drain: on `exit` alone the report line can still be in the pipe.
    const runner = childLines(live);
    const code = await runner.closed;
    const last = runner.stdout.at(-1) ?? "";
    assert.ok(last.startsWith("{"), `the runner printed no report (exit ${code}): ${runner.stderr.join("\n").slice(0, 400)}`);
    const report = JSON.parse(last) as { checks: number; failures: number; results: Array<{ route: string; rule: string; ok: boolean; detail?: string }> };
    assert.equal(code, 0, report.results.filter((r) => !r.ok).map((r) => `${r.route} ${r.rule}: ${r.detail}`).join("\n"));
    assert.ok(report.checks >= 20 && report.failures === 0, JSON.stringify({ checks: report.checks, failures: report.failures }));

    // A resident SDK pointed at the registry sees the next save on its next pass.
    const ap = await AirPrompterAgent.start({
      organizationId: "org_dev",
      agentId: "agt_dev",
      target: "dev",
      apiKey: DEV_API_KEY,
      baseUrl: String(facts.baseUrl),
      stateDir: join(work, "sdk-state"),
      root: { pinned: JSON.parse(readFileSync(String(facts.root), "utf8")) as P256PublicJwk, hostedEnvironment: "dev" },
      sync: { mode: "resident", pollSeconds: 3600, edgePointerUrl: String(facts.edgePointerUrl), rootUrl: String(facts.rootUrl) },
      telemetry: { upload: false },
    });
    try {
      assert.equal(ap.generation, 1);
      // An in-place save (truncate, then write: what `open('w')`, `echo >` and most editors do), and the only change
      // since the server started. Its half-written states (empty, or JSON cut short) read as the release already
      // served, so they cannot promote: exactly one generation, the whole save.
      saveInPlace(join(dir, "release.json"), JSON.stringify({ leaseSeconds: 600 }));
      await until(() => readFileSync(join(dir, ".airprompter-dev", "generation"), "utf8").trim() === "2", () => `the in-place save promoted as generation 2 (dev said: ${dev.stderr.slice(-4).join(" | ")})`, 20_000);
      await ap.syncNow();
      assert.equal(ap.generation, 2);
      // The counter is written just before the line is logged: wait for the line, then count.
      await until(() => dev.events().some((e) => e.event === "generation"), "the generation line");
      assert.deepEqual(dev.events().filter((e) => e.event === "generation").map((e) => e.generation), [2], "one save, one generation");
    } finally {
      await ap.stop();
    }
  } finally {
    await dev.stop();
    rmSync(work, { recursive: true, force: true });
  }
});

test("dev --daemon is refused since 0.3.0: SDKs sync from the registry directly", async () => {
  const { run } = await import("../src/cli.js");
  const { EXIT } = await import("../src/io.js");
  const work = mkdtempSync(join(tmpdir(), "ap-dev-"));
  try {
    const dir = fixture(work);
    const errors: string[] = [];
    const ctx = { stdout: () => {}, stderr: (l: string) => errors.push(l), env: {}, cwd: work, now: () => Date.now(), fetch: null, isTTY: false };
    assert.equal(await run(["dev", dir, "--daemon"], ctx), EXIT.usage);
    assert.match(errors.join("\n"), /removed in 0\.3\.0/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
