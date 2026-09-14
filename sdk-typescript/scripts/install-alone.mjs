#!/usr/bin/env node
// The core flows of S10, from the customer's side of the registry: each
// package is packed (`npm pack`, what `npm publish` would ship), installed
// into a fresh project with only the siblings it pins, and imported — ESM
// and CommonJS — with nothing else present. A package that reaches for a
// sibling it does not declare, or ships a file its exports map does not
// name, fails here and nowhere else.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (args, cwd) => execFileSync(npm, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], shell: process.platform === "win32" });

/** What each install must be able to do with only what it declares. */
const FLOWS = {
  core: { with: ["core"], esm: 'import { verifyManifest, BundleRelease, assignArm } from "@airprompter/agent-core"; import { FakeControlPlane } from "@airprompter/agent-core/testing"; if (![verifyManifest, BundleRelease, assignArm, FakeControlPlane].every((f) => typeof f === "function")) throw new Error("core surface");', cjs: 'const c = require("@airprompter/agent-core"); if (typeof c.verifyManifest !== "function") throw new Error("core cjs");' },
  sync: { with: ["core", "sync"], esm: 'import { SlotStore, syncOnce, fileKey } from "@airprompter/agent-sync"; if (![SlotStore, syncOnce, fileKey].every((f) => typeof f === "function")) throw new Error("sync surface");', cjs: 'const s = require("@airprompter/agent-sync"); if (typeof s.SlotStore !== "function") throw new Error("sync cjs");' },
  runtime: { with: ["core", "runtime"], esm: 'import { ReleaseResolver, wrapClient, ManagedAgent } from "@airprompter/agent-runtime"; if (![ReleaseResolver, wrapClient, ManagedAgent].every((f) => typeof f === "function")) throw new Error("runtime surface");', cjs: 'const r = require("@airprompter/agent-runtime"); if (typeof r.ReleaseResolver !== "function") throw new Error("runtime cjs");' },
  telemetry: { with: ["core", "telemetry"], esm: 'import { SpoolWriter, DirectorySink, SpoolUploader } from "@airprompter/agent-telemetry"; if (![SpoolWriter, DirectorySink, SpoolUploader].every((f) => typeof f === "function")) throw new Error("telemetry surface");', cjs: 'const t = require("@airprompter/agent-telemetry"); if (typeof t.SpoolWriter !== "function") throw new Error("telemetry cjs");' },
  sdk: { with: ["core", "sync", "runtime", "telemetry", "sdk"], esm: 'import { AirPrompterAgent, SlotStore, ReleaseResolver, SpoolWriter, verifyManifest } from "@airprompter/agent-sdk"; import { FakeControlPlane } from "@airprompter/agent-sdk/testing"; if (![AirPrompterAgent, SlotStore, ReleaseResolver, SpoolWriter, verifyManifest, FakeControlPlane].every((f) => typeof f === "function")) throw new Error("sdk surface");', cjs: 'const a = require("@airprompter/agent-sdk"); if (typeof a.AirPrompterAgent !== "function") throw new Error("sdk cjs");' },
};

const work = mkdtempSync(join(tmpdir(), "ap-install-alone-"));
try {
  const tarballs = {};
  for (const name of Object.keys(FLOWS)) {
    const out = run(["pack", "--pack-destination", work, "--json"], join(root, "packages", name));
    tarballs[name] = join(work, JSON.parse(out)[0].filename);
  }
  for (const [name, flow] of Object.entries(FLOWS)) {
    const project = join(work, `alone-${name}`);
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: `alone-${name}`, private: true, type: "module" }));
    // Only the tarballs this package pins; a sibling it does not declare is not there to be found.
    run(["install", "--ignore-scripts", "--no-audit", "--no-fund", ...flow.with.map((dep) => tarballs[dep])], project);
    writeFileSync(join(project, "esm.mjs"), flow.esm);
    writeFileSync(join(project, "cjs.cjs"), flow.cjs);
    execFileSync("node", ["esm.mjs"], { cwd: project, stdio: "inherit" });
    execFileSync("node", ["cjs.cjs"], { cwd: project, stdio: "inherit" });
    console.log(`install-alone: @airprompter/agent-${name} with [${flow.with.join(", ")}] — ESM and CJS import clean`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
