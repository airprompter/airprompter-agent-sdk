/**
 * Wire types for the protocol (3.x), hand-written to match `protocol/schemas/*`.
 * The conformance vectors, not these types, are what proves agreement; keep
 * them narrow and let the schema tests catch drift.
 *
 * @example
 * ```ts
 * const slot: ManifestSlot | undefined = manifest.payload.slots.find((entry) => entry.tag === "support.triage");
 * const experiment: Experiment | undefined = manifest.payload.experiments?.find((entry) => entry.tag === "support.triage"); // undefined: the slot renders with arm "none"
 * const fenced = slot?.variables.filter((variable: SlotVariable) => variable.trust === "end_user"); // rendered inside delimiters
 * if (bundle.encryption.scheme === "none") bundle.encryption.contents.manifest; // the union narrows on `scheme`
 * ```
 */

import { servableOverrides } from "./assignment.js";

/** An agent's stage: an immutable lowercase slug (`^[a-z][a-z0-9-]{0,31}$`). An SDK never branches on it, except that a plaintext bundle stays `dev` only. */
export type Target = string;
/** The shape of a stage: the only check a target gets. It feeds store paths and spool directories, so a start refuses anything else. */
export const TARGET_SLUG = /^[a-z][a-z0-9-]{0,31}$/;
/** An agent id as the control plane mints it (`manifest.schema.json` › identifier). It feeds store paths and spool directories. */
export const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** One AirPrompter deployment: what a root document belongs to, never an agent's stage. */
export type HostedEnvironment = "dev" | "staging" | "prod";
export type Sha256 = `sha256:${string}`;

export interface SlotVariable {
  name: string;
  required: boolean;
  trust: "operator" | "end_user";
  /** Rendered when neither the call site nor a source supplies a value; only meaningful on an optional `operator` variable. */
  default?: string;
  /** Who the author expects to fill it: the code that renders, or a source the application registers. A hint; a runtime does not act on it. */
  source?: "caller" | "runtime";
}

export interface SlotStep {
  stepId: string;
  ordinal: number;
  promptArtifactId: string;
  promptVersionId: string;
  contentHash: Sha256;
  byteLength: number;
  /** How the model is called for this step, as its prompt version declared it; digest-bound when present. */
  inference?: SlotInference;
}

/** One declared output check as a pin carries it (checks.md): the kind's own members only. */
export type OutputCheck =
  | { kind: "json_schema"; name: string; schema: Record<string, unknown> }
  | { kind: "enum"; name: string; path: string; values: string[] }
  | { kind: "length"; name: string; minTokens?: number; maxTokens?: number }
  | { kind: "must_match" | "must_not_match"; name: string; pattern: string; flags?: "i" };

/** Integers only (canonical-json.md): temperature in thousandths, top-p in basis points. */
export interface SlotInference {
  temperatureMilli?: number;
  topPBps?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  reasoningEffort?: "low" | "medium" | "high";
}

