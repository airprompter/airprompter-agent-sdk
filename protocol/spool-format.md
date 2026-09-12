# Spool format — local telemetry the daemon picks up

The spool is a directory of append-only files on the host. The SDK writes
to it; **any other instrumentation may write to it too** — an
OpenTelemetry exporter, a wrapper around a provider SDK we do not ship, a
line in your own logger. If a file is in the spool and matches the schema,
`airprompterd` uploads it. That makes the spool the integration point for
the open-source SDKs: their responses carry tokens and timing, and a few
lines of code turn those into a window row here.

Status: **draft 1** — matches design decision D52/D66. Breaking changes bump
`protocol` major.

## Location and permissions

```
<stateDir>/airprompter/<agentId>/<target>/spool/telemetry/
  seg-<instanceId>-<epochMinute>-<n>.ndjson      open or closed segment
  sent/                                           segments acknowledged by S3, deleted after 24 h
  quarantine/                                     segments the daemon could not parse (kept 24 h)
```

- Directory mode `0700`; files `0600`. The daemon runs as the same user or a
  group the SDK's user belongs to.
- `<stateDir>` defaults to the OS state directory (`$XDG_STATE_HOME`,
  `~/Library/Application Support`, `%LOCALAPPDATA%`); containers mount a
  volume there if segments must survive the container.

## Segment files

- **Append-only NDJSON**, UTF-8, one JSON object per line, `\n` terminated.
- A segment is *open* while its writer holds it; writers **close** a segment
  by `fsync` + rename to drop the trailing `.open` suffix
  (`seg-…ndjson.open` → `seg-…ndjson`). The daemon never reads `.open`
  files. A writer that crashes leaves an `.open` file; on its next start the
  same writer closes it (partial last line discarded).
- Rotate when the minute changes or the file reaches **1 MiB**.
- Names are unique per `(instanceId, epochMinute, n)`; the object key in S3
  is derived from the file name, which is what makes retries idempotent.
- Disk budget per host: 100 MiB by default. When exceeded, the writer (or
  the daemon, on a shared host) evicts the **oldest unsent** segments and
  writes the count and bytes as a `dropped` row — its own small closed
  segment, at once — so the loss is reported, never silent.
- Serverless hosts keep a **256 KiB** memory buffer instead of a directory
  and flush at invocation end; past the buffer the oldest rows are evicted
  and one `dropped` row (rows counted as `segments`) closes the flush.

## Row types

Every row has `type` and `v` (row schema version). Unknown fields are
dropped at ingest; unknown row types are quarantined.

### `window` — one minute of one dimension set

```json
{"type":"window","v":1,
 "minute":"2026-09-11T14:03:00Z",
 "instanceId":"i-7f3a…","instanceClass":"resident",
 "tag":"support.triage","versionId":"pv_…","arm":"candidate",
 "model":"claude-haiku-4-5","status":"ok","errorClass":null,
 "usageSource":"reported",
 "count":412,
 "latencyMs":{"buckets":[0,0,3,41,188,150,27,3,0,0,0,0,0,0,0,0],"sum":617384},
 "tokens":{"input":493200,"cachedInput":329600,"output":103000},
 "checks":{"passed":405,"failed":7},
 "outcomes":{"accepted":{"n":388,"sum":362},"rating":{"n":41,"sum":171}},
 "sdk":"agent-sdk-ts/0.1.0"}
```

- `latencyMs.buckets` are counts against the **fixed edges** in
  `schemas/latency-buckets.json` (16 log-spaced edges, 1 ms → 65 s) so
  percentiles merge across instances: a value lands in the first bucket
  whose edge is `>=` it; anything above the last edge lands in the last
  bucket. `latencyMs.sum` is the total of the observed values, each
  rounded half up and floored at 0.
- `count` is the number of runs observed in the minute. Feedback
  (`outcomes`) filed against a run rides on that run's `status: ok` window
  for the minute it arrives in and **never** adds to `count` or
  `latencyMs`; a window can therefore have `count: 0` when the feedback
  arrives in a later minute than the run.
