# airprompter-agent (Python)

Run the prompts and workflows your team approved in AirPrompter on your
own systems. The SDK pulls signed releases, keeps them in an encrypted
restart-safe store, renders with trust-aware variables, and writes
content-free telemetry to a local spool. Nothing AirPrompter runs is on
your request path; with the network gone, the last verified release keeps
serving.

Python 3.10+, `cryptography` and `httpx`. The same protocol, the same
conformance vectors and the same on-disk store as the TypeScript SDK — a
store one SDK wrote is a store the other (and the host daemon) opens.

```bash
pip install airprompter-agent            # + [openai] [anthropic] [litellm] [kms] [vault] [keyring]
```

## Quick start

```python
import os
from airprompter_agent import AirPrompterAgent
from airprompter_agent.integrations.openai import chat_completion

ap = AirPrompterAgent.start(
    organization_id="org_…",
    agent_id="agt_…",
    target="prod",
    api_key=os.environ["AIRPROMPTER_AGENT_KEY"],   # an Agent key (distribution kind); omit to run fully offline
    root={"pinned": {"kty": "EC", "crv": "P-256", "x": "…", "y": "…"}},  # the environment's root key, from your Agent's Settings tab
    sync={"mode": "resident", "poll_seconds": 30, "edge_pointer_url": "https://…/g/<token>/generation.json"},
    models={"gpt-5": {"provider": "openai"}},   # what this process can call: reported on every heartbeat, never verified
)

r = ap.prompt("support.triage").render(team="Billing", ticket=user_message)
# observe() times the call, reads `usage` off the provider's response (OpenAI, Anthropic, Bedrock — dicts or SDK
# objects), classifies a failure into the closed error set, and returns the result unchanged.
reply = ap.observe(r, lambda: openai.chat.completions.create(model=r.model, messages=[{"role": "system", "content": r.text}, {"role": "user", "content": user_message}]))
# …or wrap the client once and change nothing at the call site: the call is attributed to the render whose text it carries.
openai = ap.wrap(OpenAI())
reply = openai.chat.completions.create(model=r.model, messages=[{"role": "system", "content": r.text}, {"role": "user", "content": user_message}])
# …or the explicit helper, which places the rendered text for you:
reply = chat_completion(ap, r, openai, messages=[{"role": "user", "content": user_message}])
# …or report by hand:
ap.report(tag=r.tag, version_id=r.version_id, arm=r.arm, model=r.model, status="ok", latency_ms=812, tokens={"input": 400, "output": 90})
ap.feedback(r.run_ref, thumbs="up")
```

`render()` never touches the network. A variable declared `end_user` is
fenced (`<ticket>…</ticket>`) so the model sees where untrusted input
starts and stops; a missing required variable raises
`MissingVariableError`; a value for a variable the slot did not declare
raises `UnknownVariableError`.

Async applications use `await ap.observe_async(r, lambda: client.messages.create(...))`
(and `chat_completion_async` / `messages_create_async`). Everything else
is synchronous and thread-safe; resident mode runs its sync, heartbeat and
update-window timers on daemon threads.

## What happens at start

1. The store is read before any network call. The active slot is
   verified (signatures, hashes, generation counter, expiry); if it does
   not verify, the other slot is tried.
2. With nothing verified in the store, a vendored `.apbundle`
   (`vendored_bundle=`) is opened, verified the same way, and staged
   through the store.
3. With still nothing, one synchronous sync runs — the only time the SDK
   waits on the network. If that fails too, `start()` raises
   `AgentStartError("no_verified_release")`. Serving an unverified release
   is never an option.

Sync modes: `resident` (timer + jitter, edge pointer first so idle
instances never wake a Lambda), `on_invoke` (serverless: `ap.invoke(fn)`
syncs before and after the handler; telemetry goes to a memory sink you
drain with `ap.drain_memory_sink()` at invocation end), `daemon` (attach
to the host's `airprompterd` over its Unix socket: no key, no store of its
own, `generation` events push new releases; with no daemon on the host
the runtime syncs in-process exactly as `resident`), `offline` (no
`api_key`: serve the store or the bundle, never call home).

## Apply policy

