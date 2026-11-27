/**
 * scripts/live-n8n.mjs refuses what would break an offline run before it touches npm or n8n: --nodes-dir needs a
 * prepared folder and N8N_BIN (npx would reach the registry); --prepare-nodes-dir needs an empty folder. The full run
 * needs a real n8n and is exercised by qa/README.md's live run, not here.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const KIT = join(__dirname, "..", "..", "scripts", "live-n8n.mjs");
const run = (args: string[], env: Record<string, string> = {}) => {
  const result = spawnSync("node", [KIT, ...args], { encoding: "utf8", env: { ...process.env, AIRPROMPTER_AGENT_ID: "agent_x", AIRPROMPTER_UPDATE_KEY: "apa_never_used", N8N_BIN: "", N8N_NODES_DIR: "", ...env } });
  return { status: result.status, json: JSON.parse(result.stdout.trim().split("\n").pop() || "{}"), stderr: result.stderr };
};

test("--nodes-dir without N8N_BIN is refused (exit 2), before any npm or n8n", () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-test-"));
  const { status, json } = run(["--nodes-dir", dir]);
  assert.equal(status, 2);
  assert.match(json.error, /needs N8N_BIN/);
  assert.equal(run([], { N8N_NODES_DIR: dir }).status, 2, "the environment variable means the same");
});

test("--nodes-dir with a folder that was never prepared fails with what to do; the key appears in no output", () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-test-"));
  const { status, json, stderr } = run(["--nodes-dir", dir], { N8N_BIN: "/nonexistent/n8n" });
  assert.equal(status, 1);
  assert.match(json.error, /prepare it with --prepare-nodes-dir/);
  assert.ok(!JSON.stringify(json).includes("apa_never_used") && !stderr.includes("apa_never_used"));
});

test("--prepare-nodes-dir refuses a folder that is not empty, and a missing folder name", () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-test-"));
  mkdirSync(join(dir, "x"));
  writeFileSync(join(dir, "x", "keep.txt"), "mine");
  const full = run(["--prepare-nodes-dir", join(dir, "x")]);
  assert.equal(full.status, 2);
  assert.match(full.json.error, /is not empty/);
  assert.equal(run(["--prepare-nodes-dir"]).status, 2);
});
