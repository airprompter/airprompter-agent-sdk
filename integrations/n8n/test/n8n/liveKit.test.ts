/**
 * scripts/live-n8n.mjs, the parts that need no real n8n: strict flags (a typo never falls back to npm), the offline
 * mode's refusals before anything is touched, the commit rule for a prepared folder, and that an offline run copies
 * the prepared folder and never calls npm or npx. The full run against a real n8n is qa/README.md's live run.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

const PACKAGE = join(__dirname, "..", "..");
const KIT = join(PACKAGE, "scripts", "live-n8n.mjs");

function scratch(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(args: string[], env: Record<string, string> = {}, script = KIT) {
  const base = { ...process.env };
  delete base.N8N_NODES_DIR;
  delete base.AIRPROMPTER_KIT_NODES_DIR;
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...base, AIRPROMPTER_AGENT_ID: "agent_x", AIRPROMPTER_UPDATE_KEY: "apa_never_used", N8N_BIN: "", AIRPROMPTER_KIT_COMMIT: "", ...env } });
  return { status: result.status, json: JSON.parse(result.stdout.trim().split("\n").pop() || "{}"), stdout: result.stdout, stderr: result.stderr };
}

/** A folder shaped like one --prepare-nodes-dir makes, with a manifest whose hash matches. */
function preparedFolder(t: TestContext, commit = "c0ffee0000000000000000000000000000000000") {
  const dir = scratch(t);
  const pkg = join(dir, "node_modules", "n8n-nodes-airprompter");
  mkdirSync(join(pkg, "node_modules", "@airprompter", "agent-sdk"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "installed-nodes", private: true }));
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "n8n-nodes-airprompter", version: require(join(PACKAGE, "package.json")).version }));
  writeFileSync(join(pkg, "node_modules", "@airprompter", "agent-sdk", "package.json"), JSON.stringify({ name: "@airprompter/agent-sdk", version: "1.0.0-rc.4" }));
  return { dir, pkg, commit };
}

test("strict flags: an unknown flag, a flag without its value, or both modes at once exit 2 before any npm", (t) => {
  for (const args of [["--node-dir", "/x"], ["--nodes-dir"], ["--keep", "--nodes-dir"], ["--prepare-nodes-dir"], ["stray"], ["--keep=1"], ["--nodes-dir", "/a", "--prepare-nodes-dir", "/b"]]) {
    const { status, json } = run(args);
    assert.equal(status, 2, `${args.join(" ")}: ${json.error}`);
    assert.equal(json.ok, false);
  }
  const dir = scratch(t);
  assert.match(run([`--nodes-dir=${dir}`]).json.error, /needs N8N_BIN/, "--flag=value is read like --flag value");
});

test("--nodes-dir: N8N_BIN is required, the folder must be prepared, and nothing is created before those checks", (t) => {
  const dir = scratch(t);
  assert.match(run(["--nodes-dir", dir]).json.error, /needs N8N_BIN/);
  assert.equal(run([], { AIRPROMPTER_KIT_NODES_DIR: dir }).status, 2, "the environment variable means the same");
  assert.match(run([], { N8N_NODES_DIR: dir }).json.error, /is not read/, "the old name is refused, not ignored");
  assert.match(run([], { AIRPROMPTER_KIT_NODES_DIR: "  " }).json.error, /set but empty/);
  assert.match(run(["--nodes-dir", dir], { N8N_BIN: "   " }).json.error, /needs N8N_BIN/, "a blank N8N_BIN is no N8N_BIN");
  const before = readdirSync(tmpdir()).filter((name) => name.startsWith("airprompter-live-n8n-")).length;
  const unprepared = run(["--nodes-dir", dir], { N8N_BIN: "/nonexistent/n8n" });
  assert.equal(unprepared.status, 2);
  assert.match(unprepared.json.error, /make it with --prepare-nodes-dir/);
  assert.equal(readdirSync(tmpdir()).filter((name) => name.startsWith("airprompter-live-n8n-")).length, before, "no run folder was made");
  assert.ok(!unprepared.stdout.includes("apa_never_used") && !unprepared.stderr.includes("apa_never_used"), "the Update key is in no output");
});

/** The kit's own content hash, written out here so a test can build a manifest that matches. */
function contentSha256(dir: string): string {
  const hash = createHash("sha256");
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => relative(dir, join(entry.parentPath ?? (entry as unknown as { path: string }).path, entry.name))).sort();
  for (const file of files) hash.update(`${file}\0`).update(readFileSync(join(dir, file))).update("\0");
  return hash.digest("hex");
}

