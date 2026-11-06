#!/usr/bin/env node
// The core flows from the customer's side of the registry: every package is
// packed (`npm pack`, what `npm publish` would ship) and installed into a
// fresh project, with nothing else present.
//
//   - `@airprompter/agent-sdk` alone: every subpath but the framework adapter
//     imports, ESM and CommonJS, with no optional peer installed; the adapter
//     names the peer it is missing, and imports once that peer is there.
//   - each satellite beside it: exactly one copy of the SDK resolves, and the
//     satellite's own import works, ESM and CommonJS.
//
// A subpath that reaches for a package it does not declare, or a file the
// exports map does not name, fails here and nowhere else.
//
//   $ node scripts/install-alone.mjs            # from sdk-typescript/, after npm run build

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (args, cwd) => execFileSync(npm, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], shell: process.platform === "win32" });
const PACKAGES = ["sdk", "agent-otel", "datastore-s3", "datastore-postgres", "datastore-redis"];

/** Each subpath's own surface: one named export per job it does, so an empty barrel fails. */
const SDK_SUBPATHS = {
  "@airprompter/agent-sdk": ["AirPrompterAgent", "isAgentStartError"],
  "@airprompter/agent-sdk/core": ["verifyManifest", "BundleRelease", "assignArm"],
  "@airprompter/agent-sdk/sync": ["SlotStore", "syncOnce", "fileKey"],
  "@airprompter/agent-sdk/runtime": ["ReleaseResolver", "wrapClient", "ManagedAgent"],
  "@airprompter/agent-sdk/telemetry": ["SpoolWriter", "DirectorySink", "SpoolUploader"],
  "@airprompter/agent-sdk/testing": ["FakeControlPlane", "MemoryFs"],
};
// Pinned to what the workspace tests against, so a framework's new release cannot fail this with no commit behind it.
const WORKSPACE_DEV_DEPENDENCIES = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies;
const ADAPTER = { spec: "@airprompter/agent-sdk/frameworks/langchain", names: ["airprompter"], peers: ["langchain", "@langchain/core", "zod"].map((peer) => `${peer}@${WORKSPACE_DEV_DEPENDENCIES[peer]}`) };
const SATELLITES = {
  "agent-otel": { spec: "@airprompter/agent-otel/exporter", names: ["otlpUploadSink", "spoolRowsToOtlp"] },
  "datastore-s3": { spec: "@airprompter/datastore-s3", names: ["s3KvStore"] },
  "datastore-postgres": { spec: "@airprompter/datastore-postgres", names: ["postgresKvStore", "postgresKvSchema"] },
  "datastore-redis": { spec: "@airprompter/datastore-redis", names: ["redisKvStore", "fromNodeRedis", "fromIoRedis"] },
};

const esmCheck = (spec, names) => `import { ${names.join(", ")} } from ${JSON.stringify(spec)};\nif (![${names.join(", ")}].every((f) => typeof f === "function")) throw new Error(${JSON.stringify(`${spec} surface`)});\n`;
const cjsCheck = (spec, names) => `const m = require(${JSON.stringify(spec)});\nif (!${JSON.stringify(names)}.every((n) => typeof m[n] === "function")) throw new Error(${JSON.stringify(`${spec} cjs surface`)});\n`;

function imports(project, label, spec, names) {
  writeFileSync(join(project, `${label}.mjs`), esmCheck(spec, names));
  writeFileSync(join(project, `${label}.cjs`), cjsCheck(spec, names));
  execFileSync("node", [`${label}.mjs`], { cwd: project, stdio: "inherit" });
  execFileSync("node", [`${label}.cjs`], { cwd: project, stdio: "inherit" });
}

/** Every installed copy of the SDK under a project, nested ones included. */
function copiesOfSdk(modules, out = []) {
  if (!existsSync(modules)) return out;
  if (existsSync(join(modules, "@airprompter", "agent-sdk", "package.json"))) out.push(join(modules, "@airprompter", "agent-sdk"));
  for (const entry of readdirSync(modules)) {
    if (entry.startsWith(".")) continue;
    const packages = entry.startsWith("@") ? readdirSync(join(modules, entry)).map((name) => join(modules, entry, name)) : [join(modules, entry)];
    for (const dir of packages) copiesOfSdk(join(dir, "node_modules"), out);
  }
  return out;
}

