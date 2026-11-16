/**
 * End to end against the SDK's local registry: `airprompter dev <directory>` from `cli/`, run as its own process.
 * A prompt file is a slot; saving it is a new signed generation. Skips when the CLI's dependencies are not installed
 * (`cd cli && npm ci`).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { MemoryKvStore } from "@airprompter/agent-sdk/sync";

import { createAutomationClient } from "../../src/core";
import { automationDatastore } from "../../src/n8n/connect";

const CLI = resolve(__dirname, "../../../../cli");
const runnable = existsSync(join(CLI, "node_modules", "tsx"));

async function startRegistry(dir: string): Promise<{ baseUrl: string; child: ChildProcess }> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", "dev", dir, "--port", "0", "--environment", "prod", "--json", "--exit-after", "120"], { cwd: CLI, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const baseUrl = await new Promise<string>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`airprompter dev did not start: ${out}`)), 30_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      const match = /"baseUrl"\s*:\s*"([^"]+)"/.exec(out);
      if (match) {
        clearTimeout(timer);
        done(match[1]!);
      }
    });
    child.once("exit", (code) => fail(new Error(`airprompter dev exited ${code}: ${out}`)));
  });
  return { baseUrl, child };
}

test("against `airprompter dev`: credential test, Get prompt, a saved edit is a new version, then served offline", { skip: !runnable && "cli dependencies not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ap-dev-registry-"));
  writeFileSync(join(dir, "triage.md"), "---\nmodel: gpt-5-mini\nvariables: ticket!\nversion: v1\n---\nTriage this ticket: {{ticket}}\n");
  const { baseUrl, child } = await startRegistry(dir);
  const kv = new MemoryKvStore();
  const client = () =>
    createAutomationClient({
      agentId: "agt_dev",
      updateKey: "apa_dev_local",
      baseUrl,
      environment: "prod",
      hostedEnvironment: "prod",
      root: JSON.parse(readFileSync(join(dir, ".airprompter-dev", "root.pub.json"), "utf8")),
      datastore: automationDatastore(kv),
      requestTimeoutMs: 3000,
    });
  try {
    assert.deepEqual(await client().testConnection(), { ok: true, agentId: "agt_dev", environment: "prod" });
    const first = await client().getPrompt({ slot: "triage", variables: { ticket: "Refund" } });
    assert.match(first.prompt, /Triage this ticket: .*Refund/s);
    assert.equal(first.versionId, "v1");
    assert.equal(first.model, "gpt-5-mini");

    writeFileSync(join(dir, "triage.md"), "---\nmodel: gpt-5-mini\nvariables: ticket!\nversion: v2\n---\nSecond version: {{ticket}}\n");
    let second = first;
    for (let attempt = 0; attempt < 40 && second.versionId !== "v2"; attempt += 1) {
      await new Promise((r) => setTimeout(r, 150));
      second = await client().getPrompt({ slot: "triage", variables: { ticket: "Refund" } });
    }
    assert.equal(second.versionId, "v2");
    assert.equal(second.servedFrom, "network");

    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    const offline = await client().getPrompt({ slot: "triage", variables: { ticket: "Refund" } });
    assert.equal(offline.servedFrom, "stored");
    assert.equal(offline.versionId, "v2");
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
