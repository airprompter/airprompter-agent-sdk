/**
 * One pull, no store: fetch the release promoted to a target, run the whole
 * verification chain, and hand back an `.apbundle` — the artifact a fleet
 * carries through its own store (a database row, an object, a config
 * entry) to runtimes that never hold an Agent key. `airprompter pull` is
 * this function with files around it; a puller job is this function with a
 * database around it. The bundle is sealed to the fleet's distribution key
 * unless the caller asks for plaintext, which only the dev target permits.
 *
 * The cheap path: the control plane names an edge pointer (a few hundred
 * bytes behind a CDN, `generation.json`) in its manifest answer; a puller
 * that hands back `edge` from the last result reads the pointer first — a
 * 304, or a generation it already holds, means nothing moved and the origin
 * is never called. Only a moved pointer (or none known) reaches the API,
 * and that read is conditional too (`manifestEtag`). Steady state costs a
 * CDN 304 per interval, not an API request; `nextPullDelayMs` stretches the
 * interval while nothing changes.
 */

import { createEncryptedBundle, createPlaintextBundle, referencedPayloads, verifyManifest, verifyRootMetadata } from "@airprompter/agent-core";
import type { Bundle, BundleContents, Manifest, RefusalCode, RootMetadata, SyncClient } from "@airprompter/agent-core";

export interface PullBundleInput {
  client: SyncClient;
  scope: { organizationId: string; agentId: string; target: "dev" | "staging" | "prod" };
  /** The last accepted root, or the synthetic pinned document. */
  trustedRoot: RootMetadata;
  /**
   * The environment's root document, fetched beside the manifest. A pinned key alone names the ROOT, not the signing
   * keys under it: with `trustedRoot` built from a pinned key and no `fetchRoot`, every manifest refuses
   * `unknown_signing_key`. Pass the fetch (the edge serves `roots/{environment}/root.json`) unless `trustedRoot` is
   * already a full root document.
   */
  fetchRoot?: () => Promise<RootMetadata | null>;
  /**
   * The newest generation the caller already holds (its store's MAX(generation)). A control plane answering with an
   * OLDER generation is reported as `generation_rollback` instead of becoming a quiet extra row. 0 when unknown.
   */
  minimumGeneration?: number;
  now: () => string;
  /**
   * The fleet's X25519 distribution public key (32 raw bytes): the bundle is sealed to it. `null` writes plaintext,
   * allowed for the dev target only — every other target's bundle is ciphertext wherever it lands.
   */
  distributionPublicKey: Uint8Array | null;
  /** How long the bundle stays usable as a fallback; 90 days unless told otherwise, 365 at most. */
  notAfterDays?: number;
  countersignRoot?: RootMetadata | null;
  requireCountersign?: boolean;
  /**
   * What the last result handed back: the pointer URL the control plane named, the pointer's ETag, and the ETag of the
   * manifest last read. Pass it back verbatim; the first pull has none and goes to the origin once.
   */
  edge?: PullEdgeState | null;
  /** Skip the pointer for this pull (a nudge said "check now", or the operator asked): the origin is read, conditionally. */
  skipPointer?: boolean;
  /**
   * The bound on a stuck pointer: when the origin was last consulted longer ago than this, the pointer is skipped and
   * the origin read (conditionally — one API 304 when nothing moved). A pointer a CDN pinned, or one the control
   * plane failed to write, can hide a promotion only this long. One hour unless told otherwise.
   */
  maxPointerAgeMs?: number;
}

/**
 * The puller's memory between pulls: content-free. Persist it WITH the row it was returned beside (the same
 * transaction), never before it — a saved `manifestEtag` for a row that was never written makes the next origin read
 * a 304 and the row is never written.
 */
export interface PullEdgeState {
  pointerUrl: string | null;
  pointerEtag: string | null;
  manifestEtag: string | null;
  /** When the origin last answered (ISO); the pointer is trusted to say "nothing moved" only for `maxPointerAgeMs` after it. */
  lastOriginAt: string | null;
}

