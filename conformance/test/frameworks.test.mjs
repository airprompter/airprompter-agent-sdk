// The framework runner's own suite (AIR-2233), beside harness.test.mjs (section wiring): a fixture or vector that
// fails its schema is refused by file, each failing expectation is reported by name, a framework missing a required
// kind fails the run naming both, a framework case is run and judged like a protocol vector, rows compare by their
// wire digits, and no driver imports an SDK internal. Stub adapters answer here; the real SDKs answer through
// `node harness.mjs` (frameworks/README.md).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SECTIONS, runHarness, vectorsDir } from "../harness.mjs";
import { EXEMPTIONS, FIXTURES_DIR, FRAMEWORK_PACKAGES, REQUIRED_KINDS, VECTORS_DIR, coverageGaps, loadFixtures, matchRowSet, runSection, schemaErrors, shippedAdapters, subsetMatches } from "../frameworks/run.mjs";
import { comparableLines } from "../frameworks/operations/sessionScenario.mjs";
import { newSealer } from "../frameworks/release.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const quiet = () => {};
const python = process.platform === "win32" ? "python" : "python3";

/** A harness-shaped context that collects verdicts. */
function collector() {
  const checks = [];
  return {
    checks,
    failed: () => checks.filter((c) => !c.ok),
    ctx: (adapter, options = {}) => ({ adapter, ok: (label) => checks.push({ ok: true, label }), fail: (label, detail) => checks.push({ ok: false, label, detail }), report: {}, options }),
  };
}
const stub = (language, ops) => ({ kind: "stub", language, capabilities: Object.keys(ops), call: async (fn, args) => ({ result: await ops[fn](args) }) });

const fixtureOf = (overrides = {}) => ({
  framework: "openai", language: "ts", frameworkVersion: "6.0.0", kind: "tool-loop",
  release: { slots: [{ tag: "support.reply", text: "Approved.", versionId: "ver_a", model: "gpt-5" }] },
  agent: { slot: "support.reply" }, input: { subject: "user-1" },
  recorded: { turns: [{ content: "ok" }] },
  expect: { calls: [{ system: "Approved.", model: "gpt-5" }], rows: [{ tag: "support.reply", count: 1, modelCalls: 1 }], runRef: { entries: 1 }, runCounters: { passthrough: {} }, stateExcludes: ["Approved."] },
  ...overrides,
});

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), "ap-fixtures-"));
  for (const [path, value] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof value === "string" ? value : JSON.stringify(value));
  }
  return dir;
}

test("the harness lists the framework sections and their operations", () => {
  assert.deepEqual(SECTIONS.frameworks, ["driveRun"]);
  assert.deepEqual(SECTIONS["run-session"], ["sessionScenario", "unavailableReasons"]);
});

test("every fixture and vector in the tree passes its schema; at least 25 vectors, one for every rule, unique names", () => {
  for (const entry of loadFixtures()) assert.equal(entry.error ?? schemaErrors("fixture", entry.fixture), null, entry.file);
  const file = JSON.parse(readFileSync(join(VECTORS_DIR, "run-session.json"), "utf8"));
  assert.equal(schemaErrors("vectors", file), null);
  assert.ok(file.vectors.length >= 25, `${file.vectors.length} session vectors`);
  for (let rule = 1; rule <= 11; rule += 1) assert.ok(file.vectors.some((v) => v.rule === rule), `a vector for rule ${rule}`);
  assert.equal(new Set(file.vectors.map((v) => v.name)).size, file.vectors.length, "vector names are unique: they are the labels");
  const golden = JSON.parse(readFileSync(join(VECTORS_DIR, "run-session.rows.json"), "utf8")).vectors;
  assert.deepEqual(Object.keys(golden).sort(), file.vectors.filter((v) => v.deterministic !== false).map((v) => v.name).sort(), "the golden rows name exactly the deterministic vectors");
});

