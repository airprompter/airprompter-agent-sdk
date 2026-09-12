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
} from "./reference.mjs";

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
  const name = { manifest: "manifest", "key-set": "key-set", bundle: "bundle", "heartbeat-request": "heartbeat#/$defs/request", "heartbeat-response": "heartbeat#/$defs/response", "edge-pointer": "edge-pointer" }[entry.schema];
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

// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\nconformance: all checks passed" : `\nconformance: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
