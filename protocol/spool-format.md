# Spool format — local telemetry the telemetry daemon picks up

The spool is a directory of append-only files on the host. The SDK writes
to it; **any other instrumentation may write to it too** — an
OpenTelemetry exporter, a wrapper around a provider SDK we do not ship, a
line in your own logger. If a file is in the spool and matches the schema,
`airprompterd` uploads it. That makes the spool the integration point for
the open-source SDKs: their responses carry tokens and timing, and a few
lines of code turn those into a window row here.

Status: **draft 3** — matches design decision D52/D66, S6 (the disk
budget as a published invariant) and, from SDKs 0.3.0, the segment
manifest the telemetry daemon scans for (`daemon.md`). Draft 2 writers —
segments without manifests — stay valid. Breaking changes bump `protocol` major.

## Location and permissions

```
<stateDir>/airprompter/<agentId>/<target>/spool/telemetry/     (or the folder a live daemon.json names)
  seg-<instanceId>-<epochMinute>-<n>.ndjson          open (.open suffix) or closed segment
  seg-<instanceId>-<epochMinute>-<n>.manifest.json   the closed segment's manifest (SDKs 0.3.0+)
  quarantine/                                         segments (with their manifests) that failed the contract (kept 24 h)
```

Where a process writes: its `telemetry.spoolDir` option, else
`AIRPROMPTER_SPOOL_DIR`, else the `spoolDir` a live telemetry daemon
publishes in `daemon.json` for the process's agent and target, else the
default above (`daemon.md` › What an SDK does).

- Directory mode `0700`; files `0600`. The telemetry daemon runs as the same
  user as the SDK processes whose folder it scans, or a group they share.
- `<stateDir>` defaults to the OS state directory (`$XDG_STATE_HOME`,
  `~/Library/Application Support`, `%LOCALAPPDATA%`); containers mount a
  volume there if segments must survive the container.

## Segment files

