/**
 * 0.3.5 pins.md: the customer's own copy of a release (`MirrorPort`), materialised once, rendered from once
 * written, its seal recomputed each tick with core's `verifySeal`. Beside `test/store.test.ts`: the store is the
 * VERIFIED copy, the mirror is the CUSTOMER's copy, and the seal is the bridge between them. Two-slot fixtures
 * throughout, so a materialise that touches only what changed is distinguishable from one that touches everything.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent } from "../packages/sdk/src/agent.js";
import type { MirrorCopy, MirrorPort } from "../packages/sdk/src/mirror.js";
import { publicJwkOf } from "../packages/core/src/protocol/trust.js";
import { sealIdOf } from "../packages/core/src/protocol/seal.js";
import { FakeControlPlane } from "../packages/core/src/testing/index.js";

const scope = { organizationId: "org_1", agentId: "agt_mirror", target: "prod" as const };
const tempDir = () => mkdtempSync(join(tmpdir(), "ap-mirror-"));

function slots(plane: FakeControlPlane, marker: string) {
  return [
    plane.slot({ tag: "support.triage", text: `Triage ${marker} {{ticket}}.`, variables: [{ name: "ticket", required: true, trust: "operator" }] }),
    plane.slot({ tag: "support.reply", text: `Reply ${marker} to {{name}}.`, variables: [{ name: "name", required: false, trust: "operator" }], model: "gpt-5" }),
  ];
}

/** An in-memory `MirrorPort`: a test edits `.stored` directly to simulate drift, and counts `writes`/`reads`. */
class InMemoryMirrorPort implements MirrorPort {
  stored: MirrorCopy | null = null;
  writes = 0;
  reads = 0;
  resyncRequests: Array<{ sealId: string }> = [];
  async read(): Promise<MirrorCopy | null> {
    this.reads += 1;
    if (this.throwOnRead) throw new Error("store unreachable");
    return this.stored ? { sealId: this.stored.sealId, pins: this.stored.pins.map((p) => ({ ...p })), texts: { ...this.stored.texts } } : null;
  }
  async write(copy: MirrorCopy): Promise<void> {
    this.writes += 1;
    this.stored = { sealId: copy.sealId, pins: copy.pins.map((p) => ({ ...p })), texts: { ...copy.texts } };
  }
  throwOnRead = false;
  onResyncRequested(request: { sealId: string }): void {
    this.resyncRequests.push({ sealId: request.sealId });
  }
}

async function start(plane: FakeControlPlane, stateDir: string, extra: Partial<Parameters<typeof AirPrompterAgent.start>[0]> = {}) {
  return AirPrompterAgent.start({
    ...scope,
    apiKey: plane.apiKey,
    baseUrl: "https://api.test",
    stateDir,
    root: { pinned: publicJwkOf(plane.rootKey) },
    sync: { mode: "resident", pollSeconds: 3600, edgePointerUrl: "https://edge.test/g/token/generation.json", rootUrl: "https://edge.test/roots/prod/root.json" },
    fetch: plane.fetch(),
    telemetry: { upload: false },
    ...extra,
  });
}

