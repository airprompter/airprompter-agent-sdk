// The harness's own vectors (S14): the reference adapter passes every section; an adapter that answers wrongly is
// failed by name with the vector and the difference; an adapter missing an operation has that section skipped and the
// run reported incomplete (never green) unless --allow-skips; a JSON-lines adapter is driven over a real pipe, its
// stray stdout ignored, its refusals matched by reason; the CLI's exit codes are the contract (0 / 1 / 2).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { OPERATIONS, SECTIONS, commandAdapter, moduleAdapter, runHarness, vectorsDir } from "../harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const harnessPath = join(here, "..", "harness.mjs");
const referencePath = join(here, "..", "adapters", "reference.mjs");
const quiet = () => {};

test("every section names only known operations; the reference adapter implements them all and passes every section", async () => {
  for (const [section, ops] of Object.entries(SECTIONS)) for (const op of ops) assert.ok(OPERATIONS.includes(op), `${section} needs ${op}`);
  const adapter = await moduleAdapter(referencePath);
  assert.deepEqual([...adapter.capabilities].sort(), [...OPERATIONS].sort());
  const report = await runHarness({ adapter, vectors: vectorsDir(), log: quiet });
  assert.equal(report.failed, 0, JSON.stringify(report.sections.flatMap((s) => s.checks.filter((c) => !c.ok))));
  assert.equal(report.skipped.length, 0);
  assert.ok(report.passed > 200, `${report.passed} checks`);
  assert.equal(report.ok, true);
  assert.deepEqual(report.sections.map((s) => s.name), Object.keys(SECTIONS));
});

