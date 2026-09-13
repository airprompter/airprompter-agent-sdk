#!/usr/bin/env node
// Protocol conformance: schemas compile, examples validate (and the refused
// ones do not), the semantic rules the schema cannot express hold on every
// example manifest, and the reference implementations pass every vector.
// Exit code 1 on the first failing section; every check in a section runs.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  AssignmentError,
  CanonicalJsonError,
  assignArm,
  canonicalJson,
  orderedSteps,
  releaseDigest,
  sha256Prefixed,
  validateArms,
  decodeBase64Url,
  effectiveArms,
  rampWeightsAt,
  validateRamp,
} from "./reference.mjs";
import { trustedRootFromPinnedKey, verifyManifest, verifyRootMetadata } from "./trust.mjs";
import { LATENCY_BUCKET_EDGES_MS, SEGMENT_MAX_BYTES, SegmentPlanner, WindowAggregator, epochMinute, latencyBucketIndex, minuteOf, normalizeFeedback, segmentName } from "./spool.mjs";
import { checksRefusals, evaluateChecks, patternRefusal, projectChecks } from "./checks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const protocolDir = join(here, "..", "protocol");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

let failures = 0;
const ok = (label) => console.log(`  ok   ${label}`);
const fail = (label, detail) => {
  failures += 1;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
};
const section = (title) => console.log(`\n${title}`);

// ---------------------------------------------------------------------------
section("schemas compile (draft 2020-12)");
// strictRequired is an ajv lint opinion (a `then: { required }` next to its `properties`), not a spec rule.
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true, allowUnionTypes: true });
addFormats(ajv);
const schemaDir = join(protocolDir, "schemas");
const schemaFiles = readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json")).sort();
for (const file of schemaFiles) ajv.addSchema(readJson(join(schemaDir, file)));
const schemaIds = {};
for (const file of schemaFiles) {
  const schema = readJson(join(schemaDir, file));
  try {
    ajv.getSchema(schema.$id);
    schemaIds[basename(file, ".schema.json")] = schema.$id;
    ok(file);
  } catch (error) {
    fail(file, error.message);
  }
}

const validatorFor = (name) => {
  const [base, fragment] = name.split("#");
  const id = schemaIds[base] + (fragment ? `#${fragment}` : "");
  const validate = ajv.getSchema(id);
  if (!validate) throw new Error(`no schema ${id}`);
  return validate;
};

// ---------------------------------------------------------------------------
section("examples validate");
const exampleSchema = (file) => {
  if (file.startsWith("manifest")) return "manifest";
  if (file.startsWith("key-set")) return "key-set";
  if (file.startsWith("bundle")) return "bundle";
  if (file.startsWith("heartbeat.request")) return "heartbeat#/$defs/request";
  if (file.startsWith("heartbeat.response")) return "heartbeat#/$defs/response";
  if (file.startsWith("edge-pointer")) return "edge-pointer";
  if (file.startsWith("store.")) return "store";
  throw new Error(`no schema mapping for example ${file}`);
};
const exampleDir = join(protocolDir, "examples");
const examples = readdirSync(exampleDir).filter((f) => f.endsWith(".json")).sort();
const loaded = {};
for (const file of examples) {
  const document = readJson(join(exampleDir, file));
  loaded[file] = document;
  const validate = validatorFor(exampleSchema(file));
  if (validate(document)) ok(file);
  else fail(file, ajv.errorsText(validate.errors, { separator: "\n       " }));
}

section("refused examples are refused");
const refusedDir = join(exampleDir, "refused");
for (const file of readdirSync(refusedDir).filter((f) => f.endsWith(".json")).sort()) {
  const entry = readJson(join(refusedDir, file));
  const name = { manifest: "manifest", "key-set": "key-set", bundle: "bundle", "heartbeat-request": "heartbeat#/$defs/request", "heartbeat-response": "heartbeat#/$defs/response", "edge-pointer": "edge-pointer", store: "store" }[entry.schema];
  const validate = validatorFor(name);
  if (validate(entry.document)) fail(file, `accepted, but: ${entry.reason}`);
  else ok(`${file} — ${entry.reason}`);
}

