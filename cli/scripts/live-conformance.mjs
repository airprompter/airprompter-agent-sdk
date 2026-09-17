#!/usr/bin/env node
// The live conformance target in CI (S12): the built executable serves a
// fixture directory with `airprompter dev`, and `conformance/live.mjs`
// exercises every route with the protocol's schemas and trust chain. Exit 0
// when every check passes; the runner's report is printed either way.
//
//   $ node scripts/live-conformance.mjs dist/airprompter-linux-x64

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const executable = process.argv[2];
if (!executable) {
  console.error("usage: node scripts/live-conformance.mjs <executable>");
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const work = mkdtempSync(join(tmpdir(), "ap-live-"));
const dir = join(work, "prompts");
mkdirSync(join(dir, "support"), { recursive: true });
writeFileSync(join(dir, "support", "triage.md"), "---\nmodel: claude-sonnet-5\nvariables: ticket!, team, customer?\n---\n# Triage\n\nTriage {{ticket}} for {{team}} from {{customer}}.\n");
writeFileSync(join(dir, "support", "reply.txt"), "Reply to {{name}}.\n");
writeFileSync(join(dir, "release.json"), JSON.stringify({ applyPolicy: "auto", leaseSeconds: 600 }));

const dev = spawn(resolve(executable), ["dev", dir, "--port", "0", "--json", "--exit-after", "120"], { stdio: ["ignore", "pipe", "pipe"] });
let facts = null;
let stdout = "";
dev.stdout.setEncoding("utf8");
dev.stdout.on("data", (chunk) => {
  stdout += chunk;
  const line = stdout.split("\n").find((l) => l.startsWith("{"));
  if (line && !facts) facts = JSON.parse(line);
});
const stderr = [];
dev.stderr.setEncoding("utf8");
dev.stderr.on("data", (chunk) => stderr.push(...chunk.split("\n").filter(Boolean)));

const started = Date.now();
while (!facts) {
  if (Date.now() - started > 30_000) {
    console.error(`airprompter dev did not start: ${stderr.join(" | ")}`);
    dev.kill();
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 100));
}

const runner = spawn(process.execPath, [join(repo, "conformance", "live.mjs"), "--base-url", facts.baseUrl, "--agent", "agt_dev", "--environment", "dev", "--api-key", facts.apiKey, "--root", facts.root], { cwd: join(repo, "conformance"), stdio: "inherit" });
const code = await new Promise((r) => runner.once("exit", r));
dev.kill("SIGTERM");
await new Promise((r) => dev.once("exit", r));
rmSync(work, { recursive: true, force: true });
process.exit(code === 0 ? 0 : 1);
