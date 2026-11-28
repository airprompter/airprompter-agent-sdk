#!/usr/bin/env node
// One version across the packages. A satellite peers on the SDK exactly while
// the version is a release candidate, and with a caret from a final version on
// (`^1.0.0`), so a 1.1.0 SDK installs beside a 1.0.0 datastore; devDependencies
// stay exact (the workspace link). `--set` also moves the version in the READMEs
// that name it (the repository's, the SDK's, each package's npm page) and, from a
// final version on, drops what sits between `<!-- release-candidate -->` and
// `<!-- /release-candidate -->`: advice that only holds for a candidate.
// The runnable examples (`../examples/*/package.json`) pin the SDK exactly too, and
// `--set` moves them with the packages, so an example never names a version
// this commit is not.
// A tag may name a prerelease in the PEP 440 form the Python packages use
// (`1.0.0rc0`); it equals the npm form (`1.0.0-rc.0`).
//
//   node scripts/version-lockstep.mjs             check
//   node scripts/version-lockstep.mjs --expect V  check, and V must be the version
//   node scripts/version-lockstep.mjs --set V     rewrite every package.json (and the workspace root) to V

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
const examples = join(root, "..", "examples");
const EXAMPLES = existsSync(examples) ? readdirSync(examples).map((name) => join(examples, name, "package.json")).filter(existsSync) : [];
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
/** The READMEs whose install lines and status name the version. */
export const DOCS = [join(root, "..", "README.md"), join(root, "README.md"), ...PACKAGES.map((name) => join(root, "packages", name, "README.md"))];
export const RC_BLOCK = /<!-- release-candidate -->[\s\S]*?<!-- \/release-candidate -->\n?/g;
const isPrerelease = (version) => version.includes("-");
/** `version` as a whole token: never inside `1.0.10`, `11.0.0` or `1.0.0-rc.5`. */
export const versionToken = (version) => new RegExp(`(?<![\\w.-])${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-]|\\.\\d)`, "g");
/** What an `@airprompter/*` entry in `field` says for `version`. */
export const rangeFor = (field, version) => (field === "peerDependencies" && !isPrerelease(version) ? `^${version}` : version);
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");

/** `1.0.0rc0` as npm writes it, `1.0.0-rc.0`; anything else unchanged. */
const npmForm = (version) => version.replace(/^(\d+\.\d+\.\d+)(a|b|rc)(\d+)$/, (_, base, label, n) => `${base}-${{ a: "alpha", b: "beta", rc: "rc" }[label]}.${n}`);

if (set) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(set)) throw new Error(`not a version: ${set}`);
  for (const name of PACKAGES) {
    const manifest = read(manifestPath(name));
    manifest.version = set;
    for (const field of PINNED_FIELDS) for (const dep of Object.keys(manifest[field] ?? {})) if (dep.startsWith("@airprompter/")) manifest[field][dep] = rangeFor(field, set);
    write(manifestPath(name), manifest);
  }
  const previous = read(join(root, "package.json")).version;
  // The CLI is tied to the SDK on every candidate: a candidate --set moves it, and so does the first final version
  // after a candidate it matched. After that it is released on its own.
  const cliPath = join(root, "..", "cli", "package.json");
  if (existsSync(cliPath) && (isPrerelease(set) || (isPrerelease(previous) && read(cliPath).version === previous))) {
    write(cliPath, { ...read(cliPath), version: set });
    // Its lockfile names the root package's version twice; npm ci ignores both, but a stale one misleads.
    const lockPath = join(root, "..", "cli", "package-lock.json");
    if (existsSync(lockPath)) {
      const lock = read(lockPath);
      lock.version = set;
      if (lock.packages?.[""]) lock.packages[""].version = set;
      write(lockPath, lock);
    }
  }
  for (const path of DOCS) {
    let text = readFileSync(path, "utf8").replace(versionToken(previous), set);
    if (!isPrerelease(set)) text = text.replace(RC_BLOCK, "");
    writeFileSync(path, text);
  }
  for (const path of EXAMPLES) {
    const manifest = read(path);
    for (const field of PINNED_FIELDS) for (const dep of Object.keys(manifest[field] ?? {})) if (dep.startsWith("@airprompter/")) manifest[field][dep] = set;
    write(path, manifest);
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
      if (range !== rangeFor(field, manifest.version)) problems.push(`${name} pins ${dep}@${range} in ${field}; for ${manifest.version} it is ${rangeFor(field, manifest.version)}`);
    }
  }
}
const distinct = new Set(versions.values());
for (const path of EXAMPLES) {
  const manifest = read(path);
  const name = `examples/${path.split(/[\\/]/).at(-2)}`;
  for (const field of PINNED_FIELDS) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
      if (!dep.startsWith("@airprompter/")) continue;
      if (distinct.size === 1 && range !== [...distinct][0]) problems.push(`${name} pins ${dep}@${range} in ${field}; the lockstep version is ${[...distinct][0]} (--set moves it)`);
    }
  }
}
if (distinct.size !== 1) problems.push(`versions differ: ${[...versions].map(([n, v]) => `${n}=${v}`).join(", ")}`);
const version = [...distinct][0];
if (expect && version !== npmForm(expect)) problems.push(`the tag says ${expect}; the packages say ${version}`);
for (const path of DOCS) {
  const text = readFileSync(path, "utf8");
  if (!isPrerelease(version) && RC_BLOCK.test(text)) problems.push(`${path}: a release-candidate block on ${version}; --set drops it`);
  RC_BLOCK.lastIndex = 0;
  // Named where it counts: an install pin (`@airprompter/…@V`) or the status line (`**SDK V**`), never prose.
  const pinned = new RegExp(`(?:@|\\*\\*SDK )${versionToken(version).source}`);
  if (!pinned.test(text)) problems.push(`${path} does not name ${version}`);
}
if (problems.length) {
  for (const line of problems) console.error(`version-lockstep: ${line}`);
  process.exit(1);
}
console.log(`version-lockstep: ok (${version})`);