// ---------------------------------------------------------------------------
section("manifest rules the schema cannot express");
const manifestRules = (label, manifest) => {
  const payload = manifest.payload;
  const tags = payload.slots.map((s) => s.tag);
  const sorted = [...tags].sort();
  if (tags.join("\n") !== sorted.join("\n")) fail(`${label}: slots sorted by tag`);
  else if (new Set(tags).size !== tags.length) fail(`${label}: slot tags unique`);
  else ok(`${label}: slots sorted and unique`);

  const digest = releaseDigest(payload.slots);
  if (digest === payload.releaseDigest) ok(`${label}: releaseDigest reproduces from slots`);
  else fail(`${label}: releaseDigest`, `computed ${digest}, manifest says ${payload.releaseDigest}`);

  for (const slot of payload.slots) {
    if (slot.kind !== "workflow") continue;
    try {
      orderedSteps(slot.tag, slot.steps);
      ok(`${label}: ${slot.tag} steps are 1-based, contiguous, tagged <tag>#<n>`);
    } catch (error) {
      fail(`${label}: ${slot.tag} steps`, error.message);
    }
  }

  if (payload.experiment) {
    const { arms } = payload.experiment;
    try {
      validateArms(arms);
      decodeBase64Url(payload.experiment.salt);
      ok(`${label}: experiment weights sum to 10000 and the salt decodes`);
    } catch (error) {
      fail(`${label}: experiment`, error.message);
    }
    const control = arms[0];
    if (control.releaseDigest !== payload.releaseDigest || control.overrides.length !== 0) {
      fail(`${label}: first arm is the control arm (manifest digest, no overrides)`);
    } else ok(`${label}: first arm is the control arm`);
    for (const arm of arms.slice(1)) {
      const byTag = new Map(payload.slots.map((s) => [s.tag, s]));
      for (const override of arm.overrides) {
        if (!byTag.has(override.tag)) fail(`${label}: arm ${arm.arm} overrides unknown slot ${override.tag}`);
        byTag.set(override.tag, override);
      }
      const armDigest = releaseDigest([...byTag.values()]);
      if (armDigest === arm.releaseDigest) ok(`${label}: arm ${arm.arm} digest reproduces from slots + overrides`);
      else fail(`${label}: arm ${arm.arm} digest`, `computed ${armDigest}, manifest says ${arm.releaseDigest}`);
    }
    if (payload.requireCountersign) {
      const signed = new Set((manifest.countersignatures ?? []).map((c) => c.releaseDigest));
      const missing = arms.map((a) => a.releaseDigest).filter((d) => !signed.has(d));
      if (missing.length === 0) ok(`${label}: every arm's release is countersigned (D58)`);
      else fail(`${label}: countersign covers every arm`, `missing ${missing.join(", ")}`);
    }
  }
  for (const directive of payload.directives) {
    if (directive.kind === "request_unlock" && directive.expiresAt <= directive.requestedAt) fail(`${label}: unlock request expires after it was requested`);
  }
};
for (const [file, document] of Object.entries(loaded)) {
  if (file.startsWith("manifest")) manifestRules(file, document);
  if (file === "bundle.plaintext.json") {
    const contents = document.encryption.contents;
    manifestRules(`${file} › manifest`, contents.manifest);
    const referenced = new Set();
    for (const slot of contents.manifest.payload.slots) {
      referenced.add(slot.contentHash);
      for (const step of slot.steps ?? []) referenced.add(step.contentHash);
    }
    for (const arm of contents.manifest.payload.experiment?.arms ?? []) for (const o of arm.overrides) referenced.add(o.contentHash);
    const carried = new Map(contents.payloads.map((p) => [p.contentHash, p]));
    const missing = [...referenced].filter((h) => !carried.has(h));
    if (missing.length) fail(`${file}: bundle carries every referenced payload`, missing.join(", "));
    else ok(`${file}: bundle carries every referenced payload`);
    let hashesOk = true;
    for (const p of contents.payloads) {
      const bytes = Buffer.from(p.bytes, "base64url");
      if (bytes.length !== p.byteLength || sha256Prefixed(bytes) !== p.contentHash) {
        hashesOk = false;
        fail(`${file}: payload ${p.contentHash} bytes match hash and length`);
      }
    }
    if (hashesOk) ok(`${file}: every payload's bytes hash to its contentHash`);
    if (contents.notAfter <= contents.createdAt) fail(`${file}: notAfter after createdAt`);
  }
}

