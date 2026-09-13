# Protocol changelog

## Unreleased

### The disk budget is a published invariant (S6, AIR-1974)
- `spool-format.md` draft 2: `tree ≤ budget + (writers × 1 MiB open) + quarantine cap + exported cap`. Acknowledged segments are deleted on `2xx` (no `sent/`; `.last-upload` stamps the last one); `quarantine/` and `exported/` are capped at 10 MiB each, oldest first; an `.open` segment untouched for an hour is closed as abandoned and uploaded; `instanceId` is per process (the store's id stays store.json's identity) and the `runRef` key is derived from the store's id, so run references parse across a host's workers.
- Daemon socket: `hello.storeId` (additive). Uploader status: `tree`, `reclaimedSegments`, `capEvictedFiles`; `SpoolUploader.tree()` / `bound(writers)`. The runtime closes a passed minute's windows on a spool timer (`SpoolWriter.closeStaleWindows`).
- CLI: `airprompter telemetry verify --budget <bytes> --sink-absent [--writers N] [--quarantine-cap <bytes>]` — the customer's proof, exit 0 when the invariant holds; `status` reads `.last-upload`; `export-telemetry` holds `exported/` under its cap.
- Vectors: `sdk-typescript/test/budgetInvariant.test.ts`, `sdk-python/tests/test_budget_invariant.py`, `cli/test/cli.test.ts` "S6". No wire change to manifests or heartbeats.

### Telemetry without a daemon (S5, AIR-1973)
- SDK (TypeScript and Python): a resident host with no daemon runs the spool uploader in-process — the same `SpoolUploader` the daemon runs, on a timer off the request path, under the runtime's own grant; past the budget the oldest segments are dropped and counted. `AgentStatus.upload`, `uploadNow()` / `upload_now()`, `telemetry.upload: false` / `TelemetryOptions(upload=False)`. The daemon starts its runtime with the uploader off and keeps running the host's own.
- Serverless: `invoke()` flushes the invocation's rows before it returns; `telemetry.flush: "background"` / `TelemetryOptions(flush="background")` is the documented opt-out.
- Python parity: `airprompter_agent.telemetry.uploader` (`validate_spool_row`, `inspect_segment`, `post_segment`, `SpoolUploader`), `request_upload_grant()`, `flush_telemetry()`, the heartbeat's grant taken; the fake control plane issues grants and fakes the bucket.
- docs/telemetry.md › "Telemetry without a daemon" (the blast radius of a grant held by an application host). No wire change; vectors unchanged.

