#!/usr/bin/env node
// The protocol conformance harness (S14): every vector in protocol/vectors,
// run against an SDK under test through a JSON-only adapter — an ES module
// (`--adapter ./my-sdk.mjs`) or any process speaking JSON lines on stdin /
// stdout (`--adapter-command "python3 adapter.py"`). The LaunchDarkly
// sdk-test-harness pattern: the harness owns the vectors and the verdicts;
// the SDK owns only the answers. `run.mjs` (schemas, examples, the
// reference) stays the protocol's own gate; this is the gate an SDK ships.
//
//   npx @airprompter/protocol-conformance --adapter ./adapter.mjs
//   npx @airprompter/protocol-conformance --adapter-command "python3 adapter.py"
//   … [--vectors <dir>] [--only <section>[,<section>]] [--json]
//
// The adapter contract is ADAPTER.md: fourteen operations, JSON in, JSON
// out, an error as `{ error: { reason } }` where the protocol names a
// refusal. `capabilities` lists what the adapter implements; a section
// whose operation is missing is reported as skipped, never as passed. Exit
// 0 only when every section that ran passed and none was skipped without
// `--allow-skips`.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The vectors: `../protocol` in this repository, `./protocol` in the published package, or `--vectors`. */
export function vectorsDir(override) {
  for (const candidate of [override, join(here, "..", "protocol"), join(here, "protocol")].filter(Boolean)) if (existsSync(join(candidate, "vectors"))) return candidate;
  throw new Error("no protocol/vectors directory: pass --vectors <dir>");
}

export const OPERATIONS = ["canonicalJson", "orderedSteps", "assignArm", "experimentForTag", "experimentConflict", "validateRamp", "rampWeightsAt", "effectiveArms", "verifyRootMetadata", "verifyManifest", "latencyBucketIndex", "minuteOf", "segmentName", "planSegments", "aggregateWindows", "normalizeFeedback", "evaluateChecks", "patternRefusal", "checksRefusals", "projectChecks", "spoolRowsToOtlp"];

/** Which operations each section needs; a section runs only when its adapter has them all. */
export const SECTIONS = {
  "canonical-json": ["canonicalJson"],
  "workflow-steps": ["orderedSteps"],
  assignment: ["assignArm"],
  // S16: which experiment decides a slot, and the shape rule (M15).
  "assignment-per-tag": ["assignArm", "experimentForTag", "experimentConflict"],
  ramp: ["validateRamp", "rampWeightsAt", "effectiveArms", "assignArm"],
  "trust-root": ["verifyRootMetadata"],
  "trust-manifest": ["verifyManifest"],
  "spool-basics": ["latencyBucketIndex", "minuteOf", "segmentName"],
  "spool-rotation": ["planSegments"],
  "spool-windows": ["aggregateWindows"],
  feedback: ["normalizeFeedback"],
  checks: ["evaluateChecks", "patternRefusal", "checksRefusals", "projectChecks"],
  otel: ["spoolRowsToOtlp"],
};

// ---------------------------------------------------------------------------
// Adapters: an ES module's exports, or a JSON-lines process.

export async function moduleAdapter(specifier) {
  const url = /^[a-z]+:/.test(specifier) ? specifier : pathToFileURL(resolve(specifier)).href;
  const mod = await import(url);
  const ops = mod.ops ?? mod.default ?? mod;
  const capabilities = OPERATIONS.filter((name) => typeof ops[name] === "function");
  return {
    kind: `module ${specifier}`,
    capabilities,
    async call(fn, args) {
      if (typeof ops[fn] !== "function") return { error: { reason: "unsupported", message: `${fn} is not implemented` } };
      try {
        return { result: await ops[fn](args) };
      } catch (error) {
        return { error: { reason: error?.reason ?? "error", message: error?.message ?? String(error) } };
      }
    },
    close() {},
  };
}

