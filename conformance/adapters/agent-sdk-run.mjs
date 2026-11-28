// The TypeScript SDK's answers to the framework sections (AIR-2233):
// `sessionScenario` runs a run-session vector on a real offline agent (memory
// sink, fake clock, the harness's sealed bundle through `applyBundle`), and
// `driveRun` starts the same agent and hands it to the framework's driver in
// ../frameworks/drivers/, which builds the framework as a developer would.
// Everything is loaded from the built dist, as agent-sdk.mjs is.
//
//   import { runOps } from "./agent-sdk-run.mjs";
//   export const ops = { ...protocolOps, ...runOps };   // sessionScenario, unavailableReasons, driveRun
//   const answer = await runOps.sessionScenario(script);

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sdkRoot = join(here, "..", "..", "sdk-typescript");
const driversDir = join(here, "..", "frameworks", "drivers");

// ---------------------------------------------------------------------------
// `load`: what a driver imports, resolved as a developer's project would resolve it. The SDK's own package from
// this repository's build; everything else from sdk-typescript/node_modules, where the SDK's dist resolves the same
// names (the weekly job installs the latest framework versions there), so the driver and the adapter share one
// module instance of each. ESM conditions throughout.

const nodeModules = join(sdkRoot, "node_modules");

function packageDir(name) {
  if (name === "@airprompter/agent-sdk") return join(sdkRoot, "packages", "sdk");
  const dir = join(nodeModules, ...name.split("/"));
  if (existsSync(join(dir, "package.json"))) return dir;
  throw new Error(`${name} is not installed in ${nodeModules}`);
}

function pickTarget(target) {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) return target.map(pickTarget).find(Boolean) ?? null;
  if (target && typeof target === "object") {
    for (const condition of ["node", "import", "default"]) if (condition in target) {
      const found = pickTarget(target[condition]);
      if (found) return found;
    }
  }
  return null;
}

/** Resolve a bare specifier to a file URL by the package's `exports` (ESM conditions), else its `module` / `main`. */
export function resolveSpecifier(specifier) {
  if (specifier.startsWith("node:")) return specifier;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const subpath = `.${specifier.slice(name.length)}`;
  const dir = packageDir(name);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  let file = null;
  if (manifest.exports) {
    const exportsMap = typeof manifest.exports === "string" || Object.keys(manifest.exports).every((k) => !k.startsWith(".")) ? { ".": manifest.exports } : manifest.exports;
    file = pickTarget(exportsMap[subpath]);
  } else if (subpath === ".") file = manifest.module ?? manifest.main ?? "index.js";
  else file = subpath;
  if (!file) throw new Error(`${specifier}: ${name} exports no ${subpath}`);
  return pathToFileURL(join(dir, file)).href;
}

const importOf = (specifier) => import(resolveSpecifier(specifier));

/** What a developer's code imports from this SDK: its root and a framework's subpath, never the contract or a part. */
export const DRIVER_SDK_SPECIFIER = /^@airprompter\/agent-sdk(\/frameworks\/(?!contract$)[a-z0-9-]+)?$/;

/**
 * The `load` a driver is handed: a framework's packages and the SDK's public entries only. Anything else of this
 * SDK throws, so a driver that needs an internal fails at once (the adapter is missing something).
 */
export function load(specifier) {
  if (typeof specifier !== "string") throw new TypeError("load takes a package specifier");
  if (specifier.startsWith("@airprompter/") && !DRIVER_SDK_SPECIFIER.test(specifier)) throw new Error(`a driver imports what a developer's code imports: ${specifier} is not the SDK's root or a framework subpath`);
  if (specifier.startsWith(".") || specifier.startsWith("/") || /^[A-Za-z]:/.test(specifier)) throw new Error(`a driver loads packages, not paths: ${specifier}`);
  return importOf(specifier);
}

/** The installed version of a package, for the job title and the fixture's `frameworkVersion`. */
export const versionOf = (name) => JSON.parse(readFileSync(join(packageDir(name), "package.json"), "utf8")).version;

// The adapter itself (not a driver) reads the run reference key and the reason list. Those are not on the curated
// `/core` and `/runtime` subpaths (docs/stability.md), so it reads the layers' barrels, as agent-sdk.mjs does.
const sdk = await importOf("@airprompter/agent-sdk");
const barrel = (layer) => import(pathToFileURL(join(sdkRoot, "packages", "sdk", "dist", "esm", layer, "index.js")).href);
const runtime = await barrel("runtime");
const core = await barrel("core");

// ---------------------------------------------------------------------------
// The host: one offline agent per scenario or fixture.

