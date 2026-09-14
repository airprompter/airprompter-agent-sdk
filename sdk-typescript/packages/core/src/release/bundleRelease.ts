/**
 * A bundle the customer loads, as a `ReleaseReader` (S10): `agent-runtime`
 * on its own — no store, no daemon, no network — renders and assigns over
 * it. The same chain as OTA runs before a byte is served: the bundle's key
 * set must descend from the pinned root (or be it), and the manifest's
 * signatures, scope, expiry and every payload hash must verify. There is
 * no anti-rollback here because there is no stored generation; that is the
 * slot store's rule (`agent-sync`).
 */

import { bundlePayloadBytes, openBundle, type DistributionKey } from "../bundle/apbundle.js";
import { verifyManifest, verifyRootMetadata } from "../protocol/trust.js";
import type { Bundle, BundleContents, RefusalCode, RootMetadata, Target } from "../protocol/types.js";
import type { LoadedRelease, ReleaseReader } from "./reader.js";

export interface BundleReleaseInput {
  bundle: Bundle;
  /** The pinned root of trust (`trustedRootFromPinnedKey`, or root metadata the host already holds). */
  root: RootMetadata;
  scope: { organizationId: string; agentId: string; target: Target };
  now: string;
  distributionKey?: DistributionKey;
  countersignRoot?: RootMetadata | null;
  requireCountersign?: boolean;
}

/** A bundle refused before it became a release: the bundle itself (`bundle_*`), or the chain (a `RefusalCode`). */
export type BundleReleaseRefusal = RefusalCode | "bundle_malformed" | "bundle_wrong_recipient" | "bundle_decrypt_failed" | "bundle_relabelled";

export class BundleRelease implements ReleaseReader {
  readonly kind = "bundle" as const;
  private constructor(
    private readonly release: LoadedRelease,
    /** The key set the bundle carried, once it verified against the pinned root: what a host pins next. */
    readonly keySet: RootMetadata,
    readonly notAfter: string,
  ) {}

  /** Open, verify, and hold: `{ ok: false, reason }` names the first rule the bundle failed. */
  static load(input: BundleReleaseInput): { ok: true; release: BundleRelease } | { ok: false; reason: BundleReleaseRefusal } {
    let contents: BundleContents;
    try {
      contents = openBundle(input.bundle, { agentId: input.scope.agentId, target: input.scope.target }, input.distributionKey);
    } catch (error) {
      const code = (error as { name?: string; code?: string }).name === "BundleError" ? (error as { code: string }).code : "malformed";
      return { ok: false, reason: `bundle_${code}` as BundleReleaseRefusal };
    }
    let root = input.root;
    const rootVerdict = verifyRootMetadata({ candidate: contents.keySet, trusted: root, now: input.now });
    if (rootVerdict.ok) root = contents.keySet;
    const payloads = bundlePayloadBytes(contents);
    const verdict = verifyManifest({
      manifest: contents.manifest,
      root,
      now: input.now,
      scope: input.scope,
      storedGeneration: 0,
      payloads,
      countersignRoot: input.countersignRoot ?? null,
      ...(input.requireCountersign !== undefined ? { requireCountersign: input.requireCountersign } : {}),
    });
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    return { ok: true, release: new BundleRelease({ manifest: contents.manifest, generation: verdict.generation, payloads }, root, contents.notAfter) };
  }

  current(): LoadedRelease {
    return this.release;
  }
}
