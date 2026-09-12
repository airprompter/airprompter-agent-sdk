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
import type { Bundle, Directive, Manifest, ManifestSlot, P256PublicJwk, RootMetadata, Target } from "./protocol/types.js";
import { mintRunRef, parseRunRef, type RunRefFacts } from "./render/runRef.js";
import { renderTemplate, type Delimiters } from "./render/template.js";
import { normalizeFeedback } from "./spool/feedback.js";
import { DirectorySink, MemorySink, SpoolWriter, epochMinute, segmentName, type Observation, type RefusalRow, type SpoolRow, type SpoolSink } from "./spool/writer.js";
import { fileKey, type KeyProvider, type StorageProtection } from "./store/keyProvider.js";
import { SlotStore, StoreError, type LoadedSlot } from "./store/slotStore.js";
import { observeCall, type ObserveOptions } from "./telemetry/observe.js";
import { evaluateChecks, outputTextOf, type CheckOutcome } from "./checks/index.js";
import { postSegment, type GrantDecision, type UploadGrant } from "./telemetry/uploader.js";
import { parseWindow, windowState, type UpdateWindow } from "./apply/window.js";
import { SyncClient, type FetchLike } from "./sync/client.js";
import { DaemonClient, DaemonError, daemonSocketPath } from "./sync/daemon.js";
import { jitteredDelayMs, syncOnce, type ApplyPolicyDecision } from "./sync/loop.js";

export const SDK_NAME = "agent-sdk-ts";
export const SDK_VERSION = "0.1.0";
/** The protocol this SDK speaks; the heartbeat names it (the manifest carries its own). */
export const PROTOCOL_VERSION = "0.2.5";

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
    /**
     * T9: the update window — `"02:00-04:00 Europe/Berlin"` (optionally `"… mon,tue"`) or an object. A release
     * staged under unlock_required activates on its own inside it. A local window wins over the manifest's.
     */
    window?: string | UpdateWindow;
    /**
     * Called when a release is staged under unlock_required; `activate()` makes it live. The hook is the change-control
     * integration point: resolve after `activate()` to go live, resolve or reject without it to leave the release staged
     * (reported as `staged`, never activated by accident). `unlockRequest` is the console's open request, when there is one.
     */
    onStaged?: (staged: { generation: number; manifest: Manifest; activate: () => void; unlockRequest: Extract<Directive, { kind: "request_unlock" }> | null }) => void | Promise<void>;
  };
  /** T9: how often this instance reports to AirPrompter (30–3600 s; the server may clamp and echo a cadence). Default 300. */
  heartbeatSeconds?: number;
  /** The models this application can actually call, as the provider names them (reported on heartbeat; promotion refuses a slot whose model is absent). */
  models?: Record<string, unknown> | string[];
  delimiters?: Delimiters;
  telemetry?: {
    sink?: "directory" | "memory";
    instanceClass?: "resident" | "ephemeral";
    /** Serverless: the in-memory buffer (default 256 KiB); the oldest rows go past it and a `dropped` row says so. */
    bufferBytes?: number;
    /** Hosts: the closed-segment budget (default 100 MiB); the oldest unsent segments go past it and a `dropped` row says so. */
    spoolBudgetBytes?: number;
  };
  now?: () => number;
  fetch?: FetchLike;
  random?: () => number;
  logger?: (event: Record<string, unknown>) => void;
  /** T26: who reports on the heartbeat — the SDK by default; the daemon names itself `airprompterd`. */
  sdk?: { name: "agent-sdk-typescript" | "airprompterd" | "airprompter-cli"; version: string };
}

export type HeartbeatSdkName = NonNullable<StartOptions["sdk"]>["name"];

