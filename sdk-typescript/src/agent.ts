/**
 * `AirPrompterAgent` — the runtime a customer application holds.
 *
 * `start()` reads the store before any network and serves immediately from
 * the last verified release (other slot → vendored bundle → refuse to start
 * when nothing verifies); sync runs in the background per mode. `prompt(tag)`
 * renders with trust-aware variables and hands back a content-free `runRef`;
 * `workflow(tag)` yields steps in order; `report()` and `feedback()` feed the
 * spool. Zero network on the render path, ever.
 */

import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { bundlePayloadBytes, openBundle, type DistributionKey } from "./bundle/apbundle.js";
import { assignArm } from "./protocol/assignment.js";
import { orderedSteps } from "./protocol/assignment.js";
import { instant, keyThumbprint, trustedRootFromPinnedKey, verifyRootMetadata } from "./protocol/trust.js";
import type { Bundle, Manifest, ManifestSlot, P256PublicJwk, RootMetadata, Target } from "./protocol/types.js";
import { mintRunRef, parseRunRef, type RunRefFacts } from "./render/runRef.js";
import { renderTemplate, type Delimiters } from "./render/template.js";
import { normalizeFeedback } from "./spool/feedback.js";
import { DirectorySink, MemorySink, SpoolWriter, type Observation, type RefusalRow, type SpoolSink } from "./spool/writer.js";
import { fileKey, type KeyProvider, type StorageProtection } from "./store/keyProvider.js";
import { SlotStore, StoreError, type LoadedSlot } from "./store/slotStore.js";
import { SyncClient, type FetchLike } from "./sync/client.js";
import { DaemonClient, DaemonError, daemonSocketPath } from "./sync/daemon.js";
import { jitteredDelayMs, syncOnce, type ApplyPolicyDecision } from "./sync/loop.js";

export const SDK_NAME = "agent-sdk-ts";
export const SDK_VERSION = "0.1.0";

export type SyncMode = "resident" | "on_invoke" | "daemon" | "offline";

/** Where the release comes from: this process's own store, a vendored bundle, or the host daemon over its socket. */
export type ReleaseSource = "store" | "vendored_bundle" | "daemon";

export interface StartOptions {
  organizationId: string;
  agentId: string;
  target: Target;
  /** The Agent key (distribution kind). Absent means offline: serve the store or the vendored bundle, never call home. */
  apiKey?: string;
  baseUrl?: string;
  stateDir?: string;
  keyProvider?: KeyProvider;
  /** The pinned root for this environment, or a full root document (from the bundle or a previous accept). */
  root: { pinned: P256PublicJwk } | RootMetadata;
  /** The customer's countersign root, when the target requires countersign. */
  countersignRoot?: RootMetadata;
  requireCountersign?: boolean;
  sync?: { mode?: SyncMode; pollSeconds?: number; edgePointerUrl?: string; rootUrl?: string; daemonSocketPath?: string };
  /** Tier 3: a vendored `.apbundle` (path or object) and, for an encrypted one, the distribution key. */
  vendoredBundle?: { bundle: Bundle | string; distributionKey?: DistributionKey };
  apply?: {
    /** Overrides the manifest's policy locally (the local side can be stricter, never looser). */
    policy?: "auto" | "unlock_required";
    /** Called when a release is staged under unlock_required; `activate()` makes it live. */
    onStaged?: (staged: { generation: number; manifest: Manifest; activate: () => void }) => void | Promise<void>;
  };
  delimiters?: Delimiters;
  telemetry?: { sink?: "directory" | "memory"; instanceClass?: "resident" | "ephemeral" };
  now?: () => number;
  fetch?: FetchLike;
  random?: () => number;
  logger?: (event: Record<string, unknown>) => void;
}

export interface Rendered {
  text: string;
  model: string;
  versionId: string;
  arm: string;
  generation: number;
  runRef: string;
  tag: string;
}

