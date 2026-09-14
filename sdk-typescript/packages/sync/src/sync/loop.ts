/**
 * One sync pass, and the three ways of scheduling it.
 *
 *   resident:   every pollSeconds (jittered) — the edge pointer first,
 *               the manifest only when the generation moved
 *   on_invoke:  the same pass at invocation start and end (serverless has
 *               no background timer)
 *   daemon:     delegate to the host's daemon socket when present (T26);
 *               until then, in-process
 *
 * A pass never blocks a render and never throws past its caller: sync
 * failures degrade to the last verified release and are reported. Every
 * manifest goes through the trust chain before a byte is staged; payloads
 * already held for unchanged hashes are reused, so a pass fetches only what
 * moved.
 */

import { referencedPayloads, verifyManifest, verifyRootMetadata } from "@airprompter/agent-core";
import type { Manifest, RefusalCode, RootMetadata } from "@airprompter/agent-core";
import type { LoadedSlot, SlotStore } from "../store/slotStore.js";
import type { SyncClient } from "@airprompter/agent-core";

/** `activated_externally`: the customer's hook (or an operator) already made the staged release live during the decision. */
export type ApplyPolicyDecision = "activated" | "staged" | "activated_externally";

export interface SyncPassResult {
  /**
   * `pointer_unchanged`: the unsigned edge pointer said nothing moved — silence, not contact (S3).
   * `unchanged`: the origin's authenticated `304`, or a signed manifest at the generation already held — contact.
   */
  outcome: "pointer_unchanged" | "unchanged" | "activated" | "activated_externally" | "staged" | "refused" | "unavailable" | "nothing_promoted" | "held_back";
  generation?: number;
  reason?: RefusalCode | "unauthorized" | "forbidden" | "network" | string;
}

export interface SyncPassInput {
  store: SlotStore;
  client: SyncClient;
  now: () => string;
  scope: { organizationId: string; agentId: string; target: "dev" | "staging" | "prod" };
  /** The last accepted root, or the synthetic pinned document. */
  trustedRoot: RootMetadata;
  /** S3: the heartbeat said the origin is ahead of what the pointer showed — go to the signed manifest, skip the pointer. */
  skipPointer?: boolean;
  /** A candidate root document fetched beside the manifest, when the runtime polls one. */
  fetchRoot?: () => Promise<RootMetadata | null>;
  /** What the active slot holds (its payload bytes are reused for unchanged hashes). */
  active: LoadedSlot | null;
  etag: string | null;
  edgePointerUrl?: string | null;
  edgeEtag?: string | null;
  requireCountersign?: boolean;
  countersignRoot?: RootMetadata | null;
  /** Local policy: `auto` activates a verified release; `unlock_required` stages it and calls `onStaged`. */
  applyPolicy: (manifest: Manifest) => ApplyPolicyDecision | Promise<ApplyPolicyDecision>;
  onRefusal?: (reason: RefusalCode | string, generation: number | null) => void;
  /**
   * T15: the models this application declared it can call (`models` at start). A manifest whose slot (or arm
   * override) requires a model outside it is refused locally — `model_unavailable`, the release stays unactivated,
   * nothing is fetched — and `onModelUnavailable` names the missing models for the heartbeat. Null when the
   * application declared nothing: then no slot can be refused over its model.
   */
  catalog?: readonly string[] | null;
  onModelUnavailable?: (models: readonly string[], generation: number) => void;
  /**
   * T9: called with every manifest whose envelope verifies (signature, scope,
   * generation not below the stored one) BEFORE the pass decides whether to
   * stage, hold back or ignore it — so a `disable` (Freeze) or a
   * `request_unlock` rides a manifest the runtime would otherwise leave
   * staged or unchanged. Never a manifest that failed the trust chain.
   */
  onDirectives?: (payload: Manifest["payload"]) => void;
}

export interface SyncPassOutput extends SyncPassResult {
  etag: string | null;
  edgeEtag: string | null;
  trustedRoot: RootMetadata;
  active: LoadedSlot | null;
}

/** The required models of a payload (its slots and every arm override) that the declared catalog lacks; empty when nothing was declared. */
export function requiredModelsMissing(payload: Manifest["payload"], catalog: readonly string[] | null): string[] {
  if (catalog === null) return [];
  const declared = new Set(catalog);
  const missing = new Set<string>();
  const slots = [...payload.slots, ...(payload.experiment?.arms ?? []).flatMap((arm) => arm.overrides)];
  for (const slot of slots) if (slot.modelRequired === true && !declared.has(slot.model)) missing.add(slot.model);
  return [...missing].sort();
}