const NO_EDGE: PullEdgeState = { pointerUrl: null, pointerEtag: null, manifestEtag: null, lastOriginAt: null };
export const DEFAULT_MAX_POINTER_AGE_MS = 60 * 60 * 1000;

export type PullBundleResult =
  | { status: "ok"; bundle: Bundle; manifest: Manifest; generation: number; releaseDigest: string; createdAt: string; notAfter: string; trustedRoot: RootMetadata; edge: PullEdgeState }
  /** Nothing moved: the pointer (a CDN read, no origin call) or the origin's 304 said so. */
  | { status: "unchanged"; via: "pointer" | "origin"; edge: PullEdgeState }
  | { status: "nothing_promoted"; edge: PullEdgeState }
  | { status: "refused"; reason: RefusalCode | "payload_missing" | "payload_length_mismatch" | "plaintext_not_allowed" | "root_refused" | "generation_rollback"; contentHash?: string; detail?: string; held?: number; edge: PullEdgeState }
  | { status: "unavailable"; reason: "unauthorized" | "forbidden" | "network" | `http_${number}`; detail?: string; edge: PullEdgeState };

/**
 * How long to wait before the next pull: the interval while things change, stretching by doubling while nothing does
 * (a pointer 304 costs little, but a thousand pullers asking every ten seconds for a release that moved last week is
 * waste), never past `capMs`; back to the interval on any change, refusal or outage — those are what a puller is for.
 */
export function nextPullDelayMs(input: { outcome: PullBundleResult["status"]; unchangedStreak: number; intervalMs: number; capMs?: number }): number {
  const cap = input.capMs ?? 5 * 60 * 1000;
  if (input.outcome !== "unchanged") return input.intervalMs;
  const stretched = input.intervalMs * 2 ** Math.min(input.unchangedStreak, 20);
  return Math.min(Math.max(input.intervalMs, stretched), Math.max(cap, input.intervalMs));
}

