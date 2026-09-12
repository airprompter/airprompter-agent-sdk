# Protocol changelog

## Unreleased

- **Provider-compatible endpoints** (AIR-1962, T32, D64 / §11.2):
  compatible-endpoints.md. The OpenAI Chat Completions and Responses shapes
  under `/v1/agents/{agentId}/openai/…` and the Anthropic Messages shape
  under `/v1/agents/{agentId}/anthropic/v1/messages`, on the run URL, with
  the run key (the target is the key's own) and `model: "slot:<tag>"`. The
  release's template is the system prompt; the one user turn goes into the
  prompt's end-user variable; the other declared variables, the sticky
  subject, the idempotency key and the step ride on an `airprompter`
  extension. Metering, records, retention and judge sampling are `/run`'s
  own; the answer is the provider's shape (JSON or its own stream events)
  with `X-AirPrompter-RunRef` and an `airprompter: { runId, runRef }` field;
  every refusal is the provider's error shape with the AirPrompter code
  beside it. Three OpenAPI paths and their schemas.

- **Reference spool writers** (AIR-1963, T33, D66): `examples/spool-writer/`
  — a dependency-free writer in TypeScript and in Python that a team
  instrumenting a provider SDK themselves can start from; both pass
  `vectors/spool.json` under the conformance runner, filesystem rules
  included. spool-format.md points at them. No wire change.

- **Feedback on the hosted surface** (AIR-1960, T30, 5-F / D63): `POST
  /v1/agents/{agentId}/targets/{target}/feedback` on the run URL — the bare
  HTTP form of `ap.feedback(runRef, signals)` for hosted runs, under the
  run key; the `runRef` must verify and name the key's agent and target;
  signals go through `feedback-signals.schema.json` and land as
  `outcomes[signal] += {n, sum}` on the run's arm window in the minute they
  are filed (late arrival allowed). `ManagedAgent.feedback()` in both SDKs.
  Hosted runs now write their own `measured` windows on the serving side,
  so a hosted arm reads exactly like a client arm.

- **Declared output checks** (AIR-1959, T29, 5-E / D63): checks.md. A slot
  may carry `outputChecks` — `json_schema` (a documented JSON Schema
  subset), `enum` (a string at a dotted path), `length` (an output-token
  band; the provider's count when reported, else `ceil(UTF-8 bytes / 4)`),
  `must_match` / `must_not_match` (RE2-class patterns only: no
  backreferences, lookaround, possessive/atomic groups or nested
  quantifiers; ≤ 256 chars; an output over 64 KiB fails closed). Enabled
  checks travel on the pin sorted by name and are part of the release
  digest input when present (canonical-json.md). Both SDKs evaluate them
  inside `observe()` on the host and count `checks.passed` / `checks.failed`
  on the run's window (the counters spool-format.md already carried); the
  text never leaves. New `vectors/checks.json` and the reference
  `conformance/checks.mjs`; the manifest schema gains `$defs/outputCheck`.

- **Model catalog** (AIR-1945, T15, design §7): a slot may carry
  `modelRequired: true` — part of the release digest input only when true
  (canonical-json.md; every earlier digest unchanged; new manifest-verify
  vector "a slot whose model is required", regenerated with real
  signatures). A runtime whose declared catalog (`models` at start) lacks a
  required model refuses the release locally: heartbeat `refusal:
  model_unavailable` (the one refusal after the chain verified,
  trust-chain.md) with the additive `unavailableModels` list; the active
  release keeps serving. Both SDKs implement it; a runtime that declared no
  models is never refused over one.

- daemon-socket.md draft 2 (AIR-1956, T26 P4): the uploader. New op
  `upload` (one pass now); `status` gains an `upload` block and `healthz`
  gains `spoolDepth`, `lastUploadAt`, `backoffUntil`; the rule that a
  grant is per instance prefix and a daemon holds one per writer, obtained
  by a heartbeat naming that writer (`sdk.name: airprompterd`); rows
  validated against `spool-rows.schema.json` and the file name's
  `instanceId` before upload, a failing segment quarantined whole; the
  host budget enforced across writers with the daemon's own `dropped`
  row. spool-format.md says the same from the writer's side and names the
  serverless flush. No schema change.

- `vectors/canonical-json.json` (AIR-1947): four cases an encoder in a
  second language can get wrong — astral keys sort by UTF-16 code units
  (U+1F600 before U+FF5E), U+2028 / U+2029 / DEL / C1 controls emitted
  raw, keys with escapes sorted by their code units rather than their
  escaped text, integers at the safe boundary — and a negative unsafe
  integer in `refused`. The Python SDK (`sdk-python/`) passes every vector
  the TypeScript SDK passes; a store one SDK writes opens in the other.

- spool-format.md (AIR-1941): the serverless 256 KiB memory buffer and its
  `dropped` row; the host budget's `dropped` row is written at once as its
  own closed segment; the OpenTelemetry GenAI field mapping (D24) and the
  `sdk` writer tag as an ingest dimension (D66). No schema change: the
  `dropped` row was already `spool-rows.schema.json`.

- **Heartbeat is shipped** (AIR-1939): `POST /v1/agents/{agentId}/targets/{target}/heartbeat`
  on the Agent key with `agent.telemetry.write`. `heartbeat.schema.json`
  gains additive request fields — `instanceClass` (resident | ephemeral,
  D57), `heartbeatIntervalSeconds` (the runtime's intended cadence),
  `unlockRequestsSeen` (release digests of the open `request_unlock`
  directives the instance has surfaced), `disabled` (what it refuses under
  a Freeze) — and additive response fields `heartbeatIntervalSeconds` (the
  clamped cadence to adopt) and `expiresAt` (three intervals on). The
  upload grant stays absent until AIR-1942. Per key, 500 live instances
  per environment; the 501st is `403 instance_cap_reached`.
- `manifest.schema.json`: optional `unlockWindow` on the payload — the
  console's update window (IANA zone, HH:MM start/end, optional days),
  present only with `unlock_required`, advisory: a runtime's local
  `apply.window` wins and the local side is never looser (D33).
- Directive precedence stated for runtimes: a `disable` (Freeze) or a
  `request_unlock` on any manifest whose envelope verifies (signature,
  scope, generation not below the stored one) is honoured **before** the
  apply decision — a frozen fleet stops rendering even when the manifest
  is left staged, held back, or already held.

- `openapi.yaml`: the run route is **shipped** (AIR-1949) with its final
  shape — `RunRequest` gains `stream`, `stepId`, `maxOutputTokens`,
  `metadata`; `RunResponse` gains `runId`, `generation`, `priceMicros`,
  `priceBookRevision`, `stopReason`, `source`, `metadata`, and usage names
  its cache-read field `cachedInputTokens`; the SSE framing and the edge's
  60 s silence bound are stated on the route; `503` added. New
  `GET /v1/agents/{agentId}/targets/{target}/slots` (AIR-1953): the hosted
  catalogue a run key reads — tags, variables, step ids, the experiment's
  salt and arms — so `subjectHash` is computed exactly as client mode does.

- `daemon-socket.md` (draft 1): the local socket between `airprompterd`
  and SDK processes — path and mode, newline-JSON framing, `hello` /
  `slot` / `status` / `sync` / `unlock` / `rollback` / `healthz`,
  `generation` and `shutdown` events, `GET /healthz` over the same
  socket, and the in-process fallback. No schema change; tagged with the
  spool-upload half (P4).

## 0.2.5 — 2026-09-12 (tag `protocol/v0.2.5`)

- Spool conformance vectors (`vectors/spool.json`: latency bucket index,
  minute formatting, segment naming, rotation at the minute and at 1 MiB,
  minute-window aggregation) and feedback vectors (`vectors/feedback.json`:
  the catalogue normalised into window outcomes, with every rejection
  reason), both generated by `tools/gen_spool_vectors.py` and byte-diffed
  in CI. `schemas/spool-rows.schema.json` defines the `refusal` and
  `dropped` rows spool-format.md described in prose.
- `telemetry-window` `count` may be 0: a window that carries only feedback
  filed against runs from an earlier minute (feedback never counts as a
  run and adds no latency).
- `feedback-signals` `custom` names may not shadow a catalogue signal
  (`propertyNames.not.enum`).
- spool-format.md: `latencyMs.sum` rounds half up; feedback rides on the
  run's `status: ok` window.

## 0.2.4 — 2026-09-12 (tag `protocol/v0.2.4`)

- OpenAPI: the manifest and payload routes are **shipped** by the hosted
  service (AIR-1936). Manifest `ETag` is the sha256 of the stored envelope
  (a rollback is a new envelope even when it names an older release), both
  answers carry `x-agent-generation`, and the long poll holds only while
  the caller already has the current envelope. Payload responses carry
  `x-content-hash`; the presigned redirect is minted only after the bytes
  were verified. No schema change.

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
