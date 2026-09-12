# Protocol

The wire contract between an AirPrompter agent runtime and the control
plane. Owned here, consumed by the SDKs in this repository, by the hosted
service, and by any self-hosted registry that implements it.

| File | Purpose |
|---|---|
| `spool-format.md` | The local telemetry spool: file layout, row types, what may never be in it, how third-party instrumentation writes to it |
| `schemas/telemetry-window.schema.json` | One minute of one dimension set — content-free by schema |
| `schemas/latency-buckets.json` | The 16 fixed histogram edges every writer must use |
| `schemas/feedback-signals.schema.json` | What `ap.feedback()` accepts |
| `schemas/manifest.schema.json` | *(next)* signed release manifest: slots, arms, directives, lease, generation |
| `schemas/key-set.schema.json` | *(next)* root metadata (offline root → online signing keys, threshold, expiry) |
| `schemas/bundle.schema.json` | *(next)* the `.apbundle` offline format |
| `assignment-hash.md` | *(next)* `SHA-256(salt ‖ subject)`, first 8 bytes big-endian mod 10000 |
| `openapi.yaml` | *(next)* customer routes: manifest, payloads, heartbeat, countersign, run |
| `canonical-json.md` | Canonical JSON: the encoding under every release digest, and what the digest covers |
| `vectors/` | Conformance vectors every SDK must pass |

Versioning: this directory has its own semver. A manifest carries the
`protocol` version it was written for; the hosted service supports the
current and previous major. SDK packages declare the protocol range they
speak.