export async function pullBundle(input: PullBundleInput): Promise<PullBundleResult> {
  const now = input.now();
  // What the caller handed back is returned unchanged on every failure: an ETag advanced past an answer the origin
  // never confirmed would make the next pull a 304 and hide the promotion until the one after it.
  const given: PullEdgeState = { ...NO_EDGE, ...(input.edge ?? {}) };
  const edge: PullEdgeState = { ...given };
  if (input.distributionPublicKey === null && input.scope.target !== "dev") return { status: "refused", reason: "plaintext_not_allowed", edge };
  const days = input.notAfterDays ?? 90;
  if (!Number.isFinite(days) || days <= 0 || days > 365) throw new Error("notAfterDays must be a positive number of days, 365 at most");
  const held = input.minimumGeneration ?? 0;

  let trustedRoot = input.trustedRoot;
  try {
    // The pointer first: unsigned and cacheable, it can only say "nothing moved" — never extend trust. A 304, or a
    // generation the caller already holds, ends the pull at the CDN. Anything else (moved, unknown, unreachable,
    // malformed) goes on to the origin, which is what a pointer can never replace — and so does a pointer that has
    // said "nothing moved" for longer than `maxPointerAgeMs`, the bound on a stuck one.
    const originAge = given.lastOriginAt ? Date.parse(now) - Date.parse(given.lastOriginAt) : Number.POSITIVE_INFINITY;
    const pointerTrusted = originAge <= (input.maxPointerAgeMs ?? DEFAULT_MAX_POINTER_AGE_MS);
    let pointerEtag: string | null | undefined;
    if (given.pointerUrl && !input.skipPointer && pointerTrusted) {
      try {
        const pointer = await input.client.edgePointer(given.pointerUrl, given.pointerEtag);
        if (pointer.status === "not_modified") return { status: "unchanged", via: "pointer", edge: given };
        if (pointer.status === "ok") {
          const generation = pointer.pointer?.generation;
          pointerEtag = pointer.etag;
          if (held > 0 && typeof generation === "number" && Number.isFinite(generation) && generation <= held) return { status: "unchanged", via: "pointer", edge: { ...given, pointerEtag: pointer.etag } };
        }
      } catch {
        // A CDN outage or a malformed pointer is not an answer: the origin is asked.
      }
    }
    if (input.fetchRoot) {
      const candidate = await input.fetchRoot();
      if (candidate) {
        const verdict = verifyRootMetadata({ candidate, trusted: trustedRoot, now });
        // A root that does not descend from the trusted one is the finding, not a detail behind unknown_signing_key.
        if (!verdict.ok) return { status: "refused", reason: "root_refused", detail: verdict.reason, edge: given };
        trustedRoot = candidate;
      }
    }
    // Conditional: the origin answers 304 to the ETag it last gave, and names the pointer either way.
    const fetched = await input.client.manifest({ ifNoneMatch: given.manifestEtag });
    if (fetched.status === "not_found") return { status: "nothing_promoted", edge: given };
    if (fetched.status === "unauthorized") return { status: "unavailable", reason: "unauthorized", edge: given };
    if (fetched.status === "forbidden") return { status: "unavailable", reason: "forbidden", ...(fetched.code ? { detail: fetched.code } : {}), edge: given };
    if (fetched.status === "error") return { status: "unavailable", reason: `http_${fetched.httpStatus}`, edge: given };
    // The origin answered: the pointer it names, the ETag it moved to, and the moment — the pointer's trust starts here.
    if (fetched.edgePointerUrl) edge.pointerUrl = fetched.edgePointerUrl;
    if (pointerEtag !== undefined) edge.pointerEtag = pointerEtag;
    edge.lastOriginAt = now;
    if (fetched.status === "not_modified") return { status: "unchanged", via: "origin", edge };
    const manifest = fetched.manifest;
    if (manifest.payload.generation < held) return { status: "refused", reason: "generation_rollback", held, detail: `the control plane answered generation ${manifest.payload.generation}; the caller holds ${held}`, edge: given };

    const payloads = new Map<string, Uint8Array>();
    for (const [hash, byteLength] of referencedPayloads(manifest.payload)) {
      const bytes = await input.client.payload(hash);
      if (!bytes) return { status: "refused", reason: "payload_missing", contentHash: hash, edge: given };
      if (bytes.length !== byteLength) return { status: "refused", reason: "payload_length_mismatch", contentHash: hash, edge: given };
      payloads.set(hash, bytes);
    }
    // No stored generation here: a puller has no host to move backwards. Anti-rollback is the store's rule, applied
    // by every runtime that opens this bundle.
    const verdict = verifyManifest({ manifest, root: trustedRoot, now, scope: input.scope, storedGeneration: 0, payloads, countersignRoot: input.countersignRoot ?? null, ...(input.requireCountersign !== undefined ? { requireCountersign: input.requireCountersign } : {}) });
    if (!verdict.ok) return { status: "refused", reason: verdict.reason, edge: given };
    // The bundle is built: the manifest's ETag is the caller's to keep — with the row, never before it.
    edge.manifestEtag = fetched.etag;

    const notAfter = new Date(Date.parse(now) + days * 86_400_000).toISOString();
    const contents: BundleContents = {
      createdAt: now,
      notAfter,
      manifest,
      keySet: trustedRoot,
      payloads: [...payloads].map(([contentHash, bytes]) => ({ contentHash: contentHash as `sha256:${string}`, byteLength: bytes.length, bytes: Buffer.from(bytes).toString("base64url") })),
    };
    const bundle = input.distributionPublicKey ? createEncryptedBundle(contents, input.distributionPublicKey) : createPlaintextBundle(contents);
    return { status: "ok", bundle, manifest, generation: manifest.payload.generation, releaseDigest: manifest.payload.releaseDigest, createdAt: now, notAfter, trustedRoot, edge };
  } catch (error) {
    return { status: "unavailable", reason: "network", detail: (error as Error).message, edge: given };
  }
}
