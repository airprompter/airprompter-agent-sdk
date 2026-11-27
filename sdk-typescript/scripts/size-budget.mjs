#!/usr/bin/env node
// What each subpath of the SDK and each satellite package publishes, against
// its budget (`airprompter.sizeBudgetBytes`: a number for a satellite, one
// entry per `exports` key for the SDK): the bytes of the .js under dist/esm and
// dist/cjs that belong to it. An export with no budget fails, so a new adapter
// cannot arrive without one. An adapter file (`src/frameworks/<name>.ts`) over
// 300 lines fails too: an adapter is translation only (CONTRIBUTING.md).
// Exit 1 over budget; `--json` prints the numbers.
//
//   $ npm run size                              # from sdk-typescript/, after npm run build

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SATELLITES = ["agent-otel", "datastore-s3", "datastore-postgres", "datastore-redis"];

/** Which subpath a built file belongs to: its top directory, the test kit apart from core, the rest of the root at `.`. */
function subpathOf(rel) {
  if (rel === "testing.js" || rel.startsWith("core/testing/")) return "./testing";
  // An adapter is one file (`frameworks/langchain.js`) or one folder (`frameworks/steps/…`): either way its own entry.
  if (rel.startsWith("frameworks/")) {
    const parts = rel.split("/");
    return parts.length > 2 ? `./frameworks/${parts[1]}` : `./${rel.replace(/\.js$/, "")}`;
  }
  const slash = rel.indexOf("/");
  return slash === -1 ? "." : `./${rel.slice(0, slash)}`;
}

function jsFiles(dir, prefix = "", out = []) {
  try {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) jsFiles(path, `${prefix}${entry}/`, out);
      else if (path.endsWith(".js")) out.push({ rel: `${prefix}${entry}`, bytes: statSync(path).size });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return out;
}

const report = {};
let over = false;
const record = (name, bytes, budget) => {
  report[name] = { bytes, budget };
  if (bytes > budget) over = true;
};

const sdkDir = join(root, "packages", "sdk");
const sdk = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8"));
const sizes = Object.fromEntries(Object.keys(sdk.exports).map((subpath) => [subpath, 0]));
for (const flavour of ["esm", "cjs"]) {
  for (const { rel, bytes } of jsFiles(join(sdkDir, "dist", flavour))) {
    const subpath = subpathOf(rel);
    if (!(subpath in sizes)) throw new Error(`dist/${flavour}/${rel} belongs to no export`);
    sizes[subpath] += bytes;
  }
}
for (const [subpath, bytes] of Object.entries(sizes)) record(subpath === "." ? "sdk" : `sdk/${subpath.slice(2)}`, bytes, sdk.airprompter?.sizeBudgetBytes?.[subpath] ?? 0);

for (const name of SATELLITES) {
  const dir = join(root, "packages", name);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  record(name, jsFiles(join(dir, "dist")).reduce((total, file) => total + file.bytes, 0), manifest.airprompter?.sizeBudgetBytes ?? 0);
}

// An adapter is one file of translation: past 300 lines it is doing the run's job.
const ADAPTER_MAX_LINES = 300;
const frameworks = join(sdkDir, "src", "frameworks");
const longAdapters = [];
for (const entry of readdirSync(frameworks)) {
  if (!entry.endsWith(".ts")) continue;
  const lines = readFileSync(join(frameworks, entry), "utf8").split("\n").length;
  if (lines > ADAPTER_MAX_LINES) longAdapters.push(`src/frameworks/${entry}: ${lines} lines, over ${ADAPTER_MAX_LINES}`);
}
if (longAdapters.length > 0) {
  over = true;
  for (const line of longAdapters) console.error(`size: ${line}`);
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report));
} else {
  for (const [name, { bytes, budget }] of Object.entries(report)) console.log(`${name.padEnd(26)} ${String(bytes).padStart(8)} / ${budget} bytes${bytes > budget ? "  OVER BUDGET" : ""}`);
}
if (over) process.exit(1);