export async function commandAdapter(command, { cwd = process.cwd(), timeoutMs = 20_000 } = {}) {
  const child = spawn(command, { shell: true, cwd, stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let buffer = "";
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // the adapter's own chatter on stdout is not the protocol
      }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve("error" in message ? { error: { reason: message.error?.reason ?? "error", message: message.error?.message ?? "" } } : { result: message.result });
    }
  });
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  const call = (fn, args) =>
    new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: { reason: "timeout", message: `${fn}: no answer in ${timeoutMs} ms` } });
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      if (!child.stdin.writable) {
        pending.delete(id);
        clearTimeout(timer);
        resolve({ error: { reason: "adapter_exited", message: "the adapter process is gone" } });
        return;
      }
      // One JSON document per `\n`, with the two Unicode line separators escaped: a line reader that treats U+2028 as a
      // newline (Node's readline does) would otherwise cut a canonical-JSON vector in two.
      child.stdin.write(`${JSON.stringify({ id, fn, args }).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")}\n`);
    });
  const caps = await call("capabilities", {});
  const capabilities = Array.isArray(caps.result?.ops) ? caps.result.ops.filter((name) => OPERATIONS.includes(name)) : [];
  if (caps.error) throw new Error(`the adapter did not answer capabilities: ${caps.error.reason} ${caps.error.message}`);
  return {
    kind: `command "${command}"`,
    capabilities,
    call,
    async close() {
      child.stdin.end();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

// ---------------------------------------------------------------------------
// The verdicts.

const stable = (value) => (Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])])) : value);
const sameJson = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const short = (value) => {
  const text = JSON.stringify(value);
  return text && text.length > 160 ? `${text.slice(0, 157)}…` : text;
};

