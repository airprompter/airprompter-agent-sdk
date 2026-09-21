/**
 * The customer's own copy of a release (`protocol/pins.md` › "Customer-store seal"): a `MirrorPort` the
 * application supplies (a config row, a database, a file in its own deploy), the seal recomputed against it each
 * tick with core's `verifySeal`, and the render path that reads from it once it is written. The runtime never
 * overwrites the customer's copy on its own initiative — only `AirPrompterAgent.mirror()`'s materialise rule (a
 * copy that is `null`, or intact for the release this SDK itself last wrote) and `resync({ approvedBy })` write to
 * it; a broken copy is reported, never repaired behind the application's back.
 *
 * @example
 * ```ts
 * const mirror = new Mirror(port);
 * await mirror.refresh(); // read → cache; a throw propagates so the caller can log mirror_unreadable and leave the cache as it was
 * if (!mirror.copy) await mirror.materialise(release); // write once, cache it
 * const report = mirror.computeReport(release, now); // { sealId, observedDigest, intact, checkedAt, brokenAt?, changedTags? }
 * const slot = mirror.slotFor("support.triage"); // reads from the cached copy, not the store
 * ```
 */

import { sealIdOf, verifySeal, type Directive, type LoadedRelease, type ManifestSlot } from "@airprompter/agent-core";

/** What the customer's store holds against the seal it was written from (pins.md): the pins verbatim, and every text they reference, base64url by `contentHash`. */
export interface MirrorCopy {
  sealId: string;
  pins: ManifestSlot[];
  texts: Record<string, string>;
}

/**
 * The seam to the application's own store. `read()` returns `null` when nothing has been written yet (or the
 * store was reset); a throw is the application's own failure to reach its store, never a seal break. `write()` is
 * called only by `Mirror.materialise` / `Mirror.resync`, orchestrated by `AirPrompterAgent` — never on a schedule,
 * never because a heartbeat round trip suggested it (pins.md). `onResyncRequested` is informational: the runtime
 * never re-materialises on its own when a `request_resync` directive arrives, it only calls this hook.
 */
export interface MirrorPort {
  read(): Promise<MirrorCopy | null>;
  write(copy: MirrorCopy): Promise<void>;
  onResyncRequested?(request: { sealId: string; directive: Extract<Directive, { kind: "request_resync" }> }): void | Promise<void>;
}

/** The result of the last recomputation (pins.md `seal` heartbeat member), content-free. */
export interface SealReport {
  sealId: string;
  observedDigest: string;
  intact: boolean;
  checkedAt: string;
  /** The instance's own first observation of a broken store; held across re-checks (never moved) until it heals. */
  brokenAt?: string;
  /** Sorted, deduped, never text — absent (never an empty array) once every pin re-hashes and re-projects clean. */
  changedTags?: string[];
}

/** The mirror copy this SDK itself would write for a release: every slot pin verbatim, every text it references, base64url. */
export function copyFromRelease(release: LoadedRelease): MirrorCopy {
  const pins = release.manifest.payload.slots;
  const texts: Record<string, string> = {};
  const take = (contentHash: string) => {
    const bytes = release.payloads.get(contentHash);
    if (bytes) texts[contentHash] = Buffer.from(bytes).toString("base64url");
  };
  for (const slot of pins) {
    take(slot.contentHash);
    for (const step of slot.steps ?? []) take(step.contentHash);
  }
  return { sealId: sealIdOf(release.manifest.payload.releaseDigest), pins, texts };
}

/** protocol/schemas/heartbeat.schema.json caps `seal.changedTags` at 64 items — a strict schema, so one oversize array refuses the WHOLE heartbeat, not just that field. `changedTags` is already sorted, so the cut is deterministic; the log event (`seal_broken`) is never touched by this — only the wire body is capped. The "absent, never empty" rule is unaffected: a report with no `changedTags` still has none here. */
export function sealForHeartbeat(report: SealReport): SealReport {
  if (!report.changedTags || report.changedTags.length <= 64) return report;
  return { ...report, changedTags: report.changedTags.slice(0, 64) };
}

/**
 * Recompute the seal of `copy` against `release`'s own pins (pins.md). `previous` carries `brokenAt` forward while
 * the same release is still broken — a re-check never moves the instance's own first-observation timestamp — and
 * drops it once the copy heals (no `brokenAt` on an intact report).
 */
