/**
 * The datastore format (T40, `protocol/datastore-format.md`, format 1): where
 * a scope's records live in a key-value store, and the canonical text of
 * each record. Every SDK and every adapter reads what another wrote, so this
 * is the contract — `protocol/vectors/datastore.json` pins it byte for byte.
 *
 * @example
 * ```ts
 * const keys = datastoreKeys("airprompter/", { organizationId, agentId, target: "prod", region: "eu-west-1" });
 * keys.release(42); // "airprompter/v1/org_1/agt_1/prod/region.eu-west-1/releases/000000000042.json"
 * const text = encodeDatastoreRecord({ kind: "latest", generation: 42 }); // '{"format":1,"generation":42,"kind":"latest"}'
 * decodeDatastoreRecord(text, "latest"); // or throws DatastoreRecordError("datastore_record_newer" | "datastore_record_invalid")
 * ```
 */

import { canonicalJson, errorNamed } from "@airprompter/agent-core";
import type { ReleaseKey } from "./releaseDatastore.js";

export const DATASTORE_FORMAT = 1 as const;

export type DatastoreRecordErrorCode = "datastore_record_newer" | "datastore_record_invalid";

export class DatastoreRecordError extends Error {
  constructor(
    readonly code: DatastoreRecordErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DatastoreRecordError";
  }
}

/** `DatastoreRecordError` by name and code — true across duplicated package copies. */
export function isDatastoreRecordError(error: unknown): error is DatastoreRecordError {
  return errorNamed<DatastoreRecordErrorCode>(error, "DatastoreRecordError");
}

const SAFE_BYTE = (byte: number): boolean => (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || byte === 0x5f || byte === 0x2d;

/** One key segment: UTF-8, every byte outside `A–Z a–z 0–9 _ -` as `%XX` (uppercase). Empty is refused. */
export function encodeKeySegment(value: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("a datastore key segment is a non-empty string");
  let out = "";
  for (const byte of new TextEncoder().encode(value)) out += SAFE_BYTE(byte) ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  return out;
}

export interface DatastoreKeys {
  base: string;
  releasesPrefix: string;
  release(generation: number): string;
  latest: string;
  edge: string;
  control: string;
}

export function datastoreKeys(prefix: string, key: ReleaseKey): DatastoreKeys {
  const scope = key.region === null || key.region === undefined ? "global" : `region.${encodeKeySegment(key.region)}`;
  const base = `${prefix}v1/${encodeKeySegment(key.organizationId)}/${encodeKeySegment(key.agentId)}/${encodeKeySegment(key.target)}/${scope}/`;
  return {
    base,
    releasesPrefix: `${base}releases/`,
    release: (generation) => `${base}releases/${String(generation).padStart(12, "0")}.json`,
    latest: `${base}latest.json`,
    edge: `${base}edge.json`,
    control: `${base}control.json`,
  };
}

/** The generation a key under `releases/` names, or null for anything else there. */
export function generationOfReleaseKey(releasesPrefix: string, key: string): number | null {
  if (!key.startsWith(releasesPrefix)) return null;
  const match = /^(\d{12})\.json$/.exec(key.slice(releasesPrefix.length));
  return match ? Number(match[1]) : null;
}

export type DatastoreRecord =
  | { kind: "release"; generation: number; releaseDigest: string; createdAt: string; notAfter: string; bundle: Record<string, unknown>; rollout: Record<string, unknown> }
  | { kind: "latest"; generation: number }
  | { kind: "edge"; pointerUrl: string | null; pointerEtag: string | null; manifestEtag: string | null; lastOriginAt: string | null }
  | { kind: "control"; generation: number; heldBackBelow: number; setAt: string; reason?: string; setBy?: string };

const FIELDS: Record<DatastoreRecord["kind"], readonly string[]> = {
  release: ["generation", "releaseDigest", "createdAt", "notAfter", "bundle", "rollout"],
  latest: ["generation"],
  edge: ["pointerUrl", "pointerEtag", "manifestEtag", "lastOriginAt"],
  control: ["generation", "heldBackBelow", "setAt"],
};
const OPTIONAL: Partial<Record<DatastoreRecord["kind"], readonly string[]>> = { control: ["reason", "setBy"] };

/** The canonical text of a record: `format`, `kind`, the kind's fields (and its optional ones when set). */
export function encodeDatastoreRecord(fields: DatastoreRecord): string {
  const source = fields as unknown as Record<string, unknown>;
  const record: Record<string, unknown> = { format: DATASTORE_FORMAT, kind: fields.kind };
  for (const name of FIELDS[fields.kind]) record[name] = source[name];
  for (const name of OPTIONAL[fields.kind] ?? []) if (source[name] !== undefined && source[name] !== null) record[name] = source[name];
  return canonicalJson(record);
}

/** Decode and check a record of `kind` (and, for a release, the generation its key names). Never returns what it refused. */
export function decodeDatastoreRecord<K extends DatastoreRecord["kind"]>(text: string, kind: K, keyGeneration?: number): Extract<DatastoreRecord, { kind: K }> {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new DatastoreRecordError("datastore_record_invalid", `the ${kind} record is not JSON`);
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new DatastoreRecordError("datastore_record_invalid", `the ${kind} record is not an object`);
  const format = record.format;
  if (typeof format !== "number" || !Number.isInteger(format)) throw new DatastoreRecordError("datastore_record_invalid", `the ${kind} record names no format`);
  if (format > DATASTORE_FORMAT) throw new DatastoreRecordError("datastore_record_newer", `the ${kind} record is format ${format}; this reader reads format ${DATASTORE_FORMAT} — update the SDK or the adapter that reads it`);
  if (format !== DATASTORE_FORMAT) throw new DatastoreRecordError("datastore_record_invalid", `the ${kind} record is format ${format}`);
  if (record.kind !== kind) throw new DatastoreRecordError("datastore_record_invalid", `a ${String(record.kind)} record where a ${kind} record belongs`);
  for (const name of FIELDS[kind]) if (!(name in record)) throw new DatastoreRecordError("datastore_record_invalid", `the ${kind} record lacks ${name}`);
  const generationOk = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 1;
  if ((kind === "release" || kind === "latest" || kind === "control") && !generationOk(record.generation)) throw new DatastoreRecordError("datastore_record_invalid", `the ${kind} record's generation is not a positive integer`);
  if (kind === "control" && !generationOk(record.heldBackBelow)) throw new DatastoreRecordError("datastore_record_invalid", "the control record's heldBackBelow is not a positive integer");
  if (kind === "release") {
    if (typeof record.bundle !== "object" || record.bundle === null || typeof record.rollout !== "object" || record.rollout === null) throw new DatastoreRecordError("datastore_record_invalid", "the release record lacks its bundle or rollout");
    if (keyGeneration !== undefined && record.generation !== keyGeneration) throw new DatastoreRecordError("datastore_record_invalid", `a generation ${String(record.generation)} release under the key of generation ${keyGeneration}`);
  }
  const { format: _format, ...rest } = record;
  return rest as unknown as Extract<DatastoreRecord, { kind: K }>;
}