// ---------------------------------------------------------------------------
section("vectors: canonical JSON");
const cj = readJson(join(protocolDir, "vectors", "canonical-json.json"));
for (const vector of cj.vectors) {
  try {
    const text = canonicalJson(vector.input);
    const digest = sha256Prefixed(Buffer.from(text, "utf8"));
    if (text === vector.canonical && digest === vector.sha256) ok(vector.name);
    else fail(vector.name, `text ${text === vector.canonical ? "matches" : "differs"}, digest ${digest === vector.sha256 ? "matches" : "differs"}`);
  } catch (error) {
    fail(vector.name, error.message);
  }
}
const refusedInputs = {
  undefined_value: { a: undefined },
  non_integer_number: { n: 1.5 },
  non_finite_number: { n: Number.POSITIVE_INFINITY },
  unsafe_integer: { n: Number.MAX_SAFE_INTEGER + 2 },
  unsupported_type: { d: new Date(0) },
  cycle: (() => {
    const o = {};
    o.self = o;
    return o;
  })(),
};
for (const refused of cj.refused) {
  const input = "input" in refused ? refused.input : refusedInputs[refused.reason];
  try {
    canonicalJson(input);
    fail(`refused: ${refused.name}`, "encoded instead of refusing");
  } catch (error) {
    if (error instanceof CanonicalJsonError && error.reason === refused.reason) ok(`refused: ${refused.name} → ${refused.reason}`);
    else fail(`refused: ${refused.name}`, `expected ${refused.reason}, got ${error.reason ?? error.message}`);
  }
}

section("vectors: workflow steps");
const ws = readJson(join(protocolDir, "vectors", "workflow-steps.json"));
for (const vector of ws.vectors) {
  try {
    const steps = orderedSteps(vector.slotTag, vector.steps);
    const order = steps.map((s) => s.stepId);
    if (vector.refuse) fail(vector.name, `expected refusal ${vector.refuse}`);
    else if (order.join() === vector.expectedOrder.join()) ok(vector.name);
    else fail(vector.name, `order ${order.join(", ")}`);
  } catch (error) {
    if (vector.refuse && error.reason === vector.refuse) ok(`${vector.name} → ${vector.refuse}`);
    else fail(vector.name, error.message);
  }
}

section("vectors: assignment");
const as = readJson(join(protocolDir, "vectors", "assignment.json"));
for (const c of as.cases) {
  try {
    const result = assignArm({ salt: c.salt, subject: c.subject, arms: c.arms });
    const e = c.expected;
    if (result.subjectHash === e.subjectHash && result.bucket === e.bucket && result.arm === e.arm) ok(c.name);
    else fail(c.name, `got ${JSON.stringify(result)}, expected ${JSON.stringify(e)}`);
  } catch (error) {
    fail(c.name, error.message);
  }
}
for (const r of as.refused) {
  try {
    assignArm({ salt: r.salt, subject: "user-1", arms: r.arms });
    fail(`refused: ${r.name}`, "assigned instead of refusing");
  } catch (error) {
    if (error instanceof AssignmentError && error.reason === r.reason) ok(`refused: ${r.name} → ${r.reason}`);
    else fail(`refused: ${r.name}`, `expected ${r.reason}, got ${error.reason ?? error.message}`);
  }
}

