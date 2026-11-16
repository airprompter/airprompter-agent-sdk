/**
 * n8n only: the fully offline install — a vendored bundle named in the credential, seeded into the stored copy, with
 * AirPrompter never reached. (Usage shapes and the Steps core are tested in the SDK, `test/frameworks/steps/`.)
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPlaintextBundle, publicJwkOf } from "@airprompter/agent-sdk/core";
import { MemoryKvStore, kvAutomationDatastore } from "@airprompter/agent-sdk/frameworks/steps";

import { clientFor } from "../../src/n8n/connect";
import { harness } from "../helpers";

test("fully offline: a vendored bundle seeds the stored copy and serves with AirPrompter never reached, within its lease", async () => {
  const h = harness();
  h.plane.promote([h.triage("Bundled triage {{ticket}}", "ver_b")], { leaseSeconds: 7 * 86_400 });
  const make = (text?: string) => createPlaintextBundle({ createdAt: new Date().toISOString(), notAfter: new Date(Date.now() + 30 * 86_400_000).toISOString(), manifest: h.plane.manifest!, keySet: h.plane.root, payloads: [...h.plane.payloads].map(([contentHash, bytes]) => ({ contentHash: contentHash as `sha256:${string}`, byteLength: (text ? Buffer.from(text) : bytes).length, bytes: (text ? Buffer.from(text) : bytes).toString("base64url") })) });
  const bundle = make();
  const dir = mkdtempSync(join(tmpdir(), "ap-vendored-"));
  const bundlePath = join(dir, "release.apbundle");
  writeFileSync(bundlePath, JSON.stringify(bundle));
  const datastore = kvAutomationDatastore(new MemoryKvStore());
  const credentials = { agentId: "agt_n8n", updateKey: h.plane.apiKey, environment: "prod", apiBaseUrl: "http://127.0.0.1:9", rootKey: JSON.stringify(publicJwkOf(h.plane.rootKey)), bundlePath, storage: "userFolder" as const };
  try {
    const client = await clientFor(credentials, null, { datastore, requestTimeoutMs: 500 });
    const served = await client.getPrompt({ slot: "support.triage", variables: { ticket: "x" } });
    assert.equal(served.versionId, "ver_b");
    assert.equal(served.servedFrom, "stored");

    // A bundle that does not verify is refused when loaded: seeding trusts nothing.
    writeFileSync(bundlePath, JSON.stringify(make("Evil {{ticket}} with a different length")));
    const fresh = await clientFor(credentials, null, { datastore: kvAutomationDatastore(new MemoryKvStore()), requestTimeoutMs: 500 });
    await assert.rejects(fresh.getPrompt({ slot: "support.triage", variables: { ticket: "x" } }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