export interface AgentStatus {
  instanceId: string;
  generation: number;
  stagedGeneration: number | null;
  applyState: "active" | "staged" | "awaiting_unlock" | "refused" | "vendored_fallback";
  lastRefusal: string | null;
  storageProtection: StorageProtection | "daemon";
  signingKeyId: string | null;
  /** When the lease runs out: last successful contact + leaseSeconds (a vendored bundle's notAfter when nothing ever synced). */
  leaseExpiresAt: string | null;
  leaseExpired: boolean;
  onLeaseExpiry: "degrade" | "halt" | null;
  lastContactAt: string | null;
  forcedDowngrade: boolean;
  /** Emergency disable from the manifest (§6.5): the whole agent, or named slots. */
  disabled: { agent: boolean; slots: string[] };
  /** Open unlock requests carried by the active manifest, for operator tooling. */
  unlockRequests: Array<{ releaseDigest: string; requestedBy: string; requestedAt: string; expiresAt: string; note?: string }>;
  spool: { depthSegments: number; depthBytes: number };
  source: ReleaseSource;
  /** Attached to the host daemon (`sync.mode: "daemon"`), and whether that attachment is currently live. */
  daemon: { attached: boolean; socketPath: string | null } | null;
  /** The last sync pass this process ran (resident / on_invoke), for hosts and daemons that report it. */
  lastSyncAt: string | null;
  lastSyncOutcome: string | null;
  consecutiveSyncFailures: number;
  nextSyncAt: string | null;
}

export interface ReleaseChange {
  generation: number;
  stagedGeneration: number | null;
}

/** `render()` refused by the control plane's standing instructions: a disable directive, or a lapsed lease on a `halt` target. */
export class RenderRefusedError extends Error {
  constructor(
    readonly reason: "disabled" | "lease_expired",
    readonly tag: string,
    readonly generation: number,
  ) {
    super(`render ${tag}: refused (${reason}) on generation ${generation}`);
    this.name = "RenderRefusedError";
  }
}

export class AgentStartError extends Error {
  constructor(
    readonly code: "no_verified_release" | "kek_unavailable" | "store_corrupt",
    message: string,
  ) {
    super(message);
    this.name = "AgentStartError";
  }
}

export class AirPrompterAgent {
  private active: LoadedSlot | null = null;
  private source: ReleaseSource = "store";
  private daemon: DaemonClient | null = null;
  private daemonSocket: string | null = null;
  private daemonStagedGeneration: number | null = null;
  private daemonRefreshing: Promise<void> | null = null;
  private lastSyncMs: number | null = null;
  private lastSyncOutcome: string | null = null;
  private consecutiveSyncFailures = 0;
  private nextSyncMs: number | null = null;
  private readonly changeListeners = new Set<(change: ReleaseChange) => void>();
  private etag: string | null = null;
  private edgeEtag: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private syncing: Promise<void> | null = null;
  private lastRefusal: string | null = null;
  private stagedManifest: Manifest | null = null;
  private lastContactMs: number | null = null;
  private bundleNotAfter: string | null = null;
  private readonly stampedRefusals = new Set<string>();
  private trustedRoot: RootMetadata;
  private readonly runRefKey: Buffer;
  readonly spool: SpoolWriter;
  private readonly sink: SpoolSink;
  private readonly client: SyncClient | null;

  private constructor(
    private readonly options: StartOptions,
    /** This process's own store; null when attached to the host daemon, which holds the store and its key. */
    private readonly store: SlotStore | null,
    trustedRoot: RootMetadata,
    /** The writer identity: the store's instanceId, or a fresh one per daemon-attached process. */
    private readonly ownInstanceId: string,
    spoolDir: string,
  ) {
    this.trustedRoot = trustedRoot;
    this.runRefKey = createHmac("sha256", Buffer.from(ownInstanceId, "utf8")).update("runRef").digest();
    const serverless = (options.sync?.mode ?? "resident") === "on_invoke";
    this.sink = options.telemetry?.sink === "memory" || (options.telemetry?.sink === undefined && serverless) ? new MemorySink() : new DirectorySink(spoolDir, ownInstanceId);
    this.spool = new SpoolWriter(this.sink, { instanceId: ownInstanceId, instanceClass: options.telemetry?.instanceClass ?? (serverless ? "ephemeral" : "resident"), sdk: `${SDK_NAME}/${SDK_VERSION}` });
    this.client =
      options.apiKey && options.sync?.mode !== "offline" && options.sync?.mode !== "daemon"
        ? new SyncClient({ baseUrl: options.baseUrl ?? "https://api.airprompter.com", agentId: options.agentId, target: options.target, apiKey: options.apiKey, ...(options.fetch ? { fetch: options.fetch } : {}), userAgent: `${SDK_NAME}/${SDK_VERSION}` })
        : null;
  }

