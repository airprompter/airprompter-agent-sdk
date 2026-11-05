// The TypeScript SDK through the harness's adapter contract (ADAPTER.md):
// `@airprompter/agent-sdk/core` for the protocol, `/telemetry` for the spool,
// `@airprompter/agent-otel/exporter` for the OTLP mapping — from the built
// dist, so this adapter runs on plain Node after `node
// sdk-typescript/scripts/build.mjs`. What `run.mjs` proves for the reference,
// this proves for the packages a customer installs.
//
//   $ node sdk-typescript/scripts/build.mjs
//   $ node conformance/harness.mjs --adapter conformance/adapters/agent-sdk.mjs

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// A file URL, not a path: Windows's `D:\…` is not an import specifier.
const dist = (pkg, subpath) => pathToFileURL(join(here, "..", "..", "sdk-typescript", "packages", pkg, "dist", "esm", subpath, "index.js")).href;

const core = await import(dist("sdk", "core"));
const telemetry = await import(dist("sdk", "telemetry"));
const exporter = await import(dist("agent-otel", "exporter"));

/** A refusal the protocol names travels as `{ reason }`. */
const refusing = (fn) => (args) => {
  try {
    return fn(args);
  } catch (error) {
    if (error && typeof error.reason === "string") {
      const e = new Error(error.message);
      e.reason = error.reason;
      throw e;
    }
    throw error;
  }
};

