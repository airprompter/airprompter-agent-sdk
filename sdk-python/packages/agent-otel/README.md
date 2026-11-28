# airprompter-agent-otel

The AirPrompter agent SDK's telemetry spool as an OpenTelemetry exporter:
minute windows become OTLP metrics
(`gen_ai.client.operation.duration`, tokens, checks, feedback, refusals) and
go to the collector you already run, with no AirPrompter grant at all. A
separate distribution so the main package carries no exporter.

## Install

```bash
pip install "airprompter-agent==1.0.0rc5" "airprompter-agent-otel==1.0.0rc5"
```

It depends on `airprompter-agent` (exactly this version on a release candidate, this version or later
within the major from 1.0.0), so one copy resolves.

<!-- release-candidate -->
This is a release candidate for 1.0.0. Pin it exactly, as above: unpinned, pip
takes the 0.x line, and `--pre` opens prereleases on every dependency.
<!-- /release-candidate -->

## Use

```python
from airprompter_agent import AirPrompterAgent, TelemetryOptions
from airprompter_agent_otel.exporter import OtlpUploadSink

sink = OtlpUploadSink(endpoint="http://localhost:4318/v1/metrics", resource={"service.name": "support-bot"})
ap = AirPrompterAgent.start(..., telemetry=TelemetryOptions(upload_sink=sink))
```

- `endpoint` posts OTLP/HTTP JSON through the SDK's `Transport` (httpx by default, or `transport=`); `exporter` takes any callable, so
  the protobuf and gRPC paths need no code here.
- A collector's 4xx or 5xx drops and counts the segment, a `Retry-After` holds
  it, and a collector that never answered keeps it under backoff.
- Attribute keys are a closed set the conformance suite pins, and the rows carry
  no prompt text.

Depends on `airprompter-agent` at the same version. Parity with
`@airprompter/agent-otel` is pinned by `protocol/vectors/otel-mapping.json`.
BSD-3-Clause.
