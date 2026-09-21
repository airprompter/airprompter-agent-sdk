/**
 * The three reads a runtime makes, over outbound HTTPS with the Agent key:
 * the edge pointer (no key), the manifest (ETag / 304), and payloads by
 * content hash (inline or a presigned redirect, which `fetch` follows).
 * Nothing here decides anything; the trust chain runs on what comes back.
 *
 * @example
 * ```ts
 * const client = new SyncClient({ baseUrl: "https://api.airprompter.com", agentId, target: "prod", apiKey: process.env.AIRPROMPTER_AGENT_KEY! });
 * const fetched = await client.manifest({ ifNoneMatch: lastEtag }); // a 304 comes back as { status: "not_modified" }
 * if (fetched.status === "ok") {
 *   const envelope = verifyManifest({ manifest: fetched.manifest, root, now, scope, storedGeneration, payloads: null });
 *   // then client.payload(contentHash) for every hash the manifest references, and verifyManifest again with the bytes
 * }
 * // 0.3.5: `release` pins the read to one seal instead of the pointer (pins.md) — never combined with `wait`.
 * const pinned = await client.manifest({ release: sealIdOf(pinnedDigest) });
 * if (pinned.status === "refused_seal") report(pinned.code); // "seal_invalid" | "release_unknown" | "release_ambiguous" | "release_not_promoted_here" | "wait_with_release"
 * ```
 */

import type { EdgePointer, Manifest } from "../protocol/types.js";

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; redirect?: "follow"; body?: string | Uint8Array }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

export interface SyncClientOptions {
  baseUrl: string;
  agentId: string;
  target: string;
  apiKey: string;
  fetch?: FetchLike;
  userAgent?: string;
}

/** 0.3.5: the five refusal codes a `?release=` read can answer (pins.md); a runtime asking without `release` never sees this variant. */
export type SealRefusalCode = "seal_invalid" | "release_unknown" | "release_ambiguous" | "release_not_promoted_here" | "wait_with_release";
const SEAL_REFUSAL_CODES: ReadonlySet<SealRefusalCode> = new Set(["seal_invalid", "release_unknown", "release_ambiguous", "release_not_promoted_here", "wait_with_release"]);

export type ManifestFetch =
  | { status: "ok"; manifest: Manifest; etag: string | null; generation: number | null; edgePointerUrl: string | null }
  | { status: "not_modified"; edgePointerUrl: string | null }
  | { status: "not_found" }
  | { status: "unauthorized" }
  | { status: "forbidden"; code: string | null }
  | { status: "refused_seal"; code: SealRefusalCode; matches?: string[] }
  | { status: "error"; httpStatus: number };

/**
 * What the control plane said when it refused a call: the message and, for a 400, the validation issues — bounded and
 * content-free (a field path and a sentence). Logged so an operator reads *why* from the SDK's own log instead of
 * reproducing the call with a probe.
 */
export interface ControlPlaneRefusal {
  message: string | null;
  issues: Array<{ path: string; message: string }>;
}

export async function readControlPlaneRefusal(response: { text(): Promise<string> }): Promise<{ code: string | null } & ControlPlaneRefusal> {
  try {
    const body = JSON.parse(await response.text()) as { error?: unknown; message?: unknown; details?: { code?: unknown; issues?: unknown } };
    const text = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : null;
    const issues = Array.isArray(body.details?.issues)
      ? body.details.issues
          .filter((issue): issue is { path?: unknown; message?: unknown } => typeof issue === "object" && issue !== null)
          .slice(0, 8)
          .map((issue) => ({ path: String(issue.path ?? "").slice(0, 120), message: String(issue.message ?? "").slice(0, 240) }))
      : [];
    return { code: typeof body.details?.code === "string" ? body.details.code : null, message: text ? text.slice(0, 240) : null, issues };
  } catch {
    return { code: null, message: null, issues: [] };
  }
}

