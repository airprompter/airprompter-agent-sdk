// Reference datastore layout and records (protocol/datastore-format.md, format 1): the keys a scope's
// records live under and the canonical text of each record, and the reader's refusals. Pure — no store.
//
//   datastoreKeys("airprompter/", { organizationId: "org_1", agentId: "agt_1", target: "prod", region: "eu-west-1" }).latest;
//   // "airprompter/v1/org_1/agt_1/prod/region.eu-west-1/latest.json"
//   encodeRecord({ kind: "latest", generation: 7 });   // '{"format":1,"generation":7,"kind":"latest"}'
//   decodeRecord(text, "release", 7);                    // the record, or throws { code: "datastore_record_newer" | "datastore_record_invalid" }

import { canonicalJson } from "./reference.mjs";

export const DATASTORE_FORMAT = 1;
const SAFE = /^[A-Za-z0-9_-]$/;

/** One path segment: UTF-8, every byte outside A–Z a–z 0–9 _ - as %XX (uppercase). */
export function encodeSegment(value) {
  if (typeof value !== "string" || value.length === 0) throw new Error("a datastore key segment is a non-empty string");
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    const char = String.fromCharCode(byte);
    out += byte < 0x80 && SAFE.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export function scopeSegment(region) {
  return region === null || region === undefined ? "global" : `region.${encodeSegment(region)}`;
}

export function datastoreKeys(prefix, key) {
  const base = `${prefix}v1/${encodeSegment(key.organizationId)}/${encodeSegment(key.agentId)}/${encodeSegment(key.target)}/${scopeSegment(key.region)}/`;
  return {
    base,
    releasesPrefix: `${base}releases/`,
    release: (generation) => `${base}releases/${String(generation).padStart(12, "0")}.json`,
    latest: `${base}latest.json`,
    edge: `${base}edge.json`,
    control: `${base}control.json`,
  };
}

const FIELDS = {
  release: ["generation", "releaseDigest", "createdAt", "notAfter", "bundle", "rollout"],
  latest: ["generation"],
  edge: ["pointerUrl", "pointerEtag", "manifestEtag", "lastOriginAt"],
  control: ["generation", "heldBackBelow", "setAt"],
};
const OPTIONAL = { control: ["reason", "setBy"] };

/** The canonical text of a record from its fields (`kind` and the kind's fields; `format` is added). */
export function encodeRecord(fields) {
  const kind = fields.kind;
  const record = { format: DATASTORE_FORMAT, kind };
  for (const name of FIELDS[kind]) record[name] = fields[name];
  for (const name of OPTIONAL[kind] ?? []) if (fields[name] !== undefined && fields[name] !== null) record[name] = fields[name];
  return canonicalJson(record);
}

const refuse = (code, message) => Object.assign(new Error(message), { code });

/** Decode and check a record of the expected kind (and, for a release, the generation its key names). */
export function decodeRecord(text, kind, generation) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    throw refuse("datastore_record_invalid", "not JSON");
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) throw refuse("datastore_record_invalid", "not an object");
  if (!Number.isInteger(record.format)) throw refuse("datastore_record_invalid", "no format");
  if (record.format > DATASTORE_FORMAT) throw refuse("datastore_record_newer", `format ${record.format}; this reader reads ${DATASTORE_FORMAT}`);
  if (record.format !== DATASTORE_FORMAT) throw refuse("datastore_record_invalid", `format ${record.format}`);
  if (record.kind !== kind) throw refuse("datastore_record_invalid", `kind ${record.kind}, expected ${kind}`);
  for (const name of FIELDS[kind]) if (!(name in record)) throw refuse("datastore_record_invalid", `missing ${name}`);
  const generationOk = (value) => Number.isInteger(value) && value >= 1;
  if ((kind === "release" || kind === "latest" || kind === "control") && !generationOk(record.generation)) throw refuse("datastore_record_invalid", "generation");
  if (kind === "control" && !generationOk(record.heldBackBelow)) throw refuse("datastore_record_invalid", "heldBackBelow");
  if (kind === "release" && (typeof record.bundle !== "object" || record.bundle === null || typeof record.rollout !== "object" || record.rollout === null)) throw refuse("datastore_record_invalid", "bundle or rollout");
  if (kind === "release" && generation !== undefined && record.generation !== generation) throw refuse("datastore_record_invalid", `generation ${record.generation} under the key of ${generation}`);
  return record;
}
