/**
 * A fake control plane for SDK tests: an offline root ceremony, a signing
 * key, sealed manifests per generation, payloads by hash, an edge pointer —
 * served through a `fetch` the SDK takes as an option. Signs exactly as the
 * hosted service does (canonical payload bytes, ES256, P1363).
 */

import { generateKeyPairSync } from "node:crypto";

import { canonicalBytes, sha256Prefixed } from "../protocol/canonicalJson.js";
import { keyThumbprint, publicJwkOf, releaseDigest, signBytes } from "../protocol/trust.js";
import { experimentsOf } from "../protocol/types.js";
import type { Manifest, ManifestPayload, ManifestSlot, P256PrivateJwk, RootMetadata, RootMetadataSigned, Target } from "../protocol/types.js";
import type { FetchLike } from "../control/client.js";
import { PROTOCOL_VERSION } from "../protocol/version.js";

/** The protocol version this checkout of the repository declares; manifests the fake signs carry it. */
export const PROTOCOL = PROTOCOL_VERSION;

export function newKey(): P256PrivateJwk {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  return { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y!, d: jwk.d! };
}

export function rootDocument(input: { rootKey: P256PrivateJwk; signingKeys: P256PrivateJwk[]; environment: Target; version?: number; expires?: string; purpose?: "platform" | "countersign" }): RootMetadata {
  const keys: RootMetadataSigned["keys"] = {};
  const rootId = keyThumbprint(input.rootKey);
  keys[rootId] = { keyType: "ecdsa-p256", scheme: "ES256", publicKey: publicJwkOf(input.rootKey) };
  const targetIds = input.signingKeys.map((key) => {
    const id = keyThumbprint(key);
    keys[id] = { keyType: "ecdsa-p256", scheme: "ES256", publicKey: publicJwkOf(key) };
    return id;
  });
  const signed: RootMetadataSigned = {
    type: "root",
    protocol: PROTOCOL,
    purpose: input.purpose ?? "platform",
    environment: input.environment,
    version: input.version ?? 1,
    expires: input.expires ?? "2027-12-11T00:00:00Z",
    keys,
    roles: { root: { keyIds: [rootId], threshold: 1 }, targets: { keyIds: targetIds, threshold: 1 } },
  };
  return { signed, signatures: [{ keyId: rootId, alg: "ES256", sig: signBytes(canonicalBytes(signed), input.rootKey) }] };
}

export interface SlotSpec {
  tag: string;
  text: string;
  model?: string;
  variables?: ManifestSlot["variables"];
  versionId?: string;
  steps?: Array<{ text: string; versionId?: string }>;
}

export class FakeControlPlane {
  readonly rootKey: P256PrivateJwk;
  readonly signingKey: P256PrivateJwk;
  readonly root: RootMetadata;
  readonly payloads = new Map<string, Buffer>();
  readonly requests: string[] = [];
  private current: { manifest: Manifest; bytes: Buffer; etag: string } | null = null;
  generation = 0;
  edgeEtag = 0;
  requireCountersign = false;

  /**
   * Fresh keys by default (a test). `airprompter dev` (S12) hands in the keys it persisted, so the root a customer
   * pinned yesterday still verifies today's generations.
   */
  constructor(
    readonly scope: { organizationId: string; agentId: string; target: Target },
    readonly apiKey = "apa_live_testkey",
    keys: { rootKey?: P256PrivateJwk; signingKey?: P256PrivateJwk } = {},
  ) {
    this.rootKey = keys.rootKey ?? newKey();
    this.signingKey = keys.signingKey ?? newKey();
    this.root = rootDocument({ rootKey: this.rootKey, signingKeys: [this.signingKey], environment: scope.target });
  }

  slot(spec: SlotSpec): ManifestSlot {
    const bytes = Buffer.from(spec.text, "utf8");
    const hash = sha256Prefixed(bytes);
    this.payloads.set(hash, bytes);
    const slot: ManifestSlot = {
      tag: spec.tag,
      kind: spec.steps ? "workflow" : "prompt",
      artifactId: `art_${spec.tag}`,
      versionId: spec.versionId ?? `ver_${spec.tag}_1`,
      versionOrdinal: 1,
      contentHash: hash,
      byteLength: bytes.length,
      model: spec.model ?? "claude-sonnet-5",
      variables: spec.variables ?? [],
    };
    if (spec.steps) {
      slot.steps = spec.steps.map((step, index) => {
        const stepBytes = Buffer.from(step.text, "utf8");
        const stepHash = sha256Prefixed(stepBytes);
        this.payloads.set(stepHash, stepBytes);
        return { stepId: `${spec.tag}#${index + 1}`, ordinal: index + 1, promptArtifactId: `art_${spec.tag}_${index + 1}`, promptVersionId: step.versionId ?? `ver_${spec.tag}_step${index + 1}`, contentHash: stepHash, byteLength: stepBytes.length };
      });
    }
    return slot;
  }