export async function runHarness({ adapter, vectors, only = null, allowSkips = false, log = console.log }) {
  const readJson = (name) => JSON.parse(readFileSync(join(vectors, "vectors", name), "utf8"));
  const report = { adapter: adapter.kind, sections: [], passed: 0, failed: 0, skipped: [] };
  let current = null;
  const ok = (label) => {
    current.checks.push({ ok: true, label });
    report.passed += 1;
    log(`  ok   ${label}`);
  };
  const fail = (label, detail) => {
    current.checks.push({ ok: false, label, detail });
    report.failed += 1;
    log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  };
  const expectOk = async (label, fn, args, judge) => {
    const answer = await adapter.call(fn, args);
    if (answer.error) return fail(label, `${fn} refused: ${answer.error.reason} ${answer.error.message ?? ""}`.trim());
    const verdict = judge(answer.result);
    if (verdict === true) ok(label);
    else fail(label, verdict);
  };
  const expectRefusal = async (label, fn, args, reason) => {
    const answer = await adapter.call(fn, args);
    if (!answer.error) return fail(label, `${fn} answered ${short(answer.result)} instead of refusing ${reason}`);
    if (answer.error.reason === reason) ok(`${label} → ${reason}`);
    else fail(label, `expected ${reason}, got ${answer.error.reason}`);
  };

  const sections = {
    "canonical-json": async () => {
      const cj = readJson("canonical-json.json");
      for (const v of cj.vectors) await expectOk(v.name, "canonicalJson", { json: JSON.stringify(v.input) }, (r) => (r.text === v.canonical && r.sha256 === v.sha256 ? true : `text ${r.text === v.canonical ? "matches" : "differs"}, digest ${r.sha256 === v.sha256 ? "matches" : "differs"}`));
      for (const r of cj.refused) {
        if (!("input" in r)) continue; // undefined, NaN, a Date, a cycle: not JSON, a JavaScript-only concern
        await expectRefusal(`refused: ${r.name}`, "canonicalJson", { json: JSON.stringify(r.input) }, r.reason);
      }
    },
    "workflow-steps": async () => {
      for (const v of readJson("workflow-steps.json").vectors) {
        if (v.refuse) await expectRefusal(v.name, "orderedSteps", { slotTag: v.slotTag, steps: v.steps }, v.refuse);
        else await expectOk(v.name, "orderedSteps", { slotTag: v.slotTag, steps: v.steps }, (r) => (Array.isArray(r.order) && r.order.join() === v.expectedOrder.join() ? true : `order ${short(r.order)}`));
      }
    },
    assignment: async () => {
      const as = readJson("assignment.json");
      for (const c of as.cases) await expectOk(c.name, "assignArm", { salt: c.salt, subject: c.subject, arms: c.arms }, (r) => (r.subjectHash === c.expected.subjectHash && r.bucket === c.expected.bucket && r.arm === c.expected.arm ? true : `got ${short(r)}, expected ${short(c.expected)}`));
      for (const r of as.refused) await expectRefusal(`refused: ${r.name}`, "assignArm", { salt: r.salt, subject: "user-1", arms: r.arms }, r.reason);
    },
    "assignment-per-tag": async () => {
      const pt = readJson("assignment.json").perTag;
      for (const c of pt.cases) {
        const payload = { experiments: c.experiments.map((e) => ({ ...e, subjectKey: "request", arms: e.arms.map((a) => ({ ...a, releaseDigest: `sha256:${"0".repeat(64)}`, overrides: [] })) })) };
        for (const tag of c.tags) {
          const expected = c.expected[tag];
          await expectOk(`${c.name} · ${tag}`, "experimentForTag", { payload, tag }, (r) => {
            if (!r.experiment) return expected.arm === "none" && expected.experimentId === null ? true : `got no experiment, expected ${short(expected)}`;
            return r.experiment.experimentId === expected.experimentId ? true : `got ${r.experiment.experimentId}, expected ${expected.experimentId}`;
          });
          if (expected.arm === "none") continue;
          const e = payload.experiments.find((x) => x.tag === tag);
          await expectOk(`${c.name} · ${tag} arm`, "assignArm", { salt: e.salt, subject: c.subject, arms: e.arms }, (r) => (r.bucket === expected.bucket && r.arm === expected.arm ? true : `got ${short(r)}, expected ${short(expected)}`));
        }
      }
      for (const r of pt.refused) {
        const payload = {
          slots: [{ tag: "support.triage" }, { tag: "support.reply" }],
          directives: [],
          ...(r.experiment ? { experiment: r.experiment } : {}),
          experiments: r.experiments.map((e) => ({ ...e, subjectKey: "request", arms: e.arms.map((a) => ({ ...a, releaseDigest: `sha256:${"0".repeat(64)}`, overrides: (e.overrideTags?.[a.arm] ?? []).map((tag) => ({ tag })) })) })),
        };
        await expectOk(`refused: ${r.name}`, "experimentConflict", { payload }, (res) => (res.reason === r.reason ? true : `got ${short(res)}, expected ${r.reason}`));
      }
    },
    ramp: async () => {
      const rp = readJson("ramp.json");
      for (const c of rp.cases) {
        const disabledArms = c.directives.filter((d) => d.kind === "disable" && d.scope === "arm").map((d) => d.arm);
        const check = async (nowText, expectedWeights, assignments, field) => {
          const nowMs = Date.parse(nowText);
          if (expectedWeights) {
            const w = await adapter.call("rampWeightsAt", { arms: c.arms, ramp: c.ramp, nowMs });
            if (w.error || w.result.weightBps.join() !== expectedWeights.join()) return `weights at ${nowText}: ${w.error ? w.error.reason : w.result.weightBps.join()} ≠ ${expectedWeights.join()}`;
          }
          const eff = await adapter.call("effectiveArms", { arms: c.arms, ramp: c.ramp, disabledArms, nowMs });
          if (eff.error) return `effectiveArms: ${eff.error.reason}`;
          for (const entry of assignments) {
            const a = await adapter.call("assignArm", { salt: c.salt, subject: entry.subject, arms: eff.result.arms });
            if (a.error || a.result.bucket !== entry.bucket || a.result.arm !== entry[field]) return `${entry.subject}: ${a.error ? a.error.reason : `${a.result.arm}/${a.result.bucket}`} ≠ ${entry[field]}/${entry.bucket}`;
          }
          return true;
        };
        const valid = await adapter.call("validateRamp", { ramp: c.ramp, armCount: c.arms.length });
        if (valid.error) {
          fail(c.name, `validateRamp refused: ${valid.error.reason}`);
          continue;
        }
        let verdict;
        if (c.hosts) {
          verdict = await check(c.hosts.hostA.now, c.hosts.hostA.weightBps, c.expected.assignments, "hostA");
          if (verdict === true) verdict = await check(c.hosts.hostB.now, c.hosts.hostB.weightBps, c.expected.assignments, "hostB");
        } else verdict = await check(c.now, c.expected.weightBps, c.expected.assignments, "arm");
        if (verdict === true) ok(c.name);
        else fail(c.name, verdict);
      }
      for (const r of rp.refused) await expectRefusal(`refused: ${r.name}`, "validateRamp", { ramp: r.ramp, armCount: r.arms.length }, r.reason);
    },
    "trust-root": async () => {
      const tv = readJson("manifest-verify.json");
      const matches = (result, expected) => result.ok === expected.ok && (expected.ok ? (expected.signingKeyId === undefined || result.signingKeyId === expected.signingKeyId) && (expected.generation === undefined || result.generation === expected.generation) : result.reason === expected.reason);
      for (const c of tv.rootMetadata) await expectOk(c.name, "verifyRootMetadata", { candidate: c.candidate, now: c.now, ...(c.trustedRoot ? { trusted: c.trustedRoot } : { pinned: { purpose: c.purpose, environment: c.environment, pinnedRoot: c.pinnedRoot } }) }, (r) => (matches(r, c.expected) ? true : `got ${short(r)}, expected ${short(c.expected)}`));
    },
    "trust-manifest": async () => {
      const tv = readJson("manifest-verify.json");
      const matches = (result, expected) => result.ok === expected.ok && (expected.ok ? (expected.signingKeyId === undefined || result.signingKeyId === expected.signingKeyId) && (expected.generation === undefined || result.generation === expected.generation) : result.reason === expected.reason);
      for (const c of tv.manifests) await expectOk(c.name, "verifyManifest", { manifest: c.manifest, root: c.root, now: c.now, scope: c.scope, storedGeneration: c.storedGeneration, payloads: c.payloads ?? null, countersignRoot: c.countersignRoot ?? null, requireCountersign: c.requireCountersign ?? false }, (r) => (matches(r, c.expected) ? true : `got ${short(r)}, expected ${short(c.expected)}`));
    },
    "spool-basics": async () => {
      const sp = readJson("spool.json");
      const wrong = [];
      for (const c of sp.latencyBuckets.cases) {
        const r = await adapter.call("latencyBucketIndex", { latencyMs: c.latencyMs });
        if (r.error || r.result.bucket !== c.bucket) wrong.push(`${c.latencyMs} ms → ${r.error ? r.error.reason : r.result.bucket}, expected ${c.bucket}`);
      }
      if (wrong.length === 0) ok(`${sp.latencyBuckets.cases.length} latency values bucket as expected`);
      else fail("latency buckets", wrong.join("; "));
      for (const c of sp.minutes) await expectOk(`minute: ${c.name}`, "minuteOf", { epochMs: c.epochMs }, (r) => (r.minute === c.minute && r.epochMinute === c.epochMinute ? true : `${r.minute} / ${r.epochMinute}`));
      for (const c of sp.segmentNames) await expectOk(`segment name ${c.name}`, "segmentName", { instanceId: c.instanceId, epochMs: c.epochMs, n: c.n }, (r) => (r.name === c.name ? true : r.name));
    },
    "spool-rotation": async () => {
      for (const c of readJson("spool.json").rotation) await expectOk(`rotation: ${c.name}`, "planSegments", { instanceId: c.instanceId, appends: c.appends.map((a) => ({ epochMs: a.epochMs, lineBytes: a.lineBytes })) }, (r) => {
        const got = r.plan ?? [];
        const mismatch = c.appends.findIndex((a, i) => !got[i] || got[i].segment !== a.segment || got[i].rotated !== a.rotated);
        return mismatch === -1 ? true : `append ${mismatch}: got ${short(got[mismatch])}, expected ${short({ segment: c.appends[mismatch].segment, rotated: c.appends[mismatch].rotated })}`;
      });
    },
    "spool-windows": async () => {
      const sp = readJson("spool.json");
      const key = (row) => JSON.stringify([row.minute, row.tag, row.versionId, row.arm, row.model, row.status, row.errorClass ?? null]);
      const sortRows = (rows) => [...rows].sort((a, b) => (key(a) < key(b) ? -1 : 1));
      for (const c of sp.windows) await expectOk(`windows: ${c.name}`, "aggregateWindows", { instanceId: c.instanceId, instanceClass: c.instanceClass, sdk: c.sdk, events: c.events.filter((e) => e.kind !== "refusal") }, (r) => {
        const got = sortRows(r.windows ?? []);
        const expected = sortRows(c.expectedWindows);
        return got.length === expected.length && got.every((row, i) => sameJson(row, expected[i])) ? true : `got ${short(got)}\n       expected ${short(expected)}`;
      });
    },
    feedback: async () => {
      for (const c of readJson("feedback.json").cases) await expectOk(`feedback: ${c.name}`, "normalizeFeedback", { signals: c.signals }, (r) => (sameJson(r.normalized, c.expected) ? true : `got ${short(r.normalized)}, expected ${short(c.expected)}`));
    },
    checks: async () => {
      const ck = readJson("checks.json");
      for (const c of ck.evaluations) await expectOk(`checks: ${c.name}`, "evaluateChecks", { checks: c.checks, input: c.input }, (r) => (sameJson(r.evaluation, c.expected) ? true : `got ${short(r.evaluation)}, expected ${short(c.expected)}`));
      for (const c of ck.patterns) await expectOk(`checks: pattern ${JSON.stringify(c.pattern).slice(0, 40)} → ${c.refusal ?? "accepted"}`, "patternRefusal", { pattern: c.pattern }, (r) => ((r.refusal ?? null) === (c.refusal ?? null) ? true : `got ${r.refusal}, expected ${c.refusal}`));
      for (const c of ck.declarations) await expectOk(`checks: declaration — ${c.name}`, "checksRefusals", { checks: c.checks }, (r) => (sameJson(r.refusals, c.refusals) ? true : `got ${short(r.refusals)}, expected ${short(c.refusals)}`));
      await expectOk(`checks: ${ck.projection.name}`, "projectChecks", { checks: ck.projection.checks }, (r) => (sameJson(r.projected, ck.projection.expected) ? true : `got ${short(r.projected)}`));
    },
    otel: async () => {
      const otel = readJson("otel-mapping.json");
      for (const c of otel.cases) await expectOk(`otel: ${c.name}`, "spoolRowsToOtlp", { rows: c.rows, resource: c.resource, sdkVersion: "0.1.0" }, (r) => (sameJson(r.request, c.expected) ? true : "the request differs from the vector"));
    },
  };

  const wanted = only ? only.split(",").map((s) => s.trim()).filter(Boolean) : Object.keys(sections);
  for (const name of wanted) {
    if (!sections[name]) throw new Error(`no section ${name}; sections: ${Object.keys(sections).join(", ")}`);
    const missing = SECTIONS[name].filter((op) => !adapter.capabilities.includes(op));
    current = { name, checks: [], skipped: missing.length > 0 ? missing : null };
    report.sections.push(current);
    if (missing.length) {
      report.skipped.push({ section: name, missing });
      log(`\nvectors: ${name} — skipped (the adapter has no ${missing.join(", ")})`);
      continue;
    }
    log(`\nvectors: ${name}`);
    await sections[name]();
  }
  report.ok = report.failed === 0 && (allowSkips || report.skipped.length === 0);
  log(`\nconformance harness (${adapter.kind}): ${report.passed} passed, ${report.failed} failed, ${report.skipped.length} section${report.skipped.length === 1 ? "" : "s"} skipped${report.ok ? "" : report.failed ? " — FAILED" : " — incomplete (a section was skipped; --allow-skips to accept)"}`);
  return report;
}

