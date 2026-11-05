# airprompter-agent-otel

The AirPrompter agent SDK's telemetry spool as an OpenTelemetry exporter:
minute windows become OTLP metrics
(`gen_ai.client.operation.duration`, tokens, checks, feedback, refusals) and
go to the collector you already run, with no AirPrompter grant at all. A
separate distribution so the main package carries no exporter.

```python
from airprompter_agent import AirPrompterAgent, TelemetryOptions
from airprompter_agent_otel.exporter import OtlpUploadSink

sink = OtlpUploadSink(endpoint="http://localhost:4318/v1/metrics", resource={"service.name": "support-bot"})
ap = AirPrompterAgent.start(..., telemetry=TelemetryOptions(upload_sink=sink))
```

- `endpoint` posts OTLP/HTTP JSON with httpx; `exporter` takes any callable, so
  the protobuf and gRPC paths need no code here.
- A collector's 4xx or 5xx drops and counts the segment, a `Retry-After` holds
  it, and a collector that never answered keeps it under backoff.
- Attribute keys are a closed set the conformance suite pins, and the rows carry
  no prompt text.

Depends on `airprompter-agent` at the same version. Parity with
`@airprompter/agent-otel` is pinned by `protocol/vectors/otel-mapping.json`.
BSD-3-Clause.