/** T26: what the uploader knows about the spool, folded into the heartbeat's `spool` block. */
export interface SpoolReport {
  droppedSegments: number;
  quarantinedSegments: number;
  lastUploadAt: string | null;
  backoffUntil: string | null;
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
  /** Open (unexpired) unlock requests carried by the latest verified manifest, for operator tooling. */
  unlockRequests: Array<{ releaseDigest: string; requestedBy: string; requestedAt: string; expiresAt: string; note?: string }>;
  /** T9: the update window in force (local, else the manifest's) and whether it is open now. */
  window: { source: "local" | "manifest"; open: boolean; opensAt: string; closesAt: string } | null;
  /** T9: the last heartbeat the server accepted, and when the next one goes out. */
  heartbeat: { lastAt: string | null; nextAt: string | null; intervalSeconds: number; lastRefusal: string | null };
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
  /** T15: the required models the last `model_unavailable` refusal named; empty once a release activates. */
  private unavailableModels: string[] = [];
  private stagedManifest: Manifest | null = null;
  private lastContactMs: number | null = null;
  private bundleNotAfter: string | null = null;
  /**
   * T9: directives from the latest manifest whose envelope verified — honoured even when that manifest was left staged,
   * held back, or ignored as the generation already held. A Freeze reaches a fleet that never unlocks.
   */
  private standingDirectives: { generation: number; directives: Directive[] } | null = null;
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatIntervalSeconds: number;
  private lastHeartbeatMs: number | null = null;
  private nextHeartbeatMs: number | null = null;
  private lastHeartbeatRefusal: string | null = null;
  private heartbeating: Promise<void> | null = null;
  private haltWithoutContactWarned = false;
  private readonly localWindow: UpdateWindow | null;
  private readonly stampedRefusals = new Set<string>();
  /** T26: the runtime's own upload grant (serverless flushes under it) and the cadence the last heartbeat asked for. */
  private uploadGrant: UploadGrant | null = null;
  private uploadIntervalSeconds = 300;
  private uploadRetryAfterMs: number | null = null;
  private spoolReporter: (() => SpoolReport) | null = null;
  private flushSegmentN = 0;
  private lastFlushMinute: number | null = null;
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
    this.localWindow = options.apply?.window ? parseWindow(options.apply.window) : null;
    this.heartbeatIntervalSeconds = Math.min(3600, Math.max(30, Math.round(options.heartbeatSeconds ?? 300)));
    const serverless = (options.sync?.mode ?? "resident") === "on_invoke";
    this.sink = options.telemetry?.sink === "memory" || (options.telemetry?.sink === undefined && serverless) ? new MemorySink({ instanceId: ownInstanceId }, options.telemetry?.bufferBytes) : new DirectorySink(spoolDir, ownInstanceId, options.telemetry?.spoolBudgetBytes);
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
    if (this.client && (this.options.sync?.mode ?? "resident") === "resident") {
      this.schedule();
      // The first heartbeat goes out right after boot so the fleet view sees the instance before its first interval.
      void this.heartbeatNow().finally(() => this.scheduleHeartbeat());
    }
    this.scheduleWindowUnlock();
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

  /**
   * The apply policy engine (T9, D33). `auto` activates. `unlock_required` stages, then:
   * inside an open update window → activates now; the customer's `onStaged` hook may call
   * `activate()` (a hook that throws, rejects or never activates leaves the release staged and
   * says so in the log); otherwise the window timer, an operator's `unlock`, or the hook later.
   * The local policy can only tighten the manifest's (`auto` never overrides `unlock_required`).
   */
  private async applyPolicy(manifest: Manifest): Promise<ApplyPolicyDecision> {
    const local = this.options.apply?.policy;
    const policy = local === "unlock_required" || manifest.payload.applyPolicy === "unlock_required" ? "unlock_required" : "auto";
    if (policy === "auto") return "activated";
    this.stagedManifest = manifest;
    const window = this.windowInForce(manifest);
    if (window && windowState(window.window, this.nowMs()).open) {
      this.log({ event: "window_open_on_stage", generation: manifest.payload.generation, source: window.source });
      this.stagedManifest = null;
      return "activated";
    }
    const request = this.openUnlockRequests(manifest.payload).find((d) => d.releaseDigest === manifest.payload.releaseDigest) ?? null;
    let activation: Promise<{ generation: number } | null> | null = null;
    try {
      await this.options.apply?.onStaged?.({
        generation: manifest.payload.generation,
        manifest,
        // `activate()` may be called without awaiting; the decision waits for it either way.
        activate: () => void (activation = activation ?? this.unlock()),
        unlockRequest: request,
      });
    } catch (error) {
      // The hook refused (change control said no, or it broke): the release stays staged and the fleet view says so.
      this.log({ event: "on_staged_hook_rejected", generation: manifest.payload.generation, reason: (error as Error).message });
    }
    if (activation) {
      const result = await (activation as Promise<{ generation: number } | null>);
      if (result) return "activated_externally";
    }
    if (this.stagedManifest === null) return "activated_externally";
    this.scheduleWindowUnlock();
    return "staged";
  }

