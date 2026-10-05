/**
 * `AirPrompterAgent` — the runtime a customer application holds.
 *
 * `start()` reads the store before any network and serves immediately from
 * the last verified release (other slot → vendored bundle → refuse to start
 * when nothing verifies); sync runs in the background per mode. `prompt(tag)`
 * renders with trust-aware variables and hands back a content-free `runRef`;
 * `workflow(tag)` yields steps in order; `report()` and `feedback()` feed the
 * spool. The render path never reaches AirPrompter; the only network it can
 * touch is the application's own — a variable source it registered
 * (`renderAsync`, `docs/variables.md`), never on the synchronous `render()`.
 *
 * @example
 * ```ts
 * const ap = await AirPrompterAgent.start({
 *   organizationId, agentId, target: "prod",
 *   apiKey: process.env.AIRPROMPTER_AGENT_KEY, // omit to run fully offline from the store or a vendored bundle
 *   root: { pinned: PINNED_ROOT_JWK }, // AirPrompter's root key for the public service; never your app's target
 *   sync: { mode: "resident", pollSeconds: 30 },
 * });
 * const r = ap.prompt("support.triage", { subject: userId }).render({ team: "Billing", ticket: userMessage });
 * const reply = await ap.observe(r, () => openai.chat.completions.create({ model: r.model, messages: [{ role: "user", content: r.text }] }));
 * ap.feedback(r.runRef, { thumbs: "up" });
 * await ap.stop(); // flushes the spool
 * ```
 */