test("the schemas refuse a fixture that would judge nothing and a misspelt step key", () => {
  assert.match(schemaErrors("fixture", fixtureOf({ expect: {} })), /required property 'calls'/);
  assert.match(schemaErrors("fixture", fixtureOf({ kind: "passthrough", expect: { calls: [], rows: [] } })), /runCounters/);
  assert.match(schemaErrors("fixture", fixtureOf({ kind: "canary-checkpoint", expect: { calls: [], rows: [] } })), /stateExcludes/);
  assert.match(schemaErrors("fixture", fixtureOf({ expect: { calls: [], rows: [] } })), /runRef/, "a tool loop proves its run reference");
  assert.match(schemaErrors("fixture", fixtureOf({ expect: { calls: [], rows: [], runRef: {} } })), /entries/, "and how many entries it holds");
  assert.match(schemaErrors("fixture", fixtureOf({ kind: "canary-checkpoint", expect: { calls: [], rows: [], stateExcludes: [] } })), /fewer than 1/);
  const file = JSON.parse(readFileSync(join(VECTORS_DIR, "run-session.json"), "utf8"));
  const first = file.vectors.find((v) => v.steps.some((s) => s.op === "place"));
  const misspelt = { ...file, vectors: [{ ...first, steps: first.steps.map((s) => (s.op === "place" ? { op: s.op, run: s.run, slot: s.slot, expcet: s.expect } : s)) }] };
  assert.match(schemaErrors("vectors", misspelt), /expcet/);
});

