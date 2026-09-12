# Protocol changelog

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