export function sealOf(release: LoadedRelease, copy: MirrorCopy, now: string, previous: SealReport | null): SealReport {
  const sealId = sealIdOf(release.manifest.payload.releaseDigest);
  const result = verifySeal({ sealId, sealedPins: release.manifest.payload.slots, pins: copy.pins, texts: copy.texts });
  const carriedBrokenAt = previous && previous.sealId === sealId && !previous.intact ? previous.brokenAt : undefined;
  return {
    sealId,
    observedDigest: result.observedDigest,
    intact: result.intact,
    checkedAt: now,
    ...(!result.intact ? { brokenAt: carriedBrokenAt ?? now } : {}),
    ...(result.changedTags.length > 0 ? { changedTags: result.changedTags } : {}),
  };
}

/**
 * The port, the cached copy and the last report, together — `AirPrompterAgent` only orchestrates WHEN to
 * `refresh` / `materialise` / `resync` (the rule in `mirror()`'s doc comment); this class owns HOW.
 */
export class Mirror {
  private cachedCopy: MirrorCopy | null = null;
  private lastReport: SealReport | null = null;

  constructor(private readonly port: MirrorPort) {}

  /** The cached copy from the last successful `refresh`/`materialise`/`resync`; `null` before any of them ran, or after a `read()` that answered `null`. */
  get copy(): MirrorCopy | null {
    return this.cachedCopy;
  }

  /** The last computed report, or `null` before `computeReport` has run once. */
  get lastComputedReport(): SealReport | null {
    return this.lastReport;
  }

  /** Read the application's store and cache it. Throws whatever `port.read()` throws — the cache stays whatever it was, so the caller (the agent) can log `mirror_unreadable` and fall back without losing a good copy. */
  async refresh(): Promise<void> {
    this.cachedCopy = await this.port.read();
  }

  /** Write this SDK's own copy of `release` and cache it — the ONLY two writers of the customer's store (with `resync`), both called by the agent, never by a timer. */
  async materialise(release: LoadedRelease): Promise<MirrorCopy> {
    const copy = copyFromRelease(release);
    await this.port.write(copy);
    this.cachedCopy = copy;
    return copy;
  }

  /** `ap.mirror(port).resync({ approvedBy })`: re-materialise deliberately (a broken copy, or an application's own re-sync hook answering a `request_resync`) and report the healed state. `approvedBy` is logged by the caller, never here — this class carries no prompt text or identifiers past what it is handed. */
  async resync(release: LoadedRelease, now: string): Promise<SealReport> {
    const copy = await this.materialise(release);
    const report = sealOf(release, copy, now, null);
    this.lastReport = report;
    return report;
  }

  /** Recompute the seal of the cached copy against `release` and remember the report (for `brokenAt` carry-over next time). `null` when nothing is cached yet. */
  computeReport(release: LoadedRelease, now: string): SealReport | null {
    if (!this.cachedCopy) return null;
    const report = sealOf(release, this.cachedCopy, now, this.lastReport);
    this.lastReport = report;
    return report;
  }

  /**
   * The restart rule's one home (F6): whether the cached copy is internally consistent — its texts still hash to
   * its own pins, and its pins' digest still matches the sealId it carries — with no reference to whatever
   * release is active right now. `mirrorMaterialisedFor` (the in-process "this SDK wrote it" memory) does not
   * survive a restart, so after one, a copy this SDK genuinely wrote for release N is indistinguishable from any
   * other copy by that fact alone; but a copy nobody has tampered with since IT was written verifies against
   * ITSELF regardless of which release is active. `false` when nothing is cached yet.
   */
  copyIsSelfConsistent(): boolean {
    if (!this.cachedCopy) return false;
    return verifySeal({ sealId: this.cachedCopy.sealId, sealedPins: this.cachedCopy.pins, pins: this.cachedCopy.pins, texts: this.cachedCopy.texts }).intact;
  }

  /** A pin from the cached copy — the render source when a mirror is registered and readable. `null` before any copy is cached. */
  slotFor(tag: string): ManifestSlot | null {
    return this.cachedCopy?.pins.find((pin) => pin.tag === tag) ?? null;
  }

  /** A text from the cached copy, decoded — `null` when the copy holds no text for that hash (a break the seal already names). */
  textFor(contentHash: string): Buffer | null {
    const encoded = this.cachedCopy?.texts[contentHash];
    return encoded === undefined ? null : Buffer.from(encoded, "base64url");
  }

  /** `request_resync` (pins.md): informational only — hands the directive to the application's own hook, never writes anything itself. */
  notifyResyncRequested(request: { sealId: string; directive: Extract<Directive, { kind: "request_resync" }> }): void {
    void this.port.onResyncRequested?.(request);
  }
}