export interface ManifestSlot {
  tag: string;
  /** Any string on a slot with `requires`; a servable slot is `prompt` or `workflow`. */
  kind: "prompt" | "workflow" | (string & {});
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
  /** How the model is called for this slot, as the version declared it; in the digest when present. */
  inference?: SlotInference;
  /** T34: the slot's golden set (golden-sets.md) — a reference to a payload the runtime opens and runs before activation; in the digest input only when present. */
  goldenSet?: GoldenSetRef;
  variables: SlotVariable[];
  steps?: SlotStep[];
  /** Capabilities a reader needs to serve this slot (`capabilities.md`); a reader missing one treats the slot as absent. In the digest input when present. */
  requires?: string[];
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

/** S9: one step of the signed ramp plan — from `notBefore` (inclusive, the host's clock) these are the arms' weights, in manifest order. */
export interface RampStep {
  notBefore: string;
  weightBps: number[];
}

export interface Experiment {
  /** Absent: the experiment allocates across the whole fleet. */
  audience?: import("./assignment.js").AudienceSnapshot;
  experimentId: string;
  /** S16: the one slot this experiment splits. */
  tag: string;
  salt: string;
  subjectKey: "request" | "instance";
  arms: ExperimentArm[];
  /**
   * S9: the signed ramp plan (assignment-hash.md › The ramp plan). The runtime walks it on its own clock — no check-in
   * needed: the weights in force are the last step whose `notBefore` has passed, else `arms[].weightBps`. Steps are
   * strictly increasing and at least an hour apart; each carries one weight per arm summing to 10000.
   */
  ramp?: RampStep[];
}

export type Directive =
  | { kind: "request_unlock"; releaseDigest: Sha256; requestedBy: string; requestedAt: string; expiresAt: string; note?: string }
  | { kind: "disable"; scope: "agent" | "slot" | "arm"; tag?: string; arm?: string; experimentId?: string; issuedAt: string; reason?: string };

/**
 * S4: the set of directive kinds a runtime honours is closed. `disable` is the one kind that acts without a
 * local act (a reduction: it only ever stops serving); `request_unlock` is a request the runtime surfaces and
 * never grants. A manifest carrying any other kind is refused whole (`directive_unknown`) — never partly obeyed.
 */
export const DIRECTIVE_KINDS: ReadonlySet<string> = new Set<Directive["kind"]>(["request_unlock", "disable"]);

/** S4: the apply policy a host holds, as store.json records it. */
export type ApplyPolicy = "auto" | "unlock_required";

export interface ManifestPayload {
  requiredCapabilities?: string[];
  observations?: import("./assignment.js").AudienceObservation[];
  protocol: string;
  organizationId: string;
  agentId: string;
  target: Target;
  generation: number;
  releaseDigest: Sha256;
  previousReleaseDigest?: Sha256;
  issuedAt: string;
  leaseSeconds: number;
  applyPolicy: "auto" | "unlock_required";
  /** T9: the console's update window (advisory; a local `apply.window` wins). Only with `unlock_required`. */
  unlockWindow?: { timezone: string; start: string; end: string; days?: Array<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun"> };
  requireCountersign: boolean;
  slots: ManifestSlot[];
  /** S16: one split per slot, each independent: own salt, arms, ramp and share. */
  experiments?: Experiment[];
  directives: Directive[];
}

/**
 * M15 (S16): the per-prompt shape is consistent: every `experiments[]` entry names a slot of the release, no slot twice; each arm's overrides name that slot only; an arm-scoped disable names one of the
 * experiments. Null when it holds.
 */
export function experimentConflict(payload: Pick<ManifestPayload, "experiments" | "slots" | "directives">): "experiment_conflict" | null {
  const disables = (payload.directives ?? []).filter((directive) => directive && directive.kind === "disable" && directive.scope === "arm") as Array<Extract<Directive, { kind: "disable" }>>;
  if (disables.some((directive) => typeof directive.experimentId !== "string")) return "experiment_conflict";
  const list = payload.experiments;
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list) || list.length === 0) return "experiment_conflict";
  const slotTags = new Set((payload.slots ?? []).map((slot) => slot?.tag));
  const seen = new Set<string>();
  const ids = new Set<string>();
  for (const experiment of list) {
    if (!experiment || typeof experiment !== "object" || typeof experiment.tag !== "string") return "experiment_conflict";
    if (!slotTags.has(experiment.tag) || seen.has(experiment.tag)) return "experiment_conflict";
    seen.add(experiment.tag);
    ids.add(experiment.experimentId);
    // An override this SDK cannot serve is dropped before the check: a rubric override of another tag must not refuse the manifest.
    for (const arm of Array.isArray(experiment.arms) ? experiment.arms : []) for (const override of servableOverrides(arm ?? {})) if (override.tag !== experiment.tag) return "experiment_conflict";
  }
  return disables.every((directive) => ids.has(directive.experimentId!)) ? null : "experiment_conflict";
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

/** A platform root belongs to a deployment; a customer's countersign root belongs to the stage it signs for. */
export type RootMetadataSigned = {
  type: "root";
  protocol: string;
  version: number;
  expires: string;
  keys: Record<string, RootKeyEntry>;
  roles: { root: RootRole; targets: RootRole };
} & ({ purpose: "platform"; environment: HostedEnvironment } | { purpose: "countersign"; environment: Target });

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
  /** S9: the ramp plan is malformed (order, spacing, a weight per arm, sums) — refused whole before a byte is fetched. */
  | "ramp_invalid"
  | "experiment_conflict"
  /** The chain verified; a slot's required model is not in this runtime's declared catalog (T15). */
  | "model_unavailable";