async function startAgent(agent, { stateDir, clock, log, variableSources = {}, sourceCalls = {} }) {
  const variables = Object.fromEntries(Object.entries(variableSources).map(([name, value]) => [name, {
    trust: "operator",
    resolve: async () => {
      sourceCalls[name] = (sourceCalls[name] ?? 0) + 1;
      await new Promise((resolve) => setImmediate(resolve)); // a real source awaits: concurrent places overlap here
      return value;
    },
  }]));
  return sdk.AirPrompterAgent.start({
    organizationId: agent.organizationId, agentId: agent.agentId, target: agent.target, stateDir,
    root: { pinned: agent.rootPublicJwk }, telemetry: { sink: "memory" }, now: () => clock.ms, logger: (event) => log.push(event),
    runRefSecret: agent.runRefSecret, runIdleTimeoutMs: agent.idleTimeoutMs,
    ...(Object.keys(variables).length ? { variables } : {}),
  });
}

async function applyBundle(ap, bundle) {
  const outcome = await ap.applyBundle(bundle);
  if (outcome.outcome !== "activated" && outcome.outcome !== "staged") throw new Error(`applyBundle: ${outcome.outcome} ${outcome.reason ?? ""} ${outcome.detail ?? ""}`.trim());
  return outcome;
}

const addCounters = (into, from) => {
  for (const [reason, n] of Object.entries(from?.passthrough ?? {})) into.passthrough[reason] = (into.passthrough[reason] ?? 0) + n;
  return into;
};

const newOut = () => ({ rows: [], steps: [], refusals: [], wire: { rows: [], steps: [], refusals: [] }, runCounters: { passthrough: {} } });

/** Stop the agent (open runs end, windows close) and take its rows, as objects and as the spool's lines, and its counters. */
async function finish(ap, into) {
  await ap.stop();
  for (const row of ap.drainMemorySink()) {
    const kind = row.type === "window" ? "rows" : row.type === "step" ? "steps" : "refusals";
    into[kind].push(row);
    into.wire[kind].push(JSON.stringify(row)); // what the uploader would send (writer.ts serialises the same way)
  }
  addCounters(into.runCounters, ap.heartbeatBody().runCounters);
}

/** Release every scope still open (each `ap.run` then ends its run), and wait for them. */
async function releaseScopes(scopes) {
  const open = Object.values(scopes);
  for (const key of Object.keys(scopes)) delete scopes[key];
  for (const scope of open) scope.release();
  await Promise.allSettled(open.map((scope) => scope.done));
}

const forge = (ref) => `${ref.slice(0, -3)}${ref.endsWith("AAA") ? "BBB" : "AAA"}`;
const fill = (value, i) => (typeof value === "string" ? value.replaceAll("{i}", String(i)) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, i)])) : value);

