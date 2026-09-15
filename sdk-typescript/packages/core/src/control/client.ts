/**
 * The three reads a runtime makes, over outbound HTTPS with the Agent key:
 * the edge pointer (no key), the manifest (ETag / 304), and payloads by
 * content hash (inline or a presigned redirect, which `fetch` follows).
 * Nothing here decides anything; the trust chain runs on what comes back.
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

export type ManifestFetch =
  | { status: "ok"; manifest: Manifest; etag: string | null; generation: number | null }
  | { status: "not_modified" }
  | { status: "not_found" }
  | { status: "unauthorized" }
  | { status: "forbidden"; code: string | null }
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

  async manifest(input: { ifNoneMatch?: string | null; wait?: number }): Promise<ManifestFetch> {
    const url = new URL(`${this.options.baseUrl}/v1/agents/${encodeURIComponent(this.options.agentId)}/targets/${this.options.target}/manifest`);
    if (input.wait) url.searchParams.set("wait", String(input.wait));
    const response = await this.fetchImpl(url.toString(), { headers: this.headers(input.ifNoneMatch ? { "if-none-match": input.ifNoneMatch } : {}) });
    if (response.status === 304) return { status: "not_modified" };
    if (response.status === 404) return { status: "not_found" };
    if (response.status === 401) return { status: "unauthorized" };
    if (response.status === 403) return { status: "forbidden", code: (await readControlPlaneRefusal(response)).code };
    if (response.status !== 200) return { status: "error", httpStatus: response.status };
    const generation = response.headers.get("x-agent-generation");
    return { status: "ok", manifest: JSON.parse(await response.text()) as Manifest, etag: response.headers.get("etag"), generation: generation ? Number(generation) : null };
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