  /** The window that governs this runtime: the local one, else the manifest's; null when neither is set. */
  private windowInForce(manifest: Manifest | null): { source: "local" | "manifest"; window: UpdateWindow } | null {
    if (this.localWindow) return { source: "local", window: this.localWindow };
    const carried = manifest?.payload.unlockWindow;
    if (!carried) return null;
    try {
      return { source: "manifest", window: parseWindow(carried) };
    } catch (error) {
      this.log({ event: "manifest_window_unusable", reason: (error as Error).message });
      return null;
    }
  }

  /** While a release is staged and a window applies, wake at the next opening and activate. */
  private scheduleWindowUnlock(): void {
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = null;
    if (this.stopped || !this.stagedManifest) return;
    const governing = this.windowInForce(this.stagedManifest);
    if (!governing) return;
    const state = windowState(governing.window, this.nowMs());
    const delay = Math.max(1000, Math.min(2_147_000_000, (state.open ? 0 : state.opensAtMs - this.nowMs()) + 500));
    this.windowTimer = setTimeout(() => {
      this.windowTimer = null;
      void (async () => {
        if (!this.stagedManifest) return;
        if (windowState(governing.window, this.nowMs()).open) {
          this.log({ event: "window_unlock", generation: this.stagedManifest.payload.generation, source: governing.source });
          await this.unlock();
        }
        this.scheduleWindowUnlock();
      })();
    }, delay);
    this.windowTimer.unref?.();
  }

