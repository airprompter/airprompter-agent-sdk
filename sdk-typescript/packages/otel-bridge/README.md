# @airprompter/otel-bridge

The AirPrompter agent SDK's telemetry spool as an OpenTelemetry exporter. A
segment's minute windows become one OTLP/HTTP JSON
`ExportMetricsServiceRequest` — `gen_ai.client.operation.duration` as a delta
histogram in seconds, the token / check / feedback / refusal / dropped sums
by the documented attributes — and go to the collector you already run,
never to AirPrompter: no grant, no Agent key, no second sidecar. An
`UploadSink` for `@airprompter/agent-telemetry`'s uploader, in
`airprompterd` (`--upload-sink otlp --otlp-endpoint …`) or in-process.

```ts
import { AirPrompterAgent } from "@airprompter/agent-sdk";
import { otlpUploadSink } from "@airprompter/otel-bridge";

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

Optional and released in lockstep with the five `@airprompter/agent-*`
packages; depends on `@airprompter/agent-core` alone, and the facade never
pulls it in. The full README and the compatibility table are in
[`sdk-typescript/README.md`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/sdk-typescript);
the mapping's prose is [`docs/telemetry.md`](https://github.com/airprompter/airprompter-agent-sdk/blob/main/docs/telemetry.md).
BSD-3-Clause.
