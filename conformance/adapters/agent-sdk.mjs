// The TypeScript SDK through the harness's adapter contract (ADAPTER.md):
// `@airprompter/agent-core` for the protocol, `@airprompter/agent-telemetry`
// for the spool, `@airprompter/otel-bridge` for the OTLP mapping — from the
// built dist, so this adapter runs on plain Node after `node
// sdk-typescript/scripts/build.mjs`. What `run.mjs` proves for the reference,
// this proves for the packages a customer installs.
//
//   node conformance/harness.mjs --adapter conformance/adapters/agent-sdk.mjs

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dist = (pkg) => join(here, "..", "..", "sdk-typescript", "packages", pkg, "dist", "esm", "index.js");

const core = await import(dist("core"));
const telemetry = await import(dist("telemetry"));
const bridge = await import(dist("otel-bridge"));

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
  verifyManifest: ({ manifest, root, now, scope, storedGeneration, payloads, countersignRoot, requireCountersign }) => core.verifyManifest({ manifest, root, now, scope, storedGeneration, payloads: payloads ? new Map(payloads.map((p) => [p.contentHash, Buffer.from(p.bytes, "base64url")])) : null, countersignRoot: countersignRoot ?? null, requireCountersign: requireCountersign ?? false }),
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
      else if (event.kind === "feedback") writer.outcomes(event.feedback, event.feedback.outcomes, event.at);
      else if (event.kind === "close") writer.closeWindows(event.at);
    }
    return { windows: sink.drain().filter((r) => r.type === "window") };
  },
  normalizeFeedback: ({ signals }) => ({ normalized: core.normalizeFeedback(signals) }),
  evaluateChecks: ({ checks, input }) => ({ evaluation: core.evaluateChecks(checks, input) }),
  patternRefusal: ({ pattern }) => ({ refusal: core.patternRefusal(pattern) ?? null }),
  checksRefusals: ({ checks }) => ({ refusals: core.checksRefusals(checks) }),
  projectChecks: ({ checks }) => ({ projected: core.projectChecks(checks) }),
  spoolRowsToOtlp: ({ rows, resource, sdkVersion }) => ({ request: bridge.spoolRowsToOtlp(rows, { resource, ...(sdkVersion ? { sdkVersion } : {}) }) }),
};

export default ops;