  static async start(options: StartOptions): Promise<AirPrompterAgent> {
    const stateDir = options.stateDir ?? defaultStateDir();
    const pinnedRoot = "pinned" in options.root ? trustedRootFromPinnedKey({ purpose: "platform", environment: options.target, pinnedRoot: options.root.pinned }) : options.root;
    if (options.sync?.mode === "daemon") {
      // The host daemon holds the store and its key; this process attaches and never touches store files.
      const socketPath = options.sync.daemonSocketPath ?? daemonSocketPath({ stateDir, agentId: options.agentId, target: options.target });
      const client = await DaemonClient.connect({ socketPath, agentId: options.agentId, target: options.target, sdk: `${SDK_NAME}/${SDK_VERSION}` });
      if (client) {
        const storeDir = SlotStore.path({ stateDir, agentId: options.agentId, target: options.target });
        const agent = new AirPrompterAgent(options, null, pinnedRoot, AirPrompterAgent.newInstanceId(), join(storeDir, "spool", "telemetry"));
        agent.daemonSocket = socketPath;
        await agent.attachDaemon(client);
        return agent;
      }
      options.logger?.({ sdk: SDK_NAME, agentId: options.agentId, target: options.target, event: "daemon_absent", socketPath });
      // No daemon on this host: in-process sync from this process's own store, exactly as resident mode.
      options = { ...options, sync: { ...options.sync, mode: "resident" } };
    }
    const keyProvider = options.keyProvider ?? fileKey(join(SlotStore.path({ stateDir, agentId: options.agentId, target: options.target }), "store.key"));
    let store: SlotStore;
    try {
      store = await SlotStore.open({ stateDir, agentId: options.agentId, target: options.target, keyProvider });
    } catch (error) {
      if (error instanceof StoreError && (error.code === "kek_unavailable" || error.code === "store_corrupt")) throw new AgentStartError(error.code, error.message);
      throw error;
    }
    const pinned = pinnedRoot;
    // The stored root (accepted on an earlier run) is trusted only if it still verifies against the pinned key.
    const stored = store.state.root;
    const trusted = stored && verifyRootMetadata({ candidate: stored, trusted: pinned, now: new Date(options.now?.() ?? Date.now()).toISOString() }).ok ? stored : pinned;
    const agent = new AirPrompterAgent(options, store, trusted, store.instanceId, join(store.dir, "spool", "telemetry"));
    await agent.boot();
    return agent;
  }

  /** Daemon mode: the active release comes over the socket; `generation` events refresh it; a lost daemon keeps what is held and reconnects. */
  private async attachDaemon(client: DaemonClient): Promise<void> {
    this.daemon = client;
    this.daemonStagedGeneration = client.hello.stagedGeneration;
    this.active = await client.slot();
    this.source = "daemon";
    this.lastContactMs = this.nowMs();
    this.log({ event: "daemon_attached", generation: this.active.generation, daemon: client.hello.daemon });
    client.onEvent((event) => {
      if (event.event === "generation") {
        this.daemonStagedGeneration = typeof event.stagedGeneration === "number" ? event.stagedGeneration : null;
        void this.refreshFromDaemon();
      }
      if (event.event === "shutdown") this.log({ event: "daemon_shutdown" });
    });
    client.onClose(() => {
      if (this.daemon !== client) return;
      this.daemon = null;
      this.log({ event: "daemon_lost", socketPath: this.daemonSocket });
      this.scheduleDaemonReconnect();
    });
  }

  private async refreshFromDaemon(): Promise<void> {
    if (!this.daemon) return;
    if (this.daemonRefreshing) return this.daemonRefreshing;
    this.daemonRefreshing = (async () => {
      try {
        const slot = await this.daemon!.slot();
        const changed = slot.generation !== this.active?.generation;
        this.active = slot;
        this.source = "daemon";
        this.lastContactMs = this.nowMs();
        this.lastRefusal = null;
        if (changed) this.emitChange();
      } catch (error) {
        this.log({ event: "daemon_slot_unavailable", reason: (error as Error).message });
      }
    })().finally(() => {
      this.daemonRefreshing = null;
    });
    return this.daemonRefreshing;
  }

