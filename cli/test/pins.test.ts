/**
 * The five 0.3.5 verbs (`protocol/pins.md`): `pin` / `unpin` write and clear the sidecar with the CLI's own
 * `by: "cli"`, the same file the SDK reads only at start; `mirror status` reports the pin file and this host's
 * active seal, read-only; `mirror resync` always refuses — it exists to say why, never to write; `seal verify`
 * recomputes a `MirrorCopy`'s seal against the active release offline, with the exit-code contract (0 intact, 1
 * broken, 2 a bad file or no active release).
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent } from "../../sdk-typescript/packages/sdk/src/agent.js";
import { sealIdOf } from "../../sdk-typescript/packages/core/src/protocol/seal.js";
import { publicJwkOf } from "../../sdk-typescript/packages/core/src/protocol/trust.js";
import { readPinFile } from "../../sdk-typescript/packages/sync/src/sync/pin.js";
import { nodeFs } from "../../sdk-typescript/packages/core/src/ports/node.js";
import { FakeControlPlane } from "../../sdk-typescript/test/helpers/controlPlane.js";
import { run } from "../src/cli.js";
import { EXIT, type Context } from "../src/io.js";

const scope = { organizationId: "org_1", agentId: "agt_pins", target: "prod" as const };
const scopeArgs = ["--org", scope.organizationId, "--agent", scope.agentId, "--environment", scope.target];

function harness(plane: FakeControlPlane, work: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx: Context = { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l), env: { HOME: work, AIRPROMPTER_AGENT_KEY: plane.apiKey }, cwd: work, now: () => Date.now(), fetch: plane.fetch(), isTTY: false };
  return {
    ctx,
    stdout,
    stderr,
    json: () => JSON.parse(stdout[stdout.length - 1]!) as Record<string, unknown>,
    all: () => [...stdout, ...stderr].join("\n"),
    reset: () => {
      stdout.length = 0;
      stderr.length = 0;
    },
  };
}

/** A synced host: one triage slot promoted and applied through a real `AirPrompterAgent.start()` pass, then stopped — leaving the store on disk for the CLI to open. */
async function syncedHost(plane: FakeControlPlane, stateDir: string, rootKey = plane.rootKey) {
  const ap = await AirPrompterAgent.start({
    ...scope,
    apiKey: plane.apiKey,
    baseUrl: "https://api.test",
    stateDir,
    root: { pinned: publicJwkOf(rootKey) },
    sync: { mode: "on_invoke", rootUrl: "https://edge.test/roots/prod/root.json" },
    fetch: plane.fetch(),
    telemetry: { upload: false, sink: "memory" },
  });
  await ap.stop();
}

