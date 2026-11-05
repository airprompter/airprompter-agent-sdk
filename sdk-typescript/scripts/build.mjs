#!/usr/bin/env node
// Build every package in dependency order (the SDK, then the satellites that
// peer on it): ESM with declarations, then CommonJS, each package's `dist/cjs`
// marked commonjs. A satellite resolves `@airprompter/agent-sdk/<subpath>`
// through the workspace link to the SDK's dist, so the order is the whole build.
//
// `protocol/VERSION` and `packages/sdk/package.json` are the only hand-edited
// versions: `writeVersions` writes both constants into `core/protocol/version.ts`.
//
//   $ npm run build          # from sdk-typescript/; the release workflow runs the same

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
export const BUILD_ORDER = ["sdk", "agent-otel", "datastore-s3", "datastore-postgres", "datastore-redis"];
const tsc = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

/** Write the protocol and SDK versions into the source the build, the tests and the CLI bundle all read. */
export function writeVersions() {
  const protocol = readFileSync(join(root, "..", "protocol", "VERSION"), "utf8").trim();
  const sdk = JSON.parse(readFileSync(join(root, "packages", "sdk", "package.json"), "utf8")).version;
  const path = join(root, "packages", "sdk", "src", "core", "protocol", "version.ts");
  const source = readFileSync(path, "utf8");
  const next = source.replace(/^export const PROTOCOL_VERSION = ".*";$/m, `export const PROTOCOL_VERSION = "${protocol}";`).replace(/^export const SDK_VERSION = ".*";$/m, `export const SDK_VERSION = "${sdk}";`);
  if (next !== source) writeFileSync(path, next);
}

function build() {
  writeVersions();
  for (const name of BUILD_ORDER) {
    const dir = join(root, "packages", name);
    rmSync(join(dir, "dist"), { recursive: true, force: true });
    execFileSync(tsc, ["-p", "tsconfig.esm.json"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
    execFileSync(tsc, ["-p", "tsconfig.cjs.json"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
    mkdirSync(join(dir, "dist", "cjs"), { recursive: true });
    writeFileSync(join(dir, "dist", "cjs", "package.json"), JSON.stringify({ type: "commonjs" }));
    console.log(`built ${JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name}`);
  }
}

/**
 * Whether Node is running this file. The real path: Node resolves a symlink before it sets `import.meta.url`, and a
 * comparison against the link would exit 0 having built nothing. An argv[1] that is no path (`node -e`) means no.
 */
function isEntryPoint() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

// `version-lockstep.mjs --set` imports `writeVersions`; only running this file builds.
if (isEntryPoint()) build();