async function sessionScenario({ agent, bundle, variableSources, steps }) {
  const clock = { ms: agent.t0 };
  const log = [];
  const sourceCalls = {};
  const stateDir = mkdtempSync(join(tmpdir(), "ap-conformance-run-"));
  const out = newOut();
  const key = Buffer.from(core.runRefKeyFrom(agent.runRefSecret, agent.agentId, agent.target));
  const runs = {};
  const scopes = {};
  const results = [];
  let ap = await startAgent(agent, { stateDir, clock, log, variableSources, sourceCalls });
  let stopped = false;
  try {
    if (bundle) await applyBundle(ap, bundle);
    const inputOf = (input) => {
      const resolved = { ...input };
      if (input.subject && typeof input.subject === "object") resolved.subject = core.parseRunRef(runs[input.subject.runIdOf].runRef, [key]).runId;
      if (input.resume && typeof input.resume === "object") resolved.resume = input.resume.ref ? runs[input.resume.ref].runRef : forge(runs[input.resume.forged].runRef);
      return resolved;
    };
    const tokenOf = (step) => step.token ?? (step.forged ? forge(runs[step.forged].runRef) : runs[step.run].runRef);
    for (const step of steps) {
      try {
        const run = step.run ? runs[step.run] : undefined;
        switch (step.op) {
          case "open": {
            const input = inputOf(step.input);
            if (step.scope === "run") {
              let release;
              const gate = new Promise((resolve) => (release = resolve));
              let session;
              const done = ap.run(input, async (opened) => {
                session = opened;
                await gate;
              });
              scopes[step.run] = { release, done };
              runs[step.run] = session;
            } else runs[step.run] = ap.openRun(input);
            results.push({ runRef: runs[step.run].runRef });
            break;
          }
          case "place":
            if (step.concurrent) results.push({ placements: await Promise.all(Array.from({ length: step.concurrent }, () => run.place(step.slot))) });
            else results.push({ placement: await run.place(step.slot) });
            break;
          case "decline":
            results.push({ placement: run.decline(step.slot, "model_unresolved") });
            break;
          case "setTags":
            run.setTags(step.tags);
            results.push({});
            break;
          case "slotFor":
            results.push({ slot: (typeof step.slots === "string" ? run.slotFor(step.slots) : run.slotFor(step.slots, step.name)) ?? null });
            break;
          case "recordModelCall":
            run.recordModelCall(step.slot, step.call);
            results.push({});
            break;
          case "recordToolCall":
            run.recordToolCall(step.slot, step.call);
            results.push({});
            break;
          case "end": {
            const result = { ...(step.errorClass ? { errorClass: step.errorClass } : {}), ...(step.interrupted ? { interrupted: true } : {}) };
            const scope = scopes[step.run];
            if (scope) {
              if (Object.keys(result).length) run.end(result);
              delete scopes[step.run];
              scope.release();
              await scope.done;
            } else run.end(result);
            results.push({});
            break;
          }
          case "advance":
            clock.ms += step.ms;
            results.push({});
            break;
          case "sweep":
            // The registry sweeps idle runs at every open (the spool timer and an invocation's edges call the same sweep).
            ap.openRun().end();
            results.push({});
            break;
          case "swapRelease":
          case "applyDirective":
            await applyBundle(ap, step.bundle);
            results.push({});
            break;
          case "feedback":
            results.push({ filed: ap.feedback(tokenOf(step), step.signals, { ...(step.slot ? { slot: step.slot } : {}), ...(step.model ? { model: step.model } : {}) }) });
            break;
          case "explain":
            results.push({ entries: ap.explain(tokenOf(step)) ?? null });
            break;
          case "ref":
            results.push({ token: run.runRef });
            break;
          case "sample": {
            const placements = [];
            for (let i = 0; i < step.runs; i += 1) {
              const sampled = ap.openRun(inputOf(fill(step.input, i)));
              placements.push(await sampled.place(step.slot));
              sampled.end();
            }
            results.push({ placements });
            break;
          }
          case "restart":
            await releaseScopes(scopes);
            stopped = true;
            await finish(ap, out);
            ap = await startAgent(agent, { stateDir, clock, log, variableSources, sourceCalls });
            stopped = false;
            results.push({});
            break;
          default:
            throw new Error(`unknown step op ${step.op}`);
        }
      } catch (error) {
        results.push({ error: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}` });
      }
    }
    await releaseScopes(scopes);
    stopped = true;
    await finish(ap, out);
  } finally {
    // A step that threw out of the loop (applyBundle) still stops the agent, so no timer outlives the state folder.
    if (!stopped) await ap.stop().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
  return { results, ...out, log, sourceCalls };
}

// ---------------------------------------------------------------------------
// driveRun: the fixture's framework driver on a started agent.

/**
 * Each slot's placement, in order, from the run's logs: what the adapter chose, never the text. A later decline of an
 * approved slot (`run_passthrough model_unresolved`) turns its entry into that passthrough, keeping the version it pinned.
 */
export function placementsOf(log) {
  const out = [];
  const runOf = new WeakMap(); // a decline folds into its own run's entry: two runs can hold one slot at once
  for (const event of log) {
    if (event.event === "run_placed") out.push({ slot: event.slot, kind: event.reason ? "passthrough" : "approved", ...(event.reason ? { reason: event.reason } : {}), ...(event.versionId ? { versionId: event.versionId, arm: event.arm } : {}) }), runOf.set(out[out.length - 1], event.runId);
    else if (event.event === "run_passthrough" && event.reason === "model_unresolved") {
      const placed = [...out].reverse().find((p) => p.slot === event.slot && p.kind === "approved" && runOf.get(p) === event.runId);
      if (placed) Object.assign(placed, { kind: "passthrough", reason: "model_unresolved", declined: true });
    }
  }
  return out;
}

async function driveRun({ fixture, bundle, agent }) {
  const path = join(driversDir, `${fixture.framework}.mjs`);
  if (!existsSync(path)) throw Object.assign(new Error(`no TypeScript driver for ${fixture.framework} (frameworks/drivers/${fixture.framework}.mjs)`), { reason: "no_driver" });
  const driver = await import(pathToFileURL(path).href);
  const clock = { ms: agent.t0 };
  const log = [];
  const stateDir = mkdtempSync(join(tmpdir(), "ap-conformance-drive-"));
  const out = newOut();
  const ap = await startAgent(agent, { stateDir, clock, log });
  let stopped = false;
  try {
    if (bundle) await applyBundle(ap, bundle);
    // The context is an object, so a later part adds to it (a second agent, a framework root) without breaking a driver.
    const driven = await driver.driveRun({ ap, fixture, clock, load });
    stopped = true;
    await finish(ap, out);
    return { placements: placementsOf(log), calls: driven.calls, runRefs: driven.runRefs ?? [], ...out, log, ...(driven.state !== undefined ? { state: driven.state } : {}) };
  } finally {
    if (!stopped) await ap.stop().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
}

export const runOps = {
  sessionScenario,
  unavailableReasons: () => ({ reasons: [...runtime.UNAVAILABLE_REASONS] }),
  driveRun,
};