section("vectors: ramp plan (S9)");
const rp = readJson(join(protocolDir, "vectors", "ramp.json"));
for (const c of rp.cases) {
  try {
    validateRamp(c.ramp, c.arms.length);
    const disabled = new Set(c.directives.filter((d) => d.kind === "disable" && d.scope === "arm").map((d) => d.arm));
    const check = (nowText, expectedWeights, assignments, field) => {
      const nowMs = Date.parse(nowText);
      const weights = rampWeightsAt(c.arms, c.ramp, nowMs);
      if (expectedWeights && weights.join() !== expectedWeights.join()) throw new Error(`weights at ${nowText}: ${weights.join()} ≠ ${expectedWeights.join()}`);
      const arms = effectiveArms({ arms: c.arms, ramp: c.ramp, disabledArms: disabled, nowMs });
      for (const entry of assignments) {
        const result = assignArm({ salt: c.salt, subject: entry.subject, arms });
        if (result.bucket !== entry.bucket || result.arm !== entry[field]) throw new Error(`${entry.subject}: ${result.arm}/${result.bucket} ≠ ${entry[field]}/${entry.bucket}`);
      }
    };
    if (c.hosts) {
      check(c.hosts.hostA.now, c.hosts.hostA.weightBps, c.expected.assignments, "hostA");
      check(c.hosts.hostB.now, c.hosts.hostB.weightBps, c.expected.assignments, "hostB");
      const disagreements = c.expected.assignments.filter((e) => e.hostA !== e.hostB).length;
      if (disagreements !== c.expected.disagreements) throw new Error(`${disagreements} disagreements, expected ${c.expected.disagreements}`);
      if (c.expected.assignments.some((e) => e.hostA === "candidate" && e.hostB === "control")) throw new Error("a subject moved from candidate back to control");
    } else {
      check(c.now, c.expected.weightBps, c.expected.assignments, "arm");
    }
    ok(c.name);
  } catch (error) {
    fail(c.name, error.message);
  }
}
for (const r of rp.refused) {
  try {
    validateRamp(r.ramp, r.arms.length);
    fail(`refused: ${r.name}`, "accepted instead of refusing");
  } catch (error) {
    if (error instanceof AssignmentError && error.reason === r.reason) ok(`refused: ${r.name} → ${r.reason}`);
    else fail(`refused: ${r.name}`, `expected ${r.reason}, got ${error.reason ?? error.message}`);
  }
}

section("vectors: trust chain (root metadata)");
const trustPath = process.env.TRUST_VECTORS ?? join(protocolDir, "vectors", "manifest-verify.json");
const tv = readJson(trustPath);
const verdictMatches = (result, expected) => result.ok === expected.ok && (expected.ok ? (expected.signingKeyId === undefined || result.signingKeyId === expected.signingKeyId) && (expected.generation === undefined || result.generation === expected.generation) : result.reason === expected.reason);
for (const c of tv.rootMetadata) {
  const trusted = c.trustedRoot ?? trustedRootFromPinnedKey({ purpose: c.purpose, environment: c.environment, pinnedRootJwk: c.pinnedRoot });
  const result = verifyRootMetadata({ candidate: c.candidate, trusted, now: c.now });
  if (verdictMatches(result, c.expected)) ok(c.name);
  else fail(c.name, `got ${JSON.stringify(result)}, expected ${JSON.stringify(c.expected)}`);
}

section("vectors: trust chain (manifests)");
for (const c of tv.manifests) {
  const payloads = c.payloads ? new Map(c.payloads.map((p) => [p.contentHash, Buffer.from(p.bytes, "base64url")])) : null;
  const result = verifyManifest({
    manifest: c.manifest,
    root: c.root,
    now: c.now,
    scope: c.scope,
    storedGeneration: c.storedGeneration,
    payloads,
    countersignRoot: c.countersignRoot ?? null,
    requireCountersign: c.requireCountersign ?? false,
  });
  if (verdictMatches(result, c.expected)) ok(c.name);
  else fail(c.name, `got ${JSON.stringify(result)}, expected ${JSON.stringify(c.expected)}`);
}
const refusalEnum = readJson(join(schemaDir, "heartbeat.schema.json")).$defs.request.properties.refusal.enum;
for (const reason of new Set([...tv.rootMetadata, ...tv.manifests].filter((c) => !c.expected.ok).map((c) => c.expected.reason))) {
  if (refusalEnum.includes(reason)) ok(`refusal ${reason} is reportable on heartbeat`);
  else fail(`refusal ${reason} is reportable on heartbeat`, "missing from heartbeat.schema.json refusal enum");
}

