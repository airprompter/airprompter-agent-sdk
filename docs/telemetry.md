# Telemetry: the spool contract and the OpenTelemetry mapping

The runtime never sends a prompt, an answer or an end-user identifier
anywhere. What leaves the host is one row per minute per dimension set —
counts, token totals, a 16-bucket latency histogram, error classes, output
check counts and declared feedback outcomes — written to a local spool and
uploaded under a short-lived grant to your organization's own prefix.
The spool is a **public contract** (design D66): any process, in any
language, can write to it and be picked up by the daemon.

## The contract, in one table

| Concern | The rule | Where it is pinned |
|---|---|---|
| Location | `<state-dir>/<agentId>/<target>/spool/telemetry/`, 0700; segments 0600 | [`protocol/spool-format.md` › Location and permissions](../protocol/spool-format.md#location-and-permissions) |
| Segments | `seg-<instanceId>-<epochMinute>-<n>.ndjson`, `.open` until fsync + rename; rotate at the minute, at 1 MiB, or on an oversize line | [Segment files](../protocol/spool-format.md#segment-files); `vectors/spool.json` rotation cases |
| Rows | `window` (one minute of one dimension set), `refusal` (a control-plane refusal), `dropped` (segments evicted by the disk budget) — each validated against `spool-rows.schema.json` | [Row types](../protocol/spool-format.md#row-types) |
| Latency | 16 fixed bucket edges every writer uses | `schemas/latency-buckets.json`; `vectors/spool.json` 32 values |
| Feedback | `outcomes[signal] = {n, sum}` from the declared catalogue only; `goldenPass` is the runtime's own | `schemas/feedback-signals.schema.json`; `vectors/feedback.json` |
| Never in the spool | prompt text, model output, end-user identifiers, stack traces, application error messages — no field exists for them; unknown fields are dropped and unknown rows quarantined at ingest | [What must never be in the spool](../protocol/spool-format.md#what-must-never-be-in-the-spool) |
| Upload | heartbeat → presigned S3 POST grant (≤ 15 min, ≤ 1 MiB, the instance's own prefix); backoff with full jitter; acknowledged segments to `sent/`; a refused grant is the throttle | [Upload](../protocol/spool-format.md#upload-for-reference-implemented-by-the-daemon); `sdk-typescript/test/uploader.test.ts` |
| Offline | `airprompter export-telemetry` / `import-telemetry` carry the spool as one file, idempotent by key | [The spool over a file](../protocol/spool-format.md#the-spool-over-a-file-t16) |
| Third-party writers | `examples/spool-writer/` (TypeScript and Python, dependency-free) pass the same vectors | [Writing to the spool without our SDK](../protocol/spool-format.md#writing-to-the-spool-without-our-sdk) |

## Field → OpenTelemetry GenAI

Window fields follow the OpenTelemetry GenAI semantic conventions where one
exists, so an OTLP exporter is a renaming, not a redesign. This is the
mapping the protocol pins; it is repeated here so a platform team can read
it without the format:

| Window field | OTel GenAI attribute / metric | Note |
|---|---|---|
| `model` | `gen_ai.request.model` | as the provider names it |
| `tokens.input` | `gen_ai.usage.input_tokens` | uncached; OpenAI's `cached_tokens` are split out |
| `tokens.cachedInput` | `gen_ai.usage.cache_read.input_tokens` | proposed convention |
| `tokens.output` | `gen_ai.usage.output_tokens` | |
| `latencyMs` (buckets + sum) | `gen_ai.client.operation.duration` | histogram; OTel's unit is seconds, the spool's is milliseconds |
| `errorClass` | `error.type` | one of the fixed error classes |
| `status` | derived: `error.type` present | |
| `count` | the histogram's count | a window with no runs (feedback-only, a golden run) has `count: 0` |
| `checks.passed` / `checks.failed` | custom counters `airprompter.checks.passed` / `.failed` | declared output checks (`checks.md`) |
| `outcomes.<signal>.{n,sum}` | custom `airprompter.feedback.<signal>` (n, sum) | the declared catalogue; `goldenPass` from a golden-set run |
| `tag`, `versionId`, `arm` | `airprompter.prompt.tag`, `.version`, `.arm` | custom attributes; the arm is `none` outside a rollout |
| `sdk` | `telemetry.sdk.name` / `telemetry.sdk.version` | a **dimension at ingest**, so a misreporting writer is isolated |
| `instanceId`, `instanceClass` | `service.instance.id`; `airprompter.instance.class` | random, persisted; `resident` or `ephemeral` |

A `runRef` (the content-free receipt `render()` returns) is what your
own traces correlate on; it never enters a window.

## What a spool row can and cannot tell an observer

It can tell how often a prompt ran, on which model and rollout arm, how
long calls took, how many tokens they used, how often they failed and how,
whether declared checks passed, and which declared feedback signals were
filed. It cannot tell what was asked, what was answered, or who asked —
there is no field, and the schema is enforced twice (on the writer and at
ingest).