  private scheduleDaemonReconnect(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void (async () => {
        try {
          const client = await DaemonClient.connect({ socketPath: this.daemonSocket!, agentId: this.options.agentId, target: this.options.target, sdk: `${SDK_NAME}/${SDK_VERSION}` });
          if (client) {
            await this.attachDaemon(client);
            return;
          }
        } catch (error) {
          this.log({ event: "daemon_reconnect_failed", reason: (error as Error).message });
        }
        this.scheduleDaemonReconnect();
      })();
    }, jitteredDelayMs(this.options.sync?.pollSeconds ?? 30, this.options.random));
    this.timer.unref?.();
  }

  /** Store first (active slot, then the other), then the vendored bundle, then refuse. Zero network. */
  private async boot(): Promise<void> {
    if (!this.store) throw new AgentStartError("no_verified_release", "boot without a store");
    const now = this.nowIso();
    const verifyOptions = { now, root: this.trustedRoot, countersignRoot: this.options.countersignRoot ?? null, ...(this.options.requireCountersign !== undefined ? { requireCountersign: this.options.requireCountersign } : {}) };
    const store = this.store;
    const state = store.state;
    // The other slot is a fallback only when it holds a previously activated release: a release staged under
    // unlock_required and never unlocked is not approved for this host and is never served by accident.
    for (const slot of [state.active, state.active ? (state.active === "A" ? "B" : "A") : null] as const) {
      if (!slot || (slot !== state.active && slot === state.staged)) continue;
      try {
        const loaded = store.load(slot, slot === state.active ? { ...verifyOptions, expectGeneration: state.generation } : verifyOptions);
        if (slot !== state.active) this.log({ event: "fallback_to_other_slot", slot });
        this.active = loaded;
        this.source = "store";
        break;
      } catch (error) {
        this.log({ event: "slot_unusable", slot, reason: (error as Error).message });
      }
    }
    // A staged slot left by an unanswered unlock (or a crash after staging) is still staged: report it, keep it verifiable.
    if (state.staged && state.staged !== state.active) {
      try {
        this.stagedManifest = store.load(state.staged, verifyOptions).manifest;
      } catch (error) {
        this.log({ event: "staged_slot_unusable", slot: state.staged, reason: (error as Error).message });
        store.discardStaged();
      }
    }
    if (!this.active && this.options.vendoredBundle) {
      try {
        const bundle = typeof this.options.vendoredBundle.bundle === "string" ? (JSON.parse(readFileSync(this.options.vendoredBundle.bundle, "utf8")) as Bundle) : this.options.vendoredBundle.bundle;
        const contents = openBundle(bundle, { agentId: this.options.agentId, target: this.options.target }, this.options.vendoredBundle.distributionKey);
        this.bundleNotAfter = contents.notAfter;
        if (instant(contents.notAfter) <= instant(now)) this.log({ event: "vendored_bundle_past_not_after", notAfter: contents.notAfter });
        const rootVerdict = verifyRootMetadata({ candidate: contents.keySet, trusted: this.trustedRoot, now });
        if (rootVerdict.ok) {
          this.trustedRoot = contents.keySet;
          store.acceptRoot(contents.keySet);
        }
        // Stage through the store so the bundle's release becomes the encrypted A slot: the same verification path as OTA.
        store.stage({ manifest: contents.manifest, payloads: bundlePayloadBytes(contents) });
        const slot = store.activate();
        this.active = store.load(slot, { ...verifyOptions, root: this.trustedRoot });
        this.source = "vendored_bundle";
        this.log({ event: "vendored_bundle_applied", generation: this.active.generation });
      } catch (error) {
        this.log({ event: "vendored_bundle_unusable", reason: (error as Error).message });
      }
    }
    if (!this.active && this.client) {
      // Nothing verified locally: one synchronous sync before serving is the only time the SDK waits on the network.
      await this.syncNow();
    }
    if (!this.active) throw new AgentStartError("no_verified_release", "no verified release in the store, no usable vendored bundle, and nothing could be fetched");
    if (this.client && (this.options.sync?.mode ?? "resident") === "resident") this.schedule();
  }

  /** Called whenever the active or staged generation changes (sync, unlock, rollback, daemon event). */
  onChange(listener: (change: ReleaseChange) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private emitChange(): void {
    const change: ReleaseChange = { generation: this.generation, stagedGeneration: this.status().stagedGeneration };
    for (const listener of this.changeListeners) listener(change);
  }

  /** The active, verified release this process serves (manifest + payload bytes), or null. */
  get release(): LoadedSlot | null {
    return this.active;
  }

  private log(event: Record<string, unknown>): void {
    this.options.logger?.({ sdk: SDK_NAME, agentId: this.options.agentId, target: this.options.target, ...event });
  }

  private nowMs(): number {
    return this.options.now?.() ?? Date.now();
  }
  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    const delay = jitteredDelayMs(this.options.sync?.pollSeconds ?? 30, this.options.random);
    this.nextSyncMs = this.nowMs() + delay;
    this.timer = setTimeout(() => {
      void this.syncNow().finally(() => this.schedule());
    }, delay);
    this.timer.unref?.();
  }

  private async applyPolicy(manifest: Manifest): Promise<ApplyPolicyDecision> {
    const policy = this.options.apply?.policy ?? manifest.payload.applyPolicy;
    if (policy === "auto") return "activated";
    this.stagedManifest = manifest;
    await this.options.apply?.onStaged?.({ generation: manifest.payload.generation, manifest, activate: () => this.unlock() });
    return this.stagedManifest ? "staged" : "activated";
  }

  /** One sync pass now (resident timers call this; on_invoke hosts call it from `invoke`). Never throws. */
  async syncNow(): Promise<void> {
    if (this.daemon) {
      try {
        await this.daemon.request("sync");
        await this.refreshFromDaemon();
      } catch (error) {
        this.log({ event: "daemon_sync_failed", reason: (error as Error).message });
      }
      return;
    }
    if (!this.client || !this.store) return;
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const result = await syncOnce({
        store: this.store!,
        client: this.client!,
        now: () => this.nowIso(),
        scope: { organizationId: this.options.organizationId, agentId: this.options.agentId, target: this.options.target },
        trustedRoot: this.trustedRoot,
        ...(this.options.sync?.rootUrl ? { fetchRoot: () => this.fetchRoot(this.options.sync!.rootUrl!) } : {}),
        active: this.active,
        etag: this.etag,
        edgePointerUrl: this.options.sync?.edgePointerUrl ?? null,
        edgeEtag: this.edgeEtag,
        ...(this.options.requireCountersign !== undefined ? { requireCountersign: this.options.requireCountersign } : {}),
        countersignRoot: this.options.countersignRoot ?? null,
        applyPolicy: (manifest) => this.applyPolicy(manifest),
        onRefusal: (reason, generation) => {
          this.lastRefusal = reason;
          this.log({ event: "sync_refused", reason, generation });
        },
      });
      this.etag = result.etag;
      this.edgeEtag = result.edgeEtag;
      this.trustedRoot = result.trustedRoot;
      this.lastSyncMs = this.nowMs();
      this.lastSyncOutcome = result.outcome;
      const contact = result.outcome === "unchanged" || result.outcome === "activated" || result.outcome === "staged" || result.outcome === "nothing_promoted" || result.outcome === "held_back";
      if (contact) this.lastContactMs = this.nowMs();
      this.consecutiveSyncFailures = contact ? 0 : this.consecutiveSyncFailures + 1;
      if (result.outcome === "activated" && result.active) {
        this.active = result.active;
        this.source = "store";
        this.stagedManifest = null;
        this.lastRefusal = null;
        this.emitChange();
      }
      if (result.outcome === "staged") {
        this.log({ event: "release_staged", generation: result.generation });
        this.emitChange();
      }
    })().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async fetchRoot(url: string): Promise<RootMetadata | null> {
    try {
      const response = await (this.options.fetch ?? (globalThis.fetch as unknown as FetchLike))(url, { headers: { "user-agent": `${SDK_NAME}/${SDK_VERSION}` } });
      if (response.status !== 200) return null;
      return JSON.parse(await response.text()) as RootMetadata;
    } catch {
      return null;
    }
  }

  /** on_invoke mode: run the handler between two sync passes (the trailing one is not awaited on the response path). */
  async invoke<T>(handler: () => Promise<T>): Promise<T> {
    await this.syncNow();
    try {
      return await handler();
    } finally {
      this.spool.closeWindows(this.nowMs());
      void this.syncNow();
    }
  }

  /** Make a staged release live (an operator's `airprompter unlock`, an update window, or the change-control hook). Host-wide when attached to a daemon. */
  async unlock(): Promise<{ generation: number } | null> {
    if (this.daemon) {
      const result = (await this.daemon.request("unlock")) as { generation: number | null };
      await this.refreshFromDaemon();
      return result.generation === null ? null : { generation: result.generation };
    }
    const store = this.store!;
    if (!store.state.staged) return null;
    const slot = store.activate();
    this.active = store.load(slot, { now: this.nowIso(), root: this.trustedRoot, countersignRoot: this.options.countersignRoot ?? null });
    this.stagedManifest = null;
    this.source = "store";
    this.emitChange();
    return { generation: this.active.generation };
  }

  /** Instant local rollback to the other slot. Forced when it goes below the stored generation; stamped on evidence. Host-wide when attached to a daemon. */
  async rollback(): Promise<{ generation: number; forced: boolean }> {
    if (this.daemon) {
      const result = (await this.daemon.request("rollback")) as { generation: number; forced: boolean };
      await this.refreshFromDaemon();
      return { generation: result.generation, forced: result.forced };
    }
    const store = this.store!;
    const before = store.state.generation;
    const slot = store.rollbackLocal();
    this.active = store.load(slot, { now: this.nowIso(), root: this.trustedRoot, countersignRoot: this.options.countersignRoot ?? null });
    const forced = this.active.generation < before;
    if (forced) this.spool.refusal({ at: this.nowIso(), reason: "forced_downgrade", generation: this.active.generation, tag: null }, this.nowMs());
    this.emitChange();
    return { generation: this.active.generation, forced };
  }

  private stampRefusal(reason: RefusalRow["reason"], generation: number, tag: string | null): void {
    // One row per (reason, generation, tag): the spool reports the condition, not every render that hit it.
    const key = `${reason}\u0000${generation}\u0000${tag ?? ""}`;
    if (this.stampedRefusals.has(key)) return;
    this.stampedRefusals.add(key);
    this.spool.refusal({ at: this.nowIso(), reason, generation, tag }, this.nowMs());
  }

  private disabledBy(payload: Manifest["payload"]): { agent: boolean; slots: string[] } {
    const slots: string[] = [];
    let agent = false;
    for (const directive of payload.directives) {
      if (directive.kind !== "disable") continue;
      if (directive.scope === "agent") agent = true;
      else if (directive.tag) slots.push(directive.tag);
    }
    return { agent, slots };
  }

  private leaseExpiresAt(): string | null {
    const manifest = this.active?.manifest.payload;
    if (!manifest) return null;
    if (this.lastContactMs !== null) return new Date(this.lastContactMs + manifest.leaseSeconds * 1000).toISOString();
    if (this.bundleNotAfter && this.source === "vendored_bundle") return new Date(instant(this.bundleNotAfter)).toISOString();
    return new Date(instant(manifest.issuedAt) + manifest.leaseSeconds * 1000).toISOString();
  }

  private guard(tag: string): void {
    const active = this.active;
    if (!active) throw new AgentStartError("no_verified_release", "no active release");
    const payload = active.manifest.payload;
    const disabled = this.disabledBy(payload);
    if (disabled.agent || disabled.slots.includes(tag)) {
      this.stampRefusal("disabled", active.generation, disabled.agent ? null : tag);
      throw new RenderRefusedError("disabled", tag, active.generation);
    }
    const expiresAt = this.leaseExpiresAt();
    if (expiresAt && instant(expiresAt) <= this.nowMs()) {
      // §6.4: degrade keeps serving and reports it; halt stops rendering. Either way the spool carries one row.
      this.stampRefusal("lease_expired", active.generation, null);
      if (payload.onLeaseExpiry === "halt") throw new RenderRefusedError("lease_expired", tag, active.generation);
    }
  }

  private resolveSlot(tag: string, subject: string | undefined): { slot: ManifestSlot; arm: string; bucket: number | null } {
    this.guard(tag);
    const active = this.active!;
    const payload = active.manifest.payload;
    let slot = payload.slots.find((entry) => entry.tag === tag);
    if (!slot) throw new Error(`no slot ${tag} on generation ${active.generation}`);
    if (!payload.experiment) return { slot, arm: "none", bucket: null };
    const subjectValue = payload.experiment.subjectKey === "instance" || subject === undefined ? this.ownInstanceId : subject;
    const assigned = assignArm({ salt: payload.experiment.salt, subject: subjectValue, arms: payload.experiment.arms });
    const override = assigned.arm.overrides.find((entry) => entry.tag === tag);
    if (override) slot = override;
    return { slot, arm: assigned.arm.arm, bucket: assigned.bucket };
  }

  private textOf(slot: ManifestSlot): string {
    const bytes = this.active?.payloads.get(slot.contentHash);
    if (!bytes) throw new Error(`payload ${slot.contentHash} not loaded`);
    return bytes.toString("utf8");
  }

  prompt(tag: string, options: { subject?: string } = {}) {
    const render = (values: Record<string, string | number | boolean | null | undefined> = {}): Rendered => {
      const { slot, arm, bucket } = this.resolveSlot(tag, options.subject);
      const text = renderTemplate({ tag, text: this.textOf(slot), variables: slot.variables, values, ...(this.options.delimiters ? { delimiters: this.options.delimiters } : {}) });
      const generation = this.active!.generation;
      const facts: RunRefFacts = { agentId: this.options.agentId, target: this.options.target, tag, versionId: slot.versionId, arm, generation, bucket };
      return { text, model: slot.model, versionId: slot.versionId, arm, generation, runRef: mintRunRef(facts, this.runRefKey), tag };
    };
    return { render, variables: () => this.resolveSlot(tag, options.subject).slot.variables };
  }

  /** A workflow slot's steps in ordinal order, each with its prompt text. */
  workflow(tag: string, options: { subject?: string } = {}) {
    const { slot, arm, bucket } = this.resolveSlot(tag, options.subject);
    if (slot.kind !== "workflow" || !slot.steps) throw new Error(`${tag} is not a workflow slot`);
    const steps = orderedSteps(tag, slot.steps).map((step) => ({
      stepId: step.stepId,
      ordinal: step.ordinal,
      versionId: step.promptVersionId,
      text: this.active!.payloads.get(step.contentHash)?.toString("utf8") ?? "",
      runRef: mintRunRef({ agentId: this.options.agentId, target: this.options.target, tag: step.stepId, versionId: step.promptVersionId, arm, generation: this.active!.generation, bucket }, this.runRefKey),
    }));
    return { model: slot.model, arm, steps, variables: slot.variables };
  }

  /** Content-free measurements for one model call. */
  report(observation: Observation): void {
    this.spool.observe(observation, this.nowMs());
  }

  /** Quality signals against a run: numbers, booleans and declared enums only; anything else is refused. */
  feedback(runRef: string, signals: Record<string, unknown>): boolean {
    const facts = parseRunRef(runRef, this.runRefKey);
    if (!facts) return false;
    const normalized = normalizeFeedback(signals);
    if (Object.keys(normalized.rejected).length) this.log({ event: "feedback_rejected", rejected: normalized.rejected });
    if (!normalized.accepted) return false;
    // Feedback rides on the run's window: same dimension set, no extra count (the run was already counted).
    const payload = this.active?.manifest.payload;
    const override = payload?.experiment?.arms.find((arm) => arm.arm === facts.arm)?.overrides.find((entry) => entry.tag === facts.tag);
    const slot = override ?? payload?.slots.find((entry) => entry.tag === facts.tag);
    this.spool.outcomes({ tag: facts.tag, versionId: facts.versionId, arm: facts.arm, model: slot?.model ?? "unknown" }, normalized.outcomes, this.nowMs());
    return true;
  }

  status(): AgentStatus {
    const state = this.store?.state ?? null;
    const manifest = this.active?.manifest.payload;
    const leaseExpiresAt = this.leaseExpiresAt();
    const depth = this.sink instanceof DirectorySink ? this.sink.depth() : { segments: 0, bytes: 0 };
    return {
      instanceId: this.ownInstanceId,
      generation: this.active?.generation ?? 0,
      stagedGeneration: this.daemonSocket ? this.daemonStagedGeneration : (this.stagedManifest?.payload.generation ?? null),
      applyState: this.stagedManifest || (this.daemonSocket && this.daemonStagedGeneration !== null) ? "awaiting_unlock" : this.lastRefusal ? "refused" : this.source === "vendored_bundle" ? "vendored_fallback" : "active",
      lastRefusal: this.lastRefusal,
      storageProtection: state ? this.store!.storageProtection : "daemon",
      signingKeyId: this.active?.signingKeyId ?? null,
      leaseExpiresAt,
      leaseExpired: leaseExpiresAt ? instant(leaseExpiresAt) <= this.nowMs() : false,
      onLeaseExpiry: manifest?.onLeaseExpiry ?? null,
      lastContactAt: this.lastContactMs === null ? null : new Date(this.lastContactMs).toISOString(),
      forcedDowngrade: state?.forcedDowngrade === true,
      disabled: manifest ? this.disabledBy(manifest) : { agent: false, slots: [] },
      unlockRequests: (manifest?.directives ?? []).flatMap((d) => (d.kind === "request_unlock" ? [{ releaseDigest: d.releaseDigest, requestedBy: d.requestedBy, requestedAt: d.requestedAt, expiresAt: d.expiresAt, ...(d.note !== undefined ? { note: d.note } : {}) }] : [])),
      spool: { depthSegments: depth.segments, depthBytes: depth.bytes },
      source: this.source,
      daemon: this.daemonSocket ? { attached: this.daemon !== null, socketPath: this.daemonSocket } : null,
      lastSyncAt: this.lastSyncMs === null ? null : new Date(this.lastSyncMs).toISOString(),
      lastSyncOutcome: this.lastSyncOutcome,
      consecutiveSyncFailures: this.consecutiveSyncFailures,
      nextSyncAt: this.nextSyncMs === null || !this.timer ? null : new Date(this.nextSyncMs).toISOString(),
    };
  }

  get generation(): number {
    return this.active?.generation ?? 0;
  }

  get manifest(): Manifest | null {
    return this.active?.manifest ?? null;
  }

  get trustedRootKeyIds(): string[] {
    return Object.keys(this.trustedRoot.signed.keys);
  }

  private stopped = false;

  /** Stop timers, detach from the daemon, and close the spool. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.syncing) await this.syncing;
    if (this.daemonRefreshing) await this.daemonRefreshing;
    const daemon = this.daemon;
    this.daemon = null;
    daemon?.close();
    this.spool.closeWindows(this.nowMs());
  }

  /** The runtime's own random id (the store's, or a fresh one per daemon-attached process; never a hostname). */
  get instanceId(): string {
    return this.ownInstanceId;
  }

  static thumbprint(jwk: P256PublicJwk): string {
    return keyThumbprint(jwk);
  }

  /** Test seam: the memory sink's rows on serverless hosts. */
  drainMemorySink(): unknown[] {
    return this.sink instanceof MemorySink ? this.sink.drain() : [];
  }

  static newInstanceId(): string {
    return `i-${randomBytes(12).toString("base64url")}`;
  }

  refusalRow(row: Omit<RefusalRow, "type" | "v" | "instanceId">): void {
    this.spool.refusal(row, this.nowMs());
  }
}

function defaultStateDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  if (process.env.XDG_STATE_HOME) return process.env.XDG_STATE_HOME;
  if (process.platform === "darwin") return join(home, "Library", "Application Support");
  if (process.platform === "win32") return process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  return existsSync(join(home, ".local", "state")) ? join(home, ".local", "state") : join(home, ".local", "state");
}
