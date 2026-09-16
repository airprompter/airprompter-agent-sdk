#!/usr/bin/env node
// One version across the five packages, siblings exact-pinned to it (S10).
//   node scripts/version-lockstep.mjs             check
//   node scripts/version-lockstep.mjs --expect V  check, and V must be the version
//   node scripts/version-lockstep.mjs --set V     rewrite every package.json (and the workspace root) to V

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PACKAGES = ["core", "sync", "runtime", "telemetry", "otel-bridge", "sdk"];
const args = process.argv.slice(2);
const set = args.includes("--set") ? args[args.indexOf("--set") + 1] : null;
const expect = args.includes("--expect") ? args[args.indexOf("--expect") + 1] : null;

const manifestPath = (name) => join(root, "packages", name, "package.json");
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");

if (set) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(set)) throw new Error(`not a version: ${set}`);
  for (const name of PACKAGES) {
    const manifest = read(manifestPath(name));
    manifest.version = set;
    for (const dep of Object.keys(manifest.dependencies ?? {})) if (dep.startsWith("@airprompter/")) manifest.dependencies[dep] = set;
    write(manifestPath(name), manifest);
  }
  const workspace = read(join(root, "package.json"));
  workspace.version = set;
  write(join(root, "package.json"), workspace);
  // The constant the SDK reports on the heartbeat, pinned to core's package.json by packageSplit.test.ts.
  const versionTs = join(root, "packages", "core", "src", "protocol", "version.ts");
  writeFileSync(versionTs, readFileSync(versionTs, "utf8").replace(/export const SDK_VERSION = "[^"]+";/, `export const SDK_VERSION = "${set}";`));
  console.log(`version-lockstep: every package is ${set}`);
}

const problems = [];
const versions = new Map();
for (const name of PACKAGES) {
  const manifest = read(manifestPath(name));
  versions.set(name, manifest.version);
  for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
    if (!dep.startsWith("@airprompter/")) continue;
    if (range !== manifest.version) problems.push(`${name} pins ${dep}@${range}; the lockstep version is ${manifest.version}`);
  }
}
const distinct = new Set(versions.values());
if (distinct.size !== 1) problems.push(`versions differ: ${[...versions].map(([n, v]) => `${n}=${v}`).join(", ")}`);
const version = [...distinct][0];
if (expect && version !== expect) problems.push(`the tag says ${expect}; the packages say ${version}`);
if (problems.length) {
  for (const line of problems) console.error(`version-lockstep: ${line}`);
  process.exit(1);
}
console.log(`version-lockstep: ok (${version})`);
