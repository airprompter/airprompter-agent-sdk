/**
 * The Zapier connection: custom auth over an agent's Update key, the client each step builds from it, and the one
 * place an `AutomationError` becomes a Zapier error.
 *
 * Fields: the agent id, the Update key (a password field), the environment the key is bound to (default `prod`), the
 * API base URL (default the production API; a dev registry or AirPrompter stage overrides it), and an advanced root
 * key for a registry this app does not pin a root for (`airprompter dev` prints `root.pub.json`).
 *
 * Errors, mapped for Zapier's own retry semantics:
 * - `unauthorized` → `ExpiredAuthError` (Zapier asks the user to reconnect);
 * - retryable (AirPrompter unreachable with nothing usable stored, a report not delivered, a lapsed lease, storage
 *   down) → `ThrottledError` with a delay, so Zapier runs the step again later instead of dropping it;
 * - everything else (a slot that is not in the release, a missing variable, a disabled slot, a tampered copy with
 *   AirPrompter answering) → `z.errors.Error` with the code: the step fails with a sentence that says what to fix.
 *
 * @example
 * ```ts
 * const perform = async (z, bundle) => withClient(z, bundle, (client) => client.listSlots());
 * ```
 */

import type { Bundle, ZObject } from "zapier-platform-core";
import type { HostedEnvironment, P256PublicJwk } from "@airprompter/agent-sdk/core";
import { connectionLabel, createAutomationClient, isAutomationError, type AutomationClient } from "../core/index.js";
import { zapierDatastore, type ZapierCache } from "./storage.js";

export const PRODUCTION_API = "https://api.airprompter.com";
/** How long Zapier waits before running a retryable step again. */
export const RETRY_AFTER_SECONDS = 120;

export interface AuthData {
  agentId: string;
  updateKey: string;
  environment?: string;
  baseUrl?: string;
  rootKey?: string;
}

/** Which hosted root signs this API's manifests: production for the production API, else the stage the environment names. */
export function hostedEnvironmentOf(baseUrl: string, environment: string): HostedEnvironment {
  if (baseUrl.replace(/\/+$/, "") === PRODUCTION_API) return "prod";
  return environment === "staging" || environment === "prod" ? environment : "dev";
}

function rootOf(raw: string | undefined): P256PublicJwk | undefined {
  if (!raw || !raw.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Root key must be the JSON of a public key ({\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":…,\"y\":…}).");
  }
  const jwk = parsed as Partial<P256PublicJwk>;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") throw new Error("Root key must be a P-256 public JWK.");
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

/** HTTPS only, except a registry on this machine (`airprompter dev`); never a path, query or credentials in the URL. */
export function baseUrlOf(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`API base URL is not a URL: ${raw}`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("API base URL must use https.");
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("API base URL is the origin only, like https://api.airprompter.com.");
  return url.origin;
}

export function clientFor(z: ZObject, bundle: Bundle, overrides: { now?: () => number } = {}): AutomationClient {
  const auth = bundle.authData as unknown as AuthData;
  const agentId = String(auth.agentId ?? "").trim();
  const updateKey = String(auth.updateKey ?? "").trim();
  const environment = String(auth.environment ?? "").trim() || "prod";
  const baseUrl = baseUrlOf(String(auth.baseUrl ?? "").trim() || PRODUCTION_API);
  const root = rootOf(auth.rootKey);
  return createAutomationClient({
    agentId,
    updateKey,
    baseUrl,
    environment,
    hostedEnvironment: hostedEnvironmentOf(baseUrl, environment),
    ...(root ? { root } : {}),
    datastore: zapierDatastore(z.cache as unknown as ZapierCache, connectionLabel({ updateKey, agentId, environment })),
    ...(overrides.now ? { now: overrides.now } : {}),
    logger: (event) => z.console.log(JSON.stringify(event)),
  });
}

/** Run with a client; turn an `AutomationError` into the Zapier error with the right retry behaviour. */
export async function withClient<T>(z: ZObject, bundle: Bundle, body: (client: AutomationClient) => Promise<T>): Promise<T> {
  try {
    return await body(clientFor(z, bundle));
  } catch (error) {
    throw zapierError(z, error);
  }
}

export function zapierError(z: ZObject, error: unknown): Error {
  if (!isAutomationError(error)) return error instanceof Error ? error : new Error(String(error));
  if (error.code === "unauthorized") return new z.errors.ExpiredAuthError(error.message);
  if (error.retryable) return new z.errors.ThrottledError(error.message, RETRY_AFTER_SECONDS);
  return new z.errors.Error(error.message, error.code, 400);
}

export const authentication = {
  type: "custom" as const,
  fields: [
    { key: "agentId", label: "Agent ID", required: true, type: "string" as const, helpText: "The agent in AirPrompter (Agents › your agent) whose approved prompts these steps serve." },
    { key: "updateKey", label: "Update key", required: true, type: "password" as const, helpText: "An Update key for that agent, from Agents › Keys. It is bound to one agent and one environment and can only read approved releases." },
    { key: "environment", label: "Environment", required: false, type: "string" as const, default: "prod", helpText: "The environment the Update key is bound to (usually `prod`)." },
    { key: "baseUrl", label: "API base URL", required: false, type: "string" as const, default: PRODUCTION_API, helpText: "Leave as is. Change it only to test against a development registry." },
    { key: "rootKey", label: "Root key (advanced)", required: false, type: "text" as const, helpText: "Only for a development registry: the JSON of its root public key (`root.pub.json`). Leave empty for AirPrompter." },
  ],
  test: async (z: ZObject, bundle: Bundle) => {
    const result = await withClient(z, bundle, (client) => client.testConnection());
    if (!result.ok) throw new z.errors.Error(result.reason, "connection_failed", 401);
    return result;
  },
  connectionLabel: (_z: ZObject, bundle: Bundle) => {
    const auth = bundle.authData as unknown as AuthData;
    return `${auth.agentId} (${auth.environment || "prod"})`;
  },
};