// ---------------------------------------------------------------------------
// The command line.

export async function main(argv = process.argv.slice(2)) {
  const opts = { adapter: null, command: null, vectors: null, only: null, allowSkips: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--adapter") opts.adapter = next();
    else if (arg === "--adapter-command") opts.command = next();
    else if (arg === "--vectors") opts.vectors = next();
    else if (arg === "--only") opts.only = next();
    else if (arg === "--allow-skips") opts.allowSkips = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: airprompter-conformance (--adapter <module.mjs> | --adapter-command \"<cmd>\") [--vectors <protocol dir>] [--only <section,…>] [--allow-skips] [--json]\nsections: " + Object.keys(SECTIONS).join(", "));
      return 0;
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (!opts.adapter && !opts.command) {
    console.error("an adapter is required: --adapter <module.mjs> or --adapter-command \"<cmd>\" (see ADAPTER.md)");
    return 2;
  }
  const adapter = opts.command ? await commandAdapter(opts.command) : await moduleAdapter(opts.adapter);
  try {
    const report = await runHarness({ adapter, vectors: vectorsDir(opts.vectors), only: opts.only, allowSkips: opts.allowSkips, log: opts.json ? () => {} : console.log });
    // The report can pass 64 KiB: written and flushed before the exit, or a pipe reader sees it cut short.
    if (opts.json) await new Promise((resolve) => process.stdout.write(`${JSON.stringify(report)}\n`, resolve));
    return report.ok ? 0 : 1;
  } finally {
    await adapter.close();
  }
}

// Run as a script (the bin, `node harness.mjs`), not when imported by the tests: compared by real path, since Node
// resolves the main module through symlinks (macOS's /var → /private/var) and argv[1] is what the shell typed.
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message);
      process.exit(2);
    },
  );
}
