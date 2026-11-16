/**
 * The automation client's contract: what a no-code platform (Zapier, n8n) asks of AirPrompter Agents, in names that
 * carry no platform. One slot per step; the step picks the slot, fills its variables and may name a subject; every
 * rollout decision (versions, approvals, A/B arms, dial-up, rollback, the lease) was made in AirPrompter and arrives
 * signed. Nothing here imports a platform package, so the same file can move to a shared `integrations/core`.
 *
 * @example
 * ```ts
 * import type { AutomationClient } from "./types.js";
 * async function step(client: AutomationClient) {
 *   const served = await client.getPrompt({ slot: "support.triage", variables: { ticket: "…" }, subject: "customer-42" });
 *   // hand served.prompt to the platform's own model step, then:
 *   await client.reportRun({ runRef: served.runRef, inputTokens: 812, outputTokens: 96, thumbs: "up" });
 * }
 * ```
 */

import type { ReleaseDatastore } from "@airprompter/agent-sdk/sync";
import type { FetchLike, HostedEnvironment, P256PublicJwk } from "@airprompter/agent-sdk/core";

/**
 * A `ReleaseDatastore` that may also keep two small notes for the client: the organization id learned from the first
 * signed manifest (so a step can verify the stored copy with AirPrompter unreachable) and nothing else. A datastore
 * without notes still works when `organizationId` is passed in the options.
 */
export type AutomationDatastore = ReleaseDatastore & {
  readNote?(name: string): Promise<string | null>;
  writeNote?(name: string, value: string): Promise<void>;
};

export interface AutomationClientOptions {
  agentId: string;
  /** The agent's Update key (an Agent key, `apa_…`): bound to one agent and one environment. */
  updateKey: string;
  baseUrl: string;
  /** Where the signed manifest and payloads are kept between invocations, on the platform's side. */
  datastore: AutomationDatastore;
  /** The SDK's own slot store. Default: a fresh temporary folder per call, removed afterwards — the datastore is the copy that lasts. */
  stateDir?: string;
  now?: () => number;
  // ── Optional beyond the shared contract. Each has a default that fits the hosted service.
  /** The environment (target) the key is bound to. Default `prod`. */
  environment?: string;
  /** The hosted environment whose root signs the manifests. Default `prod`; the local registry (`airprompter dev`) is `dev`. */
  hostedEnvironment?: HostedEnvironment;
  /** The root public key to pin. Default: the one this package pins for `hostedEnvironment` (see `trust.ts`). */
  root?: P256PublicJwk;
  /** Where the root document (the signing keys under the root) is read. Default `<baseUrl>/roots/<hostedEnvironment>/root.json`. */
  rootUrl?: string;
  /** Skip learning it from the first manifest. */
  organizationId?: string;
  /** Default: the platform's `fetch` with a timeout per request (`requestTimeoutMs`). */
  fetch?: FetchLike;
  /** Per request; an unreachable AirPrompter must leave time to serve the stored copy inside a platform's step limit. Default 8000. */
  requestTimeoutMs?: number;
  logger?: (event: Record<string, unknown>) => void;
}

export interface SlotInfo {
  slot: string;
  /** `prompt` today; workflow slots are left out (one slot per step). */
  kind: string;
  model: string;
  versionId: string;
  /** Set while an A/B split runs on this slot. */
  experiment: { experimentId: string; arms: Array<{ arm: string; versionId: string; weightBps: number }> } | null;
  disabled: boolean;
}

export interface VariableInfo {
  name: string;
  required: boolean;
  /** `end_user`: text from the person the step serves, fenced when rendered. */
  trust: "operator" | "end_user";
  default?: string;
}

/** The inference settings the release pins, in the units a model step takes. */
export interface InferenceSettings {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  reasoningEffort?: "low" | "medium" | "high";
}

export interface GetPromptResult {
  /** The rendered prompt. The protocol carries one text per slot; there are no separate system/user parts today. */
  prompt: string;
  model: string;
  inference: InferenceSettings;
  slot: string;
  versionId: string;
  /** The A/B arm this run was assigned (`none` without a split). */
  arm: string;
  generation: number;
  /** Map it to Report run. Content-free, signed for this agent and environment. */
  runRef: string;
  /** `network`: AirPrompter answered on this call. `stored`: AirPrompter was unreachable and the signed copy kept on the platform served. */
  servedFrom: "network" | "stored";
  /** When the stored copy stops serving if AirPrompter stays unreachable. */
  leaseExpiresAt: string | null;
}

export interface ReportRunInput {
  runRef: string;
  inputTokens?: number;
  outputTokens?: number;
  /** What went wrong in the model step, in words; only its class leaves (provider error, timeout, rate limit, …). */
  error?: string;
  thumbs?: "up" | "down";
  rating?: 1 | 2 | 3 | 4 | 5;
  /** The model step's duration when the platform shows it. Absent: recorded as 0 (the run still counts). */
  latencyMs?: number;
}

export type RolloutState = "current" | "new_version" | "rolled_back" | "ab_started" | "ab_ended" | `dial:${string}` | "disabled" | "enabled" | "removed";

export interface RolloutEvent {
  /** `slot:digest:state`: the same change is one id however many polls see it. */
  id: string;
  slot: string;
  state: RolloutState;
  /** A sentence for the platform's UI. */
  summary: string;
  generation: number;
  versionId: string | null;
  previousVersionId: string | null;
  experiment: SlotInfo["experiment"];
  at: string;
}

/** What the last poll saw, per slot; the platform keeps it between polls. Content-free. */
export interface RolloutCursor {
  generation: number;
  slots: Record<string, { digest: string; versionId: string; ordinal: number | null; experimentId: string | null; weights: number[]; disabled: boolean }>;
}

export interface AutomationClient {
  listSlots(): Promise<SlotInfo[]>;
  slotVariables(slot: string): Promise<VariableInfo[]>;
  getPrompt(input: { slot: string; variables: Record<string, string>; subject?: string }): Promise<GetPromptResult>;
  /** The ONE place usage and quality leave for AirPrompter. Throws `AutomationError` (retryable) when they could not be delivered. */
  reportRun(input: ReportRunInput): Promise<void>;
  rolloutEvents(previous: RolloutCursor | null): Promise<{ events: RolloutEvent[]; cursor: RolloutCursor }>;
  testConnection(): Promise<{ ok: true; agentId: string; environment: string } | { ok: false; reason: string }>;
}

export type AutomationErrorCode =
  | "unauthorized"
  | "nothing_promoted"
  | "unknown_slot"
  | "invalid_input"
  | "unreachable"
  | "refused"
  | "lease_expired"
  | "root_not_pinned"
  | "storage_unavailable";

/** Every failure the client raises: a code a platform maps to its own error kinds, and whether retrying can help. */
export class AutomationError extends Error {
  constructor(
    readonly code: AutomationErrorCode,
    message: string,
    readonly retryable: boolean = code === "unreachable" || code === "storage_unavailable",
  ) {
    super(message);
    this.name = "AutomationError";
  }
}

export const isAutomationError = (error: unknown): error is AutomationError => error instanceof AutomationError || (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AutomationError");
