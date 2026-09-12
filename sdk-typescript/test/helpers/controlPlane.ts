/**
 * A fake control plane for SDK tests: an offline root ceremony, a signing
 * key, sealed manifests per generation, payloads by hash, an edge pointer —
 * served through a `fetch` the SDK takes as an option. Signs exactly as the
 * hosted service does (canonical payload bytes, ES256, P1363).
 */

import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";

import { canonicalBytes, sha256Prefixed } from "../../src/protocol/canonicalJson.js";
import { keyThumbprint, publicJwkOf, releaseDigest, signBytes } from "../../src/protocol/trust.js";
import type { Manifest, ManifestPayload, ManifestSlot, P256PrivateJwk, RootMetadata, RootMetadataSigned, Target } from "../../src/protocol/types.js";
import type { FetchLike } from "../../src/sync/client.js";

/** The protocol version this checkout of the repository declares; manifests the fake signs carry it. */
export const PROTOCOL = readFileSync(new URL("../../../protocol/VERSION", import.meta.url), "utf8").trim();

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
  readonly rootKey = newKey();
  readonly signingKey = newKey();
  readonly root: RootMetadata;
  readonly payloads = new Map<string, Buffer>();
  readonly requests: string[] = [];
  private current: { manifest: Manifest; bytes: Buffer; etag: string } | null = null;
  generation = 0;
  edgeEtag = 0;
  requireCountersign = false;

  constructor(
    readonly scope: { organizationId: string; agentId: string; target: Target },
    readonly apiKey = "apa_live_testkey",
  ) {
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
  promote(slots: ManifestSlot[], options: Partial<Pick<ManifestPayload, "applyPolicy" | "leaseSeconds" | "experiment" | "directives" | "onLeaseExpiry">> & { signWith?: P256PrivateJwk; generation?: number } = {}): Manifest {
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
      requireCountersign: this.requireCountersign,
      slots: sorted,
      ...(options.experiment ? { experiment: options.experiment } : {}),
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
        const etag = `"edge-${this.edgeEtag}"`;
        if (init?.headers?.["if-none-match"] === etag) return respond(304);
        return respond(200, JSON.stringify({ generation: this.current.manifest.payload.generation, releaseDigest: this.current.manifest.payload.releaseDigest, leaseSeconds: this.current.manifest.payload.leaseSeconds }), { etag });
      }
      if (parsed.pathname.endsWith("/root.json")) return respond(200, JSON.stringify(this.root));
      if (auth !== `Bearer ${this.apiKey}`) return respond(401, JSON.stringify({ error: "Unauthorized" }));
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
