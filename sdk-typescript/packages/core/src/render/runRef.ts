/**
 * `runRef`: a compact, content-free token a customer keeps beside their own
 * trace to attach feedback later. `agent·target·slot·versionId·arm·generation·bucket`,
 * HMAC-signed with a per-store key so a forged ref cannot file signals
 * against a version that was never run here. Carries no subject and no text.
 *
 * @example
 * ```ts
 * const runRef = mintRunRef({ agentId, target: "prod", tag: "support.triage", versionId, arm: "none", generation: 7, bucket: null }, runRefKey);
 * // Later, beside the customer's own trace: null for a ref minted under another key or edited in transit.
 * const facts = parseRunRef(runRef, runRefKey); // { agentId, target, tag, versionId, arm, generation, bucket } | null
 * ```
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface RunRefFacts {
  agentId: string;
  target: string;
  tag: string;
  versionId: string;
  arm: string;
  generation: number;
  bucket: number | null;
}

const SEP = "·";

export function mintRunRef(facts: RunRefFacts, key: Uint8Array): string {
  const body = [facts.agentId, facts.target, facts.tag, facts.versionId, facts.arm, String(facts.generation), facts.bucket === null ? "-" : String(facts.bucket)].join(SEP);
  // 22 base64url characters (132 bits) of the MAC: a forgery stays infeasible and the ref stays short enough to keep beside a trace.
  const mac = createHmac("sha256", key).update(body, "utf8").digest("base64url").slice(0, 22);
  return `${Buffer.from(body, "utf8").toString("base64url")}.${mac}`;
}

export function parseRunRef(token: string, key: Uint8Array): RunRefFacts | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = Buffer.from(token.slice(0, dot), "base64url").toString("utf8");
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", key).update(body, "utf8").digest("base64url").slice(0, 22);
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const parts = body.split(SEP);
  if (parts.length !== 7) return null;
  const [agentId, target, tag, versionId, arm, generation, bucket] = parts as [string, string, string, string, string, string, string];
  return { agentId, target, tag, versionId, arm, generation: Number(generation), bucket: bucket === "-" ? null : Number(bucket) };
}
