# airprompter-agent-telemetry

The content-free telemetry spool and its uploader: minute windows per
`(tag, artifactId, versionId, arm, model, status, errorClass, audienceIds,
outcomeRunMinute)` written as append-only
NDJSON segments (`DirectorySink`) or held in memory on a serverless host
(`MemorySink`), the host budget, and `SpoolUploader` — direct to your
prefix in object storage under a short-lived grant. The row shape
(`airprompter_agent_core.telemetry.rows`) has no field for prompt text,
output or an end-user identifier. Never imports the sync or the runtime
distribution.

```python
from airprompter_agent_telemetry import SpoolWriter, DirectorySink, Observation, WriterIdentity
```

For audience- or artifact-aware feedback, pass the authenticated
`outcome_run_minute`. Without it, `outcomes()` updates only an already
measured matching run in the writer's current open minute.

One of eight distributions released in lockstep — the five core SDK
distributions and three datastore adapters — one version, exact-pinned
siblings. The full README and the parity matrix are in
[`sdk-python/README.md`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/sdk-python);
the protocol is in [`protocol/`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/protocol).
BSD-3-Clause.