export async function syncOnce(input: SyncPassInput): Promise<SyncPassOutput> {
  const now = input.now();
  let trustedRoot = input.trustedRoot;
  let edgeEtag = input.edgeEtag ?? null;
  const done = (result: SyncPassResult, active = input.active, etag = input.etag): SyncPassOutput => ({ ...result, etag, edgeEtag, trustedRoot, active });

  try {
    // A newer root document is accepted only against the one already trusted (R1–R5).
    if (input.fetchRoot) {
      const candidate = await input.fetchRoot();
      if (candidate) {
        const verdict = verifyRootMetadata({ candidate, trusted: trustedRoot, now });
        if (verdict.ok) {
          trustedRoot = candidate;
          input.store.acceptRoot(candidate);
        } else {
          input.onRefusal?.(verdict.reason, null);
        }
      }
    }

    // Idle path: the edge pointer says whether anything moved, without a Lambda on the other end. It is unsigned and
    // cacheable, so its silence is never contact (S3): the lease does not move on `pointer_unchanged`.
    if (input.edgePointerUrl && !input.skipPointer) {
      const edge = await input.client.edgePointer(input.edgePointerUrl, edgeEtag);
      if (edge.status === "not_modified") return done({ outcome: "pointer_unchanged" });
      if (edge.status === "ok") {
        edgeEtag = edge.etag;
        if (input.active && edge.pointer.generation <= input.active.generation) return done({ outcome: "pointer_unchanged" });
      }
    }

    const fetched = await input.client.manifest({ ifNoneMatch: input.etag });
    if (fetched.status === "not_modified") return done({ outcome: "unchanged" });
    if (fetched.status === "not_found") return done({ outcome: "nothing_promoted" });
    if (fetched.status === "unauthorized" || fetched.status === "forbidden") {
      input.onRefusal?.(fetched.status, null);
      return done({ outcome: "unavailable", reason: fetched.status });
    }
    if (fetched.status === "error") return done({ outcome: "unavailable", reason: `http_${fetched.httpStatus}` });

    const manifest = fetched.manifest;
    const stored = input.store.state.generation;
    const envelope = verifyManifest({ manifest, root: trustedRoot, now, scope: input.scope, storedGeneration: stored, payloads: null, countersignRoot: input.countersignRoot ?? null, ...(input.requireCountersign !== undefined ? { requireCountersign: input.requireCountersign } : {}) });
    if (!envelope.ok) {
      input.onRefusal?.(envelope.reason, manifest.payload.generation);
      return done({ outcome: "refused", reason: envelope.reason, generation: manifest.payload.generation });
    }
    // The signature verified and the generation is not a rollback: its directives stand from here on.
    input.onDirectives?.(manifest.payload);
    if (manifest.payload.generation === stored) return done({ outcome: "unchanged" }, input.active, fetched.etag);
    const heldBackBelow = input.store.state.heldBackBelow;
    if (heldBackBelow !== undefined && manifest.payload.generation <= heldBackBelow) {
      // A local rollback stepped down from this generation on purpose; only a newer one ends the hold.
      return done({ outcome: "held_back", generation: manifest.payload.generation }, input.active, fetched.etag);
    }
    // T15: a required model this runtime cannot call refuses the release here — verified, never fetched, never staged.
    const missingModels = requiredModelsMissing(manifest.payload, input.catalog ?? null);
    if (missingModels.length > 0) {
      input.onModelUnavailable?.(missingModels, manifest.payload.generation);
      input.onRefusal?.("model_unavailable", manifest.payload.generation);
      return done({ outcome: "refused", reason: "model_unavailable", generation: manifest.payload.generation }, input.active, fetched.etag);
    }

    // Fetch only what moved; the bytes already verified in the active slot are reused for unchanged hashes.
    const payloads = new Map<string, Uint8Array>();
    for (const hash of referencedPayloads(manifest.payload).keys()) {
      const held = input.active?.payloads.get(hash);
      if (held) {
        payloads.set(hash, held);
        continue;
      }
      const bytes = await input.client.payload(hash);
      if (!bytes) {
        input.onRefusal?.("payload_missing", manifest.payload.generation);
        return done({ outcome: "refused", reason: "payload_missing", generation: manifest.payload.generation });
      }
      payloads.set(hash, bytes);
    }
    const full = verifyManifest({ manifest, root: trustedRoot, now, scope: input.scope, storedGeneration: stored, payloads, countersignRoot: input.countersignRoot ?? null, ...(input.requireCountersign !== undefined ? { requireCountersign: input.requireCountersign } : {}) });
    if (!full.ok) {
      input.onRefusal?.(full.reason, manifest.payload.generation);
      return done({ outcome: "refused", reason: full.reason, generation: manifest.payload.generation });
    }

    // All-or-nothing: the current slot stays whole until the new one is complete and fsynced.
    input.store.stage({ manifest, payloads });
    const decision = await input.applyPolicy(manifest);
    if (decision === "staged") return done({ outcome: "staged", generation: manifest.payload.generation }, input.active, fetched.etag);
    // The hook activated it itself: the caller's active slot already moved; nothing here to load.
    if (decision === "activated_externally") return done({ outcome: "activated_externally", generation: manifest.payload.generation }, input.active, fetched.etag);
    const slot = input.store.activate();
    const active = input.store.load(slot, { now, root: trustedRoot, countersignRoot: input.countersignRoot ?? null, ...(input.requireCountersign !== undefined ? { requireCountersign: input.requireCountersign } : {}) });
    return done({ outcome: "activated", generation: manifest.payload.generation }, active, fetched.etag);
  } catch (error) {
    input.onRefusal?.(`network:${(error as Error).message}`, null);
    return done({ outcome: "unavailable", reason: "network" });
  }
}

export function jitteredDelayMs(baseSeconds: number, random: () => number = Math.random): number {
  // ±20 %: a fleet restarted together must not poll together.
  const jitter = (random() * 2 - 1) * 0.2;
  return Math.max(1000, Math.round(baseSeconds * 1000 * (1 + jitter)));
}
