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
const started = Date.now();
const reply = await yourModelClient.complete({ model: r.model, prompt: r.text });
ap.report({ tag: r.tag, versionId: r.versionId, arm: r.arm, model: r.model, status: "ok", latencyMs: Date.now() - started, tokens: { input: reply.usage.input, output: reply.usage.output } });
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
