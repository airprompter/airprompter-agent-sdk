/**
 * S7 (AIR-1975): vendored bundles at boot and in git.
 *
 * A bundle committed beside the code (or stored in a column) is an update
 * like any other once a store exists on the host: a newer one is verified
 * through the same chain as OTA and staged, and the host's apply policy
 * decides; one at the held generation changes nothing; an older one — a
 * `git revert` — is refused with the sentence that names `airprompter
 * rollback`; a tampered or expired one is refused. With nothing held the
 * bundle is still the tier-3 fallback.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent } from "../src/agent.js";
import { createPlaintextBundle } from "../src/bundle/apbundle.js";
import { publicJwkOf } from "../src/protocol/trust.js";
import type { Bundle } from "../src/protocol/types.js";
import { FakeControlPlane } from "../src/testing/index.js";

const scope = { organizationId: "org_1", agentId: "agt_vendored", target: "prod" as const };

function bundleOf(plane: FakeControlPlane, notAfter = "2027-01-01T00:00:00Z"): Bundle {
  return createPlaintextBundle({ createdAt: new Date().toISOString(), notAfter, manifest: plane.manifest!, keySet: plane.root, payloads: [...plane.payloads].map(([contentHash, bytes]) => ({ contentHash: contentHash as `sha256:${string}`, byteLength: bytes.length, bytes: bytes.toString("base64url") })) });
}

function slots(plane: FakeControlPlane, versionId: string) {
  return [plane.slot({ tag: "support.reply", text: `Reply ${versionId} to {{name}}`, versionId, variables: [{ name: "name", required: false, trust: "operator" }] })];
}

async function online(plane: FakeControlPlane, stateDir: string) {
  const ap = await AirPrompterAgent.start({ ...scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" }, fetch: plane.fetch(), telemetry: { sink: "memory" } });
  await ap.stop();
}

async function offline(plane: FakeControlPlane, stateDir: string, bundle: Bundle, extra: { apply?: { policy?: "auto" | "unlock_required"; onStaged?: (s: { generation: number; activate: () => void }) => void }; now?: () => number } = {}) {
  const events: Record<string, unknown>[] = [];
  const ap = await AirPrompterAgent.start({ ...scope, stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, vendoredBundle: { bundle }, logger: (e) => events.push(e), telemetry: { sink: "memory" }, ...extra });
  return { ap, events };
}

test("a newer vendored bundle is an update: verified like OTA, staged, and the host's policy decides — auto activates it, unlock_required stages it for the unlock", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-vendored-"));
  const plane = new FakeControlPlane(scope);
  plane.promote(slots(plane, "v1"));
  await online(plane, stateDir); // the store holds generation 1, pinned auto
  plane.promote(slots(plane, "v2"));
  const newer = bundleOf(plane);
  const { ap, events } = await offline(plane, stateDir, newer);
  try {
    assert.equal(ap.generation, 2, "the committed bundle moved the host forward at boot");
    assert.equal(ap.status().source, "store", "an update lands in the store like OTA, not as a fallback");
    assert.equal(ap.status().applyState, "active");
    assert.equal(ap.prompt("support.reply").render({ name: "x" }).text, "Reply v2 to x");
    assert.ok(events.some((e) => e.event === "vendored_bundle_activated" && e.generation === 2), JSON.stringify(events));
    assert.equal(events.some((e) => e.event === "vendored_bundle_applied"), false, "not the fallback path");
  } finally {
    await ap.stop();
  }
  // The next one, under a local unlock_required: staged, the hook sees it, the unlock makes it live.
  plane.promote(slots(plane, "v3"));
  const staged: number[] = [];
  const { ap: waiting, events: waitingEvents } = await offline(plane, stateDir, bundleOf(plane), { apply: { policy: "unlock_required", onStaged: (s) => staged.push(s.generation) } });
  try {
    assert.equal(waiting.generation, 2, "still serving what it held");
    assert.equal(waiting.status().stagedGeneration, 3);
    assert.equal(waiting.status().applyState, "awaiting_unlock");
    assert.deepEqual(staged, [3], "the change-control hook saw the committed bundle");
    assert.ok(waitingEvents.some((e) => e.event === "vendored_bundle_staged" && e.generation === 3));
    assert.deepEqual(await waiting.unlock(), { generation: 3 });
    assert.equal(waiting.prompt("support.reply").render({ name: "x" }).text, "Reply v3 to x");
  } finally {
    await waiting.stop();
  }
  // Started again with the same bundle: the generation is held, nothing happens.
  const { ap: same, events: sameEvents } = await offline(plane, stateDir, bundleOf(plane));
  try {
    assert.equal(same.generation, 3);
    assert.equal(sameEvents.some((e) => String(e.event).startsWith("vendored_bundle_")), false, "a bundle at the held generation is silent");
  } finally {
    await same.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a git revert to an older bundle is refused with the sentence, and the host keeps serving what it holds; a tampered or expired newer bundle is refused too", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ap-vendored-"));
  const plane = new FakeControlPlane(scope);
  plane.promote(slots(plane, "v1"));
  const older = bundleOf(plane);
  plane.promote(slots(plane, "v2"));
  await online(plane, stateDir); // the store holds generation 2
  const { ap, events } = await offline(plane, stateDir, older);
  try {
    assert.equal(ap.generation, 2, "never moved backwards");
    const refusal = events.find((e) => e.event === "vendored_bundle_refused")!;
    assert.deepEqual({ reason: refusal.reason, bundleGeneration: refusal.bundleGeneration, heldGeneration: refusal.heldGeneration }, { reason: "generation_rollback", bundleGeneration: 1, heldGeneration: 2 });
    assert.match(String(refusal.message), /a rollback is `airprompter rollback`, never an older bundle/);
    assert.equal(ap.status().lastRefusal, "generation_rollback");
    assert.equal(ap.status().applyState, "refused", "the fleet view says so");
    assert.equal(ap.prompt("support.reply").render({ name: "x" }).text, "Reply v2 to x");
  } finally {
    await ap.stop();
  }
  // A newer bundle whose payload was altered after sealing: the chain refuses it before a byte is staged.
  plane.promote(slots(plane, "v3"));
  const tampered = bundleOf(plane);
  const contents = (tampered.encryption as { scheme: "none"; contents: { manifest: { payload: { slots: Array<{ contentHash: string }> } }; payloads: Array<{ contentHash: string; bytes: string }> } }).contents;
  const referenced = contents.payloads.find((entry) => entry.contentHash === contents.manifest.payload.slots[0]!.contentHash)!;
  referenced.bytes = Buffer.from("Reply tampered to {{name}}", "utf8").toString("base64url");
  const { ap: safe, events: safeEvents } = await offline(plane, stateDir, tampered);
  try {
    assert.equal(safe.generation, 2);
    assert.equal(safe.status().stagedGeneration, null, "nothing staged");
    assert.ok(safeEvents.some((e) => e.event === "vendored_bundle_refused" && e.reason === "payload_hash_mismatch"), JSON.stringify(safeEvents));
  } finally {
    await safe.stop();
  }
  // A newer bundle past its notAfter is refused as an update (the store's release is fine); it is only ever applied as the fallback.
  const { ap: stale, events: staleEvents } = await offline(plane, stateDir, bundleOf(plane, "2026-01-01T00:00:00Z"));
  try {
    assert.equal(stale.generation, 2);
    assert.ok(staleEvents.some((e) => e.event === "vendored_bundle_refused" && e.reason === "expired"));
  } finally {
    await stale.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
