# Protocol

The wire contract between an AirPrompter agent runtime and the control
plane. Owned here, consumed by the SDKs in this repository, by the hosted
service, and by any self-hosted registry that implements it.

| File | Purpose |
|---|---|
| `openapi.yaml` | The customer-v1 agent routes: manifest, payloads, heartbeat, countersign, run. Each operation says whether the hosted service serves it yet |
| `schemas/manifest.schema.json` | The signed release manifest: slots, experiment arms, directives, lease, generation; `signatures[]` and `countersignatures[]` |
| `schemas/key-set.schema.json` | Root metadata (TUF-shaped): offline root keys → online signing keys, threshold, expiry; the same shape for customer countersign keys |
| `schemas/bundle.schema.json` | The `.apbundle` offline format: manifest + payloads + key-set, encrypted to the target's distribution key (plaintext is a `dev` opt-in) |
| `schemas/heartbeat.schema.json` | Instance state in, presigned upload grant + intervals out — content-free by schema |
| `schemas/edge-pointer.schema.json` | `generation.json`, the few hundred bytes idle instances poll at the edge |
| `schemas/telemetry-window.schema.json` | One minute of one dimension set — content-free by schema |
| `schemas/latency-buckets.json` | The 16 fixed histogram edges every writer must use |
| `schemas/feedback-signals.schema.json` | What `ap.feedback()` accepts |
| `canonical-json.md` | Canonical JSON: the encoding under every release digest and every signature, and what the digest covers |
| `assignment-hash.md` | Sticky assignment: `SHA-256(salt ‖ subject)`, first 8 bytes big-endian mod 10000, cumulative arm weights |
| `spool-format.md` | The local telemetry spool: file layout, row types, what may never be in it, how third-party instrumentation writes to it |
| `examples/` | One valid document per schema, and `refused/` documents each schema must reject |
| `vectors/` | Conformance vectors every SDK must pass |
| `tools/` | The independent Python generators behind `vectors/assignment.json` and `examples/` — CI regenerates and diffs |

## Signing, in one paragraph

A manifest is a DSSE-shaped envelope: `payload` plus `signatures[]`. The
bytes signed are the canonical JSON of `payload` (`canonical-json.md`),
hashed with SHA-256 and signed ECDSA P-256 (`ES256`, P1363 `r ‖ s`,
base64url). The key that signed must be listed in the `targets` role of a
root document (`key-set.schema.json`) that the runtime already trusts —
the root public key is pinned in SDK source — and that root document must
not be expired. A countersignature signs the UTF-8 bytes of a
`releaseDigest` string with a customer-held key from a customer root
document of the same shape. The verification order and the refusal codes
are in `schemas/heartbeat.schema.json` (`refusal`) and in the trust-chain
vectors when they land.

## Scopes named here

`agent.bundle.read` (manifest, payloads), `agent.telemetry.write`
(heartbeat), `agent.countersign.write` (countersign), `agent.run`
(managed execution — a separate key kind, never co-granted by default).

## Versioning

This directory has its own semver, tagged `protocol/vX.Y.Z`. A manifest
carries the `protocol` version it was written for; the hosted service
supports the current and previous major. SDK packages declare the
protocol range they speak. Consumers pin a tag and vendor `schemas/`,
`vectors/` and `examples/` — the hosted service does exactly that
(`packages/contracts/protocol/` in prompt-haven, refreshed by
`protocol-sync.mjs`, drift-checked in CI).

Before `1.0.0` a minor bump may change a schema in a breaking way; the
CHANGELOG says so per entry. From `1.0.0`, breaking changes are a major.

## Where the protocol lives (DA-8)

The protocol lives with its consumer, this repository. Hangar (the
self-hosted registry) depends on it. It would move to a repository of
its own only if a server-side change were needed that no SDK needs —
that is the tie-break, written down so the question is not reopened
each time.