  /** Unexpired `request_unlock` directives from the latest verified manifest (or the active one before any sync). */
  private openUnlockRequests(payload: Manifest["payload"] | null): Array<Extract<Directive, { kind: "request_unlock" }>> {
    const directives = this.standingDirectives && (!payload || this.standingDirectives.generation >= payload.generation) ? this.standingDirectives.directives : (payload?.directives ?? []);
    const now = this.nowMs();
    return directives.flatMap((d) => (d.kind === "request_unlock" && instant(d.expiresAt) > now ? [d] : []));
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
        catalog: this.declaredModels(),
        onModelUnavailable: (models, generation) => {
          this.unavailableModels = [...models];
          this.spool.refusal({ at: this.nowIso(), reason: "model_unavailable", generation, tag: null }, this.nowMs());
        },
        onRefusal: (reason, generation) => {
          this.lastRefusal = reason;
          this.log({ event: "sync_refused", reason, generation });
        },
        onDirectives: (payload) => this.takeDirectives(payload),
      });
      this.etag = result.etag;
      this.edgeEtag = result.edgeEtag;
      this.trustedRoot = result.trustedRoot;
      this.lastSyncMs = this.nowMs();
      this.lastSyncOutcome = result.outcome;
      const contact = result.outcome === "unchanged" || result.outcome === "activated" || result.outcome === "activated_externally" || result.outcome === "staged" || result.outcome === "nothing_promoted" || result.outcome === "held_back";
      if (contact) this.lastContactMs = this.nowMs();
      this.consecutiveSyncFailures = contact ? 0 : this.consecutiveSyncFailures + 1;
      if (result.outcome === "activated" && result.active) {
        this.active = result.active;
        this.source = "store";
        this.stagedManifest = null;
        this.lastRefusal = null;
        this.unavailableModels = [];
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

  /** T9: a verified manifest's directives stand from the moment its envelope verifies; a Freeze is honoured before anything else. */
  private takeDirectives(payload: Manifest["payload"]): void {
    if (this.standingDirectives && this.standingDirectives.generation > payload.generation) return;
    const before = this.disabledNow();
    this.standingDirectives = { generation: payload.generation, directives: [...payload.directives] };
    const after = this.disabledNow();
    if (before.agent !== after.agent || before.slots.join(",") !== after.slots.join(",")) this.log({ event: after.agent || after.slots.length ? "disabled_by_directive" : "disable_lifted", generation: payload.generation, ...after });
    const requests = this.openUnlockRequests(payload);
    if (requests.length) this.log({ event: "unlock_requested", generation: payload.generation, requests: requests.map((r) => ({ releaseDigest: r.releaseDigest, expiresAt: r.expiresAt, requestedBy: r.requestedBy })) });
  }

  /** What is disabled right now: the standing directives when they are as new as the active manifest, else the active manifest's own. */
  private disabledNow(): { agent: boolean; slots: string[] } {
    const active = this.active?.manifest.payload ?? null;
    if (this.standingDirectives && (!active || this.standingDirectives.generation >= active.generation)) return this.disabledFrom(this.standingDirectives.directives);
    return active ? this.disabledFrom(active.directives) : { agent: false, slots: [] };
  }

  // ---------------------------------------------------------------------------
  // T9: the heartbeat
  // ---------------------------------------------------------------------------

  /** T15: the models this application declared it can call; null when it declared nothing (then no release is refused over a model). */
  private declaredModels(): string[] | null {
    if (this.options.models === undefined) return null;
    return Array.isArray(this.options.models) ? [...this.options.models] : Object.keys(this.options.models);
  }

  /** The protocol's heartbeat body, built from what this process knows about itself. Content-free by construction. */
  heartbeatBody(): Record<string, unknown> {
    const status = this.status();
    const store = this.store?.state ?? null;
    const models = this.declaredModels() ?? [];
    const activeDigest = this.active?.manifest.payload.releaseDigest;
    const stagedDigest = this.stagedManifest?.payload.releaseDigest;
    const applyState = status.applyState === "awaiting_unlock" && this.stagedManifest ? (this.options.requireCountersign && !this.stagedManifest.countersignatures?.length ? "awaiting_countersign" : "awaiting_unlock") : status.applyState;
    const report = this.spoolReporter?.() ?? null;
    return {
      protocol: PROTOCOL_VERSION,
      instanceId: this.ownInstanceId,
      instanceClass: this.options.telemetry?.instanceClass ?? ((this.options.sync?.mode ?? "resident") === "on_invoke" ? "ephemeral" : "resident"),
      sdk: this.options.sdk ?? { name: "agent-sdk-typescript", version: SDK_VERSION },
      host: { os: process.platform === "linux" || process.platform === "darwin" || process.platform === "win32" ? (process.platform === "win32" ? "windows" : process.platform) : "other", arch: process.arch.slice(0, 16), runtime: `node ${process.versions.node}`.slice(0, 64) },
      syncMode: (this.options.sync?.mode ?? "resident") === "on_invoke" ? "on_invoke" : this.client ? "resident" : "offline",
      heartbeatIntervalSeconds: this.heartbeatIntervalSeconds,
      generation: { active: status.generation, ...(status.stagedGeneration !== null ? { staged: status.stagedGeneration } : {}) },
      ...(activeDigest ? { activeReleaseDigest: activeDigest } : {}),
      ...(stagedDigest ? { stagedReleaseDigest: stagedDigest } : {}),
      applyState,
      ...(status.applyState === "refused" && status.lastRefusal && /^[a-z_]+$/.test(status.lastRefusal) ? { refusal: status.lastRefusal } : {}),
      ...(status.applyState === "refused" && status.lastRefusal === "model_unavailable" && this.unavailableModels.length > 0 ? { unavailableModels: this.unavailableModels.slice(0, 16) } : {}),
      ...(status.signingKeyId ? { signingKeyId: status.signingKeyId } : {}),
      storageProtection: status.storageProtection === "daemon" ? "custom" : status.storageProtection,
      catalog: { models: [...new Set(models)].slice(0, 256), reportedAt: this.nowIso() },
      lease: { ...(status.leaseExpiresAt ? { expiresAt: status.leaseExpiresAt } : {}), expired: status.leaseExpired },
      ...(store ? { localRollback: { active: store.heldBackBelow !== undefined, forced: store.forcedDowngrade === true } } : {}),
      spool: {
        depthSegments: status.spool.depthSegments,
        depthBytes: status.spool.depthBytes,
        droppedSegments: report?.droppedSegments ?? 0,
        quarantinedSegments: report?.quarantinedSegments ?? 0,
        ...(report?.lastUploadAt ? { lastUploadAt: report.lastUploadAt } : {}),
        ...(report?.backoffUntil ? { backoffUntil: report.backoffUntil } : {}),
      },
      unlockRequestsSeen: status.unlockRequests.map((r) => r.releaseDigest).slice(0, 8),
      disabled: status.disabled,
    };
  }

  /** One heartbeat now (resident timers call this; on_invoke hosts send one when the interval has elapsed). Never throws. */
  async heartbeatNow(): Promise<void> {
    if (!this.client || this.daemon) return;
    if (this.heartbeating) return this.heartbeating;
    this.heartbeating = (async () => {
      try {
        const result = await this.client!.heartbeat(this.heartbeatBody());
        if (result.status === "ok") {
          this.lastHeartbeatMs = this.nowMs();
          this.lastHeartbeatRefusal = null;
          this.lastContactMs = this.nowMs();
          const interval = Number(result.response.heartbeatIntervalSeconds);
          if (Number.isFinite(interval) && interval >= 30 && interval <= 3600) this.heartbeatIntervalSeconds = interval;
          this.takeGrant(result.response);
          this.log({ event: "heartbeat", intervalSeconds: this.heartbeatIntervalSeconds, expiresAt: result.response.expiresAt ?? null, grant: this.uploadGrant ? this.uploadGrant.grantId : null });
        } else if (result.status === "refused") {
          this.lastHeartbeatRefusal = result.code ?? `http_${result.httpStatus}`;
          this.log({ event: "heartbeat_refused", httpStatus: result.httpStatus, code: result.code });
        } else {
          this.log({ event: "heartbeat_failed", httpStatus: result.httpStatus });
        }
      } catch (error) {
        this.log({ event: "heartbeat_failed", reason: (error as Error).message });
      }
    })().finally(() => {
      this.heartbeating = null;
    });
    return this.heartbeating;
  }

  private scheduleHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.stopped || !this.client || this.daemon) return;
    const delay = jitteredDelayMs(this.heartbeatIntervalSeconds, this.options.random);
    this.nextHeartbeatMs = this.nowMs() + delay;
    this.heartbeatTimer = setTimeout(() => {
      void this.heartbeatNow().finally(() => this.scheduleHeartbeat());
    }, delay);
    this.heartbeatTimer.unref?.();
  }

  /** T26: the heartbeat's answer carries the grant (or a hold) and the upload cadence. */
  private takeGrant(response: Record<string, unknown>): void {
    const interval = Number(response.uploadIntervalSeconds);
    if (Number.isFinite(interval) && interval >= 1) this.uploadIntervalSeconds = interval;
    const grant = response.uploadGrant as UploadGrant | undefined;
    if (grant && typeof grant.url === "string" && typeof grant.keyPrefix === "string") {
      this.uploadGrant = grant;
      this.uploadRetryAfterMs = null;
    } else {
      this.uploadGrant = null;
      const retryAfter = Number(response.retryAfterSeconds);
      this.uploadRetryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? this.nowMs() + retryAfter * 1000 : null;
    }
  }

  /** T26: the daemon's uploader tells the heartbeat what it knows about the spool (drops, quarantine, last upload, backoff). */
  setSpoolReporter(reporter: (() => SpoolReport) | null): void {
    this.spoolReporter = reporter;
  }

  /**
   * T26: an upload grant for one writer's prefix — a heartbeat carrying that writer's instance id (this runtime's own
   * by default). A daemon uploading for the processes attached to it calls this once per writer; the answer is cached by
   * the uploader until a minute before it lapses. Never throws.
   */
  async requestUploadGrant(input: { instanceId?: string; instanceClass?: "resident" | "ephemeral" } = {}): Promise<GrantDecision> {
    if (!this.client) return { kind: "unavailable", reason: "offline" };
    const own = input.instanceId === undefined || input.instanceId === this.ownInstanceId;
    if (own) {
      await this.heartbeatNow();
      if (this.uploadGrant) return { kind: "grant", grant: this.uploadGrant, uploadIntervalSeconds: this.uploadIntervalSeconds };
      if (this.uploadRetryAfterMs !== null) return { kind: "hold", retryAfterSeconds: Math.max(1, Math.ceil((this.uploadRetryAfterMs - this.nowMs()) / 1000)), reason: "retry_after" };
      return { kind: "unavailable", reason: this.lastHeartbeatRefusal ?? "heartbeat_failed" };
    }
    try {
      const body = { ...this.heartbeatBody(), instanceId: input.instanceId, ...(input.instanceClass ? { instanceClass: input.instanceClass } : {}) };
      const result = await this.client.heartbeat(body);
      if (result.status === "ok") {
        const interval = Number(result.response.uploadIntervalSeconds);
        if (Number.isFinite(interval) && interval >= 1) this.uploadIntervalSeconds = interval;
        const grant = result.response.uploadGrant as UploadGrant | undefined;
        if (grant && typeof grant.url === "string") return { kind: "grant", grant, uploadIntervalSeconds: this.uploadIntervalSeconds };
        const retryAfter = Number(result.response.retryAfterSeconds);
        return { kind: "hold", retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 900, reason: "retry_after" };
      }
      return { kind: "unavailable", reason: result.status === "refused" ? (result.code ?? `http_${result.httpStatus}`) : `http_${result.httpStatus}` };
    } catch (error) {
      return { kind: "unavailable", reason: `network:${(error as Error).message}` };
    }
  }

  /** T26: the runtime's own grant as the last heartbeat left it, for hosts that upload themselves. */
  get grant(): { grant: UploadGrant | null; uploadIntervalSeconds: number; retryAfterUntil: string | null } {
    return { grant: this.uploadGrant, uploadIntervalSeconds: this.uploadIntervalSeconds, retryAfterUntil: this.uploadRetryAfterMs === null ? null : new Date(this.uploadRetryAfterMs).toISOString() };
  }

  /**
   * T26 (D25 survives on serverless): the memory sink's rows, closed as one segment and POSTed under this runtime's own
   * grant. Rows that cannot go (no grant, a hold, a refused POST) are put back so the next flush carries them; past the
   * buffer the sink's own eviction reports the loss. Never throws; returns what happened.
   */
  async flushTelemetry(): Promise<{ status: "uploaded"; segment: string; rows: number } | { status: "nothing" } | { status: "held"; reason: string; rows: number }> {
    if (!(this.sink instanceof MemorySink)) return { status: "nothing" };
    const rows = this.sink.drain(this.nowMs());
    if (rows.length === 0) return { status: "nothing" };
    const requeue = () => {
      for (const row of rows) this.sink.append(row as SpoolRow, this.nowMs());
    };
    const decision = this.uploadGrant && Date.parse(this.uploadGrant.expiresAt) - 60_000 > this.nowMs() ? { kind: "grant" as const, grant: this.uploadGrant } : await this.requestUploadGrant();
    if (decision.kind !== "grant") {
      requeue();
      return { status: "held", reason: decision.kind === "hold" ? `retry_after:${decision.retryAfterSeconds}` : decision.reason, rows: rows.length };
    }
    const minute = epochMinute(this.nowMs());
    this.flushSegmentN = this.lastFlushMinute === minute ? this.flushSegmentN + 1 : 0;
    this.lastFlushMinute = minute;
    const segment = segmentName(this.ownInstanceId, minute, this.flushSegmentN);
    const bytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    const outcome = await postSegment({ grant: decision.grant, segment, bytes, fetch: this.options.fetch ?? (globalThis.fetch as unknown as FetchLike), now: () => this.nowMs() });
    if (outcome.status === "ok") {
      this.log({ event: "telemetry_flushed", segment, rows: rows.length });
      return { status: "uploaded", segment, rows: rows.length };
    }
    requeue();
    if (outcome.status === "refused" && outcome.expired) this.uploadGrant = null;
    const reason = outcome.status === "refused" ? `http_${outcome.httpStatus}` : outcome.status === "too_large" ? "too_large" : `network:${outcome.reason}`;
    this.log({ event: "telemetry_flush_failed", reason, rows: rows.length });
    return { status: "held", reason, rows: rows.length };
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
    if (this.lastHeartbeatMs === null || this.nowMs() - this.lastHeartbeatMs >= this.heartbeatIntervalSeconds * 1000) void this.heartbeatNow();
    try {
      return await handler();
    } finally {
      this.spool.closeWindows(this.nowMs());
      void this.syncNow();
      // D25 on serverless: the invocation's rows go out under the runtime's own grant; a failure keeps them for the next one.
      if (this.client && this.sink instanceof MemorySink) void this.flushTelemetry();
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
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = null;
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
    // The standing directives (from the latest verified manifest) win when they are as new as this one.
    if (this.standingDirectives && this.standingDirectives.generation >= payload.generation) return this.disabledFrom(this.standingDirectives.directives);
    return this.disabledFrom(payload.directives);
  }

  private disabledFrom(directives: readonly Directive[]): { agent: boolean; slots: string[] } {
    const slots: string[] = [];
    let agent = false;
    for (const directive of directives) {
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
      if (payload.onLeaseExpiry === "halt") {
        // A runtime with no way to call home (no key, offline sync) can never renew: halt there is a self-inflicted
        // outage, so it degrades and says so once. The console refuses to save halt on an offline environment too.
        if (!this.client) {
          if (!this.haltWithoutContactWarned) {
            this.haltWithoutContactWarned = true;
            this.log({ event: "halt_without_contact_degraded", generation: active.generation });
          }
        } else throw new RenderRefusedError("lease_expired", tag, active.generation);
      }
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

  /**
   * Time a model call against a rendered prompt (or a workflow step) and
   * report it: latency, `usage` read off the provider's response (OpenAI,
   * Anthropic, Bedrock shapes), a thrown failure classified into the closed
   * error set. The result comes back unchanged; an error is re-thrown after
   * it is counted. Nothing of the response but its usage and finish reason
   * is read; nothing of an error but its code and status.
   */
  async observe<T>(rendered: Pick<Rendered, "tag" | "versionId" | "arm" | "model">, call: () => Promise<T> | T, options: ObserveOptions = {}): Promise<T> {
    // T29: the slot's declared output checks run on the result here, on the host, and only their counts leave.
    const declared = this.declaredChecksFor(rendered.tag, rendered.arm);
    const evaluate: ObserveOptions["evaluate"] | undefined =
      declared.length > 0
        ? (result, usage) => {
            const text = outputTextOf(result);
            if (text === null) return undefined;
            const outcome = evaluateChecks(declared, { text, outputTokens: usage.source === "reported" ? usage.output : null });
            return { passed: outcome.passed, failed: outcome.failed };
          }
        : undefined;
    return observeCall(rendered, call, (observation) => this.spool.observe(observation, this.nowMs()), { ...options, ...(evaluate ? { evaluate } : {}), now: () => this.nowMs() });
  }

  /**
   * T29: run the slot's declared output checks on an output you already have (an app that calls the model without
   * `observe()`, or one that wants the per-check results), and count them on the window. Never throws.
   */
  checks(rendered: Pick<Rendered, "tag" | "versionId" | "arm" | "model">, output: unknown, options: { outputTokens?: number | null; record?: boolean } = {}): CheckOutcome {
    const declared = this.declaredChecksFor(rendered.tag, rendered.arm);
    const text = typeof output === "string" ? output : outputTextOf(output);
    if (declared.length === 0 || text === null) return { passed: 0, failed: 0, results: [] };
    const outcome = evaluateChecks(declared, { text, outputTokens: options.outputTokens ?? null });
    if (options.record !== false && (outcome.passed > 0 || outcome.failed > 0)) {
      this.spool.checks({ tag: rendered.tag, versionId: rendered.versionId, arm: rendered.arm, model: rendered.model }, { passed: outcome.passed, failed: outcome.failed }, this.nowMs());
    }
    return outcome;
  }

  /** The active manifest's checks for a slot on an arm (the arm's override when it carries one). */
  private declaredChecksFor(tag: string, arm: string): NonNullable<ManifestSlot["outputChecks"]> {
    const payload = this.active?.manifest.payload;
    if (!payload) return [];
    const override = payload.experiment?.arms.find((entry) => entry.arm === arm)?.overrides.find((entry) => entry.tag === tag);
    const slot = override ?? payload.slots.find((entry) => entry.tag === tag);
    return slot?.outputChecks ?? [];
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
      disabled: this.disabledNow(),
      unlockRequests: this.openUnlockRequests(manifest ?? null).map((d) => ({ releaseDigest: d.releaseDigest, requestedBy: d.requestedBy, requestedAt: d.requestedAt, expiresAt: d.expiresAt, ...(d.note !== undefined ? { note: d.note } : {}) })),
      window: (() => {
        const governing = this.windowInForce(this.stagedManifest ?? this.active?.manifest ?? null);
        if (!governing) return null;
        const state = windowState(governing.window, this.nowMs());
        return { source: governing.source, open: state.open, opensAt: new Date(state.opensAtMs).toISOString(), closesAt: new Date(state.closesAtMs).toISOString() };
      })(),
      heartbeat: { lastAt: this.lastHeartbeatMs === null ? null : new Date(this.lastHeartbeatMs).toISOString(), nextAt: this.nextHeartbeatMs === null || !this.heartbeatTimer ? null : new Date(this.nextHeartbeatMs).toISOString(), intervalSeconds: this.heartbeatIntervalSeconds, lastRefusal: this.lastHeartbeatRefusal },
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
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = null;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.heartbeating) await this.heartbeating;
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

  /** The memory sink's rows on serverless hosts (the host's uploader takes them at invocation end); a `dropped` row closes an over-budget invocation. */
  drainMemorySink(): unknown[] {
    return this.sink instanceof MemorySink ? this.sink.drain(this.nowMs()) : [];
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
