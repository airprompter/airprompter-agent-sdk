# Changelog

The SDKs and the CLI, by version. The six npm packages and the five Python
distributions move in lockstep: one version number, released together by
tag (`sdk-typescript/vX.Y.Z`, `sdk-python/vX.Y.Z`). The wire protocol has
its own version and its own [changelog](protocol/CHANGELOG.md); each SDK
entry names the protocol it speaks. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/) — before 1.0, a minor bump
may change a public shape and says so here.

## Unreleased

## 0.2.12 — 2026-09-17 (protocol 0.3.4)

### Added
- Protocol 0.3.4: a slot variable's `default` (an optional `operator` variable's last resort, rendered by `renderTemplate` / `render_template` when neither the call site nor a source supplies a value — `defaultOf` / `default_of` say where one counts) and `source` (`caller` | `runtime`, a hint); both digest-bound when present. `SlotVariable` carries them in TypeScript; the Python projection agrees; the trust vectors seal both.
- The heartbeat reports `catalog.variables`: the names this application can fill from its registered sources (`ap.variables.names()`), never a value — so a seal can warn about a `source: runtime` variable no live instance fills.
- `airprompter dev`: `variables:` front matter takes `name=default` (an optional operator variable's default; no comma in it), `name~` (filled by the application's source) and `name~=default`; a default on a required or end-user variable is refused as the control plane refuses it.

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