section("vectors: spool (buckets, minutes, names, rotation, windows)");
const sp = readJson(join(protocolDir, "vectors", "spool.json"));
if (sp.latencyBuckets.edges.join() === LATENCY_BUCKET_EDGES_MS.join() && sp.segmentMaxBytes === SEGMENT_MAX_BYTES) ok("edges and the segment cap match the schema and the format");
else fail("edges and the segment cap", "vector disagrees with latency-buckets.json / spool-format.md");
{
  const wrong = sp.latencyBuckets.cases.filter((c) => latencyBucketIndex(c.latencyMs) !== c.bucket);
  if (wrong.length === 0) ok(`${sp.latencyBuckets.cases.length} latency values bucket as expected`);
  else fail("latency buckets", wrong.map((c) => `${c.latencyMs} ms → ${latencyBucketIndex(c.latencyMs)}, expected ${c.bucket}`).join("; "));
}
for (const c of sp.minutes) {
  if (minuteOf(c.epochMs) === c.minute && epochMinute(c.epochMs) === c.epochMinute) ok(`minute: ${c.name}`);
  else fail(`minute: ${c.name}`, `${minuteOf(c.epochMs)} / ${epochMinute(c.epochMs)}`);
}
for (const c of sp.segmentNames) {
  const name = segmentName(c.instanceId, epochMinute(c.epochMs), c.n);
  if (name === c.name) ok(`segment name ${c.name}`);
  else fail(`segment name ${c.name}`, name);
}
for (const c of sp.rotation) {
  const planner = new SegmentPlanner(c.instanceId);
  const got = c.appends.map((a) => planner.append(a.epochMs, a.lineBytes));
  const mismatch = got.findIndex((g, i) => g.segment !== c.appends[i].segment || g.rotated !== c.appends[i].rotated);
  if (mismatch === -1) ok(`rotation: ${c.name}`);
  else fail(`rotation: ${c.name}`, `append ${mismatch}: got ${JSON.stringify(got[mismatch])}, expected ${JSON.stringify({ segment: c.appends[mismatch].segment, rotated: c.appends[mismatch].rotated })}`);
}
const windowValidate = validatorFor("telemetry-window");
const spoolRowValidate = validatorFor("spool-rows");
const windowKey = (row) => JSON.stringify([row.minute, row.tag, row.versionId, row.arm, row.model, row.status, row.errorClass ?? null]);
const sortRows = (rows) => [...rows].sort((a, b) => (windowKey(a) < windowKey(b) ? -1 : 1));
// Key-order-insensitive equality (rows carry non-integer sums, so not the protocol's canonical form).
const stable = (value) => (Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])])) : value);
const sameJson = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
for (const c of sp.windows) {
  const aggregator = new WindowAggregator({ instanceId: c.instanceId, instanceClass: c.instanceClass, sdk: c.sdk });
  const refusals = [];
  for (const event of c.events) {
    if (event.kind === "observe") aggregator.observe(event.at, event.observation);
    else if (event.kind === "feedback") aggregator.outcomes(event.at, event.feedback);
    else if (event.kind === "refusal") refusals.push({ type: "refusal", v: 1, at: new Date(event.at).toISOString(), instanceId: c.instanceId, reason: event.reason, generation: event.generation, tag: event.tag ?? null });
    else if (event.kind === "close") aggregator.close(event.at);
  }
  const got = sortRows(aggregator.emitted);
  const expected = sortRows(c.expectedWindows);
  if (got.length === expected.length && got.every((row, i) => sameJson(row, expected[i])) && sameJson(refusals, c.expectedRefusals)) ok(`windows: ${c.name}`);
  else fail(`windows: ${c.name}`, `got ${JSON.stringify(got)} / ${JSON.stringify(refusals)}\n       expected ${JSON.stringify(expected)} / ${JSON.stringify(c.expectedRefusals)}`);
  for (const row of c.expectedWindows) {
    if (!windowValidate(row)) fail(`windows: ${c.name} row validates against telemetry-window`, ajv.errorsText(windowValidate.errors));
    if (!spoolRowValidate(row)) fail(`windows: ${c.name} row validates against spool-rows`, ajv.errorsText(spoolRowValidate.errors));
  }
  for (const row of c.expectedRefusals) {
    if (!spoolRowValidate(row)) fail(`windows: ${c.name} refusal validates against spool-rows`, ajv.errorsText(spoolRowValidate.errors));
  }
}
{
  // Content never has a field in a window: the whole vector file, serialised, carries none of the strings a leak would.
  const text = JSON.stringify(sp.windows.map((c) => [c.expectedWindows, c.expectedRefusals]));
  const forbiddenKeys = ["prompt", "text", "userId", "subject", "runRef", "message", "stack", "freeText"];
  const leaked = forbiddenKeys.filter((key) => text.includes(`"${key}"`));
  if (leaked.length === 0) ok("no window or refusal row carries a content-bearing field");
  else fail("content-bearing field in a row", leaked.join(", "));
}

