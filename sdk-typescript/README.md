# @airprompter/agent-sdk (TypeScript)

Run the prompts and workflows your team approved in AirPrompter on your
own systems. The SDK pulls signed releases, keeps them in an encrypted
restart-safe store, renders with trust-aware variables, and writes
content-free telemetry to a local spool. Nothing AirPrompter runs is on
your request path; with the network gone, the last verified release keeps
serving.

Node 20+, ESM and CJS, no runtime dependencies beyond `node:crypto`.

## Quick start

```ts
import { AirPrompterAgent } from "@airprompter/agent-sdk";

const ap = await AirPrompterAgent.start({
  organizationId: "org_…",
  agentId: "agt_…",
  target: "prod",
  apiKey: process.env.AIRPROMPTER_AGENT_KEY, // an Agent key (distribution kind); omit to run fully offline
  root: { pinned: { kty: "EC", crv: "P-256", x: "…", y: "…" } }, // the environment's root key, from your Agent's Settings tab
  sync: { mode: "resident", pollSeconds: 30, edgePointerUrl: "https://…/g/<token>/generation.json" },
});

const r = ap.prompt("support.triage").render({ team: "Billing", ticket: userMessage });
// observe() times the call, reads `usage` off the provider's response (OpenAI, Anthropic, Bedrock),
// classifies a failure into the closed error set, and returns the result unchanged.
const reply = await ap.observe(r, () => openai.chat.completions.create({ model: r.model, messages: [{ role: "user", content: r.text }] }));
// …or report by hand: ap.report({ tag: r.tag, versionId: r.versionId, arm: r.arm, model: r.model, status: "ok", latencyMs, tokens: { input, output } });
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
2. With nothing verified in the store, a vendored `.apbundle`
   (`vendoredBundle`) is opened, verified the same way, and staged
   through the store.
3. With still nothing, one synchronous sync runs — the only time the SDK
   waits on the network. If that fails too, `start()` throws
   `AgentStartError("no_verified_release")`. Serving an unverified release
   is never an option.

Sync modes: `resident` (timer + jitter, edge pointer first so idle
instances never wake a Lambda), `on_invoke` (serverless: `ap.invoke(fn)`
syncs before and after the handler; telemetry goes to a memory sink
flushed at invocation end), `daemon` (attach to the host's `airprompterd`
over its socket: no key, no store of its own, `generation` events push
new releases; with no daemon on the host the runtime syncs in-process
exactly as `resident`), `offline` (no `apiKey`: serve the store or the
bundle, never call home).

## Apply policy

The manifest carries `applyPolicy`. Under `unlock_required` a new
generation is staged, not activated; `apply.onStaged` is called, and
`await ap.unlock()` makes it live. `await ap.rollback()` flips to the
other slot instantly; going below the stored generation is a forced
downgrade, stamped in the store and in the spool, and the control plane's
current generation is held back until it moves past the one you left.
The local side can be stricter than the manifest
(`apply.policy: "unlock_required"`), never looser. In `daemon` mode both
calls act for the whole host.

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
  models: { "gpt-5": { provider: "openai" } },   // the catalogue the fleet view shows
});
// (a) an operator: `airprompter unlock --agent … --environment prod --generation 42`
```

The console can **request** an unlock (a signed, expiring
`request_unlock` directive rides the next manifest); `status().unlockRequests`
lists the open ones and your hook receives it as `staged.unlockRequest`.
A **Freeze** (`disable` directive) is honoured from any manifest whose
signature verifies — before staging or anti-rollback decide anything — so a
frozen fleet stops rendering even when nobody ever unlocks. `halt` on lease
expiry degrades (with one log line) on a runtime that has no way to check
in; the console refuses to save it on an offline environment.

Every `heartbeatSeconds` the runtime reports the protocol's heartbeat
(content-free: generations, apply state, catalogue, lease, spool depth,
the requests it has surfaced) and adopts the cadence the server answers
with; a key past its 500-live-instance cap is refused and reported in
`status().heartbeat.lastRefusal`.