const work = mkdtempSync(join(tmpdir(), "ap-install-alone-"));
try {
  const tarballs = {};
  for (const name of PACKAGES) {
    const out = run(["pack", "--pack-destination", work, "--json"], join(root, "packages", name));
    // npm 11 prints an array of one; npm 12 prints an object keyed by package name.
    const packed = Object.values(JSON.parse(out))[0];
    // What a customer downloads is the build and its licence: never a build cache, a source tree or a test.
    const stray = packed.files.map((file) => file.path).filter((path) => /(^|\/)\.tsbuildinfo$|^src\/|^test\/|\.test\.[cm]?js$/.test(path));
    if (stray.length > 0) throw new Error(`${name}: the tarball ships ${stray.join(", ")}`);
    if (!packed.files.some((file) => file.path === "LICENSE")) throw new Error(`${name}: the tarball has no LICENSE`);
    tarballs[name] = join(work, packed.filename);
  }

  const project = (name) => {
    const dir = join(work, `alone-${name}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `alone-${name}`, private: true, type: "module" }));
    return dir;
  };

  const alone = project("sdk");
  run(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballs.sdk], alone);
  Object.entries(SDK_SUBPATHS).forEach(([spec, names], index) => imports(alone, `subpath-${index}`, spec, names));
  console.log(`install-alone: @airprompter/agent-sdk alone: ${Object.keys(SDK_SUBPATHS).length} subpaths import clean, ESM and CJS, with no optional peer present`);

  // The adapter's peer is optional: absent, the adapter says so; present, it loads.
  writeFileSync(join(alone, "adapter.mjs"), esmCheck(ADAPTER.spec, ADAPTER.names));
  writeFileSync(join(alone, "adapter.cjs"), cjsCheck(ADAPTER.spec, ADAPTER.names));
  for (const file of ["adapter.mjs", "adapter.cjs"]) {
    const absent = spawnSync("node", [file], { cwd: alone, encoding: "utf8" });
    if (absent.status === 0 || !/(Cannot find (package|module) 'langchain)/.test(absent.stderr)) throw new Error(`${file}: with langchain absent the adapter must name it; got status ${absent.status}: ${absent.stderr}`);
  }
  run(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", ...ADAPTER.peers], alone);
  imports(alone, "adapter", ADAPTER.spec, ADAPTER.names);
  console.log(`install-alone: ${ADAPTER.spec} names its missing peer, and imports with ${ADAPTER.peers.join(", ")} present`);

  for (const [name, { spec, names }] of Object.entries(SATELLITES)) {
    const beside = project(name);
    // Only the SDK and the satellite; a package neither declares is not there to be found.
    run(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballs.sdk, tarballs[name]], beside);
    imports(beside, "satellite", spec, names);
    const copies = copiesOfSdk(join(beside, "node_modules"));
    if (copies.length !== 1) throw new Error(`${name}: ${copies.length} copies of @airprompter/agent-sdk resolve: ${copies.join(", ")}`);
    const manifest = JSON.parse(readFileSync(join(beside, "node_modules", "@airprompter", name, "package.json"), "utf8"));
    if (manifest.dependencies?.["@airprompter/agent-sdk"]) throw new Error(`${name}: the SDK must be a peer, never a dependency`);
    console.log(`install-alone: ${spec} beside the SDK: one copy resolves, ESM and CJS import clean`);
  }

  // Everything at once, as an application with a datastore and a collector has it.
  const together = project("together");
  run(["install", "--ignore-scripts", "--no-audit", "--no-fund", ...PACKAGES.map((name) => tarballs[name])], together);
  const copies = copiesOfSdk(join(together, "node_modules"));
  if (copies.length !== 1) throw new Error(`together: ${copies.length} copies of @airprompter/agent-sdk resolve: ${copies.join(", ")}`);
  console.log("install-alone: every package together: one copy of @airprompter/agent-sdk resolves");
} finally {
  rmSync(work, { recursive: true, force: true });
}