- **Append-only NDJSON**, UTF-8, one JSON object per line, `\n` terminated.
- A segment is *open* while its writer holds it; writers **close** a segment
  by `fsync` + rename to drop the trailing `.open` suffix
  (`seg-…ndjson.open` → `seg-…ndjson`). The uploader never reads `.open`
  files. A writer that crashes leaves an `.open` file; an `.open` file
  untouched for **one hour** has no writer behind it (a live writer closes
  every minute it has traffic, and its stale minute within one on the
  runtime's spool timer) and the uploader closes it — the partial last
  line is skipped at inspection, the rest uploads and counts against the
  budget like any segment (S6).
- **The manifest.** Right after a segment is closed, a writer that knows
  its scope writes `seg-…manifest.json` beside it (temp file + rename):
  the segment's name, size, SHA-256 and row count, the writer's
  organization, agent and target, and the writer's heartbeat report
  without `spool` (`schemas/spool-manifest.schema.json`). A segment never
  changes once its manifest exists. The daemon uploads only segments whose
  manifest names its own agent and target, and quarantines a segment whose
  size or digest no longer matches. A closed segment with no manifest (a
  third-party writer, a reclaimed `.open`, an SDK before 0.3.0) is uploaded
  under the daemon's own scope once it is a minute old.
- Rotate when the minute changes or the file reaches **1 MiB**.
- Names are unique per `(instanceId, epochMinute, n)`; the object key in S3
  is derived from the file name, which is what makes retries idempotent.
- Disk budget per host: 100 MiB by default. When exceeded, the writer (or
  the uploader, on a shared host) evicts the **oldest unsent** segments and
  writes the count and bytes as a `dropped` row — its own small closed
  segment, at once — so the loss is reported, never silent.
- **The budget is an invariant over the whole tree (S6):**

  ```
  tree ≤ budget + (writers × 1 MiB open) + quarantine cap + exported cap
  ```

  Closed unsent segments are the budget (100 MiB). Each live writer holds
  at most one open segment of at most 1 MiB. `quarantine/` (segments that
  failed the contract) and `exported/` (segments an offline host packed
  into a carrier file) are each capped at **10 MiB**, oldest first, and
  `quarantine/` is also swept after 24 h. Nothing acknowledged is kept:
  a segment is **deleted on `2xx`** — its object key is its file name, so a
  lost response replays to the same key. There is no `sent/`. The
  uploader stamps its last acknowledged upload in `.last-upload` (one
  timestamp) for `airprompter status` on a host without a daemon.
  `airprompter telemetry verify --budget <bytes> --sink-absent` runs this
  case on your own machine, over a filling in-memory filesystem with no
  registry, and prints the eviction, the `dropped` row and the bound.
- **`instanceId` is per process (S6).** Every runtime start mints its own
  id; the store's own id in `store.json` is the store's identity, never a
  writer's. Eight workers on one host are eight instances in the fleet
  view, write eight segment series into one spool, and their same-minute
  windows keep distinct keys at ingest (a shared id would replace one
  worker's window with another's). A run reference parses on any instance
  of the agent and target: see **Run reference** below.
- Serverless hosts keep a **256 KiB** memory buffer instead of a directory
  and flush at invocation end; past the buffer the oldest rows are evicted
  and one `dropped` row (rows counted as `segments`) closes the flush.
- **A writer that cannot write never fails the caller** (S2). A full disk
  (`ENOSPC`), an I/O error, or a file a sibling process took away between a
  listing and a stat is counted by the writer — by filesystem code, on its
  own status — and the rows it could not keep are reported as one `dropped`
  row (rows counted as `segments`) in the first segment it can open
  again. A segment whose fsync failed is left `.open` for the same writer's
  next start to recover; the bytes written before a failed row are kept
  and the partial last line is the daemon's to skip. The proof is the
  fault vector the SDKs run over a filesystem that fills
  (`sdk-typescript/test/spoolFaults.test.ts`, `sdk-python/tests/test_spool_faults.py`).

## Readers

A reader of 3.x ignores what it does not know. An uploader strips unknown fields, nested ones too, and serialises the line again, so no field it cannot vouch for leaves the host. It skips a row of an unknown `type` or `v`, or a `status` outside its row type's list, line by line, and counts those lines in one `dropped` row: `lines` holds the count and `segments` stays 0, because a line is not a segment. The row schemas are a writer's contract: a reader accepts any slug of 32 characters in `errorClass`, `usageSource` and `reason`. A member of the other row form is a crossed row and corrupt: `step` on a window row, or `tokensSq`, `count`, `outcomes` or `checks` on a step row. Only corruption quarantines a segment: a line that is not JSON, a row from another instance, or a known row whose fields do not fit.

A field that changes a row's identity bumps `v`; a measure keeps it.

Writers hold their side and produce only what the validator takes. Counts are non-negative integers, a total that would not be finite is skipped, and an observation whose tag, arm, model, version, status, usage source or error class does not fit is dropped and logged.

## Row types

Every row has `type` and `v` (row schema version). What a reader does with a
field or a row it does not know is under Readers.

### `window` — one minute of one dimension set

`count` means **runs**. A run is one user request to an agent, however many model and tool calls it took. A row has one of two forms, told apart by `count`, and it is never a step:

| Form | Told apart by | `count` | `latencyMs` | Carries |
| -- | -- | -- | -- | -- |
| Run row | `count` above 0 | runs | run wall-clock; bucket total equals `count` | tokens totals for the run, `modelCalls`, `agentRun`, `tools`, `tokensSq`, `outcomes[*].sumSq`, `checks` |
| Feedback-only row | `count: 0` with `outcomeRunMinute` | 0 | all zero | outcomes only; every measure zero; no `tokensSq` |

```json
{"type":"window","v":4,"artifactId":"prm_8b2f…",
 "minute":"2026-09-11T14:03:00Z",
 "instanceId":"i-7f3a…","instanceClass":"resident",
 "tag":"support.triage","versionId":"pv_…","arm":"candidate",
 "model":"claude-haiku-4-5","status":"ok","errorClass":null,
 "usageSource":"reported",
 "count":412,"modelCalls":1236,"agentRun":412,
 "tools":{"calls":188,"errors":3},
 "latencyMs":{"buckets":[0,0,3,41,188,150,27,3,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],"sum":617384},
 "tokens":{"input":493200,"cachedInput":329600,"output":103000},
 "tokensSq":{"input":6100000,"cachedInput":2700000,"output":270000,"inputOutput":1270000,"inputCached":3900000,"cachedOutput":870000},
 "checks":{"passed":405,"failed":7},
 "outcomes":{"accepted":{"n":388,"sum":362,"sumSq":362},"rating":{"n":41,"sum":171,"sumSq":761}},
 "sdk":"agent-sdk-ts/1.0.0"}
```

- `latencyMs.buckets` are counts against the **fixed edges** in
  `schemas/latency-buckets.json` (23 edges, 1 ms → one hour) so
  percentiles merge across instances: a value lands in the first bucket
  whose edge is `>=` it; anything above the last edge lands in the last
  bucket. `latencyMs.sum` is the total of the observed values, each
  rounded half up and floored at 0.
- `tag` is always the slot tag. A run adds to the open window for its key
  and lands in the minute it ended; `count: 1` is what one run adds, and rows
  with one key sum.
- `agentRun` counts this row's runs that are the first slot of their run. A
  two-slot run writes two run rows, each `count: 1`, and `agentRun: 1` on the
  first only, so an agent-wide total counts it once. A one-call run has 1.
- `tools` holds tool calls and how many failed. No tool name ever travels.
- `tokensSq` holds the second moments of each run's token totals, summed over
  runs: `input`, `cachedInput` and `output` squared, and the products
  `inputOutput`, `inputCached` and `cachedOutput`, where `inputOutput` is
  Σ inᵢ·outᵢ over runs `i`, never over model calls. With these a consumer
  computes the variance of any weighted token total, including the covariance
  terms. Each entry of `outcomes` carries `sumSq` beside `n` and `sum`, so the
  variance of an outcome is sumSq/n − (sum/n)².
- `status` is `ok`, `error`, `refused` or `interrupted`. `interrupted` counts
  as a run, not as an error.
- `recordRun` is the only thing that raises `count`. Feedback (`outcomes`)
  and checks filed against a run ride on that run's `status: ok` window when
  filed in the run minute and **never** add to `count` or `latencyMs`. The
  writer omits `outcomeRunMinute` when it equals the row's `minute`, so
  feedback filed before the run still merges with it. Delayed feedback keeps
  the original `outcomeRunMinute` and can therefore produce a `count: 0` row
  in its later filing minute. Writers must not create a feedback-only row
  without that authenticated run minute; without it, feedback may attach only
  to an already measured matching run in the writer's open minute. Writers
  refuse malformed calendar minutes and audience identifiers outside the
  opaque `aud_…` grammar before creating a row. Measurements use the minute in
  which they complete; `runMinute` on an SDK observation is attribution for
  feedback and never reopens a sealed measurement minute under the same
  ingest key.
- `artifactId` keeps two prompts that use the same per-prompt `versionId` in
  separate series and uses the manifest's canonical ASCII identifier grammar
  (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`). These identifiers are control-plane
  identities; local tag values and user or device identifiers never enter
  a row.
- `errorClass` is the closed enum in `schemas/telemetry-window.schema.json`:
  `render_missing_variable, context_length_exceeded, output_schema_invalid,
  truncated, content_filter, provider_error, provider_timeout,
  provider_rate_limited, model_unresolved`. `model_unresolved` marks a release
  whose model cannot run on this host. Nothing after the model returns is an
  error class.
- `outcomes` carries only declared signal names from the feedback catalogue
  (`schemas/feedback-signals.schema.json`), each as `{n, sum, sumSq}`.
- Rows for the same key `(instanceId, minute, tag, artifactId, versionId,
  arm, model, status, errorClass, audienceIds, outcomeRunMinute)`
  **replace** each other at ingest (SET semantics), so
  a replayed segment is a no-op.

### `step` — one step of a run in one minute

A step is its own row type, never a window row with `count: 0`, so no fold over windows can count one.

```json
{"type":"step","v":1,"artifactId":"prm_8b2f…",
 "minute":"2026-09-11T14:03:00Z",
 "instanceId":"i-7f3a…","instanceClass":"resident",
 "tag":"docs.flow","versionId":"pv_…","arm":"none","model":"gpt-5",
 "step":"docs.flow#2","status":"ok","errorClass":null,
 "usageSource":"reported","modelCalls":2,
 "latencyMs":{"buckets":[0,0,0,0,0,0,0,0,0,2,0,0,0,0,0,0,0,0,0,0,0,0,0],"sum":812},
 "tokens":{"input":300,"output":70},
 "tools":{"calls":1,"errors":0},
 "sdk":"agent-sdk-ts/1.0.0"}
```

- `step` is an opaque string, `^[^\u0000-\u001f\u007f]{1,64}$`: a
  `<slotTag>#<ordinal>` step id, or a framework node or agent name. No framework
  concept reaches the wire. `STEP_BOUNDS` are the only two caps, 64 characters
  and 32 names per run; a name past either is written as `other`. A run session
  applies them per run, and the writer holds them per run dimensions within the
  open minute.
- `latencyMs` holds each model call's latency, so its bucket total equals
  `modelCalls`. `status` is `ok` or `error`.
- There is no `count`, no moments, no outcomes and no checks. OpenTelemetry
  exports skip step rows.
- The open key is the run dimensions plus `step`, `status` and `errorClass`.

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
error messages. The schema has no field for them, and a reader strips an
unknown field before it leaves the host. Writers that need to
correlate to their own traces use the `runRef` on their side — it never
enters a window.

## Upload (for reference; implemented by the telemetry daemon)

S5: on a host that runs no daemon, the runtime implements the same upload itself (`docs/telemetry.md` › Telemetry without a daemon). A runtime whose folder a live daemon scans leaves the upload to it (`daemon.md`).

Heartbeat with the Agent key returns a presigned S3 POST grant (≤ 15 min,
prefix `org/{org}/agent/{agent}/{target}/{instance}/`, ≤ 1 MiB, NDJSON,
SSE-KMS, grant id) plus `uploadIntervalSeconds`. Closed segments are POSTed
to S3 under the grant with exponential backoff and full jitter (1 s → 5 min),
one in flight per host; acknowledged segments are deleted (S6). A refused
grant is the throttle. Nothing AirPrompter runs is in the write path.

A grant is per **instance prefix**, and the ingest processor quarantines a
row whose `instanceId` is not the prefix's. A daemon uploading for several
writers therefore holds one grant per writer, obtained by a heartbeat that
names that writer's `instanceId` — the writer's own report from its newest
manifest, with the daemon's `spool` block (`daemon.md` › What the daemon does);
a third-party writer's segment goes under the writer's own prefix, named
by the segment file. Before any bytes leave the host every line is
checked against `spool-rows.schema.json` and against the file name's
`instanceId`; a segment that fails moves to `quarantine/` whole.

Serverless runtimes (no daemon, memory buffer) POST their own rows at
invocation end as one segment under their own grant; rows that cannot go
(a hold, a refused POST) stay buffered for the next invocation.

## The spool over a file (T16)

A host that never calls home carries its telemetry out as one document,
`airprompter export-telemetry`'s output (`.aptelemetry` by convention):

```json
{
  "kind": "airprompter-telemetry-export", "v": 1, "protocol": "0.2.5",
  "organizationId": "org_…", "agentId": "agt_…", "target": "prod",
  "exportedAt": "2026-09-12T14:08:10.000Z", "generation": 12, "cli": "0.1.0",
  "segments": [
    { "name": "seg-i-offlineAAAAAAA-29817383-0.ndjson", "instanceId": "i-offlineAAAAAAA", "bytes": "<base64url of the segment, verbatim>" }
  ]
}
```

Only closed segments with at least one valid row travel; the bytes are
the segment file's own, so the ingest processor sees exactly what the
daemon would have posted. `import-telemetry` on a connected host
heartbeats once per `instanceId` the file names (as that instance,
`syncMode: "offline"`, `generation.active` = the exported generation,
`spool.depthSegments` = that instance's segments in the file), takes the
grant to that instance's prefix and PUTs each segment under its own name.
S3 PUT is idempotent by key, so importing a file twice leaves the same
objects. The exporting host moves packed segments to
`spool/telemetry/exported/` (swept a week after export); a hold on import is
reported with the platform's `retryAfterSeconds` and nothing is uploaded.

## Writing to the spool without our SDK

1. After each model call, take `usage` and elapsed time from the provider
   response.
2. Accumulate into the open minute's `window` row for
   `(tag, artifactId, versionId, arm, model, status, errorClass,
   audienceIds, outcomeRunMinute)` — the `tag`, `artifactId`, `versionId`
   and `arm` come from the release you rendered (or from the authenticated
   `runRef` the compatible endpoint returned).
3. At minute end write the row to the open segment, `fsync`, close per the
   rules above.

`vectors/spool.json` pins the bucket index, minute formatting, segment
naming, rotation and window aggregation; `vectors/feedback.json` pins the
feedback catalogue. A writer that passes both interoperates with the
daemon. The TypeScript SDK's `src/spool/writer.ts` is the reference
implementation; `conformance/spool.mjs` is the independent one CI runs;
`examples/spool-writer/` carries a dependency-free writer in TypeScript
and in Python (~100 lines each, the filesystem rules included) that the
conformance runner drives through the same vectors — start from one of
those.

## Run reference

`runRef` is a compact, content-free token a customer keeps beside their own trace to attach feedback later.

- **Body:** `JSON.stringify([agentId, target, runId, entries])`, UTF-8. **Token:** `base64url(body).mac`, where `mac` is the first 22 characters of the base64url HMAC-SHA256 of the body.
- **Entries:** one per slot the run used, so a one-slot run is a list of one. Each holds `tag`, `artifactId`, `versionId`, `model`, `arm`, `bucket` (null with no experiment), `runMinute` and optional `audienceIds`. Tags are unique. `feedback` reads only the token, because the release may have moved by then.
- **`runId`:** 22 base64url characters from 16 random bytes. It is fixed: a token that grows cannot be the run's identity.
- **Bounds:** minting stops at 8 entries and 12,288 characters (eight worst-case entries are about 9,700). Reading accepts 32 entries and 40,960 characters, so a later minor can raise minting. A token above the minting bounds can be read but not re-minted.
- **Readers are tolerant.** A body element past the fourth lands in `extra`, unknown keys on an entry stay on the entry, and both survive a re-mint, so a host can grow a ref a later SDK wrote.
- A ref with no entries parses, and `feedback` on it returns `false`.
- A hosted run's ref is a different token, for one hosted run of one slot, and is never parsed by the SDK.

**Key.** `runRefKeyFrom(secret, agentId, target)` is HMAC-SHA256(`secret`, `"airprompter runRef v1\0" + agentId + "\0" + target`). The secret is `runRefSecret`, else the Agent key, so instances of one agent and target share it with no new setting, and a ref minted on one pod parses on another.

A host with neither (offline, or a datastore runtime holding only a distribution key) falls back to its store's id. That key works on that one store only, and the SDK logs `run_ref_key_store_scoped` once. Setting `runRefSecret` fixes it.

**Rotation.** `runRefPreviousSecrets` lists older secrets. Minting uses the current key; parsing tries the current one, then each previous one, so feedback on a ref minted before a rotation still lands.

## Run counters

A run that passes through serves the agent's own prompt and writes no row, because there is no version to attribute. The heartbeat carries it instead: `runCounters.passthrough` is an open map of cumulative counts since the process started, so a retried heartbeat cannot double count. Keys match `^[a-z][a-z0-9_]{0,63}$`: `no_verified_release`, `awaiting_unlock`, `slot_disabled`, `no_slot`, `slot_kind_unsupported`, `model_unresolved`, `variables_unfilled`, `unmapped_step` and `slot_not_in_release`. New reasons need no schema change.
