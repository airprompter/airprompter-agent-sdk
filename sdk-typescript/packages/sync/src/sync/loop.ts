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
 *
 * @example
 * ```ts
 * let state = { active: null as LoadedSlot | null, etag: null as string | null, edgeEtag: null as string | null, trustedRoot };
 * const pass = await syncOnce({
 *   store, client, now: () => new Date().toISOString(), scope, ...state,
 *   edgePointerUrl, // the CDN pointer read first; its silence never moves the lease
 *   applyPolicy: (manifest) => (manifest.payload.applyPolicy === "auto" ? "activated" : "staged"),
 *   onRefusal: (reason, generation) => log({ event: "sync_refused", reason, generation }),
 * });
 * state = { active: pass.active, etag: pass.etag, edgeEtag: pass.edgeEtag, trustedRoot: pass.trustedRoot }; // hand back verbatim next time
 * setTimeout(tick, jitteredDelayMs(pollSeconds)); // ±20 %, so a fleet restarted together does not poll together
 * ```
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
   * `pinned_unchanged` (0.3.5): pinned to a release, and the pinned envelope answered is what this pass already
   * holds — distinct from `pointer_unchanged` because a pinned read always contacts the origin (pins.md: a pinned
   * read never long-polls, but it is never skipped on the pointer's silence either — the pointer only ever
   * decides whether step 3 below also asks for the live manifest).
   */
  outcome: "pointer_unchanged" | "unchanged" | "pinned_unchanged" | "activated" | "activated_externally" | "staged" | "refused" | "unavailable" | "nothing_promoted" | "held_back";
  generation?: number;
  reason?: RefusalCode | "unauthorized" | "forbidden" | "network" | string;
  /** The control plane's own word for a `forbidden` answer (its `details.code`), or the transport error for `network`. */
  detail?: string;
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
  /**
   * 0.3.5 (pins.md): pin the CONTENT this pass fetches and stages to one named seal, while control — directives,
   * lease, countersign — keeps coming from the live manifest fetched in step 3 below and returned as
   * `liveControl`. `release` is what `client.manifest({ release })` sends: a seal id or a full release digest.
   */
  pin?: { release: string };
  /** The etag of the last LIVE manifest this pass (or a previous one) fetched, for `If-None-Match` on step 3's live read. Ignored when `pin` is unset. */
  liveEtag?: string | null;
  /**
   * 0.3.5: the caller just unpinned — this (unpinned) pass's anti-rollback is scoped to the pointer's own
   * generation instead of the store's counter, and forces the stage past it exactly once when the pointer's
   * release sits below what the store holds (pins.md › unpinning re-bases). Ignored when `pin` is set.
   */
  rebase?: boolean;
}

export interface SyncPassOutput extends SyncPassResult {
  etag: string | null;
  edgeEtag: string | null;
  trustedRoot: RootMetadata;
  active: LoadedSlot | null;
  /**
   * 0.3.5: set only on a pinned pass that also read the live manifest (after a successful pinned activation, or
   * when the edge pointer moved since the last pass) — verified for signature and scope only, never staged, its
   * payloads never fetched, its models never checked. The caller adopts its `directives` / lease / countersign and
   * keeps its `etag` for the next pass's `liveEtag`.
   */
  liveControl?: { manifest: Manifest; etag: string | null };
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

    // 0.3.5 (pins.md): a pinned pass fetches CONTENT from the named seal, never the pointer — a separate branch,
    // because the edge pointer's silence must never decide pinned content (only whether step 3 below also
    // re-reads the live manifest) and the anti-rollback scope is the pinned envelope's own generation, not the
    // store's counter.
    if (input.pin) return syncPinned(input, input.pin, now, trustedRoot, edgeEtag);

    // Idle path: the edge pointer says whether anything moved, without a Lambda on the other end. It is unsigned and
    // cacheable, so its silence is never contact (S3): the lease does not move on `pointer_unchanged`. Skipped on a
    // rebase pass (0.3.5, right after `unpin()`): the edge pointer's cached etag may not have moved even though
    // what this runtime holds (a pinned release) is nowhere near the pointer's generation — the first unpinned
    // pass after unpinning always goes to the signed manifest.
    if (input.edgePointerUrl && !input.skipPointer && !input.rebase) {
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
      return done({ outcome: "unavailable", reason: fetched.status, ...(fetched.status === "forbidden" && fetched.code ? { detail: fetched.code } : {}) });
    }
    if (fetched.status === "error") return done({ outcome: "unavailable", reason: `http_${fetched.httpStatus}` });
    // Never actually reached: an unpinned pass never sends `release`, so the platform never answers `refused_seal`
    // here (only `syncPinned` below, which passes `release`, sees this branch). Handled for exhaustiveness.
    if (fetched.status === "refused_seal") return done({ outcome: "unavailable", reason: "network", detail: `unexpected refused_seal: ${fetched.code}` });

