#!/usr/bin/env node
// One version across the packages, `@airprompter/*` peers exact-pinned to it.
// A tag may name a prerelease in the PEP 440 form the Python packages use
// (`1.0.0rc0`); it equals the npm form (`1.0.0-rc.0`).
//
//   node scripts/version-lockstep.mjs             check
//   node scripts/version-lockstep.mjs --expect V  check, and V must be the version
//   node scripts/version-lockstep.mjs --set V     rewrite every package.json (and the workspace root) to V

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeVersions } from "./build.mjs";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PACKAGES = ["sdk", "agent-otel", "datastore-s3", "datastore-postgres", "datastore-redis"];
const PINNED_FIELDS = ["dependencies", "peerDependencies", "devDependencies"];
const args = process.argv.slice(2);
const set = args.includes("--set") ? args[args.indexOf("--set") + 1] : null;
const expect = args.includes("--expect") ? args[args.indexOf("--expect") + 1] : null;

const manifestPath = (name) => join(root, "packages", name, "package.json");
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");

/** `1.0.0rc0` as npm writes it, `1.0.0-rc.0`; anything else unchanged. */
const npmForm = (version) => version.replace(/^(\d+\.\d+\.\d+)(a|b|rc)(\d+)$/, (_, base, label, n) => `${base}-${{ a: "alpha", b: "beta", rc: "rc" }[label]}.${n}`);

if (set) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(set)) throw new Error(`not a version: ${set}`);
  for (const name of PACKAGES) {
    const manifest = read(manifestPath(name));
    manifest.version = set;
    for (const field of PINNED_FIELDS) for (const dep of Object.keys(manifest[field] ?? {})) if (dep.startsWith("@airprompter/")) manifest[field][dep] = set;
    write(manifestPath(name), manifest);
  }
  const workspace = read(join(root, "package.json"));
  workspace.version = set;
  write(join(root, "package.json"), workspace);
  writeVersions();
  console.log(`version-lockstep: every package is ${set}`);
}

const problems = [];
const versions = new Map();
for (const name of PACKAGES) {
  const manifest = read(manifestPath(name));
  versions.set(name, manifest.version);
  for (const field of PINNED_FIELDS) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
      if (!dep.startsWith("@airprompter/")) continue;
      if (range !== manifest.version) problems.push(`${name} pins ${dep}@${range} in ${field}; the lockstep version is ${manifest.version}`);
    }
  }
}
const distinct = new Set(versions.values());
if (distinct.size !== 1) problems.push(`versions differ: ${[...versions].map(([n, v]) => `${n}=${v}`).join(", ")}`);
const version = [...distinct][0];
if (expect && version !== npmForm(expect)) problems.push(`the tag says ${expect}; the packages say ${version}`);
if (problems.length) {
  for (const line of problems) console.error(`version-lockstep: ${line}`);
  process.exit(1);
}
console.log(`version-lockstep: ok (${version})`);