section("vectors: feedback catalogue");
const fb = readJson(join(protocolDir, "vectors", "feedback.json"));
const feedbackSchema = validatorFor("feedback-signals");
for (const c of fb.cases) {
  const got = normalizeFeedback(c.signals);
  if (sameJson(got, c.expected)) ok(`feedback: ${c.name}`);
  else fail(`feedback: ${c.name}`, `got ${JSON.stringify(got)}, expected ${JSON.stringify(c.expected)}`);
  // The schema and the normaliser agree on what is entirely valid: a payload the schema accepts is never wholly rejected, and vice versa.
  const schemaAccepts = feedbackSchema(c.signals);
  const wholly = Object.keys(c.expected.rejected).length === 0 && Object.keys(c.signals).length > 0;
  const partiallyValidCorrected = Object.values(c.expected.rejected).every((r) => r === "needs_slot_enum") && Object.keys(c.expected.rejected).length > 0;
  if (schemaAccepts === (wholly || partiallyValidCorrected) || Object.keys(c.signals).length === 0) ok(`feedback: ${c.name} — schema and normaliser agree`);
  else fail(`feedback: ${c.name} — schema and normaliser agree`, `schema ${schemaAccepts ? "accepts" : "refuses"}, normaliser rejects ${JSON.stringify(c.expected.rejected)}`);
}

section("vectors: output checks (checks.md)");
const ck = readJson(join(protocolDir, "vectors", "checks.json"));
const checkSchema = validatorFor("manifest#/$defs/outputCheck");
for (const c of ck.evaluations) {
  const got = evaluateChecks(c.checks, c.input);
  if (sameJson(got, c.expected)) ok(`checks: ${c.name}`);
  else fail(`checks: ${c.name}`, `got ${JSON.stringify(got)}, expected ${JSON.stringify(c.expected)}`);
}
for (const c of ck.patterns) {
  const got = patternRefusal(c.pattern);
  if (got === c.refusal) ok(`checks: pattern ${JSON.stringify(c.pattern).slice(0, 40)} → ${c.refusal ?? "accepted"}`);
  else fail(`checks: pattern ${JSON.stringify(c.pattern).slice(0, 40)}`, `got ${got}, expected ${c.refusal}`);
}
for (const c of ck.declarations) {
  const got = checksRefusals(c.checks);
  if (sameJson(got, c.refusals)) ok(`checks: declaration — ${c.name}`);
  else fail(`checks: declaration — ${c.name}`, `got ${JSON.stringify(got)}, expected ${JSON.stringify(c.refusals)}`);
  // The manifest schema accepts exactly the projections of well-formed checks.
  for (const projected of projectChecks(c.checks.filter((check) => !checksRefusals([check]).length))) {
    if (checkSchema(projected)) ok(`checks: schema accepts ${projected.name}`);
    else fail(`checks: schema accepts ${projected.name}`, JSON.stringify(checkSchema.errors));
  }
}
{
  const got = projectChecks(ck.projection.checks);
  if (sameJson(got, ck.projection.expected)) ok(`checks: ${ck.projection.name}`);
  else fail(`checks: ${ck.projection.name}`, `got ${JSON.stringify(got)}`);
}