    const manifest = fetched.manifest;
    const stored = input.store.state.generation;
    // 0.3.5 (pins.md): the first pass after `unpin()` re-bases to the pointer — a pinned envelope may have been
    // older than the store's generation (forced past it), so the pointer's own release must never be seen as a
    // rollback merely because the pin outran it. `rebase` is consumed here, once, by whichever pass sees it first.
    const envelope = verifyManifest({ manifest, root: trustedRoot, now, scope: input.scope, storedGeneration: input.rebase ? 0 : stored, payloads: null, countersignRoot: input.countersignRoot ?? null, ...(input.requireCountersign !== undefined ? { requireCountersign: input.requireCountersign } : {}) });
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
    const full = verifyManifest({ manifest, root: trustedRoot, now, scope: input.scope, storedGeneration: input.rebase ? 0 : stored, payloads, countersignRoot: input.countersignRoot ?? null, ...(input.requireCountersign !== undefined ? { requireCountersign: input.requireCountersign } : {}) });
    if (!full.ok) {
      input.onRefusal?.(full.reason, manifest.payload.generation);
      return done({ outcome: "refused", reason: full.reason, generation: manifest.payload.generation });
    }

    // All-or-nothing: the current slot stays whole until the new one is complete and fsynced.
    input.store.stage({ manifest, payloads, ...(input.rebase && manifest.payload.generation < stored ? { force: true } : {}) });
    const decision = await input.applyPolicy(manifest);
    if (decision === "staged") return done({ outcome: "staged", generation: manifest.payload.generation }, input.active, fetched.etag);
    // The hook activated it itself: the caller's active slot already moved; nothing here to load.
    if (decision === "activated_externally") return done({ outcome: "activated_externally", generation: manifest.payload.generation }, input.active, fetched.etag);
    const slot = input.store.activate();
    const active = input.store.load(slot, { now, root: trustedRoot, countersignRoot: input.countersignRoot ?? null, ...(input.requireCountersign !== undefined ? { requireCountersign: input.requireCountersign } : {}) });
    return done({ outcome: "activated", generation: manifest.payload.generation }, active, fetched.etag);
  } catch (error) {
    input.onRefusal?.(`network:${(error as Error).message}`, null);
    return done({ outcome: "unavailable", reason: "network", detail: String((error as Error).message ?? error).slice(0, 240) });
  }
}

/**
 * 0.3.5 (pins.md): the pinned half of a pass. Fetches `?release=<pin.release>` instead of the pointer's manifest,
 * verifies and stages it (forcing past the store's own generation counter only when the pinned envelope is
 * older — "pinned envelopes may be older"), then — after a successful activation, or when the edge pointer moved
 * since the last pass — reads the LIVE manifest (verified for signature/scope only, never staged) so the caller
 * can adopt its directives, lease and countersign requirement as `liveControl`. When `input.edgePointerUrl` is
 * absent there is no pointer whose silence can ever report "moved", so every pinned pass treats itself as moved
 * and re-reads the live manifest — otherwise a pinned runtime with no pointer configured would go deaf to live
 * control (a `disable`/Freeze directive, a lease change, a countersign requirement) forever after its first
 * activation. The live read still sends `If-None-Match: input.liveEtag`, so this costs one 304 per quiet tick —
 * the same price the unpinned path already pays with no pointer.
 */