  /** Seal and promote: generation + 1, signed with the signing key. */
  /** T9: every heartbeat body the fake accepted, and what it answers (a test may change the cadence). */
  readonly heartbeats: Array<Record<string, unknown>> = [];
  heartbeatIntervalSeconds = 300;
  heartbeatRefusal: { status: number; code: string | null; message?: string; issues?: Array<{ path: string; message: string }> } | null = null;
  /**
   * T26: the grant issuer and a fake S3 behind it. With `grantBaseUrl` set, every accepted heartbeat answers an
   * `uploadGrant` for the body's instance prefix (or `retryAfterSeconds` while `grantHold` is set); the POST endpoint at
   * `<grantBaseUrl>/s3/agent-telemetry` checks the policy the way the bucket would and keeps the objects by key.
   */
  grantBaseUrl: string | null = null;
  /** S3: a party between the fleet and the edge pins the pointer at this generation; the origin moves on regardless. */
  pinnedPointer: { generation: number } | null = null;
  /** S3: whether the heartbeat answer names the origin's generation (an older service does not). */
  heartbeatLatestGeneration = true;
  grantTtlMs = 15 * 60 * 1000;
  grantHold: { retryAfterSeconds: number } | null = null;
  uploadIntervalSeconds = 300;
  readonly grants: Array<{ grantId: string; instanceId: string; keyPrefix: string; expiresAt: string }> = [];
  readonly objects = new Map<string, Buffer>();
  readonly uploads: string[] = [];
  /** A test may fail the next N POSTs (a 500) to exercise backoff. */
  failNextUploads = 0;
  /** The issuer's and the bucket's clock (grant expiry, policy expiry); a test drives it beside the uploader's. */
  now: () => number = () => Date.now();
  private grantSeq = 0;

  private issueGrant(instanceId: string, now: number): Record<string, unknown> {
    const grantId = `grant_${String(++this.grantSeq).padStart(4, "0")}_${instanceId.slice(0, 8)}`.replace(/[^A-Za-z0-9_-]/g, "_").padEnd(16, "0");
    const keyPrefix = `org/${this.scope.organizationId}/agent/${this.scope.agentId}/${this.scope.target}/${instanceId}/`;
    const expiresAt = new Date(now + this.grantTtlMs).toISOString();
    const policy = Buffer.from(JSON.stringify({ expiration: expiresAt, conditions: [["starts-with", "$key", keyPrefix], ["content-length-range", 0, 1048576], { "Content-Type": "application/x-ndjson" }, { "x-amz-meta-grant-id": grantId }] })).toString("base64");
    this.grants.push({ grantId, instanceId, keyPrefix, expiresAt });
    return {
      grantId,
      url: `${this.grantBaseUrl}/s3/agent-telemetry`,
      fields: { policy, "x-amz-algorithm": "AWS4-HMAC-SHA256", "x-amz-credential": "AKIAFAKE/20260912/eu-west-1/s3/aws4_request", "x-amz-date": "20260912T000000Z", "x-amz-signature": "fake", "x-amz-server-side-encryption": "aws:kms", "x-amz-server-side-encryption-aws-kms-key-id": "arn:aws:kms:eu-west-1:000000000000:key/fake", "x-amz-meta-grant-id": grantId },
      keyPrefix,
      expiresAt,
      maxObjectBytes: 1048576,
      contentType: "application/x-ndjson",
    };
  }