// ---------------------------------------------------------------------------
section("examples/spool-writer: the reference writers without the SDK (D66) pass the spool vectors");
{
  // TypeScript: in-process through the same vectors as the reference, then one case through a real directory.
  const example = await import("../examples/spool-writer/typescript/spool-writer.mjs");
  const drive = (writer, c) => {
    for (const event of c.events) {
      if (event.kind === "observe") writer.observe(event.observation, event.at);
      else if (event.kind === "feedback") writer.feedback(event.feedback, event.at);
      else if (event.kind === "close") writer.close(event.at);
    }
  };
  const wrongBuckets = sp.latencyBuckets.cases.filter((c) => example.latencyBucketIndex(c.latencyMs) !== c.bucket);
  if (wrongBuckets.length === 0 && sp.minutes.every((c) => example.minuteOf(c.epochMs) === c.minute) && sp.segmentNames.every((c) => example.segmentName(c.instanceId, example.epochMinute(c.epochMs), c.n) === c.name)) ok("spool-writer.mjs: buckets, minutes, segment names");
  else fail("spool-writer.mjs: buckets, minutes, segment names");
  for (const c of sp.rotation) {
    const writer = new example.SpoolWriter({ instanceId: c.instanceId });
    const got = c.appends.map((a) => writer.planSegment(a.epochMs, a.lineBytes));
    const mismatch = got.findIndex((g, i) => g.segment !== c.appends[i].segment || g.rotated !== c.appends[i].rotated);
    if (mismatch === -1) ok(`spool-writer.mjs rotation: ${c.name}`);
    else fail(`spool-writer.mjs rotation: ${c.name}`, `append ${mismatch}: got ${JSON.stringify(got[mismatch])}`);
  }
  for (const c of sp.windows) {
    const writer = new example.SpoolWriter({ instanceId: c.instanceId, instanceClass: c.instanceClass, sdk: c.sdk });
    drive(writer, c);
    const got = sortRows(writer.emitted);
    const expected = sortRows(c.expectedWindows);
    if (got.length === expected.length && got.every((row, i) => sameJson(row, expected[i]))) ok(`spool-writer.mjs windows: ${c.name}`);
    else fail(`spool-writer.mjs windows: ${c.name}`, `got ${JSON.stringify(got)}\n       expected ${JSON.stringify(expected)}`);
    for (const row of writer.emitted) if (!spoolRowValidate(row)) fail(`spool-writer.mjs windows: ${c.name} row validates against spool-rows`, ajv.errorsText(spoolRowValidate.errors));
  }
  const { mkdtempSync, readdirSync: listDir, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "ap-spool-example-"));
  try {
    const c = sp.windows[0];
    drive(new example.SpoolWriter({ dir, instanceId: c.instanceId, instanceClass: c.instanceClass, sdk: c.sdk }), c);
    const files = listDir(dir).sort();
    const rows = files.flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    if (files.length > 0 && files.every((f) => f.endsWith(".ndjson")) && sameJson(sortRows(rows), sortRows(c.expectedWindows))) ok(`spool-writer.mjs: a sealed segment (${files[0]}) reads back as the expected rows`);
    else fail("spool-writer.mjs: sealed segment", `files ${files.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Python: its own checker, standard library only.
  const { spawnSync } = await import("node:child_process");
  const py = spawnSync("python3", [join(here, "..", "examples", "spool-writer", "python", "check_vectors.py"), join(protocolDir, "vectors", "spool.json")], { encoding: "utf8" });
  if (py.status === 0) ok(`spool_writer.py: ${py.stdout.trim()}`);
  else fail("spool_writer.py", (py.stderr || py.stdout || `exit ${py.status}`).trim().split("\n").slice(-3).join(" | "));
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\nconformance: all checks passed" : `\nconformance: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