- `errorClass` is the closed enum in `schemas/telemetry-window.schema.json`:
  `render_missing_variable, context_length_exceeded, output_schema_invalid,
  truncated, content_filter, provider_error, provider_timeout,
  provider_rate_limited`. Nothing after the model returns is an error class.
- `outcomes` carries only declared signal names from the feedback catalogue
  (`schemas/feedback-signals.schema.json`), each as `{n, sum}`.
- Rows for the same key `(instanceId, minute, tag, versionId, arm, model,
  status, errorClass)` **replace** each other at ingest (SET semantics), so
  a replayed segment is a no-op.

### `refusal` — a control-plane refusal (rare, content-free)

```json
{"type":"refusal","v":1,"at":"2026-09-11T14:03:12Z","instanceId":"i-7f3a…",
 "reason":"lease_expired","generation":41,"tag":null}
```

Reasons: `disabled`, `lease_expired`, `payload_verification_failed`,
`forced_downgrade`, `model_unavailable`, `unlock_refused`. Row shape in
`schemas/spool-rows.schema.json` (with `dropped` below).

### `dropped` — segments evicted by the disk budget

```json
{"type":"dropped","v":1,"at":"2026-09-11T14:05:00Z","instanceId":"i-7f3a…","segments":3,"bytes":2871040}
```

## Field names and OpenTelemetry

Window fields follow the OpenTelemetry GenAI semantic conventions where one
exists, so an OTLP exporter is a renaming, not a redesign:

| window field | OTel GenAI |
| --- | --- |
| `model` | `gen_ai.request.model` |
| `tokens.input` | `gen_ai.usage.input_tokens` (uncached; OpenAI's `cached_tokens` are split out) |
| `tokens.cachedInput` | `gen_ai.usage.cache_read.input_tokens` (proposed) |
| `tokens.output` | `gen_ai.usage.output_tokens` |
| `latencyMs` | `gen_ai.client.operation.duration` (histogram; OTel's unit is seconds) |
| `errorClass` | `error.type` |
| `status` | derived: `error.type` present |
| `tag`, `versionId`, `arm` | `airprompter.prompt.tag`, `.version`, `.arm` (custom attributes) |
| `sdk` | `telemetry.sdk.name` / `.version` — a **dimension at ingest**, so a misreporting writer is isolated |

## What must never be in the spool

Prompt text, model output, end-user identifiers, stack traces, application
error messages. The schema has no field for them; the ingest processor
drops unknown fields and quarantines unknown rows. Writers that need to
correlate to their own traces use the `runRef` on their side — it never
enters a window.

## Upload (for reference; implemented by the daemon)

Heartbeat with the Agent key returns a presigned S3 POST grant (≤ 15 min,
prefix `org/{org}/agent/{agent}/{target}/{instance}/`, ≤ 1 MiB, NDJSON,
SSE-KMS, grant id) plus `uploadIntervalSeconds`. Closed segments are PUT to
S3 under the grant with exponential backoff and full jitter (1 s → 5 min),
one in flight per host; acknowledged segments move to `sent/`. A refused
grant is the throttle. Nothing AirPrompter runs is in the write path.

## Writing to the spool without our SDK

1. After each model call, take `usage` and elapsed time from the provider
   response.
2. Accumulate into the open minute's `window` row for
   `(tag, versionId, arm, model, status, errorClass)` — the `tag`,
   `versionId` and `arm` come from the release you rendered (or from the
   `runRef` the compatible endpoint returned).
3. At minute end write the row to the open segment, `fsync`, close per the
   rules above.

`vectors/spool.json` pins the bucket index, minute formatting, segment
naming, rotation and window aggregation; `vectors/feedback.json` pins the
feedback catalogue. A writer that passes both interoperates with the
daemon. The TypeScript SDK's `src/spool/writer.ts` is the reference
implementation; `conformance/spool.mjs` is the independent one CI runs.