test("pin writes pin.json with by:\"cli\" and the restart note; unpin removes it and reports what it removed", async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-pins-"));
  const stateDir = join(work, "state");
  try {
    const plane = new FakeControlPlane(scope);
    plane.promote([plane.slot({ tag: "support.reply", text: "Reply {{name}}", variables: [{ name: "name", required: false, trust: "operator" }] })]);
    let h = harness(plane, work);

    assert.equal(await run(["pin", "a3a20ff4f7fb", ...scopeArgs, "--state-dir", stateDir, "--json"], h.ctx), EXIT.ok);
    const pinned = h.json();
    assert.equal(pinned.release, "a3a20ff4f7fb");
    const pinPath = join(stateDir, "airprompter", scope.agentId, scope.target, "pin.json");
    assert.equal(pinned.path, pinPath);
    assert.equal(existsSync(pinPath), true);
    const onDisk = JSON.parse(readFileSync(pinPath, "utf8")) as { version: number; release: string; pinnedAt: string; by: string };
    assert.deepEqual(onDisk, { version: 1, release: "a3a20ff4f7fb", pinnedAt: pinned.pinnedAt, by: "cli" });
    h.reset();

    assert.equal(await run(["pin", "a3a20ff4f7fb", ...scopeArgs, "--state-dir", stateDir], h.ctx), EXIT.ok);
    assert.match(h.all(), /A running SDK reads pin\.json only at start — restart it to take the pin\./);
    h.reset();

    assert.equal(await run(["unpin", ...scopeArgs, "--state-dir", stateDir, "--json"], h.ctx), EXIT.ok);
    const unpinned = h.json();
    assert.equal(unpinned.removed, true);
    assert.equal(unpinned.release, "a3a20ff4f7fb");
    assert.equal(existsSync(pinPath), false);
    assert.equal(readPinFile(nodeFs, stateDir, scope.agentId, scope.target), null);
    h.reset();

    // A second unpin has nothing to remove.
    assert.equal(await run(["unpin", ...scopeArgs, "--state-dir", stateDir, "--json"], h.ctx), EXIT.ok);
    assert.equal(h.json().removed, false);
    assert.equal(h.json().release, null);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("pin refuses a seal that does not match the grammar (fewer than 12 hex characters) with exit 2", async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-pins-"));
  const stateDir = join(work, "state");
  try {
    const plane = new FakeControlPlane(scope);
    const h = harness(plane, work);
    assert.equal(await run(["pin", "abc123", ...scopeArgs, "--state-dir", stateDir, "--json"], h.ctx), EXIT.usage);
    assert.equal(h.json().reason, "seal_invalid");
    assert.equal(existsSync(join(stateDir, "airprompter", scope.agentId, scope.target, "pin.json")), false, "a refused pin never writes the file");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("mirror status prints the pin file and the active seal id of a synced store", async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-pins-"));
  const stateDir = join(work, "state");
  try {
    const plane = new FakeControlPlane(scope);
    const manifest = plane.promote([plane.slot({ tag: "support.reply", text: "Reply {{name}}", variables: [{ name: "name", required: false, trust: "operator" }] })]);
    await syncedHost(plane, stateDir);
    const expectedSealId = sealIdOf(manifest.payload.releaseDigest);
    const h = harness(plane, work);

    // Not pinned yet.
    assert.equal(await run(["mirror", "status", ...scopeArgs, "--state-dir", stateDir, "--json"], h.ctx), EXIT.ok);
    let doc = h.json();
    assert.equal(doc.pin, null);
    assert.equal(doc.activeSealId, expectedSealId);
    assert.equal(doc.activeReleaseDigest, manifest.payload.releaseDigest);
    h.reset();

    assert.equal(await run(["mirror", "status", ...scopeArgs, "--state-dir", stateDir], h.ctx), EXIT.ok);
    assert.match(h.all(), /not pinned/);
    assert.match(h.all(), new RegExp(`active seal: ${expectedSealId}`));
    assert.match(h.all(), /The runtime reports drift on its heartbeat; see the Fleet tab\./);
    h.reset();

    // Pinned: the pin file shows up too.
    assert.equal(await run(["pin", expectedSealId, ...scopeArgs, "--state-dir", stateDir, "--json"], h.ctx), EXIT.ok);
    h.reset();
    assert.equal(await run(["mirror", "status", ...scopeArgs, "--state-dir", stateDir, "--json"], h.ctx), EXIT.ok);
    doc = h.json();
    assert.equal((doc.pin as { release: string }).release, expectedSealId);
    assert.equal((doc.pin as { by: string }).by, "cli");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("mirror resync always refuses: --approve is required, and even given it never rewrites the store", async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-pins-"));
  const stateDir = join(work, "state");
  try {
    const plane = new FakeControlPlane(scope);
    const h = harness(plane, work);

    assert.equal(await run(["mirror", "resync", ...scopeArgs, "--state-dir", stateDir, "--json"], h.ctx), EXIT.usage);
    assert.match(h.all(), /--approve <who> is required/);
    h.reset();

    assert.equal(await run(["mirror", "resync", "--approve", "ops@acme.example", ...scopeArgs, "--state-dir", stateDir, "--json"], h.ctx), EXIT.usage);
    assert.match(h.all(), /Re-sync runs inside the application that owns the store: call ap\.mirror\(port\)\.resync\(\{ approvedBy \}\) — the CLI never rewrites a customer store\./);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("seal verify: an intact copy exits 0; a tampered one exits 1 and names the tag; --json carries the verdict", async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-pins-"));
  const stateDir = join(work, "state");
  try {
    const plane = new FakeControlPlane(scope);
    const triage = plane.slot({ tag: "support.triage", text: "Triage {{ticket}}.", variables: [{ name: "ticket", required: true, trust: "operator" }] });
    const manifest = plane.promote([triage]);
    await syncedHost(plane, stateDir);
    const sealId = sealIdOf(manifest.payload.releaseDigest);

    const texts: Record<string, string> = {};
    for (const [contentHash, bytes] of plane.payloads) texts[contentHash] = bytes.toString("base64url");
    const goodCopy = { sealId, pins: manifest.payload.slots, texts };
    const copyPath = join(work, "mirror-copy.json");
    writeFileSync(copyPath, JSON.stringify(goodCopy));

    let h = harness(plane, work);
    assert.equal(await run(["seal", "verify", "--copy", copyPath, ...scopeArgs, "--state-dir", stateDir, "--json"], h.ctx), EXIT.ok);
    let doc = h.json();
    assert.equal(doc.intact, true);
    assert.equal(doc.sealId, sealId);
    assert.deepEqual(doc.changedTags, []);
    h.reset();

    assert.equal(await run(["seal", "verify", "--copy", copyPath, ...scopeArgs, "--state-dir", stateDir], h.ctx), EXIT.ok);
    assert.match(h.all(), new RegExp(`intact: the copy matches seal ${sealId}`));
    h.reset();

    // Tamper the triage slot's text: the rehash no longer matches its contentHash, so the tag is named and nothing about the text leaks.
    const tamperedTexts = { ...texts };
    const tamperedHash = triage.contentHash;
    tamperedTexts[tamperedHash] = Buffer.from("something else entirely").toString("base64url");
    const brokenCopy = { sealId, pins: manifest.payload.slots, texts: tamperedTexts };
    const brokenPath = join(work, "mirror-copy-broken.json");
    writeFileSync(brokenPath, JSON.stringify(brokenCopy));

    h = harness(plane, work);
    assert.equal(await run(["seal", "verify", "--copy", brokenPath, ...scopeArgs, "--state-dir", stateDir, "--json"], h.ctx), EXIT.refused);
    doc = h.json();
    assert.equal(doc.intact, false);
    assert.deepEqual(doc.changedTags, ["support.triage"]);
    assert.equal(h.all().includes("Triage"), false, "nothing printed is prompt text");
    h.reset();

    assert.equal(await run(["seal", "verify", "--copy", brokenPath, ...scopeArgs, "--state-dir", stateDir], h.ctx), EXIT.refused);
    assert.match(h.all(), /broken: 1 tag changed \(support\.triage\)/);
    h.reset();

    // A bad file: exit 2, not 1.
    const badPath = join(work, "not-json.json");
    writeFileSync(badPath, "not json");
    assert.equal(await run(["seal", "verify", "--copy", badPath, ...scopeArgs, "--state-dir", stateDir], h.ctx), EXIT.usage);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
