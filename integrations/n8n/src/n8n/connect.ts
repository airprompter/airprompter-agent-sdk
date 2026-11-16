/**
 * From an n8n credential to the shared core's `AutomationClient`: where the stored copy lives (the n8n user folder
 * on a self-hosted instance, or the workflow's static data where there is no disk), the credential's fields mapped
 * onto the core's options, and — n8n only — seeding the stored copy from a vendored bundle for installs that never
 * reach AirPrompter. No n8n runtime import here, so it is tested without n8n.
 *
 * Every core call starts a fresh SDK agent and stops it (`on_invoke`); the stored copy is what lasts: on disk, shared
 * by every workflow on the instance; in static data, by the nodes of one workflow.
 *
 * @example
 * ```ts
 * const client = await clientFor(credentials, { getWorkflowStaticData: (t) => this.getWorkflowStaticData(t) });
 * const served = await client.getPrompt({ slot: "support.triage", variables: { ticket } });
 * ```
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { openBundle } from "@airprompter/agent-sdk/core";
import type { Bundle, HostedEnvironment, P256PublicJwk } from "@airprompter/agent-sdk/core";
import { fsKvStore, kvReleaseDatastore, rolloutOf } from "@airprompter/agent-sdk/sync";
import type { KvStore } from "@airprompter/agent-sdk/sync";

import { AutomationError, createAutomationClient } from "../core";
import type { AutomationClient, AutomationClientOptions, AutomationDatastore } from "../core";
import { staticDataKvStore } from "./staticDataKvStore";

export type StorageMode = "userFolder" | "workflowStaticData";

/** The credential's fields, as `AirPrompterAgentApi` declares them. */
export interface AirPrompterCredentials {
  agentId: string;
  updateKey: string;
  environment?: string;
  apiBaseUrl?: string;
  hostedEnvironment?: HostedEnvironment;
  rootKey?: string;
  rootUrl?: string;
  organizationId?: string;
  storage?: StorageMode;
  bundlePath?: string;
}

/** What the adapter needs from an n8n execution, poll or load-options context. */
export interface N8nStorageContext {
  getWorkflowStaticData(type: string): Record<string, unknown>;
}

export const DEFAULT_API_BASE_URL = "https://api.airprompter.com";
const NOTE_PREFIX = "automation/notes/";

/** n8n's own rule: `N8N_USER_FOLDER` (else the home folder), then `.n8n`. */
export function userFolder(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.N8N_USER_FOLDER || homedir(), ".n8n");
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "_";
}

/** The shared datastore format over any KvStore, plus the core's notes (the organization id) as keys beside it. */
export function automationDatastore(kv: KvStore): AutomationDatastore {
  const datastore = kvReleaseDatastore(kv) as AutomationDatastore;
  datastore.readNote = async (name) => (await kv.get(`${NOTE_PREFIX}${name}`))?.value ?? null;
  datastore.writeNote = async (name, value) => {
    const key = `${NOTE_PREFIX}${name}`;
    const held = await kv.get(key);
    if (held?.value === value) return;
    await kv.put(key, value, held ? { ifVersion: held.version } : { ifAbsent: true });
  };
  return datastore;
}

export function parseRootKey(text: string | undefined): P256PublicJwk | undefined {
  if (!text || !text.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AutomationError("invalid_input", 'Root Public Key must be the JSON Web Key AirPrompter publishes for its deployment ({"kty":"EC","crv":"P-256","x":…,"y":…})', false);
  }
  const jwk = parsed as Partial<P256PublicJwk>;
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new AutomationError("invalid_input", "Root Public Key must be a P-256 public JSON Web Key with kty, crv, x and y", false);
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

export function datastoreFor(credentials: AirPrompterCredentials, context: N8nStorageContext | null, env: NodeJS.ProcessEnv = process.env): AutomationDatastore {
  if ((credentials.storage ?? "userFolder") === "workflowStaticData") {
    if (!context) throw new AutomationError("invalid_input", "Workflow static data is only available inside a workflow.", false);
    return automationDatastore(staticDataKvStore(context.getWorkflowStaticData("global")));
  }
  const environment = credentials.environment?.trim() || "prod";
  return automationDatastore(fsKvStore(join(userFolder(env), "airprompter", safeSegment(credentials.agentId), safeSegment(environment), "releases")));
}

export function clientOptions(credentials: AirPrompterCredentials, datastore: AutomationDatastore, extra: Partial<AutomationClientOptions> = {}): AutomationClientOptions {
  if (!credentials.agentId?.trim()) throw new AutomationError("invalid_input", "Agent ID is required.", false);
  if (!credentials.updateKey?.trim()) throw new AutomationError("invalid_input", "Update Key is required.", false);
  const root = parseRootKey(credentials.rootKey);
  return {
    agentId: credentials.agentId.trim(),
    updateKey: credentials.updateKey.trim(),
    baseUrl: credentials.apiBaseUrl?.trim() || DEFAULT_API_BASE_URL,
    datastore,
    environment: credentials.environment?.trim() || "prod",
    hostedEnvironment: credentials.hostedEnvironment ?? "prod",
    ...(root ? { root } : {}),
    ...(credentials.rootUrl?.trim() ? { rootUrl: credentials.rootUrl.trim() } : {}),
    ...(credentials.organizationId?.trim() ? { organizationId: credentials.organizationId.trim() } : {}),
    ...extra,
  };
}

/**
 * n8n only (self-hosted, fully offline): put a vendored `.apbundle` into an empty stored copy, so the core serves it
 * like any release it fetched. Nothing is trusted here — the SDK verifies the row (root, signature, scope, payload
 * hashes) when it loads it, and refuses a bundle that does not verify. A bundle sealed to another key cannot be read
 * here; export it with `airprompter pull --plaintext`. It serves within its manifest's lease (`leaseSeconds` from
 * when it was issued), like any stored copy that never met AirPrompter.
 */
export async function seedFromBundle(datastore: AutomationDatastore, input: { bundlePath: string; agentId: string; environment: string }): Promise<boolean> {
  const bundle = JSON.parse(readFileSync(input.bundlePath, "utf8")) as Bundle;
  const contents = openBundle(bundle, { agentId: input.agentId, target: input.environment });
  const payload = contents.manifest.payload;
  const key = { organizationId: payload.organizationId, agentId: input.agentId, target: input.environment, region: null };
  if (await datastore.latest(key)) return false;
  await datastore.putRelease(key, { generation: payload.generation, releaseDigest: payload.releaseDigest, bundle: JSON.stringify(bundle), createdAt: contents.createdAt, notAfter: contents.notAfter, rollout: rolloutOf(contents.manifest) });
  if (!(await datastore.readNote?.("organizationId"))) await datastore.writeNote?.("organizationId", payload.organizationId);
  return true;
}

/** The client for one node run. Each call on it is self-contained (a fresh SDK agent, stopped at the end). */
export async function clientFor(credentials: AirPrompterCredentials, context: N8nStorageContext | null, extra: Partial<AutomationClientOptions> = {}): Promise<AutomationClient> {
  const datastore = extra.datastore ?? datastoreFor(credentials, context);
  if (credentials.bundlePath?.trim() && (credentials.storage ?? "userFolder") === "userFolder") {
    try {
      await seedFromBundle(datastore, { bundlePath: credentials.bundlePath.trim(), agentId: credentials.agentId.trim(), environment: credentials.environment?.trim() || "prod" });
    } catch (error) {
      throw new AutomationError("invalid_input", `The starting bundle could not be read: ${(error as Error).message}`, false);
    }
  }
  return createAutomationClient(clientOptions(credentials, datastore, extra));
}
