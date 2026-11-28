// Section `run-session`: every vector in vectors/run-session.json through the
// adapter's `sessionScenario`, and the SDK's reason list against
// vectors/placement-reasons.json through `unavailableReasons`. The harness
// seals each release (release.mjs) and parses every run reference itself
// (reference.mjs), so what is judged is what the SDK wrote and minted, not
// what it says about it.
//
//   $ node harness.mjs --adapter adapters/agent-sdk.mjs --only run-session --json > ts.json
//   $ node harness.mjs --adapter-command "python …/adapter.py" --only run-session --compare ts.json
//
// Every deterministic vector's rows must equal, as the bytes the spool would
// write (numbers by their digits, never as JavaScript reads them), the rows in
// vectors/run-session.rows.json: both SDKs are held to one record, so neither
// drifts. `--write-golden` rewrites that file from this adapter's run (review
// the diff); `--compare <report.json>` also holds the rows to another
// adapter's `--json` report.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseRunRef, runRefKeyFrom } from "../../reference.mjs";
import { newSealer } from "../release.mjs";

/** Fields that name the process, not the run: left out of a cross-language comparison. */
const PROCESS_FIELDS = new Set(["instanceId", "sdk", "instanceClass"]);
const NUMBER = "\u0000n:";

/**
 * Lines as the spool wrote them, made comparable: parsed keeping every number's own digits (JSON.parse's source
 * text), the process's fields dropped, keys sorted. `1` and `1.0`, or two integers past 2^53 one double apart, differ.
 */
