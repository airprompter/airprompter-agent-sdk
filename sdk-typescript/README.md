# @airprompter/agent-sdk (TypeScript)

Run the prompts and workflows your team approved in AirPrompter on your
own systems. The SDK pulls signed releases, keeps them in an encrypted
restart-safe store, renders with trust-aware variables, and writes
content-free telemetry to a local spool. Nothing AirPrompter runs is on
your request path; with the network gone, the last verified release keeps
serving.

Node 20+, ESM and CJS, no runtime dependencies beyond `node:crypto`.

## Packages

One install. Everything below is in the one package; you import the part you
use, and a part you do not import is not loaded.

```bash
npm install --save-exact @airprompter/agent-sdk@1.0.0-rc.0   # the 1.0 release candidate
# With a satellite, pin each one to the same candidate:
npm install --save-exact @airprompter/agent-sdk@1.0.0-rc.0 @airprompter/datastore-s3@1.0.0-rc.0 @airprompter/agent-otel@1.0.0-rc.0
```

Pin every package exactly. An unpinned datastore installs 0.6.0, which brings
the old split packages in beside this one. npm's default range,
`^1.0.0-rc.0`, also matches later candidates, and a later candidate removes
`ap.wrap`.

| Import | Use it when |
| --- | --- |
| `@airprompter/agent-sdk` | `AirPrompterAgent` and its option and result types. Everything else is reached through a subpath. |
| `@airprompter/agent-sdk/core` | You need the protocol without any I/O: verify a manifest or a key set, canonical JSON, arm assignment and the ramp walk, render a template, run output checks or a golden set, open a bundle, the telemetry row schemas, the control-plane HTTP client, the port interfaces. Nothing here opens a file, a socket or a timer at import. |
| `@airprompter/agent-sdk/sync` | Your CI pulls and verifies releases (`syncOnce`), or a host holds them in the encrypted slot store and decides when they apply (`SlotStore`, the apply policy and its windows, the customer's datastore). |
| `@airprompter/agent-sdk/runtime` | Your application renders and assigns over a release **it already holds**: a bundle you loaded, a release from the store or a datastore row, with no store or network of its own (`BundleRelease` from `/core` + `ReleaseResolver`); the provider wrappers (`wrapClient`, `aiSdkMiddleware`, `observeCall`). |
| `@airprompter/agent-sdk/telemetry` | Your own instrumentation writes the content-free spool (`SpoolWriter`, `DirectorySink` / `MemorySink`) and ships it under a grant (`SpoolUploader`, or to any `UploadSink`). |
| `@airprompter/agent-sdk/testing` | The kit a customer's CI imports: `FakeControlPlane`, `MemoryFs`, `FakeClock`. Never loaded by the runtime. |
| `@airprompter/agent-sdk/frameworks/langchain` | Middleware for LangChain's `createAgent`. `langchain`, `@langchain/core` and `zod` are optional peers: install them to use this subpath, and no other subpath loads them. |

Everything runs on your systems: there is no hosted mode. `ManagedAgent` and
its `runtime/managed/` module are retired. They stay in the source only until a
later release removes them, so do not build on them.

Beside it, separate packages only where a dependency footprint earns one. Each
takes `@airprompter/agent-sdk` as a peer at the same version, so an application
never holds a second copy:

| Package | Use it when |
| --- | --- |
| `@airprompter/agent-otel/exporter` | Your OpenTelemetry collector takes the windows instead of AirPrompter (`otlpUploadSink`, `spoolRowsToOtlp`): OTLP/HTTP metrics, no grant, no Agent key. Renamed from the earlier OpenTelemetry package. |
| `@airprompter/datastore-s3`, `-postgres`, `-redis` | Your own datastore carries releases to your runtimes ([docs/datastore.md](../docs/datastore.md)). |

The direction is fixed and linted: `core` imports nothing of ours; `sync`,
`runtime` and `telemetry` import `core` and never each other; `agent.ts` and
`frameworks/` import those; the `airprompter` binary is built from the sources.
`scripts/lint-imports.mjs` refuses an upward import or a path past a layer's
barrel (`../core/index.js`), and `test/packageShape.test.ts` pins the edge set
and the exports map, proves two copies in one lockfile agree (an error, a
release and a sink from one copy are recognised by the other, never
`instanceof`), and holds each subpath under its size budget
(`airprompter.sizeBudgetBytes` in `package.json`).

```ts
// The runtime alone, over a bundle committed beside the code: no store, no daemon, no network.
import { BundleRelease, trustedRootFromPinnedKey } from "@airprompter/agent-sdk/core";
import { ReleaseResolver } from "@airprompter/agent-sdk/runtime";

const root = trustedRootFromPinnedKey({ purpose: "platform", environment: "prod", pinnedRoot: PINNED_ROOT_JWK });
const loaded = BundleRelease.load({ bundle: JSON.parse(readFileSync("release.apbundle", "utf8")), root, scope, now: new Date().toISOString() });
if (!loaded.ok) throw new Error(`bundle refused: ${loaded.reason}`); // the same chain as OTA: signatures, scope, expiry, every payload hash
const runtime = new ReleaseResolver({ release: loaded.release.current(), runRefKey, agentId: scope.agentId, target: scope.target, instanceId, nowMs: Date.now });
const slot = runtime.resolve("support.triage", userId);
if (slot.ok) {
  const r = runtime.render(slot, { team: "Billing", ticket: userMessage }); // { text, model, versionId, arm, generation, runRef, tag }
}
```

## Quick start

```ts
import { AirPrompterAgent } from "@airprompter/agent-sdk";

const ap = await AirPrompterAgent.start({
  organizationId: "org_…",
  agentId: "agt_…",
  target: "prod",
  apiKey: process.env.AIRPROMPTER_AGENT_KEY, // an Agent key (distribution kind); omit to run fully offline
  root: { pinned: { kty: "EC", crv: "P-256", x: "…", y: "…" } }, // AirPrompter's root key for the public service (prod); pass hostedEnvironment: "dev" only against AirPrompter's dev deployment — it is never your app's target
  sync: { mode: "resident", pollSeconds: 30, edgePointerUrl: "https://…/g/<token>/generation.json" },
});

const r = ap.prompt("support.triage").render({ team: "Billing", ticket: userMessage });
// observe() times the call, reads `usage` off the provider's response (OpenAI, Anthropic, Bedrock),
// classifies a failure into the closed error set, and returns the result unchanged.
const reply = await ap.observe(r, () => openai.chat.completions.create({ model: r.model, messages: [{ role: "user", content: r.text }] }));
// …or wrap the client once and change nothing at the call site: the call is attributed to the render whose text it carries.
const openai = ap.wrap(new OpenAI());
const reply2 = await openai.chat.completions.create({ model: r.model, messages: [{ role: "system", content: r.text }, { role: "user", content: userMessage }] });
// …or report by hand: ap.report({ tag: r.tag, artifactId: r.artifactId, versionId: r.versionId, arm: r.arm, model: r.model, status: "ok", latencyMs, tokens: { input, output } });
ap.feedback(r.runRef, { thumbs: "up" });
```

`render()` never touches the network. A variable declared `end_user` is
fenced (`<ticket>…</ticket>`) so the model sees where untrusted input
starts and stops; a missing required variable throws; a value for a
variable the slot did not declare throws.

## What happens at start

1. The store is read before any network call. The active slot is
   verified (signatures, hashes, generation counter, expiry); if it does
   not verify, the other slot is tried.
2. A vendored `.apbundle` (`vendoredBundle`) — committed beside the code
   or read from a column — is opened and verified the same way. With
   nothing verified in the store it is staged and activated, whatever its
   generation (the fallback). With a store already serving it is an
   **update** (S7): a newer generation goes through the same chain as OTA
   and is staged, and the host's apply policy decides — `auto` activates
   it, `unlock_required` stages it for the unlock, the window or the hook;
   the held generation changes nothing; an OLDER one (a `git revert`) is
   refused, logged `vendored_bundle_refused` with the sentence, and the
   host keeps serving what it holds — a rollback is `airprompter
   rollback`, never an older bundle. Every process that reads a bundle
   from a database column holds the distribution key, so keep that column
   as private as the key.
3. With still nothing, one synchronous sync runs — the only time the SDK
   waits on the network. If that fails too, the agent still starts, at
   generation 0. It logs `started_without_release`, keeps syncing, and takes
   the first promotion with no restart. Until then a run answers
   `passthrough`, so your framework's own prompt and model run. Plain
   `ap.prompt(...).render()` has no prompt to fall back on, so it throws
   `AgentStartError("no_verified_release")` at the first render. The log line
   names the control plane's answer: a 404 is "no release promoted to `<target>`" (promote one
   from the app's board, or the key is bound to another app/environment), a
   401 is the key, a 403 carries the server's code, a transport failure
   carries its message and the base URL. Serving an unverified release is
   never an option.
4. **The fleet pattern** — your store carries the release, your runtimes
   apply it. One puller job holds the Agent key: `pullBundle({ client,
   scope, trustedRoot, fetchRoot, minimumGeneration, distributionPublicKey })`
   fetches, verifies and seals an `.apbundle` to the fleet's X25519
   distribution key; write it to a row per generation. Every runtime holds
   only the distribution private key (`distributionKey` at start): it boots
   from the newest row (`vendoredBundle`), serves from memory, and hands a
   newer row to `await agent.applyBundle(row)` → `{ outcome: "activated" |
   "staged" | "unchanged" | "held_back" | "refused", generation, reason? }`
   — the same chain as OTA before a byte is staged, never below the held
   generation, the apply policy deciding. How a runtime learns the row
   changed is yours (poll, `LISTEN`, your bus). `fetchRoot` is not optional
   in practice: a pinned key names the root, not the signing keys. Hand the
   last result's `edge` back on the next pull and the puller polls the
   CDN pointer, not the API: `{ status: "unchanged", via: "pointer" }` is
   one 304 and no origin call; only a promotion reaches the API.
   `nextPullDelayMs` stretches the interval while nothing changes;
   `skipPointer: true` is the "check now" a nudge or an operator uses
   ([docs/change-notification.md](../docs/change-notification.md)).
   Or hand the SDK your datastore and skip the glue:
   `kvReleaseDatastore(kv)` over an S3 bucket, a Postgres table or a Redis
   (`@airprompter/datastore-s3`, `-postgres`, `-redis`; any other backend is
   a four-method `KvStore` that `checkKvStore` proves), run
   `pullToDatastore({ datastore, region, … })` in the puller, and start
   each runtime with `datastore: { store, region, pollSeconds? }` — it
   hydrates from the datastore at start and on `ap.hydrate()`, the ramp
   walking as signed, a rollback set with `rollbackDatastore()` moving the
   whole fleet (or one region) down and held until the fleet moves past it
   ([docs/datastore.md](../docs/datastore.md)).
5. One shape is not a failure: the sync found a release **staged under
   `unlock_required`** and nothing active — a first production release,
   or a restart whose active slot is unusable beside a staged one. The
   host starts with nothing to serve (`generation` 0, `applyState`
   `awaiting_unlock`, `healthz` degraded, logged `awaiting_first_unlock`),
   heartbeats `{ active: 0, staged: N }`, keeps syncing, and answers
   `unlock()`, the window, or the `onStaged` hook; `prompt()` refuses with
   the staged generation named until then. The unlock is yours to give,
   and a process that refuses to start could never give it.

Two more things the SDK says in its own words rather than as a bare status:
a refused heartbeat is logged `heartbeat_refused` with the control plane's
message and, for a 400, its validation issues (bounded to eight); and
`options.sdk` — which names the *reporting software* (`agent-sdk-typescript`,
`agent-sdk-python`, `airprompter-cli`, `airprompterd`), never your app — is
checked at `start()` and refused with `AgentStartError("invalid_options")`
before any network call. Leave it unset to report as this SDK.

`store.json` is a versioned contract between the CLI that writes it
and the SDK that reads it (S8, `protocol/store-format.md`): a reader
accepts its own format and the one before, migrates an older file
forward on its first write (never on open, so a rolled-back writer still
finds the file it can read), and refuses a newer one with
`AgentStartError("store_newer")` naming the package that wrote it.

Sync modes: `resident` (timer + jitter, edge pointer first so idle
instances never wake a Lambda), `on_invoke` (serverless: `ap.invoke(fn)`
syncs before and after the handler; telemetry goes to a memory sink that
`invoke` POSTs at invocation end as one segment under the runtime's own
upload grant, **before it returns** (S5: a frozen Lambda loses nothing;
`telemetry.flush: "background"` is the opt-out) — `ap.flushTelemetry()`
does the same by hand, and rows a hold or a refused POST leaves behind
wait for the next invocation), `offline` (no `apiKey`: serve the store,
the datastore or the bundle, never call home). `daemon` was removed in
0.3.0 and is refused with `AgentStartError("invalid_options")`: the host's
`airprompterd` ships telemetry only and never serves a release (below).

Every process is its own instance (S6): `ap.instanceId` is minted at
start, never the store's; N workers are N instances in the fleet view and
N writers into one spool. `runRef`s parse across workers because their key
is the store's. The spool's disk use is bounded by a published invariant
(`docs/telemetry.md` › The disk budget is an invariant).

Telemetry and the host's daemon (`protocol/daemon.md`): the spool goes to
`telemetry.spoolDir`, else `AIRPROMPTER_SPOOL_DIR`, else the folder a live
`airprompterd` for this agent and target publishes in
`<store dir>/daemon.json`, else `<store dir>/spool/telemetry`; every closed
segment gets a manifest beside it (its digest and this process's
heartbeat report). While a live daemon ships that folder, this process
runs no uploader — the daemon uploads under this writer's own grant, with
this writer's own report. Otherwise a resident host uploads its own spool
(S5): the same uploader, in-process, on a timer off the request path,
under the runtime's own grant; past the budget the oldest segments are
dropped and counted, never silently. The hand-over is re-checked every
minute in both directions. `ap.status().telemetry` says which folder and
who uploads, `ap.status().upload` what this process's uploader is doing,
`ap.uploadNow()` runs one pass, `telemetry.upload: false` leaves the spool
for the daemon or an operator's export. See `docs/telemetry.md`.

## Apply policy

The manifest carries `applyPolicy`. Under `unlock_required` a new
generation is staged, not activated; `apply.onStaged` is called, and
`await ap.unlock()` makes it live. `await ap.rollback()` flips to the
other slot instantly; going below the stored generation is a forced
downgrade, stamped in the store and in the spool, and the control plane's
current generation is held back until it moves past the one you left.
The local side can be stricter than the manifest
(`apply.policy: "unlock_required"`), never looser. Both calls act on this
process and the store it shares; another process already running on the
same store keeps what it loaded until it calls them too (or, across a
fleet, until a datastore rollback reaches its next `hydrate()`).

The policy is the host's, not the manifest's (S4). The first manifest a
host verifies pins `applyPolicy` in `store.json`; a later manifest may
tighten the pin (`auto` → `unlock_required`) and never loosen it — a
console flipped back to `auto` is advisory on that host (logged once per
generation, reported on the heartbeat so the fleet view says "pinned on
the host"). Loosening is an operator's act: `airprompter policy set …
auto` on the host, or `await ap.setApplyPolicy("auto", { by: "…" })`,
logged with who asked. `ap.status().applyPolicy` says what is in force and
where it came from (`local` / `pinned` / `operator`).

Three things unlock a staged release, and only your side holds them:

```ts
const ap = await AirPrompterAgent.start({
  …,
  apply: {
    // (b) an update window: staged releases go live on their own inside it.
    //     "HH:MM-HH:MM <IANA zone> [days]"; a window that ends before it
    //     starts runs past midnight. A local window wins over the console's.
    window: "02:00-04:00 Europe/Berlin sat,sun",
    // (c) your change-control hook: resolve after activate() to go live;
    //     resolve or reject without it to leave the release staged.
    onStaged: async (staged) => {
      const ticket = await changeControl.open({ generation: staged.generation, request: staged.unlockRequest?.note });
      if (ticket.approved) staged.activate();
    },
  },
  heartbeatSeconds: 300,          // how often this instance reports to the fleet view (30–3600)
  models: { "gpt-5": { provider: "openai" } },   // what this process can call: reported on every heartbeat, never verified
});
// (a) an operator: `airprompter unlock --agent … --environment prod --generation 42`
```

**Output checks.** A prompt's owner can declare checks on the slot
(Settings › Prompt settings): the answer parses as a JSON schema, a field is
one of an enum, the length sits in a token band, a pattern must or must not
occur. `observe()` runs them on the provider's answer right here — the text
never leaves — and counts `passed` / `failed` on the run's window; the
console shows the failed rate per arm as a guardrail. Checks are form, not
quality. An app that calls the model itself can run
`ap.checks(rendered, output)` and get the per-check results; a failing
check never throws. Patterns are RE2-class only (no backreferences,
lookaround or nested quantifiers) and an output over 64 KiB fails a pattern
check closed — `protocol/checks.md`.

**Golden sets (T34).** A prompt's owner can attach 1–50 known inputs with
the properties a right answer has (Settings › Prompt settings); they ride
the release as a payload, encrypted like the prompt. Start with
`golden: { invoke }` and every staged release runs them first: each case is
rendered with the release's own text, `invoke({ text, model, caseId, … })`
asks your model, the expectations (the output-check grammar) run on the
answer, `goldenPass` lands per case on the arm's window, and a release
below its floor stays staged — under `auto` too — until you `unlock()` it
deliberately (`status().golden` has the counts; `golden_set_failed` in the
log). `ap.golden()` runs the active release's sets on demand and returns the
reports; no output ever leaves. `ap.judge(runRef, output, "prompt", invoke)`
runs the prompt's own `## Success criteria` (or `"protection"`,
`"helpfulness"`, or your criteria) on your model and files only
`judgeScore` / `flagged` — `protocol/golden-sets.md`.

Judging comes from your side. Keep `runRef` beside your own record and later
call `ap.feedback(runRef, { thumbs: "up" })` or `{ rating: 4 }` (1 to 5) from
any process holding the same `runRefSecret` or Agent key: the signals join the
run's window. The console's Settings › Prompt settings says which signal
decides "quality" for a prompt and which ones are guardrails that may never
rise. A middleware option that gives a client the thumbs or the 5-star rating to
send is planned, and has no API yet.

`models` is the catalogue the console shows under Settings › Models
("available on 3 of 5 instances") and the gate a release must pass: a
version naming a model no instance declared is refused at seal. A release
may mark a slot's model **required**; a process whose `models` lacks it
refuses that release (`status().lastRefusal === "model_unavailable"`, the
heartbeat names the model) and keeps serving what it has — a partially
upgraded fleet degrades honestly instead of running the prompt on another
model. Declare nothing and no release is refused over a model; `render()`
still returns the pinned `model` for you to map.

The console can **request** an unlock (a signed, expiring
`request_unlock` directive rides the next manifest); `status().unlockRequests`
lists the open ones and your hook receives it as `staged.unlockRequest`.
A **Freeze** (`disable` directive) is honoured from any manifest whose
signature verifies — before staging or anti-rollback decide anything — so a
frozen fleet stops rendering even when nobody ever unlocks. A lapsed lease
reports stale and keeps serving: an agent never stops because of AirPrompter.

Every `heartbeatSeconds` the runtime reports the protocol's heartbeat
(content-free: generations, apply state, catalogue, lease, spool depth,
the requests it has surfaced) and adopts the cadence the server answers
with; a key past its 500-live-instance cap is refused and reported in
`status().heartbeat.lastRefusal`.

## Wrapped clients (`ap.wrap`, D65)

`ap.wrap(client)` returns the same client with its public model-call
methods observed — a proxy, never a patched internal, never a vendored
copy of a provider SDK, and no import of one (the packages are optional
peers). Each call is timed, its `usage` and finish reason read off the
response or the stream as it goes by, the slot's declared checks run on
the text here, and one content-free observation filed. Nothing the wrapper
does can fail the call: attribution and tapping are guarded, an
unattributed call passes straight through (logged `wrap_unattributed`),
and a stream a consumer abandons reports what was seen.

| Client | Observed methods | Streams |
| --- | --- | --- |
| `openai` (`OpenAI`) | `chat.completions.create` / `.parse` / `.stream()`, `responses.create` / `.parse` / `.stream()`, `beta.chat.completions.parse` | `stream: true` (usage from the last chunk — send `stream_options: { include_usage: true }`), the `.stream()` helpers through `finalChatCompletion()` / `finalResponse()` |
| `@anthropic-ai/sdk` (`Anthropic`) | `messages.create`, `messages.stream()`, `beta.messages.*` | `stream: true` (usage from `message_start` + `message_delta`), `messages.stream()` through `finalMessage()` |
| Vercel AI SDK (`ai`) | `wrapLanguageModel({ model, middleware: ap.aiSdkMiddleware() })` — every provider the AI SDK drives | `wrapStream` taps the parts; the `finish` part's usage and reason count |

Not observed (the client's own): `withResponse()` is (its `data` is
observed); `.tee()`'d streams, `with_raw_response`-style surfaces, and any
method not in the table are forwarded untouched.

**The release's inference settings (protocol 0.3.1 / 0.3.2).** A prompt
version declares how its model is called — temperature, top-p, the output
cap, stop sequences, reasoning effort — and the release seals those with
the text (`rendered.inference`, integers on the wire: `temperatureMilli`
200 is 0.2, `topPBps` 9000 is 0.9; a workflow step carries its own). A
wrapped call attributed to that render goes out with the release's values:
`temperature`, `top_p`, `max_completion_tokens` / `max_output_tokens` /
`max_tokens`, `stop` / `stop_sequences`, `reasoning_effort` /
`reasoning.effort` (the Responses `reasoning` object is merged, its other
members kept). A call site that wrote a different value is told once —
`wrap_inference_overridden` names the parameters — never failed. The
settings go only on a call to the release's model: a call that names
another model keeps its own parameters (`wrap_inference_model_mismatch`),
since settings sealed for one model are refused by another. A setting the
call cannot carry is reported, not sent (`wrap_inference_unsupported`, with
a reason): a stop sequence on Responses or a reasoning effort on Messages
(`shape`); on Anthropic Messages, which takes one sampling parameter,
temperature goes and top-p does not (`one_sampling_parameter`), and neither
goes beside a `thinking` block the call site set (`thinking`). The AI SDK
middleware applies the same rules through `transformParams`. Instrumentation
that calls a provider itself uses `applyInference(kind, params, inference,
{ model })` (exported from `@airprompter/agent-sdk/runtime`); a
golden-set `invoke` receives `inference` so the activation gate samples as
production does.

**Which render a call belongs to.** In order: an enclosing
`ap.attribute(rendered, () => …)` scope (`AsyncLocalStorage`, so it
follows `await`s); else a request text — `system`, `instructions`, then
each message's string or `text` parts — that is exactly one of the last
256 renders (matched by SHA-256; the registry keeps hashes and dimension
names, never a prompt); else the call is unattributed and passed through.
The request's `model` names the window (a router that chose another model
than the slot's is reported as such). Tested against clients shaped like
the real ones in CI, and against the latest `openai`, `@anthropic-ai/sdk`
and `ai` releases weekly (`.github/workflows/wrap-latest.yml`,
`npm run test:wrap-live`); the supported ranges are the package's
`peerDependencies`.

## LangChain

Add one line to the agent you already have. Your framework, tools and data stay where they are.

```ts
import { createAgent } from "langchain";
import { airprompter } from "@airprompter/agent-sdk/frameworks/langchain";

const agent = createAgent({
  model: "openai:gpt-5",
  tools,
  middleware: [airprompter(ap, { slots: "support-reply" })], // last in the list
});

await agent.invoke({ messages }, { context: { airprompter: { subject: userId, tags: { plan }, variables: { team } } } });
```

- **What it does.** The system text and model on every provider request are the release's, and the sealed temperature, top-p, output cap and stop sequences go with them. One request is one run, one version, one `count`, with its tokens summed, however many model calls and tools it used.
- **Keep it last in `middleware`.** The list runs outermost first. Listed before `modelFallbackMiddleware`, the fallback model would receive the approved text. Middleware cannot see its neighbours, so nothing enforces this for you.
- **Pass a subject.** `context.airprompter.subject` decides the arm. Without one it uses the `thread_id`, then the run's own id, so each request lands on its own. To build the input from your own context, use `input: (context) => ({ subject: context.userId })` and list those keys in `contextSchema: z.object({ userId: z.string() })`, because LangChain hands a middleware only the keys it declares. A `subject` that is not a string is dropped, not refused.
- **When nothing can be served,** your own prompt and model run, untouched, and nothing is written: nothing promoted, a staged release waiting for an unlock, a disable, or a slot that is not in the release. A release on a model LangChain cannot load does the same and logs `run_passthrough` with `model_unresolved` once.
- **The release's model wins.** On your provider your key and base URL stay, so a gateway keeps working. An id no provider claims runs only where you set your own base URL, and otherwise gives `model_unresolved`. On another provider, the model is built with `initChatModel` and nothing of yours: it uses that provider's environment key and default endpoint. With no key there, OpenAI fails as a model error at the call, and a provider that checks its key at build gives `model_unresolved`. An Azure deployment never moves to another model id: that is `model_unresolved`, because it would run on the wrong deployment or send your messages to the public endpoint.
- **A thrown model error** reaches the console after the idle sweep (`runIdleTimeoutMs`, default 15 minutes), because LangChain has no hook after one. A recovered failure, such as one a retry middleware retried, counts as `ok`.
- **Interrupts.** A resume in the same process is the same run. After a sweep or on another host it is a new run, and it counts again. It keeps its arm only if you pass the same `context` on the resume.
- **Checkpoints.** AirPrompter writes only a run id and run reference into graph state. What LangChain itself stores in your own checkpoint stays yours. Nothing crosses to AirPrompter.

Inside `ap.run(...)`, the middleware joins that run and `ap.run` ends it. Finish the work inside it, draining a stream there too: anything still going after `ap.run` returns is not part of that run. Waiting for 1.0: several slots in a run, tool counts in the console, output checks on this path, `modelFor`, and Python.

## Module map

| Module | What it holds |
| --- | --- |
| `packages/sdk/src/agent.ts` | `AirPrompterAgent`: start/boot fallback chain, `prompt().render()`, `workflow()`, `report()`, `feedback()`, `unlock()`, `rollback()`, `status()`, `invoke()` — the facade that wires the four packages below |
| `packages/sdk/src/core/protocol/` | Wire types, canonical JSON + SHA-256, the trust chain (RFC 7638 thumbprints, ES256/P1363, root metadata R1–R5, manifest M1–M14), sticky assignment and the ramp walk, workflow step order |
| `packages/sdk/src/core/release/` | `LoadedRelease` / `ReleaseReader` — the seam between the layers — and `BundleRelease`, a bundle the customer loads verified into one |
| `packages/sdk/src/core/bundle/` | `.apbundle` v1: HPKE X25519 / HKDF-SHA256 / AES-256-GCM (RFC 9180 vectors), AAD `agentId|target` so a bundle cannot be relabelled |
| `packages/sdk/src/core/render/` | `{{name}}` substitution with trust-aware fencing; `runRef` (HMAC, content-free) |
| `packages/sdk/src/core/checks/`, `golden/`, `judge/` | Declared output checks; golden sets (`runGoldenSet`: render → invoke → evaluate → count, the threshold); `ap.judge()`'s rubrics and prompt |
| `packages/sdk/src/core/telemetry/` | The row schemas (`window`, `refusal`, `dropped`), latency buckets, the feedback catalogue normaliser — pure, so the spool writer and the wrappers build on them without importing each other |
| `packages/sdk/src/core/control/` | `SyncClient`: edge pointer, manifest with ETag, payloads by hash, heartbeat, upload grants — the one HTTP client, shared by sync and telemetry |
| `packages/sdk/src/core/protocol/ports.ts`, `ports/` | The seams to the world: `FsPort`, `ClockPort`, `FetchPort` (pure types) and the Node implementations. The spool, the store and the uploader reach the filesystem only through `FsPort`; the spool never throws on the request path (`faults` counts what it could not keep, a `dropped` row says it) |
| `packages/sdk/src/core/testing/` (`@airprompter/agent-sdk/testing`) | The kit a customer's CI imports: `MemoryFs` (a filesystem that fills, fails and loses files), `FakeClock` (advances, skews), `FakeControlPlane` (signed manifests, refusals, lease, an expiring upload grant). Never loaded by the runtime |
| `packages/sdk/src/sync/store/` | `SlotStore`: two slots, stage → fsync → activate, AAD `agentId target generation contentHash` per payload, anti-rollback counter outside the slots, DEK wrapped by a `KeyProvider` (file key default; custom / KMS via `customKeyProvider`) |
| `packages/sdk/src/sync/sync/`, `apply/` | `syncOnce` (root → pointer → manifest → only the changed payloads → verify → stage → policy), `pullToDatastore`, the apply policy's update windows |
| `packages/sdk/src/runtime/release/` | `ReleaseResolver`: which slot a subject gets under which arm (the plan walked on this host's clock, a retreat honoured), the rendered text with its run reference — over any `LoadedRelease` |
| `packages/sdk/src/runtime/wrap/`, `observe.ts` | `ap.wrap()`: the client proxy and stream taps (`client.ts`), attribution by scope or rendered text (`attribution.ts`), the AI SDK middleware (`aiSdk.ts`); `observeCall` (usage off the provider's answer, the closed error set) |
| `packages/sdk/src/telemetry/spool/`, `uploader.ts` | Minute windows per dimension set, segment naming and rotation (`SegmentPlanner`), `DirectorySink` (0600, `.open` until fsync + rename, crash recovery, a manifest per closed segment) and `MemorySink`; `SpoolUploader` (grant, budget, quarantine, manifests, the marker); `spool/manifest.ts` (the daemon's `daemon.json` and the segment manifest) |

Every file in `protocol/vectors/` runs through these modules in `test/`;
the table under **Packages** says which suite exercises which vector.

### The pointer never extends trust

The edge pointer is unsigned and cacheable, so a party between your fleet
and the edge can pin it. It cannot keep you on the last release: the lease
renews only when a signed manifest is fetched or the origin answers an
authenticated request (the manifest route's `304`, the heartbeat), the
heartbeat's `latestGeneration` sends a runtime whose pointer lags straight
to the signed manifest (`pointer_behind` in the log), and nothing read
locally — the store, a datastore row, a bundle — ever counts as contact. `status().lastSyncOutcome` says `pointer_unchanged` for
the pointer's silence and `unchanged` for the origin's.

### Error identity is data, never the class

A lockfile can hold two copies of this package (a satellite resolved to a
different patch; a bundler duplicating a chunk), and an error thrown by one
copy is not `instanceof` the class from the other. Every SDK error therefore
sets `name` and carries a `code`, and the guards read those: `isStoreError`,
`isAgentStartError`, `isPayloadDecryptError`, and `errorNamed(error, name)` for your own checks.
Sinks say what they are with `kind` (`"directory"` | `"memory"`) and what
they can do with optional `drain()` / `depth()`; the runtime branches on
those, never on `instanceof MemorySink`. `test/discriminants.test.ts` pins
the rule on every source file, the CLI's included.

## What the SDK refuses to do

- Serve a release it has not verified against the pinned root, or one
  whose generation is below the stored counter (unless `rollback()` says
  so, and then it is stamped).
- Fetch anything on the render path.
- Write prompt text, model output, end-user identifiers or free-text
  feedback to the spool. The row shape has no field for them; unknown
  feedback signal names are rejected and logged as such.

## Building

```
npm ci                 # the workspace: the SDK, agent-otel and the three datastores, linked
npm run build          # the SDK, then the satellites: dist/esm + dist/cjs
npm run typecheck      # the whole tree as one program (subpaths resolve to source)
npm test               # lint-imports, then node:test over test/**
npm run size           # each subpath and satellite against its size budget
```

Optional key providers ship as separate packages:
`@airprompter/keyprovider-aws-kms`, `-vault`, `-os-keystore`. The provider
packages `ap.wrap()` observes are optional peers: nothing here imports
them; `npm run test:wrap-live` runs the wrapper suites against whichever
are installed.
