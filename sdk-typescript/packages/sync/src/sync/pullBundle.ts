/**
 * One pull, no store: fetch the release promoted to a target, run the whole
 * verification chain, and hand back an `.apbundle` — the artifact a fleet
 * carries through its own store (a database row, an object, a config
 * entry) to runtimes that never hold an Agent key. `airprompter pull` is
 * this function with files around it; a puller job is this function with a
 * database around it. The bundle is sealed to the fleet's distribution key
 * unless the caller asks for plaintext, which only the dev target permits.
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
}

export type PullBundleResult =
  | { status: "ok"; bundle: Bundle; manifest: Manifest; generation: number; releaseDigest: string; createdAt: string; notAfter: string; trustedRoot: RootMetadata }
  | { status: "nothing_promoted" }
  | { status: "refused"; reason: RefusalCode | "payload_missing" | "payload_length_mismatch" | "plaintext_not_allowed" | "root_refused" | "generation_rollback"; contentHash?: string; detail?: string; held?: number }
  | { status: "unavailable"; reason: "unauthorized" | "forbidden" | "network" | `http_${number}`; detail?: string };

export async function pullBundle(input: PullBundleInput): Promise<PullBundleResult> {
  const now = input.now();
  if (input.distributionPublicKey === null && input.scope.target !== "dev") return { status: "refused", reason: "plaintext_not_allowed" };
  const days = input.notAfterDays ?? 90;
  if (!Number.isFinite(days) || days <= 0 || days > 365) throw new Error("notAfterDays must be a positive number of days, 365 at most");

  let trustedRoot = input.trustedRoot;
  try {
    if (input.fetchRoot) {
      const candidate = await input.fetchRoot();
      if (candidate) {
        const verdict = verifyRootMetadata({ candidate, trusted: trustedRoot, now });
        // A root that does not descend from the trusted one is the finding, not a detail behind unknown_signing_key.
        if (!verdict.ok) return { status: "refused", reason: "root_refused", detail: verdict.reason };
        trustedRoot = candidate;
      }
    }
    const fetched = await input.client.manifest({});
    if (fetched.status === "not_found") return { status: "nothing_promoted" };
    if (fetched.status === "unauthorized") return { status: "unavailable", reason: "unauthorized" };
    if (fetched.status === "forbidden") return { status: "unavailable", reason: "forbidden", ...(fetched.code ? { detail: fetched.code } : {}) };
    if (fetched.status === "error") return { status: "unavailable", reason: `http_${fetched.httpStatus}` };
    if (fetched.status === "not_modified") return { status: "unavailable", reason: "http_304" };
    const manifest = fetched.manifest;
    const held = input.minimumGeneration ?? 0;
    if (manifest.payload.generation < held) return { status: "refused", reason: "generation_rollback", held, detail: `the control plane answered generation ${manifest.payload.generation}; the caller holds ${held}` };

    const payloads = new Map<string, Uint8Array>();
    for (const [hash, byteLength] of referencedPayloads(manifest.payload)) {
      const bytes = await input.client.payload(hash);
      if (!bytes) return { status: "refused", reason: "payload_missing", contentHash: hash };
      if (bytes.length !== byteLength) return { status: "refused", reason: "payload_length_mismatch", contentHash: hash };
      payloads.set(hash, bytes);
    }
    // No stored generation here: a puller has no host to move backwards. Anti-rollback is the store's rule, applied
    // by every runtime that opens this bundle.
    const verdict = verifyManifest({ manifest, root: trustedRoot, now, scope: input.scope, storedGeneration: 0, payloads, countersignRoot: input.countersignRoot ?? null, ...(input.requireCountersign !== undefined ? { requireCountersign: input.requireCountersign } : {}) });
    if (!verdict.ok) return { status: "refused", reason: verdict.reason };

    const notAfter = new Date(Date.parse(now) + days * 86_400_000).toISOString();
    const contents: BundleContents = {
      createdAt: now,
      notAfter,
      manifest,
      keySet: trustedRoot,
      payloads: [...payloads].map(([contentHash, bytes]) => ({ contentHash: contentHash as `sha256:${string}`, byteLength: bytes.length, bytes: Buffer.from(bytes).toString("base64url") })),
    };
    const bundle = input.distributionPublicKey ? createEncryptedBundle(contents, input.distributionPublicKey) : createPlaintextBundle(contents);
    return { status: "ok", bundle, manifest, generation: manifest.payload.generation, releaseDigest: manifest.payload.releaseDigest, createdAt: now, notAfter, trustedRoot };
  } catch (error) {
    return { status: "unavailable", reason: "network", detail: (error as Error).message };
  }
}
