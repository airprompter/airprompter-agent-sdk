// Section `frameworks`: every fixture under fixtures/ checked against
// fixture.schema.json, the coverage rule for the adapter's language, and
// each fixture in that language run through the adapter's `driveRun`: the
// real framework with the AirPrompter adapter in place, over the recorded
// turns, on a fake clock. The harness seals the release and parses the run
// references; the adapter reports what the provider saw and what was written.
//
//   $ node harness.mjs --adapter adapters/agent-sdk.mjs --only frameworks
//
// `driveRun({ fixture, bundle, agent })` → `{ placements, calls, runRefs, rows, steps, runCounters, log, state }`.

import { parseRunRef, runRefKeyFrom } from "../../reference.mjs";
import { newSealer } from "../release.mjs";

/** The agent every fixture runs on: one scope (a `dev` target: plaintext bundles are its opt-in), one run-reference secret, one clock start. */
export const FIXTURE_AGENT = { organizationId: "org_conformance", agentId: "agt_conformance", target: "dev", runRefSecret: "conformance-run-ref-secret-0001", t0: 1789300800000, idleTimeoutMs: 900000 };

export default {
  section: "frameworks",
  operations: ["driveRun"],
  slow: ["driveRun"],
  async run({ adapter, ok, fail, helpers }) {
    const { schemaErrors, loadFixtures, coverageGaps, subsetMatches, matchRowSet, sameJson, short } = helpers;
    const language = adapter.language;
    if (!language) return fail("frameworks", "the adapter names no language (capabilities `language`: ts or py), so its fixtures cannot be chosen");
    const fixtures = loadFixtures();
    const valid = [];
    for (const entry of fixtures) {
      const problem = entry.error ?? schemaErrors("fixture", entry.fixture);
      if (problem) fail(`fixture ${entry.file}`, `fails fixture.schema.json: ${problem}`);
      else if (entry.fixture.framework !== entry.folder) fail(`fixture ${entry.file}`, `framework ${entry.fixture.framework} sits in folder ${entry.folder}`);
      // `<kind>-<case>-<language>.json`, or `<kind>-<language>.json`: the name says what the coverage rule counts.
      else if (!entry.name.startsWith(`${entry.fixture.kind}-`) || !entry.name.endsWith(`-${entry.fixture.language}.json`)) fail(`fixture ${entry.file}`, `the file name must be ${entry.fixture.kind}-<case>-${entry.fixture.language}.json`);
      else valid.push(entry);
    }
    const gaps = coverageGaps(valid, { language });
    for (const gap of gaps) fail(`coverage: ${gap.framework} (${gap.language})`, gap.detail ?? `no fixture of kind ${gap.kind}`);
    const frameworks = [...new Set(valid.filter((e) => e.fixture.language === language).map((e) => e.folder))];
    if (gaps.length === 0) {
      const exempt = Object.entries(helpers.EXEMPTIONS).filter(([key]) => key.endsWith(`/${language}`)).map(([key, kinds]) => `${key.split("/")[0]}: ${Object.keys(kinds).join(" ")}`);
      ok(`coverage: every ${language} framework (fixtures: ${frameworks.join(", ") || "none"}) has every kind it requires${exempt.length ? `, but for the exempt ${exempt.join("; ")}` : ""}`);
    }

    const key = runRefKeyFrom(FIXTURE_AGENT.runRefSecret, FIXTURE_AGENT.agentId, FIXTURE_AGENT.target);
    for (const { file, fixture } of valid.filter((e) => e.fixture.language === language)) {
      const label = `${fixture.framework} ${fixture.kind}: ${file}`;
      const sealer = newSealer({ organizationId: FIXTURE_AGENT.organizationId, agentId: FIXTURE_AGENT.agentId, target: FIXTURE_AGENT.target });
      const bundle = fixture.release ? sealer.seal(fixture.release, { nowMs: FIXTURE_AGENT.t0 }) : null;
      const pkg = helpers.FRAMEWORK_PACKAGES[fixture.framework]?.[fixture.language];
      const answer = await adapter.call("driveRun", { fixture, bundle, agent: { ...FIXTURE_AGENT, rootPublicJwk: sealer.rootPublicJwk }, ...(pkg ? { package: pkg } : {}) });
      if (answer.error) {
        fail(label, `driveRun refused: ${answer.error.reason} ${answer.error.message ?? ""}`.trim());
        continue;
      }
      const r = answer.result;
      const misses = [];
      const miss = (where, detail) => misses.push([where, detail]);
      // The fixture says what it was recorded from; the run says what ran. On the pinned lanes they are one version.
      const latest = process.env.AIRPROMPTER_FRAMEWORKS_LATEST === "1";
      if (pkg && !latest && r.frameworkVersion !== fixture.frameworkVersion) miss("frameworkVersion", `${pkg} ${r.frameworkVersion ?? "(not reported)"} is installed; the fixture was recorded from ${fixture.frameworkVersion}`);
      const expect = fixture.expect;
      const ordered = (name, actual, expected) => {
        if (!Array.isArray(actual)) return miss(name, `the adapter reported no ${name}`);
        if (actual.length !== expected.length) miss(`${name}.length`, `${actual.length}, expected ${expected.length}: ${short(actual)}`);
        expected.forEach((want, i) => {
          if (i < actual.length && !subsetMatches(actual[i], want)) miss(`${name}[${i}]`, `got ${short(actual[i])}, expected ${short(want)}`);
          // Settings a call names are the call's settings, exactly: a key the release did not seal must not ride along.
          else if (i < actual.length && want?.settings !== undefined && !sameJson(actual[i].settings, want.settings)) miss(`${name}[${i}].settings`, `got ${short(actual[i].settings)}, expected exactly ${short(want.settings)}`);
        });
      };
      if (expect.placements) ordered("placements", r.placements, expect.placements);
      if (expect.calls) ordered("calls", r.calls, expect.calls);
      if (expect.runRef) {
        const facts = (r.runRefs ?? []).map((token) => (typeof token === "string" ? parseRunRef(token, [key]) : null));
        if (facts.length === 0 || facts.some((f) => f === null)) miss("runRef", `${facts.length} references, ${facts.filter((f) => f === null).length} that do not verify`);
        else {
          const last = facts[facts.length - 1];
          if (expect.runRef.entries !== undefined && last.entries.length !== expect.runRef.entries) miss("runRef.entries", `${last.entries.length}, expected ${expect.runRef.entries}`);
          if (expect.runRef.count !== undefined && facts.length !== expect.runRef.count) miss("runRef.count", `${facts.length} references, expected ${expect.runRef.count}`);
          if (expect.runRef.runIdStable && new Set(facts.map((f) => f.runId)).size !== 1) miss("runRef.runIdStable", `run ids ${short(facts.map((f) => f.runId))}`);
        }
      }
      if (expect.rows) {
        const verdict = matchRowSet(r.rows ?? [], expect.rows, "row");
        if (verdict !== true) miss("rows", verdict);
      }
      if (expect.steps) {
        const verdict = matchRowSet(r.steps ?? [], expect.steps, "step row");
        if (verdict !== true) miss("steps", verdict);
      }
      if (expect.results && !subsetMatches(r.results, expect.results)) miss("results", `got ${short(r.results)}, expected ${short(expect.results)}`);
      if (expect.runCounters && !sameJson(r.runCounters, expect.runCounters)) miss("runCounters", `got ${short(r.runCounters)}, expected ${short(expect.runCounters)}`);
      // An adapter that reports no log cannot pass an `events` expectation, a count of 0 included.
      if (expect.events && !Array.isArray(r.log)) miss("events", "the adapter reported no log");
      else for (const [name, want] of Object.entries(expect.events ?? {})) {
        const named = r.log.filter((event) => event?.event === name);
        const count = typeof want === "number" ? want : want.count;
        if (named.length !== count) miss(`events.${name}`, `${named.length} logged, expected ${count}`);
        else if (typeof want === "object") {
          const off = named.find((event) => !subsetMatches(event, want.fields));
          if (off) miss(`events.${name}`, `got ${short(off)}, expected every one to carry ${short(want.fields)}`);
        }
      }
      if (expect.stateExcludes) {
        if (r.state === undefined) miss("state", "the adapter reported no framework state");
        const text = JSON.stringify(r.state ?? null);
        for (const needle of expect.stateExcludes) if (text.includes(needle)) miss("state", `framework state written by AirPrompter contains ${short(needle)}`);
      }
      const ran = latest && pkg ? ` (${pkg} ${r.frameworkVersion ?? "?"})` : "";
      if (misses.length === 0) ok(`${label}${ran}`);
      else for (const [where, detail] of misses) fail(`${label}${ran} › ${where}`, detail);
    }
  },
};
