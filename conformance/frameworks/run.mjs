// The framework conformance runner (AIR-2233): the harness's sections that hold
// framework adapters and the run session to one recorded suite. An operation
// registry: each module in ./operations/ names one adapter operation, the
// section it drives and how that section is judged, so a later operation
// (AIR-2232's `spanToObservation`) is a new file here and changes no existing
// code. harness.mjs loads this file when it is present (in this repository;
// the published package carries the protocol sections only).
//
//   import { OPERATIONS, SECTIONS, runSection } from "./frameworks/run.mjs";
//   await runSection("run-session", { adapter, ok, fail, report, options });
//
// Fixtures and vectors are checked against fixture.schema.json and
// vector.schema.json before anything runs; one that fails is reported by file
// and path and its cases do not run. The coverage rule fails every framework
// adapter the SDKs ship, and every fixture folder, missing a kind its
// framework requires (REQUIRED_KINDS), naming both, unless EXEMPTIONS excuses
// it with a ticket.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(here, "fixtures");
export const VECTORS_DIR = join(here, "vectors");
const repo = join(here, "..", "..");

// ---------------------------------------------------------------------------
// Schemas. Ajv loads on the first check, so a protocol-only run of the harness needs no install.

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
let validators = null;
function validatorsOf() {
  if (validators) return validators;
  const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js").default;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  // The fixture schema takes its release from the vector schema's, so both are added before either compiles.
  ajv.addSchema(readJson(join(here, "vector.schema.json")));
  ajv.addSchema(readJson(join(here, "fixture.schema.json")));
  validators = {
    fixture: ajv.getSchema("https://airprompter.dev/conformance/frameworks/fixture.schema.json"),
    vectors: ajv.getSchema("https://airprompter.dev/conformance/frameworks/vector.schema.json"),
  };
  return validators;
}

/** Null when `document` is valid, else a one-line list of what is wrong, by JSON path. */
export function schemaErrors(kind, document) {
  const validate = validatorsOf()[kind];
  if (validate(document)) return null;
  return validate.errors.slice(0, 6).map((e) => `${e.instancePath || "/"} ${e.message}${e.params?.allowedValues ? ` (${e.params.allowedValues.join(", ")})` : ""}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ""}`).join("; ");
}

// ---------------------------------------------------------------------------
// The coverage rule (section 5 of 00-redesign.md). A framework's traits say
// which conditional kinds it owes; a framework not listed here fails until it
// is added, so a new adapter cannot owe nothing by omission.

export const FRAMEWORK_TRAITS = {
  openai: { stream: true, map: false, state: false },
  anthropic: { stream: true, map: false, state: false },
  "ai-sdk": { stream: true, map: false, state: false },
  litellm: { stream: true, map: false, state: false },
  langchain: { stream: true, map: true, state: true },
  langgraph: { stream: true, map: true, state: true },
  "openai-agents": { stream: true, map: true, state: true },
  mastra: { stream: true, map: true, state: true },
  "pydantic-ai": { stream: true, map: true, state: true },
};

const NAMED = (...names) => (framework) => names.includes(framework);
export const REQUIRED_KINDS = {
  "tool-loop": () => true,
  streaming: (framework) => FRAMEWORK_TRAITS[framework].stream,
  "stream-escape": NAMED("openai-agents"),
  handoff: NAMED("openai", "anthropic", "ai-sdk", "langchain", "langgraph", "openai-agents", "mastra", "pydantic-ai"),
  "node-map": NAMED("langchain", "langgraph", "openai-agents", "mastra", "pydantic-ai"),
  passthrough: () => true,
  interrupted: NAMED("langchain", "langgraph", "pydantic-ai", "openai-agents", "mastra"),
  model: () => true,
  "late-tag": NAMED("langchain", "langgraph", "openai-agents", "pydantic-ai", "mastra", "ai-sdk"),
  "slot-typo": (framework) => FRAMEWORK_TRAITS[framework].map,
  "canary-checkpoint": (framework) => FRAMEWORK_TRAITS[framework].state,
  settings: () => true,
};

const every = (framework, reason) => Object.fromEntries(Object.keys(REQUIRED_KINDS).filter((kind) => REQUIRED_KINDS[kind](framework)).map((kind) => [kind, reason]));

/**
 * The kinds a framework is excused from, per `<framework>/<language>`, each with the ticket that lifts it. Code, not
 * data, so an exemption is reviewed like code; `test/frameworks.test.mjs` pins the set, every reason names a ticket,
 * and an exemption for a kind that has a fixture fails as stale.
 */
