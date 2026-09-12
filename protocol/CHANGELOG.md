# Protocol changelog

## 0.2.3 — 2026-09-12 (tag `protocol/v0.2.3`)

- `protocol/VERSION` is the one source of the version: the generators read
  it, so examples and vectors carry the tag's version (0.2.1 and 0.2.2
  shipped examples still saying 0.2.0 — the hosted service's pin test
  caught it). CI refuses a protocol tag that does not match VERSION.

## 0.2.2 — 2026-09-12 (tag `protocol/v0.2.2`)

- trust-chain.md: timestamps compare as instants, never as strings; the
  reference verifier does the same. No schema change.

## 0.2.1 — 2026-09-12 (tag `protocol/v0.2.1`)

- `keyId` (manifest signatures, root metadata keys and roles, bundle
  `recipientKeyId`) is now *schema*-constrained to the lowercase hex
  thumbprint trust-chain.md already required; examples use real
  thumbprints. Breaking only for documents that used another id form,
  which no implementation has shipped.

## 0.2.0 — 2026-09-12 (tag `protocol/v0.2.0`)

Breaking for readers of `heartbeat.refusal` (new enum values); additive
otherwise. Schema `$id`s move to `/protocol/0.2/`.

- **Trust chain** (`trust-chain.md`): the verification order a runtime
  follows — root metadata R1–R5 (scope, key-id = thumbprint, rollback,
  root-role signatures against the *trusted* document, expiry) and
  manifest M1–M12 (root expiry, protocol major, listed signing key, key
  validity window, signature, threshold, scope, generation, payload
  presence, payload hash + length, countersign presence, countersign
  validity). `keyId` is now defined as the RFC 7638 thumbprint, not merely
  recommended. Expiry degrades: refusals apply to new manifests and the
  active release keeps serving.
- **Vectors** `vectors/manifest-verify.json`: 10 root cases + 30 manifest
  cases with real ES256 signatures (`tools/gen_trust_vectors.mjs`).
- **Heartbeat** `refusal` enum is now the full trust-chain vocabulary
  (17 values, was 9). The conformance runner checks every vector refusal
  is reportable.
- **Conformance**: `trust.mjs` reference verifier; CI verifies a freshly
  generated vector file as well as the committed one.

## 0.1.0 — 2026-09-12 (tag `protocol/v0.1.0`)

First pinned protocol. Pre-1.0: a minor bump may still change a schema
in a breaking way, and each entry says so.

- **Manifest** (`schemas/manifest.schema.json`): signed envelope with
  `payload`, `signatures[]`, `countersignatures[]`. Payload carries
  `protocol`, scope (`organizationId`, `agentId`, `target`), a strictly
  monotonic `generation`, `releaseDigest` / `previousReleaseDigest`,
  `leaseSeconds` + `onLeaseExpiry`, `applyPolicy`, `requireCountersign`,
  `slots[]` (exactly the release-digest projection), an optional
  `experiment` (arms with `releaseDigest` + slot `overrides`), and
  `directives[]` (`request_unlock`, `disable`). No prompt text, by
  `additionalProperties: false` everywhere.
- **Root metadata** (`schemas/key-set.schema.json`): TUF-shaped `signed`
  (`purpose`, `environment`, `version`, `expires`, `keys`, `roles.root`,
  `roles.targets`) + root signatures. Same shape for customer countersign
  keys.
- **Offline bundle** (`schemas/bundle.schema.json`): `apbundle` v1;
  HPKE (X25519 / HKDF-SHA256 / AES-256-GCM) to the target's distribution
  key by default, `scheme: none` for the `dev` opt-in; contents carry the
  manifest, the key-set(s), every referenced payload, and `notAfter`.
- **Heartbeat** (`schemas/heartbeat.schema.json`): request (instance,
  sync mode, generations, apply state + refusal code, storage protection,
  model catalog, lease, spool depth) and response (presigned S3 upload
  grant, `uploadIntervalSeconds`, `pollSeconds`, `retryAfterSeconds`,
  `edgePointerUrl`).
- **Edge pointer** (`schemas/edge-pointer.schema.json`).
- **OpenAPI** (`openapi.yaml`) for the five customer-v1 routes, each
  tagged with its delivery status and the ticket that ships it. A release
  is addressed by `(target, releaseDigest)`.
- **Sticky assignment** (`assignment-hash.md`, `vectors/assignment.json`):
  35 cases including boundary buckets, a zero-weight arm, unicode and
  untrimmed subjects; 5 refusals.
- **Examples** for every schema plus 16 refused documents; conformance
  also checks the rules the schema cannot express (digest reproduces from
  slots, arms' digests reproduce from overrides, countersign covers every
  arm, bundles carry every referenced payload and the bytes hash).
- **Conformance runner** (`conformance/run.mjs`) with reference
  implementations of canonical JSON, assignment and step ordering.

## Draft 1 — 2026-09-11

- Spool format: file layout, `window` / `refusal` / `dropped` rows, closing
  and rotation rules, third-party writers.
- Telemetry window schema, fixed latency bucket edges, feedback signal
  catalogue.
- Canonical JSON and the release digest; workflow step-tag scheme.
