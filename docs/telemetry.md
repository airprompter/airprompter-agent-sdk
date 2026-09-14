# Telemetry: the spool contract and the OpenTelemetry mapping

The runtime never sends a prompt, an answer or an end-user identifier
anywhere. What leaves the host is one row per minute per dimension set —
counts, token totals, a 16-bucket latency histogram, error classes, output
check counts and declared feedback outcomes — written to a local spool and
uploaded under a short-lived grant to your organization's own prefix.
The spool is a **public contract** (design D66): any process, in any
language, can write to it and be picked up by the daemon — or by the
runtime itself, on a host that runs none.

## The contract, in one table

| Concern | The rule | Where it is pinned |
|---|---|---|
| Location | `<state-dir>/<agentId>/<target>/spool/telemetry/`, 0700; segments 0600 | [`protocol/spool-format.md` › Location and permissions](../protocol/spool-format.md#location-and-permissions) |
| Segments | `seg-<instanceId>-<epochMinute>-<n>.ndjson`, `.open` until fsync + rename; rotate at the minute, at 1 MiB, or on an oversize line | [Segment files](../protocol/spool-format.md#segment-files); `vectors/spool.json` rotation cases |
| Rows | `window` (one minute of one dimension set), `refusal` (a control-plane refusal), `dropped` (segments evicted by the disk budget) — each validated against `spool-rows.schema.json` | [Row types](../protocol/spool-format.md#row-types) |
| Latency | 16 fixed bucket edges every writer uses | `schemas/latency-buckets.json`; `vectors/spool.json` 32 values |
| Feedback | `outcomes[signal] = {n, sum}` from the declared catalogue only; `goldenPass` is the runtime's own | `schemas/feedback-signals.schema.json`; `vectors/feedback.json` |
| Never in the spool | prompt text, model output, end-user identifiers, stack traces, application error messages — no field exists for them; unknown fields are dropped and unknown rows quarantined at ingest | [What must never be in the spool](../protocol/spool-format.md#what-must-never-be-in-the-spool) |
| Upload | heartbeat → presigned S3 POST grant (≤ 15 min, ≤ 1 MiB, the instance's own prefix); backoff with full jitter; acknowledged segments deleted (S6); a refused grant is the throttle | [Upload](../protocol/spool-format.md#upload-for-reference-implemented-by-the-daemon); `sdk-typescript/test/uploader.test.ts` |
| Offline | `airprompter export-telemetry` / `import-telemetry` carry the spool as one file, idempotent by key | [The spool over a file](../protocol/spool-format.md#the-spool-over-a-file-t16) |
| Third-party writers | `examples/spool-writer/` (TypeScript and Python, dependency-free) pass the same vectors | [Writing to the spool without our SDK](../protocol/spool-format.md#writing-to-the-spool-without-our-sdk) |

## Field → OpenTelemetry GenAI

Window fields follow the OpenTelemetry GenAI semantic conventions where one
exists, so an OTLP exporter is a renaming, not a redesign. This is the
mapping the protocol pins (`protocol/vectors/otel-mapping.json`, S13) and
the bridge ships; it is repeated here so a platform team can read it
without the format:

| Window field | OTel metric / attribute | Note |
|---|---|---|
| `model` | attribute `gen_ai.request.model` | as the provider names it |
| `latencyMs` (buckets + sum), `count` | histogram `gen_ai.client.operation.duration` (unit `s`) | the spool's fixed buckets as `explicitBounds` in seconds, the last bucket as overflow; a window with no runs (feedback-only, a golden run) has `count: 0` |
| `tokens.input` / `.cachedInput` / `.output` | sum `airprompter.tokens` by `gen_ai.token.type` = `input` / `cached_input` / `output` | `input` is uncached; OpenAI's `cached_tokens` are split out |
| `errorClass` | attribute `error.type` | one of the fixed error classes; absent on `ok` |
| `status`, `usageSource` | attributes `airprompter.status`, `airprompter.usage.source` | `reported` / `estimated` / `unavailable` |
| `checks.passed` / `checks.failed` | sum `airprompter.checks` by `airprompter.check.outcome` | declared output checks (`checks.md`) |
| `outcomes.<signal>.{n,sum}` | sums `airprompter.feedback.count` (monotonic) and `airprompter.feedback.sum` (not) by `airprompter.feedback.signal` | the declared catalogue; a rate is sum / count; `goldenPass` from a golden-set run |
| `tag`, `versionId`, `arm` | attributes `airprompter.prompt.tag`, `.version`, `.arm` | the arm is `none` outside a rollout |
| `sdk` | resource `telemetry.sdk.name` / `telemetry.sdk.version` | a **dimension at ingest**, so a misreporting writer is isolated |
| `instanceId`, `instanceClass` | resource `service.instance.id`; `airprompter.instance.class` | random, persisted; `resident` or `ephemeral` |
| `refusal` row | sum `airprompter.refusals` by `airprompter.refusal.reason`, `airprompter.generation` (+ `.prompt.tag`) | a render refused |
| `dropped` row | sums `airprompter.spool.dropped_segments`, `airprompter.spool.dropped_bytes` | the budget's loss, reported |

Every sum is delta temporality; a window's points carry the minute's start
and end as `startTimeUnixNano` / `timeUnixNano`. A `runRef` (the
content-free receipt `render()` returns) is what your own traces correlate
on; it never enters a window.

## Exporting to OpenTelemetry (S13)

A team that already runs an OpenTelemetry collector will not run a second
sidecar holding an Agent key. The bridge makes the spool an OTLP exporter:
every validated segment becomes one OTLP/HTTP JSON
`ExportMetricsServiceRequest` — the table above, exactly — and goes to the
collector, **never to AirPrompter**. No grant is requested, no key is
needed; a host with a vendored bundle and no network to AirPrompter still
exports. The uploader keeps owning the spool (the sweep, the budget, the
quarantine, delete on ack); the bridge only maps and sends. It is its own
package, `@airprompter/otel-bridge` (`airprompter_agent_telemetry.otel` in
Python), depending on core alone; the facade never pulls it in.

Three ways to run it:

```sh
# The daemon, for every writer on the host — no AIRPROMPTER_AGENT_KEY at all:
airprompterd --org … --agent … --environment prod --root root.jwk.json \
  --upload-sink otlp --otlp-endpoint http://localhost:4318/v1/metrics \
  --otlp-header 'authorization=$OTEL_TOKEN' --otlp-resource service.name=support-bot
```

```ts
// In-process, the facade:
import { otlpUploadSink } from "@airprompter/otel-bridge";
const ap = await AirPrompterAgent.start({ ..., telemetry: { uploadSink: otlpUploadSink({ endpoint: "http://localhost:4318/v1/metrics", resource: { "service.name": "support-bot" } }) } });
```

```python
from airprompter_agent_telemetry.otel import OtlpUploadSink
ap = AirPrompterAgent.start(..., telemetry=TelemetryOptions(upload_sink=OtlpUploadSink(endpoint="http://localhost:4318/v1/metrics", resource={"service.name": "support-bot"})))
```

The rules, each a vector:

- **Drop and count on a collector's refusal.** A collector that answers
  4xx or 5xx has decided: the segment is deleted, counted (`droppedSegments`
  in `status`, `segment_dropped_by_sink` in the log with the sink and the
  reason), and the next segment is tried — a spool that fills behind a
  misconfigured collector is the worse outcome. A `429` / `503` with
  `Retry-After` is a hold for that long, the segment kept. A collector that
  **never answered** (connection refused, a timeout — a restart mid-pass)
  has not decided: the segment is kept under the uploader's backoff and the
  budget (the S6 invariant bounds it), so a blip does not wipe a backlog.
- **Nothing here reads a prompt.** The attribute keys are the closed set in
  the table; the rows carry no text and no variable value.
- **Headers from the environment.** `--otlp-header 'name=$VAR'` (quoted, so
  the shell leaves it) takes the value from the daemon's environment, never
  from argv, so a hosted collector's token does not appear in a process
  list; an unset variable is a usage error, never an empty header.
- **Exporter-pluggable.** The built-in exporter is OTLP/HTTP with the JSON
  encoding over `fetch` / httpx and needs no OpenTelemetry dependency. The
  sink takes any `exporter` — `@opentelemetry/exporter-metrics-otlp-proto`
  or `-grpc` wrapped in a few lines, or your own — so the protobuf and gRPC
  paths need no code in the SDK.
- **A sink is a port.** `UploadSink` (`@airprompter/agent-core`) is what
  `SpoolUploader` ships to: `ship(segment) → ok | hold | failed | dropped |
  too_large`. AirPrompter's sink and the bridge are the two that ship;
  yours takes the same validated segments (`sink:` on the uploader,
  `telemetry.uploadSink` on the facade).

Vectors: `protocol/vectors/otel-mapping.json` (generated by
`protocol/tools/gen_otel_vectors.py` from this prose; both SDKs reproduce it
byte for byte and `conformance/run.mjs` checks the attribute set),
`sdk-typescript/test/otelBridge.test.ts`, `sdk-python/tests/test_otel_bridge.py`,
`cli/test/otelDaemon.test.ts` (the daemon against a collector with no key).

## What the writer does when the disk says no

The request path never sees the spool fail. A full disk, an I/O error, or a
segment another process evicted between our listing and our stat is
counted on the writer (`faults.byCode`, by the filesystem's own code) and
the rows that could not be kept are said in one `dropped` row the moment
a write works again — never thrown into your request. Every SDK reaches the
filesystem through a port, so the same writer runs in your CI over
`MemoryFs` from `@airprompter/agent-core/testing` (also `@airprompter/agent-sdk/testing`; `airprompter_agent_core.testing` in
Python): a filesystem you can fill, fail and take files from, with a clock
you can advance or skew. Our own vectors are those cases — two writers over
budget, a crash mid-open, no daemon, no grant — and they are the same
cases your host will meet.

## Telemetry without a daemon (S5)

The daemon is an optimisation, never a requirement. A resident host with
no `airprompterd` runs the same uploader in-process (`SpoolUploader`, the
one the daemon runs): closed segments go out under the runtime's **own**
grant, on a timer with a random phase (never on the request path), a
failed pass backs off with full jitter and the next one retries, and past
the host budget the oldest unsent segments are dropped and counted — one
`dropped` row in the spool, `spool.droppedSegments` on the heartbeat, the
fleet view's "metric batches waiting" — never silently. `ap.status().upload`
says what the uploader is doing; `ap.uploadNow()` runs one pass by hand.
`telemetry.upload: false` (`TelemetryOptions(upload=False)`) leaves the
spool for a daemon or for `airprompter export-telemetry`; the budget still
holds and the loss is still counted. The daemon itself starts its runtime
with the uploader off and runs the host's own, one grant per attached
writer.

Serverless (`on_invoke`) hosts keep no spool: the invocation's rows sit in
a memory buffer and `invoke()` POSTs them as one segment under the
runtime's own grant **before it returns** — a platform that freezes the
process at the response (Lambda) would otherwise lose rows in flight with
no `dropped` row possible. The cost is one POST on the response path,
never more than the buffer (256 KiB by default). `telemetry.flush:
"background"` (`TelemetryOptions(flush="background")`) is the documented
opt-out for hosts that keep running after the response: the flush goes to
the event loop (a thread in Python) and `invoke()` returns at once.

The blast radius of a grant held by an application host is exactly the
daemon's: a presigned S3 POST, ≤ 15 minutes, ≤ 1 MiB per object, bound to
one prefix — `org/{org}/agent/{agent}/{target}/{instance}/` — and to
`application/x-ndjson`. A process that holds one can write NDJSON objects
under its own instance prefix and nothing else: it cannot read, list,
delete, or write another instance's prefix, and the ingest processor
quarantines a row whose `instanceId` is not the prefix's. The grant is
minted by the same heartbeat the runtime already sends; no new secret
reaches the host. Vectors: `sdk-typescript/test/uploadHost.test.ts`,
`sdk-python/tests/test_upload_host.py` (grant present; no grant, budget,
a grant lapsing mid-run; `upload: false`; the awaited flush and the
opt-out).

## The disk budget is an invariant (S6)

What the spool can hold on a host is bounded, and the bound is published:

```
tree ≤ budget + (writers × 1 MiB open) + quarantine cap + exported cap
```

The budget (100 MiB by default) is closed, unsent segments — the only
thing that grows with traffic when the registry is away. Each live writer
holds at most one open segment of at most 1 MiB, and an `.open` file
untouched for an hour is closed by the uploader as abandoned. `quarantine/`
and `exported/` are capped at 10 MiB each, oldest first. Nothing
acknowledged is kept: a segment is deleted on `2xx` (the object key is its
file name, so a lost response replays to the same key). Every runtime
process is its own instance — eight workers are eight writers into one
spool and eight instances in the fleet view, never one — and a run
reference minted by one worker parses in another because the key is the
store's, not the process's.

`airprompter telemetry verify --budget <bytes> --sink-absent` runs the
case on your machine (a filling in-memory filesystem, no registry): two
writers past the budget, a crash mid-open, a live writer, an overfilled
quarantine; it prints the tree before and after, the eviction, the
`dropped` row and the bound, and exits 0 when the invariant holds. The
same cases are the vectors both SDKs run
(`sdk-typescript/test/budgetInvariant.test.ts`,
`sdk-python/tests/test_budget_invariant.py`).

## What a spool row can and cannot tell an observer

It can tell how often a prompt ran, on which model and rollout arm, how
long calls took, how many tokens they used, how often they failed and how,
whether declared checks passed, and which declared feedback signals were
filed. It cannot tell what was asked, what was answered, or who asked —
there is no field, and the schema is enforced twice (on the writer and at
ingest).
