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

export interface ManifestSlot {
  tag: string;
  kind: "prompt" | "workflow";
  artifactId: string;
  versionId: string;
  versionOrdinal: number | null;
  contentHash: Sha256;
  byteLength: number;
  model: string;
  variables: SlotVariable[];
  steps?: SlotStep[];
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
  | "schema_invalid";