### The apply policy is the customer's (S4, AIR-1972)
- `trust-chain.md` M13: the directive kinds a runtime honours are a closed set (`disable`, `request_unlock`); any other kind refuses the whole manifest — `directive_unknown`, a new refusal code in `heartbeat.schema.json` — before a payload is fetched. Vectors in `vectors/manifest-verify.json` ("a directive of a kind the runtime does not honour…", "the two kinds the runtime honours verify"); the reference verifier checks it.
- `heartbeat.schema.json` request: `applyPolicy { effective, source }` (optional, additive) — what the host runs under and where it comes from (`local` / `pinned` / `operator` / `manifest`), so the fleet view can say the console's setting is advisory on a pinned host. Example `heartbeat.request.json` carries it.
- SDK (TypeScript and Python): `store.json` gains `applyPolicyPin { value, source, generation, setAt }`. The first verified manifest pins the host's policy (trust-on-first-use); a later manifest may tighten it (`apply_policy_tightened`) and never loosen it (`apply_policy_manifest_advisory`, once per generation); `setApplyPolicy(value, { by })` / `set_apply_policy` is the operator's act (`apply_policy_set`). `AgentStatus.applyPolicy`. The process's `apply.policy` only adds strictness.
- CLI: `airprompter policy show | set auto|unlock_required [--by …]` (host-wide through the daemon when one runs); `airprompter apply` honours the pin (the update file's value pins or tightens, never loosens); `airprompter status` prints the pin. Daemon socket: `policy` op, `policy` event, `applyPolicy` on `slot` and `status`.
- `trust-chain.md` › "The apply policy is the customer's"; threat-model rows; change-control.md.

### The pointer never extends trust (S3, AIR-1971)
- `heartbeat.schema.json` response: `latestGeneration` (optional, additive) — the environment's current generation as the origin knows it. A runtime whose edge pointer says less marks the pointer behind, skips it on its next pass and fetches the signed manifest directly. Example `heartbeat.response.json` carries it.
- Sync loop (TypeScript and Python): `pointer_unchanged` is a distinct outcome from `unchanged`. The edge pointer's silence never renews the lease; a signed manifest (activated / staged / held back / same generation) or the origin's authenticated answer (manifest `304`, heartbeat `200`) does. `syncOnce({ skipPointer })`.
- Daemon socket: the `slot` answer carries `leaseExpiresAt`; a new `lease` event broadcasts every renewal; an attached SDK adopts the daemon's lease and never counts the socket as contact. `AirPrompterAgent.onContact(listener)`.
- `trust-chain.md` › "The pointer never extends trust"; threat-model row with its vectors (`sdk-typescript/test/pointer.test.ts`, `sdk-python/tests/test_agent.py`).

### SDK — the spool never throws on the request path; the ports and the testing kit (S2, AIR-1970)
- TypeScript: `FsPort` / `ClockPort` / `FetchPort` in `protocol/ports.ts`; `DirectorySink`, `SlotStore` and `SpoolUploader` take an `fs` (the Node port by default). The sink never throws: filesystem failures are counted on `sink.faults` by code and the rows it could not keep are reported as one `dropped` row when a write succeeds again; an unsynced segment stays `.open` for recovery; a file a sibling took away is skipped by the writer's sweep and the uploader's (`uploader.fsFaults`). `AirPrompterAgent.start({ fs })` passes the port through. `src/testing/`: `MemoryFs`, `FakeClock`, and the fake registry moved out of the tests. `PROTOCOL_VERSION` lives in `protocol/version.ts`.
- Python: `airprompter_agent.ports` (`FsPort`, `OsFs`, `fs_failure_code`), `DirectorySink(..., fs=)` with the same never-raise rule and `faults`, and `airprompter_agent.testing` (`MemoryFs`, `FakeClock`).
- spool-format.md: the writer-fault paragraph. No wire change; vectors unchanged.

### SDK — error and sink identity as data (S1, AIR-1969)
- TypeScript: every SDK error sets `name` and carries a `code`; `isStoreError`, `isDaemonError`, `isAgentStartError`, `isManagedRunError`, `isPayloadDecryptError` and `errorNamed` replace `instanceof`, so an error from a duplicated copy of the package is still recognised. `SpoolSink` gains `kind` and optional `drain()` / `depth()`; the runtime branches on those. `PayloadDecryptError` gains `code: "payload_decrypt_failed"`. A source pin refuses `instanceof` on any SDK class in the SDK and the CLI.
- Python: `SpoolSink.kind` (`"memory"` / `"directory"`, `"custom"` on the base); the runtime reads `drain` / `depth` by capability.
- No wire change; vectors unchanged.

- **Golden sets before activation and the customer-side judge** (AIR-1964,
  T34, 5-D / D63): golden-sets.md. A manifest slot (or arm override) may
  carry `goldenSet: { setId, cases, contentHash, byteLength, minPassBps }`
  — in the release digest input only when present, like `outputChecks`;
  `contentHash` names a payload (`schemas/golden-set.schema.json`: 1–50
  cases, each variables plus 1–8 expectations in the output-check grammar)
  fetched, verified, stored and bundled like any other. On stage the
  runtime renders every case, asks the customer's model through the call
  the application supplied, evaluates the expectations, writes `goldenPass`
  per case on the arm's window (reserved in the feedback catalogue: refused
  from `ap.feedback()` and from `custom`) and leaves a release below its
  floor staged under `auto` as under `unlock_required`. `airprompter verify
  --golden` / `apply --golden` run the same cases offline from a bundle
  (`--run <command>` per case or `--outputs <file>`). `ap.judge(runRef,
  output, rubric, invoke)` runs a criteria rubric (the prompt's `## Success
  criteria`, the protection lens, `helpfulness`, or the customer's) on the
  customer's model and files only `judgeScore` / `flagged`. Two new trust
  vectors; two new feedback vectors; the manifest and telemetry-window
  schemas describe the new members.

- **Air-gapped update files and the spool over a file** (AIR-1946, T16,
  D33 / §6.3): the platform builds the same `.apbundle` `pull` writes —
  promoted manifest, payloads, the environment's root document — sealed
  to the environment's registered distribution key, with a `notAfter` 90
  days out by default (365 at most); `verify` and `apply` print
  `daysLeft` / `expiringSoon` and warn inside the last 30 days, and a
  runtime starting from a vendored bundle that close logs
  `vendored_bundle_expiring_soon`. `pull --not-after-days` now defaults
  to 90 to match. `airprompter export-telemetry` packs the spool's closed
  segments into an `airprompter-telemetry-export` document (spool-format.md
  › The spool over a file) and `import-telemetry` uploads it through the
  ordinary heartbeat + grant path, one grant per instance, idempotent by
  key. No wire change on the control plane.

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
