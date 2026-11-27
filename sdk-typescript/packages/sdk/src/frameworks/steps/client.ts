/**
 * `createAutomationClient`: AirPrompter Agents for a no-code step, as a thin client of `@airprompter/agent-sdk`.
 * Platform-agnostic — no Zapier or n8n import: the Steps core both platforms build on (AIR-2405).
 *
 * Every call is one invocation and starts a FRESH agent (`on_invoke`), as a serverless step must: nothing is kept warm
 * between invocations, so two reports in one minute never share an ingest key. The order of a call:
 *
 * 1. **Refresh the stored copy.** `pullToDatastore` fetches the signed manifest and payloads, verifies the whole chain
 *    and writes the sealed `.apbundle` into the platform's datastore — only when it moved (ETag / edge pointer).
 *    AirPrompter unreachable is not an error here: the call goes on with what is stored.
 * 2. **Start the agent from the datastore.** The SDK hydrates from the stored row and verifies it again (signature,
 *    scope, every payload hash) — a row edited in the platform's storage is refused, not served.
 * 3. **The lease.** Served from the stored copy, a step refuses once the manifest's `leaseSeconds` have run out since
 *    the last successful contact (the SDK itself only marks a lapsed lease as stale; a no-code step refuses instead,
 *    because nobody watches its health endpoint).
 * 4. **Render.** `ap.prompt(slot, { subject }).render(values)` — never the network; the arm is the SDK's sticky hash of
 *    the subject (empty subject: a fresh random one per run, so the split follows the signed weights).
 *
 * What a step can change: the slot, its variables and the subject. Versions, approvals, A/B arms, dial-up, rollback
 * and the lease are AirPrompter's, signed into the manifest; there is no setting for them here.
 *
 * @example
 * ```ts
 * const client = createAutomationClient({ agentId, updateKey, baseUrl: "https://api.airprompter.com", datastore });
 * const served = await client.getPrompt({ slot: "support.triage", variables: { ticket }, subject: customerId });
 * await client.reportRun({ runRef: served.runRef, inputTokens: 812, outputTokens: 96, rating: 4 });
 * ```
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SyncClient, instant, trustedRootFromPinnedKey } from "../../core/index.js";
import type { ManifestPayload, RootMetadata } from "../../core/index.js";
import { AirPrompterAgent } from "../../index.js";
import { pullToDatastore, type ReleaseKey } from "../../sync/index.js";

import { rolloutChanges, slotsOf, variablesOf } from "./rollout.js";
import { distributionKeyFor, pinnedRootFor, timedFetch } from "./trust.js";
import { AutomationError, isAutomationError, type AutomationClient, type AutomationClientOptions, type GetPromptResult, type InferenceSettings, type ReportRunInput } from "./types.js";
import { runReportOf } from "./usage.js";

const ORGANIZATION_NOTE = "organizationId";
const USER_AGENT = "airprompter-automation/1.0.0-rc.5";
/** Rows kept per connection: the one serving and the one before it. A rollback is a new generation, so older rows serve nothing. */
const KEEP_ROWS = 2;

/** What the refresh found: whose release this is, and whether AirPrompter answered on this call. */
interface Refresh {
  organizationId: string;
  contact: "network" | "stored";
  /** Why the network did not count, when it did not. */
  detail: string | null;
  /** The last time AirPrompter answered for this connection (the edge state the puller keeps beside the rows). */
  lastOriginAt: string | null;
}

interface Session {
  ap: AirPrompterAgent;
  payload: ManifestPayload;
  refresh: Refresh;
  leaseExpiresAt: string | null;
  close(): Promise<void>;
}

