/**
 * `runRef`: a compact, content-free token a customer keeps beside their own
 * trace to attach feedback later. Its legacy seven-part body remains readable; Team runs add an authenticated JSON
 * extension with the atomic artifact/model pair and, when targeted, opaque audience IDs plus the original run minute.
 * The per-store HMAC prevents forged feedback. The token carries no subject, tag values, or prompt text.
 *
 * @example
 * ```ts
 * const runRef = mintRunRef({ agentId, target: "prod", tag: "support.triage", artifactId, model, versionId, arm: "none", generation: 7, bucket: null, audienceIds, runMinute }, runRefKey);
 * // Later, beside the customer's own trace: null for a ref minted under another key or edited in transit.
 * const facts = parseRunRef(runRef, runRefKey); // authenticated facts, or null for a forged/malformed token
 * ```
 */

import { validAudienceIds, validAudienceMinute } from "../protocol/assignment.js";
import { createHmac, timingSafeEqual } from "node:crypto";

interface RunRefBaseFacts {
  agentId: string;
  target: string;
  tag: string;
  versionId: string;
  arm: string;
  generation: number;
  bucket: number | null;
}

/** Team artifact identity and its configured model are authenticated as one atomic extension. */
export type RunRefFacts = RunRefBaseFacts & (
  | { artifactId: string; model: string; audienceIds?: never; runMinute?: string }
  | { artifactId: string; model: string; audienceIds: readonly string[]; runMinute: string }
  | { artifactId?: never; model?: never; audienceIds?: never; runMinute?: never }
  | { artifactId?: never; model?: never; audienceIds: readonly string[]; runMinute: string }
);

const SEP = "·";
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function mintRunRef(facts: RunRefFacts, key: Uint8Array): string {
  if ([facts.agentId, facts.target, facts.tag, facts.versionId, facts.arm].some((value) => typeof value !== "string" || value.includes(SEP))) throw new Error("run_ref_facts_invalid");
  if (!Number.isSafeInteger(facts.generation) || facts.generation < 1 || facts.bucket !== null && (!Number.isInteger(facts.bucket) || facts.bucket < 0 || facts.bucket > 9999)) throw new Error("run_ref_facts_invalid");
  const hasArtifact = facts.artifactId !== undefined, hasModel = facts.model !== undefined;
  if (hasArtifact !== hasModel || (hasArtifact && (typeof facts.artifactId !== "string" || !ARTIFACT_ID.test(facts.artifactId) || typeof facts.model !== "string" || !MODEL_ID.test(facts.model)))) throw new Error("run_ref_facts_invalid");
  if (facts.runMinute !== undefined && (!validAudienceMinute(facts.runMinute) || !hasArtifact && facts.audienceIds === undefined) || facts.audienceIds !== undefined && (!validAudienceIds(facts.audienceIds) || facts.runMinute === undefined)) throw new Error("run_ref_facts_invalid");
  const legacyBody = [facts.agentId, facts.target, facts.tag, facts.versionId, facts.arm, String(facts.generation), facts.bucket === null ? "-" : String(facts.bucket)].join(SEP);
  // The negotiated extension authenticates artifact identity, opaque memberships and the ORIGINAL minute. No raw tags.
  const extension = facts.artifactId ? { artifactId: facts.artifactId, model: facts.model, ...(facts.runMinute ? { runMinute: facts.runMinute } : {}), ...(facts.audienceIds ? { audienceIds: facts.audienceIds } : {}) } : facts.audienceIds ? [facts.audienceIds, facts.runMinute] : null;
  const body = extension ? legacyBody + SEP + JSON.stringify(extension) : legacyBody;
  // 22 base64url characters (132 bits) of the MAC: a forgery stays infeasible and the ref stays short enough to keep beside a trace.
  const mac = createHmac("sha256", key).update(body, "utf8").digest("base64url").slice(0, 22);
  return `${Buffer.from(body, "utf8").toString("base64url")}.${mac}`;
}

export function parseRunRef(token: string, key: Uint8Array): RunRefFacts | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || token.length > 4096) return null;
  const body = Buffer.from(token.slice(0, dot), "base64url").toString("utf8");
  const mac = token.slice(dot + 1);
  // timingSafeEqual throws when decoded byte lengths differ. Check the protocol's exact base64url MAC shape first.
  if (!/^[A-Za-z0-9_-]{22}$/.test(mac)) return null;
  const expected = createHmac("sha256", key).update(body, "utf8").digest("base64url").slice(0, 22);
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const parts = body.split(SEP);
  if (parts.length !== 7 && parts.length !== 8) return null;
  const [agentId, target, tag, versionId, arm, generationText, bucketText] = parts as [string, string, string, string, string, string, string];
  if (!/^[1-9][0-9]*$/.test(generationText) || bucketText !== "-" && !/^(?:0|[1-9][0-9]{0,3})$/.test(bucketText)) return null;
  const generation = Number(generationText), bucket = bucketText === "-" ? null : Number(bucketText);
  if (!Number.isSafeInteger(generation) || generation < 1 || bucket !== null && (!Number.isInteger(bucket) || bucket < 0 || bucket > 9999)) return null;
  let extensionFacts: {artifactId?: string;model?: string;audienceIds?: string[];runMinute?: string} = {};
  if (parts.length === 8) {
    try {
      const extension = JSON.parse(parts[7]!);
      if (Array.isArray(extension)) {
        if (extension.length !== 2) return null;
        const [ids,minute] = extension;
        if (!validAudienceIds(ids) || !validAudienceMinute(minute)) return null;
        extensionFacts = {audienceIds: ids,runMinute: minute};
      } else if (extension && typeof extension === "object" && !Array.isArray(extension)) {
        const value = extension as Record<string,unknown>;
        if (Object.keys(value).some((key) => !["artifactId","model","audienceIds","runMinute"].includes(key)) || typeof value.artifactId !== "string" || !ARTIFACT_ID.test(value.artifactId) || typeof value.model !== "string" || !MODEL_ID.test(value.model)) return null;
        if (value.runMinute !== undefined && !validAudienceMinute(value.runMinute)) return null;
        if (value.audienceIds !== undefined && (!validAudienceIds(value.audienceIds) || value.runMinute === undefined)) return null;
        extensionFacts = {
          artifactId: value.artifactId,
          model: value.model,
          ...(value.audienceIds !== undefined ? { audienceIds: value.audienceIds } : {}),
          ...(value.runMinute !== undefined ? { runMinute: value.runMinute } : {}),
        };
      } else return null;
    } catch {return null;}
  }
  return { agentId, target, tag, versionId, arm, generation, bucket, ...extensionFacts } as RunRefFacts;
}