The manifest carries `applyPolicy`. Under `unlock_required` a new
generation is staged, not activated; `apply.on_staged` is called, and
`ap.unlock()` makes it live. `ap.rollback()` flips to the other slot
instantly; going below the stored generation is a forced downgrade,
stamped in the store and in the spool, and the control plane's current
generation is held back until it moves past the one you left. The local
side can be stricter than the manifest (`apply={"policy": "unlock_required"}`),
never looser. In `daemon` mode both calls act for the whole host.

```python
ap = AirPrompterAgent.start(
    …,
    apply={
        # an update window: staged releases go live on their own inside it ("HH:MM-HH:MM <IANA zone> [days]");
        # a local window wins over the one the console put on the manifest.
        "window": "02:00-04:00 Europe/Berlin mon,tue,wed,thu,fri",
        # a change-control hook: call staged.activate() to go live; return (or raise) without it to leave it staged.
        "on_staged": lambda staged: staged.activate() if change_control.approved(staged.generation) else None,
    },
)
```

**Output checks.** Checks declared on the slot (a JSON schema, an enum at a
path, a token band, a pattern that must or must not occur) run inside
`observe()` on the provider's answer, here on the host, and count
`passed` / `failed` on the run's window; `ap.checks(rendered, output)` runs
them on text you already have and returns the per-check results. Checks
are form, not quality; a failing check never raises. Patterns are RE2-class
only and an output over 64 KiB fails a pattern check closed —
`protocol/checks.md`.

`models` is the catalogue the console shows under Settings › Models and the
gate a release must pass at seal. A release may mark a slot's model
**required**; a process whose `models` lacks it refuses that release
(`status().last_refusal == "model_unavailable"`, the heartbeat names the
model) and keeps serving what it has. Declare nothing and no release is
refused over a model.

A `disable` directive (a Freeze from the console) is honoured from any
manifest whose signature verifies — even one left staged — and
`render()` raises `RenderRefusedError("disabled")` until the next
verified manifest lifts it. A lapsed lease degrades (keeps serving,
reports it) or halts (`RenderRefusedError("lease_expired")`) per the
manifest's `onLeaseExpiry`.

## Key providers

What protects the store's key-encryption key is reported on every
heartbeat as `storageProtection`, so a fleet view can show a `file_key`
host as a finding instead of hiding it.

| Provider | `storageProtection` | Extra |
|---|---|---|
| `file_key(path)` (default: `store.key` beside the store, 0600) | `file_key` | — |
| `kms(key_id)` — AWS KMS Encrypt/Decrypt | `kms` | `pip install airprompter-agent[kms]` |
| `vault(transit_key)` — HashiCorp Vault transit | `vault` | `[vault]` |
| `os_keystore()` — Keychain / Credential Locker / Secret Service | `os_keystore` | `[keyring]` |
| `custom_key_provider(wrap=…, unwrap=…)` | `custom` | — |

`SlotStore.rotate_key(provider)` re-wraps the DEK under a new provider
without re-encrypting a payload.

## Managed mode

Feedback works the same way hosted: keep `result.run_ref` beside your own
record and later call `agent.feedback(run_ref, accepted=True, rating=4)` from
any process holding the run key.

No store, no models, no keys of your own: `ManagedAgent.start(agent_id=…, target=…, api_key=<run key>, base_url=<run route>)`,
then `agent.run("support.triage", {"team": "Billing", "ticket": text}, subject="user-42")`
or `for delta in agent.stream(...)`. The subject is hashed with the
experiment's salt here and never sent.

## Provider wrappers

**`ap.wrap(client)` (D65)** returns the same `openai` / `anthropic` client
(sync or async) with its public model-call methods observed — a proxy,
never a patched internal, and no import of the provider package (they are
optional extras). Each call is timed, its usage and finish reason read off
the response or the stream as it goes by, the slot's declared checks run
on the text here, and one content-free observation filed. Nothing the
wrapper does can fail the call: an unattributed call passes straight
through (logged `wrap_unattributed`) and a stream a consumer abandons
reports what was seen.

