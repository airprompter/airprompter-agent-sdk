/**
 * The roots `@airprompter/agent-sdk/frameworks/steps` pins (`HOSTED_ROOTS`): each one is the key the offline ceremony
 * wrote, the real root document that ceremony signed verifies under it, and nothing signed by another root does.
 *
 * `fixtures/hosted-dev-root.json` is the service repository's `infrastructure/trust/agent-root/dev/root.json`,
 * byte for byte (public: keys and signatures only).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { keyThumbprint, publicJwkOf, trustedRootFromPinnedKey, verifyRootMetadata } from "../../../packages/sdk/src/core/index.js";
import type { P256PublicJwk, RootMetadata } from "../../../packages/sdk/src/core/index.js";
import { FakeControlPlane } from "../../../packages/sdk/src/core/testing/index.js";
import { MemoryKvStore } from "../../../packages/sdk/src/sync/index.js";
import { HOSTED_ROOTS, createAutomationClient, isAutomationError, kvAutomationDatastore, pinnedRootFor } from "../../../packages/sdk/src/frameworks/steps/index.js";

const devRootDocument = JSON.parse(readFileSync(new URL("./fixtures/hosted-dev-root.json", import.meta.url), "utf8")) as RootMetadata;
// Inside the document's validity (it was signed 2026-09-14 and expires 2026-12-13); renewal re-signs it under the same root.
const NOW = "2026-11-16T00:00:00.000Z";

const trustedUnder = (pinnedRoot: P256PublicJwk) => trustedRootFromPinnedKey({ purpose: "platform", environment: "dev", pinnedRoot });

test("dev is pinned to the ceremony's root key; prod is not pinned until its ceremony runs", () => {
  const dev = HOSTED_ROOTS.dev!;
  assert.ok(dev, "a dev root is pinned");
  assert.equal(keyThumbprint(dev), "86267aa3dc49005a0c1474d5c9c06bd7e1d0e835da715a864c1eca706545df91");
  assert.deepEqual(devRootDocument.signed.roles.root.keyIds, [keyThumbprint(dev)], "the ceremony's document names the pinned key as its root");
  assert.equal(HOSTED_ROOTS.prod, undefined);
  assert.equal(pinnedRootFor("prod"), null);
});

test("the root document AirPrompter's dev ceremony signed verifies under the pinned dev root", () => {
  assert.deepEqual(verifyRootMetadata({ candidate: devRootDocument, trusted: trustedUnder(HOSTED_ROOTS.dev!), now: NOW }), { ok: true });
});

test("a root document signed by any other root is refused under the pinned dev root", () => {
  const stranger = new FakeControlPlane({ organizationId: "org_test", agentId: "agt_steps", target: "dev" }, undefined, {}, { hostedEnvironment: "dev" });
  assert.equal(stranger.root.signed.environment, "dev");
  assert.deepEqual(verifyRootMetadata({ candidate: stranger.root, trusted: trustedUnder(HOSTED_ROOTS.dev!), now: NOW }), { ok: false, reason: "root_signature_invalid" });

  // The real document with its targets key swapped is no longer the root's signature.
  const forged = structuredClone(devRootDocument);
  const strangerSigningId = stranger.root.signed.roles.targets.keyIds[0]!;
  forged.signed.keys[strangerSigningId] = stranger.root.signed.keys[strangerSigningId]!;
  forged.signed.roles.targets.keyIds = [strangerSigningId];
  assert.deepEqual(verifyRootMetadata({ candidate: forged, trusted: trustedUnder(HOSTED_ROOTS.dev!), now: NOW }), { ok: false, reason: "root_signature_invalid" });

  // And the real document does not verify under another root.
  assert.deepEqual(verifyRootMetadata({ candidate: devRootDocument, trusted: trustedUnder(publicJwkOf(stranger.rootKey)), now: NOW }), { ok: false, reason: "root_signature_invalid" });
});

test("the client verifies through HOSTED_ROOTS with no root passed in: a manifest under the pinned root serves, any other is refused and never stored", async () => {
  const plane = new FakeControlPlane({ organizationId: "org_test", agentId: "agt_steps", target: "prod" }, undefined, {}, { hostedEnvironment: "dev" });
  plane.grantBaseUrl = "https://bucket.test";
  plane.promote([plane.slot({ tag: "support.triage", text: "Triage: {{ticket}}", versionId: "ver_1", variables: [{ name: "ticket", required: true, trust: "end_user" }] })]);
  const kv = new MemoryKvStore();
  const client = () => createAutomationClient({ agentId: "agt_steps", updateKey: plane.apiKey, baseUrl: "https://api.test", hostedEnvironment: "dev", environment: "prod", datastore: kvAutomationDatastore(kv), fetch: plane.fetch() });

  // The real pinned dev root did not sign this plane's root document: refused, nothing stored.
  await assert.rejects(client().getPrompt({ slot: "support.triage", variables: { ticket: "x" } }), (error: unknown) => isAutomationError(error));
  assert.deepEqual((await kv.list("")).filter((key) => key.includes("/releases/")), []);

  // The same plane with its root pinned (as a release of this package would pin it): verified and served.
  const pinned = HOSTED_ROOTS.dev;
  HOSTED_ROOTS.dev = publicJwkOf(plane.rootKey);
  try {
    const result = await client().getPrompt({ slot: "support.triage", variables: { ticket: "x" } });
    assert.equal(result.versionId, "ver_1");
    assert.equal(result.servedFrom, "network");
  } finally {
    HOSTED_ROOTS.dev = pinned!;
  }
});