export function comparableLines(lines) {
  const keep = (key, value, context) => {
    if (typeof value !== "number") return value;
    // JSON.parse hands a reviver the source text from Node 21 on; without it the digits are gone, so refuse rather than compare doubles.
    if (typeof context?.source !== "string") throw new Error("comparing rows by their digits needs JSON.parse source text (Node 21 or later)");
    return `${NUMBER}${context.source}`;
  };
  const canonical = (value) => (Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}` : typeof value === "string" && value.startsWith(NUMBER) ? value.slice(NUMBER.length) : JSON.stringify(value));
  return lines
    .map((line) => JSON.parse(line, keep))
    .map((row) => canonical(Object.fromEntries(Object.entries(row).filter(([key]) => !PROCESS_FIELDS.has(key)))))
    .sort();
}

function differs(mine, theirs, what) {
  const a = [...mine.rows, ...mine.steps, ...mine.refusals];
  const b = [...theirs.rows, ...theirs.steps, ...(theirs.refusals ?? [])];
  const only = a.find((row) => !b.includes(row));
  const missing = b.find((row) => !a.includes(row));
  if (only) return `this adapter wrote ${only.length > 300 ? `${only.slice(0, 297)}…` : only}, which ${what} has not`;
  if (missing) return `${what} has ${missing.length > 300 ? `${missing.slice(0, 297)}…` : missing}, which this adapter did not write`;
  return `${a.length} rows here, ${b.length} in ${what}`;
}

/** The script the adapter runs: releases sealed into bundles at the step's instant on the vector's clock. */
export function scriptOf(vector, file, sealer) {
  const named = (ref) => (typeof ref === "string" ? file.releases[ref] ?? (() => { throw new Error(`no release ${ref}`); })() : ref);
  let now = file.agent.t0;
  let current = vector.release === null ? null : named(vector.release);
  const bundle = current ? sealer.seal(current, { nowMs: now }) : null;
  const steps = vector.steps.map((step) => {
    if (step.op === "advance") now += step.ms;
    if (step.op === "swapRelease") {
      current = named(step.release);
      return { ...step, release: undefined, bundle: sealer.seal(current, { nowMs: now }) };
    }
    if (step.op === "applyDirective") {
      if (!current) throw new Error("applyDirective with no release");
      current = { ...current, directives: [...(current.directives ?? []), ...step.directives] };
      return { ...step, bundle: sealer.seal(current, { nowMs: now }) };
    }
    return step;
  });
  return { agent: { ...file.agent, rootPublicJwk: sealer.rootPublicJwk }, bundle, variableSources: vector.variableSources ?? {}, steps };
}

const placementFields = ["kind", "slot", "reason", "instructions", "model", "settings"];
const placementOf = (p) => (p && typeof p === "object" ? Object.fromEntries(placementFields.filter((k) => k in p).map((k) => [k, p[k]])) : p);

export default {
  section: "run-session",
  operations: ["sessionScenario", "unavailableReasons"],
  slow: ["sessionScenario"],
  async run({ adapter, ok, fail, report, options, helpers }) {
    const { schemaErrors, subsetMatches, matchRowSet, sameJson, short, readJson, VECTORS_DIR } = helpers;

    const reasons = readJson(join(VECTORS_DIR, "placement-reasons.json")).reasons;
    const listed = await adapter.call("unavailableReasons", {});
    if (listed.error) fail("placement reasons", `unavailableReasons refused: ${listed.error.reason}`);
    else if (sameJson(listed.result.reasons, reasons)) ok(`placement reasons: the SDK's ${reasons.length} reasons equal placement-reasons.json`);
    else fail("placement reasons", `got ${short(listed.result.reasons)}, expected ${short(reasons)}`);

    const file = readJson(join(VECTORS_DIR, "run-session.json"));
    const invalid = schemaErrors("vectors", file);
    if (invalid) return fail("vectors/run-session.json", `fails vector.schema.json: ${invalid}`);
    const key = runRefKeyFrom(file.agent.runRefSecret, file.agent.agentId, file.agent.target);
    const other = options.compare ? JSON.parse(readFileSync(options.compare, "utf8")).sessionRows ?? {} : null;
    const goldenPath = join(VECTORS_DIR, "run-session.rows.json");
    const golden = !options.writeGolden && existsSync(goldenPath) ? readJson(goldenPath).vectors : null;
    if (!options.writeGolden && !golden) fail("vectors/run-session.rows.json", "missing: write it with --write-golden from the TypeScript adapter, and review it");
    report.sessionRows ??= {};

    for (const vector of file.vectors) {
      const label = `rule ${vector.rule}: ${vector.name}`;
      let script;
      try {
        script = scriptOf(vector, file, newSealer({ organizationId: file.agent.organizationId, agentId: file.agent.agentId, target: file.agent.target }));
      } catch (error) {
        fail(label, `the vector cannot be sealed: ${error.message}`);
        continue;
      }
      const answer = await adapter.call("sessionScenario", script);
      if (answer.error) {
        fail(label, `sessionScenario refused: ${answer.error.reason} ${answer.error.message ?? ""}`.trim());
        continue;
      }
      const r = answer.result;
      const misses = [];
      const miss = (where, detail) => misses.push(`${where}: ${detail}`);
      const results = Array.isArray(r.results) ? r.results : [];
      if (results.length !== vector.steps.length) miss("results", `${results.length} answers for ${vector.steps.length} steps`);
      const openRefs = {};
      const decode = (token) => (typeof token === "string" ? parseRunRef(token, [key]) : null);

      vector.steps.forEach((step, i) => {
        const at = `step ${i} ${step.op}${step.run ? ` ${step.run}` : ""}`;
        const got = results[i] ?? {};
        if (got.error) return miss(at, `threw ${got.error}`);
        const expect = step.expect ?? {};
        const judgePlacement = (placement) => {
          const { sameAs, ...fields } = expect;
          if (!subsetMatches(placementOf(placement), fields)) return `got ${short(placementOf(placement))}, expected ${short(fields)}`;
          if (sameAs !== undefined && !sameJson(placementOf(placement), placementOf(results[sameAs]?.placement))) return `got ${short(placementOf(placement))}, step ${sameAs} got ${short(placementOf(results[sameAs]?.placement))}`;
          return true;
        };
        switch (step.op) {
          case "open":
            openRefs[step.run] = got.runRef;
            if (!decode(got.runRef)) miss(at, "the run reference does not verify under the agent's key");
            break;
          case "place":
          case "decline": {
            if (step.concurrent) {
              const all = got.placements ?? [];
              if (all.length !== step.concurrent) miss(at, `${all.length} answers for ${step.concurrent} concurrent calls`);
              if (!all.every((p) => sameJson(placementOf(p), placementOf(all[0])))) miss(at, `concurrent calls answered differently: ${short(all.map(placementOf))}`);
              const verdict = judgePlacement(all[0]);
              if (verdict !== true) miss(at, verdict);
            } else {
              const verdict = judgePlacement(got.placement);
              if (verdict !== true) miss(at, verdict);
            }
            break;
          }
          case "slotFor":
            if ((got.slot ?? null) !== expect.slot) miss(at, `got ${short(got.slot ?? null)}, expected ${short(expect.slot)}`);
            break;
          case "feedback":
            if (got.filed !== expect.filed) miss(at, `filed ${got.filed}, expected ${expect.filed}`);
            break;
          case "explain":
          case "ref": {
            const facts = step.op === "ref" ? decode(got.token) : null;
            const entries = step.op === "ref" ? (facts ? facts.entries : null) : got.entries ?? null;
            if (step.op === "ref" && !facts) {
              miss(at, "the run reference does not verify under the agent's key");
              break;
            }
            if ("entries" in expect) {
              if (expect.entries === null ? entries !== null : !(Array.isArray(entries) && entries.length === expect.entries.length && expect.entries.every((want, j) => subsetMatches(entries[j], want)))) miss(at, `entries ${short(entries)}, expected ${short(expect.entries)}`);
            }
            if (expect.entryCount !== undefined && entries?.length !== expect.entryCount) miss(at, `${entries?.length ?? "no"} entries, expected ${expect.entryCount}`);
            if (expect.runIdOf && facts?.runId !== decode(openRefs[expect.runIdOf])?.runId) miss(at, `runId ${facts?.runId} is not ${expect.runIdOf}'s ${decode(openRefs[expect.runIdOf])?.runId}`);
            if (expect.runIdNotOf && facts?.runId === decode(openRefs[expect.runIdNotOf])?.runId) miss(at, `runId is ${expect.runIdNotOf}'s`);
            if (expect.excludes) {
              const body = Buffer.from(String(got.token).slice(0, String(got.token).lastIndexOf(".")), "base64url").toString("utf8");
              for (const text of expect.excludes) if (body.includes(text)) miss(at, `the decoded reference contains ${short(text)}`);
            }
            break;
          }
          case "sample": {
            const texts = new Set((got.placements ?? []).map((p) => (p?.kind === "approved" ? p.instructions : `passthrough:${p?.reason}`)));
            if ((got.placements ?? []).length !== step.runs) miss(at, `${(got.placements ?? []).length} runs, expected ${step.runs}`);
            if (expect.distinct !== undefined && texts.size !== expect.distinct) miss(at, `${texts.size} distinct placements (${short([...texts])}), expected ${expect.distinct}`);
            break;
          }
          default:
            break;
        }
      });

      const rows = Array.isArray(r.rows) ? r.rows : [];
      const stepRows = Array.isArray(r.steps) ? r.steps : [];
      const expect = vector.expect ?? {};
      if (expect.rows) {
        const verdict = matchRowSet(rows, expect.rows, "row");
        if (verdict !== true) miss("rows", verdict);
      }
      if (expect.steps) {
        const verdict = matchRowSet(stepRows, expect.steps, "step row");
        if (verdict !== true) miss("step rows", verdict);
      }
      if (expect.rowCount !== undefined) {
        const counted = rows.filter((row) => row.count > 0).length;
        if (counted !== expect.rowCount) miss("rowCount", `${counted} rows with a count, expected ${expect.rowCount}`);
      }
      if (expect.agentRuns !== undefined) {
        const runs = rows.reduce((sum, row) => sum + (row.agentRun ?? 0), 0);
        if (runs !== expect.agentRuns) miss("agentRuns", `${runs} runs counted, expected ${expect.agentRuns}`);
      }
      if (expect.runCounters && !sameJson(r.runCounters, expect.runCounters)) miss("runCounters", `got ${short(r.runCounters)}, expected ${short(expect.runCounters)}`);
      const log = Array.isArray(r.log) ? r.log : [];
      for (const [name, count] of Object.entries(expect.events ?? {})) {
        const seen = log.filter((event) => event?.event === name).length;
        if (seen !== count) miss(`events ${name}`, `${seen} logged, expected ${count}`);
      }
      if (expect.logExcludes) {
        const text = JSON.stringify(log);
        for (const needle of expect.logExcludes) if (text.includes(needle)) miss("log", `an event contains ${short(needle)}`);
      }
      if (expect.sourceCalls && !sameJson(r.sourceCalls ?? {}, expect.sourceCalls)) miss("sourceCalls", `got ${short(r.sourceCalls)}, expected ${short(expect.sourceCalls)}`);

      // The spool's own lines, refusal rows (a lapsed lease, a disable's stamp) too: both SDKs must stamp the same refusals.
      const wire = r.wire ?? {};
      if (!Array.isArray(wire.rows) || !Array.isArray(wire.steps) || !Array.isArray(wire.refusals)) miss("wire", "the adapter answered no `wire` lines (rows, steps, refusals as the spool writes them)");
      else if (vector.deterministic !== false) {
        const comparable = { rows: comparableLines(wire.rows), steps: comparableLines(wire.steps), refusals: comparableLines(wire.refusals) };
        report.sessionRows[vector.name] = comparable;
        if (golden) {
          if (!golden[vector.name]) miss("golden", "vectors/run-session.rows.json has no rows for this vector: rewrite it with --write-golden");
          else if (!sameJson(golden[vector.name], comparable)) miss("golden", differs(comparable, golden[vector.name], "run-session.rows.json"));
        }
        if (other) {
          if (!other[vector.name]) miss("compare", "the other report has no rows for this vector");
          else if (!sameJson(other[vector.name], comparable)) miss("compare", differs(comparable, other[vector.name], "the other report"));
        }
      }

      if (misses.length === 0) ok(label);
      else for (const detail of misses) fail(`${label} › ${detail.split(": ")[0]}`, detail.slice(detail.indexOf(": ") + 2));
    }
    if (options.writeGolden) {
      const description = "The rows every deterministic vector in run-session.json writes, as the spool writes them (numbers by their digits; instanceId, sdk and instanceClass left out). Generated by `node harness.mjs --adapter adapters/agent-sdk.mjs --only run-session --write-golden` and reviewed; both SDKs must write exactly these.";
      writeFileSync(goldenPath, `${JSON.stringify({ description, vectors: report.sessionRows }, null, 1)}\n`);
      ok(`wrote ${Object.keys(report.sessionRows).length} vectors' rows to vectors/run-session.rows.json`);
    }
  },
};