test("a wrong answer fails by vector name with the difference; a missing operation skips its section and the run is incomplete", async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-harness-"));
  try {
    // Wrong: assignArm always says control; canonicalJson never refuses; the rest is the reference.
    const wrongPath = join(work, "wrong.mjs");
    writeFileSync(wrongPath, `import { ops as reference } from ${JSON.stringify(referencePath)};
export const ops = { ...reference, assignArm: (args) => ({ ...reference.assignArm({ ...args, arms: args.arms.length >= 2 ? args.arms : [{ arm: "control", weightBps: 5000 }, { arm: "candidate", weightBps: 5000 }] }), arm: "control" }), canonicalJson: ({ json }) => { try { return reference.canonicalJson({ json }); } catch { return { text: json, sha256: "sha256:0" }; } } };
`);
    const wrong = await moduleAdapter(wrongPath);
    const report = await runHarness({ adapter: wrong, vectors: vectorsDir(), only: "canonical-json,assignment,checks", log: quiet });
    assert.equal(report.ok, false);
    const failed = report.sections.flatMap((s) => s.checks.filter((c) => !c.ok));
    assert.ok(failed.some((c) => c.label.startsWith("refused: fractional number") && /answered .* instead of refusing non_integer_number/.test(c.detail)), JSON.stringify(failed.slice(0, 3)));
    assert.ok(failed.some((c) => c.label === "different salt, same subject" && /expected \{"subjectHash"/.test(c.detail)));
    assert.ok(failed.some((c) => c.label.startsWith("refused: ") && c.label.includes("arm") && /answered .* instead of refusing/.test(c.detail)), "a refusal vector answered instead of refused is a failure");
    assert.equal(report.sections.find((s) => s.name === "checks").checks.every((c) => c.ok), true, "the untouched section still passes");

    // Partial: no spool, no otel — those sections skip; the run is incomplete unless skips are allowed.
    const partialPath = join(work, "partial.mjs");
    writeFileSync(partialPath, `import { ops as reference } from ${JSON.stringify(referencePath)};
const { planSegments, aggregateWindows, spoolRowsToOtlp, ...rest } = reference;
export const ops = rest;
`);
    const partial = await moduleAdapter(partialPath);
    const incomplete = await runHarness({ adapter: partial, vectors: vectorsDir(), log: quiet });
    assert.equal(incomplete.failed, 0);
    assert.deepEqual(incomplete.skipped, [
      { section: "spool-rotation", missing: ["planSegments"] },
      { section: "spool-windows", missing: ["aggregateWindows"] },
      { section: "otel", missing: ["spoolRowsToOtlp"] },
    ]);
    assert.equal(incomplete.ok, false, "a skipped section is never a pass");
    const allowed = await runHarness({ adapter: partial, vectors: vectorsDir(), allowSkips: true, log: quiet });
    assert.equal(allowed.ok, true);
    // The command line: 0 / 1 / 2.
    assert.equal(spawnSync(process.execPath, [harnessPath, "--adapter", referencePath, "--only", "assignment"], { encoding: "utf8" }).status, 0);
    assert.equal(spawnSync(process.execPath, [harnessPath, "--adapter", wrongPath, "--only", "assignment"], { encoding: "utf8" }).status, 1);
    assert.equal(spawnSync(process.execPath, [harnessPath, "--adapter", partialPath], { encoding: "utf8" }).status, 1);
    assert.equal(spawnSync(process.execPath, [harnessPath, "--adapter", partialPath, "--allow-skips"], { encoding: "utf8" }).status, 0);
    assert.equal(spawnSync(process.execPath, [harnessPath], { encoding: "utf8" }).status, 2);
    const json = spawnSync(process.execPath, [harnessPath, "--adapter", referencePath, "--only", "feedback", "--json"], { encoding: "utf8" });
    assert.equal(JSON.parse(json.stdout).ok, true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("a JSON-lines adapter over a pipe: capabilities, answers, refusals by reason, stray stdout ignored, a missing op marked unsupported", async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-harness-cmd-"));
  try {
    // A Node process speaking the wire protocol, wrapping the reference — the shape any language's adapter takes.
    const adapterPath = join(work, "adapter.mjs");
    writeFileSync(adapterPath, `import { createInterface } from "node:readline";
import { ops } from ${JSON.stringify(referencePath)};
console.log("adapter starting (not a protocol line)");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.fn === "capabilities") return console.log(JSON.stringify({ id: m.id, result: { ops: Object.keys(ops).filter((k) => k !== "spoolRowsToOtlp") } }));
  if (m.fn === "spoolRowsToOtlp") return console.log(JSON.stringify({ id: m.id, error: { reason: "unsupported" } }));
  try { console.log(JSON.stringify({ id: m.id, result: ops[m.fn](m.args) })); }
  catch (e) { console.log(JSON.stringify({ id: m.id, error: { reason: e.reason ?? "error", message: e.message } })); }
});
`);
    const adapter = await commandAdapter(`${JSON.stringify(process.execPath)} ${JSON.stringify(adapterPath)}`);
    try {
      assert.ok(adapter.capabilities.includes("assignArm") && !adapter.capabilities.includes("spoolRowsToOtlp"));
      const answer = await adapter.call("assignArm", { salt: "AAECAwQFBgcICQoLDA0ODw", subject: "user-1", arms: [{ arm: "control", weightBps: 5000 }, { arm: "candidate", weightBps: 5000 }] });
      assert.ok(answer.result && typeof answer.result.bucket === "number", JSON.stringify(answer));
      const refused = await adapter.call("assignArm", { salt: "AAECAwQFBgcICQoLDA0ODw", subject: "user-1", arms: [{ arm: "control", weightBps: 10000 }] });
      assert.equal(refused.error?.reason, "too_few_arms");
      const report = await runHarness({ adapter, vectors: vectorsDir(), log: quiet });
      assert.equal(report.failed, 0, JSON.stringify(report.sections.flatMap((s) => s.checks.filter((c) => !c.ok)).slice(0, 3)));
      assert.deepEqual(report.skipped, [{ section: "otel", missing: ["spoolRowsToOtlp"] }]);
    } finally {
      await adapter.close();
    }
    const dead = await commandAdapter(`${JSON.stringify(process.execPath)} -e "process.stdout.write(JSON.stringify({id:1,result:{ops:['assignArm']}})+'\\\\n'); process.exit(0)"`, { timeoutMs: 1500 });
    try {
      const gone = await dead.call("assignArm", {});
      assert.ok(["adapter_exited", "timeout"].includes(gone.error?.reason), JSON.stringify(gone));
    } finally {
      await dead.close();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the published package is self-contained: npm pack carries the vectors, schemas and VERSION; installed alone, the bin runs the reference and an adapter that imports the /reference export", { timeout: 120_000 }, () => {
  const work = mkdtempSync(join(tmpdir(), "ap-harness-pack-"));
  try {
    const packed = spawnSync("npm", ["pack", "--pack-destination", work], { cwd: join(here, ".."), encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    const tarball = packed.stdout.trim().split("\n").pop();
    const listing = spawnSync("tar", ["tzf", join(work, tarball)], { encoding: "utf8" }).stdout.split("\n");
    for (const path of ["package/harness.mjs", "package/adapters/reference.mjs", "package/protocol/VERSION", "package/protocol/vectors/otel-mapping.json", "package/protocol/schemas/latency-buckets.json", "package/ADAPTER.md"]) assert.ok(listing.includes(path), `${path} in the tarball`);
    assert.ok(!listing.some((p) => p.includes("agent-sdk.mjs") || p.includes("run.mjs") || p.includes("node_modules")), "repository-only files stay out");
    assert.equal(existsSync(join(here, "..", "protocol")), false, "postpack removed the bundled copy");
    writeFileSync(join(work, "package.json"), JSON.stringify({ name: "sdk-under-test", private: true, type: "module" }));
    const installed = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", join(work, tarball)], { cwd: work, encoding: "utf8" });
    assert.equal(installed.status, 0, installed.stderr);
    writeFileSync(join(work, "adapter.mjs"), `export { ops } from "@airprompter/protocol-conformance/reference";\n`);
    const run = spawnSync(process.execPath, [join(work, "node_modules", "@airprompter", "protocol-conformance", "harness.mjs"), "--adapter", "./adapter.mjs", "--json"], { cwd: work, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const report = JSON.parse(run.stdout);
    assert.equal(report.ok, true);
    assert.ok(report.passed > 200);
    assert.ok(existsSync(join(work, "node_modules", ".bin", "airprompter-conformance")), "the bin is linked");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
