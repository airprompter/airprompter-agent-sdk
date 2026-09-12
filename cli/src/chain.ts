/**
 * The T5 verification chain as the CLI reports it: root of trust first,
 * then the manifest envelope, then every payload against its hash and
 * length. The report names the step that refused and why, and describes
 * the release in counts, hashes and ids — never in text.
 */

import { openBundle, bundlePayloadBytes, type DistributionKey } from "../../sdk-typescript/src/bundle/apbundle.js";
import { instant, referencedPayloads, verifyManifest, verifyRootMetadata } from "../../sdk-typescript/src/protocol/trust.js";
import type { Bundle, BundleContents, Manifest, RootMetadata, Target } from "../../sdk-typescript/src/protocol/types.js";
import { refused } from "./io.js";
import type { RootSource } from "./keys.js";

export interface Scope {
  organizationId: string;
  agentId: string;
  target: Target;
}

export interface ManifestSummary {
  generation: number;
  releaseDigest: string;
  issuedAt: string;
  leaseSeconds: number;
  onLeaseExpiry: string;
  applyPolicy: string;
  requireCountersign: boolean;
  slots: number;
  workflows: number;
  payloads: number;
  experiment: { experimentId: string; arms: Array<{ arm: string; weightBps: number }> } | null;
  directives: Array<{ kind: string; scope?: string; tag?: string }>;
  signatures: string[];
  countersignatures: number;
}

export interface ChainReport {
  ok: boolean;
  step: "root" | "manifest" | "payloads" | "complete";
  reason: string | null;
  root: { trusted: "pinned_key" | "document"; accepted: boolean; version: number | null; expires: string | null; keys: string[]; reason: string | null };
  manifest: ManifestSummary | null;
  signingKeyId: string | null;
  storedGeneration: number;
}

export function summarizeManifest(manifest: Manifest): ManifestSummary {
  const payload = manifest.payload;
  return {
    generation: payload.generation,
    releaseDigest: payload.releaseDigest,
    issuedAt: payload.issuedAt,
    leaseSeconds: payload.leaseSeconds,
    onLeaseExpiry: payload.onLeaseExpiry,
    applyPolicy: payload.applyPolicy,
    requireCountersign: payload.requireCountersign,
    slots: payload.slots.length,
    workflows: payload.slots.filter((slot) => slot.kind === "workflow").length,
    payloads: referencedPayloads(payload).size,
    experiment: payload.experiment ? { experimentId: payload.experiment.experimentId, arms: payload.experiment.arms.map((arm) => ({ arm: arm.arm, weightBps: arm.weightBps })) } : null,
    directives: payload.directives.map((directive) => (directive.kind === "disable" ? { kind: directive.kind, scope: directive.scope, ...(directive.tag ? { tag: directive.tag } : {}) } : { kind: directive.kind })),
    signatures: manifest.signatures.map((signature) => signature.keyId),
    countersignatures: manifest.countersignatures?.length ?? 0,
  };
}

/** Root first: a candidate key-set document is accepted only against what `--root` already trusts. */
export function resolveRoot(source: RootSource, candidate: RootMetadata | null, now: string): { trusted: RootMetadata; report: ChainReport["root"] } {
  const base = source.kind === "pinned" ? source.trusted : source.document;
  const describe = (document: RootMetadata, accepted: boolean, reason: string | null): ChainReport["root"] => ({
    trusted: source.kind === "pinned" ? "pinned_key" : "document",
    accepted,
    version: document.signed.version,
    expires: document.signed.expires,
    keys: Object.keys(document.signed.keys),
    reason,
  });
  if (!candidate) {
    if (source.kind === "pinned") throw refused("a pinned key alone names no signing keys; pass a root document (--root root.json) or --root-url", { reason: "root_document_required" });
    return { trusted: base, report: describe(base, true, null) };
  }
  const verdict = verifyRootMetadata({ candidate, trusted: base, now });
  if (verdict.ok) return { trusted: candidate, report: describe(candidate, true, null) };
  return { trusted: base, report: describe(candidate, false, verdict.reason) };
}

export interface VerifyInput {
  manifest: Manifest;
  keySet: RootMetadata | null;
  payloads: ReadonlyMap<string, Uint8Array> | null;
  root: RootSource;
  scope: Scope;
  now: string;
  storedGeneration: number;
  countersignRoot?: RootMetadata | null;
  requireCountersign?: boolean;
}

export function verifyChain(input: VerifyInput): ChainReport & { trustedRoot: RootMetadata } {
  const { trusted, report: rootReport } = resolveRoot(input.root, input.keySet, input.now);
  const base: ChainReport & { trustedRoot: RootMetadata } = { ok: false, step: "root", reason: null, root: rootReport, manifest: summarizeManifest(input.manifest), signingKeyId: null, storedGeneration: input.storedGeneration, trustedRoot: trusted };
  if (!rootReport.accepted) return { ...base, reason: rootReport.reason };
  const envelope = verifyManifest({ manifest: input.manifest, root: trusted, now: input.now, scope: input.scope, storedGeneration: input.storedGeneration, payloads: null, countersignRoot: input.countersignRoot ?? null, ...(input.requireCountersign !== undefined ? { requireCountersign: input.requireCountersign } : {}) });
  if (!envelope.ok) return { ...base, step: "manifest", reason: envelope.reason };
  if (!input.payloads) return { ...base, ok: true, step: "manifest", signingKeyId: envelope.signingKeyId };
  const full = verifyManifest({ manifest: input.manifest, root: trusted, now: input.now, scope: input.scope, storedGeneration: input.storedGeneration, payloads: input.payloads, countersignRoot: input.countersignRoot ?? null, ...(input.requireCountersign !== undefined ? { requireCountersign: input.requireCountersign } : {}) });
  if (!full.ok) return { ...base, step: "payloads", reason: full.reason, signingKeyId: envelope.signingKeyId };
  return { ...base, ok: true, step: "complete", signingKeyId: full.signingKeyId };
}

export interface OpenedBundle {
  contents: BundleContents;
  encryption: "none" | "hpke";
  recipientKeyId: string | null;
  expired: boolean;
}

export function openBundleFile(bundle: Bundle, scope: { agentId: string; target: string }, key: DistributionKey | undefined, now: string): OpenedBundle {
  const contents = openBundle(bundle, scope, key);
  return {
    contents,
    encryption: bundle.encryption.scheme === "none" ? "none" : "hpke",
    recipientKeyId: bundle.encryption.scheme === "none" ? null : bundle.encryption.recipientKeyId,
    expired: instant(contents.notAfter) <= instant(now),
  };
}

export function payloadsOf(contents: BundleContents): Map<string, Buffer> {
  return bundlePayloadBytes(contents);
}
