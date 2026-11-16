/**
 * n8n-only pieces: the fully offline install (a vendored bundle seeded into the stored copy, AirPrompter never
 * reached), the usage shapes model nodes return, and the rule that the shared core imports nothing from n8n.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPlaintextBundle, publicJwkOf } from "@airprompter/agent-sdk/core";
import { MemoryKvStore } from "@airprompter/agent-sdk/sync";

import { automationDatastore, clientFor } from "../../src/n8n/connect";
import { usageFrom } from "../../src/n8n/usageShapes";
import { harness } from "../helpers";

test("fully offline: a vendored bundle seeds the stored copy and serves with AirPrompter never reached, within its lease", async () => {
  const h = harness();
  h.plane.promote([h.triage("Bundled triage {{ticket}}", "ver_b")], { leaseSeconds: 7 * 86_400 });
  const make = (text?: string) => createPlaintextBundle({ createdAt: new Date().toISOString(), notAfter: new Date(Date.now() + 30 * 86_400_000).toISOString(), manifest: h.plane.manifest!, keySet: h.plane.root, payloads: [...h.plane.payloads].map(([contentHash, bytes]) => ({ contentHash: contentHash as `sha256:${string}`, byteLength: (text ? Buffer.from(text) : bytes).length, bytes: (text ? Buffer.from(text) : bytes).toString("base64url") })) });
  const bundle = make();
  const dir = mkdtempSync(join(tmpdir(), "ap-vendored-"));
  const bundlePath = join(dir, "release.apbundle");
  writeFileSync(bundlePath, JSON.stringify(bundle));
  const datastore = automationDatastore(new MemoryKvStore());
  const credentials = { agentId: "agt_n8n", updateKey: h.plane.apiKey, environment: "prod", apiBaseUrl: "http://127.0.0.1:9", rootKey: JSON.stringify(publicJwkOf(h.plane.rootKey)), bundlePath, storage: "userFolder" as const };
  try {
    const client = await clientFor(credentials, null, { datastore, requestTimeoutMs: 500 });
    const served = await client.getPrompt({ slot: "support.triage", variables: { ticket: "x" } });
    assert.equal(served.versionId, "ver_b");
    assert.equal(served.servedFrom, "stored");

    // A bundle that does not verify is refused when loaded: seeding trusts nothing.
    writeFileSync(bundlePath, JSON.stringify(make("Evil {{ticket}} with a different length")));
    const fresh = await clientFor(credentials, null, { datastore: automationDatastore(new MemoryKvStore()), requestTimeoutMs: 500 });
    await assert.rejects(fresh.getPrompt({ slot: "support.triage", variables: { ticket: "x" } }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage is read from the shapes model nodes return", () => {
  assert.deepEqual(usageFrom({ usage: { prompt_tokens: 812, completion_tokens: 96 } }), { inputTokens: 812, outputTokens: 96 });
  assert.deepEqual(usageFrom({ usage: { input_tokens: 10, output_tokens: 2 } }), { inputTokens: 10, outputTokens: 2 });
  assert.deepEqual(usageFrom({ response: { generations: [], llmOutput: { tokenUsage: { promptTokens: 5, completionTokens: 6 } } } }), { inputTokens: 5, outputTokens: 6 });
  assert.deepEqual(usageFrom({ usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 8 } }), { inputTokens: 7, outputTokens: 8 });
  assert.deepEqual(usageFrom({ output: [{ usage: { inputTokens: 1, outputTokens: 3 } }] }), { inputTokens: 1, outputTokens: 3 });
  assert.equal(usageFrom({ text: "no usage here" }), null);
  assert.equal(usageFrom("string"), null);
});

test("src/core imports nothing from n8n and nothing outside itself (it is the shared core)", () => {
  const dir = join(__dirname, "../../src/core");
  for (const file of readdirSync(dir)) {
    const source = readFileSync(join(dir, file), "utf8");
    assert.doesNotMatch(source, /from ["'](n8n-workflow|n8n-core|zapier-platform-core)["']/, file);
    assert.doesNotMatch(source, /from ["']\.\.\//, `${file} reaches outside core`);
  }
});
