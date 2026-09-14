/**
 * S14: the in-process healthz. The rules over a status document (each one a vector), then a live host: 200 with the
 * document while serving, 503 once the lease lapsed under `halt`, `degraded` (still 200) under `degrade`; the handler
 * answers GET and HEAD and refuses other methods. Parity with `sdk-python/tests/test_healthz.py`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent, healthzOf, healthzResponse, type AgentStatus } from "../packages/sdk/src/agent.js";
import { publicJwkOf } from "../packages/core/src/protocol/trust.js";
import { FakeControlPlane } from "../packages/core/src/testing/index.js";

const scope = { organizationId: "org_1", agentId: "agt_health", target: "prod" as const };
const T0 = 1_789_300_800_000;

async function host(plane: FakeControlPlane, stateDir: string, clock: { ms: number }): Promise<AirPrompterAgent> {
  const ap = await AirPrompterAgent.start({ ...scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" }, fetch: plane.fetch(), now: () => clock.ms, random: () => 0.5, telemetry: { upload: false } });
  while (ap.status().heartbeat.lastAt === null) await new Promise((resolve) => setTimeout(resolve, 10));
  return ap;
}

test("healthzOf: every rule, in order — failing beats degraded, reasons name each rule that fired", async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-healthz-"));
  const plane = new FakeControlPlane(scope);
  const clock = { ms: T0 };
  plane.now = () => clock.ms;
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply {{name}}", variables: [{ name: "name", required: false, trust: "operator" }] })], { leaseSeconds: 3600 });
  const ap = await host(plane, work, clock);
  let base: AgentStatus;
  try {
    base = ap.status();
  } finally {
    await ap.stop();
    rmSync(work, { recursive: true, force: true });
  }
  const at = (patch: Partial<AgentStatus>, budget: number | null = 100 * 1024 * 1024) => healthzOf({ ...base, ...patch }, { spoolBudgetBytes: budget, nowMs: T0 });

  const ok = at({});
  assert.deepEqual({ ok: ok.ok, status: ok.status, reasons: ok.reasons, generation: ok.generation }, { ok: true, status: "ok", reasons: [], generation: 1 });
  assert.deepEqual(at({ generation: 0 }).reasons, ["no_verified_release"]);
  assert.equal(at({ generation: 0 }).ok, false);
  assert.deepEqual(at({ leaseExpired: true, onLeaseExpiry: "halt" }), { ...at({ leaseExpired: true, onLeaseExpiry: "halt" }), ok: false, status: "failing", reasons: ["lease_expired_halt"] });
  const degrade = at({ leaseExpired: true, onLeaseExpiry: "degrade" });
  assert.deepEqual({ ok: degrade.ok, status: degrade.status, reasons: degrade.reasons }, { ok: true, status: "degraded", reasons: ["lease_expired_degrade"] });
  assert.deepEqual(at({ consecutiveSyncFailures: 2 }).reasons, [], "two failures is a bad minute, not a rule");
  assert.deepEqual(at({ consecutiveSyncFailures: 3 }).reasons, ["sync_failing"]);
  assert.deepEqual(at({ upload: { ...(base.upload ?? ({} as NonNullable<AgentStatus["upload"]>)), backoffUntil: new Date(T0 + 60_000).toISOString(), lastUploadAt: null } as AgentStatus["upload"] }).reasons, ["upload_backing_off"]);
  assert.deepEqual(at({ upload: { ...(base.upload ?? ({} as NonNullable<AgentStatus["upload"]>)), backoffUntil: new Date(T0 - 1).toISOString(), lastUploadAt: null } as AgentStatus["upload"] }).reasons, [], "a backoff already over is not a reason");
  assert.deepEqual(at({ forcedDowngrade: true }).reasons, ["forced_downgrade"]);
  assert.deepEqual(at({ daemon: { attached: false, socketPath: "/x" } }).reasons, ["daemon_detached"]);
  assert.deepEqual(at({ daemon: { attached: true, socketPath: "/x" } }).reasons, []);
  assert.deepEqual(at({ spool: { depthSegments: 80, depthBytes: 80 * 1024 * 1024 } }).reasons, ["spool_near_budget"], "80 % of the budget");
  assert.deepEqual(at({ spool: { depthSegments: 79, depthBytes: 79 * 1024 * 1024 } }).reasons, []);
  assert.deepEqual(at({ spool: { depthSegments: 80, depthBytes: 80 * 1024 * 1024 } }, null).reasons, [], "no budget known (a memory sink): no rule");
  const both = at({ generation: 0, forcedDowngrade: true, consecutiveSyncFailures: 5 });
  assert.deepEqual({ ok: both.ok, status: both.status, reasons: both.reasons }, { ok: false, status: "failing", reasons: ["no_verified_release", "sync_failing", "forced_downgrade"] }, "failing wins; every reason is listed in rule order");
  assert.equal(healthzResponse(both).status, 503);
  assert.equal(healthzResponse(ok).status, 200);
  assert.deepEqual(JSON.parse(healthzResponse(ok).body).spool, { depthSegments: 0, depthBytes: 0, budgetBytes: 100 * 1024 * 1024 });
  assert.equal(healthzResponse(ok).headers["cache-control"], "no-store");
});

test("a live host: 200 while serving; 503 once the lease lapsed under halt; the handler answers GET and HEAD, refuses POST", async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-healthz-live-"));
  const plane = new FakeControlPlane(scope);
  const clock = { ms: T0 };
  plane.now = () => clock.ms;
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply {{name}}", variables: [{ name: "name", required: false, trust: "operator" }] })], { leaseSeconds: 60, onLeaseExpiry: "halt" });
  const ap = await host(plane, work, clock);
  try {
    const answer = (method: string) => {
      const out: { status?: number; headers?: Record<string, string>; body?: string | undefined } = {};
      ap.healthzHandler()({ method }, { writeHead: (status, headers) => Object.assign(out, { status, headers }), end: (body?: string) => (out.body = body) });
      return out;
    };
    let got = answer("GET");
    assert.equal(got.status, 200);
    const doc = JSON.parse(got.body!) as { ok: boolean; status: string; generation: number; spool: { budgetBytes: number } };
    assert.deepEqual({ ok: doc.ok, status: doc.status, generation: doc.generation, budget: doc.spool.budgetBytes }, { ok: true, status: "ok", generation: 1, budget: 100 * 1024 * 1024 });
    assert.equal(answer("HEAD").body, undefined);
    assert.equal(answer("HEAD").status, 200);
    assert.equal(answer("POST").status, 405);
    // The lease lapses with no contact: under halt every render refuses, so the probe says so.
    clock.ms = T0 + 61_000;
    got = answer("GET");
    assert.equal(got.status, 503);
    assert.deepEqual(JSON.parse(got.body!).reasons, ["lease_expired_halt"]);
    assert.equal(ap.healthz().ok, false);
  } finally {
    await ap.stop();
    rmSync(work, { recursive: true, force: true });
  }
});
