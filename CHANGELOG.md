# Changelog

The SDKs and the CLI, by version. The five npm packages and the five Python
distributions move in lockstep: one version number, released together by
tag (`sdk-typescript/vX.Y.Z`, `sdk-python/vX.Y.Z`). The wire protocol has
its own version and its own [changelog](protocol/CHANGELOG.md); each SDK
entry names the protocol it speaks. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/) — before 1.0, a minor bump
may change a public shape and says so here.

## Unreleased

- **Runnable framework examples** (AIR-2316): `examples/langchain-typescript/`, a LangChain support agent on the approved prompt `examples/prompts/support/reply.md`, run in CI unchanged against `airprompter dev` and a fake provider (`examples/ci/run.mjs`). For a release: `version-lockstep --set` now also moves the SDK pin in every `examples/*/package.json`, and the check fails while an example pins another version.

### CLI release checksums name the bare file (AIR-2268)
- **Each CLI asset's `.sha256` is one line, `<hex>  <asset>`**, so `shasum -a 256 -c airprompter-linux-x64.sha256` (or `sha256sum -c`) works in the folder the asset was downloaded to. It used to name `dist/<asset>`, the path on the build runner, and the check failed with "No such file". `cli/scripts/checksum.mjs` writes it the same way on every platform; `cli/test/checksum.test.ts` checks the format and runs the platform's own checker on it, and the release job checks each `.sha256` beside its asset before uploading. The verify action reads only the digest, so it is unaffected.

## 1.0.0-rc.5 — 2026-11-27 (protocol 4.0.0)

The fifth release candidate: one contract for every framework adapter (AIR-2231), the OpenAI, Anthropic, Vercel AI SDK and LiteLLM support rebuilt as adapters on it, and the wrapped clients of rc.4 removed. It is also the first release since rc.4, so it carries **AirPrompter's production trust root pin** (#110): the Steps core can verify a production manifest only from this release on, and so can any agent pointed at the production service. The Zapier and n8n integrations get it with their own move to rc.5 (they still pin rc.4). Protocol unchanged. Python moves in lockstep (`1.0.0rc5`). The CLI's version moves with it (lockstep); `cli/src` uses nothing removed here, so tagging `cli/v1.0.0-rc.5` is the release's call.

