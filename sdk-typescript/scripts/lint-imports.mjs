#!/usr/bin/env node
// The layer direction inside the one package, and the rule for what sits beside it.
//
//   layer 0  sdk/src/core                  imports nothing of ours
//   layer 1  sdk/src/sync, runtime,        import core only, never each other
//            telemetry
//   layer 2  sdk/src/*.ts (the agent),     import the layers below, never each other
//            sdk/src/frameworks
//   layer 3  sdk/src/frameworks/steps      the no-code automation core: drives the
//                                          agent (through the root barrel), core, sync
//   beside   agent-otel, datastore-*       import `@airprompter/agent-sdk/<layer>`
//   platform integrations/*                import the SDK only as
//                                          `@airprompter/agent-sdk/frameworks/steps`
//                                          (Decision L, AIR-2231/AIR-2405); tests exempt
//   binary   cli/src                       imports any source, by path
//
// Framework adapters (AIR-2231, the rules of section 3.2):
//
//   1. An adapter, `frameworks/<name>.ts` or a folder `frameworks/<name>/`,
//      imports only the contract (`./contract.js`, `../contract.js` from a
//      folder), its own folder's files, and the packages in its ADAPTERS entry
//      below. `frameworks/contract.ts` imports the runtime and core barrels and
//      the adapters' internal barrel `runtime/adapter/index.js` (which nothing
//      else may import), and no package. A framework with no entry fails.
//      `langchain` is exempt from the contract-only rule until AIR-2234 moves
//      it onto the contract; `steps/` is its own layer.
//   2. core, sync, runtime, telemetry and the agent import no framework
//      package (FRAMEWORK_PACKAGES).
//   3. `runtime/run/` imports neither telemetry nor sync: held by the layer
//      rule, since runtime may import neither.
//
// A file reaches another layer only through that layer's barrel
// (`../core/index.js`; the agent's is the root `index.js`, Steps' is
// `frameworks/steps/index.js`), never a deeper path, so what a layer exports
// is what another layer can depend on. The one other barrel is
// `core/testing/index.js`, and only the `./testing` entry may use it. The binary and the tests import
// sources by path on purpose (they bundle and they test internals); only the
// binary's edges are recorded.
//
// Exit 1 with every offending line; `--json` prints the edges instead.
//
//   $ node scripts/lint-imports.mjs             # from sdk-typescript/

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "..");
const sdkSrc = join(root, "packages", "sdk", "src");
const LAYER = { core: 0, sync: 1, runtime: 1, telemetry: 1, agent: 2, frameworks: 2, steps: 3 };
/** A layer's one barrel, relative to packages/sdk/src without the extension. */
const barrelOf = (layer) => (layer === "agent" ? "index" : layer === "steps" ? "frameworks/steps/index" : `${layer}/index`);
const STEPS_SPEC = "@airprompter/agent-sdk/frameworks/steps";
const SATELLITES = ["agent-otel", "datastore-s3", "datastore-postgres", "datastore-redis"];
const SUBPATH = /^@airprompter\/agent-sdk\/(core|sync|runtime|telemetry)$/;
/** Rule 1: each adapter's own packages. An adapter ticket adds its entry; `*` matches one scoped name. */
const ADAPTERS = {
  openai: ["openai"],
  anthropic: ["@anthropic-ai/sdk"],
  "ai-sdk": ["ai", "@ai-sdk/*"],
  langchain: ["langchain", "langchain/*", "@langchain/*", "zod"],
};
/** Not on the contract yet (AIR-2234): may still reach the runtime and core barrels. */
const CONTRACT_EXEMPT = new Set(["langchain"]);
/** Rule 2: no layer below the adapters imports any of these. */
const FRAMEWORK_PACKAGES = ["openai", "openai/*", "@anthropic-ai/*", "ai", "ai/*", "@ai-sdk/*", "langchain", "langchain/*", "@langchain/*", "@openai/agents", "@openai/agents*", "@mastra/*"];
const matches = (spec, pattern) => {
  if (pattern.endsWith("/*")) return spec.startsWith(pattern.slice(0, -1));
  if (pattern.endsWith("*")) return spec.startsWith(pattern.slice(0, -1));
  return spec === pattern;
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/**
 * Every module a file names, with its line, read from the TypeScript AST rather than by pattern, so no quoting or
 * layout gets past it: `import … from`, a bare `import "x"`, `export … from`, `import x = require("x")`, `require("x")`
 * and `import("x")`. A dynamic `import()` or `require()` whose argument is not a string literal is itself an offence:
 * what it loads cannot be checked.
 */
const parsed = new Map();
function specifiersOf(file) {
  if (!parsed.has(file)) parsed.set(file, parse(file));
  return parsed.get(file);
}

function parse(file) {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const out = [];
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const literal = (node) => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null);
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const spec = literal(node.moduleSpecifier);
      if (spec !== null) out.push({ spec, line: lineOf(node) });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      // `import("../x.js").T` in a type position: types only, but past the barrel all the same.
      const spec = literal(node.argument.literal);
      if (spec !== null) out.push({ spec, line: lineOf(node) });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const spec = literal(node.moduleReference.expression);
      if (spec !== null) out.push({ spec, line: lineOf(node) });
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const spec = literal(node.arguments[0]);
      if (spec !== null) out.push({ spec, line: lineOf(node) });
      else offenders.push(`${relative(root, file)}:${lineOf(node)}: a dynamic import of a computed specifier cannot be checked; name the module`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

const posix = (path) => path.split(sep).join("/");

/** The layer a path under `packages/sdk/src` belongs to; a file directly under `src` is the agent. */
function layerOf(path) {
  const rel = posix(relative(sdkSrc, path));
  if (rel.startsWith("frameworks/steps/")) return "steps";
  const slash = rel.indexOf("/");
  return slash === -1 ? "agent" : rel.slice(0, slash);
}

const insideSdk = (path) => !posix(relative(sdkSrc, path)).startsWith("..");

const offenders = [];
const edges = [];

/** `frameworks/<name>.ts` or `frameworks/<name>/…` → name; the Steps folder is its own layer. */
function adapterOf(file) {
  const rel = posix(relative(sdkSrc, file));
  const m = /^frameworks\/([^/]+?)(\.ts$|\/)/.exec(rel);
  return m && m[1] !== "steps" ? m[1] : null;
}
/** The adapters' internal barrel: `frameworks/contract.ts` alone imports it. */
const ADAPTER_BARREL = "runtime/adapter/index";

function lintAdapter(file, name) {
  const shown = relative(root, file);
  if (name === "contract") {
    for (const { spec, line } of specifiersOf(file)) {
      const target = spec.startsWith(".") ? posix(relative(sdkSrc, resolve(dirname(file), spec))).replace(/\.(js|ts)$/, "") : null;
      if (target !== "runtime/index" && target !== "core/index" && target !== ADAPTER_BARREL) offenders.push(`${shown}:${line}: frameworks/contract imports only the runtime, core and runtime/adapter barrels (${spec})`);
    }
    return true;
  }
  const allowed = ADAPTERS[name];
  if (!allowed) {
    offenders.push(`${shown}: frameworks/${name}.ts has no entry in ADAPTERS (scripts/lint-imports.mjs) or in tools/lint_imports.py; see CONTRIBUTING.md › Adding a framework adapter`);
    return false;
  }
  if (CONTRACT_EXEMPT.has(name)) return false;
  const home = join(sdkSrc, "frameworks", name);
  for (const { spec, line } of specifiersOf(file)) {
    if (spec.startsWith(".")) {
      const target = resolve(dirname(file), spec).replace(/\.(js|ts)$/, "");
      const contract = target === join(sdkSrc, "frameworks", "contract");
      const ownFolder = !posix(relative(home, target)).startsWith("..");
      if (!contract && !ownFolder) offenders.push(`${shown}:${line}: an adapter imports only the contract, its own folder and its framework, not ${spec}`);
      continue;
    }
    if (!allowed.some((pattern) => matches(spec, pattern))) offenders.push(`${shown}:${line}: ${spec} is not in frameworks/${name}'s allowlist (${allowed.join(", ")})`);
  }
  return true;
}

function lintSdkFile(file) {
  const shown = relative(root, file);
  const layer = layerOf(file);
  if (!(layer in LAYER)) {
    offenders.push(`${shown}: packages/sdk/src/${layer} is not a layer; add it to LAYER or move the file`);
    return;
  }
  const adapter = adapterOf(file);
  if (adapter && lintAdapter(file, adapter)) {
    for (const { spec } of specifiersOf(file)) if (spec.startsWith(".")) {
      const into = layerOf(resolve(dirname(file), spec));
      if (into !== layer) edges.push([layer, into]);
    }
    return;
  }
  for (const { spec, line } of specifiersOf(file)) {
    if (!spec.startsWith(".") && layer !== "frameworks" && layer !== "steps" && FRAMEWORK_PACKAGES.some((pattern) => matches(spec, pattern))) {
      offenders.push(`${shown}:${line}: ${layer} imports the framework package ${spec}; only frameworks/<name> may`);
      continue;
    }
    if (spec.startsWith("@airprompter/")) {
      offenders.push(`${shown}:${line}: the package imports ${spec} by name; use a relative path through the layer's barrel`);
      continue;
    }
    if (!spec.startsWith(".")) continue;
    const target = resolve(dirname(file), spec);
    if (!insideSdk(target)) {
      offenders.push(`${shown}:${line}: ${spec} leaves packages/sdk/src`);
      continue;
    }
    const into = layerOf(target);
    if (into === layer) continue;
    edges.push([layer, into]);
    const rel = posix(relative(sdkSrc, target)).replace(/\.(js|ts)$/, "");
    const barrel = rel === barrelOf(into) || (rel === "core/testing/index" && posix(relative(sdkSrc, file)) === "testing.ts");
    if (rel === ADAPTER_BARREL && into !== layer) {
      offenders.push(`${shown}:${line}: runtime/adapter is the adapters' internal barrel; only frameworks/contract.ts imports it`);
      continue;
    }
    if (!barrel) {
      offenders.push(`${shown}:${line}: reaches into ${into} by path (${spec}); import ${into}'s barrel`);
      continue;
    }
    if (!(into in LAYER)) {
      offenders.push(`${shown}:${line}: ${spec} is not a layer`);
      continue;
    }
    if (LAYER[into] >= LAYER[layer]) {
      offenders.push(`${shown}:${line}: ${layer} (layer ${LAYER[layer]}) may not import ${into} (layer ${LAYER[into]}); the direction is core → sync, runtime, telemetry → agent, frameworks → steps`);
    }
  }
}

function lintSatellite(name) {
  const src = join(root, "packages", name, "src");
  for (const file of walk(src)) {
    const shown = relative(root, file);
    for (const { spec, line } of specifiersOf(file)) {
      if (spec.startsWith(".")) {
        if (posix(relative(src, resolve(dirname(file), spec))).startsWith("..")) offenders.push(`${shown}:${line}: ${spec} leaves ${name}`);
        continue;
      }
      if (!spec.startsWith("@airprompter/")) continue;
      const subpath = SUBPATH.exec(spec);
      if (!subpath) {
        offenders.push(`${shown}:${line}: ${spec}: a satellite imports only @airprompter/agent-sdk/{core,sync,runtime,telemetry}`);
        continue;
      }
      edges.push([name, subpath[1]]);
    }
  }
}

for (const file of walk(sdkSrc)) lintSdkFile(file);
for (const name of SATELLITES) lintSatellite(name);

// The platforms: every non-test source of integrations/<name> imports the SDK only through the Steps subpath, and
// never reaches outside its own folder by path (the SDK's sources included). Their own platform packages are theirs.
const integrations = resolve(root, "..", "integrations");
const SKIP = new Set(["node_modules", "dist", "test"]);
function walkIntegration(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walkIntegration(path, out);
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) out.push(path);
  }
  return out;
}
try {
  for (const name of readdirSync(integrations).sort()) {
    const home = join(integrations, name);
    if (!statSync(home).isDirectory()) continue;
    for (const file of walkIntegration(home)) {
      const shown = relative(resolve(root, ".."), file);
      for (const { spec, line } of specifiersOf(file)) {
        if (spec.startsWith(".")) {
          if (posix(relative(home, resolve(dirname(file), spec))).startsWith("..")) offenders.push(`${shown}:${line}: ${spec} leaves integrations/${name}; the SDK is reached as ${STEPS_SPEC}`);
          continue;
        }
        if (!spec.startsWith("@airprompter/")) continue;
        if (spec !== STEPS_SPEC) {
          offenders.push(`${shown}:${line}: ${spec}: an integration imports the SDK only as ${STEPS_SPEC}`);
          continue;
        }
        edges.push([name, "steps"]);
      }
    }
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

// The binary: cli/src imports sources by path (it bundles them); every layer is below it.
const cliSrc = resolve(root, "..", "cli", "src");
try {
  for (const file of walk(cliSrc)) {
    const shown = relative(resolve(root, ".."), file);
    for (const { spec, line } of specifiersOf(file)) {
      if (spec.startsWith("@airprompter/")) {
        offenders.push(`${shown}:${line}: the binary bundles sources by path; ${spec} would resolve at run time`);
        continue;
      }
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec);
      if (insideSdk(target)) {
        edges.push(["cli", layerOf(target)]);
        continue;
      }
      const satellite = /^packages\/([a-z0-9-]+)\/src\//.exec(posix(relative(root, target)));
      if (satellite) edges.push(["cli", satellite[1]]);
    }
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

if (process.argv.includes("--json")) {
  const unique = [...new Set(edges.map((e) => e.join("→")))].sort();
  console.log(JSON.stringify({ layers: LAYER, satellites: SATELLITES, edges: unique }, null, 2));
}
if (offenders.length) {
  console.error("lint-imports: the direction is core → sync, runtime, telemetry → agent, frameworks → steps → integrations, and the binary; these lines break it:");
  for (const line of offenders) console.error("  " + line);
  process.exit(1);
}
console.log(`lint-imports: ok (${edges.length} imports between layers, all downward and through barrels)`);
