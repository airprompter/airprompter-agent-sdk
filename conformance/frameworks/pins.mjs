#!/usr/bin/env node
// The framework versions the fixtures were recorded from, as one install line
// per language: the one source CI installs Python from (ci.yml), so a pin
// lives in its fixtures (TypeScript's are also sdk-typescript's exact
// devDependencies, and test/frameworks.test.mjs holds the two equal). With
// `--matrix`, the weekly job's matrix instead: one entry per framework and
// language, at the newest release each registry has (npm, PyPI), with the
// companion packages that must move with it, so a job is named for, and
// installs, exactly what it runs.
//
//   $ node conformance/frameworks/pins.mjs py                     # anthropic==2.14.0 litellm==1.111.0 openai==3.60.0
//   $ node conformance/frameworks/pins.mjs py --except openai     # the others, for a job that installs openai's newest
//   $ node conformance/frameworks/pins.mjs py --names --except "openai httpx"   # the others by name only (any version)
//   $ node conformance/frameworks/pins.mjs ts                     # ai@7.0.162 @ai-sdk/provider@4.0.35 …
//   $ node conformance/frameworks/pins.mjs --matrix               # [{"framework":"openai","language":"py","package":"openai","version":"3.61.0","with":""}, …]
//
// A framework's own package is FRAMEWORK_PACKAGES's; a fixture's `packages`
// adds the others it was recorded with, and FRAMEWORK_COMPANIONS the ones a
// newest release needs beside it (a peer range). Two fixtures of one
// framework and language that pin different versions are refused.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FRAMEWORK_COMPANIONS, FRAMEWORK_PACKAGES, FRAMEWORK_TRAITS, loadFixtures } from "./run.mjs";

/** `{ language: Map<package, { version, file }> }` from every fixture; throws on two pins for one package. */
export function pinsOf(fixtures = loadFixtures()) {
  const pins = { ts: new Map(), py: new Map() };
  const take = (language, pkg, version, file) => {
    const held = pins[language].get(pkg);
    if (held && held.version !== version) throw new Error(`${pkg} (${language}) is pinned to ${held.version} in ${held.file} and ${version} in ${file}`);
    pins[language].set(pkg, { version, file });
  };
  for (const { fixture, file } of fixtures) {
    if (!fixture || FRAMEWORK_TRAITS[fixture.framework]?.sdk) continue;
    const pkg = FRAMEWORK_PACKAGES[fixture.framework]?.[fixture.language];
    if (pkg) take(fixture.language, pkg, fixture.frameworkVersion, file);
    for (const [name, version] of Object.entries(fixture.packages ?? {})) take(fixture.language, name, version, file);
  }
  return pins;
}

/** The newest release of a package: npm's registry for TypeScript, PyPI for Python. */
export async function latestOf(language, pkg) {
  const url = language === "ts" ? `https://registry.npmjs.org/${pkg.replace("/", "%2F")}/latest` : `https://pypi.org/pypi/${pkg}/json`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const body = await response.json();
  return language === "ts" ? body.version : body.info.version;
}

/** One weekly job per framework and language with fixtures: its package and companions at their newest releases. */
export async function matrixOf(fixtures = loadFixtures()) {
  const seen = new Map();
  for (const { fixture } of fixtures) {
    if (!fixture || FRAMEWORK_TRAITS[fixture.framework]?.sdk) continue;
    const pkg = FRAMEWORK_PACKAGES[fixture.framework]?.[fixture.language];
    if (!pkg) continue;
    const key = `${fixture.framework}/${fixture.language}`;
    const companions = seen.get(key)?.companions ?? new Set(FRAMEWORK_COMPANIONS[fixture.framework]?.[fixture.language] ?? []);
    for (const name of Object.keys(fixture.packages ?? {})) if (name !== pkg) companions.add(name);
    seen.set(key, { framework: fixture.framework, language: fixture.language, package: pkg, companions });
  }
  const matrix = [];
  for (const entry of seen.values()) {
    const version = await latestOf(entry.language, entry.package);
    const withs = [];
    for (const name of [...entry.companions].sort()) withs.push(`${name}${entry.language === "py" ? "==" : "@"}${await latestOf(entry.language, name)}`);
    matrix.push({ framework: entry.framework, language: entry.language, package: entry.package, version, with: withs.join(" "), withNames: [...entry.companions].sort().join(" ") });
  }
  return matrix;
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const [arg, ...rest] = process.argv.slice(2);
  const names = rest.includes("--names");
  const at = rest.indexOf("--except");
  const except = at === -1 ? [] : (rest[at + 1] ?? "").split(/\s+/).filter(Boolean);
  if (arg === "--matrix") {
    console.log(JSON.stringify(await matrixOf()));
  } else if ((arg === "ts" || arg === "py") && (at === -1 || except.length > 0)) {
    // `--names`: the weekly job's other frameworks, installed at whatever version resolves beside the newest one it tests.
    const lines = [...pinsOf()[arg]].filter(([pkg]) => !except.includes(pkg)).map(([pkg, { version }]) => (names ? pkg : arg === "py" ? `${pkg}==${version}` : `${pkg}@${version}`));
    console.log(lines.join(" "));
  } else {
    console.error('usage: pins.mjs ts | py [--names] [--except "<package> …"] | --matrix');
    process.exit(2);
  }
}