| Client | Observed methods | Streams |
| --- | --- | --- |
| `openai` (`OpenAI` / `AsyncOpenAI`) | `chat.completions.create` / `.parse` / `.stream()`, `responses.create` / `.parse` / `.stream()`, `beta.chat.completions.parse` | `stream=True` (usage from the last chunk — pass `stream_options={"include_usage": True}`); the `.stream()` context managers through `get_final_completion()` / `get_final_response()`, else the helper's `current_completion_snapshot` when the block closes |
| `anthropic` (`Anthropic` / `AsyncAnthropic`) | `messages.create`, `messages.stream()`, `beta.messages.*` | `stream=True` (usage from `message_start` + `message_delta`); `messages.stream()` through `get_final_message()`, else `current_message_snapshot` when the block closes |
| LiteLLM | `AirPrompterLiteLLMCallback(ap)` on `litellm.callbacks` | attributed by `metadata=litellm_metadata(rendered)` or by the messages' text |

`with_raw_response` / `with_streaming_response` surfaces and any method
not in the table are the client's own and are not observed.

**Which render a call belongs to.** In order: an enclosing
`with ap.attribute(rendered):` block (a `contextvars` variable, so it
follows `await`s and threads started with a copied context); else a
request text — `system`, `instructions`, then each message's string or
`text` parts — that is exactly one of the last 256 renders (matched by
SHA-256; the registry keeps hashes and dimension names, never a prompt);
else the call is unattributed and passed through. The request's `model`
names the window.

The explicit helpers remain: `airprompter_agent.integrations.openai`
(`chat_completion`, `responses_create`, async twins) and
`airprompter_agent.integrations.anthropic` (`messages_create`, async twin)
place the rendered text for you and call `ap.observe` by name. Each imports
its library lazily; none is required to install the SDK. The wrapper suites
run against clients shaped like the real ones in CI and against the latest
`openai`, `anthropic` and `litellm` releases weekly
(`.github/workflows/wrap-latest.yml`; `WRAP_LIVE=1 python -m pytest
tests/test_wrap_live.py` locally).

## Parity with the TypeScript SDK

Same protocol version (`0.2.5`), same vectors, same store layout. The
conformance suite (`tests/test_protocol_vectors.py`, `tests/test_spool.py`)
runs every vector the TypeScript SDK runs, and `tests/test_interop.py`
opens a store the TypeScript SDK wrote (encrypted A slot, spool segment,
a `run_ref` minted there).

| Area | TypeScript | Python |
|---|---|---|
| Canonical JSON, release digest, sticky assignment, workflow steps | ✓ | ✓ (same vectors, incl. UTF-16 key order for astral characters) |
| Trust chain R1–R5 / M1–M12, ES256 P1363 | ✓ | ✓ (`cryptography`) |
| A/B slot store, AAD binding, anti-rollback, KEK rotation | ✓ | ✓ (byte-compatible; interop test) |
| Key providers | file, custom (+ optional packages) | file, custom, kms (boto3), vault (hvac), os_keystore (keyring) |
| `.apbundle` (HPKE X25519 / AES-256-GCM, RFC 9180 A.1 vector) | ✓ | ✓ |
| Render, trust-aware fencing, `run_ref`, feedback catalogue | ✓ | ✓ |
| Spool writer: minute windows, segments, both budgets, `dropped` rows | ✓ | ✓ (same vectors) |
| Sync: resident / on_invoke / offline, edge pointer, root rotation, held-back generations | ✓ | ✓ |
| Daemon attach (`daemon-socket.md`) | Unix socket + Windows named pipe | Unix socket (Windows named pipe: next phase — falls back to in-process) |
| Apply control: update window (DST-safe), `on_staged` hook, Freeze precedence, heartbeat | ✓ | ✓ (`zoneinfo`) |
| `observe()`: OpenAI / Anthropic / Bedrock usage, error classes | ✓ | ✓ + SDK objects, async variant |
| Managed mode (catalogue, run, stream, typed refusals, 429 retry) | ✓ | ✓ |
| Provider wrappers | `ap.wrap()` for openai / Anthropic, AI SDK middleware | `ap.wrap()` for openai / anthropic (sync + async), explicit helpers, LiteLLM callback |
| Spool upload on hosts | `airprompterd` uploads every writer's segments (T26) | same daemon — the SDK writes, the daemon uploads |
| Serverless flush under the runtime's own grant (`flushTelemetry`, `requestUploadGrant`) | ✓ | next phase (drain the memory sink with `drain_memory_sink()` and POST it yourself until then) |