test("a fixture that fails its schema, or is misnamed, is refused by file, and its case does not run", async () => {
  const dir = tree({ "openai/tool-loop-ts.json": fixtureOf({ kind: "tool_loop" }), "openai/broken-ts.json": "{ not json", "openai/streaming-ts.json": fixtureOf() });
  const { ctx, failed } = collector();
  let driven = 0;
  try {
    await runSection("frameworks", ctx(stub("ts", { driveRun: () => (driven += 1, {}) }), { fixturesDir: dir, adapters: [] }));
    assert.ok(failed().some((c) => c.label === "fixture openai/tool-loop-ts.json" && /fixture\.schema\.json.*\/kind/.test(c.detail)), JSON.stringify(failed()));
    assert.ok(failed().some((c) => c.label === "fixture openai/broken-ts.json" && /not JSON/.test(c.detail)));
    assert.ok(failed().some((c) => c.label === "fixture openai/streaming-ts.json" && /tool-loop-<case>-ts\.json/.test(c.detail)), "the name says the kind the coverage rule counts");
    assert.equal(driven, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each failing expectation is reported by name; a right answer passes, judged like a protocol vector", async () => {
  const kinds = Object.fromEntries(Object.keys(REQUIRED_KINDS).filter((k) => REQUIRED_KINDS[k]("openai")).map((kind) => [`openai/${kind}-ts.json`, fixtureOf({ kind })]));
  const dir = tree(kinds);
  const options = { fixturesDir: dir, adapters: [{ framework: "openai", language: "ts" }], exemptions: {} };
  try {
    const right = { calls: [{ system: "Approved.", model: "gpt-5", settings: {} }], rows: [{ type: "window", tag: "support.reply", count: 1, modelCalls: 1, arm: "none" }], runRefs: [], placements: [], runCounters: { passthrough: {} }, state: {}, frameworkVersion: "6.0.0" };
    const good = collector();
    await runSection("frameworks", good.ctx(stub("ts", { driveRun: () => right }), options));
    // No run reference came back, so runRef fails by name on the kinds that need one; everything else passes.
    assert.deepEqual([...new Set(good.failed().map((c) => c.label.split(" › ")[1]))], ["runRef"], JSON.stringify(good.failed()));
    assert.ok(good.checks.some((c) => c.ok && c.label.startsWith("coverage:")));

    const wrong = collector();
    await runSection("frameworks", wrong.ctx(stub("ts", { driveRun: () => ({ ...right, calls: [{ system: "The caller's own prompt.", model: "gpt-4.1" }], rows: [{ tag: "support.reply", count: 5, modelCalls: 1 }] }) }), options));
    const labels = wrong.failed().map((c) => c.label);
    assert.ok(labels.includes("openai tool-loop: openai/tool-loop-ts.json › calls[0]"), labels.join("\n"));
    assert.ok(labels.includes("openai tool-loop: openai/tool-loop-ts.json › rows"));
    assert.match(wrong.failed().find((c) => c.label.endsWith("tool-loop-ts.json › calls[0]")).detail, /gpt-4\.1/);

    // Another installed version than the fixture's fails by name; the weekly latest run names the version instead.
    const stale = collector();
    await runSection("frameworks", stale.ctx(stub("ts", { driveRun: () => ({ ...right, frameworkVersion: "6.1.0" }) }), options));
    assert.match(stale.failed().find((c) => c.label.endsWith("tool-loop-ts.json › frameworkVersion"))?.detail ?? "", /openai 6\.1\.0 is installed; the fixture was recorded from 6\.0\.0/);
    process.env.AIRPROMPTER_FRAMEWORKS_LATEST = "1";
    try {
      const latest = collector();
      await runSection("frameworks", latest.ctx(stub("ts", { driveRun: () => ({ ...right, frameworkVersion: "6.1.0" }) }), options));
      assert.ok(!latest.failed().some((c) => c.label.endsWith("› frameworkVersion")));
      assert.ok(latest.checks.some((c) => c.label.includes("(openai 6.1.0)")), "the version that ran is in the case's name");
    } finally {
      delete process.env.AIRPROMPTER_FRAMEWORKS_LATEST;
    }

    const other = collector();
    await runSection("frameworks", other.ctx(stub("py", { driveRun: () => assert.fail("a TypeScript fixture never reaches a Python adapter") }), options));
    assert.deepEqual(other.failed(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("events count by name, and with `fields` every one must carry them; no reported log fails even a count of 0", async () => {
  const want = { count: 1, fields: { setting: [{ setting: "temperatureMilli", reason: "client" }] } };
  const dir = tree({ "openai/settings-ts.json": fixtureOf({ kind: "settings", expect: { calls: [{ system: "Approved.", model: "gpt-5" }], rows: [], events: { adapter_inference_unsupported: want, adapter_late_record: 0 } } }) });
  assert.notEqual(schemaErrors("fixture", fixtureOf({ kind: "settings", expect: { calls: [], rows: [], events: { e: { count: 1 } } } })), null, "an object form names its fields");
  const run = async (log) => {
    const c = collector();
    const answer = { calls: [{ system: "Approved.", model: "gpt-5" }], rows: [], frameworkVersion: "6.0.0", ...(log === undefined ? {} : { log }) };
    await runSection("frameworks", c.ctx(stub("ts", { driveRun: () => answer }), { fixturesDir: dir, adapters: [], exemptions: {} }));
    return c.failed().filter((f) => f.label.includes("settings-ts.json")).map((f) => f.label.split(" › ")[1]);
  };
  try {
    const event = (setting, reason) => ({ event: "adapter_inference_unsupported", setting: [{ setting, reason }] });
    assert.deepEqual(await run([event("temperatureMilli", "client")]), []);
    assert.deepEqual(await run([event("temperatureMilli", "shape")]), ["events.adapter_inference_unsupported"], "the wrong reason fails");
    assert.deepEqual(await run([event("temperatureMilli", "client"), event("topPBps", "client")]), ["events.adapter_inference_unsupported"], "one too many fails");
    assert.deepEqual(await run(undefined), ["events"], "an adapter that reports no log cannot pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the coverage rule fails a framework missing a required kind, naming both, a shipped adapter with no folder, and an exemption with no ticket or gone stale", () => {
  const dir = tree({ "openai/tool-loop-ts.json": fixtureOf(), "litellm/tool-loop-py.json": fixtureOf({ framework: "litellm", language: "py" }), "newthing/tool-loop-ts.json": fixtureOf({ framework: "newthing" }) });
  try {
    const exemptions = { "litellm/py": { streaming: "until a customer needs it", model: "AIR-9999: later", "tool-loop": "AIR-9999: stale" } };
    const gaps = coverageGaps(loadFixtures(dir), { adapters: [{ framework: "anthropic", language: "py" }], exemptions });
    const named = gaps.map((g) => `${g.framework}/${g.language}/${g.kind}`);
    for (const kind of ["streaming", "handoff", "passthrough", "model", "settings"]) assert.ok(named.includes(`openai/ts/${kind}`), `openai owes ${kind}: ${named}`);
    assert.ok(!named.includes("openai/ts/node-map") && !named.includes("openai/ts/canary-checkpoint"), "a direct client takes no map and keeps no state");
    assert.ok(named.includes("anthropic/py/tool-loop"), "a shipped adapter with no fixture owes every kind");
    assert.ok(named.includes("litellm/py/passthrough"));
    assert.ok(!gaps.some((g) => g.framework === "litellm" && g.kind === "model" && !g.detail), "exempt with a ticket");
    assert.ok(gaps.some((g) => g.framework === "litellm" && g.kind === "streaming" && /names no ticket/.test(g.detail)));
    assert.ok(gaps.some((g) => g.framework === "litellm" && g.kind === "tool-loop" && /stale/.test(g.detail)));
    assert.ok(gaps.some((g) => g.framework === "newthing" && /FRAMEWORK_TRAITS/.test(g.detail)), "an unknown framework cannot owe nothing");
    const onlyPython = coverageGaps(loadFixtures(dir), { language: "py", adapters: [], exemptions });
    assert.ok(onlyPython.length > 0 && onlyPython.every((g) => g.framework === "litellm"), "a language's run judges only that language");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the tree's own coverage holds for both languages, every shipped adapter is counted, and the exemptions are these", () => {
  assert.deepEqual(coverageGaps(loadFixtures()), []);
  const shipped = shippedAdapters().map((a) => `${a.framework}/${a.language}`).sort();
  assert.deepEqual(shipped, ["agent/py", "agent/ts", "ai-sdk/ts", "anthropic/py", "anthropic/ts", "langchain/ts", "litellm/py", "openai/py", "openai/ts"]);
  // Pinned: an exemption is added or lifted here on purpose, with its ticket.
  assert.deepEqual(Object.fromEntries(Object.entries(EXEMPTIONS).map(([key, kinds]) => [key, Object.keys(kinds).sort()])), {
    "langchain/ts": ["canary-checkpoint", "handoff", "interrupted", "late-tag", "model", "node-map", "passthrough", "settings", "slot-typo", "streaming"],
  });
  assert.ok(!Object.values(EXEMPTIONS).some((kinds) => Object.values(kinds).some((reason) => /AIR-2233 part 2/.test(reason))), "part 2 left no exemption of its own");
  for (const kinds of Object.values(EXEMPTIONS)) for (const reason of Object.values(kinds)) assert.match(reason, /\bAIR-\d+\b/);
});

test("a vector file that fails its schema is refused; a wrong session answer fails by vector and expectation", async () => {
  const broken = mkdtempSync(join(tmpdir(), "ap-vectors-"));
  try {
    cpSync(join(VECTORS_DIR, "placement-reasons.json"), join(broken, "placement-reasons.json"));
    const file = JSON.parse(readFileSync(join(VECTORS_DIR, "run-session.json"), "utf8"));
    writeFileSync(join(broken, "run-session.json"), JSON.stringify({ ...file, vectors: [{ ...file.vectors[0], steps: [{ op: "teleport" }] }] }));
    const refused = collector();
    await runSection("run-session", refused.ctx(stub("ts", { unavailableReasons: () => ({ reasons: ["no_slot"] }), sessionScenario: () => assert.fail("never run") }), { vectorsDir: broken }));
    assert.ok(refused.failed().some((c) => c.label === "vectors/run-session.json" && /vector\.schema\.json/.test(c.detail)));
    assert.ok(refused.failed().some((c) => c.label === "placement reasons"), "a reason list that differs fails");

    const one = file.vectors.find((v) => v.name.startsWith("end twice writes once"));
    writeFileSync(join(broken, "run-session.json"), JSON.stringify({ ...file, vectors: [one] }));
    cpSync(join(VECTORS_DIR, "run-session.rows.json"), join(broken, "run-session.rows.json"));
    const wrong = collector();
    const reasons = JSON.parse(readFileSync(join(VECTORS_DIR, "placement-reasons.json"), "utf8")).reasons;
    const row = { type: "window", tag: "support.reply", count: 2 };
    await runSection("run-session", wrong.ctx(stub("ts", {
      unavailableReasons: () => ({ reasons }),
      sessionScenario: (script) => ({ results: script.steps.map((s) => (s.op === "open" ? { runRef: "x.y" } : s.op === "place" ? { placement: { kind: "approved", slot: "support.reply", instructions: "Version A", model: "gpt-5", settings: {} } } : {})), rows: [row], steps: [], refusals: [], wire: { rows: [JSON.stringify(row)], steps: [], refusals: [] }, runCounters: { passthrough: {} }, log: [] }),
    }), { vectorsDir: broken }));
    const labels = wrong.failed().map((c) => c.label);
    assert.ok(labels.some((l) => l.startsWith("rule 5: end twice writes once") && l.endsWith("› rows")), labels.join("\n"));
    assert.ok(labels.some((l) => l.endsWith("› golden")), "rows that differ from the record fail");
    assert.ok(labels.some((l) => l.endsWith("› step 0 open r")), "a reference that does not verify under the agent's key fails");
    assert.ok(wrong.checks.some((c) => c.ok && c.label.startsWith("placement reasons")));
  } finally {
    rmSync(broken, { recursive: true, force: true });
  }
});

test("rows compare by the digits the spool wrote, not as JavaScript reads them, without the process's own fields", () => {
  assert.notDeepEqual(comparableLines(['{"a":1}']), comparableLines(['{"a":1.0}']));
  assert.notDeepEqual(comparableLines(['{"a":56921485453937780}']), comparableLines(['{"a":56921485453937776}']), "one double, two integers");
  assert.deepEqual(comparableLines(['{"b":2,"a":{"y":1,"x":[1,2]},"instanceId":"i-1","sdk":"ts"}']), comparableLines(['{"a":{"x":[1,2],"y":1},"b":2,"instanceId":"i-2","sdk":"py","instanceClass":"resident"}']));
});

test("rows match on the fields named, deeply, and every row is taken once, whatever the order", () => {
  assert.equal(subsetMatches({ a: 1, b: { c: 2, d: 3 }, e: [1] }, { b: { c: 2 } }), true);
  assert.equal(subsetMatches({ b: { c: 2 } }, { b: { c: 3 } }), false);
  assert.equal(subsetMatches({ e: [1, 2] }, { e: [1] }), false, "arrays compare whole");
  assert.equal(matchRowSet([{ count: 1 }, { count: 1 }], [{ count: 1 }]), "1 row not expected: [{\"count\":1}]");
  assert.equal(matchRowSet([{ count: 1 }], [{ count: 1 }, { count: 1 }]).startsWith("row 1"), true);
  assert.equal(matchRowSet([{ tag: "a", count: 2 }, { tag: "a", count: 1 }], [{ tag: "a" }, { tag: "a", count: 2 }]), true, "a general row does not steal the specific one's match");
});

test("a sealed release is a plaintext bundle the protocol's schema accepts", () => {
  const require = createRequire(import.meta.url);
  const Ajv2020 = require("ajv/dist/2020.js").default;
  const addFormats = require("ajv-formats");
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  (addFormats.default ?? addFormats)(ajv);
  for (const name of readdirSync(join(repo, "protocol", "schemas")).filter((f) => f.endsWith(".schema.json"))) ajv.addSchema(JSON.parse(readFileSync(join(repo, "protocol", "schemas", name), "utf8")));
  const validate = ajv.getSchema(JSON.parse(readFileSync(join(repo, "protocol", "schemas", "bundle.schema.json"), "utf8")).$id);
  const file = JSON.parse(readFileSync(join(VECTORS_DIR, "run-session.json"), "utf8"));
  const sealer = newSealer({ organizationId: file.agent.organizationId, agentId: file.agent.agentId, target: file.agent.target });
  for (const name of Object.keys(file.releases)) {
    const bundle = sealer.seal(file.releases[name], { nowMs: file.agent.t0 });
    assert.equal(validate(bundle), true, `${name}: ${JSON.stringify(validate.errors?.slice(0, 3))}`);
  }
});

test("a framework section an adapter cannot answer is skipped, never passed", async () => {
  const report = await runHarness({ adapter: stub("ts", {}), vectors: vectorsDir(), only: "frameworks,run-session", log: quiet });
  assert.deepEqual(report.skipped, [{ section: "frameworks", missing: ["driveRun"] }, { section: "run-session", missing: ["sessionScenario", "unavailableReasons"] }]);
  assert.equal(report.ok, false);
});

// ---------------------------------------------------------------------------
// Drivers import what a developer's code imports: the SDK's root, a framework subpath, the framework, Node built-ins
// and the drivers' own helpers. Never an SDK internal, a build path or the CI kit. TypeScript drivers also get `load`,
// which refuses the same at run time (adapters/agent-sdk-run.mjs).

const ALLOWED_SDK_TS = /^@airprompter\/agent-sdk(\/frameworks\/(?!contract$)[a-z0-9-]+)?$/;

/** Every import a TypeScript driver makes; a dynamic import, `require` or `load` whose argument is not a literal string is itself a violation. */
export function tsDriverViolations(source) {
  const bad = [];
  for (const m of source.matchAll(/\b(import|require|createRequire|load)\s*\(\s*([^)]*)\)/g)) {
    const literal = /^(["'])([^"'`$]+)\1$/.exec(m[2].trim());
    if (m[1] === "createRequire" || !literal) bad.push(`${m[1]}(${m[2].trim()})`);
  }
  const specifiers = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+|\bload\s*\(\s*|\brequire\s*\(\s*)(["'])([^"']+)\1/gm)].map((m) => m[2]);
  for (const s of specifiers) {
    if (s.startsWith("node:")) continue;
    if (s.startsWith("./")) {
      if (!/^\.\/[a-z0-9-]+\.mjs$/.test(s)) bad.push(s);
    } else if (s.startsWith("@airprompter/")) {
      if (!ALLOWED_SDK_TS.test(s)) bad.push(s);
    } else if (s.startsWith("/") || s.startsWith("../") || /\/(dist|src|packages)\//.test(s)) bad.push(s);
  }
  return [...new Set(bad)];
}

const PY_SCAN = String.raw`
import ast, json, sys
tree = ast.parse(sys.stdin.read())
for parent in ast.walk(tree):
    for child in ast.iter_child_nodes(parent):
        child._parent = parent
bad = []
PARTS = ("core", "runtime", "telemetry", "sync", "frameworks", "agent")
def allowed(module):
    if not module.startswith("airprompter_agent"):
        return not (module == "importlib" or module.startswith("importlib."))
    parts = module.split(".")
    return parts == ["airprompter_agent"] or (len(parts) == 3 and parts[1] == "frameworks" and parts[2] != "contract")
package = {a.asname or "airprompter_agent" for node in ast.walk(tree) if isinstance(node, ast.Import) for a in node.names if a.name == "airprompter_agent"}
frameworks = {a.asname or "frameworks" for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.module == "airprompter_agent" for a in node.names if a.name == "frameworks"}
roots = package | frameworks
def chain(node):
    names = []
    while isinstance(node, ast.Attribute):
        names.insert(0, node.attr)
        node = node.value
    return (node.id, names) if isinstance(node, ast.Name) else (None, names)
for node in ast.walk(tree):
    if isinstance(node, ast.Attribute) and not isinstance(getattr(node, "_parent", None), ast.Attribute):
        root, names = chain(node)
        if root in roots and names:
            path = (["airprompter_agent"] if root in package else ["airprompter_agent", "frameworks"]) + names
            if path[1] in PARTS and not (path[1] == "frameworks" and len(path) >= 3 and path[2] != "contract"):
                bad.append(".".join(path[:3] if path[1] == "frameworks" else path[:2]))
    if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Attribute) and node.value.attr == "modules" and isinstance(node.slice, ast.Constant) and str(node.slice.value).startswith("airprompter_agent"):
        bad.append(f"sys.modules[{node.slice.value!r}]")
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "getattr" and node.args and isinstance(node.args[0], ast.Name) and node.args[0].id in roots:
        bad.append(f"getattr({node.args[0].id})")
    if isinstance(node, ast.Import):
        bad += [a.name for a in node.names if not allowed(a.name)]
    elif isinstance(node, ast.ImportFrom):
        module = node.module or ""
        if node.level:
            bad.append("." * node.level + module)
        elif module == "airprompter_agent":
            bad += [f"airprompter_agent.{a.name}" for a in node.names if a.name in PARTS and a.name != "frameworks"]
        elif module == "airprompter_agent.frameworks":
            bad += [f"airprompter_agent.frameworks.{a.name}" for a in node.names if a.name == "contract"]
        elif not allowed(module):
            bad.append(module)
    elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ("__import__", "exec", "eval"):
        bad.append(node.func.id)
print(json.dumps(sorted(bad)))
`;

/** Every import a Python driver makes, read from its syntax tree; `importlib`, `__import__`, `exec` and `eval` are violations. */
export function pyDriverViolations(source) {
  const run = spawnSync(python, ["-I", "-c", PY_SCAN], { input: source, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`python could not read the driver: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

test("the driver scan refuses an SDK internal however it is spelt, and every driver in the tree passes it", (t) => {
  assert.deepEqual(tsDriverViolations(`import { x } from "@airprompter/agent-sdk/runtime";\nconst y = await load("@airprompter/agent-sdk/frameworks/contract");\nawait import("../../sdk-typescript/packages/sdk/dist/esm/agent.js");\nimport "./recorded.mjs";\nawait load("@airprompter/agent-sdk/frameworks/openai"); await load("openai");`).sort(), ["../../sdk-typescript/packages/sdk/dist/esm/agent.js", "@airprompter/agent-sdk/frameworks/contract", "@airprompter/agent-sdk/runtime"].sort());
  assert.ok(tsDriverViolations(`await load("@airprompter/agent-sdk" + "/runtime");`).length > 0, "a computed specifier");
  assert.ok(tsDriverViolations("await load (`@airprompter/agent-sdk/runtime`);").length > 0, "a template specifier, a space before the parenthesis");
  assert.ok(tsDriverViolations(`const r = createRequire(import.meta.url);`).length > 0);
  assert.ok(tsDriverViolations(`await import(new URL("../x.js", import.meta.url).href);`).length > 0);
  const tsDir = join(here, "..", "frameworks", "drivers");
  for (const file of readdirSync(tsDir).filter((f) => f.endsWith(".mjs"))) assert.deepEqual(tsDriverViolations(readFileSync(join(tsDir, file), "utf8")), [], file);

  // In CI a missing interpreter is a failure, never a skip: the Python drivers would go unread.
  if (spawnSync(python, ["--version"]).status !== 0) {
    if (process.env.CI) assert.fail(`no ${python} to read the Python drivers with`);
    return t.skip("no python3 to read Python drivers with");
  }
  const source = "from airprompter_agent.runtime.run import RunInput\nimport airprompter_agent.core\nfrom airprompter_agent.frameworks.openai import instrument\nimport openai\nfrom airprompter_agent.frameworks.contract import acquire_run\nfrom airprompter_agent import runtime, AirPrompterAgent\nfrom airprompter_agent.frameworks import contract, litellm\nimport os, airprompter_agent.telemetry.spool\nimport importlib\n__import__('x')\nfrom . import y\n";
  assert.deepEqual(pyDriverViolations(source), [".", "__import__", "airprompter_agent.core", "airprompter_agent.frameworks.contract", "airprompter_agent.frameworks.contract", "airprompter_agent.runtime", "airprompter_agent.runtime.run", "airprompter_agent.telemetry.spool", "importlib"]);
  assert.deepEqual(pyDriverViolations("import airprompter_agent\nimport sys\nx = airprompter_agent.runtime.run.RunInput\ny = getattr(airprompter_agent, 'runtime')\nz = sys.modules['airprompter_agent.runtime.run']\nok = airprompter_agent.AirPrompterAgent\nfine = airprompter_agent.frameworks.openai.instrument\nno = airprompter_agent.frameworks.contract\n"), ["airprompter_agent.frameworks.contract", "airprompter_agent.runtime", "getattr(airprompter_agent)", "sys.modules['airprompter_agent.runtime.run']"]);
  assert.deepEqual(pyDriverViolations("import airprompter_agent as ap_sdk\nfrom airprompter_agent import frameworks\nx = ap_sdk.core.thing\ny = frameworks.contract\nz = frameworks.litellm.measure_call\n"), ["airprompter_agent.core", "airprompter_agent.frameworks.contract"]);
  const pyDir = join(repo, "examples", "conformance-adapter", "python", "drivers");
  let pyFiles = [];
  try {
    pyFiles = readdirSync(pyDir).filter((f) => f.endsWith(".py"));
  } catch {
    // no Python drivers yet
  }
  // A known gap, each with the ticket that closes it: LiteLLM's subpath has no measuring helper, so its driver measures
  // with the contract's `measure_call`, as LiteLLM's own docs tell a developer to (AIR-2545, `instrument(litellm)`).
  const KNOWN = { "litellm.py": ["airprompter_agent.frameworks.contract"] };
  for (const file of pyFiles) assert.deepEqual(pyDriverViolations(readFileSync(join(pyDir, file), "utf8")), KNOWN[file] ?? [], file);
  assert.ok(pyFiles.includes("litellm.py"), "the known gap names a driver that exists: delete it with AIR-2545");
});

test("the fixture tree's folders are the frameworks named in their fixtures", () => {
  for (const entry of loadFixtures(FIXTURES_DIR)) assert.equal(entry.fixture.framework, entry.folder, entry.file);
});

test("pins come from the fixtures, one version per package and language; --framework runs one framework", async () => {
  const { pinsOf } = await import("../frameworks/pins.mjs");
  // TypeScript's pins are also sdk-typescript's exact devDependencies: one version, wherever it is read.
  const manifest = JSON.parse(readFileSync(join(repo, "sdk-typescript", "package.json"), "utf8"));
  const own = new Set(Object.values(FRAMEWORK_PACKAGES).map((p) => p.ts).filter(Boolean));
  for (const [name, { version, file }] of pinsOf().ts) if (own.has(name)) assert.equal(manifest.devDependencies?.[name], version, `${name} ${version} (${file}) is sdk-typescript's exact devDependency`);
  const tree1 = tree({ "openai/tool-loop-py.json": fixtureOf({ language: "py", frameworkVersion: "3.60.0" }), "openai/settings-py.json": fixtureOf({ language: "py", kind: "settings", frameworkVersion: "3.60.0", packages: { httpx: "0.28.1" } }), "agent/two-store-py.json": fixtureOf({ framework: "agent", language: "py", kind: "two-store", frameworkVersion: "1.0.0rc5" }) });
  const tree2 = tree({ "openai/tool-loop-py.json": fixtureOf({ language: "py", frameworkVersion: "3.60.0" }), "openai/settings-py.json": fixtureOf({ language: "py", kind: "settings", frameworkVersion: "3.61.0" }) });
  const both = tree({ "openai/tool-loop-ts.json": fixtureOf(), "anthropic/tool-loop-ts.json": fixtureOf({ framework: "anthropic" }) });
  try {
    const pins = pinsOf(loadFixtures(tree1));
    assert.deepEqual([...pins.py].map(([name, { version }]) => `${name}==${version}`).sort(), ["httpx==0.28.1", "openai==3.60.0"], "the SDK's own folder pins nothing");
    assert.throws(() => pinsOf(loadFixtures(tree2)), /openai \(py\) is pinned to 3\.6[01]\.0 in .* and 3\.6[01]\.0 in /);
    const only = collector();
    await runSection("frameworks", only.ctx(stub("ts", { driveRun: () => ({}) }), { fixturesDir: both, adapters: [], framework: "anthropic" }));
    assert.ok(only.checks.every((c) => !c.label.startsWith("openai ")), "another framework's cases do not run");
    assert.ok(only.checks.some((c) => c.label.startsWith("anthropic tool-loop")));
    const none = collector();
    await runSection("frameworks", none.ctx(stub("py", { driveRun: () => ({}) }), { fixturesDir: both, adapters: [], framework: "anthropic" }));
    assert.ok(none.failed().some((c) => c.label === "frameworks: anthropic"), "a filter that selects nothing fails");
  } finally {
    for (const dir of [tree1, tree2, both]) rmSync(dir, { recursive: true, force: true });
  }
});
