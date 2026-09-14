/**
 * S14: the verify GitHub Action (`action/verify`), run as GitHub runs it — `node run.mjs` with INPUT_* in the
 * environment — against bundles the fake control plane sealed. Two good bundles verify (outputs, a summary table, exit
 * 0); a tampered one is refused with its step and reason while the good one still verifies (every bundle is tried);
 * a glob that matches nothing is an error, not a pass; a missing root is an error; the distribution key reaches the
 * CLI as a path. The download path (release asset + checksum + Sigstore) is exercised by `commandFor`/`expandBundles`
 * unit checks here and by the release itself; `binary:` is what this repository's CI uses.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createEncryptedBundle, createPlaintextBundle } from "../../sdk-typescript/packages/core/src/bundle/apbundle.js";
import { publicJwkOf } from "../../sdk-typescript/packages/core/src/protocol/trust.js";
import { FakeControlPlane } from "../../sdk-typescript/test/helpers/controlPlane.js";
// @ts-expect-error the action is plain JavaScript (Node's standard library only); its exports are checked by these tests
import { commandFor, expandBundles } from "../../action/verify/run.mjs";
import { generateDistributionKeyFiles } from "../src/keys.js";

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runMjs = join(cliRoot, "..", "action", "verify", "run.mjs");
const scope = { organizationId: "org_1", agentId: "agt_action", target: "prod" as const };

/** The CLI as the action runs it: the built bundle (what CI hands the action as `binary:`), built here when absent. */
function builtCli(): string {
  const bundled = join(cliRoot, "dist", "airprompter.cjs");
  const build = spawnSync(process.execPath, [join(cliRoot, "scripts", "bundle.mjs")], { cwd: cliRoot, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  return bundled;
}

function runAction(work: string, inputs: Record<string, string>) {
  const output = join(work, "github-output");
  const summary = join(work, "github-summary");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const env: Record<string, string> = { ...(process.env as Record<string, string>), GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: work, INPUT_BINARY: builtCli(), INPUT_ORG: scope.organizationId, INPUT_AGENT: scope.agentId, INPUT_ENVIRONMENT: scope.target };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase().replace(/-/g, "_")}`] = v;
  const result = spawnSync(process.execPath, [runMjs], { cwd: work, env, encoding: "utf8" });
  const outputs = Object.fromEntries(readFileSync(output, "utf8").split("\n").filter(Boolean).map((line) => line.split(/=(.*)/s).slice(0, 2) as [string, string]));
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, outputs, summary: readFileSync(summary, "utf8") };
}

test("the verify action: good bundles verify with outputs and a summary; a tampered one is refused by step and reason; a bad glob and a missing root are errors", { timeout: 120_000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-action-"));
  try {
    const plane = new FakeControlPlane(scope);
    plane.promote([plane.slot({ tag: "support.reply", text: "Reply warmly {{name}}", variables: [{ name: "name", required: false, trust: "operator" }] })]);
    const payloads = [...plane.payloads].map(([contentHash, bytes]) => ({ contentHash: contentHash as `sha256:${string}`, byteLength: bytes.length, bytes: bytes.toString("base64url") }));
    const bundle = createPlaintextBundle({ createdAt: new Date().toISOString(), notAfter: "2027-01-01T00:00:00Z", manifest: plane.manifest!, keySet: plane.root, payloads });
    mkdirSync(join(work, "bundles"));
    writeFileSync(join(work, "bundles", "prod.apbundle"), JSON.stringify(bundle));
    writeFileSync(join(work, "bundles", "prod-copy.apbundle"), JSON.stringify(bundle));
    const rootPath = join(work, "root.jwk.json");
    writeFileSync(rootPath, JSON.stringify(publicJwkOf(plane.rootKey)));

    let r = runAction(work, { bundle: "bundles/*.apbundle", root: "root.jwk.json" });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.outputs.ok, "true");
    assert.equal(r.outputs.generation, "1");
    assert.match(r.outputs["release-digest"]!, /^sha256:[0-9a-f]{64}$/);
    assert.match(r.summary, /2 of 2 bundles verified — binary supplied by the job/);
    assert.match(r.summary, /\| `prod\.apbundle` \| ✅ verified \| 1 \|/);
    assert.match(r.summary, /\| `prod-copy\.apbundle` \| ✅ verified \| 1 \|/);
    assert.doesNotMatch(r.stdout + r.summary, /Reply warmly/, "nothing printed is prompt text");
    const report = JSON.parse(readFileSync(r.outputs.report!, "utf8")) as { ok: boolean; bundles: Array<{ report: { ok: boolean } }> };
    assert.equal(report.ok, true);
    assert.equal(report.bundles.length, 2);

    // A tampered bundle next to a good one: the run fails, names the step and reason, and the good one still verified.
    const contents = (bundle.encryption as { scheme: "none"; contents: { manifest: { payload: { generation: number } } } }).contents;
    const tampered = { ...bundle, encryption: { scheme: "none", contents: { ...contents, manifest: { ...contents.manifest, payload: { ...contents.manifest.payload, generation: 99 } } } } };
    writeFileSync(join(work, "bundles", "prod-copy.apbundle"), JSON.stringify(tampered));
    r = runAction(work, { bundle: "bundles/*.apbundle", root: "root.jwk.json" });
    assert.equal(r.code, 1);
    assert.equal(r.outputs.ok, "false");
    assert.match(r.summary, /1 of 2 bundles verified/);
    assert.match(r.summary, /\| `prod-copy\.apbundle` \| ❌ refused at manifest \(/);
    assert.match(r.summary, /\| `prod\.apbundle` \| ✅ verified/);
    assert.match(r.stdout, /::error file=.*prod-copy\.apbundle::airprompter verify refused prod-copy\.apbundle at manifest/);

    // An encrypted bundle: the key reaches the CLI as a file path.
    const keys = generateDistributionKeyFiles(join(work, "prod"), new Date().toISOString());
    const keyPath = keys.privatePath;
    const publicRaw = Buffer.from((JSON.parse(readFileSync(keys.publicPath, "utf8")) as { publicKey: string }).publicKey, "base64url");
    const sealed = createEncryptedBundle({ createdAt: new Date().toISOString(), notAfter: "2027-01-01T00:00:00Z", manifest: plane.manifest!, keySet: plane.root, payloads }, publicRaw);
    writeFileSync(join(work, "bundles", "sealed.apbundle"), JSON.stringify(sealed));
    r = runAction(work, { bundle: "bundles/sealed.apbundle", root: "root.jwk.json", "distribution-key": keyPath });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.summary, /\| `sealed\.apbundle` \| ✅ verified/);
    r = runAction(work, { bundle: "bundles/sealed.apbundle", root: "root.jwk.json" });
    assert.equal(r.code, 1, "sealed with no key: refused, not skipped");

    // A glob that matches nothing is an error (exit 2), never a green run; so is a missing root.
    r = runAction(work, { bundle: "bundles/*.nothing", root: "root.jwk.json" });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /::error::bundle: nothing matches bundles\/\*\.nothing/);
    r = runAction(work, { bundle: "bundles/prod.apbundle", root: "missing.json" });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /::error::root: .*missing\.json does not exist/);
    // No binary and no usable version: says how to fix it before touching the network.
    const noBinary = runAction(work, { bundle: "bundles/prod.apbundle", root: "root.jwk.json", binary: "" });
    assert.equal(noBinary.code, 2);
    assert.match(noBinary.stdout, /cli\/vX\.Y\.Z release tag is needed/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("action helpers: commandFor picks node for bundles and tsx for sources; expandBundles takes one path per line and refuses an empty match", () => {
  assert.deepEqual(commandFor("/opt/airprompter"), ["/opt/airprompter"]);
  assert.deepEqual(commandFor("/x/airprompter.cjs"), [process.execPath, "/x/airprompter.cjs"]);
  assert.deepEqual(commandFor("/x/main.ts"), [process.execPath, "--import", "tsx", "/x/main.ts"]);
  const work = mkdtempSync(join(tmpdir(), "ap-action-glob-"));
  try {
    writeFileSync(join(work, "a.apbundle"), "");
    writeFileSync(join(work, "b.apbundle"), "");
    writeFileSync(join(work, "c.txt"), "");
    assert.deepEqual(expandBundles("*.apbundle", work), [join(work, "a.apbundle"), join(work, "b.apbundle")]);
    assert.deepEqual(expandBundles("a.apbundle\n\n c.txt ", work), [join(work, "a.apbundle"), join(work, "c.txt")]);
    assert.throws(() => expandBundles("*.zip", work), /nothing matches/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