## Hosted mode (`ManagedAgent`)

When an environment runs hosted, there is no store, no models and no keys of
your own: AirPrompter runs the promoted version and meters it. The SDK's
hosted client is deliberately thin.

```ts
import { ManagedAgent, ManagedRunError } from "@airprompter/agent-sdk";

const ap = await ManagedAgent.start({
  agentId: "agt_…",
  target: "prod",
  apiKey: process.env.AIRPROMPTER_RUN_KEY!, // a run key (Settings › Keys, "Run key")
  baseUrl: "https://d123.cloudfront.net",  // the environment's hosted run URL
});

// The catalogue: tags, declared variables, workflow step ids, experiment arms.
ap.slots.slots.map((s) => s.tag);

// One run. The subject is hashed with the experiment's salt and never sent.
const result = await ap.run("support.triage", { team: "Billing", ticket }, { subject: userId });
result.output; result.arm; result.usage; result.priceMicros; result.runRef;

// Streaming: deltas as they arrive, then the assembled result.
const stream = await ap.stream("support.reply", { name }, { subject: userId });
for await (const delta of stream) process.stdout.write(delta);
const done = await stream.result;

// Workflow slots: the customer executes tools between steps.
const flow = ap.workflow("onboarding.flow", { subject: userId });
for (const { stepId } of flow.steps) await flow.step(stepId, vars);

try { await ap.run(…); } catch (e) { if (e instanceof ManagedRunError) e.code; /* typed refusal, e.status, e.retryAfterSeconds */ }
```

Every run streams under the hood (the edge closes a silent connection at
60 s; a JSON run is silent until the model finishes) and `run()` assembles
the final frame. The only retry is a `429`, honouring `Retry-After`. The
CLI's `airprompter pull --tags-only --base-url <run url> --out slots.json`
writes the same catalogue for build steps.

## Module map

| Module | What it holds |
| --- | --- |
| `src/agent.ts` | `AirPrompterAgent`: start/boot fallback chain, `prompt().render()`, `workflow()`, `report()`, `feedback()`, `unlock()`, `rollback()`, `status()`, `invoke()` |
| `src/protocol/` | Wire types, canonical JSON + SHA-256, the trust chain (RFC 7638 thumbprints, ES256/P1363, root metadata R1–R5, manifest M1–M12), sticky assignment, workflow step order |
| `src/store/` | `SlotStore`: two slots, stage → fsync → activate, AAD `agentId target generation contentHash` per payload, anti-rollback counter outside the slots, DEK wrapped by a `KeyProvider` (file key default; custom / KMS via `customKeyProvider`) |
| `src/bundle/` | `.apbundle` v1: HPKE X25519 / HKDF-SHA256 / AES-256-GCM (RFC 9180 vectors), AAD `agentId|target` so a bundle cannot be relabelled |
| `src/render/` | `{{name}}` substitution with trust-aware fencing; `runRef` (HMAC, content-free) |
| `src/spool/` | Minute windows per dimension set, segment naming and rotation (`SegmentPlanner`), `DirectorySink` (0600, `.open` until fsync + rename, crash recovery) and `MemorySink`, the feedback catalogue normaliser |
| `src/sync/` | `SyncClient` (edge pointer, manifest with ETag, payloads by hash), `syncOnce` (root → pointer → manifest → only the changed payloads → verify → stage → policy), `DaemonClient` (the socket side of `protocol/daemon-socket.md`) |

Every file in `protocol/vectors/` runs through these modules in `test/`.

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
npm ci
npm run typecheck
npm test          # node:test, ~1 s
npm run build     # dist/esm + dist/cjs
```

Optional key providers ship as separate packages:
`@airprompter/keyprovider-aws-kms`, `-vault`, `-os-keystore`. Provider
middleware (`ap.wrap()` for the OpenAI, Anthropic and Vercel AI SDK
clients) and declared output checks are on the roadmap (T8, T9).
