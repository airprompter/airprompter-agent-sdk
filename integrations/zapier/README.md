# AirPrompter Agents for Zapier

A Zapier app that serves prompts approved in AirPrompter to Zap steps. The model runs in
Zapier (AI by Zapier, or any model step). AirPrompter only serves the approved, signed
prompt version and records content-free counts. No model runs on AirPrompter.

The app is a thin client of [`@airprompter/agent-sdk`](../../sdk-typescript/). Every
step starts a fresh agent in `on_invoke` mode over a signed copy kept on the Zapier side.

## What a Zap does with it

| Step | What it does |
|---|---|
| **Get Prompt** (action) | Pick a **slot** from the release serving your agent. Fill its **variables** (fields appear for the chosen slot). Optionally set a **Subject**. Out come the rendered `prompt`, the `model` and inference settings the version pins (`temperature`, `top_p`, `max_output_tokens`, `stop_sequences`, `reasoning_effort`), plus `slot`, `version_id`, `arm`, `generation`, `run_ref`, `served_from` (`network` or `stored`) and `lease_expires_at`. |
| **Report Run** (action) | Map `run_ref` from Get Prompt. Add input and output tokens, the duration, an error if the model step failed, and optionally a thumbs up/down or a 1–5 rating. Only counts and an error *class* are sent: no text. |
| **Rollout Changed** (polling trigger) | One item per slot change: a new version approved, a dial-up step, an A/B test started or ended, a rollback, a slot disabled or enabled. The item id is `slot:digest:state`, so Zapier drops repeats. |

**One slot per step.** A multi-step workflow is several Get Prompt steps.

**Control lives in AirPrompter.** Versions, approvals, A/B arms, dial-up percentages,
rollback and the lease are all signed into the manifest, and none of them can be edited
in Zapier. A step chooses only the slot, the variables and the Subject:

- **Subject set** (a customer or ticket id): the same subject always gets the same arm.
  This uses the SDK's sticky assignment hash, so the result matches every other runtime.
- **Subject empty**: each run gets a random arm, split by the approved weights.
- **Dial-up** follows the signed ramp plan by the clock. A ramp step takes effect at its
  time, even with no new release.

The prompt output is a single text. The protocol carries one text per slot today, so
there are no separate system and user parts. If the protocol adds them, they become
extra output fields.

## Connecting

Custom auth, with these fields:

- **Agent ID**
- **Update key**: an Agent key (`apa_…`) bound to one agent and one environment. It can
  only read approved releases.
- **Environment**: default `prod`.
- **API base URL**: default `https://api.airprompter.com`. Must be an https origin. Only
  a registry on this machine may use http.
- **Root key (advanced)**: leave empty for AirPrompter Production and Dev. Only for Staging (ask AirPrompter for
  its root key; the SDK pins none) or a development registry (its `root.pub.json`).

The connection test fetches the signed manifest, verifies it against the pinned root, and
stores it.

> **Production root:** `HOSTED_ROOTS` in the SDK
> ([`sdk-typescript/packages/sdk/src/core/protocol/hostedRoots.ts`](../../sdk-typescript/packages/sdk/src/core/protocol/hostedRoots.ts),
> which the Steps core pins from) pins both the hosted `dev` root and the `prod` root (ceremony of 2026-11-27, key id `044af6e8…1793`). This app
> depends on an SDK release that carries the prod pin (`1.0.0-rc.5` was the first), so a connection to the
> production API needs no root key. Production must be serving protocol 4.0.0 manifests, which this SDK reads; until
> it does, the connection test reports `protocol_unsupported`. Staging has no pinned root: ask AirPrompter for its
> root key and paste it into the advanced field.

## Where the signed copy lives (storage decision)

Zapier runs each step in its own cloud invocation, and nothing on disk survives between
steps. Here "offline" means AirPrompter is unreachable from Zapier. These are the options
that were checked, in `zapier-platform-core` 19.3.0 and `zapier-platform-cli` 19.3.0:

| Option | Survives between steps? | Verdict |
|---|---|---|
| **`z.cache`** (`src/tools/create-cache.js`: get / set with `ttl`, `scope`, `nx` / delete over Zapier's RPC) | Yes. It is server-side and per app. `scope: ["auth"]` keeps it per connection, and with no `ttl` there is no expiry of our own. The CLI has a `cache clear` command (per major version), which confirms it is a durable store run by Zapier. | **Chosen.** |
| `z.cursor` | About one hour (Zapier's docs), and only for paginating a polling trigger | Too short, and not reachable from actions. |
| Connection fields written on auth refresh (session auth / OAuth computed fields) | Only for session or OAuth auth, which an Update key doesn't use. They are refreshed only on a 401, and the data sits in `authData` on every request. | Wrong auth type, and an abuse of the auth store. |
| Storage by Zapier | A separate app the *user* adds to their Zap, with its own secret. Not callable from a CLI app's code. | Not available to the app. |
| `/tmp` | Only while one Lambda container stays warm | Lost at any cold start. |

What is stored, per connection (scope `auth`), in the SDK's shared datastore format
(`kvReleaseDatastore`, [protocol/datastore-format.md](../../protocol/datastore-format.md)):

- the sealed `.apbundle` (signed manifest + payloads). It is encrypted to an X25519 key
  derived from the Update key, the agent and the environment (HKDF-SHA256). Zapier's
  storage holds ciphertext only.
- the content-free edge state (ETags and the last time AirPrompter answered).
- the `latest` pointer and an index key (`z.cache` has no list).
- one note: the organization id, learned from the first verified manifest.
- per Zap, the trigger's cursor (slot digests and weights, no content).

**How it behaves:**

- **Verified on every load.** The SDK hydrates from the stored row and checks the whole
  chain: root, signing key, signature, scope, every payload hash. An edited copy is
  refused, never served.
- **Served offline until the lease runs out.** The lease is the manifest's `leaseSeconds`,
  counted from the last time AirPrompter answered for this connection (never earlier
  than the manifest's `issuedAt`). After that, Get Prompt fails with a retryable error.
  The SDK itself only marks a lapsed lease as stale. Here it is a refusal, because nobody
  watches a Zap's health. The edge state (when AirPrompter last answered) is stored
  unsigned, so someone who can write this connection's `z.cache` could extend the lease.
  They could not change what is served.
- **New dial-up steps, approvals and rollbacks arrive on the next successful fetch.**
  Every step tries AirPrompter first, with an 8 s timeout per request, so the stored copy
  can still serve inside Zapier's 30 s step limit.
- **Rows kept:** the serving generation and the one before it (`prune`).

**Real limits, and what is not verified:**

- `z.cache` limits are **not published by Zapier**. I found no documented value-size limit,
  maximum TTL or eviction policy. Zapier's published limits are a 6 MB input payload
  (35 MB from v17.2.0), 20 MB HTTP responses and 30 s per step. A release stores roughly
  1.4× the bytes of its prompt texts (base64 ciphertext) plus a few KB. That is
  comfortable for typical agents, but a release with megabytes of prompts has **not been
  tried against Zapier's real cache**.
- Without a `ttl`, how long Zapier keeps an entry is up to Zapier. The app owner can wipe
  it with `zapier-platform cache clear`, and it may not carry across major versions. The
  next successful fetch rewrites it.
- `z.cache` has no compare-and-set. `ifVersion` is read-compare-write on a content hash,
  and `list` is an index key. Two steps racing can each write. The rows don't change once
  written and every read is verified, so the worst case is an extra fetch.
- The tests use the app tester's in-memory `z.cache`. The scope and TTL behaviour of
  Zapier's real cache has not been exercised.

## Usage and the run count

`Report Run` is the only place usage leaves: the Steps core calls the SDK's
`ap.reportRun(runRef, …)` (see [`client.ts`](../../sdk-typescript/packages/sdk/src/frameworks/steps/client.ts) and [`usage.ts`](../../sdk-typescript/packages/sdk/src/frameworks/steps/usage.ts)
in `@airprompter/agent-sdk/frameworks/steps`). That is the run's one count.

Get Prompt renders outside any `ap.run`, so a render writes no run row. **A Get Prompt
with no Report Run is not counted today.**

If AirPrompter cannot take a report (no upload grant, network down), the step fails with
`ThrottledError` and Zapier runs it again. The report is never dropped silently.

## Errors in Zapier

| Client error | Zapier error | Effect |
|---|---|---|
| `unauthorized` | `ExpiredAuthError` | The user is asked to reconnect. |
| retryable: AirPrompter unreachable with nothing usable stored, a report not delivered, lease expired, storage down, a tampered copy while AirPrompter is unreachable | `ThrottledError` (120 s) | Zapier retries the step. |
| anything else: unknown slot, missing variable, disabled slot, nothing promoted, root not pinned | `z.errors.Error` with the code | The step fails with a sentence saying what to fix. |

## Layout

- The platform-agnostic client (`createAutomationClient`, the trigger's rollout diff, trust,
  usage) is the SDK's Steps subpath, `@airprompter/agent-sdk/frameworks/steps`, shared with
  the n8n nodes (AIR-2405). This package imports the SDK only through that subpath; the
  SDK's `npm run lint:imports` enforces it. Its tests live in the SDK
  (`sdk-typescript/test/frameworks/steps/`).
- `src/zapier/`: connection, field schemas, the `z.cache` datastore, the trigger cursor,
  and error mapping.
- `test/zapier.test.ts`: the app tester, against `airprompter dev`'s own code
  ([`cli/src/commands/dev.ts`](../../cli/src/commands/dev.ts)) through the SDK's Steps test registry.

## Develop

```sh
cd sdk-typescript && npm ci && npm run build && cd ../cli && npm ci && cd ..   # the tests run `airprompter dev` from source
cd integrations/zapier && npm ci
npm run typecheck && TSX_DISABLE_CACHE=1 npm test
npm run validate                                         # zapier-platform validate; runs without a Zapier login
```

## Push to your Zapier account (owner)

None of these steps have been run. They need the owner's Zapier account.

1. Check that the SDK pin still carries the production root (`HOSTED_ROOTS.prod` in
   `sdk-typescript/packages/sdk/src/core/protocol/hostedRoots.ts`; every release since `1.0.0-rc.5` does), and that
   production serves protocol 4.0.0 manifests.
2. `npx zapier-platform login`, then `npx zapier-platform register "AirPrompter Agents"`
   (once). This writes `.zapierapprc`, which is gitignored.
3. `npm run build && npx zapier-platform push`. The SDK comes from npm
   (`@airprompter/agent-sdk`, pinned exactly), so the build zips the published package.
4. In Zapier, connect with an Agent ID and an Update key. Build a Zap: Get Prompt → AI by
   Zapier (prompt `{{prompt}}`, model `{{model}}`) → Report Run (`{{run_ref}}`, the
   token counts).
5. Things only a live account can show: `z.cache` persistence and size, the connection
   test against production, and `ThrottledError` retries.
