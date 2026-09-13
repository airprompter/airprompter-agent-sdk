/**
 * Wire types for protocol 0.2 — hand-written to match `protocol/schemas/*`.
 * The conformance vectors, not these types, are what proves agreement; keep
 * them narrow and let the schema tests catch drift.
 */

export type Target = "dev" | "staging" | "prod";
export type Sha256 = `sha256:${string}`;

export interface SlotVariable {
  name: string;
  required: boolean;
  trust: "operator" | "end_user";
}

export interface SlotStep {
  stepId: string;
  ordinal: number;
  promptArtifactId: string;
  promptVersionId: string;
  contentHash: Sha256;
  byteLength: number;
}

/** One declared output check as a pin carries it (checks.md): the kind's own members only. */
export type OutputCheck =
  | { kind: "json_schema"; name: string; schema: Record<string, unknown> }
  | { kind: "enum"; name: string; path: string; values: string[] }
  | { kind: "length"; name: string; minTokens?: number; maxTokens?: number }
  | { kind: "must_match" | "must_not_match"; name: string; pattern: string; flags?: "i" };

export interface ManifestSlot {
  tag: string;
  kind: "prompt" | "workflow";
  artifactId: string;
  versionId: string;
  versionOrdinal: number | null;
  contentHash: Sha256;
  byteLength: number;
  model: string;
  /** The model is required: a runtime whose declared catalog lacks it refuses the release (`model_unavailable`). In the digest input only when true. */
  modelRequired?: boolean;
  /** T29: the slot's enabled output checks (checks.md), sorted by name; in the digest input only when present. */
  outputChecks?: OutputCheck[];
  /** T34: the slot's golden set (golden-sets.md) — a reference to a payload the runtime opens and runs before activation; in the digest input only when present. */
  goldenSet?: GoldenSetRef;
  variables: SlotVariable[];
  steps?: SlotStep[];
}

/** T34: what the pin carries — the cases themselves are the payload under `contentHash`. */
export interface GoldenSetRef {
  setId: string;
  cases: number;
  contentHash: Sha256;
  byteLength: number;
  /** Pass-rate floor in basis points; below it a staged release is not activated. */
  minPassBps: number;
}

export interface ExperimentArm {
  arm: string;
  weightBps: number;
  releaseDigest: Sha256;
  overrides: ManifestSlot[];
}

export interface Experiment {
  experimentId: string;
  salt: string;
  subjectKey: "request" | "instance";
  arms: ExperimentArm[];
}

export type Directive =
  | { kind: "request_unlock"; releaseDigest: Sha256; requestedBy: string; requestedAt: string; expiresAt: string; note?: string }
  | { kind: "disable"; scope: "agent" | "slot"; tag?: string; issuedAt: string; reason?: string };

/**
 * S4: the set of directive kinds a runtime honours is closed. `disable` is the one kind that acts without a
 * local act (a reduction: it only ever stops serving); `request_unlock` is a request the runtime surfaces and
 * never grants. A manifest carrying any other kind is refused whole (`directive_unknown`) — never partly obeyed.
 */
export const DIRECTIVE_KINDS: ReadonlySet<string> = new Set<Directive["kind"]>(["request_unlock", "disable"]);

/** S4: the apply policy a host holds, as store.json records it. */
export type ApplyPolicy = "auto" | "unlock_required";

export interface ManifestPayload {
  protocol: string;
  organizationId: string;
  agentId: string;
  target: Target;
  generation: number;
  releaseDigest: Sha256;
  previousReleaseDigest?: Sha256;
  issuedAt: string;
  leaseSeconds: number;
  onLeaseExpiry: "degrade" | "halt";
  applyPolicy: "auto" | "unlock_required";
  /** T9: the console's update window (advisory; a local `apply.window` wins). Only with `unlock_required`. */
  unlockWindow?: { timezone: string; start: string; end: string; days?: Array<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun"> };
  requireCountersign: boolean;
  slots: ManifestSlot[];
  experiment?: Experiment;
  directives: Directive[];
}

export interface Signature {
  keyId: string;
  alg: "ES256";
  sig: string;
}

export interface Countersignature extends Signature {
  releaseDigest: Sha256;
  signedAt: string;
}

export interface Manifest {
  payload: ManifestPayload;
  signatures: Signature[];
  countersignatures?: Countersignature[];
}

export interface P256PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

export interface P256PrivateJwk extends P256PublicJwk {
  d: string;
}

export interface RootKeyEntry {
  keyType: "ecdsa-p256";
  scheme: "ES256";
  publicKey: P256PublicJwk;
  notBefore?: string;
  notAfter?: string;
}

export interface RootRole {
  keyIds: string[];
  threshold: number;
}

export interface RootMetadataSigned {
  type: "root";
  protocol: string;
  purpose: "platform" | "countersign";
  environment: Target;
  version: number;
  expires: string;
  keys: Record<string, RootKeyEntry>;
  roles: { root: RootRole; targets: RootRole };
}

export interface RootMetadata {
  signed: RootMetadataSigned;
  signatures: Signature[];
}

export interface EdgePointer {
  generation: number;
  releaseDigest: Sha256;
  leaseSeconds: number;
  issuedAt?: string;
}

export interface BundleContents {
  createdAt: string;
  notAfter: string;
  manifest: Manifest;
  keySet: RootMetadata;
  countersignKeySet?: RootMetadata;
  payloads: Array<{ contentHash: Sha256; byteLength: number; bytes: string }>;
}

export type Bundle =
  | { format: "apbundle"; version: 1; protocol: string; encryption: { scheme: "none"; contents: BundleContents } }
  | {
      format: "apbundle";
      version: 1;
      protocol: string;
      encryption: { scheme: "hpke-x25519-hkdf-sha256-aes-256-gcm"; recipientKeyId: string; enc: string; info?: "airprompter-apbundle-v1"; ciphertext: string };
    };

/** trust-chain.md refusal vocabulary, in verification order. */
export type RefusalCode =
  | "root_scope_mismatch"
  | "key_id_mismatch"
  | "root_rollback"
  | "root_signature_invalid"
  | "root_expired"
  | "protocol_unsupported"
  | "unknown_signing_key"
  | "signing_key_expired"
  | "signature_invalid"
  | "signature_threshold"
  | "scope_mismatch"
  | "generation_rollback"
  | "payload_missing"
  | "payload_hash_mismatch"
  | "countersign_missing"
  | "countersign_invalid"
  | "schema_invalid"
  /** S4: a directive of a kind this runtime does not honour — the manifest is refused whole, never partly obeyed. */
  | "directive_unknown"
  /** The chain verified; a slot's required model is not in this runtime's declared catalog (T15). */
  | "model_unavailable";