export class SyncClient {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: SyncClientOptions) {
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    if (!this.fetchImpl) throw new Error("no fetch available: Node 20+ or pass options.fetch");
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.options.apiKey}`, "user-agent": this.options.userAgent ?? "airprompter-agent-sdk-ts", ...extra };
  }

  async edgePointer(url: string, etag: string | null): Promise<{ status: "ok"; pointer: EdgePointer; etag: string | null } | { status: "not_modified" } | { status: "unavailable" }> {
    const response = await this.fetchImpl(url, { headers: etag ? { "if-none-match": etag, "user-agent": this.options.userAgent ?? "airprompter-agent-sdk-ts" } : {} });
    if (response.status === 304) return { status: "not_modified" };
    if (response.status !== 200) return { status: "unavailable" };
    return { status: "ok", pointer: JSON.parse(await response.text()) as EdgePointer, etag: response.headers.get("etag") };
  }

  async manifest(input: { ifNoneMatch?: string | null; wait?: number; release?: string }): Promise<ManifestFetch> {
    // pins.md: `?release=` never long-polls — the release it names does not move by definition — and the platform
    // refuses the combination too (`wait_with_release`); refusing it here saves the round trip.
    if (input.wait && input.release) throw new Error("manifest: release cannot be combined with wait");
    const url = new URL(`${this.options.baseUrl}/v1/agents/${encodeURIComponent(this.options.agentId)}/targets/${this.options.target}/manifest`);
    if (input.wait) url.searchParams.set("wait", String(input.wait));
    if (input.release) url.searchParams.set("release", input.release);
    const response = await this.fetchImpl(url.toString(), { headers: this.headers(input.ifNoneMatch ? { "if-none-match": input.ifNoneMatch } : {}) });
    // The answer names the edge pointer for this target (`x-agent-edge-pointer-url`): the few hundred bytes an idle
    // puller polls at the CDN instead of here. Null on a deployment without an edge.
    const edgePointerUrl = response.headers.get("x-agent-edge-pointer-url");
    if (response.status === 304) return { status: "not_modified", edgePointerUrl };
    // 0.3.5: a pinned read's 400/404/409 may be one of the five seal refusals (pins.md) — read the body before
    // falling back to the unpinned mapping below, so an unrelated 400/404/409 (there is none today, but the shape
    // stays honest) is never silently swallowed as a seal refusal.
    if (input.release && (response.status === 400 || response.status === 404 || response.status === 409)) {
      if (response.status === 409) {
        // The 409 body is shaped `{ error, matches }` (openapi.yaml), not the common `{ error, details }` refusal —
        // `matches` lives at the top, so it is read here rather than through `readControlPlaneRefusal`.
        let matches: string[] | undefined;
        try {
          const parsed = JSON.parse(await response.text()) as { matches?: unknown };
          if (Array.isArray(parsed.matches)) matches = parsed.matches.filter((m): m is string => typeof m === "string");
        } catch {
          matches = undefined;
        }
        return { status: "refused_seal", code: "release_ambiguous", ...(matches ? { matches } : {}) };
      }
      const refusal = await readControlPlaneRefusal(response);
      if (refusal.code && (SEAL_REFUSAL_CODES as ReadonlySet<string>).has(refusal.code)) {
        return { status: "refused_seal", code: refusal.code as SealRefusalCode };
      }
    }
    if (response.status === 404) return { status: "not_found" };
    if (response.status === 401) return { status: "unauthorized" };
    if (response.status === 403) return { status: "forbidden", code: (await readControlPlaneRefusal(response)).code };
    if (response.status !== 200) return { status: "error", httpStatus: response.status };
    const generation = response.headers.get("x-agent-generation");
    return { status: "ok", manifest: JSON.parse(await response.text()) as Manifest, etag: response.headers.get("etag"), generation: generation ? Number(generation) : null, edgePointerUrl };
  }

  /** T9: the heartbeat. Content-free by schema; the response carries the cadence, the expiry and (T12) the upload grant. */
  async heartbeat(
    body: Record<string, unknown>,
  ): Promise<
    | { status: "ok"; response: Record<string, unknown> }
    | ({ status: "refused"; httpStatus: number; code: string | null } & ControlPlaneRefusal)
    | { status: "error"; httpStatus: number }
  > {
    const url = `${this.options.baseUrl}/v1/agents/${encodeURIComponent(this.options.agentId)}/targets/${this.options.target}/heartbeat`;
    const response = await this.fetchImpl(url, { method: "POST", headers: this.headers({ "content-type": "application/json" }), body: JSON.stringify(body) });
    if (response.status === 200) return { status: "ok", response: JSON.parse(await response.text()) as Record<string, unknown> };
    if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 429) {
      return { status: "refused", httpStatus: response.status, ...(await readControlPlaneRefusal(response)) };
    }
    return { status: "error", httpStatus: response.status };
  }

  async payload(contentHash: string): Promise<Buffer | null> {
    const url = `${this.options.baseUrl}/v1/agents/${encodeURIComponent(this.options.agentId)}/payloads/${contentHash}`;
    const response = await this.fetchImpl(url, { headers: this.headers(), redirect: "follow" });
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error(`payload ${contentHash}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
}
