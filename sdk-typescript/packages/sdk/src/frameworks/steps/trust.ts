/**
 * Trust for a client that keeps no files: the root it pins, the distribution key its stored copy is sealed to, and a
 * `fetch` that gives up in time.
 *
 * - **The root.** A manifest verifies against AirPrompter's root public key for the hosted environment; the key is
 *   pinned here, in source, so a change is a visible commit. `HOSTED_ROOTS` is where it goes. A root passed in the
 *   options (the local registry's `root.pub.json`) wins.
 * - **The distribution key.** What the platform stores is the sealed `.apbundle` (signed manifest + payloads,
 *   encrypted). It is sealed to an X25519 key DERIVED from the Update key, the agent and the environment (HKDF-SHA256),
 *   so the platform's storage holds ciphertext only and nothing extra has to be configured or kept. Rotating the
 *   Update key changes the key: the old copy no longer opens, and the next successful fetch writes a new one.
 * - **Timeouts.** An AirPrompter that does not answer must fail fast enough that the stored copy still serves inside
 *   the platform's step limit (Zapier: 30 s).
 *
 * @example
 * ```ts
 * const key = distributionKeyFor({ updateKey, agentId, environment: "prod" }); // same inputs → same key, every invocation
 * const root = pinnedRootFor("prod", options.root);                           // null until the production key is pinned
 * const fetch = timedFetch(globalThis.fetch, 8000);
 * ```
 */

import { createHash, createPrivateKey, createPublicKey, hkdfSync } from "node:crypto";
import type { DistributionKey, FetchLike, HostedEnvironment, P256PublicJwk } from "../../core/index.js";

/**
 * AirPrompter's root public key per hosted environment. Empty until the owner pins the production key: until then a
 * connection to the hosted service needs `root` passed in, and `testConnection` says so (`root_not_pinned`).
 */
export const HOSTED_ROOTS: Partial<Record<HostedEnvironment, P256PublicJwk>> = {};

export function pinnedRootFor(environment: HostedEnvironment, override?: P256PublicJwk): P256PublicJwk | null {
  return override ?? HOSTED_ROOTS[environment] ?? null;
}

// RFC 8410: a PKCS#8 X25519 private key is this prefix and the 32 raw bytes.
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

/** The X25519 key the stored copy is sealed to: HKDF-SHA256 over the Update key, bound to the agent and environment. */
export function distributionKeyFor(input: { updateKey: string; agentId: string; environment: string }): DistributionKey {
  const raw = Buffer.from(hkdfSync("sha256", Buffer.from(input.updateKey, "utf8"), Buffer.from("airprompter/automation-store/v1", "utf8"), Buffer.from(`${input.agentId}\u0000${input.environment}`, "utf8"), 32));
  const privateKey = createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x: string };
  return { privateKey, publicRaw: new Uint8Array(Buffer.from(jwk.x, "base64url")) };
}

/** A short, stable, non-reversible label for a connection (storage keys, logs): never the key itself. */
export function connectionLabel(input: { updateKey: string; agentId: string; environment: string }): string {
  return createHash("sha256").update(`${input.agentId}\u0000${input.environment}\u0000${input.updateKey}`).digest("hex").slice(0, 16);
}

/** `fetch` with a per-request timeout; a timeout surfaces as a network error, which the SDK treats as unreachable. */
export function timedFetch(base: typeof globalThis.fetch, timeoutMs: number): FetchLike {
  return async (input, init) => {
    // The caller's own signal (the agent's stop bound) still aborts the request; the timeout is the outer limit.
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? (typeof AbortSignal.any === "function" ? AbortSignal.any([init.signal, timeout]) : init.signal) : timeout;
    const response = await base(input, { ...(init as RequestInit), signal });
    return response as unknown as Awaited<ReturnType<FetchLike>>;
  };
}