export const ops = {
  audiencePredicate: ({selector,tags}) => ({valid:core.validAudienceSelector(selector), matches:core.matchesAudience(selector,tags)}),
  audienceValidator: ({kind,value}) => ({valid:kind === "key" ? core.validAudienceKey(value) : kind === "label" ? core.validAudienceLabel(value) : core.validAudienceInstant(value)}),
  canonicalJson: refusing(({ json }) => {
    const text = core.canonicalJson(JSON.parse(json));
    return { text, sha256: core.sha256Prefixed(Buffer.from(text, "utf8")) };
  }),
  orderedSteps: refusing(({ slotTag, steps }) => ({ order: core.orderedSteps(slotTag, steps).map((s) => s.stepId) })),
  assignArm: refusing(({ salt, subject, arms }) => {
    const r = core.assignArm({ salt, subject, arms });
    return { subjectHash: r.subjectHash, bucket: r.bucket, arm: typeof r.arm === "string" ? r.arm : r.arm.arm };
  }),
  validateRamp: refusing(({ ramp, armCount }) => {
    core.validateRamp(ramp, armCount);
    return { ok: true };
  }),
  rampWeightsAt: ({ arms, ramp, nowMs }) => ({ weightBps: core.rampWeightsAt(arms, ramp, nowMs) }),
  effectiveArms: ({ arms, ramp, disabledArms, nowMs }) => ({ arms: core.effectiveArms({ arms, ramp, disabledArms: new Set(disabledArms ?? []), nowMs }) }),
  verifyRootMetadata: ({ candidate, trusted, pinned, now }) => core.verifyRootMetadata({ candidate, trusted: trusted ?? core.trustedRootFromPinnedKey({ purpose: pinned.purpose, environment: pinned.environment, pinnedRoot: pinned.pinnedRoot }), now }),
  servableSlots: ({ payload, tags }) => ({ frozen: (Array.isArray(payload.experiments) ? payload.experiments : []).map((experiment) => experiment.tag).filter((tag) => core.frozenExperiment(payload, (id) => new Set(core.disabledFrom(payload.directives).armsByExperiment[id] ?? []), tag, tags ?? {})).sort(), tags: core.servableSlots(payload).map((slot) => slot.tag), overrides: Object.fromEntries(core.servableExperiments(payload).map((experiment) => [experiment.experimentId, Object.fromEntries(experiment.arms.map((arm) => [arm.arm, arm.overrides.map((override) => override.tag)]))])) }),
  inspectSegment: ({ instanceId, lines, nowMs }) => {
    const { rows, invalid, skipped, stripped } = telemetry.inspectSegment(Buffer.from(lines.map((line) => `${line}\n`).join(""), "utf8"), instanceId, nowMs);
    return { rows, invalid, skipped, stripped };
  },
  runRefKeyFrom: ({ secret, agentId, target }) => ({ keyHex: Buffer.from(core.runRefKeyFrom(secret, agentId, target)).toString("hex") }),
  mintRunRef: refusing(({ facts, keyHex }) => {
    try {
      return { token: core.mintRunRef(facts, Buffer.from(keyHex, "hex")) };
    } catch (error) {
      throw Object.assign(error, { reason: error.message });
    }
  }),
  parseRunRef: ({ token, keysHex }) => ({ facts: core.parseRunRef(token, keysHex.map((hex) => Buffer.from(hex, "hex"))) }),
  experimentConflict: ({ payload }) => ({ reason: core.experimentConflict(payload) }),
  carriedPayloads: ({ payload }) => ({ carried: [...core.carriedPayloads(payload)].sort(([a], [b]) => (a < b ? -1 : 1)), optional: [...core.optionalPayloads(payload)].sort() }),
  verifyManifest: ({ manifest, root, now, scope, storedGeneration, payloads, countersignRoot, requireCountersign, carrying, absentRequires }) => core.verifyManifest({ manifest, root, now, scope, storedGeneration, carrying: carrying === true, absentRequires: absentRequires === true, payloads: payloads ? new Map(payloads.map((p) => [p.contentHash, Buffer.from(p.bytes, "base64url")])) : null, countersignRoot: countersignRoot ?? null, requireCountersign: requireCountersign ?? false }),
  latencyBucketIndex: ({ latencyMs }) => ({ bucket: core.latencyBucketIndex(latencyMs) }),
  minuteOf: ({ epochMs }) => ({ minute: core.minuteOf(epochMs), epochMinute: core.epochMinute(epochMs) }),
  segmentName: ({ instanceId, epochMs, n }) => ({ name: telemetry.segmentName(instanceId, core.epochMinute(epochMs), n) }),
  planSegments: ({ instanceId, appends }) => {
    const planner = new telemetry.SegmentPlanner(instanceId);
    return { plan: appends.map((a) => planner.append(a.epochMs, a.lineBytes)) };
  },
  aggregateWindows: ({ instanceId, instanceClass, sdk, events }) => {
    const sink = new telemetry.MemorySink();
    const writer = new telemetry.SpoolWriter(sink, { instanceId, instanceClass, sdk });
    for (const event of events) {
      if (event.kind === "observe") writer.observe(event.observation, event.at);
      else if (event.kind === "recordRun") writer.recordRun(event.run, event.at);
      else if (event.kind === "recordStep") writer.recordStep(event.step, event.at);
      else if (event.kind === "feedback") writer.outcomes(event.feedback, event.feedback.outcomes, event.at);
      else if (event.kind === "close") writer.closeWindows(event.at);
    }
    const rows = sink.drain();
    return { windows: rows.filter((r) => r.type === "window"), steps: rows.filter((r) => r.type === "step") };
  },
  normalizeFeedback: ({ signals }) => ({ normalized: core.normalizeFeedback(signals) }),
  evaluateChecks: ({ checks, input }) => ({ evaluation: core.evaluateChecks(checks, input) }),
  patternRefusal: ({ pattern }) => ({ refusal: core.patternRefusal(pattern) ?? null }),
  checksRefusals: ({ checks }) => ({ refusals: core.checksRefusals(checks) }),
  projectChecks: ({ checks }) => ({ projected: core.projectChecks(checks) }),
  spoolRowsToOtlp: ({ rows, resource, sdkVersion }) => ({ request: exporter.spoolRowsToOtlp(rows, { resource, ...(sdkVersion ? { sdkVersion } : {}) }) }),
};

export default ops;
