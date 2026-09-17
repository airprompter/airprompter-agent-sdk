/**
 * `airprompter dev` (S12): a directory served as a registry over the
 * protocol's routes. Every save that changes the release is a generation and
 * an unchanged re-read is not; the keys and the generation counter persist
 * across restarts, so a root pinned once verifies later generations and a
 * client never sees a fresh N; the SDK syncs from it exactly as from the
 * hosted service and honours `unlock_required` locally; the live conformance
 * runner passes against it; with `--daemon` the host's SDKs get generation
 * events over the socket.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent } from "../../sdk-typescript/packages/sdk/src/agent.js";
import type { P256PublicJwk } from "../../sdk-typescript/packages/core/src/protocol/types.js";
import { DaemonClient, daemonSocketPath } from "../../sdk-typescript/packages/sync/src/sync/daemon.js";
import { parsePromptFile, parseVariables, readDevRelease, tagFromPath, DEV_API_KEY } from "../src/commands/dev.js";

const cliRoot = join(import.meta.dirname, "..");
const skip = process.platform === "win32" ? "unix sockets and recursive watch differ on Windows; the ubuntu lane covers this" : false;

const until = async (check: () => boolean, label: string | (() => string), timeoutMs = 15_000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${typeof label === "function" ? label() : label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

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
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => stdout.push(...chunk.split("\n").filter(Boolean)));
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => stderr.push(...chunk.split("\n").filter(Boolean)));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return {
    child,
    stdout,
    stderr,
    exited,
    facts: () => JSON.parse(stdout[0]!) as Record<string, unknown>,
    events: () => stderr.map((line) => JSON.parse(line) as Record<string, unknown>),
    stop: async () => {
      child.kill("SIGTERM");
      await exited;
    },
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
  // 0.3.4: `name=default` and `name~` (filled by the application's source), alone or together.
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
      writeFileSync(join(dir, "support", "reply.txt"), "Reply warmly to {{name}}.");
      await until(() => dev.events().some((e) => e.event === "generation" && e.generation === 2), () => `generation 2 (dev said: ${dev.stderr.join(" | ")})`);
      await until(() => ap.generation === 2, "the client on generation 2");
      assert.equal(ap.prompt("support.reply").render({ name: "Bo" }).text, "Reply warmly to Bo.");
      // A save that changes nothing (the same bytes again): no generation.
      writeFileSync(join(dir, "support", "reply.txt"), "Reply warmly to {{name}}.");
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.equal(dev.events().filter((e) => e.event === "generation").length, 1, "an unchanged save is not a generation");
      // A file that does not parse: reported; generation 2 keeps serving.
      writeFileSync(join(dir, "Bad Name.md", ), "oops");
      await until(() => dev.events().some((e) => e.event === "problem"), "the problem reported");
      assert.equal(dev.events().filter((e) => e.event === "generation").length, 1);
      rmSync(join(dir, "Bad Name.md"));
    } finally {
      await ap.stop();
    }

    // Restart: the same keys, the counter continues (a client that holds 2 never sees a fresh 1 or 2).
    await dev.stop();
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

test("the live conformance runner passes against airprompter dev; with --daemon the host's SDKs get the generations over the socket", { skip }, async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-dev-"));
  const dir = fixture(work);
  const dev = startDev(dir, ["--daemon", "--poll-seconds", "1"]);
  try {
    await until(() => dev.stdout.length > 0, () => `the facts (dev said: ${dev.stderr.join(" | ")})`);
    const facts = dev.facts();
    const socketPath = String(facts.daemonSocket);
    assert.equal(socketPath, daemonSocketPath({ stateDir: join(dir, ".airprompter-dev", "state"), agentId: "agt_dev", target: "dev" }));
    await until(() => existsSync(socketPath), "the daemon socket");

    // The runner needs the conformance package's own dependencies (ajv); CI installs them before this suite.
    assert.ok(existsSync(join(cliRoot, "..", "conformance", "node_modules", "ajv")), "conformance/node_modules is installed (npm ci in conformance/)");
    const live = spawn(process.execPath, [join(cliRoot, "..", "conformance", "live.mjs"), "--base-url", String(facts.baseUrl), "--agent", "agt_dev", "--environment", "dev", "--api-key", DEV_API_KEY, "--root", String(facts.root), "--json"], { cwd: join(cliRoot, "..", "conformance"), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let liveErr = "";
    live.stdout.setEncoding("utf8");
    live.stdout.on("data", (chunk: string) => (output += chunk));
    live.stderr.setEncoding("utf8");
    live.stderr.on("data", (chunk: string) => (liveErr += chunk));
    const code = await new Promise<number | null>((resolve) => live.once("exit", resolve));
    const last = output.trim().split("\n").pop() ?? "";
    assert.ok(last.startsWith("{"), `the runner printed no report (exit ${code}): ${liveErr.slice(0, 400)}`);
    const report = JSON.parse(last) as { checks: number; failures: number; results: Array<{ route: string; rule: string; ok: boolean; detail?: string }> };
    assert.equal(code, 0, report.results.filter((r) => !r.ok).map((r) => `${r.route} ${r.rule}: ${r.detail}`).join("\n"));
    assert.ok(report.checks >= 20 && report.failures === 0, JSON.stringify({ checks: report.checks, failures: report.failures }));

    // An SDK attached to the embedded daemon sees the next save as a generation event over the socket.
    const client = await DaemonClient.connect({ socketPath, agentId: "agt_dev", target: "dev", sdk: "test/0" });
    assert.ok(client, "attached");
    const seen: number[] = [];
    client!.onEvent((event) => {
      if (event.event === "generation") seen.push(Number(event.generation));
    });
    writeFileSync(join(dir, "support", "reply.txt"), "Reply again to {{name}}.");
    await until(() => seen.includes(2), () => `generation 2 over the socket (seen ${seen.join(",")}; dev said: ${dev.stderr.slice(-4).join(" | ")})`, 20_000);
    client!.close();
  } finally {
    await dev.stop();
    rmSync(work, { recursive: true, force: true });
  }
});