function fakeTools(t: TestContext) {
  const bin = scratch(t);
  const called = join(bin, "called");
  for (const tool of ["npm", "npx"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho ${tool} >> "${called}"\nexit 1\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  writeFileSync(join(bin, "n8n"), '#!/bin/sh\ncase "$1" in --version) echo 2.49.8;; --help) echo usage;; *) echo "stand-in n8n" >&2; exit 1;; esac\n');
  chmodSync(join(bin, "n8n"), 0o755);
  return { bin, called, env: { N8N_BIN: join(bin, "n8n"), PATH: `${bin}:${process.env.PATH}` } };
}

const PIN = "c0ffee0000000000000000000000000000000000";
const manifest = (dir: string, commit: string) => writeFileSync(join(dir, "airprompter-kit.json"), JSON.stringify({ package: "n8n-nodes-airprompter", packageVersion: require(join(PACKAGE, "package.json")).version, sdkVersion: "1.0.0-rc.4", contentSha256: contentSha256(join(dir, "node_modules")), commit }));
const preparedCheck = (json: { checks: Array<{ id: string; state: string; detail?: Record<string, unknown> }> }) => json.checks.find((entry) => entry.id === "nodes.prepared");

test("nodes.prepared passes only for an intact folder and the exact pinned commit; otherwise n8n is never started", (t) => {
  const { dir } = preparedFolder(t);
  const tools = fakeTools(t);
  manifest(dir, PIN);
  // Outside git, so the pin is the only commit known (in a checkout, its HEAD must match as well).
  const kit = copyOfKit(t);
  const pointer = join(scratch(t), "current");
  symlinkSync(dir, pointer);
  const good = run(["--nodes-dir", pointer], { ...tools.env, AIRPROMPTER_KIT_COMMIT: PIN }, kit);
  assert.equal(preparedCheck(good.json)?.state, "pass", `${good.stderr} (a --nodes-dir that is a symlink is followed once)`);
  assert.match(good.json.error, /import:credentials failed/, "the run went on to n8n");
  for (const [why, env] of [["another pin", { AIRPROMPTER_KIT_COMMIT: "c0ffee0000000000000000000000000000000001" }], ["no pin known (outside git)", {}]] as const) {
    const result = run(["--nodes-dir", dir], { ...tools.env, ...env }, kit);
    assert.equal(preparedCheck(result.json)?.state, "fail", why);
    assert.match(result.json.error, /does not match.*n8n was not started/, why);
  }
  assert.equal(run(["--nodes-dir", dir], { ...tools.env, AIRPROMPTER_KIT_COMMIT: "c0ffee" }).status, 2, "a short pin is refused");
  manifest(dir, "");
  assert.equal(preparedCheck(run(["--nodes-dir", dir], { ...tools.env, AIRPROMPTER_KIT_COMMIT: PIN }, kit).json)?.state, "fail", "an empty manifest commit matches nothing");
  assert.ok(!existsSync(tools.called), "npm and npx were never called");
});

/** The kit and its package.json outside any git checkout, so it knows no checkout commit of its own. */
function copyOfKit(t: TestContext): string {
  const copy = scratch(t);
  mkdirSync(join(copy, "scripts"), { recursive: true });
  cpSync(KIT, join(copy, "scripts", "live-n8n.mjs"));
  cpSync(join(PACKAGE, "package.json"), join(copy, "package.json"));
  return join(copy, "scripts", "live-n8n.mjs");
}

test("an offline run copies the prepared folder and calls neither npm nor npx", (t) => {
  const { dir } = preparedFolder(t);
  // Fake npm and npx that leave a mark if anything calls them.
  const bin = scratch(t);
  const called = join(bin, "called");
  for (const tool of ["npm", "npx"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho ${tool} >> "${called}"\nexit 1\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  // A stand-in n8n: answers --version and --help, then fails at import:credentials, which ends the run there.
  writeFileSync(join(bin, "n8n"), '#!/bin/sh\ncase "$1" in --version) echo 2.49.8;; --help) echo usage;; *) echo "stand-in n8n" >&2; exit 1;; esac\n');
  chmodSync(join(bin, "n8n"), 0o755);
  writeFileSync(join(dir, "airprompter-kit.json"), JSON.stringify({ package: "n8n-nodes-airprompter", packageVersion: require(join(PACKAGE, "package.json")).version, sdkVersion: "1.0.0-rc.4", contentSha256: "set below", commit: "c0ffee0000000000000000000000000000000000" }));
  const env = { N8N_BIN: join(bin, "n8n"), PATH: `${bin}:${process.env.PATH}`, AIRPROMPTER_KIT_COMMIT: "c0ffee0000000000000000000000000000000000" };
  const result = run(["--nodes-dir", dir], env);
  assert.equal(result.json.nodes?.mode, "preinstalled", result.stderr);
  assert.equal(result.json.nodes.kit.commit, "c0ffee0000000000000000000000000000000000");
  const prepared = result.json.checks.find((entry: { id: string }) => entry.id === "nodes.prepared");
  assert.equal(prepared.state, "fail", "a manifest whose content hash does not match the folder fails nodes.prepared");
  assert.equal(prepared.detail.contentHashMatches, false);
  assert.match(result.json.error, /does not match.*n8n was not started/, "a folder that is not what was prepared stops the run before n8n");
  assert.ok(!existsSync(called), "npm and npx were never called");
});

test("--prepare-nodes-dir: refuses --no-build, a folder that is not empty, and a copy with no commit to record", (t) => {
  const dir = scratch(t);
  mkdirSync(join(dir, "full"));
  writeFileSync(join(dir, "full", "keep.txt"), "mine");
  assert.match(run(["--prepare-nodes-dir", join(dir, "full")]).json.error, /not an empty folder/);
  assert.match(run(["--prepare-nodes-dir", join(dir, "new"), "--no-build"]).json.error, /always builds/);
  // A copy of the kit outside any git checkout, with no AIRPROMPTER_KIT_COMMIT: nothing to record, so nothing is built.
  const copy = join(dir, "copy");
  mkdirSync(join(copy, "scripts"), { recursive: true });
  cpSync(KIT, join(copy, "scripts", "live-n8n.mjs"));
  writeFileSync(join(copy, "package.json"), JSON.stringify({ name: "n8n-nodes-airprompter", version: "0.0.0" }));
  const none = run(["--prepare-nodes-dir", join(dir, "new")], {}, join(copy, "scripts", "live-n8n.mjs"));
  assert.equal(none.status, 2);
  assert.match(none.json.error, /no commit to record/);
  assert.ok(!existsSync(join(dir, "new")), "the target was not created");
});