export const EXEMPTIONS = {
  // S0's middleware: AIR-2234 moves it onto the adapter contract and adds every kind but its tool loop.
  "langchain/ts": Object.fromEntries(Object.entries(every("langchain", "AIR-2234: S0's middleware moves onto the contract there")).filter(([kind]) => kind !== "tool-loop")),
  // AIR-2233 part 2 adds these fixtures with their drivers, and deletes these lines.
  "openai/ts": every("openai", "AIR-2233 part 2"),
  "anthropic/ts": every("anthropic", "AIR-2233 part 2"),
  "ai-sdk/ts": every("ai-sdk", "AIR-2233 part 2"),
  "openai/py": every("openai", "AIR-2233 part 2"),
  "anthropic/py": every("anthropic", "AIR-2233 part 2"),
  // The ticket's own ruling stays after part 2: LiteLLM owes no streaming until a customer needs it.
  "litellm/py": { ...every("litellm", "AIR-2233 part 2"), streaming: "AIR-2233: exempt until a customer needs it, by the ticket's ruling" },
};

/**
 * The framework adapters each SDK ships: a module in `frameworks/` that is not the contract (and not `steps`, the
 * no-code core, held to its own drivers in part 3, nor a `_`-named shared helper). Each owes its kinds whether or not
 * a fixture folder exists.
 */
export function shippedAdapters(root = repo) {
  const out = [];
  const ts = join(root, "sdk-typescript", "packages", "sdk", "src", "frameworks");
  const py = join(root, "sdk-python", "packages", "agent", "src", "airprompter_agent", "frameworks");
  if (existsSync(ts)) for (const file of readdirSync(ts)) if (file.endsWith(".ts") && file !== "contract.ts" && !file.startsWith("_")) out.push({ framework: file.slice(0, -3), language: "ts" });
  if (existsSync(py)) for (const file of readdirSync(py)) if (file.endsWith(".py") && !["__init__.py", "contract.py"].includes(file) && !file.startsWith("_")) out.push({ framework: file.slice(0, -3).replaceAll("_", "-"), language: "py" });
  return out;
}

/** Every fixture file under fixtures/, parsed, with its folder; a file that is not JSON is reported, not thrown. */
export function loadFixtures(dir = FIXTURES_DIR) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const framework of readdirSync(dir).sort()) {
    const folder = join(dir, framework);
    if (!statSync(folder).isDirectory()) continue;
    for (const file of readdirSync(folder).sort()) {
      if (!file.endsWith(".json")) continue;
      const path = join(folder, file);
      let fixture = null;
      let error = null;
      try {
        fixture = readJson(path);
      } catch (e) {
        error = `not JSON: ${e.message}`;
      }
      // Posix in labels, whatever the host: a label is a name, not a path.
      out.push({ folder: framework, file: relative(dir, path).split(sep).join("/"), name: file, path, fixture, error });
    }
  }
  return out;
}

/**
 * The kinds each (framework, language) owes and lacks: `[{ framework, language, kind, detail? }]`. A pair owes when
 * it has a fixture or the SDK ships its adapter. A fixture's `kind` counts for the folder it sits in and the language
 * it names. An exemption needs a ticket, and one for a kind that has a fixture is stale.
 */
export function coverageGaps(fixtures, { language = null, adapters = shippedAdapters(), exemptions = EXEMPTIONS } = {}) {
  const gaps = [];
  const present = new Map();
  const owe = (framework, lang) => {
    if (language && lang !== language) return;
    const key = `${framework}/${lang}`;
    if (!present.has(key)) present.set(key, new Set());
  };
  for (const { framework, language: lang } of adapters) owe(framework, lang);
  for (const { folder, fixture } of fixtures) {
    if (!fixture || typeof fixture.language !== "string") continue;
    owe(folder, fixture.language);
    present.get(`${folder}/${fixture.language}`)?.add(fixture.kind);
  }
  for (const [key, kinds] of [...present].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [framework, lang] = key.split("/");
    if (!FRAMEWORK_TRAITS[framework]) {
      gaps.push({ framework, language: lang, kind: null, detail: `no traits for ${framework}: add it to FRAMEWORK_TRAITS in run.mjs` });
      continue;
    }
    const exempt = exemptions[key] ?? {};
    for (const [kind, reason] of Object.entries(exempt)) {
      if (!/\bAIR-\d+\b/.test(reason ?? "")) gaps.push({ framework, language: lang, kind, detail: `the exemption for ${kind} names no ticket` });
      else if (kinds.has(kind)) gaps.push({ framework, language: lang, kind, detail: `stale exemption: ${kind} has a fixture; delete it from EXEMPTIONS` });
    }
    for (const [kind, required] of Object.entries(REQUIRED_KINDS)) {
      if (!required(framework) || kinds.has(kind)) continue;
      if (/\bAIR-\d+\b/.test(exempt[kind] ?? "")) continue;
      gaps.push({ framework, language: lang, kind });
    }
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// Matching: rows and placements match on the fields named, deeply, so a new
// row field does not break every fixture.

/** True when every field `expected` names is equal in `actual`, objects compared the same way; arrays compare whole. A `null` expects null or absent. */
export function subsetMatches(actual, expected) {
  if (expected === null) return actual === null || actual === undefined;
  if (typeof expected !== "object") return Object.is(actual, expected) || actual === expected;
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, i) => subsetMatches(actual[i], item));
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) => subsetMatches(actual[key], value));
}

