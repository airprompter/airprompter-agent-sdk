/**
 * `runRef`: a compact, content-free token a customer keeps beside their own trace to attach feedback later. One body
 * form: `JSON.stringify([agentId, target, runId, entries])`, base64url, then the same 22-character HMAC. One entry per
 * slot the run used, so a one-slot run is a list of one. `runId` is fixed, because a token that grows cannot be the
 * run's identity. The token carries no subject, tag values, or prompt text.
 *
 * Readers are tolerant so a host can grow a ref a later SDK wrote: a body element past the fourth lands in `extra`,
 * unknown keys stay on their entry, and both survive `mintRunRef`. Readers accept more than minting writes. A hosted
 * run's ref (prompt-haven) is a different token and is never parsed here.
 *
 * @example
 * ```ts
 * const key = runRefKeyFrom(apiKey, agentId, target); // the same on every instance of this agent and target
 * const runRef = mintRunRef({ agentId, target, runId: newRunId(), entries: [{ tag, artifactId, versionId, model, arm: "none", bucket: null, runMinute }] }, key);
 * // Later, beside the customer's own trace: null for a ref minted under another key or edited in transit.
 * const facts = parseRunRef(runRef, [key, previousKey]); // tries each key
 * ```
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { validAudienceIds, validAudienceMinute } from "../protocol/assignment.js";

export const RUN_REF_MAX_ENTRIES = 8;
/** Eight worst-case entries are about 9,500 characters. */
export const RUN_REF_MAX_TOKEN_LENGTH = 12288;
/** Reading stays above minting, so a later minor can raise what is minted. */
export const RUN_REF_READ_MAX_ENTRIES = 32;
export const RUN_REF_READ_MAX_TOKEN_LENGTH = 40960;

export interface RunRefEntry {
  tag: string;
  artifactId: string;
  versionId: string;
  model: string;
  arm: string;
  bucket: number | null;
  runMinute: string;
  audienceIds?: readonly string[];
}

export interface RunRefFacts {
  agentId: string;
  target: string;
  runId: string;
  /** Tags are unique. */
  entries: readonly RunRefEntry[];
  /** Body elements past the fourth, kept for a later re-mint. */
  extra?: readonly unknown[];
}

const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function validEntry(entry: unknown): entry is RunRefEntry {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  if (!nonEmpty(e.tag) || !nonEmpty(e.versionId) || !nonEmpty(e.arm)) return false;
  if (typeof e.artifactId !== "string" || !ARTIFACT_ID.test(e.artifactId) || typeof e.model !== "string" || !MODEL_ID.test(e.model)) return false;
  if (e.bucket !== null && (!Number.isInteger(e.bucket) || (e.bucket as number) < 0 || (e.bucket as number) > 9999)) return false;
  return validAudienceMinute(e.runMinute) && (e.audienceIds === undefined || validAudienceIds(e.audienceIds));
}

const macOf = (body: string, key: Uint8Array): string => createHmac("sha256", key).update(body, "utf8").digest("base64url").slice(0, 22);

/** 22 base64url characters from 16 random bytes. */
export function newRunId(): string {
  return randomBytes(16).toString("base64url");
}

/** The key instances of one agent and target share: derived, so the secret itself never keys a token. */
export function runRefKeyFrom(secret: string, agentId: string, target: string): Uint8Array {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(`airprompter runRef v1\0${agentId}\0${target}`, "utf8").digest();
}

/** Throws `run_ref_facts_invalid` past either minting bound, on repeated tags, or on an entry that does not fit. */
export function mintRunRef(facts: RunRefFacts, key: Uint8Array): string {
  const { agentId, target, runId, entries, extra } = facts;
  if (!nonEmpty(agentId) || !nonEmpty(target) || !nonEmpty(runId) || !Array.isArray(entries) || entries.length > RUN_REF_MAX_ENTRIES) throw new Error("run_ref_facts_invalid");
  if (!entries.every(validEntry) || new Set(entries.map((entry) => entry.tag)).size !== entries.length) throw new Error("run_ref_facts_invalid");
  const body = JSON.stringify([agentId, target, runId, entries, ...(extra ?? [])]);
  const token = `${Buffer.from(body, "utf8").toString("base64url")}.${macOf(body, key)}`;
  if (token.length > RUN_REF_MAX_TOKEN_LENGTH) throw new Error("run_ref_facts_invalid");
  return token;
}

/** The authenticated facts, or null for a forged or malformed token. `keys` is tried in order, so a rotation keeps older refs working. */
export function parseRunRef(token: string, keys: Uint8Array | readonly Uint8Array[]): RunRefFacts | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || token.length > RUN_REF_READ_MAX_TOKEN_LENGTH) return null;
  const mac = token.slice(dot + 1);
  // timingSafeEqual throws when decoded byte lengths differ. Check the protocol's exact base64url MAC shape first.
  if (!/^[A-Za-z0-9_-]{22}$/.test(mac)) return null;
  const body = Buffer.from(token.slice(0, dot), "base64url").toString("utf8");
  const candidates = keys instanceof Uint8Array ? [keys] : keys;
  if (!candidates.some((key) => timingSafeEqual(Buffer.from(mac), Buffer.from(macOf(body, key))))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length < 4) return null;
  const [agentId, target, runId, entries, ...extra] = parsed as [unknown, unknown, unknown, unknown, ...unknown[]];
  if (!nonEmpty(agentId) || !nonEmpty(target) || !nonEmpty(runId) || !Array.isArray(entries) || entries.length > RUN_REF_READ_MAX_ENTRIES || !entries.every(validEntry)) return null;
  return { agentId, target, runId, entries, ...(extra.length > 0 ? { extra } : {}) };
}
