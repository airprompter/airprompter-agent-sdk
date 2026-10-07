# @airprompter/agent-telemetry

The content-free telemetry spool and its uploader: minute windows per
`(tag, artifactId, versionId, arm, model, status, errorClass, audienceIds,
outcomeRunMinute)` written as append-only
NDJSON segments (`DirectorySink`: 0600, `.open` until fsync + rename, crash
recovery) or held in memory on a serverless host (`MemorySink`), the host
budget, and `SpoolUploader` — direct to your prefix in object storage under
a short-lived grant, with quarantine and the last-upload marker. The row
shape (`@airprompter/agent-core`) has no field for prompt text, output or
an end-user identifier. Install it alone when your own instrumentation
writes the spool.

```ts
import { SpoolWriter, DirectorySink } from "@airprompter/agent-telemetry";

const writer = new SpoolWriter(new DirectorySink(spoolDir, instanceId), { instanceId, instanceClass: "resident", sdk: "my-app/1.0" });
writer.observe({ tag, artifactId, versionId, arm, model, status: "ok", latencyMs, tokens: { input, output } }, Date.now());
```

For audience- or artifact-aware feedback, pass the authenticated
`outcomeRunMinute`. Without it, `outcomes()` updates only an already measured
matching run in the writer's current open minute.

`SpoolUploader` ships to an `UploadSink`: AirPrompter's by default, or one
you pass (`sink:`) — `@airprompter/otel-bridge` sends the windows to your
OpenTelemetry collector with no grant and no key.

This package never imports the sync or the runtime package.

One of nine packages released in lockstep — the five core SDK packages,
`@airprompter/otel-bridge`, and three datastore adapters — one version,
exact-pinned siblings. The direction is core → clients → sdk and is linted.
The full README, the module map and the compatibility table are in
[`sdk-typescript/README.md`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/sdk-typescript);
the protocol is in [`protocol/`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/protocol).
BSD-3-Clause.