export function createAutomationClient(options: AutomationClientOptions): AutomationClient {
  const environment = options.environment ?? "prod";
  const hosted = options.hostedEnvironment ?? "prod";
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const rootUrl = options.rootUrl ?? `${baseUrl}/roots/${hosted}/root.json`;
  const nowMs = () => options.now?.() ?? Date.now();
  const nowIso = () => new Date(nowMs()).toISOString();
  const requestTimeoutMs = options.requestTimeoutMs ?? 8000;
  const fetch = options.fetch ?? timedFetch(globalThis.fetch, requestTimeoutMs);
  const log = options.logger ?? (() => undefined);
  const distributionKey = distributionKeyFor({ updateKey: options.updateKey, agentId: options.agentId, environment });
  const { datastore } = options;

  const pinned = () => {
    const root = pinnedRootFor(hosted, options.root);
    if (!root) throw new AutomationError("root_not_pinned", `No AirPrompter root key is pinned for the ${hosted} environment in this version of the app, so nothing it serves can be verified. Update the app (or pass the root explicitly).`, false);
    return root;
  };
  const syncClient = () => new SyncClient({ baseUrl, agentId: options.agentId, target: environment, apiKey: options.updateKey, fetch, userAgent: USER_AGENT });
  const keyFor = (organizationId: string): ReleaseKey => ({ organizationId, agentId: options.agentId, target: environment, region: null });

  async function fetchRoot(): Promise<RootMetadata | null> {
    try {
      const response = await fetch(rootUrl, { headers: { "user-agent": USER_AGENT } });
      return response.status === 200 ? (JSON.parse(await response.text()) as RootMetadata) : null;
    } catch {
      return null;
    }
  }

  async function storedOrganization(): Promise<string | null> {
    if (options.organizationId) return options.organizationId;
    try {
      return (await datastore.readNote?.(ORGANIZATION_NOTE)) ?? null;
    } catch (error) {
      throw new AutomationError("storage_unavailable", `The stored copy could not be read: ${(error as Error).message}`);
    }
  }

  const unauthorized = () => new AutomationError("unauthorized", `AirPrompter refused the Update key for agent ${options.agentId} in ${environment}. Check the key in AirPrompter (Agents › Keys) and that it is bound to this agent and environment.`, false);

  /** Step 1: bring the stored copy up to date when AirPrompter answers; never fail only because it does not. */
  async function refresh(): Promise<Refresh> {
    const trustedRoot = trustedRootFromPinnedKey({ purpose: "platform", environment: hosted, pinnedRoot: pinned() });
    const client = syncClient();
    let organizationId = await storedOrganization();
    let detail: string | null = null;
    let learned = false;
    if (!organizationId) {
      // First contact for this connection: the organization is read from the manifest and then verified with it —
      // the platform root's signature over the payload is what makes it trustworthy, not this read.
      try {
        const answer = await client.manifest({});
        if (answer.status === "unauthorized" || answer.status === "forbidden") throw unauthorized();
        if (answer.status === "not_found") throw new AutomationError("nothing_promoted", `Nothing is promoted to ${environment} for agent ${options.agentId} yet. Approve and promote a release in AirPrompter first.`, false);
        if (answer.status === "ok") {
          organizationId = answer.manifest.payload.organizationId;
          learned = true;
        } else detail = answer.status === "error" ? `http_${answer.httpStatus}` : answer.status;
      } catch (error) {
        if (isAutomationError(error)) throw error;
        detail = `network: ${(error as Error).message}`;
      }
      if (!organizationId) throw new AutomationError("unreachable", `AirPrompter could not be reached (${detail}) and nothing is stored for this connection yet.`);
    }
    const key = keyFor(organizationId);
    let contact: Refresh["contact"] = "stored";
    if (detail === null) {
      let result: Awaited<ReturnType<typeof pullToDatastore>> | null = null;
      try {
        result = await pullToDatastore({ datastore, region: null, client, scope: { organizationId, agentId: options.agentId, target: environment }, trustedRoot, fetchRoot, now: nowIso, distributionPublicKey: distributionKey.publicRaw });
      } catch (error) {
        detail = `network: ${(error as Error).message}`;
      }
      if (result) {
        if (result.status === "ok" || result.status === "unchanged" || result.status === "nothing_promoted") {
          contact = "network";
          if (result.status === "ok") {
            log({ event: "automation_release_stored", generation: result.generation });
            try {
              await datastore.prune?.(key, KEEP_ROWS);
            } catch (error) {
              log({ event: "automation_prune_failed", reason: (error as Error).message });
            }
          }
          if (learned && result.status !== "nothing_promoted") {
            try {
              await datastore.writeNote?.(ORGANIZATION_NOTE, organizationId);
            } catch (error) {
              log({ event: "automation_note_failed", reason: (error as Error).message });
            }
          }
        } else if (result.status === "unavailable") {
          if (result.reason === "unauthorized" || result.reason === "forbidden") throw unauthorized();
          detail = result.detail ? `${result.reason}: ${result.detail}` : result.reason;
        } else if (result.status === "datastore_unavailable") {
          throw new AutomationError("storage_unavailable", `The stored copy could not be ${result.stage === "read" ? "read" : "written"}: ${result.detail}`);
        } else {
          // A manifest that fails verification over the network is not served; the stored copy is, if it verifies.
          detail = `refused: ${result.reason}${result.detail ? ` (${result.detail})` : ""}`;
          log({ event: "automation_network_release_refused", reason: result.reason });
        }
      }
    }
    let lastOriginAt: string | null = null;
    try {
      lastOriginAt = (await datastore.edge(key))?.lastOriginAt ?? null;
    } catch {
      lastOriginAt = null;
    }
    if (contact === "stored") log({ event: "automation_serving_stored", reason: detail });
    return { organizationId, contact, detail, lastOriginAt };
  }

  /** Step 2 and 3: a fresh agent over the stored copy; refuses what does not verify and a lapsed lease. */
  async function open(input: { forReport?: boolean; checkLease?: boolean; refreshed?: Refresh } = {}): Promise<Session> {
    const fresh = input.refreshed ?? (await refresh());
    const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), "airprompter-automation-"));
    const cleanup = () => {
      if (!options.stateDir) rmSync(stateDir, { recursive: true, force: true });
    };
    let ap: AirPrompterAgent;
    try {
      ap = await AirPrompterAgent.start({
        organizationId: fresh.organizationId,
        agentId: options.agentId,
        target: environment,
        // With AirPrompter unreachable the agent gets no key: it would only try (and time out) again at boot. A report
        // always has the key — delivering it is the point.
        ...(fresh.contact === "network" || input.forReport ? { apiKey: options.updateKey } : {}),
        baseUrl,
        // The run reference is keyed by the Update key, so a ref minted in one invocation verifies in the next.
        runRefSecret: options.updateKey,
        root: { pinned: pinned(), hostedEnvironment: hosted },
        stateDir,
        sync: { mode: "on_invoke", rootUrl },
        datastore: { store: datastore },
        distributionKey,
        // stop() bounds its last pass (AIR-2261, 2 s by default) and aborts whatever is in flight at the bound, the
        // heartbeat that issues the upload grant included; after that abort the flush that delivers a report cannot
        // run. A new agent's first heartbeat on a cold service takes longer than 2 s, so every new connection's first
        // report failed (live on dev, 2026-11-17). The bound is this client's own per-request limit: a step never
        // gives up on a request sooner than `timedFetch` would.
        telemetry: { sink: "memory", flush: "await", stopUploadTimeoutMs: requestTimeoutMs },
        fetch,
        now: nowMs,
        logger: log,
      });
    } catch (error) {
      cleanup();
      throw new AutomationError("refused", `The agent could not start: ${(error as Error).message}`, false);
    }
    const close = async () => {
      await ap.stop();
      cleanup();
    };
    const manifest = ap.manifest;
    if (!manifest) {
      if (input.forReport) return { ap, payload: null as unknown as ManifestPayload, refresh: fresh, leaseExpiresAt: null, close };
      const status = ap.status();
      await close();
      const stored = status.datastore?.lastOutcome;
      if (stored === "refused") throw new AutomationError("refused", `The stored copy failed verification (${status.lastRefusal ?? "unusable"}) and was not served${fresh.contact === "stored" ? `; AirPrompter could not be reached (${fresh.detail})` : ""}.`, fresh.contact === "stored");
      if (fresh.contact === "stored") throw new AutomationError("unreachable", `AirPrompter could not be reached (${fresh.detail}) and no verified copy is stored for this connection.`);
      throw new AutomationError("nothing_promoted", `Nothing is promoted to ${environment} for agent ${options.agentId} yet.`, false);
    }
    const payload = manifest.payload;
    let leaseExpiresAt: string;
    if (fresh.contact === "network") leaseExpiresAt = new Date(nowMs() + payload.leaseSeconds * 1000).toISOString();
    else {
      // The lease runs from the last time AirPrompter answered (never before the manifest was issued).
      const since = Math.max(instant(payload.issuedAt), fresh.lastOriginAt ? instant(fresh.lastOriginAt) : 0);
      leaseExpiresAt = new Date(since + payload.leaseSeconds * 1000).toISOString();
      if (input.checkLease && instant(leaseExpiresAt) <= nowMs()) {
        await close();
        throw new AutomationError("lease_expired", `AirPrompter has been unreachable since ${fresh.lastOriginAt ?? payload.issuedAt} and the release's lease (${payload.leaseSeconds} s) ran out at ${leaseExpiresAt}; the stored copy is not served past it. Steps serve again on the next successful contact.`, true);
      }
    }
    return { ap, payload, refresh: fresh, leaseExpiresAt, close };
  }

  async function withSession<T>(input: Parameters<typeof open>[0], body: (session: Session) => Promise<T> | T): Promise<T> {
    const session = await open(input);
    try {
      return await body(session);
    } finally {
      await session.close();
    }
  }

  return {
    async listSlots() {
      return withSession({}, (s) => slotsOf(s.payload, nowMs()));
    },

    async slotVariables(slot) {
      return withSession({}, (s) => {
        const variables = variablesOf(s.payload, slot);
        if (!variables) throw new AutomationError("unknown_slot", `Slot ${slot} is not in the release serving ${environment} (generation ${s.payload.generation}).`, false);
        return variables;
      });
    },

    async getPrompt(input) {
      return withSession({ checkLease: true }, (s): GetPromptResult => {
        const declared = variablesOf(s.payload, input.slot);
        if (!declared) throw new AutomationError("unknown_slot", `Slot ${input.slot} is not in the release serving ${environment} (generation ${s.payload.generation}).`, false);
        // Only the slot's declared names; an empty optional field is "not given" (its default applies).
        const values: Record<string, string> = {};
        for (const variable of declared) {
          const value = input.variables[variable.name];
          if (value === undefined || value === null) continue;
          if (value === "" && !variable.required) continue;
          values[variable.name] = String(value);
        }
        const subject = input.subject?.trim() ? input.subject.trim() : undefined;
        let rendered;
        try {
          // Outside any `ap.run`: a render writes no run row; Report run is the run's one count.
          rendered = s.ap.prompt(input.slot, subject ? { subject } : {}).render(values);
        } catch (error) {
          const code = (error as { code?: unknown }).code;
          const name = (error as Error).name;
          if (code === "render_missing_variable" || code === "render_unknown_variable") throw new AutomationError("invalid_input", (error as Error).message, false);
          if (name === "RenderRefusedError") throw new AutomationError("refused", `Slot ${input.slot} is disabled in AirPrompter: ${(error as Error).message}`, false);
          throw error;
        }
        return {
          prompt: rendered.text,
          model: rendered.model,
          inference: inferenceOf(rendered.inference),
          slot: rendered.tag,
          versionId: rendered.versionId,
          arm: rendered.arm,
          generation: rendered.generation,
          runRef: rendered.runRef,
          servedFrom: s.refresh.contact,
          leaseExpiresAt: s.leaseExpiresAt,
        };
      });
    },

    async reportRun(input: ReportRunInput) {
      if (typeof input.runRef !== "string" || input.runRef.trim() === "") throw new AutomationError("invalid_input", "Run reference is required: map it from the Get prompt step.", false);
      if (input.rating !== undefined && !(Number.isInteger(input.rating) && input.rating >= 1 && input.rating <= 5)) throw new AutomationError("invalid_input", "Rating is a whole number from 1 to 5.", false);
      if (input.thumbs !== undefined && input.thumbs !== "up" && input.thumbs !== "down") throw new AutomationError("invalid_input", "Thumbs is up or down.", false);
      const organizationId = await storedOrganization();
      // A report needs no fresh release — only the organization (for the agent's scope) — so it skips the pull when it can.
      const refreshed: Refresh | undefined = organizationId ? { organizationId, contact: "stored", detail: "report", lastOriginAt: null } : undefined;
      const session = await open({ forReport: true, ...(refreshed ? { refreshed } : {}) });
      try {
        const runRef = input.runRef.trim();
        const usage = { ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}), ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}), ...(input.error ? { error: input.error } : {}), ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}) };
        // `ap.reportRun` is the run's one count: Get prompt rendered outside any run and wrote no row.
        if (!session.ap.reportRun(runRef, runReportOf(usage))) throw new AutomationError("invalid_input", "The run reference does not verify for this connection (another agent, environment or Update key), or carries more than one slot.", false);
        const signals = { ...(input.thumbs ? { thumbs: input.thumbs } : {}), ...(input.rating !== undefined ? { rating: input.rating } : {}) };
        if (Object.keys(signals).length > 0 && !session.ap.feedback(runRef, signals)) throw new AutomationError("invalid_input", "The quality signal was not accepted for this run reference.", false);
      } catch (error) {
        await session.close();
        throw error;
      }
      // The windows close at stop; then the rows go out under this invocation's own grant. Held means not delivered:
      // the platform retries the step rather than the report being dropped.
      await session.close();
      const flushed = await session.ap.flushTelemetry();
      if (flushed.status === "held") throw new AutomationError("unreachable", `AirPrompter could not take the report right now (${flushed.reason}); it was not recorded. Retry the step.`);
    },

    async rolloutEvents(previous) {
      return withSession({}, (s) => rolloutChanges(s.payload, previous, nowMs()));
    },

    async testConnection() {
      try {
        const fresh = await refresh();
        if (fresh.contact !== "network") return { ok: false, reason: `AirPrompter could not be reached or its answer did not verify (${fresh.detail}).` };
        return await withSession({ refreshed: fresh }, () => ({ ok: true as const, agentId: options.agentId, environment }));
      } catch (error) {
        if (isAutomationError(error)) return { ok: false, reason: error.message };
        throw error;
      }
    },
  };
}

function inferenceOf(inference: { temperatureMilli?: number; topPBps?: number; maxOutputTokens?: number; stopSequences?: string[]; reasoningEffort?: "low" | "medium" | "high" } | undefined): InferenceSettings {
  if (!inference) return {};
  return {
    ...(inference.temperatureMilli !== undefined ? { temperature: inference.temperatureMilli / 1000 } : {}),
    ...(inference.topPBps !== undefined ? { topP: inference.topPBps / 10000 } : {}),
    ...(inference.maxOutputTokens !== undefined ? { maxOutputTokens: inference.maxOutputTokens } : {}),
    ...(inference.stopSequences ? { stopSequences: [...inference.stopSequences] } : {}),
    ...(inference.reasoningEffort ? { reasoningEffort: inference.reasoningEffort } : {}),
  };
}
