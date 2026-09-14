#!/usr/bin/env node
// The package direction (S10): core → clients → sdk → binary.
//
//   layer 0  @airprompter/agent-core        imports nothing of ours
//   layer 1  agent-sync, agent-runtime,     import core only — never each other
//            agent-telemetry
//   layer 2  @airprompter/agent-sdk         imports core and the clients
//   layer 3  cli/src (the binary)           imports any package
//
// A package reaches a sibling only through the sibling's barrel
// (`@airprompter/agent-<name>` or `@airprompter/agent-core/testing`), never by
// a relative path into its src — so what a package exports is what a package
// can depend on. The binary and the tests import sources by path on purpose
// (they bundle and they test internals); their direction is still checked.
//
// Exit 1 with every offending line; `--json` prints the edges instead.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "..");
const LAYER = { core: 0, sync: 1, runtime: 1, telemetry: 1, "otel-bridge": 1, sdk: 2 };
const PACKAGES = Object.keys(LAYER);

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

/** Which of our packages a specifier names, and how. */
function targetOf(spec, fromFile) {
  const barrel = /^@airprompter\/agent-([a-z]+)(\/testing)?$/.exec(spec);
  if (barrel) return { pkg: barrel[1], via: "barrel" };
  if (spec === "@airprompter/otel-bridge") return { pkg: "otel-bridge", via: "barrel" };
  if (spec.startsWith("@airprompter/")) return { pkg: null, via: "unknown-barrel" };
  if (spec.startsWith(".")) {
    const abs = resolve(fromFile, "..", spec);
    const rel = relative(root, abs).split(sep).join("/");
    const m = /^packages\/([a-z-]+)\/src\//.exec(rel);
    if (m) return { pkg: m[1], via: "relative" };
    return { pkg: null, via: "outside" };
  }
  return { pkg: null, via: "external" };
}

const offenders = [];
const edges = [];

for (const pkg of PACKAGES) {
  for (const file of walk(join(root, "packages", pkg, "src"))) {
    const shown = relative(root, file);
    for (const { spec, line } of specifiersOf(file)) {
      const target = targetOf(spec, file);
      if (target.via === "external") continue;
      if (target.via === "unknown-barrel") {
        offenders.push(`${shown}:${line}: ${spec} is not one of our packages`);
        continue;
      }
      if (target.via === "outside") {
        offenders.push(`${shown}:${line}: ${spec} leaves the packages tree`);
        continue;
      }
      if (target.pkg === pkg) {
        if (target.via === "barrel") offenders.push(`${shown}:${line}: a package imports itself through its own barrel (${spec}); use a relative path`);
        continue;
      }
      edges.push([pkg, target.pkg]);
      if (target.via === "relative") {
        offenders.push(`${shown}:${line}: reaches into ${target.pkg} by path (${spec}); import ${target.pkg === "otel-bridge" ? "@airprompter/otel-bridge" : `@airprompter/agent-${target.pkg}`}`);
        continue;
      }
      if (!(target.pkg in LAYER)) {
        offenders.push(`${shown}:${line}: ${spec} is not a package`);
        continue;
      }
      if (LAYER[target.pkg] >= LAYER[pkg]) {
        offenders.push(`${shown}:${line}: ${pkg} (layer ${LAYER[pkg]}) may not import ${target.pkg} (layer ${LAYER[target.pkg]}) — the direction is core → clients → sdk`);
      }
    }
  }
}

// The binary: cli/src imports the packages by path (it bundles them); any package is below it.
const cliSrc = resolve(root, "..", "cli", "src");
try {
  for (const file of walk(cliSrc)) {
    const shown = relative(resolve(root, ".."), file);
    for (const { spec, line } of specifiersOf(file)) {
      const target = targetOf(spec, file);
      if (target.via === "barrel") offenders.push(`${shown}:${line}: the binary bundles sources by path; ${spec} would resolve at run time`);
      if (target.pkg) edges.push(["cli", target.pkg]);
    }
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

if (process.argv.includes("--json")) {
  const unique = [...new Set(edges.map((e) => e.join("→")))].sort();
  console.log(JSON.stringify({ layers: LAYER, edges: unique }, null, 2));
}
if (offenders.length) {
  console.error("lint-imports: the package direction is core → clients → sdk → binary; these lines break it:");
  for (const line of offenders) console.error("  " + line);
  process.exit(1);
}
console.log(`lint-imports: ok (${edges.length} cross-package imports, all downward and through barrels)`);