test("materialise once: the mirror writes the release's two pins and their texts on registration; a second tick writes nothing more", async () => {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  const [t, r] = slots(plane, "A");
  plane.promote([t!, r!]);
  const ap = await start(plane, stateDir);
  const port = new InMemoryMirrorPort();
  try {
    const handle = ap.mirror(port);
    // `mirror()` reconciles in the background; give it a tick.
    await handle.refresh();
    assert.equal(port.writes, 1, "materialised once");
    assert.equal(port.stored?.pins.length, 2, "both slots");
    assert.equal(Object.keys(port.stored?.texts ?? {}).length, 2, "both texts");

    await ap.syncNow();
    assert.equal(port.writes, 1, "a second tick with nothing new writes nothing more");
  } finally {
    await ap.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a tampered text breaks the seal: intact is false, changedTags names the tag, brokenAt is stamped once, render reads the edited text, seal_broken is logged once", async () => {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  const [t, r] = slots(plane, "A");
  const manifest = plane.promote([t!, r!]);
  const events: Array<Record<string, unknown>> = [];
  const ap = await start(plane, stateDir, { logger: (e) => events.push(e) });
  const port = new InMemoryMirrorPort();
  try {
    const handle = ap.mirror(port);
    await handle.refresh();
    assert.equal(port.writes, 1);

    // Edit one byte of the triage slot's text in the port's own store.
    const triagePin = port.stored!.pins.find((p) => p.tag === "support.triage")!;
    const original = Buffer.from(port.stored!.texts[triagePin.contentHash]!, "base64url").toString("utf8");
    port.stored!.texts[triagePin.contentHash] = Buffer.from(original.replace("A", "X")).toString("base64url");

    await ap.syncNow(); // reconciles the mirror; the tick itself changes nothing content-wise.
    const report = ap.seal();
    assert.equal(report?.intact, false);
    assert.deepEqual(report?.changedTags, ["support.triage"]);
    assert.ok(report?.brokenAt, "brokenAt stamped");
    assert.equal(port.writes, 1, "the write count did not move — a broken copy is never overwritten");

    const rendered = ap.prompt("support.triage").render({ ticket: "t" });
    assert.equal(rendered.text, "Triage X t.", "renders the EDITED text — the mirror is the source of truth, drift is reported not blocking");
    assert.equal(rendered.resolutionSource, "customer_store");

    await ap.heartbeatNow();
    const hb = plane.heartbeats.at(-1)!;
    const sealMember = hb.seal as { intact: boolean; brokenAt?: string; changedTags?: string[] } | undefined;
    assert.equal(sealMember?.intact, false);
    assert.ok(sealMember?.brokenAt, "the heartbeat carries brokenAt");

    assert.equal(events.filter((e) => e.event === "seal_broken").length, 1, "seal_broken logged exactly once across the ticks above");
    void manifest;
  } finally {
    await ap.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a settings-only drift and a missing slot are each named by tag", async () => {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  const [t, r] = slots(plane, "A");
  plane.promote([t!, r!]);
  const ap = await start(plane, stateDir);
  const port = new InMemoryMirrorPort();
  try {
    const handle = ap.mirror(port);
    await handle.refresh();

    // A settings change on the reply pin, text untouched.
    const replyPin = port.stored!.pins.find((p) => p.tag === "support.reply")!;
    replyPin.model = "gpt-6";
    await handle.refresh();
    let report = ap.seal();
    assert.equal(report?.intact, false);
    assert.deepEqual(report?.changedTags, ["support.reply"]);

    // Remove the triage slot from the copy entirely.
    replyPin.model = "gpt-5"; // heal the settings drift first
    port.stored!.pins = port.stored!.pins.filter((p) => p.tag !== "support.triage");
    await handle.refresh();
    report = ap.seal();
    assert.equal(report?.intact, false);
    assert.deepEqual(report?.changedTags, ["support.triage"]);
  } finally {
    await ap.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a new release activates while the mirror is broken: the copy is untouched, the heartbeat's active digest moves but the seal member still names the old, broken release", async () => {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  const [ta, ra] = slots(plane, "A");
  const manifestA = plane.promote([ta!, ra!]);
  const ap = await start(plane, stateDir);
  const port = new InMemoryMirrorPort();
  try {
    const handle = ap.mirror(port);
    await handle.refresh();
    const triagePin = port.stored!.pins.find((p) => p.tag === "support.triage")!;
    port.stored!.texts[triagePin.contentHash] = Buffer.from("tampered").toString("base64url");
    ap.seal();

    const [tb, rb] = slots(plane, "B");
    const manifestB = plane.promote([tb!, rb!]);
    await ap.syncNow();
    assert.equal(ap.status().generation, manifestB.payload.generation, "the new release IS active");
    assert.equal(port.writes, 1, "the mirror copy was never overwritten while broken");

    await ap.heartbeatNow();
    const hb = plane.heartbeats.at(-1)!;
    assert.equal(hb.activeReleaseDigest, manifestB.payload.releaseDigest, "active digest is the NEW release");
    const sealMember = hb.seal as { sealId: string } | undefined;
    assert.equal(sealMember?.sealId, sealIdOf(manifestA.payload.releaseDigest), "the seal member still names the OLD release the broken copy was written for");
  } finally {
    await ap.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("resync({ approvedBy }) writes, heals and is logged with approvedBy; seal_intact fires once", async () => {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  const [t, r] = slots(plane, "A");
  plane.promote([t!, r!]);
  const events: Array<Record<string, unknown>> = [];
  const ap = await start(plane, stateDir, { logger: (e) => events.push(e) });
  const port = new InMemoryMirrorPort();
  try {
    const handle = ap.mirror(port);
    await handle.refresh();
    const triagePin = port.stored!.pins.find((p) => p.tag === "support.triage")!;
    port.stored!.texts[triagePin.contentHash] = Buffer.from("tampered").toString("base64url");
    await handle.refresh();
    assert.equal(ap.seal()?.intact, false);

    const report = await handle.resync({ approvedBy: "ops@acme" });
    assert.equal(report.intact, true);
    assert.equal(port.writes, 2, "resync wrote once more");
    assert.ok(events.some((e) => e.event === "mirror_resynced" && e.approvedBy === "ops@acme"));
    assert.equal(events.filter((e) => e.event === "seal_intact").length, 1, "seal_intact logged once on heal");
  } finally {
    await ap.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a port whose read() throws: render falls back to the store, resolutionSource is \"store\", mirror_unreadable is logged", async () => {
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  const [t, r] = slots(plane, "A");
  plane.promote([t!, r!]);
  const events: Array<Record<string, unknown>> = [];
  const ap = await start(plane, stateDir, { logger: (e) => events.push(e) });
  const port = new InMemoryMirrorPort();
  port.throwOnRead = true;
  try {
    const handle = ap.mirror(port);
    await handle.refresh();
    const rendered = ap.prompt("support.triage").render({ ticket: "t" });
    assert.equal(rendered.text, "Triage A t.");
    assert.equal(rendered.resolutionSource, "store");
    assert.ok(events.some((e) => e.event === "mirror_unreadable"));
    assert.equal(port.writes, 0, "never wrote — the port never became readable");
  } finally {
    await ap.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a request_resync directive notifies the mirror's onResyncRequested once — nothing is written", async () => {
  // Pinned, so the active (pinned) release never changes — isolating the directive's effect from the unrelated
  // "a new release activated, materialise it" rule a live promotion would otherwise also trigger.
  const stateDir = tempDir();
  const plane = new FakeControlPlane(scope);
  const [ta, ra] = slots(plane, "A");
  const manifestA = plane.promote([ta!, ra!]);
  const sealA = sealIdOf(manifestA.payload.releaseDigest);
  const ap = await start(plane, stateDir, { release: sealA });
  const port = new InMemoryMirrorPort();
  try {
    const handle = ap.mirror(port);
    await handle.refresh();
    const writesBefore = port.writes;

    const now = new Date().toISOString();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const [tb, rb] = slots(plane, "B");
    plane.promote([tb!, rb!], { directives: [{ kind: "request_resync", releaseDigest: manifestA.payload.releaseDigest, requestedBy: "ops@acme", requestedAt: now, expiresAt: later }] });
    await ap.syncNow();

    assert.equal(port.resyncRequests.length, 1, "onResyncRequested called once");
    assert.equal(port.resyncRequests[0]!.sealId, sealA);
    assert.equal(port.writes, writesBefore, "nothing written — the pinned content never changed and the directive is informational only");
    assert.equal(ap.prompt("support.triage").render({ ticket: "t" }).text, "Triage A t.", "the pinned content is untouched");

    // A second tick with the same directive still riding the manifest does not re-announce it.
    const [tc, rc] = slots(plane, "C");
    plane.promote([tc!, rc!], { directives: [{ kind: "request_resync", releaseDigest: manifestA.payload.releaseDigest, requestedBy: "ops@acme", requestedAt: now, expiresAt: later }] });
    await ap.syncNow();
    assert.equal(port.resyncRequests.length, 1, "deduped — the same (releaseDigest, requestedAt) pair riding a later manifest is not re-announced");
  } finally {
    await ap.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