import { createHmac, randomBytes } from "node:crypto";
import { errorNamed, experimentForTag, experimentsOf, nodeFs, protocolAtLeast } from "@airprompter/agent-core";
import type { FsPort } from "@airprompter/agent-core";
import { realpathSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

import { bundlePayloadBytes, openBundle, type DistributionKey } from "@airprompter/agent-core";
import { rampWeightsAt } from "@airprompter/agent-core";
import { instant, keyThumbprint, trustedRootFromPinnedKey, verifyManifest, verifyRootMetadata } from "@airprompter/agent-core";
import type { ApplyPolicy, Bundle, Directive, Manifest, ManifestSlot, P256PublicJwk, RefusalCode, RootMetadata, SlotVariable, Target, UploadSink } from "@airprompter/agent-core";
import { copyAudienceTags, validAudienceKey, validAudienceLabel, AUDIENCE_CAPABILITY, AUDIENCE_PROTOCOL_VERSION, parseRunRef } from "@airprompter/agent-core";
import type { Delimiters } from "@airprompter/agent-core";
import { normalizeFeedback } from "@airprompter/agent-core";
import { DirectorySink, HOST_SPOOL_BUDGET_BYTES, MemorySink, SpoolWriter, epochMinute, segmentName, type Observation, type RefusalRow, type SpoolRow, type SpoolSink } from "@airprompter/agent-telemetry";
import { readDaemonDiscovery, type DiscoveryResult } from "@airprompter/agent-telemetry";
import { fileKey, type KeyProvider, type StorageProtection } from "@airprompter/agent-sync";
import { requiredModelsMissing } from "@airprompter/agent-sync";
import { SlotStore, StoreError, isStoreError, type LoadedSlot } from "@airprompter/agent-sync";
import { observeCall, type ObserveOptions } from "@airprompter/agent-runtime";
import { ReleaseResolver, disabledFrom, type Rendered } from "@airprompter/agent-runtime";
import { VariableSourceRegistry, fillAsync, fillSync, isVariableSourceError, planFill, unsourced, type FillPlan, type FilledRender, type RenderValues, type VariableSourceInput } from "@airprompter/agent-runtime";
import { RenderRegistry, currentAttribution, requestTexts, withAttribution, type Attribution } from "@airprompter/agent-runtime";
import { wrapClient, type WrapHooks } from "@airprompter/agent-runtime";
import { aiSdkMiddleware, type AiSdkMiddleware, type AiSdkMiddlewareOptions } from "@airprompter/agent-runtime";
import { evaluateChecks, outputTextOf, type CheckOutcome } from "@airprompter/agent-core";
import { goldenReportsMeet, parseGoldenSet, runGoldenSet, type GoldenInvoke, type GoldenReport } from "@airprompter/agent-core";
import { JUDGE_RUBRICS, judgePrompt, judgeSignalsOf, parseJudgeReply, rubricFromPrompt, type JudgeResult, type JudgeRubric } from "@airprompter/agent-core";
import { SpoolUploader, postSegment, type GrantDecision, type UploadGrant, type UploaderStatus } from "@airprompter/agent-telemetry";
import { parseWindow, windowState, type UpdateWindow } from "@airprompter/agent-sync";
import { SyncClient, type FetchLike } from "@airprompter/agent-core";
import { jitteredDelayMs, syncOnce, type ApplyPolicyDecision } from "@airprompter/agent-sync";
import { resolveHydration, type HydrationPlan, type ReleaseDatastore, type ReleaseKey } from "@airprompter/agent-sync";

import { PROTOCOL_VERSION, SDK_VERSION } from "@airprompter/agent-core";

export const SDK_NAME = "agent-sdk-ts";
/** This package's version and the protocol it speaks (`protocol/version.ts`); the heartbeat names both, store.json records the first (S8). */
export { PROTOCOL_VERSION, SDK_VERSION };
/** A vendored bundle this close to its notAfter logs `vendored_bundle_expiring_soon` at start (the platform warns at the same distance). */
export const VENDORED_BUNDLE_EXPIRY_WARNING_DAYS = 30;

export type SyncMode = "resident" | "on_invoke" | "offline";

/** Where the release comes from: this process's own store (synced, applied, or hydrated from the datastore), or a vendored bundle. */
export type ReleaseSource = "store" | "vendored_bundle";

/**
 * Where this process writes its spool (`protocol/daemon.md`): the `telemetry.spoolDir` option, `AIRPROMPTER_SPOOL_DIR`,
 * the folder a live telemetry daemon published, or the store's own `spool/telemetry`.
 */
export type SpoolDirSource = "option" | "env" | "daemon" | "default";

/** The environment variable that names the spool folder when `telemetry.spoolDir` does not. */
export const SPOOL_DIR_ENV = "AIRPROMPTER_SPOOL_DIR";

export interface StartOptions {
  /** Local SDK tags only. Names are registered; values are never persisted or transmitted. */
  tags?: Readonly<Record<string,string>>;
  /** SDK-owned prompt labels, registered under their stable prompt tags. */
  promptLabels?: Readonly<Record<string,string>>;
  organizationId: string;
  agentId: string;
  target: Target;
  /** The Agent key (distribution kind). Absent means offline: serve the store or the vendored bundle, never call home. */
  apiKey?: string;
  baseUrl?: string;
  stateDir?: string;
  keyProvider?: KeyProvider;
  /** The pinned root for this environment, or a full root document (from the bundle or a previous accept). */
  /**
   * The trust anchor: the pinned root public key shipped for the hosted environment this runtime talks to (the public
   * service is `prod`; `dev` / `staging` are AirPrompter's own stages), or an already-trusted root document. The root is
   * scoped to the HOSTED environment, never to this app's `target` — one platform key signs every target's manifests.
   */
  root: { pinned: P256PublicJwk; hostedEnvironment?: Target } | RootMetadata;
  /** The customer's countersign root, when the target requires countersign. */
  countersignRoot?: RootMetadata;
  requireCountersign?: boolean;
  /**
   * How this process syncs releases. `"daemon"` was removed in 0.3.0 — the telemetry daemon never serves releases — and
   * `start()` refuses it with `invalid_options`.
   */
  sync?: { mode?: SyncMode; pollSeconds?: number; edgePointerUrl?: string; rootUrl?: string };
  /** Tier 3: a vendored `.apbundle` (path or object) and, for an encrypted one, the distribution key. */
  vendoredBundle?: { bundle: Bundle | string; distributionKey?: DistributionKey };
  /**
   * T40: the customer's own datastore as the fleet's copy of each release (`ReleaseDatastore`, a DAO the application
   * implements; `pullToDatastore` fills it). At start — after the host's own store, before the vendored bundle — the
   * runtime hydrates from it: the row for its `region` (else the global rows), verified through the same chain as
   * OTA, with the datastore's rollback in force (an older row, held until the fleet moves past it). The signed
   * manifest inside the row carries the ramp plan and the directives, so dial-up percentages walk on this host's
   * clock exactly as signed. `ap.hydrate()` re-reads it (on your `LISTEN`, your bus); `pollSeconds` re-reads it on a
   * timer. Every sealed row is opened with `distributionKey`.
   */
  datastore?: { store: ReleaseDatastore; region?: string | null; pollSeconds?: number };
  /**
   * The fleet's X25519 distribution private key: opens every sealed bundle this host is handed — the vendored one
   * and every `applyBundle()` — when neither names its own. Held by runtimes, never by the puller.
   */
  distributionKey?: DistributionKey;
  apply?: {
    /**
     * A local policy this process always applies on top of the host's pin (S4): `unlock_required` here makes every
     * release wait whatever the manifest or the pin says; `auto` here is not a loosening — the pin still governs.
     * Loosening a pinned host is an operator's act: `airprompter policy set … auto` (or `ap.setApplyPolicy("auto")`).
     */
    policy?: ApplyPolicy;
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
  /**
   * How this application fills prompt variables from its own system: a literal per name, or a source
   * (`{ resolve, trust, timeoutMs?, maxBytes? }`) called at `renderAsync()` for a declared variable the version uses
   * and the call site did not pass. `ap.variables.provide()` adds more after start. See `variables/sources.ts`.
   */
  variables?: Record<string, VariableSourceInput>;
  delimiters?: Delimiters;
  telemetry?: {
    sink?: "directory" | "memory";
    instanceClass?: "resident" | "ephemeral";
    /** Serverless: the in-memory buffer (default 256 KiB); the oldest rows go past it and a `dropped` row says so. */
    bufferBytes?: number;
    /** Hosts: the closed-segment budget (default 100 MiB); the oldest unsent segments go past it and a `dropped` row says so. */
    spoolBudgetBytes?: number;
    /**
     * The folder this process writes its spool to. Absent: `AIRPROMPTER_SPOOL_DIR`, else the folder a live telemetry
     * daemon for this agent and target published (`<storeDir>/daemon.json`), else `<storeDir>/spool/telemetry`. An
     * explicit folder never moves; a discovered one is re-read once a minute.
     */
    spoolDir?: string;
    /**
     * S5: a resident host whose spool no live telemetry daemon ships uploads it itself — the same `SpoolUploader` the
     * daemon runs, in-process, on a timer off the request path, under this runtime's own grant. When a live daemon
     * names this process's folder the daemon uploads and this process does not (re-checked once a minute, both ways).
     * `false` leaves the spool for the daemon or an operator's `airprompter export-telemetry`; the budget still holds
     * and `dropped` rows still count.
     */
    upload?: boolean;
    /**
     * S13: where the uploader ships validated segments. Absent: AirPrompter's sink (a grant per writer, a PUT to your
     * prefix). `otlpUploadSink(...)` from `@airprompter/otel-bridge` sends the windows to your OpenTelemetry collector
     * instead — no grant is ever requested — and a customer's own sink takes the same segments.
     */
    uploadSink?: UploadSink;
    /**
     * S5: serverless (`on_invoke`) — `invoke()` waits for the invocation's rows to land before it returns
     * (`"await"`, the default: one POST under the runtime's own grant, never more than the buffer). `"background"`
     * hands the flush to the event loop and returns at once; on a platform that freezes the process at the response
     * (Lambda), rows in flight are lost with no `dropped` row possible.
     */
    flush?: "await" | "background";
  };
  now?: () => number;
  fetch?: FetchLike;
  /** S2: the filesystem behind the store and the spool — the Node port by default; a fake that fills, fails or loses files in a customer's CI. */
  fs?: FsPort;
  random?: () => number;
  logger?: (event: Record<string, unknown>) => void;
  /**
   * T26: who reports on the heartbeat — this SDK by default; the telemetry daemon names itself `airprompterd`, the CLI
   * `airprompter-cli`. It names the *reporting software*, never the customer's app (the heartbeat schema is an enum,
   * so any other name is refused by the control plane); `start()` refuses it up front with `invalid_options`.
   */
  sdk?: { name: HeartbeatReporterName; version: string };
  /**
   * T34: golden sets before activation. With `invoke` set, every slot of a staged release that carries a golden set is
   * run against the pinned model through this call before the apply decision; a set below its pass-rate floor leaves
   * the release staged (`golden_set_failed` in the log, `goldenPass` counts on the arm's window) until an operator
   * unlocks it deliberately. Without it, golden sets ride the release unrun (`ap.golden()` runs them on demand).
   */
  golden?: { invoke: GoldenInvoke; concurrency?: number };
}

export type HeartbeatSdkName = NonNullable<StartOptions["sdk"]>["name"];

/** T26: what the uploader knows about the spool, folded into the heartbeat's `spool` block. */
export interface SpoolReport {
  droppedSegments: number;
  quarantinedSegments: number;
  lastUploadAt: string | null;
  backoffUntil: string | null;
}

export type { Rendered };

/** S9/S16: a ramp plan as this host walks it — one per experiment. */
export interface AgentRampStatus {
  experimentId: string;
  /** S16: the slot the experiment splits; null on the legacy single experiment. */
  tag: string | null;
  weightBps: number[];
  arms: string[];
  step: number;
  nextStepAt: string | null;
  plan: Array<{ notBefore: string; weightBps: number[] }>;
}

export interface AgentStatus {
  instanceId: string;
  generation: number;
  stagedGeneration: number | null;
  applyState: "active" | "staged" | "awaiting_unlock" | "refused" | "vendored_fallback";
  lastRefusal: string | null;
  storageProtection: StorageProtection;
  signingKeyId: string | null;
  /** When the lease runs out: last successful contact + leaseSeconds (a vendored bundle's notAfter when nothing ever synced). */
  leaseExpiresAt: string | null;
  leaseExpired: boolean;
  onLeaseExpiry: "degrade" | "halt" | null;
  lastContactAt: string | null;
  forcedDowngrade: boolean;
  /** Emergency disable from the manifest (§6.5): the whole agent, named slots, or (S9) named arms whose share went back to the control. */
  disabled: { agent: boolean; slots: string[]; arms: string[] };
  /**
   * S9: the ramp plan as this host walks it — the weights in force now (after any disabled arm's share went to the control),
   * the step in force (0-based index into `ramp`, or -1 before the first / with no plan), and the next step's instant.
   */
  ramp: AgentRampStatus | null;
  /** S16: one entry per experiment the active manifest carries (per slot); `ramp` is the first of them. */
  ramps: AgentRampStatus[];
  /** Open (unexpired) unlock requests carried by the latest verified manifest, for operator tooling. */
  unlockRequests: Array<{ releaseDigest: string; requestedBy: string; requestedAt: string; expiresAt: string; note?: string }>;
  /** T9: the update window in force (local, else the manifest's) and whether it is open now. */
  window: { source: "local" | "manifest"; open: boolean; opensAt: string; closesAt: string } | null;
  /**
   * S4: the apply policy this host runs under and where it comes from — `local` (this process's `apply.policy`),
   * `pinned` (store.json, set on first use or tightened by a manifest), `operator` (set by hand on this host), or
   * `manifest` (no pin yet: nothing verified). `manifestSaid` is what the latest verified manifest asked for; when it
   * differs from `effective` the console's setting is advisory here.
   */
  applyPolicy: { effective: ApplyPolicy; source: "local" | "pinned" | "operator" | "manifest"; manifestSaid: ApplyPolicy | null };
  /** T9: the last heartbeat the server accepted, and when the next one goes out. */
  heartbeat: { lastAt: string | null; nextAt: string | null; intervalSeconds: number; lastRefusal: string | null };
  spool: { depthSegments: number; depthBytes: number };
  source: ReleaseSource;
  /** Where the spool goes and who ships it (`protocol/daemon.md`). */
  telemetry: TelemetryPlacement;
  /** The last sync pass this process ran (resident / on_invoke). */
  lastSyncAt: string | null;
  /** T34: the last golden-set run before activation — counts only; null until one ran. */
  golden: { generation: number; met: boolean; reports: Array<{ tag: string; arm: string; cases: number; passed: number; minPassBps: number }> } | null;
  /** T40: the customer's datastore this runtime hydrates from — absent when none was given. */
  datastore?: DatastoreStatus;
  /**
   * Prompt variables and where they come from: the names this application can fill (registered sources), and per
   * slot and arm of the active release the required names no source fills — the ones every call site must pass.
   * Compare with what your code passes at start-up (`ap.prompt(tag).needs(values)` does exactly that for one call
   * site) and a version this application cannot render is found there, not on the first request. Names only.
   */
  variables: { sources: string[]; unsourced: Array<{ tag: string; arm: string; names: string[] }> };
  /** S5: this process's own uploader; null when a live telemetry daemon, a memory sink or `telemetry.upload: false` owns the spool. */
  upload: UploaderStatus | null;
  lastSyncOutcome: string | null;
  consecutiveSyncFailures: number;
  nextSyncAt: string | null;
}

/** Where this process's spool goes and who ships it (`protocol/daemon.md`). */
export interface TelemetryPlacement {
  /** `directory` (segments in `spoolDir`) or `memory` (serverless; flushed at invocation end). */
  sink: "directory" | "memory";
  /** The folder segments are written to; null on the memory sink. */
  spoolDir: string | null;
  spoolDirFrom: SpoolDirSource | null;
  /** `daemon`: a live telemetry daemon ships this folder. `self`: this process's own uploader. `none`: nobody here does. */
  uploadedBy: "daemon" | "self" | "none";
  /** The telemetry daemon for this agent and target, as its discovery file says; null when there is none. */
  daemon: { live: boolean; pid: number; version: string; heartbeatAt: string; spoolDir: string } | null;
}

/** T40: what the last hydration from the customer's datastore found. */
export interface DatastoreStatus {
  region: string | null;
  lastHydrateAt: string | null;
  lastOutcome: HydrateOutcome["outcome"] | null;
  /** The newest generation the datastore holds for this region (or the global rows); 0 when none. */
  newestGeneration: number;
  rowsFrom: "region" | "global" | null;
  /** The fleet rollback in force, as the datastore says it. */
  rollback: { generation: number; heldBackBelow: number; scope: "region" | "global"; setAt: string; reason?: string } | null;
}

export interface ReleaseChange {
  generation: number;
  stagedGeneration: number | null;
}

/**
 * S14: what a probe asks. `ok` is the liveness answer (serve this process traffic?); `status` adds the one degraded
 * middle. The rules, each a vector (`test/healthz.test.ts`, `sdk-python/tests/test_healthz.py`):
 * - `failing` (ok: false): nothing verified to serve (generation 0); the lease lapsed under `onLeaseExpiry: "halt"`
 *   (every render refuses).
 * - `degraded` (ok: true): the lease lapsed under `degrade` (serving the last verified release); three or more
 *   consecutive sync failures; the uploader backing off; a forced downgrade in force; the telemetry daemon's file has
 *   gone stale and nothing here uploads instead (`upload_daemon_stale`); the spool at 80 % of its budget or more.
 * - `ok` otherwise. `reasons` names every rule that fired, in that order.
 */
export interface Healthz {
  ok: boolean;
  status: "ok" | "degraded" | "failing";
  reasons: string[];
  generation: number;
  stagedGeneration: number | null;
  applyState: AgentStatus["applyState"];
  source: ReleaseSource;
  leaseExpiresAt: string | null;
  leaseExpired: boolean;
  onLeaseExpiry: "degrade" | "halt" | null;
  lastSyncAt: string | null;
  lastSyncOutcome: string | null;
  consecutiveSyncFailures: number;
  forcedDowngrade: boolean;
  telemetry: { uploadedBy: TelemetryPlacement["uploadedBy"]; daemon: "live" | "stale" | null };
  spool: { depthSegments: number; depthBytes: number; budgetBytes: number | null };
  lastUploadAt: string | null;
  backoffUntil: string | null;
}

/** The same rules on any status document. */
export function healthzOf(status: AgentStatus, input: { spoolBudgetBytes?: number | null; nowMs: number }): Healthz {
  const reasons: string[] = [];
  const levels = { ok: 0, degraded: 1, failing: 2 } as const;
  let level: Healthz["status"] = "ok";
  const raise = (to: Healthz["status"], reason: string) => {
    reasons.push(reason);
    if (levels[to] > levels[level]) level = to;
  };
  const failing = (reason: string) => raise("failing", reason);
  const degraded = (reason: string) => raise("degraded", reason);
  if (status.generation <= 0) failing("no_verified_release");
  if (status.leaseExpired && status.onLeaseExpiry === "halt") failing("lease_expired_halt");
  if (status.leaseExpired && status.onLeaseExpiry === "degrade") degraded("lease_expired_degrade");
  if (status.consecutiveSyncFailures >= 3) degraded("sync_failing");
  const backoffUntil = status.upload?.backoffUntil ?? null;
  if (backoffUntil && instant(backoffUntil) > input.nowMs) degraded("upload_backing_off");
  if (status.forcedDowngrade) degraded("forced_downgrade");
  const telemetry = status.telemetry ?? null;
  if (telemetry?.daemon && !telemetry.daemon.live && telemetry.uploadedBy === "none") degraded("upload_daemon_stale");
  const budgetBytes = input.spoolBudgetBytes ?? null;
  if (budgetBytes !== null && budgetBytes > 0 && status.spool.depthBytes >= budgetBytes * 0.8) degraded("spool_near_budget");
  const status_: Healthz["status"] = level;
  return {
    ok: levels[status_] < levels.failing,
    status: status_,
    reasons,
    generation: status.generation,
    stagedGeneration: status.stagedGeneration,
    applyState: status.applyState,
    source: status.source,
    leaseExpiresAt: status.leaseExpiresAt,
    leaseExpired: status.leaseExpired,
    onLeaseExpiry: status.onLeaseExpiry,
    lastSyncAt: status.lastSyncAt,
    lastSyncOutcome: status.lastSyncOutcome,
    consecutiveSyncFailures: status.consecutiveSyncFailures,
    forcedDowngrade: status.forcedDowngrade,
    telemetry: { uploadedBy: telemetry?.uploadedBy ?? "none", daemon: telemetry?.daemon ? (telemetry.daemon.live ? "live" : "stale") : null },
    spool: { depthSegments: status.spool.depthSegments, depthBytes: status.spool.depthBytes, budgetBytes },
    lastUploadAt: status.upload?.lastUploadAt ?? null,
    backoffUntil,
  };
}

/** An HTTP answer for any framework: 200 with the document when `ok`, 503 otherwise. */
export function healthzResponse(healthz: Healthz): { status: 200 | 503; headers: Record<string, string>; body: string } {
  const body = JSON.stringify(healthz);
  return { status: healthz.ok ? 200 : 503, headers: { "content-type": "application/json", "cache-control": "no-store" }, body };
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

/** The reporters the heartbeat schema admits (`protocol/schemas/heartbeat.schema.json`, `sdk.name`). */
export const HEARTBEAT_REPORTER_NAMES = ["agent-sdk-typescript", "agent-sdk-python", "airprompter-cli", "airprompterd"] as const;
export type HeartbeatReporterName = (typeof HEARTBEAT_REPORTER_NAMES)[number];

/** What `applyBundle()` (and the vendored bundle at boot) did with a bundle, and why when it did nothing. */
export type BundleOutcome =
  | { outcome: "activated"; generation: number }
  | { outcome: "staged"; generation: number }
  | { outcome: "unchanged"; generation: number }
  | { outcome: "held_back"; generation: number; heldBackBelow: number }
  | { outcome: "refused"; generation: number | null; reason: RefusalCode | "generation_rollback" | "expired" | "model_unavailable" | "unusable" | "no_store" | "no_datastore"; held?: number; detail?: string };

/**
 * T40: what `hydrate()` did — a `BundleOutcome` for the row it read, `rolled_back` when the datastore's rollback moved
 * this host down, `empty` when the datastore holds no row for it, `unavailable` when the datastore could not be read.
 */
export type HydrateOutcome =
  | BundleOutcome
  | { outcome: "rolled_back"; generation: number; heldBackBelow: number }
  | { outcome: "empty"; generation: null }
  | { outcome: "unavailable"; generation: null; detail: string };

export class AgentStartError extends Error {
  constructor(
    readonly code: "no_verified_release" | "kek_unavailable" | "store_corrupt" | "store_newer" | "invalid_options",
    message: string,
  ) {
    super(message);
    this.name = "AgentStartError";
  }
}

/** `AgentStartError` by name and code — true across duplicated package copies. */
export function isAgentStartError(error: unknown): error is AgentStartError {
  return errorNamed<AgentStartError["code"]>(error, "AgentStartError");
}

export class AirPrompterAgent {
  private active: LoadedSlot | null = null;
  private source: ReleaseSource = "store";
  private lastSyncMs: number | null = null;
  private lastSyncOutcome: string | null = null;
  /** The reason and detail behind the last sync outcome (`unavailable`/`refused`), for the boot error and the log. */
  private lastSyncDetail: { reason: string | null; detail: string | null } = { reason: null, detail: null };
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
  private lastGolden: AgentStatus["golden"] = null;
  private lastContactMs: number | null = null;
  /** S3: the heartbeat named a generation the pointer has not shown; the next pass goes to the signed manifest. */
  private pointerBehind = false;
  private readonly contactListeners = new Set<(contact: { expiresAt: string | null; lastContactAt: string }) => void>();
  private bundleNotAfter: string | null = null;
  private datastoreStatus: DatastoreStatus | null = null;
  private datastoreTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * T9: directives from the latest manifest whose envelope verified — honoured even when that manifest was left staged,
   * held back, or ignored as the generation already held. A Freeze reaches a fleet that never unlocks.
   */
  private standingDirectives: { generation: number; directives: Directive[] } | null = null;
  private resolverFor: { release: LoadedSlot; standing: { generation: number; directives: Directive[] } | null; resolver: ReleaseResolver } | null = null;
  /** S4: what the latest verified manifest asked for, and the generation whose advisory mismatch was already logged. */
  private manifestApplyPolicy: { generation: number; value: ApplyPolicy } | null = null;
  private applyPolicyAdvisoryLogged = 0;
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  /** S6: closes the windows of a minute that has passed, so an idle writer never parks a burst's last minute in an `.open` file. */
  private spoolTimer: ReturnType<typeof setInterval> | null = null;
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
  /** S5: the in-process uploader; null when a live telemetry daemon, a memory sink, or `telemetry.upload: false` owns the spool. */
  private uploader: SpoolUploader | null = null;
  /** `protocol/daemon.md`: the folder, where it came from, and the daemon's discovery file as last read. */
  private spoolDir: string;
  private spoolDirFrom: SpoolDirSource;
  private discovery: DiscoveryResult | null;
  private placing: Promise<void> | null = null;
  private flushSegmentN = 0;
  private lastFlushMinute: number | null = null;
  private trustedRoot: RootMetadata;
  private readonly runRefKey: Buffer;
  private audienceServerSupported = false;
  private audienceTags: Readonly<Record<string,string>> = {};
  private readonly audienceTagKeys = new Set<string>();
  private readonly audiencePromptLabels = new Map<string,string>();
  /** T33: the last renders by text hash, so a wrapped client can tell which slot a call is. */
  private readonly renders = new RenderRegistry();
  /** The application's variable sources (`start({ variables })`, `ap.variables.provide()`). */
  readonly variables: VariableSourceRegistry;
  /** Slot × variable pairs whose stricter-trust line was logged; bounded by declared names, never cleared. */
  private readonly stricterSaid = new Set<string>();
  readonly spool: SpoolWriter;
  private readonly sink: SpoolSink;
  private readonly directorySink: DirectorySink | null;
  private readonly client: SyncClient | null;

  private constructor(
    private readonly options: StartOptions,
    /** This process's own store. */
    private readonly store: SlotStore | null,
    trustedRoot: RootMetadata,
    /** The writer identity (S6): this PROCESS's own id, fresh at every start; never a hostname, never the store's. */
    private readonly ownInstanceId: string,
    placement: { dir: string; from: SpoolDirSource; discovery: DiscoveryResult | null },
    /**
     * S6: what the runRef key is derived from — the STORE's id (store.json), which every process on the host shares, so a
     * runRef minted by one worker parses in another (feedback lands wherever the request lands).
     */
    runRefSeed: string = ownInstanceId,
  ) {
    this.spoolDir = placement.dir;
    this.spoolDirFrom = placement.from;
    this.discovery = placement.discovery;
    this.trustedRoot = trustedRoot;
    this.setTags(options.tags ?? {});
    for (const [tag,label] of Object.entries(options.promptLabels ?? {})) this.registerPromptLabel(tag,label);
    this.runRefKey = createHmac("sha256", Buffer.from(runRefSeed, "utf8")).update("runRef").digest();
    this.localWindow = options.apply?.window ? parseWindow(options.apply.window) : null;
    this.heartbeatIntervalSeconds = Math.min(3600, Math.max(30, Math.round(options.heartbeatSeconds ?? 300)));
    const serverless = (options.sync?.mode ?? "resident") === "on_invoke";
    const memory = options.telemetry?.sink === "memory" || (options.telemetry?.sink === undefined && serverless);
    // Every closed segment gets its manifest: the writer's scope and its heartbeat report, for the telemetry daemon.
    this.directorySink = memory ? null : new DirectorySink(placement.dir, ownInstanceId, options.telemetry?.spoolBudgetBytes, options.fs, { manifest: () => this.manifestContext(), now: () => this.nowMs() });
    this.sink = this.directorySink ?? new MemorySink({ instanceId: ownInstanceId }, options.telemetry?.bufferBytes);
    this.spool = new SpoolWriter(this.sink, { instanceId: ownInstanceId, instanceClass: options.telemetry?.instanceClass ?? (serverless ? "ephemeral" : "resident"), sdk: `${SDK_NAME}/${SDK_VERSION}` });
    this.variables = new VariableSourceRegistry(options.variables);
    this.client =
      options.apiKey && options.sync?.mode !== "offline"
        ? new SyncClient({ baseUrl: options.baseUrl ?? "https://api.airprompter.com", agentId: options.agentId, target: options.target, apiKey: options.apiKey, ...(options.fetch ? { fetch: options.fetch } : {}), userAgent: `${SDK_NAME}/${SDK_VERSION}` })
        : null;
  }

  static async start(options: StartOptions): Promise<AirPrompterAgent> {
    if (options.sdk !== undefined) {
      const name = (options.sdk as { name?: unknown }).name;
      const version = (options.sdk as { version?: unknown }).version;
      if (!(HEARTBEAT_REPORTER_NAMES as readonly unknown[]).includes(name) || typeof version !== "string" || version.length === 0 || version.length > 64) {
        throw new AgentStartError(
          "invalid_options",
          `options.sdk names the reporting software and must be one of ${HEARTBEAT_REPORTER_NAMES.join(", ")} with a version up to 64 characters (got ${JSON.stringify(options.sdk)}); leave it unset to report as this SDK — it is not the place for your app's name`,
        );
      }
    }
    const stateDir = options.stateDir ?? defaultStateDir();
    const pinnedRoot = "pinned" in options.root ? trustedRootFromPinnedKey({ purpose: "platform", environment: options.root.hostedEnvironment ?? "prod", pinnedRoot: options.root.pinned }) : options.root;
    if ((options.sync?.mode as string | undefined) === "daemon" || (options.sync as { daemonSocketPath?: unknown } | undefined)?.daemonSocketPath !== undefined) {
      throw new AgentStartError(
        "invalid_options",
        'sync.mode "daemon" was removed in 0.3.0: the telemetry daemon (airprompterd) only ships telemetry and never serves a release. Start with the default mode (resident) — each process loads its release from its own store, the datastore or a vendored bundle — and keep the daemon running for telemetry (protocol/daemon.md)',
      );
    }
    const keyProvider = options.keyProvider ?? fileKey(join(SlotStore.path({ stateDir, agentId: options.agentId, target: options.target }), "store.key"), options.fs ?? nodeFs);
    let store: SlotStore;
    try {
      // S8: store.json records who wrote it — this SDK, or the CLI naming itself through `sdk`.
      store = await SlotStore.open({ stateDir, agentId: options.agentId, target: options.target, keyProvider, hooks: { writer: options.sdk ? { name: options.sdk.name, version: options.sdk.version } : { name: "agent-sdk-typescript", version: SDK_VERSION } }, ...(options.fs ? { fs: options.fs } : {}) });
    } catch (error) {
      if (isStoreError(error) && (error.code === "kek_unavailable" || error.code === "store_corrupt" || error.code === "store_newer")) throw new AgentStartError(error.code, error.message);
      throw error;
    }
    const pinned = pinnedRoot;
    // The stored root (accepted on an earlier run) is trusted only if it still verifies against the pinned key.
    const stored = store.state.root;
    const trusted = stored && verifyRootMetadata({ candidate: stored, trusted: pinned, now: new Date(options.now?.() ?? Date.now()).toISOString() }).ok ? stored : pinned;
    // S6: the instance id is the PROCESS's, never the store's — N workers on one host are N instances in the fleet view, and
    // their same-minute windows keep distinct keys at ingest (the store's own id stays store.json's identity).
    const agent = new AirPrompterAgent(options, store, trusted, AirPrompterAgent.newInstanceId(), spoolPlacement(options, store.dir, options.now?.() ?? Date.now()), store.instanceId);
    await agent.boot();
    return agent;
  }

  /**
   * The vendored bundle at boot (S7). With nothing verified on the host it is the tier-3 fallback: staged through the store
   * and activated, whatever its generation. With a store already serving, a bundle is an UPDATE like any other: one whose
   * generation is above what the host holds is verified through the same chain as OTA and staged, and the host's apply
   * policy decides (the S4 pin: `auto` activates, `unlock_required` stages for the unlock, the window, the hook); one at
   * the held generation changes nothing; one BELOW it — a `git revert` to an older bundle — is refused and says so: a
   * rollback is `airprompter rollback`, never an older bundle. A bundle past its `notAfter` is refused as an update (the
   * store's release is fine) and applied only as the fallback, lease-expired. Never throws.
   */
  private async takeVendoredBundle(now: string, verifyOptions: { now: string; root: RootMetadata; countersignRoot: RootMetadata | null; requireCountersign?: boolean }): Promise<void> {
    let contents: ReturnType<typeof openBundle>;
    try {
      // A path is read through the application's filesystem port, like everything else the runtime opens.
      const bundle = typeof this.options.vendoredBundle!.bundle === "string" ? (JSON.parse(new TextDecoder().decode((this.options.fs ?? nodeFs).readFile(this.options.vendoredBundle!.bundle))) as Bundle) : this.options.vendoredBundle!.bundle;
      contents = openBundle(bundle, { agentId: this.options.agentId, target: this.options.target }, this.options.vendoredBundle!.distributionKey ?? this.options.distributionKey);
    } catch (error) {
      this.log({ event: "vendored_bundle_unusable", reason: (error as Error).message });
      return;
    }
    await this.takeBundle(contents, "vendored_bundle", now, verifyOptions);
  }

  /**
   * A release handed to this host as a bundle — vendored at boot, or applied at run time from the customer's own
   * store. With nothing active it is the tier-3 fallback, staged through the store and activated whatever its
   * generation. With a release serving it is an UPDATE like any other: above the held generation it runs the same
   * chain as OTA — signatures, scope, every payload's hash — and is staged, then the host's apply policy decides
   * (auto activates; unlock_required stages, then the hook, the window, `unlock()`); the held generation changes
   * nothing; one BELOW it is refused — a rollback is `rollback()`, never an older bundle; past `notAfter` it is
   * refused as an update (the store's release is fine) and applied only as the fallback, lease-expired. Never throws.
   */
  private async takeBundle(contents: ReturnType<typeof openBundle>, source: "vendored_bundle" | "applied_bundle" | "datastore", now: string, verifyOptions: { now: string; root: RootMetadata; countersignRoot: RootMetadata | null; requireCountersign?: boolean }): Promise<BundleOutcome> {
    const store = this.store!;
    const generation = contents.manifest.payload.generation;
    const daysLeft = Math.floor((instant(contents.notAfter) - instant(now)) / 86_400_000);
    // A first release staged under unlock_required (nothing active, something staged) is a HELD generation: a bundle
    // at or below it is not a fallback to activate around the unlock, it is the update path with its rules.
    const updating = this.active !== null || this.stagedManifest !== null;
    if (updating) {
      const held = Math.max(store.state.generation, this.stagedManifest?.payload.generation ?? 0);
      if (generation === held) return { outcome: "unchanged", generation };
      if (generation < held) {
        // The sentence a git customer sees on a revert, or a fleet sees on a restored backup: refused, and what to do instead.
        this.log({ event: `${source}_refused`, reason: "generation_rollback", bundleGeneration: generation, heldGeneration: held, message: `the bundle is generation ${generation}; this host holds ${held}. A bundle never moves a host backwards — a rollback is \`airprompter rollback\`, never an older bundle.` });
        this.lastRefusal = "generation_rollback";
        return { outcome: "refused", generation, reason: "generation_rollback", held };
      }
      const heldBackBelow = store.state.heldBackBelow;
      if (heldBackBelow !== undefined && generation <= heldBackBelow) {
        this.log({ event: `${source}_held_back`, bundleGeneration: generation, heldBackBelow });
        return { outcome: "held_back", generation, heldBackBelow };
      }
      if (daysLeft < 0) {
        this.log({ event: `${source}_refused`, reason: "expired", bundleGeneration: generation, notAfter: contents.notAfter });
        return { outcome: "refused", generation, reason: "expired" };
      }
    } else {
      this.bundleNotAfter = contents.notAfter;
      if (daysLeft < 0) this.log({ event: `${source}_past_not_after`, notAfter: contents.notAfter });
      else if (daysLeft < VENDORED_BUNDLE_EXPIRY_WARNING_DAYS) this.log({ event: `${source}_expiring_soon`, notAfter: contents.notAfter, daysLeft });
    }
    try {
      const rootVerdict = verifyRootMetadata({ candidate: contents.keySet, trusted: this.trustedRoot, now });
      if (rootVerdict.ok) {
        this.trustedRoot = contents.keySet;
        store.acceptRoot(contents.keySet);
      }
      const payloads = bundlePayloadBytes(contents);
      // The same chain as OTA — signatures, scope, anti-rollback, every payload's hash — BEFORE a byte is staged, in
      // both branches. Staging first and letting `load` refuse left store.json advanced to a forged generation, and a
      // fresh host then refused every legitimate release below it: a compromised store could brick a fleet's runtimes.
      const verdict = verifyManifest({ manifest: contents.manifest, root: this.trustedRoot, now, scope: { organizationId: this.options.organizationId, agentId: this.options.agentId, target: this.options.target }, storedGeneration: updating ? store.state.generation : 0, payloads, countersignRoot: this.options.countersignRoot ?? null, ...(this.options.requireCountersign !== undefined ? { requireCountersign: this.options.requireCountersign } : {}) });
      if (!verdict.ok) {
        this.log({ event: `${source}_refused`, reason: verdict.reason, bundleGeneration: generation });
        this.lastRefusal = verdict.reason;
        return { outcome: "refused", generation, reason: verdict.reason };
      }
      // T15: the models this application declared it can call gate a bundle exactly as they gate a release over the air.
      const missing = requiredModelsMissing(contents.manifest.payload, this.declaredModels());
      if (missing.length > 0) {
        this.unavailableModels = [...missing];
        this.spool.refusal({ at: now, reason: "model_unavailable", generation, tag: null }, this.nowMs());
        this.log({ event: `${source}_refused`, reason: "model_unavailable", bundleGeneration: generation, models: missing });
        this.lastRefusal = "model_unavailable";
        return { outcome: "refused", generation, reason: "model_unavailable", detail: missing.join(", ") };
      }
      if (updating) {
        this.takeApplyPolicy(contents.manifest.payload);
        this.takeDirectives(contents.manifest.payload);
        store.stage({ manifest: contents.manifest, payloads });
        const decision = await this.applyPolicy(contents.manifest);
        if (decision === "staged") {
          this.log({ event: `${source}_staged`, generation });
          this.emitChange();
          return { outcome: "staged", generation };
        }
        if (decision === "activated") {
          const slot = store.activate();
          this.active = store.load(slot, { ...verifyOptions, root: this.trustedRoot });
          this.stagedManifest = null;
        }
        this.source = "store";
        this.lastRefusal = null;
        this.unavailableModels = [];
        this.log({ event: `${source}_activated`, generation: this.active!.generation });
        this.emitChange();
        return { outcome: "activated", generation: this.active!.generation };
      }
      // Stage through the store so the bundle's release becomes the encrypted A slot: verified above, like OTA.
      store.stage({ manifest: contents.manifest, payloads });
      const slot = store.activate();
      this.active = store.load(slot, { ...verifyOptions, root: this.trustedRoot });
      this.stagedManifest = null;
      this.source = source === "vendored_bundle" ? "vendored_bundle" : "store";
      this.lastRefusal = null;
      this.unavailableModels = [];
      this.log({ event: `${source}_applied`, generation: this.active.generation });
      this.emitChange();
      return { outcome: "activated", generation: this.active.generation };
    } catch (error) {
      this.log({ event: `${source}_unusable`, reason: (error as Error).message });
      return { outcome: "refused", generation, reason: "unusable", detail: (error as Error).message };
    }
  }

  /**
   * A release from the customer's own store, at run time (T39). The fleet pattern: one puller writes the bundle into
   * a database, every runtime reads the newest row and hands it here when the generation rises. The same chain and
   * the same rules as a vendored bundle — verified before a byte is staged, the apply policy decides, never below the
   * held generation (a restored backup or a stale replica cannot move a host backwards) — and the swap is atomic:
   * renders in flight finish on the release they resolved against. Never throws on a bad bundle; the outcome says why.
   */
  async applyBundle(bundle: Bundle | string, options: { distributionKey?: DistributionKey } = {}): Promise<BundleOutcome> {
    if (!this.store) return { outcome: "refused", generation: null, reason: "no_store" };
    const now = this.nowIso();
    let contents: ReturnType<typeof openBundle>;
    try {
      const parsed = typeof bundle === "string" ? (JSON.parse(bundle) as Bundle) : bundle;
      contents = openBundle(parsed, { agentId: this.options.agentId, target: this.options.target }, options.distributionKey ?? this.options.distributionKey ?? this.options.vendoredBundle?.distributionKey);
    } catch (error) {
      this.log({ event: "applied_bundle_unusable", reason: (error as Error).message });
      return { outcome: "refused", generation: null, reason: "unusable", detail: (error as Error).message };
    }
    const verifyOptions = { now, root: this.trustedRoot, countersignRoot: this.options.countersignRoot ?? null, ...(this.options.requireCountersign !== undefined ? { requireCountersign: this.options.requireCountersign } : {}) };
    // One pass over the store at a time: a sync in flight finishes first, and a sync (or another applyBundle) that
    // starts meanwhile waits for this one. `stop()` awaits the same promise.
    const previous = this.syncing ?? Promise.resolve();
    let outcome!: BundleOutcome;
    const pass = previous.catch(() => undefined).then(async () => { outcome = await this.takeBundle(contents, "applied_bundle", now, verifyOptions); });
    const guarded: Promise<void> = pass.finally(() => { if (this.syncing === guarded) this.syncing = null; });
    this.syncing = guarded;
    await guarded;
    return outcome;
  }

  /** Store first (active slot, then the other), then the vendored bundle (S7: an update when newer, the fallback when nothing is held), then refuse. Zero network. */
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
    if (this.options.datastore) await this.takeDatastore(now, verifyOptions);
    if (this.options.vendoredBundle) await this.takeVendoredBundle(now, verifyOptions);
    if (!this.active && this.client) {
      // Nothing verified locally: one synchronous sync before serving is the only time the SDK waits on the network.
      await this.syncNow();
    }
    if (!this.active) {
      // A first release staged under unlock_required (the sync just staged it, or a restart found it in the store) is a
      // host with nothing to serve yet — not a host that cannot run. T9 makes the unlock the customer's to give, and a
      // process that refuses to start can never give it: so it starts, heartbeats as generation 0 with the staged
      // generation beside it, keeps syncing, and answers `unlock()`, the window, or the hook. `prompt()` refuses until then.
      if (!this.stagedManifest) throw new AgentStartError("no_verified_release", `no verified release in the store, no usable vendored bundle, and ${this.describeFetchFailure()}`);
      this.log({ event: "awaiting_first_unlock", generation: this.stagedManifest.payload.generation });
    }
    if (this.client && (this.options.sync?.mode ?? "resident") === "resident") {
      this.schedule();
      // The first heartbeat goes out right after boot so the fleet view sees the instance before its first interval.
      void this.heartbeatNow().finally(() => this.scheduleHeartbeat());
    }
    // Who ships the spool: a live telemetry daemon naming this folder, else this process (with a client, or — S13 — a
    // sink of the customer's own, offline too), else nobody until one appears. Re-checked by the spool timer.
    await this.checkTelemetryDaemon();
    this.startSpoolTimer();
    this.scheduleWindowUnlock();
    this.startDatastorePoll();
  }

  /** T40: re-read the datastore on a timer, off the request path, when `datastore.pollSeconds` asks for it. */
  private startDatastorePoll(): void {
    const seconds = this.options.datastore?.pollSeconds;
    if (!seconds || this.datastoreTimer) return;
    this.datastoreTimer = setInterval(() => void this.hydrate(), Math.max(1, seconds) * 1000);
    this.datastoreTimer.unref?.();
  }

  /**
   * T40: hydrate from the customer's datastore now — the row for this region (else the global rows), the rollback in
   * force applied. One pass over the store at a time, like `applyBundle`. Never throws; the outcome says what happened.
   */
  async hydrate(): Promise<HydrateOutcome> {
    if (!this.options.datastore) return { outcome: "refused", generation: null, reason: "no_datastore" };
    if (!this.store) return { outcome: "refused", generation: null, reason: "no_store" };
    const now = this.nowIso();
    const verifyOptions = { now, root: this.trustedRoot, countersignRoot: this.options.countersignRoot ?? null, ...(this.options.requireCountersign !== undefined ? { requireCountersign: this.options.requireCountersign } : {}) };
    const previous = this.syncing ?? Promise.resolve();
    let outcome!: HydrateOutcome;
    const pass = previous.catch(() => undefined).then(async () => { outcome = await this.takeDatastore(now, verifyOptions); });
    const guarded: Promise<void> = pass.finally(() => { if (this.syncing === guarded) this.syncing = null; });
    this.syncing = guarded;
    await guarded;
    return outcome;
  }

  private datastoreKey(): ReleaseKey {
    return { organizationId: this.options.organizationId, agentId: this.options.agentId, target: this.options.target, region: this.options.datastore?.region ?? null };
  }

  /**
   * T40: one read of the datastore and what it asks of this host. Without a rollback in force the newest row is an
   * update like any `applyBundle` (never below the held generation: a stale replica or a restored backup cannot move a
   * host backwards) — and a local hold the datastore no longer asks for is released first, so the fleet's newest row
   * is not held back by a rollback that was cleared. With one in force the row it names is served: below what the host
   * holds it is a forced downgrade (verified through the whole chain, stamped on evidence, `forced_downgrade` in the
   * spool), and every generation up to the rollback's `heldBackBelow` is held back until the fleet moves past it.
   */
  private async takeDatastore(now: string, verifyOptions: { now: string; root: RootMetadata; countersignRoot: RootMetadata | null; requireCountersign?: boolean }): Promise<HydrateOutcome> {
    const datastore = this.options.datastore!;
    const store = this.store!;
    const key = this.datastoreKey();
    const record = (plan: HydrationPlan | null, outcome: HydrateOutcome): HydrateOutcome => {
      this.datastoreStatus = {
        region: key.region,
        lastHydrateAt: now,
        lastOutcome: outcome.outcome,
        newestGeneration: plan?.newest ?? this.datastoreStatus?.newestGeneration ?? 0,
        rowsFrom: plan ? plan.rowsFrom : (this.datastoreStatus?.rowsFrom ?? null),
        rollback: plan ? (plan.control ? { generation: plan.control.generation, heldBackBelow: plan.control.heldBackBelow, scope: plan.control.scope, setAt: plan.control.setAt, ...(plan.control.reason ? { reason: plan.control.reason } : {}) } : null) : (this.datastoreStatus?.rollback ?? null),
      };
      return outcome;
    };
    let plan: HydrationPlan;
    try {
      plan = await resolveHydration(datastore.store, key);
    } catch (error) {
      const detail = String((error as Error).message ?? error).slice(0, 240);
      this.log({ event: "datastore_unavailable", region: key.region, reason: detail });
      return record(null, { outcome: "unavailable", generation: null, detail });
    }
    if (plan.missingRollbackGeneration !== undefined) this.log({ event: "datastore_rollback_missing", region: key.region, generation: plan.missingRollbackGeneration, message: `the datastore's rollback names generation ${plan.missingRollbackGeneration}, which it does not hold; serving the newest row` });
    if (!plan.row) return record(plan, { outcome: "empty", generation: null });
    let contents: ReturnType<typeof openBundle>;
    try {
      contents = openBundle(JSON.parse(plan.row.bundle) as Bundle, { agentId: this.options.agentId, target: this.options.target }, this.options.distributionKey ?? this.options.vendoredBundle?.distributionKey);
    } catch (error) {
      this.log({ event: "datastore_row_unusable", region: key.region, generation: plan.row.generation, reason: (error as Error).message });
      return record(plan, { outcome: "refused", generation: plan.row.generation, reason: "unusable", detail: (error as Error).message });
    }
    const control = plan.control;
    if (!control) {
      const heldBackBelow = store.state.heldBackBelow;
      if (heldBackBelow !== undefined && contents.manifest.payload.generation > store.state.generation) {
        store.releaseHold();
        this.log({ event: "datastore_hold_released", heldBackBelow, generation: contents.manifest.payload.generation });
      }
      return record(plan, await this.takeBundle(contents, "datastore", now, verifyOptions));
    }
    const generation = contents.manifest.payload.generation;
    const held = Math.max(store.state.generation, this.stagedManifest?.payload.generation ?? 0);
    let outcome: HydrateOutcome;
    if (this.active?.generation === generation) outcome = { outcome: "unchanged", generation };
    else if (this.active && generation < held) outcome = await this.takeRollback(contents, control.heldBackBelow, now, verifyOptions);
    else {
      // Up to (or, with nothing active, onto) the rollback's generation: an update like any other, past a hold the
      // datastore's own rollback set — which is set again below either way.
      store.releaseHold();
      outcome = await this.takeBundle(contents, "datastore", now, verifyOptions);
    }
    store.holdBack(control.heldBackBelow);
    return record(plan, outcome);
  }

  /** T40: the datastore's rollback below what the host holds — the whole chain, then a forced step down and a hold. */
  private async takeRollback(contents: ReturnType<typeof openBundle>, heldBackBelow: number, now: string, verifyOptions: { now: string; root: RootMetadata; countersignRoot: RootMetadata | null; requireCountersign?: boolean }): Promise<HydrateOutcome> {
    const store = this.store!;
    const generation = contents.manifest.payload.generation;
    if (instant(contents.notAfter) < instant(now)) {
      this.log({ event: "datastore_rollback_refused", reason: "expired", generation, notAfter: contents.notAfter });
      return { outcome: "refused", generation, reason: "expired" };
    }
    try {
      const rootVerdict = verifyRootMetadata({ candidate: contents.keySet, trusted: this.trustedRoot, now });
      if (rootVerdict.ok) {
        this.trustedRoot = contents.keySet;
        store.acceptRoot(contents.keySet);
      }
      const payloads = bundlePayloadBytes(contents);
      // An older release is still a SIGNED release for this scope: everything but the counter is checked.
      const verdict = verifyManifest({ manifest: contents.manifest, root: this.trustedRoot, now, scope: { organizationId: this.options.organizationId, agentId: this.options.agentId, target: this.options.target }, storedGeneration: 0, payloads, countersignRoot: this.options.countersignRoot ?? null, ...(this.options.requireCountersign !== undefined ? { requireCountersign: this.options.requireCountersign } : {}) });
      if (!verdict.ok) {
        this.log({ event: "datastore_rollback_refused", reason: verdict.reason, generation });
        this.lastRefusal = verdict.reason;
        return { outcome: "refused", generation, reason: verdict.reason };
      }
      const missing = requiredModelsMissing(contents.manifest.payload, this.declaredModels());
      if (missing.length > 0) {
        this.log({ event: "datastore_rollback_refused", reason: "model_unavailable", generation, models: missing });
        return { outcome: "refused", generation, reason: "model_unavailable", detail: missing.join(", ") };
      }
      // The inactive slot is overwritten: a staged release there is not approved for this host any more.
      if (store.state.staged) store.discardStaged();
      this.stagedManifest = null;
      store.stage({ manifest: contents.manifest, payloads, force: true });
      const slot = store.activate();
      store.holdBack(heldBackBelow);
      this.active = store.load(slot, { ...verifyOptions, root: this.trustedRoot });
      this.source = "store";
      this.lastRefusal = null;
      this.spool.refusal({ at: now, reason: "forced_downgrade", generation, tag: null }, this.nowMs());
      this.log({ event: "datastore_rolled_back", generation, heldBackBelow });
      this.emitChange();
      return { outcome: "rolled_back", generation, heldBackBelow };
    } catch (error) {
      this.log({ event: "datastore_rollback_unusable", reason: (error as Error).message, generation });
      return { outcome: "refused", generation, reason: "unusable", detail: (error as Error).message };
    }
  }

  /** S6: once a minute, the windows of the minute that passed are written and the open segment closed — off the request path, never the current minute. */
  private startSpoolTimer(): void {
    if (this.spoolTimer || (this.options.sync?.mode ?? "resident") === "on_invoke") return;
    this.spoolTimer = setInterval(() => {
      this.spool.closeStaleWindows(this.nowMs());
      void this.checkTelemetryDaemon();
    }, 60_000);
    this.spoolTimer.unref?.();
  }

  /**
   * `protocol/daemon.md`, once a minute and at boot: where to write (an explicit folder never moves; a discovered one
   * follows the daemon's `daemon.json`) and who uploads — a live daemon naming this folder does, and this process's own
   * uploader stops; when the daemon goes (its file stale or gone) the uploader starts again. Never throws.
   */
  async checkTelemetryDaemon(): Promise<TelemetryPlacement> {
    if (this.placing) await this.placing;
    else {
      this.placing = this.placeTelemetry().finally(() => {
        this.placing = null;
      });
      await this.placing;
    }
    return this.telemetryPlacement();
  }

  private async placeTelemetry(): Promise<void> {
    try {
      const sink = this.directorySink;
      if (!sink || !this.store || this.stopped) return;
      const placement = spoolPlacement(this.options, this.store.dir, this.nowMs());
      this.discovery = placement.discovery;
      const moved = placement.dir !== this.spoolDir;
      if (moved) {
        // The daemon published another folder (or went away and the store's is back): new segments go there.
        sink.moveTo(placement.dir, this.nowMs());
        this.log({ event: "spool_moved", from: this.spoolDir, to: placement.dir, source: placement.from });
        this.spoolDir = placement.dir;
      }
      this.spoolDirFrom = placement.from;
      // An uploader sweeps the folder it was started on: a move stops it, and a new one starts below if it is still ours.
      const daemonShips = this.daemonShipsSpool();
      if (this.uploader && (moved || daemonShips)) await this.stopUploader(daemonShips ? "upload_handed_to_daemon" : "uploader_restarted");
      if (daemonShips) {
        // The daemon ships this folder; nothing more to do here.
      } else if ((this.options.sync?.mode ?? "resident") === "resident" && !this.uploader) {
        this.startUploader();
        if (this.uploader && this.discovery?.discovery) this.log({ event: "upload_taken_back", reason: this.discovery.live ? "daemon_ships_another_folder" : this.discovery.reason });
      }
    } catch (error) {
      this.log({ event: "telemetry_placement_failed", reason: (error as Error).message });
    }
  }

  /** A live daemon for this agent and target that ships somewhere (`sink` is not `none`) names the folder this process writes (the same path, symlinks resolved). */
  private daemonShipsSpool(): boolean {
    const found = this.discovery;
    return !!found && found.live && found.discovery.sink !== "none" && samePath(found.discovery.spoolDir, this.spoolDir);
  }

  private async stopUploader(event: string): Promise<void> {
    const uploader = this.uploader;
    this.uploader = null;
    this.spoolReporter = null;
    if (uploader) await uploader.stop();
    this.log({ event });
  }

  private telemetryPlacement(): TelemetryPlacement {
    const found = this.discovery?.discovery ?? null;
    const daemon = found && (this.discovery!.live || this.discovery!.reason === "stale") ? { live: this.discovery!.live, pid: found.pid, version: found.daemon?.version ?? "", heartbeatAt: found.heartbeatAt, spoolDir: found.spoolDir } : null;
    if (!this.directorySink) return { sink: "memory", spoolDir: null, spoolDirFrom: null, uploadedBy: "none", daemon };
    return { sink: "directory", spoolDir: this.spoolDir, spoolDirFrom: this.spoolDirFrom, uploadedBy: this.uploader ? "self" : this.daemonShipsSpool() ? "daemon" : "none", daemon };
  }

  /** What each closed segment's manifest carries: this writer's scope and its heartbeat report as it stands. */
  private manifestContext(): { organizationId: string; agentId: string; target: string; report: Record<string, unknown> } {
    return { organizationId: this.options.organizationId, agentId: this.options.agentId, target: this.options.target, report: this.heartbeatBody() };
  }

  /**
   * S5: the telemetry daemon is an optimisation, never a requirement — a resident host with no live daemon uploads its own spool. The
   * same uploader the daemon runs, in-process, on a timer off the request path: closed segments go out under this
   * runtime's own grant (its heartbeat's), a failed pass backs off and the next one retries, and past the budget the
   * oldest unsent segments are dropped and counted (`dropped` rows, the heartbeat's `spool.droppedSegments`). Nothing
   * here ever blocks a render.
   */
  private startUploader(): void {
    // S13: a sink of the customer's own (the OpenTelemetry bridge) needs no client and no grant: it runs offline too.
    const customSink = this.options.telemetry?.uploadSink;
    if (this.uploader || (!customSink && !this.client) || !this.store || this.stopped) return;
    if (this.options.telemetry?.upload === false) return;
    // A memory sink has no directory to sweep; `flushTelemetry()` is its path.
    if (!this.directorySink) return;
    const uploader = new SpoolUploader({
      dir: this.spoolDir,
      instanceId: this.ownInstanceId,
      // A shared folder: another agent's or target's segments are left for its own uploader.
      scope: { agentId: this.options.agentId, target: this.options.target },
      ...(customSink
        ? { sink: customSink }
        : {
            grantFor: (instanceId: string, report?: Record<string, unknown>) => this.requestUploadGrant({ instanceId, instanceClass: this.options.telemetry?.instanceClass ?? "resident", ...(report ? { report } : {}) }),
            fetch: this.options.fetch ?? (globalThis.fetch as unknown as FetchLike),
          }),
      now: () => this.nowMs(),
      ...(this.options.fs ? { fs: this.options.fs } : {}),
      ...(this.options.random ? { random: this.options.random } : {}),
      logger: (event) => this.log(event),
      intervalSeconds: this.uploadIntervalSeconds,
      ...(this.options.telemetry?.spoolBudgetBytes !== undefined ? { budgetBytes: this.options.telemetry.spoolBudgetBytes } : {}),
    });
    this.uploader = uploader;
    this.spoolReporter = () => {
      const s = uploader.status();
      return { droppedSegments: s.droppedSegments, quarantinedSegments: s.quarantinedSegments, lastUploadAt: s.lastUploadAt, backoffUntil: s.backoffUntil };
    };
    uploader.start();
    this.log({ event: "uploader_started", intervalSeconds: this.uploadIntervalSeconds, sink: uploader.status().sink });
  }

  /** S5: one upload pass now (tests and operators); `null` when this process runs no uploader. Never throws. */
  async uploadNow(): Promise<{ uploaded: number; quarantined: number; dropped: number; held: boolean } | null> {
    if (!this.uploader) return null;
    const result = await this.uploader.runOnce();
    return { uploaded: result.uploaded.length, quarantined: result.quarantined.length, dropped: result.dropped, held: result.held };
  }

  /** S3: contact with the origin — a signed manifest or an authenticated answer. Renews the lease and tells `onContact` listeners. */
  private markContact(): void {
    this.lastContactMs = this.nowMs();
    const contact = { expiresAt: this.leaseExpiresAt(), lastContactAt: new Date(this.lastContactMs).toISOString() };
    for (const listener of this.contactListeners) listener(contact);
  }

  /** S3: the heartbeat names the origin's generation; a pointer that shows less is behind, and the next pass skips it. */
  private takeLatestGeneration(response: { latestGeneration?: unknown }): void {
    const latest = response.latestGeneration;
    if (typeof latest !== "number" || !Number.isInteger(latest) || latest < 0) return;
    const seen = Math.max(this.active?.generation ?? 0, this.stagedManifest?.payload.generation ?? 0, this.store?.state.generation ?? 0);
    if (latest > seen && !this.pointerBehind) {
      this.pointerBehind = true;
      this.log({ event: "pointer_behind", latestGeneration: latest, seen });
      // Go now: the origin has something the pointer has not shown (a freeze, a dial-down, a release).
      void this.syncNow();
    }
  }

  /** S3: told at every contact with the origin, with the lease it renewed. */
  onContact(listener: (contact: { expiresAt: string | null; lastContactAt: string }) => void): () => void {
    this.contactListeners.add(listener);
    return () => void this.contactListeners.delete(listener);
  }

  /** Called whenever the active or staged generation changes (sync, unlock, rollback, applyBundle, hydrate). */
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
   * The policy is the host's (S4): the pin in store.json, tightened by a manifest and never loosened by one, with this
   * process's own `apply.policy` on top. The manifest's value only ever sets the pin on first use or tightens it.
   */
  private async applyPolicy(manifest: Manifest): Promise<ApplyPolicyDecision> {
    this.takeApplyPolicy(manifest.payload);
    const policy = this.effectiveApplyPolicy().effective;
    // T34: verified before activate — a staged release's golden sets run first; below the floor it stays staged.
    if (this.options.golden && manifestHasGolden(manifest)) {
      const reports = await this.runGoldenFor(manifest, this.store!.state.staged ? this.store!.load(this.store!.state.staged, { now: this.nowIso(), root: this.trustedRoot, countersignRoot: this.options.countersignRoot ?? null }).payloads : new Map(), this.options.golden.invoke, this.options.golden.concurrency);
      if (!goldenReportsMeet(reports)) {
        this.stagedManifest = manifest;
        for (const report of reports.filter((r) => !r.meetsThreshold)) this.log({ event: "golden_set_failed", generation: manifest.payload.generation, tag: report.tag, arm: report.arm, passed: report.passed, cases: report.cases, minPassBps: report.minPassBps });
        return "staged";
      }
    }
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
    if (!this.client || !this.store) return;
    // One pass over the store at a time. A pass already in flight — a sync, or an `applyBundle` — is the answer: this
    // call resolves when it ends and runs no sync of its own (the resident timer's next tick catches up).
    if (this.syncing) return this.syncing;
    const pass = (async () => {
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
        skipPointer: this.pointerBehind,
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
        onDirectives: (payload) => {
          this.takeApplyPolicy(payload);
          this.takeDirectives(payload);
        },
      });
      this.etag = result.etag;
      this.edgeEtag = result.edgeEtag;
      this.trustedRoot = result.trustedRoot;
      this.lastSyncMs = this.nowMs();
      this.lastSyncOutcome = result.outcome;
      this.lastSyncDetail = { reason: result.reason ?? null, detail: result.detail ?? null };
      // S3: contact is a signed manifest or the origin's authenticated answer — never the pointer's silence.
      const contact = result.outcome === "unchanged" || result.outcome === "activated" || result.outcome === "activated_externally" || result.outcome === "staged" || result.outcome === "nothing_promoted" || result.outcome === "held_back";
      if (contact) this.markContact();
      // The pass went to the origin (any outcome but the pointer's silence): the pointer is trusted again from here.
      if (result.outcome !== "pointer_unchanged" && result.outcome !== "unavailable") this.pointerBehind = false;
      this.consecutiveSyncFailures = contact || result.outcome === "pointer_unchanged" ? 0 : this.consecutiveSyncFailures + 1;
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
    })();
    // Cleared only by the pass that set it: an `applyBundle` chained behind this sync replaces the guard with its own
    // promise, and this sync's end must not drop it while the apply is still over the store.
    const guarded: Promise<void> = pass.finally(() => { if (this.syncing === guarded) this.syncing = null; });
    this.syncing = guarded;
    return guarded;
  }

  /**
   * S4: the apply policy is the customer's. The first verified manifest pins the host's policy (trust-on-first-use);
   * a later manifest may tighten the pin (`auto` → `unlock_required`) and never loosen it — a manifest that says
   * `auto` against a pinned `unlock_required` is advisory, logged once per generation, and reported on the heartbeat
   * so the fleet view says "pinned on the host". Called for every manifest whose envelope verified, before the
   * pass decides anything.
   */
  private takeApplyPolicy(payload: Manifest["payload"]): void {
    const store = this.store;
    if (!store) return;
    if (!this.manifestApplyPolicy || payload.generation >= this.manifestApplyPolicy.generation) this.manifestApplyPolicy = { generation: payload.generation, value: payload.applyPolicy };
    const pin = store.state.applyPolicyPin;
    if (!pin) {
      store.pinApplyPolicy({ value: payload.applyPolicy, source: "manifest", generation: payload.generation, setAt: this.nowIso() });
      this.log({ event: "apply_policy_pinned", policy: payload.applyPolicy, generation: payload.generation });
      return;
    }
    if (payload.applyPolicy === "unlock_required" && pin.value === "auto") {
      store.pinApplyPolicy({ value: "unlock_required", source: "manifest", generation: payload.generation, setAt: this.nowIso() });
      this.log({ event: "apply_policy_tightened", from: pin.value, to: "unlock_required", generation: payload.generation, previousSource: pin.source });
      return;
    }
    if (payload.applyPolicy === "auto" && pin.value === "unlock_required" && this.applyPolicyAdvisoryLogged < payload.generation) {
      this.applyPolicyAdvisoryLogged = payload.generation;
      this.log({ event: "apply_policy_manifest_advisory", manifestSaid: "auto", pinned: "unlock_required", pinnedBy: pin.source, generation: payload.generation });
    }
  }

  /** S4: the policy in force on this host and where it comes from (see `AgentStatus.applyPolicy`). */
  private effectiveApplyPolicy(): AgentStatus["applyPolicy"] {
    const local = this.options.apply?.policy;
    const pin = this.store?.state.applyPolicyPin ?? null;
    const manifestSaid = this.manifestApplyPolicy?.value ?? null;
    if (local === "unlock_required") return { effective: "unlock_required", source: "local", manifestSaid };
    if (pin) return { effective: pin.value, source: pin.source === "operator" ? "operator" : "pinned", manifestSaid };
    // Nothing verified yet: the manifest that arrives will pin; until then the local value (or `auto`) is what a start would apply.
    return { effective: local ?? manifestSaid ?? "auto", source: local ? "local" : "manifest", manifestSaid };
  }

  /**
   * S4: an operator's act on this host — the one way a pinned policy loosens. `unlock_required` tightens the pin by
   * hand; `auto` loosens it, and a later manifest that says `unlock_required` tightens it again (a manifest may always
   * tighten). Logged, and host-wide through the store (every process sharing it reads the pin). Never called by sync.
   */
  async setApplyPolicy(value: ApplyPolicy, input: { by?: string } = {}): Promise<AgentStatus["applyPolicy"]> {
    const store = this.store;
    if (!store) throw new AgentStartError("no_verified_release", "no store to record the policy in");
    const before = store.state.applyPolicyPin ?? null;
    store.pinApplyPolicy({ value, source: "operator", generation: this.manifestApplyPolicy?.generation ?? 0, setAt: this.nowIso() });
    this.log({ event: "apply_policy_set", policy: value, previous: before?.value ?? null, previousSource: before?.source ?? null, ...(input.by ? { by: input.by } : {}) });
    // A loosened policy with something already staged: the staged release waits for its own unlock; nothing activates here.
    return this.effectiveApplyPolicy();
  }

  /** T9: a verified manifest's directives stand from the moment its envelope verifies; a Freeze is honoured before anything else. */
  private takeDirectives(payload: Manifest["payload"]): void {
    if (this.standingDirectives && this.standingDirectives.generation > payload.generation) return;
    const before = this.disabledNow();
    this.standingDirectives = { generation: payload.generation, directives: [...payload.directives] };
    const after = this.disabledNow();
    if (before.agent !== after.agent || before.slots.join(",") !== after.slots.join(",") || before.arms.join(",") !== after.arms.join(",")) this.log({ event: after.agent || after.slots.length || after.arms.length ? "disabled_by_directive" : "disable_lifted", generation: payload.generation, ...after });
    const requests = this.openUnlockRequests(payload);
    if (requests.length) this.log({ event: "unlock_requested", generation: payload.generation, requests: requests.map((r) => ({ releaseDigest: r.releaseDigest, expiresAt: r.expiresAt, requestedBy: r.requestedBy })) });
  }

  /** What is disabled right now: the standing directives when they are as new as the active manifest, else the active manifest's own. */
  private disabledNow(): { agent: boolean; slots: string[]; arms: string[] } {
    // The public shape (status, heartbeat) is agent / slots / arms; the per-experiment detail stays in the resolver.
    const detail = !this.active ? (this.standingDirectives ? disabledFrom(this.standingDirectives.directives) : null) : this.resolver().disabled();
    if (!detail) return { agent: false, slots: [], arms: [] };
    return { agent: detail.agent, slots: detail.slots, arms: [...detail.arms, ...Object.values(detail.armsByExperiment).flat()] };
  }

  /** S10: the runtime over the active release — resolution, the ramp walk and rendering live in `@airprompter/agent-runtime`. */
  private resolver(): ReleaseResolver {
    const release = this.active;
    if (!release) throw new AgentStartError("no_verified_release", this.stagedManifest ? `no active release: generation ${this.stagedManifest.payload.generation} is staged under unlock_required and waiting for an unlock` : "no active release");
    if (this.resolverFor?.release === release && this.resolverFor.standing === this.standingDirectives) return this.resolverFor.resolver;
    const resolver = new ReleaseResolver({
      release,
      runRefKey: this.runRefKey,
      agentId: this.options.agentId,
      target: this.options.target,
      instanceId: this.ownInstanceId,
      nowMs: () => this.nowMs(),
      tags: () => this.audienceTags,
      ...(this.options.delimiters ? { delimiters: this.options.delimiters } : {}),
      standingDirectives: this.standingDirectives,
    });
    this.resolverFor = { release, standing: this.standingDirectives, resolver };
    return resolver;
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
  /**
   * Why the boot sync brought nothing, in the control plane's own terms — the sentence a customer reads first, so it
   * names the fix: a 404 is "nothing promoted to this environment" (or a key bound elsewhere), a 401 is the key, a 403
   * carries the server's code, and a transport failure carries its message.
   */
  private describeFetchFailure(): string {
    const scope = `${this.options.agentId} on ${this.options.target}`;
    const { reason, detail } = this.lastSyncDetail;
    if (!this.client) return "no control plane is configured (no apiKey/baseUrl), so nothing could be fetched";
    switch (this.lastSyncOutcome) {
      case "nothing_promoted":
        return `the control plane has no release promoted to ${this.options.target} for ${scope} (HTTP 404) — promote one from the app's board, or check that this key is bound to this app and environment`;
      case "refused":
        return `the manifest for ${scope} was fetched but refused: ${reason ?? "unknown"}`;
      case "unavailable":
        if (reason === "unauthorized") return `the control plane refused this key for ${scope} (HTTP 401) — the key is wrong, revoked, or minted for another environment`;
        if (reason === "forbidden") return `the control plane forbade the read for ${scope} (HTTP 403${detail ? ` ${detail}` : ""})`;
        if (reason === "network") return `the control plane at ${this.options.baseUrl ?? "the configured baseUrl"} could not be reached${detail ? `: ${detail}` : ""}`;
        return `the control plane answered ${reason ?? "an error"} for ${scope}`;
      case null:
        return "nothing could be fetched";
      default:
        return `the sync ended ${this.lastSyncOutcome} for ${scope} without a release`;
    }
  }

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
      ...((this.audienceServerSupported || (this.active?.manifest.payload.protocol === AUDIENCE_PROTOCOL_VERSION && this.active.manifest.payload.requiredCapabilities?.includes(AUDIENCE_CAPABILITY))) ? {
        capabilities: [AUDIENCE_CAPABILITY],
        registration: {tagKeys: [...this.audienceTagKeys].sort(), prompts: [...this.audiencePromptLabels].sort(([a],[b])=>a.localeCompare(b)).map(([tag,displayName])=>({tag,displayName}))},
      } : {}),
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
      storageProtection: status.storageProtection,
      // 0.3.4: the variable names this application can fill from its own sources — names, never values — so the seal
      // can warn about a `source: runtime` variable no live instance fills before the promotion, not after. Sent only
      // once the control plane has shown it speaks 0.3.4 (the active manifest's protocol): an older service refuses
      // the whole heartbeat over an unknown key, and a refused heartbeat is worse than an unreported name. Past that
      // gate the key is always sent — an empty list says "I fill nothing", which is a report; absence says nothing.
      catalog: { models: [...new Set(models)].slice(0, 256), ...(protocolAtLeast(this.active?.manifest.payload.protocol ?? "0.0.0", "0.3.4") ? { variables: this.variables.names().slice(0, 256) } : {}), reportedAt: this.nowIso() },
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
      disabled: { agent: status.disabled.agent, slots: status.disabled.slots, ...(status.disabled.arms.length ? { arms: status.disabled.arms } : {}) },
      // S4: what this host runs under, so the fleet view can say "pinned on the host" when the console's setting is advisory here.
      applyPolicy: { effective: status.applyPolicy.effective, source: status.applyPolicy.source },
    };
  }

  /** One heartbeat now (resident timers call this; on_invoke hosts send one when the interval has elapsed). Never throws. */
  async heartbeatNow(): Promise<void> {
    if (!this.client) return;
    if (this.heartbeating) return this.heartbeating;
    this.heartbeating = (async () => {
      try {
        const result = await this.client!.heartbeat(this.heartbeatBody());
        if (result.status === "ok") {
          this.lastHeartbeatMs = this.nowMs();
          this.lastHeartbeatRefusal = null;
          this.markContact();
          this.takeLatestGeneration(result.response);
          const interval = Number(result.response.heartbeatIntervalSeconds);
          if (Number.isFinite(interval) && interval >= 30 && interval <= 3600) this.heartbeatIntervalSeconds = interval;
          this.takeGrant(result.response);
          this.log({ event: "heartbeat", intervalSeconds: this.heartbeatIntervalSeconds, expiresAt: result.response.expiresAt ?? null, grant: this.uploadGrant ? this.uploadGrant.grantId : null });
        } else if (result.status === "refused") {
          this.lastHeartbeatRefusal = result.code ?? `http_${result.httpStatus}`;
          this.log({ event: "heartbeat_refused", httpStatus: result.httpStatus, code: result.code, ...(result.message ? { message: result.message } : {}), ...(result.issues.length ? { issues: result.issues } : {}) });
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
    if (this.stopped || !this.client) return;
    const delay = jitteredDelayMs(this.heartbeatIntervalSeconds, this.options.random);
    this.nextHeartbeatMs = this.nowMs() + delay;
    this.heartbeatTimer = setTimeout(() => {
      void this.heartbeatNow().finally(() => this.scheduleHeartbeat());
    }, delay);
    this.heartbeatTimer.unref?.();
  }

  /** T26: the heartbeat's answer carries the grant (or a hold) and the upload cadence. */
  private takeGrant(response: Record<string, unknown>): void {
    this.audienceServerSupported = response.protocol === AUDIENCE_PROTOCOL_VERSION && Array.isArray(response.capabilities) && response.capabilities.includes(AUDIENCE_CAPABILITY);
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

  /** T26: an uploader other than this process's own tells the heartbeat what it knows about the spool (drops, quarantine, last upload, backoff). */
  setSpoolReporter(reporter: (() => SpoolReport) | null): void {
    this.spoolReporter = reporter;
  }

  /**
   * T26: an upload grant for one writer's prefix — a heartbeat carrying that writer's instance id (this runtime's own
   * by default). The uploader asks once per writer whose segments sit in this folder (a sibling that exited, a
   * reclaimed segment); `report` is that writer's own heartbeat report from its manifest, sent with this process's
   * `spool` block. The answer is cached by the uploader until a minute before it lapses. Never throws.
   */
  async requestUploadGrant(input: { instanceId?: string; instanceClass?: "resident" | "ephemeral"; report?: Record<string, unknown> } = {}): Promise<GrantDecision> {
    if (!this.client) return { kind: "unavailable", reason: "offline" };
    const own = input.instanceId === undefined || input.instanceId === this.ownInstanceId;
    if (own) {
      await this.heartbeatNow();
      if (this.uploadGrant) return { kind: "grant", grant: this.uploadGrant, uploadIntervalSeconds: this.uploadIntervalSeconds };
      if (this.uploadRetryAfterMs !== null) return { kind: "hold", retryAfterSeconds: Math.max(1, Math.ceil((this.uploadRetryAfterMs - this.nowMs()) / 1000)), reason: "retry_after" };
      return { kind: "unavailable", reason: this.lastHeartbeatRefusal ?? "heartbeat_failed" };
    }
    try {
      const own = this.heartbeatBody();
      const body = input.report ? { ...input.report, instanceId: input.instanceId, spool: own.spool } : { ...own, instanceId: input.instanceId, ...(input.instanceClass ? { instanceClass: input.instanceClass } : {}) };
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
    // Capability, not class: a buffered sink is one that can hand its rows back (another copy of this package counts too).
    if (typeof this.sink.drain !== "function") return { status: "nothing" };
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

  /**
   * on_invoke mode: run the handler between two sync passes (the trailing one is not awaited on the response path).
   * S5: the invocation's rows are flushed before `invoke()` returns — a platform that freezes the process at the
   * response (Lambda) would otherwise lose them with no `dropped` row possible. `telemetry.flush: "background"` is the
   * documented opt-out for hosts that keep running after the response.
   */
  async invoke<T>(handler: () => Promise<T>): Promise<T> {
    await this.syncNow();
    if (this.lastHeartbeatMs === null || this.nowMs() - this.lastHeartbeatMs >= this.heartbeatIntervalSeconds * 1000) void this.heartbeatNow();
    try {
      return await handler();
    } finally {
      this.spool.closeWindows(this.nowMs());
      void this.syncNow();
      // D25 on serverless: the invocation's rows go out under the runtime's own grant; a failure keeps them for the next one.
      if (this.client && typeof this.sink.drain === "function") {
        if (this.options.telemetry?.flush === "background") void this.flushTelemetry();
        else await this.flushTelemetry();
      }
    }
  }

  /** Make a staged release live (an operator's `airprompter unlock`, an update window, or the change-control hook). */
  async unlock(): Promise<{ generation: number } | null> {
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

  /**
   * Instant local rollback to the other slot. Forced when it goes below the stored generation; stamped on evidence.
   * Throws `StoreError` `release_staged` while a release is staged (a rollback is never a quiet unlock) and
   * `no_previous_release` when this host has held one release only.
   */
  async rollback(): Promise<{ generation: number; forced: boolean }> {
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

  private leaseExpiresAt(): string | null {
    const manifest = this.active?.manifest.payload;
    if (!manifest) return null;
    if (this.lastContactMs !== null) return new Date(this.lastContactMs + manifest.leaseSeconds * 1000).toISOString();
    if (this.bundleNotAfter && this.source === "vendored_bundle") return new Date(instant(this.bundleNotAfter)).toISOString();
    return new Date(instant(manifest.issuedAt) + manifest.leaseSeconds * 1000).toISOString();
  }

  /** The lease: the facade's rule (it knows the origin); the runtime knows nothing of contact. */
  private guardLease(tag: string): void {
    const active = this.active!;
    const payload = active.manifest.payload;
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

  /** S10: the runtime resolves; the facade turns a refusal into the spool row and the thrown error, and guards the lease. */
  private resolveSlot(tag: string, subject: string | undefined, tags?: Readonly<Record<string,string>>): { slot: ManifestSlot; arm: string; bucket: number | null; audienceIds?: readonly string[]; runMinute?: string } {
    const resolver = this.resolver();
    const active = this.active!;
    const outcome = resolver.resolve(tag, subject, tags);
    if (!outcome.ok) {
      if (outcome.reason === "no_slot") throw new Error(`no slot ${tag} on generation ${active.generation}`);
      this.stampRefusal("disabled", active.generation, outcome.tag);
      throw new RenderRefusedError("disabled", tag, active.generation);
    }
    this.guardLease(tag);
    return { slot: outcome.slot, arm: outcome.arm, bucket: outcome.bucket, ...(outcome.audienceIds ? {audienceIds: outcome.audienceIds, runMinute: outcome.runMinute} : {}) };
  }

  /** Replace process tags locally. Registration remembers key names, never their values. */
  setTags(tags: Readonly<Record<string,string>>): void {
    const copied = copyAudienceTags(tags);
    const keys = new Set([...this.audienceTagKeys,...Object.keys(copied)]);
    if (keys.size > 64) throw new Error("audience_tag_names_limit");
    keys.forEach(key=>this.audienceTagKeys.add(key));
    this.audienceTags = copied;
  }

  private registerPromptLabel(tag: string, label: string): void {
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(tag) || tag.length > 128 || !validAudienceLabel(label)) throw new Error("prompt_label_invalid");
    if (!this.audiencePromptLabels.has(tag) && this.audiencePromptLabels.size >= 32) throw new Error("prompt_labels_limit");
    this.audiencePromptLabels.set(tag,label);
  }

  prompt(tag: string, options: { subject?: string; tags?: Readonly<Record<string,string>>; displayName?: string } = {}) {
    this.registerPromptLabel(tag, options.displayName ?? this.audiencePromptLabels.get(tag) ?? tag);
    // Snapshot caller-owned selectors now; process tags from setTags() remain live per render.
    const tagOverride = options.tags ? copyAudienceTags(options.tags) : undefined;

    // Every path captures the resolver and the resolved slot FIRST: a release that activates while a source is being
    // awaited must not mix generation N+1's text with generation N's run reference. The payload is decoded once here
    // and handed to the resolver's render.
    const prepare = (values: RenderValues) => {
      const resolver = this.resolver();
      const localTags = tagOverride ? copyAudienceTags({...this.audienceTags,...tagOverride}) : this.audienceTags;
      const keys = new Set([...this.audienceTagKeys,...Object.keys(localTags)]);
      if (keys.size > 64) throw new Error("audience_tag_names_limit");
      keys.forEach(key=>this.audienceTagKeys.add(key));
      const resolved = this.resolveSlot(tag, options.subject, localTags);
      const text = resolver.textOf(resolved.slot);
      const plan = planFill({ tag, variables: resolved.slot.variables, text, values, registry: this.variables });
      return { resolver, resolved, text, plan };
    };
    const finish = (prepared: ReturnType<typeof prepare>, filled: FilledRender): Rendered => {
      const rendered = this.renderObserved(() => prepared.resolver.render(prepared.resolved, filled.values, { fenced: filled.fenced, text: prepared.text }), { tag, versionId: prepared.resolved.slot.versionId, arm: prepared.resolved.arm, model: prepared.resolved.slot.model });
      this.renders.register(rendered.text, { ...(rendered.audienceIds ? {audienceIds: rendered.audienceIds,runMinute: rendered.runMinute} : {}), tag, versionId: rendered.versionId, arm: rendered.arm, model: rendered.model, ...(rendered.inference ? { inference: rendered.inference } : {}) });
      this.sayStricter(tag, prepared.resolved.slot, filled);
      return rendered;
    };
    /** Synchronous: the call site's values and literal sources. A callable source in the way is `VariableSourceRequiredError`. */
    const render = (values: RenderValues = {}): Rendered => {
      const prepared = prepare(values);
      return finish(prepared, fillSync(prepared.plan, this.variables));
    };
    /** The same render, with callable sources awaited (each under its own timeout), values fenced by the stricter trust. */
    const renderAsync = async (values: RenderValues = {}): Promise<Rendered> => {
      const prepared = prepare(values);
      const filled = await this.fillObserved(prepared.plan, { tag, subject: options.subject, versionId: prepared.resolved.slot.versionId, arm: prepared.resolved.arm }, { tag, versionId: prepared.resolved.slot.versionId, arm: prepared.resolved.arm, model: prepared.resolved.slot.model });
      return finish(prepared, filled);
    };
    /** The required names a render would still lack after these values and the registered sources — check it at start-up. */
    const localTags = () => tagOverride ? copyAudienceTags({...this.audienceTags,...tagOverride}) : this.audienceTags;
    const needs = (values: RenderValues = {}): string[] => unsourced({ variables: this.resolveSlot(tag, options.subject, localTags()).slot.variables, values, registry: this.variables });
    return { render, renderAsync, needs, variables: () => this.resolveSlot(tag, options.subject, localTags()).slot.variables };
  }

  /**
   * A render, observed: a `MissingVariableError` is also one content-free error row (`render_missing_variable`),
   * so the board sees a version this host cannot render. The row names the slot, never a step (a step id is not a
   * spool tag) and never a variable.
   */
  private renderObserved<T>(render: () => T, row: { tag: string; versionId: string; arm: string; model: string }): T {
    try {
      return render();
    } catch (error) {
      if (errorNamed(error, "MissingVariableError")) this.spool.observe({ ...row, status: "error", errorClass: "render_missing_variable", latencyMs: 0, usageSource: "unavailable" }, this.nowMs());
      throw error;
    }
  }

  /**
   * Sources run here. A failure is logged by name and reason only and counted as the same error row as a missing
   * variable — the window schema has no class for "a source failed" (a protocol 0.3.4 note), and to the board the
   * outcome is the same: this host could not render the version.
   */
  private async fillObserved(plan: FillPlan, context: { tag: string; subject: string | undefined; versionId: string; arm: string }, row: { tag: string; versionId: string; arm: string; model: string }): Promise<FilledRender> {
    try {
      return await fillAsync(plan, context, this.variables);
    } catch (error) {
      if (isVariableSourceError(error)) {
        this.log({ event: "variable_source_failed", tag: context.tag, name: error.variable, reason: error.reason });
        this.spool.observe({ ...row, status: "error", errorClass: "render_missing_variable", latencyMs: 0, usageSource: "unavailable" }, this.nowMs());
      }
      throw error;
    }
  }

  /**
   * A source stricter than the prompt's declaration is said once per slot and name for the life of the process —
   * bounded by declared names; a declaration that later loosens again is not said a second time, by design.
   */
  private sayStricter(tag: string, slot: ManifestSlot, filled: FilledRender): void {
    for (const entry of filled.filled) {
      if (!entry.stricter) continue;
      const key = `${tag}\u0000${entry.name}`;
      if (this.stricterSaid.has(key)) continue;
      this.stricterSaid.add(key);
      this.log({ event: "variable_source_trust_stricter", tag, name: entry.name, declared: slot.variables.find((v) => v.name === entry.name)?.trust ?? null });
    }
  }

  /** A workflow slot's steps in ordinal order, each with its prompt text. */
  workflow(tag: string, options: { subject?: string } = {}) {
    const resolved = this.resolveSlot(tag, options.subject);
    const workflow = this.resolver().workflow(resolved);
    for (const step of workflow.steps) this.renders.register(step.text, { ...(step.audienceIds ? {audienceIds: step.audienceIds,runMinute: step.runMinute} : {}), tag: step.stepId, versionId: step.versionId, arm: workflow.arm, model: workflow.model, ...(step.inference ? { inference: step.inference } : {}) });
    /**
     * A step's text with its variables filled — the workflow's declarations, the same precedence and the same
     * fencing as a prompt (the resolver renders both), each step scanned on its own: a source is called for step 3
     * and not for step 1 when only step 3 uses it. A source sees the step id as its tag; the error row, when there
     * is one, names the workflow slot.
     */
    const resolver = this.resolver();
    const row = { tag, versionId: resolved.slot.versionId, arm: workflow.arm, model: workflow.model };
    const renderStepAsync = async (stepId: string, values: RenderValues = {}): Promise<string> => {
      const step = workflow.steps.find((entry) => entry.stepId === stepId);
      if (!step) throw new Error(`no step ${stepId} on ${tag}`);
      const plan = planFill({ tag: step.stepId, variables: resolved.slot.variables, text: step.text, values, registry: this.variables });
      const filled = await this.fillObserved(plan, { tag: step.stepId, subject: options.subject, versionId: step.versionId, arm: workflow.arm }, row);
      const text = this.renderObserved(() => resolver.renderText({ tag: step.stepId, text: step.text, variables: resolved.slot.variables, values: filled.values, fenced: filled.fenced }), row);
      this.renders.register(text, { ...(step.audienceIds ? {audienceIds: step.audienceIds,runMinute: step.runMinute} : {}), tag: step.stepId, versionId: step.versionId, arm: workflow.arm, model: workflow.model, ...(step.inference ? { inference: step.inference } : {}) });
      this.sayStricter(step.stepId, resolved.slot, filled);
      return text;
    };
    return { ...workflow, renderStepAsync };
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
  async observe<T>(rendered: Pick<Rendered, "tag" | "versionId" | "arm" | "model" | "audienceIds" | "runMinute">, call: () => Promise<T> | T, options: ObserveOptions = {}): Promise<T> {
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
  checks(rendered: Pick<Rendered, "tag" | "versionId" | "arm" | "model" | "audienceIds" | "runMinute">, output: unknown, options: { outputTokens?: number | null; record?: boolean } = {}): CheckOutcome {
    const declared = this.declaredChecksFor(rendered.tag, rendered.arm);
    const text = typeof output === "string" ? output : outputTextOf(output);
    if (declared.length === 0 || text === null) return { passed: 0, failed: 0, results: [] };
    const outcome = evaluateChecks(declared, { text, outputTokens: options.outputTokens ?? null });
    if (options.record !== false && (outcome.passed > 0 || outcome.failed > 0)) {
      this.spool.checks({ tag: rendered.tag, versionId: rendered.versionId, arm: rendered.arm, model: rendered.model, ...(rendered.audienceIds !== undefined ? {audienceIds:rendered.audienceIds,runMinute:rendered.runMinute} : {}) }, { passed: outcome.passed, failed: outcome.failed }, this.nowMs());
    }
    return outcome;
  }

  /** The active manifest's checks for a slot on an arm (the arm's override when it carries one). */
  private declaredChecksFor(tag: string, arm: string): NonNullable<ManifestSlot["outputChecks"]> {
    const payload = this.active?.manifest.payload;
    if (!payload) return [];
    const override = experimentForTag(payload, tag)?.arms.find((entry) => entry.arm === arm)?.overrides.find((entry) => entry.tag === tag);
    const slot = override ?? payload.slots.find((entry) => entry.tag === tag);
    return slot?.outputChecks ?? [];
  }

  // ------------------------------------------------------------------ T33: wrapped clients

  /**
   * The OpenAI or Anthropic client, observed without a change at the call site: `chat.completions.create`,
   * `responses.create`, `messages.create` (streaming or not) and the `.stream()` helpers are timed, their usage and
   * finish reason read, the slot's checks run on the text, and one content-free observation filed — attributed to
   * the render whose text the request carries (or to an enclosing `attribute()` scope). A call that names no render
   * passes through untouched; nothing the wrapper does can fail the call. Everything else on the client is its own.
   */
  wrap<T extends object>(client: T): T {
    return wrapClient(client, this.wrapHooks());
  }

  /** Run `fn` with every wrapped call inside it (across awaits) attributed to `rendered`, whatever text it carries. */
  attribute<T>(rendered: Pick<Rendered, "tag" | "versionId" | "arm" | "model" | "inference" | "audienceIds" | "runMinute"> | (Pick<Rendered, "versionId" | "model" | "inference"> & { stepId: string; arm?: string; runRef?: string }), fn: () => T): T {
    // A workflow step attributes under its step id (`<tag>#<n>`); its arm is the one its run reference carries (the
    // workflow's), unless the caller names one.
    const tag = "stepId" in rendered ? rendered.stepId : rendered.tag;
    const arm = rendered.arm ?? ("runRef" in rendered && rendered.runRef ? parseRunRef(rendered.runRef, this.runRefKey)?.arm : undefined) ?? "none";
    const cohort = "audienceIds" in rendered ? rendered : ("runRef" in rendered && rendered.runRef ? parseRunRef(rendered.runRef, this.runRefKey) : null);
    return withAttribution({ ...(cohort?.audienceIds ? {audienceIds: cohort.audienceIds,runMinute: cohort.runMinute} : {}), tag, versionId: rendered.versionId, arm, model: rendered.model, ...(rendered.inference ? { inference: rendered.inference } : {}) }, fn);
  }

  /** A Vercel AI SDK middleware for `wrapLanguageModel({ model, middleware: ap.aiSdkMiddleware() })`. */
  aiSdkMiddleware(options: AiSdkMiddlewareOptions = {}): AiSdkMiddleware {
    return aiSdkMiddleware(this.wrapHooks(), options);
  }

  /** The render a request's parameters name: an explicit scope first, else a message whose text is a recent render. */
  attributionFor(params: unknown): Attribution | undefined {
    return currentAttribution() ?? this.renders.match(requestTexts(params));
  }

  private wrapHooks(): WrapHooks {
    return {
      attribute: (params) => this.attributionFor(params),
      observe: (target, call, options) => this.observe(target, call, options),
      log: (event) => this.log(event),
    };
  }

  /**
   * T34: run the golden sets the active (or, with `staged: true`, the staged) release carries — every slot with one,
   * on the control arm and on each arm that overrides the slot — through the customer's model call, and record
   * `goldenPass` per case on the arm's window. Returns the reports (counts and the names of failed expectations; never
   * an output). `tag` narrows to one slot.
   */
  async golden(options: { invoke?: GoldenInvoke; tag?: string; staged?: boolean; concurrency?: number } = {}): Promise<GoldenReport[]> {
    const invoke = options.invoke ?? this.options.golden?.invoke;
    if (!invoke) throw new Error("golden(): no model call — pass invoke, or start with golden.invoke");
    if (options.staged) {
      const store = this.store;
      if (!store?.state.staged || !this.stagedManifest) return [];
      const loaded = store.load(store.state.staged, { now: this.nowIso(), root: this.trustedRoot, countersignRoot: this.options.countersignRoot ?? null });
      return this.runGoldenFor(loaded.manifest, loaded.payloads, invoke, options.concurrency ?? this.options.golden?.concurrency, options.tag);
    }
    if (!this.active) return [];
    return this.runGoldenFor(this.active.manifest, this.active.payloads, invoke, options.concurrency ?? this.options.golden?.concurrency, options.tag);
  }

  private async runGoldenFor(manifest: Manifest, payloads: ReadonlyMap<string, Uint8Array>, invoke: GoldenInvoke, concurrency: number | undefined, onlyTag?: string): Promise<GoldenReport[]> {
    const payload = manifest.payload;
    const targets: Array<{ slot: ManifestSlot; arm: string }> = payload.slots.filter((slot) => slot.goldenSet && (!onlyTag || slot.tag === onlyTag)).map((slot) => ({ slot, arm: "none" }));
    for (const experiment of experimentsOf(payload)) {
      for (const arm of experiment.arms) {
        for (const override of arm.overrides) if (override.goldenSet && (!onlyTag || override.tag === onlyTag)) targets.push({ slot: override, arm: arm.arm });
      }
    }
    const reports: GoldenReport[] = [];
    for (const { slot, arm } of targets) {
      const setBytes = payloads.get(slot.goldenSet!.contentHash);
      const text = payloads.get(slot.contentHash);
      if (!setBytes || !text) {
        this.log({ event: "golden_set_unavailable", tag: slot.tag, arm, generation: payload.generation });
        continue;
      }
      const set = parseGoldenSet(setBytes, slot.goldenSet!);
      const report = await runGoldenSet({ slot, arm, text: Buffer.from(text).toString("utf8"), set, invoke, ...(concurrency !== undefined ? { concurrency } : {}), ...(this.options.delimiters ? { delimiters: this.options.delimiters } : {}) });
      // One `goldenPass` per case on the arm's window: the rollout reads pass counts per arm; nothing else leaves the host.
      for (const result of report.results) this.spool.outcomes({ tag: slot.tag, versionId: slot.versionId, arm, model: slot.model }, { goldenPass: result.ok }, this.nowMs());
      this.log({ event: "golden_set_run", generation: payload.generation, tag: slot.tag, arm, setId: set.setId, cases: report.cases, passed: report.passed, minPassBps: report.minPassBps, met: report.meetsThreshold });
      reports.push(report);
    }
    this.lastGolden = { generation: payload.generation, met: goldenReportsMeet(reports), reports: reports.map((r) => ({ tag: r.tag, arm: r.arm, cases: r.cases, passed: r.passed, minPassBps: r.minPassBps })) };
    return reports;
  }

  /**
   * T34: a rubric on the customer's own model, reporting only the score. `rubric` is a criteria list, one of the
   * templates (`"protection"`, `"helpfulness"`), or `"prompt"` — the `## Success criteria` section of the prompt the
   * run rendered, read the way the hosted judge reads it. `invoke` receives the judge prompt and returns the reply. The
   * score (share of resolved task criteria that passed) lands as `judgeScore` on the run's arm window, a failed
   * protection criterion as `flagged`; the output, the rubric text and the reply never reach the spool.
   */
  async judge(runRef: string, output: string, rubric: JudgeRubric | "protection" | "helpfulness" | "prompt", invoke: (prompt: string) => Promise<string>): Promise<JudgeResult> {
    const resolved: JudgeRubric = typeof rubric !== "string" ? rubric : rubric === "prompt" ? this.promptRubricFor(runRef) : JUDGE_RUBRICS[rubric];
    const reply = await invoke(judgePrompt(resolved, output));
    const result = parseJudgeReply(reply, resolved);
    const filed = this.feedback(runRef, judgeSignalsOf(result));
    this.log({ event: "judged", rubric: resolved.name, criteria: resolved.criteria.length, score: result.score, flagged: result.flagged, filed });
    return result;
  }

  private promptRubricFor(runRef: string): JudgeRubric {
    const facts = parseRunRef(runRef, this.runRefKey);
    const payload = this.active?.manifest.payload;
    const override = facts && payload ? experimentForTag(payload, facts.tag)?.arms.find((arm) => arm.arm === facts.arm)?.overrides.find((entry) => entry.tag === facts.tag) : undefined;
    const slot = override ?? (facts ? payload?.slots.find((entry) => entry.tag === facts.tag) : undefined);
    const text = slot ? this.active?.payloads.get(slot.contentHash) : undefined;
    const criteria = text ? rubricFromPrompt(Buffer.from(text).toString("utf8")) : [];
    return { name: "prompt", criteria, protection: [...JUDGE_RUBRICS.protection.criteria] };
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
    const override = payload ? experimentForTag(payload, facts.tag)?.arms.find((arm) => arm.arm === facts.arm)?.overrides.find((entry) => entry.tag === facts.tag) : undefined;
    const slot = override ?? payload?.slots.find((entry) => entry.tag === facts.tag);
    this.spool.outcomes({ tag: facts.tag, versionId: facts.versionId, arm: facts.arm, model: slot?.versionId === facts.versionId ? slot.model : "unknown", ...(facts.audienceIds ? {audienceIds: facts.audienceIds,outcomeRunMinute: facts.runMinute} : {}) }, normalized.outcomes, this.nowMs());
    return true;
  }

  /** S14: the in-process healthz — the rules on `Healthz`, over this process's own status. Never throws. */
  healthz(): Healthz {
    return healthzOf(this.status(), { spoolBudgetBytes: this.sink.depth ? (this.options.telemetry?.spoolBudgetBytes ?? HOST_SPOOL_BUDGET_BYTES) : null, nowMs: this.nowMs() });
  }

  /**
   * S14: a request handler for Node's `http` (or any framework with `(req, res)`): `GET /healthz` → 200 / 503 with the
   * document. Mount it where your probes look; nothing else is served.
   */
  healthzHandler(): (request: { method?: string }, response: { writeHead(status: number, headers: Record<string, string>): unknown; end(body?: string): unknown }) => void {
    return (request, response) => {
      if (request.method && request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { allow: "GET, HEAD" });
        response.end();
        return;
      }
      const answer = healthzResponse(this.healthz());
      response.writeHead(answer.status, answer.headers);
      response.end(request.method === "HEAD" ? undefined : answer.body);
    };
  }

  /**
   * Per slot and arm of the active release: the required variables neither a literal nor a source fills, so the
   * call site must. Declarations only — a required variable is needed whether or not the text uses it — so no
   * payload is read; `status()` stays cheap for a probe. Every arm override for a tag counts, since a subject may
   * land on any arm.
   */
  private variablesStatus(): AgentStatus["variables"] {
    const sources = this.variables.names();
    const payload = this.active?.manifest.payload;
    if (!payload) return { sources, unsourced: [] };
    const seen = new Map<string, { tag: string; arm: string; names: string[] }>();
    const consider = (slot: ManifestSlot, arm: string) => {
      const names = unsourced({ variables: slot.variables, values: {}, registry: this.variables });
      if (names.length > 0) seen.set(`${slot.tag}\u0000${arm}`, { tag: slot.tag, arm, names });
    };
    for (const slot of payload.slots) consider(slot, "none");
    for (const experiment of experimentsOf(payload)) for (const arm of experiment.arms) for (const override of arm.overrides) consider(override, arm.arm);
    return { sources, unsourced: [...seen.values()].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : a.arm < b.arm ? -1 : 1)) };
  }

  status(): AgentStatus {
    const state = this.store?.state ?? null;
    const manifest = this.active?.manifest.payload;
    const leaseExpiresAt = this.leaseExpiresAt();
    const depth = this.sink.depth?.() ?? { segments: 0, bytes: 0 };
    // S9/S16: every experiment's plan as this host walks it — per slot, each on its own clock and retreat.
    const ramps: AgentRampStatus[] = manifest
      ? experimentsOf(manifest).map((experiment) => {
          const arms = this.resolver().arms(experiment);
          const nowMs = this.nowMs();
          const plan = experiment.ramp ?? [];
          let step = -1;
          for (let i = 0; i < plan.length; i += 1) if (instant(plan[i]!.notBefore) <= nowMs) step = i;
          const next = plan[step + 1] ?? null;
          return { experimentId: experiment.experimentId, tag: experiment.tag ?? null, weightBps: arms ? arms.map((arm) => arm.weightBps) : rampWeightsAt(experiment.arms, experiment.ramp, nowMs), arms: experiment.arms.map((arm) => arm.arm), step, nextStepAt: next ? next.notBefore : null, plan: plan.map((entry) => ({ notBefore: entry.notBefore, weightBps: [...entry.weightBps] })) };
        })
      : [];
    return {
      instanceId: this.ownInstanceId,
      generation: this.active?.generation ?? 0,
      stagedGeneration: this.stagedManifest?.payload.generation ?? null,
      applyState: this.stagedManifest ? "awaiting_unlock" : this.lastRefusal ? "refused" : this.source === "vendored_bundle" ? "vendored_fallback" : "active",
      lastRefusal: this.lastRefusal,
      storageProtection: this.store?.storageProtection ?? "custom",
      signingKeyId: this.active?.signingKeyId ?? null,
      leaseExpiresAt,
      leaseExpired: leaseExpiresAt ? instant(leaseExpiresAt) <= this.nowMs() : false,
      onLeaseExpiry: manifest?.onLeaseExpiry ?? null,
      lastContactAt: this.lastContactMs === null ? null : new Date(this.lastContactMs).toISOString(),
      forcedDowngrade: state?.forcedDowngrade === true,
      disabled: this.disabledNow(),
      ramp: ramps[0] ?? null,
      ramps,
      unlockRequests: this.openUnlockRequests(manifest ?? this.stagedManifest?.payload ?? null).map((d) => ({ releaseDigest: d.releaseDigest, requestedBy: d.requestedBy, requestedAt: d.requestedAt, expiresAt: d.expiresAt, ...(d.note !== undefined ? { note: d.note } : {}) })),
      applyPolicy: this.effectiveApplyPolicy(),
      window: (() => {
        const governing = this.windowInForce(this.stagedManifest ?? this.active?.manifest ?? null);
        if (!governing) return null;
        const state = windowState(governing.window, this.nowMs());
        return { source: governing.source, open: state.open, opensAt: new Date(state.opensAtMs).toISOString(), closesAt: new Date(state.closesAtMs).toISOString() };
      })(),
      heartbeat: { lastAt: this.lastHeartbeatMs === null ? null : new Date(this.lastHeartbeatMs).toISOString(), nextAt: this.nextHeartbeatMs === null || !this.heartbeatTimer ? null : new Date(this.nextHeartbeatMs).toISOString(), intervalSeconds: this.heartbeatIntervalSeconds, lastRefusal: this.lastHeartbeatRefusal },
      spool: { depthSegments: depth.segments, depthBytes: depth.bytes },
      source: this.source,
      telemetry: this.telemetryPlacement(),
      lastSyncAt: this.lastSyncMs === null ? null : new Date(this.lastSyncMs).toISOString(),
      golden: this.lastGolden,
      variables: this.variablesStatus(),
      upload: this.uploader?.status() ?? null,
      lastSyncOutcome: this.lastSyncOutcome,
      consecutiveSyncFailures: this.consecutiveSyncFailures,
      nextSyncAt: this.nextSyncMs === null || !this.timer ? null : new Date(this.nextSyncMs).toISOString(),
      ...(this.options.datastore ? { datastore: this.datastoreStatus ?? { region: this.options.datastore.region ?? null, lastHydrateAt: null, lastOutcome: null, newestGeneration: 0, rowsFrom: null, rollback: null } } : {}),
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

  /** Stop timers and uploads, and close the spool. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = null;
    if (this.spoolTimer) clearInterval(this.spoolTimer);
    this.spoolTimer = null;
    if (this.datastoreTimer) clearInterval(this.datastoreTimer);
    this.datastoreTimer = null;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.heartbeating) await this.heartbeating;
    if (this.syncing) await this.syncing;
    if (this.placing) await this.placing;
    if (this.uploader) await this.uploader.stop();
    // T33: an observation settled by a wrapped client's stream helper lands a few microtasks after the customer's own
    // await; one turn of the event loop lets everything in flight reach the spool before the windows close.
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.spool.closeWindows(this.nowMs());
  }

  /** The runtime's own random id — this process's, fresh at every start (S6); never a hostname, never the store's. */
  get instanceId(): string {
    return this.ownInstanceId;
  }

  /** S6: the store's id (store.json), shared by every process on the host. */
  get storeInstanceId(): string | null {
    return this.store?.instanceId ?? null;
  }

  static thumbprint(jwk: P256PublicJwk): string {
    return keyThumbprint(jwk);
  }

  /** The memory sink's rows on serverless hosts (the host's uploader takes them at invocation end); a `dropped` row closes an over-budget invocation. */
  drainMemorySink(): unknown[] {
    return this.sink.drain?.(this.nowMs()) ?? [];
  }

  static newInstanceId(): string {
    return `i-${randomBytes(12).toString("base64url")}`;
  }

  refusalRow(row: Omit<RefusalRow, "type" | "v" | "instanceId">): void {
    this.spool.refusal(row, this.nowMs());
  }
}

/**
 * `protocol/daemon.md` › What an SDK does: the folder this process writes — `telemetry.spoolDir`, else
 * `AIRPROMPTER_SPOOL_DIR`, else a live daemon's published `spoolDir`, else `<storeDir>/spool/telemetry`.
 */
function spoolPlacement(options: StartOptions, storeDir: string, nowMs: number): { dir: string; from: SpoolDirSource; discovery: DiscoveryResult | null } {
  const discovery = readDaemonDiscovery(options.fs ?? nodeFs, storeDir, { agentId: options.agentId, target: options.target, organizationId: options.organizationId, nowMs });
  const explicit = options.telemetry?.spoolDir;
  if (explicit) return { dir: resolvePath(explicit), from: "option", discovery };
  const env = process.env[SPOOL_DIR_ENV];
  if (env) return { dir: resolvePath(env), from: "env", discovery };
  if (discovery.live) return { dir: resolvePath(discovery.discovery.spoolDir), from: "daemon", discovery };
  return { dir: join(storeDir, "spool", "telemetry"), from: "default", discovery };
}

/** Two folders are one when they resolve to the same real path (a symlinked volume); a path that cannot be resolved compares as written. */
function samePath(a: string, b: string): boolean {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return resolvePath(path);
    }
  };
  return resolvePath(a) === resolvePath(b) || real(a) === real(b);
}

function defaultStateDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  if (process.env.XDG_STATE_HOME) return process.env.XDG_STATE_HOME;
  if (process.platform === "darwin") return join(home, "Library", "Application Support");
  if (process.platform === "win32") return process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  return join(home, ".local", "state");
}

/** T34: whether any slot (or arm override) of a manifest carries a golden set. */
function manifestHasGolden(manifest: Manifest): boolean {
  const payload = manifest.payload;
  return payload.slots.some((slot) => !!slot.goldenSet) || experimentsOf(payload).some((experiment) => experiment.arms.some((arm) => arm.overrides.some((override) => !!override.goldenSet)));
}
