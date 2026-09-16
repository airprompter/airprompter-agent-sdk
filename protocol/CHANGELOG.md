# Protocol changelog

## Unreleased

### 0.3.2 — a workflow step carries its prompt version's inference settings (SDKs 0.2.7)
- The hosted slots catalogue (`GET /v1/agents/{agentId}/targets/{target}/slots`, `openapi.yaml`) names each slot's `inference` block and each step's: a client can see what a hosted run will use. `ManagedSlot` carries it. The example manifest and the trust vectors seal blocks their models take (a reasoning model: an effort and a cap; Claude: a temperature, a cap, stops).
- SDKs 0.2.7, second pass: the AI SDK middleware writes the cap as `maxTokens` for AI SDK 4 (`middlewareVersion: "v1"`, or call options that carry `mode` / `inputFormat`) and `maxOutputTokens` for AI SDK 5+; under AI SDK 4 `transformParams` names no model, so the release-model rule cannot apply there. `attribute()` takes a workflow step in TypeScript too (its step id is the tag, its run reference's arm the arm). Python hands out a plain copy of the block (`copy_inference`) and keeps its own.
- `slots[].steps[].inference` (optional; the same block as `slots[].inference`, digest-bound when present): a workflow's step runs with the settings ITS prompt version declared, sealed with the step — a prompt pinned directly and the same prompt as a workflow step run with the same settings, and the release digest covers both. `canonical-json.md` now lists `goldenSet` and `inference` in the digest input (both were projected since they existed; the list had not been updated). Additive: a 0.3.1 runtime verifies a 0.3.2 manifest and ignores the step block. Examples and the trust vectors regenerated.
- SDKs 0.2.7 (found by the review of 0.2.6): the release's settings go only on a call to the release's model — a call site that names another model gets its own parameters and `wrap_inference_model_mismatch` in the log, since settings sealed for one model are refused by another (Anthropic Messages takes one of `temperature` / `top_p`, and none beside `thinking`; OpenAI reasoning models take neither); on Messages the wrapper sends `temperature` alone when the slot carries both, and neither beside a `thinking` block (`wrap_inference_unsupported` names the setting and the reason); a Responses `reasoning` object is merged (`effort` set, the caller's `summary` kept), not replaced; the Python `attribute()` scope carries the settings (it had projected them away, so every explicit scope ran with defaults); workflow steps carry and apply their step's settings; golden-set invocations carry `inference` so the activation gate samples as production does; the AI SDK middleware applies them through `transformParams`; `litellm_inference(rendered)` returns the keyword arguments for a LiteLLM call; `apply_inference` is exported from the Python package roots and `applyInference` from `@airprompter/agent-sdk`; a JSON `null` in the block is treated as absent by every implementation (the digest projection agrees across the reference, TypeScript and Python); a call-site value the wrapper cannot compare no longer abandons the whole application. The "accepted and ignored" wording in `compatible-endpoints.md` stands: the hosted endpoints use the release's settings and ignore the caller's.

### 0.3.1 — a slot carries its inference settings (SDKs 0.2.6)
- `slots[].inference` (optional; `temperatureMilli`, `topPBps`, `maxOutputTokens`, `stopSequences`, `reasoningEffort` — integers only, per canonical-json.md; 200 is 0.2, 9000 is 0.9): how the model is called for the slot, as the prompt VERSION declared it in AirPrompter, sealed into the release digest when present and carried to every runtime. The provider wrappers and the hosted endpoints apply them; a caller's own value for the same parameter is refused (the release owns it — `compatible-endpoints.md`). Additive: a 0.3.0 runtime verifies a 0.3.1 manifest (same major) and ignores the block. Examples and the trust vectors regenerated at 0.3.1.
- SDKs 0.2.6 apply them: `Rendered.inference` carries the slot's block; `wrap(client)` puts the release's values on the outgoing OpenAI chat / Responses / Anthropic Messages call (`temperature`, `top_p`, `max_completion_tokens` / `max_output_tokens` / `max_tokens`, `stop` / `stop_sequences`, `reasoning_effort` / `reasoning.effort`), replaces a call site's differing value and logs `wrap_inference_overridden` once per call, and logs `wrap_inference_unsupported` for a setting the request shape cannot carry (a stop sequence on Responses, a reasoning effort on Messages). `applyInference` / `apply_inference` is exported for instrumentation that calls providers itself. The Python agent's protocol constant is core's (a second copy had drifted a bump behind).

### The fleet pattern: your store carries the release, your runtimes apply it (SDKs 0.2.5)
- `pullBundle()` (`pull_bundle`) in `agent-sync`: one pull with no store — fetch, verify the chain, seal to the fleet's distribution key — for a puller job that writes releases into a database, a bucket or a config entry; `airprompter pull` is the same with files. `fetchRoot` is required in practice with a pinned key (a pinned key names the root, not the signing keys) and the doc says so; a root that does not descend from the trusted one is `root_refused`; `minimumGeneration` reports a control plane answering below what the caller holds as `generation_rollback` instead of writing a quiet extra row.
- `applyBundle()` (`apply_bundle`) on the facade, and a top-level `distributionKey` option: a runtime that boots from the newest row and hands the next row over when the generation rises. The same chain and the same rules as a vendored bundle — verified before a byte is staged, the models the application declared gate it as they gate a release over the air, never below the held generation, held back after a local rollback, the apply policy decides — and one pass over the store at a time with `syncNow`. Returns a `BundleOutcome` (`activated` · `staged` · `unchanged` · `held_back` · `refused` with the reason); never throws on a bad bundle.
- Two fixes to the shared bundle path, found by the review: a bundle handed to a host with nothing active was staged and its generation recorded in `store.json` BEFORE its signature was checked, so a forged row (sealed to the fleet's public key, which is no secret) could leave a fresh runtime refusing every legitimate release below the forged generation — now the chain runs before a byte is staged in both branches; and a first release staged under `unlock_required` counted as "nothing held", so a bundle at that generation activated around the unlock — now it is a held generation (`unchanged`), and the unlock stays the customer's act.
- `@airprompter/agent-sdk`'s publish size budget is 220 KB (was 200); the facade grew by the bundle path. No protocol change.

### A first release staged under unlock_required starts the host (SDKs 0.2.4)
- `start()` refused (`no_verified_release`, "the sync ended staged … without a release") when the only release the control plane had for a target was staged under `unlock_required` — the ordinary shape of a first production release. The unlock is the customer's to give (T9), and a process that refuses to start can never give it. Both SDKs now start with nothing to serve: `generation` 0, `applyState` `awaiting_unlock` with the staged generation, `healthz` failing on `no_verified_release`, the `onStaged` hook called, heartbeats reporting `{ active: 0, staged: N }`, sync continuing; `prompt()` refuses with the staged generation named until `unlock()`, the window, or the hook activates it. A restart on a store whose active slot is unusable and whose other slot is staged starts the same way instead of refusing — the staged slot is still never served as a fallback. Logged `awaiting_first_unlock`. No protocol change.

### The pinned root is scoped to the hosted environment, not the app's target (SDKs 0.2.3, CLI)
- `trust-chain.md` has always said the pinned root is "one public JWK per hosted environment" and root metadata's `environment` is "the hosted environment this root governs". The SDKs built the trusted root from the pinned key with the app's **target** instead, so a `dev` or `staging` target on the public service — or any target other than `dev` on AirPrompter's dev deployment — refused the fetched root document (`root_scope_mismatch`, silently) and then every manifest (`unknown_signing_key`). `root: { pinned, hostedEnvironment }` (`hosted_environment` in Python) names the deployment the key belongs to, default `prod`; the CLI takes `--hosted-environment`; `airprompter dev` scopes its embedded daemon and its printed hint to the environment it serves. Regression tests in both SDKs. No protocol change.

### The managed-mode client picks its experiment by tag (SDKs 0.2.2)
- `/slots` lists `experiments[]` (each with its `tag`, salt, subject key and arms) beside the legacy `experiment`; `ManagedAgent.experimentFor(tag)` / `experiment_for(tag)` picks the slot's experiment, and a run hashes the subject with THAT salt — two prompts under test split independently in hosted mode as they do in client mode. A slot outside every experiment sends no hash; the legacy single `experiment` still covers every slot. No protocol change.

### The SDK reports the version that shipped (SDKs 0.2.1)
- `SDK_VERSION` had stayed at 0.1.0 through the 0.1.1 and 0.2.0 releases, so every heartbeat, store.json writer and OTel scope named a version that never shipped. Now 0.2.1 and pinned to the package version by `packageSplit.test.ts` / `test_package_split.py`; the Python `agent` package reads core's one constant; both OTel bridges default their scope version to it. No protocol change.

### One experiment per prompt (S16, AIR-1986) — protocol minor, 0.3.0
- `manifest.schema.json`: `payload.experiments[]` (1–32, each with a required `tag`, own salt, arms, ramp) beside the legacy `payload.experiment`, never both (`not: required [experiment, experiments]`); `experiment.tag` (optional on the legacy shape); `disable scope: "arm"` gains `experimentId`. Example `manifest.experiments.json` (two splits, the second against another prompt under the same key — D79); refused: the two shapes together, an entry without its tag.
- trust-chain M15 `experiment_conflict` (also in the heartbeat's refusal enum): never both keys, every entry names a slot of the release once, an arm's overrides name that slot only, an arm-scoped disable names its experiment. M9–M12 and M14 run over every experiment. Reference verifier in `conformance/trust.mjs`.
- `assignment-hash.md` › Per-prompt experiments: `experiment(tag)` picks the entry by tag (else the legacy one), assigns on that experiment's salt; a slot outside every experiment is arm `none`; the legacy shape is read unchanged and written only while a fleet has not reported 0.3. `vectors/assignment.json › perTag`: three subjects across two experiments, three refused shapes. `vectors/manifest-verify.json`: a verifying `experiments[]` manifest and four M15 refusals.
- Version 0.3.0 across `VERSION`, `openapi.yaml`, examples and vectors.
- SDK (TypeScript and Python, 0.2.0 in lockstep): `experimentsOf` / `experimentForTag` / `experimentConflict` in core (`experiments_of` / `experiment_for_tag` / `experiment_conflict`); the resolver decides each slot by its own experiment (own salt, arms, ramp); `disable scope: "arm"` keyed by `experimentId`; `AgentStatus.ramps` (one per experiment, with `tag`) beside `ramp` (the first); the heartbeat's `disabled.arms` flattens every experiment's. The legacy single `experiment` still reads as before. Vectors `sdk-typescript/test/perPromptExperiments.test.ts`, `sdk-python/tests/test_per_prompt_experiments.py`; the conformance harness gains `experimentForTag` / `experimentConflict` and the `assignment-per-tag` section; both adapters pass 245/245.

### The signed ramp plan (S9, AIR-1977) — protocol minor
- `manifest.schema.json`: `experiment.ramp: [{ notBefore, weightBps[] }]` (optional, 1–8 steps); `disable` gains `scope: "arm"` with `arm`. trust-chain M14 `ramp_invalid` (also in the heartbeat's refusal enum); the heartbeat's `disabled` block gains `arms`. Example manifest carries a plan; refused examples for an arm-disable without its arm and a step with one weight.
- `assignment-hash.md` › The ramp plan: the walk (the last step whose `notBefore` ≤ now, on the host's clock; steps ≥ 1 h apart; one weight per arm summing to 10000), the retreat (`disable scope: "arm"` hands an arm's share to the first live arm in manifest order; every arm disabled is a Freeze; an unknown arm changes nothing), no `reweight`. `vectors/ramp.json` from `tools/gen_ramp_vectors.py` (an independent implementation): the walk, two skewed hosts, the retreat, every refused plan; the conformance run mirrors it.
- SDK (TypeScript and Python): `validateRamp` / `rampWeightsAt` / `effectiveArms` in the assignment module; the runtime walks the plan at every render with no check-in, `AgentStatus.ramp`, `disabled.arms`; the retreat is honoured from any verified envelope (S3/S4). Vectors `sdk-typescript/test/ramp.test.ts`, `sdk-python/tests/test_ramp.py`.
- docs: trust-chain › "The ramp plan is what users will see", change-control › 5b, threat-model row.

### store.json joins the protocol with an N/N-1 rule (S8, AIR-1976)
- `schemas/store.schema.json` + `store-format.md`: `store.json` is a cross-package contract. Format 2 adds `writer { name, version }` and carries the S4 `applyPolicyPin`; format 1 (0.2.0–0.2.5) is still read. A reader at format N accepts N and N-1, writes N, migrates an N-1 file forward on its first write (never on open — the rollback window), and refuses N+1 with `store_newer` naming the writer. Examples `store.v1.json` / `store.v2.json`; refused: a format-3 file, a format-2 file without its writer, a free-form member.
- SDK (TypeScript and Python): `STORE_FORMAT_VERSION = 2`, `STORE_FORMATS_READ = {1, 2}`, `StoreError("store_newer", …, detail = the writer)`, `AgentStartError("store_newer")`; `StoreHooks.writer` — the SDK names itself, the daemon names itself through `sdk`, the CLI names itself. `SDK_VERSION` moves to `protocol/version.ts` (still exported from the package root).
- Vectors: `sdk-typescript/test/storeFormat.test.ts`, `sdk-python/tests/test_store_format.py` (N-1 read + first-write migration, N as written, a fresh store at N, N+1 refused naming the writer, the start error).

### Vendored bundles at boot and in git (S7, AIR-1975)
- SDK (TypeScript and Python): with a store already serving, a vendored bundle whose generation is above the host's is verified through the same chain as OTA and staged, and the host's apply policy decides (`vendored_bundle_staged` / `vendored_bundle_activated`); the held generation changes nothing; an older one is refused with `vendored_bundle_refused: generation_rollback` and the sentence naming `airprompter rollback`; a tampered or expired newer one is refused. With nothing held the bundle is the fallback as before.
- CLI: `airprompter diff <bundle> --against <other>` compares two update files with no store and names a backward one; `airprompter apply` of an older file says the sentence and carries `bundleGeneration` / `heldGeneration`.
- docs/change-control.md › 7 "Bundles in git" (the CI recipe; readers of a bundle in a database column hold the distribution key). Vectors: `sdk-typescript/test/vendored.test.ts`, `sdk-python/tests/test_vendored.py`, `cli/test/cli.test.ts`. No wire change.

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
