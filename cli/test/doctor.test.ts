/**
 * S14: `airprompter doctor` against the fake control plane. A host a runtime just synced is healthy (one warning: the
 * file key); no store fails with the remedy; a wrong key fails the source with a 401 and names the variable; no key
 * skips the source; a spool at its budget and a quarantined segment warn; a stale daemon socket fails; a missing root
 * file fails while a pinned JWK passes. Reads only: doctor never creates a store. Exit codes are the contract.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent } from "../../sdk-typescript/packages/sdk/src/agent.js";
import { publicJwkOf } from "../../sdk-typescript/packages/core/src/protocol/trust.js";
import { SlotStore } from "../../sdk-typescript/packages/sync/src/store/slotStore.js";
import { daemonSocketPath } from "../../sdk-typescript/packages/sync/src/sync/daemon.js";
import { FakeControlPlane } from "../../sdk-typescript/test/helpers/controlPlane.js";
import { run } from "../src/cli.js";
import { EXIT, type Context } from "../src/io.js";

const scope = { organizationId: "org_1", agentId: "agt_doctor", target: "prod" as const };
const scopeArgs = ["--org", scope.organizationId, "--agent", scope.agentId, "--environment", scope.target];

interface Check {
  name: string;
  level: "ok" | "warn" | "fail" | "skip";
  detail: string;
  remedy?: string;
}

function harness(plane: FakeControlPlane, work: string, env: Record<string, string> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx: Context = { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l), env: { HOME: work, AIRPROMPTER_AGENT_KEY: plane.apiKey, ...env }, cwd: work, now: () => Date.now(), fetch: plane.fetch(), isTTY: false };
  return { ctx, stdout, stderr, doc: () => JSON.parse(stdout[stdout.length - 1]!) as { ok: boolean; checks: Check[] }, reset: () => void (stdout.length = 0) };
}

const level = (checks: Check[], name: string) => checks.find((c) => c.name === name)?.level;

test("doctor: a synced host is healthy; no store, a wrong key, a full spool, a stale socket and a missing root each say what and how to fix it", async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-doctor-"));
  const plane = new FakeControlPlane(scope);
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply {{name}}", variables: [{ name: "name", required: false, trust: "operator" }] })]);
  const stateDir = join(work, "state");
  const rootPath = join(work, "root.jwk.json");
  writeFileSync(rootPath, JSON.stringify(publicJwkOf(plane.rootKey)));
  try {
    // Nothing on the host yet: the store check fails with the remedy, and doctor did not create one.
    let h = harness(plane, work);
    assert.equal(await run(["doctor", ...scopeArgs, "--state-dir", stateDir, "--root", rootPath, "--base-url", "https://api.test", "--json"], h.ctx), EXIT.refused);
    let doc = h.doc();
    assert.equal(doc.ok, false);
    assert.deepEqual({ source: level(doc.checks, "source"), root: level(doc.checks, "root"), store: level(doc.checks, "store"), daemon: level(doc.checks, "daemon") }, { source: "ok", root: "ok", store: "fail", daemon: "skip" });
    assert.match(doc.checks.find((c) => c.name === "store")!.remedy!, /airprompter pull/);
    assert.equal(existsSync(join(SlotStore.path({ stateDir, ...scope }), "store.json")), false, "doctor never creates a store");

    // A runtime syncs once: the host is healthy, with the one warning every file-key host gets.
    const ap = await AirPrompterAgent.start({ ...scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "on_invoke", rootUrl: "https://edge.test/roots/prod/root.json" }, fetch: plane.fetch(), telemetry: { upload: false, sink: "memory" } });
    await ap.stop();
    h = harness(plane, work);
    assert.equal(await run(["doctor", ...scopeArgs, "--state-dir", stateDir, "--root", rootPath, "--base-url", "https://api.test", "--json"], h.ctx), EXIT.ok);
    doc = h.doc();
    assert.equal(doc.ok, true);
    assert.deepEqual(
      Object.fromEntries(doc.checks.map((c) => [c.name, c.level])),
      { source: "ok", root: "ok", store: "ok", active_release: "ok", lease: "ok", key_protection: "warn", policy_pin: "ok", spool: "ok", daemon: "skip" },
    );
    assert.match(doc.checks.find((c) => c.name === "key_protection")!.remedy!, /OS keystore, KMS or Vault/);
    h.reset();
    assert.equal(await run(["doctor", ...scopeArgs, "--state-dir", stateDir, "--base-url", "https://api.test"], h.ctx), EXIT.ok);
    assert.match(h.stdout.join("\n"), /^ok {3}source: https:\/\/api\.test answers: generation 1/m);
    assert.match(h.stdout.join("\n"), /^warn key_protection: file_key/m);
    assert.match(h.stdout.join("\n"), /^skip root: --root not given/m);
    assert.match(h.stdout.join("\n"), /doctor: serving, 1 warning$/m);
    assert.doesNotMatch(h.stdout.join("\n"), /Reply \{\{name\}\}/, "no prompt text");

    // The wrong key: the source fails with a 401 and names the variable; the host itself is still fine.
    h = harness(plane, work, { AIRPROMPTER_AGENT_KEY: "apa_wrong" });
    assert.equal(await run(["doctor", ...scopeArgs, "--state-dir", stateDir, "--base-url", "https://api.test", "--json"], h.ctx), EXIT.refused);
    doc = h.doc();
    assert.equal(level(doc.checks, "source"), "fail");
    assert.match(doc.checks.find((c) => c.name === "source")!.detail, /401/);
    assert.match(doc.checks.find((c) => c.name === "source")!.remedy!, /AIRPROMPTER_AGENT_KEY/);
    assert.equal(level(doc.checks, "store"), "ok");
    // No key at all: the source is skipped, not failed (an offline host).
    h = harness(plane, work, { AIRPROMPTER_AGENT_KEY: "" });
    assert.equal(await run(["doctor", ...scopeArgs, "--state-dir", stateDir, "--json"], h.ctx), EXIT.ok);
    assert.equal(level(h.doc().checks, "source"), "skip");
    // A key for another agent: forbidden, with the mismatch named.
    h = harness(plane, work);
    assert.equal(await run(["doctor", "--org", scope.organizationId, "--agent", "agt_other", "--environment", scope.target, "--state-dir", join(work, "other"), "--base-url", "https://api.test", "--json"], h.ctx), EXIT.refused);
    assert.match(h.doc().checks.find((c) => c.name === "source")!.remedy!, /another agent/);

    // The spool at its budget and a quarantined segment: warnings with the next command to run.
    const spoolDir = join(SlotStore.path({ stateDir, ...scope }), "spool", "telemetry");
    mkdirSync(join(spoolDir, "quarantine"), { recursive: true });
    writeFileSync(join(spoolDir, "seg-i-writer-a-29821660-0.ndjson"), "x".repeat(900));
    writeFileSync(join(spoolDir, "quarantine", "seg-i-writer-b-29821660-0.ndjson"), "{}\n");
    h = harness(plane, work);
    assert.equal(await run(["doctor", ...scopeArgs, "--state-dir", stateDir, "--base-url", "https://api.test", "--spool-budget-bytes", "1000", "--json"], h.ctx), EXIT.ok, "warnings are not fatal");
    doc = h.doc();
    assert.equal(level(doc.checks, "spool"), "warn");
    assert.match(doc.checks.find((c) => c.name === "spool")!.detail, /90 % of the 1000-byte budget\), 0 open: near the budget/);
    assert.equal(level(doc.checks, "quarantine"), "warn");
    assert.match(doc.checks.find((c) => c.name === "quarantine")!.remedy!, /telemetry validate/);

    // A stale daemon socket (a file where the socket should be): the daemon check fails and says to restart it.
    const socketPath = daemonSocketPath({ stateDir, ...scope });
    mkdirSync(join(socketPath, ".."), { recursive: true });
    writeFileSync(socketPath, "");
    h = harness(plane, work);
    assert.equal(await run(["doctor", ...scopeArgs, "--state-dir", stateDir, "--base-url", "https://api.test", "--json"], h.ctx), EXIT.refused);
    doc = h.doc();
    assert.equal(level(doc.checks, "daemon"), "fail");
    assert.match(doc.checks.find((c) => c.name === "daemon")!.remedy!, /restart airprompterd/);
    rmSync(socketPath);

    // A root file that is not there.
    h = harness(plane, work);
    assert.equal(await run(["doctor", ...scopeArgs, "--state-dir", stateDir, "--root", join(work, "nope.json"), "--base-url", "https://api.test", "--json"], h.ctx), EXIT.refused);
    assert.equal(level(h.doc().checks, "root"), "fail");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