/** Every actual row taken by exactly one expected row (a bipartite match, so order never decides); the first mismatch as text, else true. */
export function matchRowSet(actual, expected, label = "row") {
  const owner = new Array(actual.length).fill(-1);
  const fits = expected.map((want) => actual.map((row) => subsetMatches(row, want)));
  const assign = (e, seen) => {
    for (let a = 0; a < actual.length; a += 1) {
      if (!fits[e][a] || seen[a]) continue;
      seen[a] = true;
      if (owner[a] === -1 || assign(owner[a], seen)) {
        owner[a] = e;
        return true;
      }
    }
    return false;
  };
  for (let e = 0; e < expected.length; e += 1) {
    if (!assign(e, new Array(actual.length).fill(false))) {
      const want = expected[e];
      return `${label} ${e} ${short(want)} matches none of ${short(actual.filter((_, a) => owner[a] === -1).map((row) => pick(row, Object.keys(want))))}`;
    }
  }
  const left = actual.filter((_, a) => owner[a] === -1);
  return left.length === 0 ? true : `${left.length} ${label}${left.length === 1 ? "" : "s"} not expected: ${short(left)}`;
}

const pick = (row, keys) => Object.fromEntries(keys.filter((k) => row && k in row).map((k) => [k, row[k]]));
export const stable = (value) => (Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])])) : value);
export const sameJson = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
export function short(value) {
  const text = JSON.stringify(value);
  return text && text.length > 240 ? `${text.slice(0, 237)}…` : text;
}

// ---------------------------------------------------------------------------
// The registry.

const operationsDir = join(here, "operations");
const registered = [];
for (const file of readdirSync(operationsDir).filter((f) => f.endsWith(".mjs")).sort()) {
  const spec = (await import(pathToFileURL(join(operationsDir, file)).href)).default;
  if (!spec || typeof spec.section !== "string" || !Array.isArray(spec.operations) || typeof spec.run !== "function") throw new Error(`operations/${file}: export default { section, operations, run }`);
  registered.push(spec);
}

/** The adapter operations these sections call, in registry order. */
export const OPERATIONS = [...new Set(registered.flatMap((spec) => spec.operations))];
/** Section → the operations it needs, as harness.mjs's SECTIONS. */
export const SECTIONS = Object.fromEntries(registered.map((spec) => [spec.section, spec.operations]));
/** Operations whose call may take longer than a protocol vector: a real framework, a whole scenario. */
export const SLOW_OPERATIONS = new Set(registered.flatMap((spec) => spec.slow ?? []));

/**
 * Run one registered section; `ctx` is the harness's: `{ adapter, ok, fail, report, options }`. `options.fixturesDir`,
 * `options.vectorsDir`, `options.adapters` and `options.exemptions` point a test at its own tree.
 */
export async function runSection(name, ctx) {
  const spec = registered.find((s) => s.section === name);
  if (!spec) throw new Error(`no framework section ${name}`);
  const options = ctx.options ?? {};
  const fixturesDir = options.fixturesDir ?? FIXTURES_DIR;
  await spec.run({
    ...ctx,
    options,
    helpers: {
      schemaErrors,
      loadFixtures: () => loadFixtures(fixturesDir),
      coverageGaps: (fixtures, opts = {}) => coverageGaps(fixtures, { ...opts, ...(options.adapters ? { adapters: options.adapters } : {}), ...(options.exemptions ? { exemptions: options.exemptions } : {}) }),
      subsetMatches, matchRowSet, sameJson, short, readJson,
      EXEMPTIONS: options.exemptions ?? EXEMPTIONS,
      FIXTURES_DIR: fixturesDir,
      VECTORS_DIR: options.vectorsDir ?? VECTORS_DIR,
    },
  });
}