async function syncPinned(input: SyncPassInput, pin: { release: string }, now: string, trustedRoot: RootMetadata, edgeEtagIn: string | null): Promise<SyncPassOutput> {
  let edgeEtag = edgeEtagIn;
  // No pointer configured: there is nothing whose silence could ever flip this to true, so every pinned pass
  // must re-read the live manifest itself (step 3 below) — otherwise a pinned runtime with no
  // `input.edgePointerUrl` would never again see live control (directives/lease/countersign) after its first
  // activation. The live read already sends `If-None-Match: input.liveEtag`, so a quiet environment still costs
  // only one 304 per tick — the same price the unpinned path pays without a pointer.
  let pointerMoved = !input.edgePointerUrl;
  if (input.edgePointerUrl) {
    const edge = await input.client.edgePointer(input.edgePointerUrl, edgeEtag);
    // The pointer's silence (`not_modified`) never decides pinned content and is not itself "moved" — only a new
    // etag counts, and only for whether step 3 below also re-reads the live manifest.
    if (edge.status === "ok") {
      pointerMoved = edge.etag !== edgeEtag;
      edgeEtag = edge.etag;
    }
  }
  const done = (result: SyncPassResult, active = input.active, etag = input.etag): SyncPassOutput => ({ ...result, etag, edgeEtag, trustedRoot, active });

  const withLiveControl = async (base: SyncPassOutput): Promise<SyncPassOutput> => {
    const activated = base.outcome === "activated" || base.outcome === "activated_externally";
    if (!activated && !pointerMoved) return base;
    const liveFetched = await input.client.manifest({ ifNoneMatch: input.liveEtag ?? null });
    if (liveFetched.status !== "ok") return base; // 304, refused, or unavailable: keep whatever control the caller already adopted.
    const liveVerdict = verifyManifest({
      manifest: liveFetched.manifest,
      root: base.trustedRoot,
      now,
      scope: input.scope,
      // Signature/scope only — not compared against a stored generation counter, the way the trust chain's
      // anti-rollback normally is: the live manifest is never staged, so there is nothing here to protect.
      storedGeneration: 0,
      payloads: null,
      countersignRoot: input.countersignRoot ?? null,
      ...(input.requireCountersign !== undefined ? { requireCountersign: input.requireCountersign } : {}),
    });
    if (!liveVerdict.ok) {
      input.onRefusal?.(liveVerdict.reason, liveFetched.manifest.payload.generation);
      return base;
    }
    return { ...base, liveControl: { manifest: liveFetched.manifest, etag: liveFetched.etag } };
  };

  const fetched = await input.client.manifest({ ifNoneMatch: input.etag, release: pin.release });
  if (fetched.status === "not_modified") return withLiveControl(done({ outcome: "pinned_unchanged" }));
  if (fetched.status === "refused_seal") {
    input.onRefusal?.(fetched.code, null);
    return withLiveControl(done({ outcome: "refused", reason: fetched.code, ...(fetched.matches?.length ? { detail: fetched.matches.join(",") } : {}) }));
  }
  if (fetched.status === "not_found") return withLiveControl(done({ outcome: "nothing_promoted" }));
  if (fetched.status === "unauthorized" || fetched.status === "forbidden") {
    input.onRefusal?.(fetched.status, null);
    return withLiveControl(done({ outcome: "unavailable", reason: fetched.status, ...(fetched.status === "forbidden" && fetched.code ? { detail: fetched.code } : {}) }));
  }
  if (fetched.status === "error") return withLiveControl(done({ outcome: "unavailable", reason: `http_${fetched.httpStatus}` }));

  const manifest = fetched.manifest;
  // Pinned envelopes may be older than whatever this runtime last held (unpinned, or a different pin): the trust
  // chain's M-check is bypassed here (storedGeneration: 0) rather than refusing an older pinned generation before
  // it is even staged — `stage()`'s own `force` below is the one real gate, against the STORE's counter.
  const envelope = verifyManifest({ manifest, root: trustedRoot, now, scope: input.scope, storedGeneration: 0, payloads: null, countersignRoot: input.countersignRoot ?? null, ...(input.requireCountersign !== undefined ? { requireCountersign: input.requireCountersign } : {}) });
  if (!envelope.ok) {
    input.onRefusal?.(envelope.reason, manifest.payload.generation);
    return withLiveControl(done({ outcome: "refused", reason: envelope.reason, generation: manifest.payload.generation }));
  }
  // "Unchanged" for a pinned pass: this pass answered the same generation already held for THIS pin (the active
  // release, while pinned — never the store's counter, which may belong to a different, earlier pin or an
  // unpinned release).
  if (input.active && manifest.payload.generation === input.active.generation) return withLiveControl(done({ outcome: "pinned_unchanged" }, input.active, fetched.etag));

  const missingModels = requiredModelsMissing(manifest.payload, input.catalog ?? null);
  if (missingModels.length > 0) {
    input.onModelUnavailable?.(missingModels, manifest.payload.generation);
    input.onRefusal?.("model_unavailable", manifest.payload.generation);
    return withLiveControl(done({ outcome: "refused", reason: "model_unavailable", generation: manifest.payload.generation }, input.active, fetched.etag));
  }

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
      return withLiveControl(done({ outcome: "refused", reason: "payload_missing", generation: manifest.payload.generation }));
    }
    payloads.set(hash, bytes);
  }
  const full = verifyManifest({ manifest, root: trustedRoot, now, scope: input.scope, storedGeneration: 0, payloads, countersignRoot: input.countersignRoot ?? null, ...(input.requireCountersign !== undefined ? { requireCountersign: input.requireCountersign } : {}) });
  if (!full.ok) {
    input.onRefusal?.(full.reason, manifest.payload.generation);
    return withLiveControl(done({ outcome: "refused", reason: full.reason, generation: manifest.payload.generation }));
  }

  // "Pinned envelopes may be older": force past the STORE's own generation counter only when this pinned
  // generation sits below it — the store records `forcedDowngrade` exactly as an operator's local rollback does.
  const forceStage = manifest.payload.generation < input.store.state.generation;
  input.store.stage({ manifest, payloads, ...(forceStage ? { force: true } : {}) });
  const decision = await input.applyPolicy(manifest);
  if (decision === "staged") return withLiveControl(done({ outcome: "staged", generation: manifest.payload.generation }, input.active, fetched.etag));
  if (decision === "activated_externally") return withLiveControl(done({ outcome: "activated_externally", generation: manifest.payload.generation }, input.active, fetched.etag));
  const slot = input.store.activate();
  const active = input.store.load(slot, { now, root: trustedRoot, countersignRoot: input.countersignRoot ?? null, ...(input.requireCountersign !== undefined ? { requireCountersign: input.requireCountersign } : {}) });
  return withLiveControl(done({ outcome: "activated", generation: manifest.payload.generation }, active, fetched.etag));
}

export function jitteredDelayMs(baseSeconds: number, random: () => number = Math.random): number {
  // ±20 %: a fleet restarted together must not poll together.
  const jitter = (random() * 2 - 1) * 0.2;
  return Math.max(1000, Math.round(baseSeconds * 1000 * (1 + jitter)));
}
