# @airprompter/agent-otel

The AirPrompter agent SDK's telemetry spool as an OpenTelemetry exporter. A
segment's minute windows become one OTLP/HTTP JSON
`ExportMetricsServiceRequest` — `gen_ai.client.operation.duration` as a delta
histogram in seconds, the token / check / feedback / refusal / dropped sums
by the documented attributes — and go to the collector you already run,
never to AirPrompter: no grant, no Agent key, no second sidecar. An
`UploadSink` for the uploader in `@airprompter/agent-sdk/telemetry`, in
`airprompterd` (`--upload-sink otlp --otlp-endpoint …`) or in-process.

## Install

```bash
npm install --save-exact @airprompter/agent-sdk@1.0.0-rc.5 @airprompter/agent-otel@1.0.0-rc.5
```

The SDK is a peer (exactly this version on a release candidate, this version or later within the major
from 1.0.0), so one copy resolves.

<!-- release-candidate -->
This is a release candidate for 1.0.0. Pin it exactly, as above: npm's default
range on a candidate also matches later candidates, and an unpinned install
takes the `latest` tag, the 0.x line.
<!-- /release-candidate -->

## Use

```ts
import { AirPrompterAgent } from "@airprompter/agent-sdk";
import { otlpUploadSink } from "@airprompter/agent-otel/exporter";

const ap = await AirPrompterAgent.start({
  organizationId, agentId, target: "prod", root: { pinned },
  telemetry: { uploadSink: otlpUploadSink({ endpoint: "http://localhost:4318/v1/metrics", headers: { authorization: process.env.OTEL_TOKEN! }, resource: { "service.name": "support-bot" } }) },
});
```

Rules: a collector's answered refusal (4xx / 5xx) **drops and counts** the
segment — never a spool that fills behind a misconfigured collector — while
an unanswered request (the network, a timeout) keeps it under backoff, and
`429` / `503` with `Retry-After` holds for that long; nothing here
reads a prompt (the attribute keys are a closed set); the exporter is
pluggable (`exporter:` takes `@opentelemetry/exporter-metrics-otlp-proto`
or `-grpc` wrapped in a few lines). The mapping is pinned by
`protocol/vectors/otel-mapping.json`; `spoolRowsToOtlp(rows)` is the pure
function behind the sink.

Optional and released in lockstep with `@airprompter/agent-sdk`, which it takes
as a peer at the same version, so an application holds one copy of the SDK. The
SDK never pulls this package in. `/exporter` is its one subpath today. The full README is in
[`sdk-typescript/README.md`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/sdk-typescript);
the mapping's prose is [`docs/telemetry.md`](https://github.com/airprompter/airprompter-agent-sdk/blob/main/docs/telemetry.md).
BSD-3-Clause.