  /** The bucket's side of a presigned POST: the policy's conditions, the expiry, the size cap; nothing else is looked at. */
  private acceptUpload(init: { headers?: Record<string, string>; body?: string | Uint8Array } | undefined, now: number): { status: number; body: string } {
    const contentType = init?.headers?.["content-type"] ?? "";
    const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
    if (!boundary || !init?.body) return { status: 400, body: "<Error><Code>MalformedPOSTRequest</Code></Error>" };
    const raw = typeof init.body === "string" ? Buffer.from(init.body, "utf8") : Buffer.from(init.body);
    const fields = new Map<string, Buffer>();
    const marker = Buffer.from(`--${boundary}`);
    let offset = raw.indexOf(marker);
    while (offset !== -1) {
      const next = raw.indexOf(marker, offset + marker.length);
      if (next === -1) break;
      const part = raw.subarray(offset + marker.length + 2, next - 2); // skip CRLF after the marker; drop CRLF before the next
      const headerEnd = part.indexOf("\r\n\r\n");
      const headers = part.subarray(0, headerEnd).toString("utf8");
      const name = /name="([^"]+)"/.exec(headers)?.[1];
      if (name) fields.set(name, part.subarray(headerEnd + 4));
      offset = next;
    }
    if (this.failNextUploads > 0) {
      this.failNextUploads -= 1;
      return { status: 500, body: "<Error><Code>InternalError</Code></Error>" };
    }
    const policyText = fields.get("policy")?.toString("utf8");
    const policy = policyText ? (JSON.parse(Buffer.from(policyText, "base64").toString("utf8")) as { expiration: string; conditions: unknown[] }) : null;
    if (!policy) return { status: 403, body: "<Error><Code>AccessDenied</Code><Message>Invalid according to Policy: Policy missing</Message></Error>" };
    if (Date.parse(policy.expiration) <= now) return { status: 403, body: "<Error><Code>AccessDenied</Code><Message>Invalid according to Policy: Policy expired.</Message></Error>" };
    const key = fields.get("key")?.toString("utf8") ?? "";
    const grantId = fields.get("x-amz-meta-grant-id")?.toString("utf8");
    const grant = this.grants.find((g) => g.grantId === grantId);
    if (!grant || !key.startsWith(grant.keyPrefix)) return { status: 403, body: "<Error><Code>AccessDenied</Code><Message>Invalid according to Policy: Policy Condition failed: [\"starts-with\", \"$key\", ...]</Message></Error>" };
    if (fields.get("Content-Type")?.toString("utf8") !== "application/x-ndjson") return { status: 403, body: "<Error><Code>AccessDenied</Code><Message>Invalid according to Policy: Content-Type</Message></Error>" };
    if (fields.get("x-amz-server-side-encryption")?.toString("utf8") !== "aws:kms") return { status: 403, body: "<Error><Code>AccessDenied</Code><Message>Invalid according to Policy: SSE</Message></Error>" };
    const file = fields.get("file");
    if (!file) return { status: 400, body: "<Error><Code>InvalidArgument</Code><Message>POST requires exactly one file upload per request.</Message></Error>" };
    if (file.length > 1048576) return { status: 400, body: "<Error><Code>EntityTooLarge</Code></Error>" };
    this.objects.set(key, Buffer.from(file));
    this.uploads.push(key);
    return { status: 204, body: "" };
  }

  promote(slots: ManifestSlot[], options: Partial<Pick<ManifestPayload, "applyPolicy" | "leaseSeconds" | "experiment" | "experiments" | "directives" | "onLeaseExpiry" | "unlockWindow">> & { signWith?: P256PrivateJwk; generation?: number } = {}): Manifest {
    const sorted = [...slots].sort((a, b) => (a.tag < b.tag ? -1 : 1));
    this.generation = options.generation ?? this.generation + 1;
    const payload: ManifestPayload = {
      protocol: PROTOCOL,
      ...this.scope,
      generation: this.generation,
      releaseDigest: releaseDigest(sorted),
      issuedAt: new Date().toISOString(),
      leaseSeconds: options.leaseSeconds ?? 3600,
      onLeaseExpiry: options.onLeaseExpiry ?? "degrade",
      applyPolicy: options.applyPolicy ?? "auto",
      ...(options.unlockWindow ? { unlockWindow: options.unlockWindow } : {}),
      requireCountersign: this.requireCountersign,
      slots: sorted,
      ...(options.experiment ? { experiment: options.experiment } : {}),
      ...(options.experiments ? { experiments: options.experiments } : {}),
      directives: options.directives ?? [],
    };
    const signer = options.signWith ?? this.signingKey;
    const manifest: Manifest = { payload, signatures: [{ keyId: keyThumbprint(signer), alg: "ES256", sig: signBytes(canonicalBytes(payload), signer) }], countersignatures: [] };
    const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
    this.current = { manifest, bytes, etag: sha256Prefixed(bytes) };
    this.edgeEtag += 1;
    return manifest;
  }

  get manifest(): Manifest | null {
    return this.current?.manifest ?? null;
  }

  /** The `fetch` the SDK sees. */
  fetch(): FetchLike {
    const respond = (status: number, body: Buffer | string = "", headers: Record<string, string> = {}) => ({
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      /** Every header, for a test that bridges this fake onto a real HTTP listener. */
      headerEntries: Object.entries(headers),
      arrayBuffer: async () => {
        // A Buffer may be a view into a shared pool: copy exactly its bytes, never the pool.
        const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
        return new Uint8Array(bytes).buffer as ArrayBuffer;
      },
      text: async () => (typeof body === "string" ? body : body.toString("utf8")),
    });
    return async (url, init) => {
      this.requests.push(url);
      const auth = init?.headers?.authorization ?? init?.headers?.Authorization;
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/generation.json")) {
        if (!this.current) return respond(404);
        if (this.pinnedPointer) {
          // The pinned pointer: the same stale answer, the same ETag, forever.
          const pinnedEtag = `"edge-pinned-${this.pinnedPointer.generation}"`;
          if (init?.headers?.["if-none-match"] === pinnedEtag) return respond(304);
          return respond(200, JSON.stringify({ generation: this.pinnedPointer.generation, releaseDigest: this.current.manifest.payload.releaseDigest, leaseSeconds: this.current.manifest.payload.leaseSeconds }), { etag: pinnedEtag });
        }
        const etag = `"edge-${this.edgeEtag}"`;
        if (init?.headers?.["if-none-match"] === etag) return respond(304);
        return respond(200, JSON.stringify({ generation: this.current.manifest.payload.generation, releaseDigest: this.current.manifest.payload.releaseDigest, leaseSeconds: this.current.manifest.payload.leaseSeconds }), { etag });
      }
      if (parsed.pathname.endsWith("/root.json")) return respond(200, JSON.stringify(this.root));
      if (parsed.pathname === "/s3/agent-telemetry") {
        const reply = this.acceptUpload(init, this.now());
        return respond(reply.status, reply.body, { "content-type": "application/xml" });
      }
      if (auth !== `Bearer ${this.apiKey}`) return respond(401, JSON.stringify({ error: "Unauthorized" }));
      // T23: the hosted catalogue — the manifest's tags, variables, step ids and experiment, no payloads.
      const slotsMatch = /^\/v1\/agents\/([^/]+)\/targets\/([^/]+)\/slots$/.exec(parsed.pathname);
      if (slotsMatch) {
        if (slotsMatch[1] !== this.scope.agentId || slotsMatch[2] !== this.scope.target) return respond(403, JSON.stringify({ error: "Forbidden", code: "forbidden", detail: slotsMatch[1] !== this.scope.agentId ? "agent_mismatch" : "target_mismatch" }));
        if (!this.current) return respond(404, JSON.stringify({ error: "nothing is promoted to this environment", code: "nothing_promoted" }));
        const payload = this.current.manifest.payload;
        return respond(200, JSON.stringify({ agentId: payload.agentId, target: payload.target, generation: payload.generation, releaseDigest: payload.releaseDigest, slots: payload.slots.map((pin) => ({ tag: pin.tag, kind: pin.kind, model: pin.model, variables: pin.variables, steps: pin.steps ? pin.steps.map((s) => ({ stepId: s.stepId })) : null })), experiment: payload.experiment ? { salt: payload.experiment.salt, subjectKey: payload.experiment.subjectKey, arms: payload.experiment.arms.map((a) => a.arm) } : null, experiments: experimentsOf(payload).map((e) => ({ experimentId: e.experimentId, tag: e.tag ?? null, salt: e.salt, subjectKey: e.subjectKey, arms: e.arms.map((a) => a.arm) })) }), { "x-agent-generation": String(payload.generation) });
      }
      // T9: the heartbeat — the protocol schema's required keys, content-free; answers the cadence and the expiry.
      const heartbeatMatch = /^\/v1\/agents\/([^/]+)\/targets\/([^/]+)\/heartbeat$/.exec(parsed.pathname);
      if (heartbeatMatch) {
        if (heartbeatMatch[1] !== this.scope.agentId || heartbeatMatch[2] !== this.scope.target) return respond(403, JSON.stringify({ error: "x", details: { code: heartbeatMatch[1] !== this.scope.agentId ? "agent_mismatch" : "target_mismatch" } }));
        if (this.heartbeatRefusal) return respond(this.heartbeatRefusal.status, JSON.stringify({ error: this.heartbeatRefusal.message ?? "x", details: { code: this.heartbeatRefusal.code, ...(this.heartbeatRefusal.issues ? { issues: this.heartbeatRefusal.issues } : {}) } }));
        const body = JSON.parse(typeof init?.body === "string" ? init.body : init?.body ? Buffer.from(init.body).toString("utf8") : "{}") as Record<string, unknown>;
        // The real schema admits four reporters; anything else is the platform's 400 with its zod issues.
        const reporter = (body.sdk as { name?: unknown } | undefined)?.name;
        if (!["agent-sdk-typescript", "agent-sdk-python", "airprompter-cli", "airprompterd"].includes(String(reporter))) {
          return respond(400, JSON.stringify({ error: "The heartbeat body does not match the protocol", details: { issues: [{ path: "sdk.name", message: `Invalid enum value. Expected 'agent-sdk-typescript' | 'agent-sdk-python' | 'airprompter-cli' | 'airprompterd', received '${String(reporter)}'` }] } }));
        }
        for (const key of ["protocol", "instanceId", "sdk", "syncMode", "generation", "applyState", "storageProtection", "catalog", "lease", "spool"]) {
          if (!(key in body)) return respond(400, JSON.stringify({ error: `heartbeat: missing ${key}` }));
        }
        for (const key of Object.keys(body)) {
          if (!["protocol", "instanceId", "instanceClass", "sdk", "host", "syncMode", "heartbeatIntervalSeconds", "generation", "activeReleaseDigest", "stagedReleaseDigest", "applyState", "refusal", "signingKeyId", "storageProtection", "catalog", "lease", "localRollback", "spool", "unlockRequestsSeen", "disabled", "applyPolicy"].includes(key)) return respond(400, JSON.stringify({ error: `heartbeat: unknown ${key}` }));
        }
        this.heartbeats.push(body);
        const answer: Record<string, unknown> = { pollSeconds: 30, uploadIntervalSeconds: this.uploadIntervalSeconds, heartbeatIntervalSeconds: this.heartbeatIntervalSeconds, expiresAt: new Date(Date.now() + this.heartbeatIntervalSeconds * 3000).toISOString() };
        // S3: the authenticated answer names the origin's generation; a runtime whose pointer says less goes to the manifest.
        if (this.heartbeatLatestGeneration) answer.latestGeneration = this.current?.manifest.payload.generation ?? 0;
        if (this.grantBaseUrl) {
          if (this.grantHold) answer.retryAfterSeconds = this.grantHold.retryAfterSeconds;
          else answer.uploadGrant = this.issueGrant(String(body.instanceId), this.now());
        }
        return respond(200, JSON.stringify(answer), { "content-type": "application/json" });
      }
      const manifestMatch = /^\/v1\/agents\/([^/]+)\/targets\/([^/]+)\/manifest$/.exec(parsed.pathname);
      if (manifestMatch) {
        if (manifestMatch[1] !== this.scope.agentId) return respond(403, JSON.stringify({ error: "x", details: { code: "agent_mismatch" } }));
        if (manifestMatch[2] !== this.scope.target) return respond(403, JSON.stringify({ error: "x", details: { code: "target_mismatch" } }));
        if (!this.current) return respond(404, JSON.stringify({ error: "Not found" }));
        if (init?.headers?.["if-none-match"] === this.current.etag) return respond(304, "", { etag: this.current.etag });
        return respond(200, this.current.bytes, { etag: this.current.etag, "x-agent-generation": String(this.current.manifest.payload.generation), "content-type": "application/json" });
      }
      const payloadMatch = /^\/v1\/agents\/([^/]+)\/payloads\/(sha256:[0-9a-f]{64})$/.exec(parsed.pathname);
      if (payloadMatch) {
        const bytes = this.payloads.get(payloadMatch[2]!);
        return bytes ? respond(200, bytes) : respond(404, JSON.stringify({ error: "Not found" }));
      }
      return respond(404, JSON.stringify({ error: "Not found" }));
    };
  }
}

/** The fake behind a real HTTP listener, for daemons and CLIs that run as their own process — and `airprompter dev` (S12). */
export async function serveOverHttp(plane: FakeControlPlane, listen: { host?: string; port?: number } = {}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const { createServer } = await import("node:http");
  const fetchImpl = plane.fetch();
  const server = createServer((request, response) => {
    void (async () => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers[name.toLowerCase()] = value;
      const url = `http://${request.headers.host ?? "127.0.0.1"}${request.url ?? "/"}`;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      const body = raw.length === 0 ? undefined : headers["content-type"]?.startsWith("multipart/") ? raw : raw.toString("utf8");
      const result = (await fetchImpl(url, { method: request.method ?? "GET", headers, ...(body !== undefined ? { body } : {}) })) as Awaited<ReturnType<FetchLike>> & { headerEntries?: Array<[string, string]> };
      const answer = Buffer.from(await result.arrayBuffer());
      response.writeHead(result.status, Object.fromEntries(result.headerEntries ?? []));
      response.end(answer);
    })();
  });
  const host = listen.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listen.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as { port: number };
  return { baseUrl: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
