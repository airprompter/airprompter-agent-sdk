#!/usr/bin/env node
// What each package publishes, against its budget (`airprompter.sizeBudgetBytes`
// in the package's package.json): the bytes of every .js under dist/esm and
// dist/cjs. Exit 1 over budget; `--json` prints the numbers.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PACKAGES = ["core", "sync", "runtime", "telemetry", "otel-bridge", "sdk"];

function jsBytes(dir) {
  let total = 0;
  try {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) total += jsBytes(path);
      else if (path.endsWith(".js")) total += statSync(path).size;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return total;
}

const report = {};
let over = false;
for (const name of PACKAGES) {
  const dir = join(root, "packages", name);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const budget = manifest.airprompter?.sizeBudgetBytes ?? 0;
  const bytes = jsBytes(join(dir, "dist"));
  report[name] = { bytes, budget };
  if (bytes > budget) over = true;
}
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report));
} else {
  for (const [name, { bytes, budget }] of Object.entries(report)) console.log(`${name.padEnd(10)} ${String(bytes).padStart(8)} / ${budget} bytes${bytes > budget ? "  OVER BUDGET" : ""}`);
}
if (over) process.exit(1);
