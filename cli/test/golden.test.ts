/**
 * T34 (AIR-1964): `verify --golden` and `apply --golden` run a release's
 * golden sets on this host, offline from a bundle, with the operator's own
 * model call — answers a harness already produced (`--outputs`) or a program
 * run once per case (`--run`). Below the floor `verify` refuses and `apply`
 * stages without activating; nothing printed is an output.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalBytes, sha256Prefixed } from "../../sdk-typescript/src/protocol/canonicalJson.js";
import { publicJwkOf } from "../../sdk-typescript/src/protocol/trust.js";
import type { ManifestSlot } from "../../sdk-typescript/src/protocol/types.js";
import { FakeControlPlane } from "../../sdk-typescript/test/helpers/controlPlane.js";
import { run } from "../src/cli.js";
import { EXIT, type Context } from "../src/io.js";

const scope = { organizationId: "org_1", agentId: "agt_1", target: "prod" as const };
const scopeArgs = ["--org", scope.organizationId, "--agent", scope.agentId, "--environment", scope.target];

const SET = {
  format: "airprompter-golden-set" as const,
  version: 1 as const,
  setId: "gs_cli",
  minPassBps: 10000,
  cases: [
    { caseId: "billing", variables: { ticket: "I was charged twice" }, expect: [{ kind: "enum" as const, name: "category", path: "category", values: ["billing", "shipping", "other"] }] },
    { caseId: "shipping", variables: { ticket: "Order 1234 has not arrived" }, expect: [{ kind: "must_match" as const, name: "mentions-order", pattern: "1234" }] },
  ],
};

function harness(plane: FakeControlPlane, work: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx: Context = { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l), env: { HOME: work, AIRPROMPTER_AGENT_KEY: plane.apiKey }, cwd: work, now: () => Date.now(), fetch: plane.fetch(), isTTY: false };
  return { ctx, stdout, stderr, json: () => JSON.parse(stdout[stdout.length - 1]!) as Record<string, unknown>, all: () => [...stdout, ...stderr].join("\n"), reset: () => void ((stdout.length = 0), (stderr.length = 0)) };
}

test("verify --golden and apply --golden run the cases offline from the bundle; below the floor verify refuses and apply stages without activating", async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-cli-golden-"));
  const plane = new FakeControlPlane(scope);
  const rootPath = join(work, "root.jwk.json");
  writeFileSync(rootPath, JSON.stringify(publicJwkOf(plane.rootKey)));
  const rootDocPath = join(work, "root.json");
  writeFileSync(rootDocPath, JSON.stringify(plane.root));
  const stateDir = join(work, "state");
  const plain = plane.slot({ tag: "support.triage", text: "Triage as JSON: {{ticket}}", variables: [{ name: "ticket", required: true, trust: "end_user" }] });
  const bytes = canonicalBytes(SET);
  plane.payloads.set(sha256Prefixed(bytes), Buffer.from(bytes));
  const slot: ManifestSlot = { ...plain, goldenSet: { setId: SET.setId, cases: 2, contentHash: sha256Prefixed(bytes), byteLength: bytes.length, minPassBps: 10000 } };
  plane.promote([slot]);
  const h = harness(plane, work);
  mkdirSync(join(work, "keys"), { recursive: true });
  assert.equal(await run(["keygen", "--purpose", "distribution", "--out", join(work, "keys", "prod")], h.ctx), EXIT.ok);
  const keys = ["--distribution-key", join(work, "keys", "prod.pub.json")];
  const priv = ["--distribution-key", join(work, "keys", "prod.key.json")];
  const bundle = join(work, "release.apbundle");
  h.reset();
  assert.equal(await run(["pull", ...scopeArgs, "--root", rootDocPath, ...keys, "--out", bundle, "--json"], h.ctx), EXIT.ok, h.all());
  assert.equal(h.json().payloads, 2, "the golden set travels in the bundle as a payload");

  // --outputs: answers a harness produced. One wrong → refused, the case named, the answer never printed.
  const bad = join(work, "bad.json");
  writeFileSync(bad, JSON.stringify({ "support.triage/billing": '{"category":"billing"}', "support.triage/shipping": "Sorry, SECRET-ANSWER, no order found" }));
  h.reset();
  assert.equal(await run(["verify", bundle, ...scopeArgs, "--root", rootDocPath, ...priv, "--golden", "--outputs", bad, "--json"], h.ctx), EXIT.refused);
  const refusedGolden = h.json().golden as { met: boolean; reports: Array<{ passed: number; cases: number; results: Array<{ caseId: string; ok: boolean; failed: string[] }> }> };
  assert.equal(refusedGolden.met, false);
  assert.deepEqual(refusedGolden.reports[0]!.results, [{ caseId: "billing", ok: true, failed: [] }, { caseId: "shipping", ok: false, failed: ["mentions-order"] }]);
  assert.equal(h.json().ok, false);
  assert.equal(h.all().includes("SECRET-ANSWER"), false, "no output is ever printed");
  assert.ok(h.stderr.some((l) => l.includes("refused at golden")));
  // Both right → ok; the human line names the counts.
  const good = join(work, "good.json");
  writeFileSync(good, JSON.stringify({ "support.triage": { billing: '{"category":"billing"}', shipping: "Order 1234 is on its way" } }));
  h.reset();
  assert.equal(await run(["verify", bundle, ...scopeArgs, "--root", rootDocPath, ...priv, "--golden", "--outputs", good], h.ctx), EXIT.ok, h.all());
  assert.ok(h.stdout.some((l) => l === "golden support.triage: 2/2 passed, floor 100% → met"), h.all());
  // A missing answer is a failed case, not a crash; --golden without a source is a usage error.
  writeFileSync(join(work, "partial.json"), JSON.stringify({ "support.triage/billing": '{"category":"billing"}' }));
  h.reset();
  assert.equal(await run(["verify", bundle, ...scopeArgs, "--root", rootDocPath, ...priv, "--golden", "--outputs", join(work, "partial.json"), "--json"], h.ctx), EXIT.refused);
  assert.deepEqual((h.json().golden as { reports: Array<{ results: unknown[] }> }).reports[0]!.results[1], { caseId: "shipping", ok: false, failed: [], error: "Error" });
  h.reset();
  assert.equal(await run(["verify", bundle, ...scopeArgs, "--root", rootDocPath, ...priv, "--golden"], h.ctx), EXIT.usage);

  // --run: a program per case — the case arrives as JSON on stdin, the answer on stdout. Here it answers from the rendered text.
  const script = join(work, "model.mjs");
  writeFileSync(script, ["let raw = '';", "process.stdin.on('data', (c) => (raw += c));", "process.stdin.on('end', () => {", "  const c = JSON.parse(raw);", "  if (!c.text.startsWith('Triage as JSON: <ticket>')) { console.error('unexpected render'); process.exit(3); }", "  process.stdout.write(c.caseId === 'billing' ? JSON.stringify({ category: 'billing' }) : process.env.GOLDEN_PASS === '1' ? 'Order 1234 is on its way' : 'no idea');", "});"].join("\n"));
  const runCmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
  // Failing → staged, not activated, exit 1; the store holds the release for a deliberate unlock.
  h.reset();
  assert.equal(await run(["apply", bundle, ...scopeArgs, "--root", rootPath, ...priv, "--state-dir", stateDir, "--golden", "--run", runCmd, "--json"], h.ctx), EXIT.refused, h.all());
  assert.deepEqual({ outcome: h.json().outcome, goldenMet: h.json().goldenMet }, { outcome: "staged", goldenMet: false });
  h.reset();
  assert.equal(await run(["status", ...scopeArgs, "--state-dir", stateDir, "--json"], h.ctx), EXIT.ok);
  assert.deepEqual({ generation: h.json().generation, activeSlot: h.json().activeSlot, staged: (h.json().staged as { verified: boolean } | undefined)?.verified }, { generation: 0, activeSlot: null, staged: true }, "staged, verifiable, not active");
  // Passing → activated.
  process.env.GOLDEN_PASS = "1";
  try {
    h.reset();
    assert.equal(await run(["apply", bundle, ...scopeArgs, "--root", rootPath, ...priv, "--state-dir", stateDir, "--golden", "--run", runCmd, "--concurrency", "1", "--json"], h.ctx), EXIT.ok, h.all());
    assert.deepEqual({ outcome: h.json().outcome, goldenMet: h.json().goldenMet }, { outcome: "activated", goldenMet: true });
    // verify on the state directory runs the active release's set too.
    h.reset();
    assert.equal(await run(["verify", stateDir, ...scopeArgs, "--root", rootPath, "--golden", "--run", runCmd, "--json"], h.ctx), EXIT.ok, h.all());
    assert.equal((h.json().golden as { met: boolean }).met, true);
  } finally {
    delete process.env.GOLDEN_PASS;
  }
  assert.equal(readFileSync(bundle, "utf8").includes("charged twice"), false, "the cases are ciphertext in the bundle");
  rmSync(work, { recursive: true, force: true });
});
