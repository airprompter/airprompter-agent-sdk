#!/usr/bin/env node
// A single executable (Node SEA): bundle → SEA blob → copy of the running
// node binary with the blob injected. macOS binaries are ad-hoc signed here
// (the release workflow replaces that with Developer ID + notarization);
// Windows gets its Authenticode signature in the workflow too.
//
//   node scripts/build-sea.mjs --out ../dist/airprompter-darwin-arm64

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const { values } = parseArgs({ options: { out: { type: "string" } }, strict: true });
const out = resolve(root, values.out ?? join("dist", process.platform === "win32" ? "airprompter.exe" : "airprompter"));
mkdirSync(dirname(out), { recursive: true });

const run = (file, args, opts = {}) => execFileSync(file, args, { stdio: "inherit", cwd: root, ...opts });

run(process.execPath, [join(root, "scripts", "bundle.mjs")]);

const seaConfig = join(root, "dist", "sea-config.json");
const blob = join(root, "dist", "airprompter.blob");
writeFileSync(seaConfig, JSON.stringify({ main: join(root, "dist", "airprompter.cjs"), output: blob, disableExperimentalSEAWarning: true, useCodeCache: false }, null, 2));
run(process.execPath, ["--experimental-sea-config", seaConfig]);

if (existsSync(out)) rmSync(out);
copyFileSync(process.execPath, out);
chmodSync(out, 0o755);
if (process.platform === "darwin") run("codesign", ["--remove-signature", out]);

const postjectArgs = [join(root, "node_modules", "postject", "dist", "cli.js"), out, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
if (process.platform === "darwin") postjectArgs.push("--macho-segment-name", "NODE_SEA");
run(process.execPath, postjectArgs);

if (process.platform === "darwin") run("codesign", ["--sign", "-", out]);

const size = statSync(out).size;
console.log(`built ${out} (${(size / 1024 / 1024).toFixed(1)} MiB, node ${process.version}, ${process.platform}-${process.arch})`);
