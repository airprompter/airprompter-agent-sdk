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

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "..");
const sdkSrc = join(root, "packages", "sdk", "src");
const LAYER = { core: 0, sync: 1, runtime: 1, telemetry: 1, agent: 2, frameworks: 2, steps: 3 };
/** A layer's one barrel, relative to packages/sdk/src without the extension. */
const barrelOf = (layer) => (layer === "agent" ? "index" : layer === "steps" ? "frameworks/steps/index" : `${layer}/index`);
const STEPS_SPEC = "@airprompter/agent-sdk/frameworks/steps";
const SATELLITES = ["agent-otel", "datastore-s3", "datastore-postgres", "datastore-redis"];
const SUBPATH = /^@airprompter\/agent-sdk\/(core|sync|runtime|telemetry)$/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

const SPECIFIER = /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"\s*\)/g;

function specifiersOf(file) {
  const text = readFileSync(file, "utf8");
  const out = [];
  for (const m of text.matchAll(SPECIFIER)) {
    const spec = m[1] ?? m[2];
    const line = text.slice(0, m.index).split("\n").length;
    out.push({ spec, line: line + (m[0].startsWith("\n") ? 1 : 0) });
  }
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

function lintSdkFile(file) {
  const shown = relative(root, file);
  const layer = layerOf(file);
  if (!(layer in LAYER)) {
    offenders.push(`${shown}: packages/sdk/src/${layer} is not a layer; add it to LAYER or move the file`);
    return;
  }
  for (const { spec, line } of specifiersOf(file)) {
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