`1.0.0-rc.1` was once reserved for this contract. That reservation is void: rc.2 to rc.4 shipped first, and a lower version would never be resolved over them, so the contract ships as rc.5 (decided by the orchestrator under the owner's delegation, 2026-11-27).

### One contract for every framework adapter (AIR-2231, Python)
- **New `airprompter_agent.frameworks.contract`**, the twin of the TypeScript one and **outside the 1.0 promise**: `acquire_run`, `choose_model`, `settings_for` (a `MappedSettings` with `values`, `unsupported`, `overridden`), `measure_call` / `measure_call_async`, `begin_measure`, `apply_settings`, `instrument_client`, `ADAPTER_EVENTS` (the same event names as TypeScript), the run types. It sits behind the internal module `airprompter_agent.runtime.adapter`, which only the contract may import (`tools/lint_imports.py`).
- **New adapters:** `airprompter_agent.frameworks.openai` and `.anthropic` (`instrument(client, ap, slot=None, model_for=None, now=None)`, `apply_placement`), sync and async clients alike (an async client places with `run.place_async`); `airprompter_agent.frameworks.litellm` (`AirPrompterLiteLLMCallback`, `litellm_metadata(target)` with `target` a rendered prompt, a workflow step or `(run, slot)`, and `litellm_params(placement)`). The rules are the TypeScript ones: approved text in the system position on a copy, the release's model or a decline, sealed settings, one run per request, a `.stream()` helper on a slot-bound client passes through unmeasured, a scope-mode call to another model goes out unobserved.
- **LiteLLM** attributes only by the signed run reference in `metadata["airprompter"]` (`tag` and `runRef`): the entry whose tag matches is read; a reference that does not verify, or names no such entry, files nothing; unsigned metadata and text matching are gone. The call is recorded into the live run that reference names, found by an internal lookup, so it lands on its run whichever thread LiteLLM 1.111 logs on (a sync `stream=True` call logs on a worker thread without the caller's context). LiteLLM logs after the call returns, so with `litellm_metadata((run, slot))` a record that arrives after its run ended is dropped with one `adapter_late_record` log, never a second row; measure in-run calls with `measure_call` at the call site to keep every one. A call sent under another model than the reference's is not counted. Outside any run, `litellm_metadata(rendered)` is a one-call row. The lookup is internal to the adapter contract (both SDKs' run registries gain one read-only function; it never opens, extends or revives a run) and is on no public list.
- **Breaking for the rc line.** Removed with no replacement shim: `ap.wrap`, `ap.attribution_for`, the private `_wrap_hooks`; the `airprompter_agent.integrations` package (`chat_completion`, `chat_completion_async`, `responses_create`, `responses_create_async`, `messages_create`, `messages_create_async`, `litellm_inference`, the old callback); from `airprompter_agent.runtime`: `RenderRegistry`, `request_texts`, `WRAPPED_METHODS`, `WrapHooks`, `wrap_client`, and the `runtime.wrap` module (now `runtime.proxy`, internal). `apply_inference` takes no `model=` and `AppliedInference` has no `skipped`.
- **Log events are renamed as in TypeScript** (`ADAPTER_EVENTS`): the Python `wrap_*` events become `adapter_*` (`adapter_unattributed` now once per method), and `adapter_late_record` is new (a record that arrived after its run ended, dropped).
- **`Rendered.run_bound` and `WorkflowStep.run_bound`** (new, default `False`): set when rendered or resolved inside an open run, so the LiteLLM callback treats a late record as that run's (dropped), never as a second run. A public shape gains a field; TypeScript has no LiteLLM adapter and no twin yet.
- **`ap.begin_observation(attribution, model)`** is public (was `_begin_observation`), and inside a run that pinned the slot it now folds into the run, as `ap.observe` does. New `ap.current_attribution()`.
- **Moving over:** `ap.wrap(OpenAI())` → `instrument(OpenAI(), ap, slot=...)` from `airprompter_agent.frameworks.openai` (or `.anthropic`); `chat_completion(ap, rendered, client, ...)` → the instrumented client inside `ap.run` (or inside `with ap.attribute(rendered):` with no slot); `litellm_inference(rendered)` → `litellm_params(placed)`; `from airprompter_agent.integrations.litellm import AirPrompterLiteLLMCallback` → `from airprompter_agent.frameworks.litellm import ...`.
- **Lint and budgets:** an adapter imports only the contract, its own folder, the standard library and its framework; `core`, `sync`, `runtime`, `telemetry` and the agent import no framework package; `tests/test_package_shape.py` pins `agent.py` at 2517 lines and fails an adapter over 300.

### One contract for every framework adapter (AIR-2231, TypeScript)
- **New `@airprompter/agent-sdk/frameworks/contract`**: the run types and `acquireRun`, `chooseModel`, `settingsFor`, `measureCall`, `beginMeasure`, `applySettings`, `instrumentClient`, `ADAPTER_EVENTS`. Public so a third-party adapter can read it, and **outside the 1.0 promise**: a minor may change it while the LangChain and OpenAI Agents adapters prove its shapes. None of it is on `/runtime`: it sits behind an internal barrel (`runtime/adapter/`) that only the contract may import.
- **New adapters:** `@airprompter/agent-sdk/frameworks/openai` and `/frameworks/anthropic` (`instrument(client, ap, { slot, modelFor })`, `applyPlacement`), and `/frameworks/ai-sdk` (`airprompterMiddleware(ap, { slot, modelFor, version })` for `wrapLanguageModel`). With a slot, each call gets the approved instructions in the system position, the release's model and its sealed settings, and is measured into the run; with no run open it is a one-call run. A call that names another model with no `modelFor` declines the slot (`model_unresolved`, one error row) and goes out unchanged: approved text never runs on a model the release did not pin.
- **Breaking for the rc line.** Removed with no replacement shim: `ap.wrap`, `ap.aiSdkMiddleware`, `ap.attributionFor`; from `/runtime`: `wrapClient`, `WRAPPED_METHODS`, `accumulatorFor`, `WrapHooks`, `RenderRegistry`, `requestTexts`, `hashText`, `aiSdkMiddleware`, `generateResultShape` (now on `/frameworks/ai-sdk`), `AiSdkMiddleware*` types, `ApplyInferenceOptions`; from `/core`: `ambiguousAudienceAttribution`. Matching a call to a prompt by hashing its text is gone: a direct client measures only with a slot or inside `ap.attribute(rendered, fn)`, and passes any other call through unobserved.
- **`applyInference` takes no `{ model }` option and never answers `skipped: "model_mismatch"`**: the adapter decides the model first (`chooseModel`), and a call to another model is declined before settings are applied. The `StreamKind` type on `/runtime` is renamed `RequestKind`.
- **Inside `ap.attribute`, without a slot,** a call to the release's model (or naming none) gets that model and the sealed settings; a call to another model with no `modelFor` goes out unchanged and is **not observed** (`model_unresolved`, logged once), so another model's numbers never count against the version. Under `ap.wrap` such a call was observed: an Azure deployment or a gateway alias now needs `modelFor` to be measured.
- **Log events are renamed and fixed** (`ADAPTER_EVENTS`): `wrap_unattributed` → `adapter_unattributed` (now once per method, not per call), `wrap_inference_overridden` → `adapter_inference_overridden`, `wrap_inference_unsupported` → `adapter_inference_unsupported` (always `settings: { setting, reason }[]`, the AI SDK's included), `wrap_tap_failed` → `adapter_tap_failed`, `wrap_attribution_failed` → `adapter_attribution_failed`; new `adapter_stream_helper_unmeasured` and `adapter_placement_failed`; `wrap_inference_model_mismatch` and `wrap_inference_failed` are gone. Every event carries `adapter` and, where there is one, `slot` and `method`.
- **`asResponse()` hands back an unread response**, in both modes: the body is parsed only when the caller awaits the call itself.
- **New `ap.currentAttribution()`**, so the agent satisfies `InstrumentRuntime`.
- **Moving over:** `ap.wrap(new OpenAI())` → `instrument(new OpenAI(), ap, { slot })` from `/frameworks/openai` (or `/frameworks/anthropic`); `ap.aiSdkMiddleware()` → `airprompterMiddleware(ap, { slot })` from `/frameworks/ai-sdk`; `ap.attributionFor(params)` → `ap.currentAttribution()` inside `ap.attribute(rendered, fn)`. A call that only carried a render's text is no longer matched: give the client a `slot`, or call it inside `ap.attribute`.
- **Lint and budgets:** an adapter imports only `./contract.js` and its own framework (an allowlist per adapter in `scripts/lint-imports.mjs`; LangChain is exempt until AIR-2234); core, sync, runtime, telemetry and the agent import no framework package; an adapter file over 300 lines fails `npm run size`; `agent.ts`'s line count is pinned by `packageShape.test.ts`. CONTRIBUTING.md has *Adding a framework adapter*.
- `ai` 7.0.162 is a pinned devDependency, so CI proves on the real AI SDK that `wrapGenerate` receives the object `transformParams` returned.

### n8n: Report Run records inside a real n8n (AIR-2393)
- **Report Run never recorded in n8n.** n8n installs its own `undici` as the global `fetch` dispatcher, and that undici refuses the explicit `content-length` the SDK's telemetry upload sets (`invalid content-length header`), so the upload held and nothing was counted. `integrations/n8n` now hands the Steps core a `fetch` without that header (`fetch` computes it from the body). The SDK-side fix is to stop setting the header in `telemetry/uploader.ts`; `test/n8n/dispatcher.test.ts` says when the workaround can go.
- **Root Public Key is optional** in the n8n credential: Dev's root is pinned. Production still needs it on `1.0.0-rc.4`.
- **`integrations/n8n/scripts/live-n8n.mjs`** runs the node in a real, headless n8n (installed as a community package) against a live AirPrompter, for the n8n QA test (`integrations/n8n/qa/README.md`).
- **Self-hosted n8n only at launch**; depending on the SDK is accepted (decisions recorded on AIR-2393).

### Steps: the hosted prod root is pinned (AIR-2214)
- **`HOSTED_ROOTS.prod` is AirPrompter's production root** (key id `044af6e8…1793`), exactly as the root ceremony of 2026-11-27 wrote it (`infrastructure/trust/agent-root/prod/root-public.jwk.json` in the service repository). A Steps client pointed at the production service needs no `root` any more and no longer reports `root_not_pinned`. A test checks the real prod root document (`fixtures/hosted-prod-root.json`) against the pinned key, and refuses a document signed by any other root, including dev's. Zapier and n8n get it when they move to the release that carries it.

### Zapier and n8n on 1.0.0-rc.4
- **`integrations/zapier` and `integrations/n8n` depend on `@airprompter/agent-sdk` `1.0.0-rc.4`** (exact pin, registry lockfiles). Both now speak protocol 4.0.0 and refuse 3.x manifests, matching AirPrompter's dev server.
- **The temporary protocol override is removed** (added in #105). The Zapier tests run against the repository's registry at 4.0.0 again: `SERVED_PROTOCOL` is gone from `zapier.test.ts`, `startRegistry` loses its `protocol` option, and `devPlane` / `promoteRelease` in the CLI lose the test-only `protocol` override (`DevPromoteOverrides`). The n8n tests use rc.4's own `FakeControlPlane`, which stamps 4.0.0.

## 1.0.0-rc.4 — 2026-11-25 (protocol 4.0.0)

The fourth release candidate, on protocol 4.0.0 (`protocol/v4.0.0`, #105): hosted (managed) execution is removed from both SDKs, the CLI and the testing kit, and both SDKs read only protocol major 4. The CLI moves with it (`cli/v1.0.0-rc.4`). `1.0.0-rc.1` stays reserved for AIR-2231.

**Upgrade with your server.** rc.4 refuses a 3.x manifest (`protocol_unsupported`), and rc.3 does not read 4.x. Move from rc.3 to rc.4 at the same time as your AirPrompter server starts emitting `4.0.0` manifests. AirPrompter's dev server switches with this release; prod switches with its next release.

### Hosted execution is removed (AIR-2317 slice 4)
- **Breaking for the rc line.** Every agent runs on your own systems, so the managed client goes from both SDKs and the CLI.
- **Protocol 4.0.0.** Both SDKs, the CLI and the conformance harness speak protocol 4.0.0 (`PROTOCOL_VERSION`), read only major 4 (`SUPPORTED_PROTOCOL_MAJORS`), and refuse a 3.x manifest with `protocol_unsupported`. Heartbeats, bundles and spool reports carry `4.0.0`. A service must emit `protocol: "4.x.y"` in the manifest payload for this SDK to load it; see `protocol/CHANGELOG.md` › 4.0.0.
- **TypeScript, `@airprompter/agent-sdk` root:** `ManagedAgent`, `ManagedRunError`, `isManagedRunError`, and the types `ManagedStartOptions`, `ManagedRunOptions`, `ManagedRunResult`, `ManagedRunStream`.
- **TypeScript, `@airprompter/agent-sdk/runtime`:** the same, plus `parseSse`, `MANAGED_SDK_USER_AGENT`, and the types `ManagedCatalogue`, `ManagedSlot`, `ManagedRefusalCode`, `ManagedFetchLike`, `ManagedTarget`. The `runtime/managed/` module is gone.
- **Python, `airprompter_agent` and `airprompter_agent.runtime`:** `ManagedAgent`, `ManagedRunError`, `ManagedRunResult`, `ManagedRunStream`, `ManagedWorkflow`, `MANAGED_REFUSAL_CODES`, `MANAGED_SDK_USER_AGENT`, `parse_sse`. The `airprompter_agent.runtime.managed` module is gone.
- **Variables, managed-only parts (both SDKs):** `stricterSources` (TypeScript `/runtime`) and `stricter_sources` (Python `airprompter_agent`, `.runtime`, `.runtime.variables`) are gone. `VariableSourceError` loses the `"unfenceable"` reason. `planFill` / `plan_fill` take `text` as a string, never null, so a `source: runtime` hint no longer plans a variable the text does not use. `VariableSourceContext.versionId` / `version_id` and `arm` are always set (`string` / `str`, no longer nullable).
- **CLI:** `airprompter pull --tags-only` (the hosted catalogue) is gone.
- **Testing kit:** `FakeControlPlane` in both languages no longer serves `GET …/slots`.
- **Conformance:** the OpenAPI hosted-compatibility section of `run.mjs` and the catalogue section of `live.mjs` are gone with the routes they checked.

### Zapier and n8n on 1.0.0-rc.3
- **`integrations/zapier` and `integrations/n8n` depend on `@airprompter/agent-sdk` `1.0.0-rc.3`** (exact pin, registry lockfiles). They get the pinned hosted dev root, and a new connection's first Report run no longer fails.

## 1.0.0-rc.3 — 2026-11-17

The third release candidate, for the Steps core under Zapier and n8n: the hosted dev root is pinned, and a new connection's first Report run no longer fails. Protocol unchanged. Python has no changes and moves with the version only (lockstep). The CLI moves with it (`cli/v1.0.0-rc.3`). `1.0.0-rc.1` stays reserved for AIR-2231.

### Steps: a new connection's first Report run no longer fails (AIR-2392)
- **Report run waits out a slow first heartbeat.** A Steps session closes with `stop()`, which since rc.2 (AIR-2261) bounds its last pass at `telemetry.stopUploadTimeoutMs`, 2000 ms by default, and aborts whatever is still in flight. A new agent's first heartbeat, which issues the upload grant, takes longer than that on a cold service. It was aborted, so every new Zapier or n8n connection's first report came back as a retryable `unreachable … heartbeat_failed` with nothing recorded (2 of 2 live on dev). The Steps client now gives that pass its own per-request limit (`requestTimeoutMs`, default 8000 ms). It was verified live: a fresh dev agent's first report was accepted after about 3 s. The core agent's default is unchanged.

### Steps: the hosted dev root is pinned (AIR-2392)
- **`HOSTED_ROOTS.dev` is AirPrompter's dev root** (key id `86267aa3…df91`), exactly as the offline ceremony of 2026-09-14 wrote it (AIR-1935). A Steps client pointed at the hosted dev service needs no `root` any more. `HOSTED_ROOTS.prod` stays empty, so the production service still reports `root_not_pinned`, because its root ceremony has not run yet. A test checks the real dev root document against the pinned key and refuses a document signed by any other root.

### Zapier and n8n depend on the published SDK
- **`integrations/zapier` and `integrations/n8n` now depend on `@airprompter/agent-sdk` `1.0.0-rc.2` from npm** (pinned exactly; it ships `/frameworks/steps` and `ap.reportRun`), instead of `file:../../sdk-typescript/packages/sdk`. Their `.npmrc` (`install-links`) and n8n's `prepare:sdk` are gone, and building either one no longer needs the SDK built first.

## 1.0.0-rc.2 — 2026-11-16

The second release candidate. `1.0.0-rc.1` is kept for AIR-2231 (the adapter contract), which publishes the candidate after this one; npm and PyPI list rc.2 first until then. Protocol unchanged. The CLI moves with it (`cli/v1.0.0-rc.2`).

### `stop()` sends the last runs (AIR-2261, TypeScript and Python)
- **`stop()` uploads what it ends.** After ending open runs and closing the windows it makes one upload pass (a resident host's own uploader, `flushTelemetry()` on the memory sink), bounded by the new `telemetry.stopUploadTimeoutMs` / `TelemetryOptions.stop_upload_timeout_ms` (default 2000 ms from the call, `0` skips). It waits for an uploader pass already in flight first, so that pass cannot hide the last segment. At the bound TypeScript aborts every request the runtime has in flight, heartbeat and grant included (`FetchLike` and `UploadSegment` take an optional `signal`, `SpoolUploader.runOnce({ signal })`, `postSegment({ signal })`); Python leaves the pass on a daemon thread. Neither holds the process's exit; what did not go stays for the next start, and a pass that sends nothing logs `stop_upload_held`. No pass with `upload: false` or a directory spool this process does not upload. Before this, a short-lived process's last runs waited in the spool until the next start.
- **TypeScript: a `flushTelemetry()` after `stop()` waits for the flush `stop()` started**, so it cannot report `nothing` while that one is putting rows back. Flushes on the request path still never wait on each other.
- **Steps: `timedFetch` keeps the caller's `signal`** beside its per-request timeout, so the stop bound reaches Zapier and n8n requests.
- **`unknown_signing_key` says what to check:** every log event with that reason carries a `hint` naming the root's keys, the service, `hostedEnvironment` and `sync.rootUrl`.
- **Size budget:** `.` 275,000 → 285,000 bytes.

### Steps: one core for Zapier and n8n (AIR-2405, TypeScript)
- **New subpath `@airprompter/agent-sdk/frameworks/steps`** (outside the 1.0 promise for now): `createAutomationClient` and its contract (`AutomationClient`, `AutomationError`, `RolloutCursor`, `RolloutEvent`, …), `slotsOf`, `variablesOf`, `rolloutChanges`, `usageFrom` (token usage from the shapes model steps return), `runReportOf`, `errorClassOf`, `kvAutomationDatastore`, `seedDatastoreFromBundle`, and the trust helpers (`HOSTED_ROOTS`, `distributionKeyFor`, `connectionLabel`, `timedFetch`). It was `src/core/` in both integrations, byte-identical; they now import the SDK only through this subpath (`npm run lint:imports` checks `integrations/*`). Report run goes through `ap.reportRun` alone: the `ap.explain` + `ap.report` fallback is gone. Own size budget; the root entry is unchanged. Python follows in AIR-2406.
- **New in `/core`: `diffReleases(previous, next)`**, the per-slot change between two content-free release snapshots (`current`, `new_version`, `rolled_back`, `ab_started`, `ab_ended`, `dial:<weights>`, `disabled`, `enabled`, `removed`). The Steps trigger's events use it. TypeScript only for now (AIR-2406).

### A run reported by a later step (Zapier, n8n)
- **New: `ap.reportRun(runRef, { inputTokens?, cachedInputTokens?, outputTokens?, error?, latencyMs?, model?, slot? })`** (TypeScript). A prompt rendered in one stateless invocation (`render()` outside a run writes no row) is counted by a later invocation that holds only its `runRef` and the same Agent key or `runRefSecret`: one ordinary one-call run row, `count` 1, on the slot, version, arm and audience the reference carries, whatever release the reporting process holds. `error` takes an error class name or anything `classifyError` reads; only the class is written. With no `latencyMs` the row takes the time since the render's minute, an upper bound. Returns false and writes nothing for a reference that does not verify, a `slot` it does not name, several entries with no `slot`, or a value out of range. No protocol or row change, so Python is unchanged: `ap.explain` plus `ap.report` write the same row there.

### Zapier app (new, `integrations/zapier`, not published)
- **AirPrompter Agents for Zapier**: Get Prompt, Report Run and the Rollout Changed trigger over `@airprompter/agent-sdk`, with an agent Update key. The signed release is kept in `z.cache` (sealed to a key derived from the Update key), verified on every load, and served while AirPrompter is unreachable until the manifest's lease runs out. Its platform-agnostic core (`src/core`, `createAutomationClient`) imports nothing from Zapier. CI runs it against `airprompter dev`.

### n8n nodes (new, `integrations/n8n`, not published)
- **AirPrompter Agents for n8n** (`n8n-nodes-airprompter`): the AirPrompter node (Get Prompt, Report Run) and the AirPrompter Trigger (polling: new version, A/B start/end, dial-up step, rollback, disable) over `@airprompter/agent-sdk`, with an agent Update key. The signed release is kept on the n8n side — the n8n user folder when self-hosted, workflow static data without a disk — sealed to a key derived from the Update key, verified on every load, and served while AirPrompter is unreachable until the manifest's lease runs out. A vendored `.apbundle` seeds fully offline installs. Built on the same platform-agnostic core as the Zapier app (`src/core`, byte-identical). CI runs it against `airprompter dev`.

### Runs: several prompts in one request (AIR-2242)
- **Python gets the run session** (`airprompter_agent.runtime.run`): `with ap.run(...) as run:` and `async with ap.run(...) as run:` from one object, `run.place` (sync sources only) and `run.place_async`, `run.run_ref`, `set_tags`, `slot_for`, `decline`, `record_model_call(..., tools_observed=)`, `record_tool_call`, `end(error_class=None, interrupted=False)`, `ap.open_run`, `ap.current_run`, `ap.with_run`, `ap.explain`, and `ap.feedback(..., slot=)`. The same rows, rules and review fixes as TypeScript.
- **Python: a start with nothing promoted no longer raises.** It runs at generation 0 and `place` answers `passthrough no_verified_release`, as TypeScript has since S0. A missing subject is a fresh id per call, never the instance id, unless the experiment's `subjectKey` is `instance`.
- **A run holds several slots.** Each slot pins one version at its first `place`, and the run writes one run row per slot when it ends: `count` 1, `modelCalls`, tool counts and summed tokens, with `agentRun` 1 on the first row only, plus a `step` row per named step. This closes the rc.0 gap where `RunSession` wrote `modelCalls: 1` and `agentRun: 1` on every slot.
- **Breaking: `RunSession.id` is gone.** `run.runRef` is always a string, a getter that grows one entry per slot and keeps one run id. `RunInput.resume` takes a run reference. LangChain's graph state key is now `airprompter_run_ref` (was `airprompter_run_id`).
- **New on `RunSession`:** `setTags` (late tags for later slots), `slotFor(slots, name)`, `decline(slot, "model_unresolved")`, `step` and `outputText` on `recordModelCall`, `step` on `recordToolCall`, and `end({ interrupted: true })`, which parks a run for a resume in the same process.
- **`ap.feedback` files on every entry of a reference** unless `{ slot }` names one. `{ model }` on a reference with several entries needs `{ slot }`. **`ap.explain(runRef)`** decodes a reference.
- **The direct path joins a run.** Inside `ap.run`, `ap.prompt` and `ap.workflow` resolve through the run's pin, `ap.prompt`'s rendered `runRef` is the run's, and `ap.observe` folds into the run, so one request counts once.
- **The idle sweep** writes `interrupted` for a run no record failed (it wrote `ok`), runs at the edges of `invoke()` on serverless hosts, and holds at most 10,000 open runs.
- **The heartbeat's `runCounters.passthrough`** counts each passthrough reason once per slot per run, plus `unmapped_step` and `slot_not_in_release`.
- **LangChain:** a model the middleware cannot build writes one `model_unresolved` error row per run.
- **Size budgets:** `./runtime` 215,000 → 260,000 bytes, `.` 265,000 → 275,000.
- **Protocol 3.1.0: window rows v5, step rows v2.** Both gain a required `toolsReported`, true when the writer saw the row's tool calls, so `tools.calls: 0` means none ran. `usageSource` and `toolsReported` join the window key and the step key, so a `reported` run and an `unavailable` run in one minute land in two rows. `recordModelCall` takes `toolsObserved`, which LangChain sets on every call. A cut-over: old row versions are neither written nor read. See the [protocol changelog](protocol/CHANGELOG.md).

## 1.0.0-rc.0 — 2026-11-04 (protocol 3.0.0, Python 1.0.0rc0)

The release candidate for 1.0.0, published beside `latest`: `npm install --save-exact @airprompter/agent-sdk@1.0.0-rc.0`, `pip install "airprompter-agent==1.0.0rc0"`. Pin every package to the candidate, satellites included: an unpinned datastore installs the 0.x release, which brings the old split packages in beside the SDK. npm's default range, `^1.0.0-rc.0`, also matches later candidates, and a later candidate removes `ap.wrap`. pip's `--pre` opens prereleases on every dependency; `uv pip install` resolves the same pins with no flag. The CLI candidate is the GitHub pre-release `cli/v1.0.0-rc.0`; `@airprompter/cli` stays off npm. This is the version a dev environment on protocol 3.0.0 installs until 1.0.0.

Both SDKs speak protocol 3.0.0 and no other. See the [protocol changelog](protocol/CHANGELOG.md) for the wire.

### Known gaps
- **`RunSession` reports `modelCalls: 1` and `agentRun: 1` on every slot** (TypeScript), however many model calls a run makes. A later candidate records what the run did.

### One package per language
- **Breaking: install one package.** `@airprompter/agent-core`, `-sync`, `-runtime` and `-telemetry` are folded into `@airprompter/agent-sdk`, and `airprompter-agent-core`, `-sync`, `-runtime` and `-telemetry` into `airprompter-agent`. Nothing new is published under the old names.

  | Before | Now |
  | --- | --- |
  | `@airprompter/agent-core` | `@airprompter/agent-sdk/core` |
  | `@airprompter/agent-core/testing` | `@airprompter/agent-sdk/testing` |
  | `@airprompter/agent-sync` | `@airprompter/agent-sdk/sync` |
  | `@airprompter/agent-runtime` | `@airprompter/agent-sdk/runtime` |
  | `@airprompter/agent-telemetry` | `@airprompter/agent-sdk/telemetry` |
  | `@airprompter/otel-bridge` | `@airprompter/agent-otel/exporter` |
  | `airprompter_agent_core` | `airprompter_agent.core` |
  | `airprompter_agent_sync` | `airprompter_agent.sync` |
  | `airprompter_agent_runtime` | `airprompter_agent.runtime` |
  | `airprompter_agent_telemetry` | `airprompter_agent.telemetry` |
  | `airprompter_agent_telemetry.otel` | `airprompter_agent_otel.exporter` (distribution `airprompter-agent-otel`) |

- **Breaking: the TypeScript root exports a list, not everything.** `@airprompter/agent-sdk` exports `AirPrompterAgent`, its option and result types, and the hosted client. Every other name moved to its subpath: `import { publicJwkOf } from "@airprompter/agent-sdk/core"`.
- **`@airprompter/agent-otel` and the `@airprompter/datastore-*` packages take the SDK as a peer** at the same version, so an application holds one copy. The Python satellites pin `airprompter-agent` exactly.
- **Python extras moved to the one distribution:** `kms`, `vault`, `keyring`, `openai`, `anthropic`, `litellm`.
- **`httpx` is bounded below 1.0** (`>=0.27,<1`) in `airprompter-agent` and `airprompter-agent-otel`: its 1.0 prereleases take no `timeout` on `Client`, and `start()` needs it.
- **`SDK_VERSION` has one source per language:** written from `packages/sdk/package.json` at build, read from the installed distribution's metadata in Python (`0+unknown` when the source runs with no metadata beside it).
- **The import lint in both languages holds a layer to another layer's package,** never a module inside it.
- `version-lockstep.mjs` and `version_lockstep.py` read a prerelease in either form, `1.0.0-rc.0` or `1.0.0rc0`.
- `release.yml` publishes a prerelease under the npm dist-tag `next` and marks its GitHub release a pre-release.
- `tag-release.yml` and the verify action accept a prerelease tag such as `cli/v1.0.0-rc.0`. Conformance and protocol tags stay final-only.

### Added
- `runRefSecret` and `runRefPreviousSecrets` on `start()` (Python: `run_ref_secret`, `run_ref_previous_secrets`). A run reference now works on any instance of an agent and target; the key derives from the secret, else the Agent key.
- `recordRun` and `recordStep` on `SpoolWriter` (Python: `record_run`, `record_step`), and the `RunTotals`, `StepTotals`, `RunDimensions`, `TokenTotals`, `StepRow` and `STEP_BOUNDS` exports.
- `step` on `ap.report`, `ap.observe` targets and `ap.attribute`; `toolCalls` on `ap.report` and `ap.observe` (Python: `tool_calls`).
- `newRunId`, `runRefKeyFrom` and the `RUN_REF_*` bounds; `servableSlots`, `servableExperiments`, `servableOverrides`; `frozenExperiment`; `SUPPORTED_CAPABILITIES`; `capabilitiesImplemented`; `HostedEnvironment`; `TARGET_SLUG`; `AGENT_ID`; `countOf`; `SLOT_TAG`, `WINDOW_STATUSES`, `STEP_STATUSES`, `USAGE_SOURCES`, `ERROR_CLASSES`.
- `slotHashes`, `carriedPayloads`, `optionalPayloads`, and `carrying` and `absentRequires` on `verifyManifest` (Python: `slot_hashes`, `carried_payloads`, `optional_payloads`, `carrying`, `absent_requires`).

### Changed
- **`artifactId` is required on `ap.report`, `ap.observe` targets and spool observations** (Python: `artifact_id`). `ap.report` logs `observation_dropped` and drops a row it cannot write; it never throws.
- **Telemetry never replaces a model result:** a failure to record is logged, and `ap.observe` returns the result or re-raises the provider's own error.
- **`Target` is any lowercase slug**, and `start()` refuses anything else, or an `agentId` that is not an identifier, with `invalid_options`. `HostedEnvironment` names a deployment.
- **`RunRefFacts` holds `runId` and `entries`.** `parseRunRef` takes one key or a list.
- **An override this SDK cannot serve:** if an arm loses the override of the experiment's own tag, or the `subjectKey` is unknown, the host sits the experiment out (base text, arm `none`, bucket null); an unmet override of another tag goes alone. An experiment with every arm disabled stops a host that sits it out, and a pinned run.
- **An audience selector this SDK cannot read loads and matches nothing.** An unknown `audienceId` and a fingerprint mismatch stay refused.
- **`experimentConflict` refuses an arm-scoped disable with no `experimentId`**, and `status().ramps[].tag` is never null.
- **Spool uploaders strip unknown fields, skip rows they cannot read and count those lines in a `dropped` row's new `lines` field.** Only corruption quarantines a segment. `inspectSegment` returns `skipped`, `stripped` and `payload`. Status is a closed list per row type; a later value is skipped, and a member of the other row form is refused.
- **A spool writer drops a bad observation** with `telemetry_tag_invalid` and its siblings, so no writer input can quarantine a segment. A tag carrying `#N` is one of them.
- **`airprompter dev`, `--environment` and every other target option take a slug.** `telemetry validate` reports what an uploader would clean up.
- **Python `healthz` at generation 0 is `degraded`**, as TypeScript's is.
- **`pullBundle` and `airprompter pull` carry every payload a release names**, including a slot this SDK cannot serve, and take a release with a capability they lack. `store.load` treats a missing payload named only under `requires` as an absent slot, so a host that gains a capability comes up serving and a sync picks the slot up at the same generation, trying once. A bundle host picks it up at its next generation.
- **A manifest refused for a capability still delivers its disables**, on a sync pass, a bundle or a datastore read. They stack on the active release's own, and the next refused manifest replaces them. `onDirectives` takes `{ reduceOnly: true }` on that path (Python: `reduce_only`).
- **`store.stage` refuses any entry whose name is not a content hash or whose bytes do not hash to it**, referenced or not.
- **`ap.feedback` returns false for a token that is not a string.**
- **`airprompterd`'s fallback report fills every field the heartbeat requires**, and `report.required` in the spool manifest equals the heartbeat's list minus `spool`.
- **`airprompter telemetry validate` reports what an uploader would strip or skip**, and says `would not ship as written`.

### Removed
- `protocolAtLeast`, `AUDIENCE_CAPABILITY`, `AUDIENCE_PROTOCOL_VERSION`, `experimentForTag`, `experimentsOf`, the `experiment` manifest member and `ManagedCatalogue.experiment`, in both SDKs (Python: their snake_case names).
- `onLeaseExpiry` and all halt behaviour: `status().onLeaseExpiry`, the `lease_expired` value of `RenderRefusedError` and `UnavailableReason`, and the healthz reason `lease_expired_halt`. A lapsed lease reports stale, degraded with reason `lease_expired`, and keeps serving.
- The healthz `failing` level and the 503 answer: no rule stops an agent from serving.
- `Disabled.arms` as an input. Arm-scoped disables are per experiment; the status and heartbeat view stays flat.
- The `sync.mode: "daemon"` refusal.

## 0.6.0 — 2026-11-04 (protocol 2.0.0)

TypeScript only. The Python SDK stays at 0.5.0 until AIR-2242 brings the same run session to it. No schema, vector or wire byte changed.

### Added
- `@airprompter/agent-sdk/frameworks/langchain`: `airprompter(ap, { slots })`, middleware for `createAgent`. It runs the agent on the approved prompt and model, and counts one request as one run. The root import never loads LangChain. List it last in `middleware`.
- A run: `ap.run(input, fn)`, `ap.openRun`, `ap.currentRun` and `ap.withRun`. One run holds one version per slot, a disable applies at the next `place`, and a run with no activity for `runIdleTimeoutMs` (default 15 minutes) ends by itself. A run's calls recorded through `recordModelCall`, as the LangChain middleware does, write one row with `count` 1, the run's total tokens and its wall-clock latency. `ap.prompt` plus `ap.observe` still count per call, inside a run or not, until AIR-2242.

### Changed
- **`start()` no longer throws `no_verified_release`.** With nothing promoted an agent starts at generation 0, logs `started_without_release` with the control plane's answer, keeps syncing, and takes the first promotion with no restart. Plain `ap.prompt(...).render()` has no prompt to fall back on, so it now throws at the first render instead of at start.
- **`healthz` at generation 0 is `degraded`, not `failing`**, so a liveness probe does not restart a working agent on a 503.
- **An absent subject is a fresh id per call, not the instance id.** Before, a small fleet could never reach a 5 % arm, because it split instances, not users. A call with no subject no longer sticks to one arm: pass a subject for that. `subjectKey: "instance"` still splits by instance.

## 0.5.0 — 2026-10-07 (protocol 2.0.0)

### Changed
- Audience targeting has one capability, `audience`, and one selector shape. Tag conditions require an explicit `is` or `contains` operator and combine with implicit AND semantics.
- The first heartbeat advertises audience support without registration. Names-only registration begins after the authenticated service response echoes protocol 2.0.0 and the capability.
- Targeted manifests from the unpublished draft protocol are refused. Non-targeted major-zero manifests remain readable.

## 0.4.1 — 2026-10-06 (protocol 1.1.1)

### Added
- Hosted `ManagedAgent` clients accept process and per-run arbitrary tags, match signed audience selectors locally, and transmit only opaque audience ids.
- A catalogue that advertises `catalogue_generation` makes hosted runs carry its signed generation. A stale catalogue refusal refreshes `/slots`, recomputes audience membership from current local tags, and retries once; older services remain compatible because their catalogues do not advertise the field.

### Fixed
- Workflow step telemetry such as `onboarding.flow#1` now passes the shared protocol, TypeScript, and Python validators.
- Hosted clients preserve workflow telemetry and catalogue-refresh behavior introduced in this release line.
- All-device audiences remain server-derived; managed clients submit only locally matched tag audiences.

## 0.4.0 — 2026-10-06 (protocol 1.1.0)

### Added
- Local arbitrary-tag audiences with case-sensitive `is` and `contains` predicates. Every condition must match; tag values stay on the host and only registered tag keys are reported.
- Artifact-aware protocol-v3 telemetry windows and signed run references preserve Team prompt identity, audience membership, model, and original run minute for delayed feedback.
- Feedback accepts an actual-model override so ratings merge into the same window when a provider call overrides the prompt's configured model.

### Changed
- This unpublished draft introduced capability negotiation for audience targeting; protocol 2.0.0 replaces the draft contract before production release.
- npm and PyPI packages remain lockstep at SDK 0.4.0.

## CLI 0.3.0 — 2026-10-03 (SDK 0.3.0, protocol 0.3.4)

- Ships the CLI changes documented under SDK 0.3.0 as four signed single-file executables. The daemon now ships telemetry only; `status`, `doctor`, `unlock`, `rollback` and `policy` use the local store and daemon discovery file. Operators upgrading from CLI 0.1.0 must remove the retired release-serving daemon flags and `dev --daemon`.
- The verify action can be pinned to `action/verify@cli/v0.3.0`.

## 0.3.0 — 2026-09-28 (protocol 0.3.4)

The daemon ships telemetry and nothing else; every process loads its own release — from its store, from the
customer's datastore (new in this release), or from a vendored bundle. 0.2.15 was never published: its changes are
listed here.

### Removed — breaking
- `sync.mode: "daemon"` (`SyncOptions(mode="daemon")`) and `sync.daemonSocketPath` (`daemon_socket_path`): `start()` refuses them with `AgentStartError("invalid_options")`. A process in daemon mode took its release from `airprompterd` and skipped the rest of start-up, so a datastore given to it was never read — the report behind this release was "Europe loads its release from the daemon, and the SDK will not also hydrate that process from the datastore". Such a process now boots like any other: its own store, then the datastore, then the vendored bundle, then its own sync.
- The daemon client: `DaemonClient`, `DaemonError`, `isDaemonError`, `daemonSocketPath`, `DAEMON_MAX_LINE_BYTES`, `UNIX_SOCKET_PATH_MAX` and the `Daemon*` types from `@airprompter/agent-sync` and the facade; `DaemonClient`, `DaemonError`, `DaemonHello`, `daemon_socket_path`, `DAEMON_MAX_LINE_BYTES` from `airprompter_agent_sync` and `airprompter_agent`. `ReleaseSource` and `storageProtection` lose `"daemon"`; `hydrate()` / `applyBundle()` lose the `daemon_attached` refusal.
- `status().daemon` is replaced by `status().telemetry` (below); the healthz document's `daemon` field is replaced by `telemetry`, and its `daemon_detached` reason by `upload_daemon_stale`.
- `airprompterd`'s socket and its operations (`hello`, `slot`, `status`, `sync`, `unlock`, `rollback`, `policy`, `healthz`, `upload`). `airprompter daemon` refuses `--root`, `--hosted-environment`, `--root-url`, `--edge-pointer-url`, `--poll-seconds`, `--socket` and `--apply-policy` by name; `airprompter dev --daemon` is refused; `status`, `unlock`, `rollback`, `policy` and `doctor` lose `--socket` and act on the host's store directly.

### Migration
- A process that ran with `sync.mode: "daemon"`: drop the option. With an Agent key it syncs itself (`resident`); without one it hydrates from the customer's datastore (`datastore: { store, region }`, `docs/datastore.md`) or serves a vendored bundle. Keep `airprompterd` running for telemetry, with the removed flags dropped, on the same state directory.
- The deploy manifests in `deploy/` are updated; their liveness probe is `airprompter status --require-daemon`.
- `airprompter unlock` / `rollback` / `policy set` change the host's store; a process started afterwards serves the change, a running one keeps what it loaded until its own `ap.unlock()` / `ap.rollback()` / `ap.setApplyPolicy()`, the update window or the hook moves it — or, across a fleet, a rollback in the datastore reaches its next `hydrate()`.

### Added
- The telemetry daemon (`protocol/daemon.md`, draft 3): `airprompterd` publishes `<store dir>/daemon.json` (`schemas/daemon.schema.json`: pid, version, the spool folder it scans, the sink, how its uploads are going; mode 0600, refreshed every minute, deleted on a clean stop), ships the segments SDK processes write there to AirPrompter or — with `--upload-sink otlp` — to your collector, and holds no store, no store key and no socket. `--spool-dir` moves the folder. One daemon per agent and target, as before.
- Segment manifests (`protocol/spool-format.md`, draft 3; `schemas/spool-manifest.schema.json`): both SDKs write `seg-….manifest.json` beside every segment they close — its size, SHA-256 and row count, the writer's scope, and its heartbeat report without `spool` (`DirectorySink`'s `manifest` option). The uploader leaves a segment whose manifest names another agent or target alone, quarantines a segment that no longer matches its manifest together with it, waits a minute for a manifest before shipping a segment without one (a third-party writer, an SDK before 0.3.0), sweeps orphan manifests, and hands the writer's report to `grantFor(instanceId, report)` — so the daemon obtains each writer's grant with that writer's own report, and a runtime that never talks to AirPrompter (hydrated from the datastore, no key) appears in the fleet view as what it is. `SpoolUploader` takes `scope`, `manifestGraceMs` / `manifest_grace_ms` and `onPass` / `on_pass`; `UploadSegment.report`; `status().foreignSegments`. Manifest and discovery helpers (`readDaemonDiscovery`, `writeSegmentManifest`, … / `read_daemon_discovery`, `write_segment_manifest`, …) are exported from the telemetry package.
- Where the spool goes: `telemetry.spoolDir` (`TelemetryOptions(spool_dir=…)`), else `AIRPROMPTER_SPOOL_DIR`, else the folder a live daemon publishes, else `<store dir>/spool/telemetry`. While a live daemon ships that folder a process runs no uploader of its own; when the daemon stops or its file goes stale (ten minutes) a process with a key takes the upload back — re-checked every minute both ways, or now with `ap.checkTelemetryDaemon()` / `ap.check_telemetry_daemon()`. `status().telemetry` says which folder, where it came from, who uploads and how the daemon looks; healthz reports `upload_daemon_stale` when the daemon went stale and nothing here uploads instead. A daemon that ships nothing (`sink: "none"`: no key, no collector) never takes the upload from a process that can.
- `airprompter status` works on a host with no store (the daemon's own container) and never creates one; it reports the daemon from `daemon.json` and exits `1` when the file is stale — with `--require-daemon`, when there is none. `airprompter doctor` checks the file (live, this scope, its folder writable).
- Your datastore carries the release (T40, TypeScript and Python): the puller writes every sealed release into a datastore the application already runs, and every runtime hydrates from it — the release, its dial-up percentages and ramp, the fleet's rollback, the region. Two layers, so any backend can join: `KvStore` (four operations — `get` with an opaque version, a conditional `put` (`ifAbsent` / `ifVersion`), `list` by prefix, `delete`; no transactions) and `kvReleaseDatastore(kv)` / `kv_release_datastore(kv)`, the SDK's `ReleaseDatastore` over any `KvStore` in one shared format (`protocol/datastore-format.md`), so a Python puller and a TypeScript runtime share one bucket. `MemoryKvStore`, `fsKvStore` / `FileKvStore` and `MemoryReleaseDatastore` ship in `agent-sync`. `docs/datastore.md`.
- Three optional adapters, one per language, bundling no client library: `@airprompter/datastore-s3` / `airprompter-datastore-s3` (S3's `If-None-Match` / `If-Match`; MinIO and R2 too), `@airprompter/datastore-postgres` / `airprompter-datastore-postgres` (one table; `INSERT … ON CONFLICT`, versioned `UPDATE`s; `pg`, Neon, psycopg 3, psycopg2), `@airprompter/datastore-redis` / `airprompter-datastore-redis` (atomic Lua writes, a sorted-set index, one cluster hash tag; `redis`, `ioredis`, redis-py). The TypeScript and Python adapter for a backend use the same table, keys or objects.
- `checkKvStore` / `check_kv_store`: the contract an adapter proves against a live backend — conditional writes, exact prefixes (no `%`, `_`, `*`, `?` or `[` is a wildcard), large and non-ASCII values, and racing writers (exactly one of N wins). CI runs it for all three adapters in both languages against live Postgres, Redis and an S3 endpoint, plus a cross-language test: releases and a rollback the TypeScript adapter wrote hydrate a Python runtime through the Python adapter, for every backend.
- `pullToDatastore` / `pull_to_datastore`: the puller around the datastore — the edge state and newest generation read from it, the sealed release written back with a content-free `rollout` summary, then the edge state (never before its release). `AirPrompterAgent.start({ datastore: { store, region, pollSeconds } })` hydrates from it after the host's own store and before the vendored bundle; `ap.hydrate()` re-reads it; `status().datastore` reports it. Every record is verified through the same chain as OTA; a record from a newer format is refused, never served.
- Fleet rollback held in the datastore: `rollbackDatastore` / `rollback_datastore` names an older release and the generation it steps down from; every runtime that hydrates next steps down (verified, stamped as a forced downgrade) and holds the newer generations back until a later promotion or `clearDatastoreRollback` ends it. Written only if the rollback is still what was read — a racing operator gets `conflict`. An older release with no rollback in the datastore is still refused.
- Regions: every release and rollback is keyed by region; a region with releases of its own serves them, one without reads the global ones; a regional rollback binds that region, a global one every region without its own.
- `pruneDatastore` / `prune_datastore` keeps the newest N releases and the one a rollback names. `SlotStore.holdBack` / `releaseHold` (`hold_back` / `release_hold`) set and clear the store's existing `heldBackBelow` for the datastore's rollback; no store-format change.

### Changed
- Publish size budgets: `@airprompter/agent-sync` 220 KB (was 160) — the KV layer, the record codec and the adapter check; `@airprompter/agent-sdk` 260 KB (was 240) — the datastore hydration.

### Fixed
- Every npm package stopped shipping `dist/esm/.tsbuildinfo` — TypeScript's incremental-build cache, in every tarball since the packages split (37 KB in most, 168 KB in `datastore-s3`). `scripts/install-alone.mjs` fails a tarball that carries a build cache, a source tree, a test or no LICENSE.
- The release workflow can be re-run after a partial failure: a version already on npm or PyPI is skipped instead of failing the run before the rest of the version goes out (a new npm package's first version must be published by hand before npm accepts a trusted publisher for it; `release.yml` says how).
- The Node filesystem port's `listRecursive` returned directories as well as files; it returns files only, as the port documents and as `MemoryFs` and the Python port always did (`SlotStore.listSlotFiles` no longer lists `payloads`).

## 0.2.14 — 2026-09-17 (protocol 0.3.4)

### Added
- `airprompter rollback`: the previous release on this host live again, now and offline — the store's other slot, through the daemon when one runs. A step below the stored generation is a forced downgrade, recorded and reported on the next heartbeat, and sync holds the newer generation back until the control plane moves past it. The README and `docs/change-control.md` had named the command since the first release; it exists now.
- `fileKey(path, fs?)` takes the filesystem port the store uses, and the facade passes its `fs` option through, so an application running the store on a memory or custom filesystem keeps the key file there too; the vendored bundle path is read through the same port.

### Changed
- Every source file opens with a header that says what the file is for and shows one usage example (CONTRIBUTING.md › File headers); `scripts/check-headers.mjs` enforces it in CI.

### Fixed
- A local rollback (`SlotStore.rollbackLocal` / `rollback_local`, `ap.rollback()`, `airprompter rollback`) is refused while the other slot holds a STAGED release — flipping to it was a silent unlock, not a rollback (`release_staged`) — and when the host has only ever held one release (`no_previous_release`, where the error used to say `slot_corrupt`).

## 0.2.13 — 2026-09-17 (protocol 0.3.4)

### Changed
- The heartbeat's `catalog.variables` is sent whenever the active release was sealed at protocol ≥ 0.3.4 — an empty list when the application registered no source. An empty list is a report ("I fill nothing"); an absent key says nothing, and the service counts only reporting instances in "filled on X of Y", so a 0.3.4 fleet with no sources now reads as uncovered rather than unknown.

## 0.2.12 — 2026-09-17 (protocol 0.3.4)

### Added
- Protocol 0.3.4: a slot variable's `default` (an optional `operator` variable's last resort, rendered by `renderTemplate` / `render_template` when neither the call site nor a source supplies a value — `defaultOf` / `default_of` say where one counts) and `source` (`caller` | `runtime`); both digest-bound when present. `SlotVariable` carries them in TypeScript (`ManagedSlot.variables` too); the Python projection agrees; the trust vectors seal both. In managed mode a `source: runtime` variable is filled from the registered source before the run is posted, required or not.
- The heartbeat reports `catalog.variables`: the names this application can fill from its registered sources (`ap.variables.names()`), never a value — sent only once the active release was sealed at protocol ≥ 0.3.4 (`protocolAtLeast` / `protocol_at_least` in core), because a service at 0.3.3 refuses the whole heartbeat over the unknown key. Upgrading the SDK ahead of the service is safe.
- `airprompter dev`: `variables:` front matter takes `name=default` (an optional operator variable's default; never empty, no comma in it), `name~` (filled by the application's source), `name!~` / `name?~` and `name~=default`; a default on a required or end-user variable is refused as the schema refuses it, and a name outside the grammar is an error rather than a variable called `name~`.

### Changed
- Precedence at render is now the full ladder: the call site's value → a registered source → the declared default → empty (optional) or `MissingVariableError` (required). `plan_fill` / `planFill` are unchanged: a default is applied by the render itself, so a source is still consulted first for a variable the text uses.

## 0.2.11 — 2026-09-17 (protocol 0.3.3) — the Python SDK catches up with 0.2.10; TypeScript republished unchanged to keep the lockstep

### Added (Python)
- Variable sources: `AirPrompterAgent.start(variables=...)` and `ap.variables.provide(name, value_or_source)` / `revoke(name)` — a literal, a `VariableSource(resolve, trust, timeout_seconds, max_bytes)` (2 s and 64 KiB unless given; `DEFAULT_SOURCE_TIMEOUT_SECONDS`, `DEFAULT_SOURCE_MAX_BYTES`), or that as a mapping — with the same precedence, the same "consulted only when this version's text uses it", and the same stricter-trust fencing as TypeScript (`variable_source_trust_stricter` logged once per slot and name).
- `render()` is synchronous and RUNS a plain-callable source — on a daemon thread of its own, all sources at once, each under its own timeout measured from the moment the render dispatched it, the first failure ending the render — holding none of the agent's locks; a source that ignores its timeout keeps its thread until it returns but never holds up the interpreter's exit. A coroutine-function source is refused with `VariableSourceRequiredError` (use `await ap.prompt(tag).render_async(...)`, which awaits those and runs plain callables on a daemon thread — never the loop's default executor); a plain callable that hands back a coroutine is awaited there too. The managed client is synchronous throughout, so it refuses a coroutine-function source by name. Failures are `VariableSourceError(tag, variable, reason)` (`threw` · `timeout` · `too_large` · `not_text` · `empty` · `unfenceable`), plus `variable_source_failed` in the log and one content-free `render_missing_variable` error row under the slot's tag. The slot is captured before any source runs, so a release activating mid-lookup never mixes generations.
- `ap.prompt(tag).needs(values)` and `AgentStatus.variables` (`{"sources": [...], "unsourced": [{"tag", "arm", "names"}]}`), from declarations alone.
- `ap.workflow(tag)` returns a `WorkflowHandle` (a `Workflow`) with `render_step(step_id, values)` / `render_step_async`; `ManagedAgent.start(variables=...)` and `agent.needs(tag, values)` fill required declared variables before a hosted run is posted, an `end_user` source for an `operator`-declared variable refused before any lookup (`unfenceable`).
- `ReleaseResolver.render_text()` (one render path for prompts and steps; `render()` takes `fenced=` and an already-decoded `text=`); `placeholders_of(text)` in `airprompter_agent_core`; `MissingVariableError.code` / `UnknownVariableError.code`.
- `airprompter_agent_runtime.variables` is the new subpackage; every public name in it is re-exported from `airprompter_agent`.

### Changed
- TypeScript: no functional change; 0.2.11 is the same code as 0.2.10.

## 0.2.10 — 2026-09-17 (protocol 0.3.3) — TypeScript only; Python follows in 0.2.11

### Added
- Variable sources: `start({ variables })` and `ap.variables.provide(name, valueOrSource)` / `revoke(name)` fill a declared variable from the application's own system at render time — a literal, or `{ resolve: async (ctx) => …, trust, timeoutMs?, maxBytes? }` with `trust` required. Precedence: the call site's value, then a source (consulted only for a declared variable that is required or present in the text, so a version that dropped it never causes the lookup), then missing. The effective trust is the stricter of the prompt's declaration and the source's; an `end_user` source is fenced wherever the prompt declared `operator`, and `variable_source_trust_stricter` is logged once per slot and name.
- `ap.prompt(tag).renderAsync(values)` runs sources (concurrently, each under its own timeout and byte bound); `render()` stays synchronous and throws `VariableSourceRequiredError` when a callable source would be needed. A source that throws, times out, oversizes, answers something other than text, or answers nothing for a required variable is `VariableSourceError { tag, variable, reason }` (`threw` · `timeout` · `too_large` · `not_text` · `empty`; `unfenceable` in managed mode) plus `variable_source_failed` in the log and one content-free `render_missing_variable` error row. The slot is captured before any await.
- `ap.prompt(tag).needs(values)` and `status().variables` (`sources`, and per slot and arm the required names no source fills — `unsourced`) find an uncoverable version at start-up, from declarations alone (no payload is read).
- `flow.renderStepAsync(stepId, values)` renders a workflow step with the same precedence, scanned per step; `ManagedAgent.start({ variables })` and `agent.needs(tag, values)` fill required declared variables before a hosted run is posted (an `end_user` source for an `operator`-declared variable is refused before any lookup — `VariableSourceError` reason `unfenceable` — since a hosted run cannot fence it; an aborted run is not filled).
- `ReleaseResolver.renderText()`: one render path for prompts and workflow steps (fencing and delimiters in one place; `render()` takes `fenced` and an already-decoded `text`). `placeholdersOf(text)` in `@airprompter/agent-core`; `MissingVariableError` / `UnknownVariableError` carry `code`s (`render_missing_variable`, `render_unknown_variable`) so callers identify them by name and code, never `instanceof`.
- `docs/variables.md`.

### Changed
- Publish size budgets: `@airprompter/agent-runtime` 180 KB (was 160), `@airprompter/agent-sdk` 240 KB (was 220) — the variables module.
- `VariableSourceContext.versionId` / `.arm` are `string | null` (null in managed mode, where the run route resolves them). The runtime barrel also exports `stricterSources` and `supplied`.

## 0.2.9 — 2026-09-17 (protocol 0.3.3)

### Fixed
- The edge pointer a puller polls can hide nothing for long: it is believed for at most `maxPointerAgeMs` (one hour) after the origin last answered, then the origin is read once; the edge state never advances past an answer the origin did not confirm (an origin blip after the pointer moved no longer hides that promotion until the next one); a CDN outage or a malformed pointer falls through to the origin. Python reads the pointer's generation as an integer or not at all.
- The demo puller commits its edge state after the row, never before.

## 0.2.8 — 2026-09-17 (protocol 0.3.3)

### Added
- `pullBundle` / `pull_bundle` read the CDN edge pointer first when the caller hands back the last result's `edge` (`pointerUrl`, `pointerEtag`, `manifestEtag`): a 304, or a generation the caller already holds, is `{ status: "unchanged", via: "pointer" }` and the API is never called; only a moved pointer reaches the origin, conditionally. `skipPointer` reads the origin at once (a nudge, an operator).
- `nextPullDelayMs` / `next_pull_delay_ms`: the interval doubles while nothing changes, to a cap (five minutes by default), and snaps back on any change, refusal or outage.
- `docs/change-notification.md`: the pointer-first pull and the proposed nudge on a channel the customer owns.

### Changed
- An origin 304 on a conditional pull is `unchanged` via `origin`; it was `unavailable` with reason `http_304`.
- `ManifestFetch` carries `edgePointerUrl` (`edge_pointer_url`) from the manifest answer's `x-agent-edge-pointer-url` header.

## 0.2.7 — 2026-09-16 (protocol 0.3.2)

### Added
- A workflow step carries its prompt version's inference settings (`steps[].inference`, digest-bound); `WorkflowStep` carries `model` and `inference`; `attribute()` takes a step in both SDKs.
- Golden-set invocations carry `inference`; the AI SDK middleware applies the settings through `transformParams` (`maxTokens` for AI SDK 4, `maxOutputTokens` for 5+); `litellm_inference(rendered)` returns the keyword arguments for a LiteLLM call; `apply_inference` is exported from the Python package roots; `copy_inference` from the runtime.
- The hosted slots catalogue (`GET …/slots`) names each slot's and step's inference block; `ManagedSlot.inference`.

### Changed
- The release's settings go only on a call to the release's model: a call site that names another model keeps its own parameters and is told (`wrap_inference_model_mismatch`).
- On Anthropic Messages the wrapper sends `temperature` alone when the slot carries both sampling parameters, and neither beside a `thinking` block; `wrap_inference_unsupported` entries are `{ setting, reason }` (`shape`, `one_sampling_parameter`, `thinking`).
- A Responses `reasoning` object is merged (`effort` set, the caller's `summary` kept), not replaced.
- Python hands out a plain copy of the inference block; the registry and every scope keep their own.

### Fixed
- The Python `with ap.attribute(rendered)` scope carried no inference settings (it read them off the observe target, which has none).
- A call-site value the wrapper could not compare no longer abandons the whole application; the `overridden` list is in the settings' order in both SDKs.

## 0.2.6 — 2026-09-16 (protocol 0.3.1) — superseded by 0.2.7 on the same day

### Added
- `Rendered.inference` / `Attribution.inference`: the slot's inference settings (temperature, top-p, output cap, stop sequences, reasoning effort) as the release sealed them, in the wire's integer encoding.
- `wrap(client)` puts the release's values on OpenAI chat / Responses / Anthropic Messages calls, replaces a call site's differing value (`wrap_inference_overridden`), and reports a setting the shape cannot carry (`wrap_inference_unsupported`). `applyInference` / `apply_inference` for instrumentation that calls providers itself.

### Fixed
- The Python agent's protocol constant is core's (a second copy had drifted a bump behind).

## 0.2.5 — 2026-09-16 (protocol 0.3.0)

### Added
- The fleet pattern: `pullBundle` / `pull_bundle` in `agent-sync` (one pull, no store, sealed to the fleet's distribution key; `fetchRoot`, `minimumGeneration`, `root_refused`, `generation_rollback`) and `applyBundle` / `apply_bundle` on the facade with a top-level `distributionKey` option (`BundleOutcome`: `activated` · `staged` · `unchanged` · `held_back` · `refused`).

### Fixed
- A bundle handed to a host with nothing active was staged and its generation recorded before its signature was checked; the chain now runs before a byte is staged in both branches.
- A first release staged under `unlock_required` counted as "nothing held"; it is a held generation now.

### Changed
- `@airprompter/agent-sdk`'s publish size budget is 220 KB (was 200).

## 0.2.4 — 2026-09-16 (protocol 0.3.0)

### Fixed
- `start()` refused (`no_verified_release`) when the only release for a target was staged under `unlock_required` — the ordinary shape of a first production release. Both SDKs now start with nothing to serve (`generation` 0, `applyState` `awaiting_unlock`, `healthz` failing, `awaiting_first_unlock` logged) and serve after the unlock, the window, or the hook.

## 0.2.3 — 2026-09-15 (protocol 0.3.0)

### Fixed
- The pinned root was scoped to the app's target instead of the hosted environment, so a `dev` or `staging` target on the public service refused every manifest (`root_scope_mismatch`, then `unknown_signing_key`). `root: { pinned, hostedEnvironment }` (`hosted_environment`) names the deployment the key belongs to, default `prod`; the CLI takes `--hosted-environment`.

## 0.2.2 — 2026-09-15 (protocol 0.3.0)

### Added
- The managed-mode client picks its experiment by tag: `ManagedAgent.experimentFor(tag)` / `experiment_for(tag)`; `/slots` lists `experiments[]`.

## 0.2.1 — 2026-09-15 (protocol 0.3.0)

### Fixed
- `SDK_VERSION` had stayed at 0.1.0 through two releases; it is pinned to the package version by a test in both SDKs, and the OTel bridges default their scope version to it.

## 0.2.0 — 2026-09-15 (protocol 0.3.0)

### Changed
- Protocol 0.3.0: one experiment per prompt (`experiments[]`, each with its tag, salt, arms and ramp, beside the legacy single `experiment`; trust rule M15). Both SDKs read both shapes and assign on the experiment's own salt.

## 0.1.1 — 2026-09-15 (protocol 0.2.5)

### Fixed
- A start failure names the control plane's answer; a refused heartbeat carries its reasons; `options.sdk` is checked first.
- Trusted publishing needs npm 11.5+; the release workflow installs it.

## 0.1.0 — 2026-09-14 (protocol 0.2.5)

First public release: `@airprompter/agent-core`, `-sync`, `-runtime`, `-telemetry`, `-sdk` and `@airprompter/otel-bridge` on npm; the five Python distributions in the repository; the `airprompter` CLI and `airprompterd`; the conformance suite and its published harness.
