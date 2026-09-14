#!/usr/bin/env node
// Build every package in dependency order (core → clients → sdk): ESM with
// declarations, then CommonJS, each package's `dist/cjs` marked commonjs.
// A sibling resolves through the workspace link to the sibling's dist, so
// the order is the whole build.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
export const BUILD_ORDER = ["core", "sync", "runtime", "telemetry", "otel-bridge", "sdk"];
const tsc = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

for (const name of BUILD_ORDER) {
  const dir = join(root, "packages", name);
  rmSync(join(dir, "dist"), { recursive: true, force: true });
  execFileSync(tsc, ["-p", "tsconfig.esm.json"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
  execFileSync(tsc, ["-p", "tsconfig.cjs.json"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
  mkdirSync(join(dir, "dist", "cjs"), { recursive: true });
  writeFileSync(join(dir, "dist", "cjs", "package.json"), JSON.stringify({ type: "commonjs" }));
  console.log(`built ${name === "otel-bridge" ? "@airprompter/otel-bridge" : `@airprompter/agent-${name}`}`);
}
