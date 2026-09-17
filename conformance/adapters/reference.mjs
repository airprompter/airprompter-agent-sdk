// The reference implementations behind the harness's adapter contract
// (ADAPTER.md). This is the adapter every other one is measured against:
// `node harness.mjs --adapter adapters/reference.mjs` must pass every
// section, and an SDK's adapter answers the same calls the same way.
//
//   $ node conformance/harness.mjs --adapter conformance/adapters/reference.mjs
//   $ node conformance/harness.mjs --adapter conformance/adapters/reference.mjs --only canonical-json,trust-manifest --json

import { AssignmentError, CanonicalJsonError, assignArm, canonicalJson, effectiveArms, orderedSteps, rampWeightsAt, sha256Prefixed, validateRamp } from "../reference.mjs";
import { experimentConflict, experimentsOf, trustedRootFromPinnedKey, verifyManifest, verifyRootMetadata } from "../trust.mjs";
import { SegmentPlanner, WindowAggregator, epochMinute, latencyBucketIndex, minuteOf, normalizeFeedback, segmentName } from "../spool.mjs";
import { checksRefusals, evaluateChecks, patternRefusal, projectChecks } from "../checks.mjs";
import { spoolRowsToOtlp } from "../otel.mjs";

/** A refusal the protocol names travels as `{ reason }`; the harness compares reasons, never messages. */
const refusal = (error) => {
  if (error instanceof CanonicalJsonError || error instanceof AssignmentError || (error && typeof error.reason === "string")) {
    const e = new Error(error.message);
    e.reason = error.reason;
    throw e;
  }
  throw error;
};

export const ops = {
  canonicalJson({ json }) {
    try {
      const text = canonicalJson(JSON.parse(json));
      return { text, sha256: sha256Prefixed(Buffer.from(text, "utf8")) };
    } catch (error) {
      refusal(error);
    }
  },
  orderedSteps({ slotTag, steps }) {
    try {
      return { order: orderedSteps(slotTag, steps).map((s) => s.stepId) };
    } catch (error) {
      refusal(error);
    }
  },
  assignArm({ salt, subject, arms }) {
    try {
      return assignArm({ salt, subject, arms });
    } catch (error) {
      refusal(error);
    }
  },
  validateRamp({ ramp, armCount }) {
    try {
      validateRamp(ramp, armCount);
      return { ok: true };
    } catch (error) {
      refusal(error);
    }
  },
  rampWeightsAt({ arms, ramp, nowMs }) {
    return { weightBps: rampWeightsAt(arms, ramp, nowMs) };
  },
  effectiveArms({ arms, ramp, disabledArms, nowMs }) {
    return { arms: effectiveArms({ arms, ramp, disabledArms: new Set(disabledArms ?? []), nowMs }) };
  },
  verifyRootMetadata({ candidate, trusted, pinned, now }) {
    const trustedRoot = trusted ?? trustedRootFromPinnedKey({ purpose: pinned.purpose, environment: pinned.environment, pinnedRootJwk: pinned.pinnedRoot });
    return verifyRootMetadata({ candidate, trusted: trustedRoot, now });
  },
  experimentForTag({ payload, tag }) {
    const listed = Array.isArray(payload.experiments) ? payload.experiments.find((e) => e.tag === tag) ?? null : (experimentsOf(payload)[0] ?? null);
    return { experiment: listed };
  },
  experimentConflict({ payload }) {
    return { reason: experimentConflict(payload) };
  },
  verifyManifest({ manifest, root, now, scope, storedGeneration, payloads, countersignRoot, requireCountersign }) {
    return verifyManifest({ manifest, root, now, scope, storedGeneration, payloads: payloads ? new Map(payloads.map((p) => [p.contentHash, Buffer.from(p.bytes, "base64url")])) : null, countersignRoot: countersignRoot ?? null, requireCountersign: requireCountersign ?? false });
  },
  latencyBucketIndex({ latencyMs }) {
    return { bucket: latencyBucketIndex(latencyMs) };
  },
  minuteOf({ epochMs }) {
    return { minute: minuteOf(epochMs), epochMinute: epochMinute(epochMs) };
  },
  segmentName({ instanceId, epochMs, n }) {
    return { name: segmentName(instanceId, epochMinute(epochMs), n) };
  },
  planSegments({ instanceId, appends }) {
    const planner = new SegmentPlanner(instanceId);
    return { plan: appends.map((a) => planner.append(a.epochMs, a.lineBytes)) };
  },
  aggregateWindows({ instanceId, instanceClass, sdk, events }) {
    const aggregator = new WindowAggregator({ instanceId, instanceClass, sdk });
    for (const event of events) {
      if (event.kind === "observe") aggregator.observe(event.at, event.observation);
      else if (event.kind === "feedback") aggregator.outcomes(event.at, event.feedback);
      else if (event.kind === "close") aggregator.close(event.at);
    }
    return { windows: aggregator.emitted };
  },
  normalizeFeedback({ signals }) {
    return { normalized: normalizeFeedback(signals) };
  },
  evaluateChecks({ checks, input }) {
    return { evaluation: evaluateChecks(checks, input) };
  },
  patternRefusal({ pattern }) {
    return { refusal: patternRefusal(pattern) ?? null };
  },
  checksRefusals({ checks }) {
    return { refusals: checksRefusals(checks) };
  },
  projectChecks({ checks }) {
    return { projected: projectChecks(checks) };
  },
  spoolRowsToOtlp({ rows, resource, sdkVersion }) {
    return { request: spoolRowsToOtlp(rows, { resource, ...(sdkVersion ? { sdkVersion } : {}) }) };
  },
};

export default ops;
