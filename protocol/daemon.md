# The telemetry daemon — a folder, a discovery file, a manifest per segment

`airprompterd` (`airprompter daemon`) has one job: ship the telemetry that
SDK processes on its host write, to AirPrompter (or to your OpenTelemetry
collector). It **does not** sync releases, hold the store's key, verify
manifests, or serve anything to an SDK. Every SDK process loads its release
itself — from its own store, the customer's datastore (`../docs/datastore.md`),
a vendored bundle, or its own sync — so a release path never runs through
the daemon, and a datastore-hydrated process in any region is exactly what
it looks like.

Status: **draft 3** (SDKs 0.3.0). Draft 2's socket — `hello`, `slot`,
`sync`, `unlock`, `rollback`, `policy`, `healthz`, `upload` — and the SDK's
`sync: { mode: "daemon" }` are **removed**: an SDK started with it refuses
(`AgentStartError("invalid_options")`). The daemon is an optimisation for
telemetry, never a requirement: a host without one uploads its own spool
when it holds an Agent key (S5), or keeps it on disk for
`airprompter export-telemetry`.

There is **one daemon per agent and target** — it holds that pair's Agent
key, and uploads only what that pair's processes wrote.

```
SDK process ──writes──▶ <spoolDir>/seg-<instanceId>-<minute>-<n>.ndjson      (closed segment)
            ──then───▶ <spoolDir>/seg-<instanceId>-<minute>-<n>.manifest.json (its manifest)
                                   ▲ scans *.manifest.json
airprompterd ──publishes──▶ <storeDir>/daemon.json ──names──▶ spoolDir
             ──heartbeat per writer (report from the manifest) → grant ──PUT segment──▶ AirPrompter
```

## The discovery file — `daemon.json`

The daemon publishes where it scans in one file per agent and target, at
the store directory every SDK process computes from the same inputs:

```
<stateDir>/airprompter/<agentId>/<target>/daemon.json
```

```json
{"format":1,"kind":"daemon","daemon":{"name":"airprompterd","version":"0.3.0"},"pid":4242,
 "organizationId":"org_…","agentId":"agt_…","target":"prod",
 "spoolDir":"/var/lib/airprompter/airprompter/agt_…/prod/spool/telemetry",
 "startedAt":"…","heartbeatAt":"…","uploadIntervalSeconds":300,"sink":"airprompter",
 "upload":{"lastUploadAt":"…","backoffUntil":null,"sentSegments":41,"quarantinedSegments":0,"droppedSegments":0,"depthSegments":3,"depthBytes":18234}}
```

- Written with a temp file and a rename (a reader never sees half of it),
  mode `0600`, and refreshed at least every **60 s** (`heartbeatAt`) and
  after every upload pass (`upload`).
- **Live** means `heartbeatAt` is within **10 minutes** of the reader's clock
  and the scope (`agentId`, `target`, and `organizationId` when the reader
  knows it) is the reader's. A file that is stale, for another scope, of
  another `format`, or unreadable is ignored — never trusted in part.
- On a clean stop the daemon deletes it. A crashed daemon leaves it; it
  goes stale in 10 minutes and SDKs fall back (below).
- `spoolDir` is absolute. By default it is `<storeDir>/spool/telemetry` —
  the folder SDKs have always written; `--spool-dir` moves it (a shared
  volume in a container, a disk with more room).

Schema: `schemas/daemon.schema.json`; example `examples/daemon.json`.

## What an SDK does

At start, and again once a minute off the request path:

1. **Where to write.** `telemetry.spoolDir` (option) → `AIRPROMPTER_SPOOL_DIR`
   (environment) → a live `daemon.json`'s `spoolDir` → `<storeDir>/spool/telemetry`.
   The first that is set wins; an explicit one never moves because a
   daemon appeared.
2. **Who uploads.** When a live `daemon.json` names the folder this process
   writes (the same path after resolving symlinks) and its `sink` is not
   `none` (a daemon with no key and no collector ships nothing), the daemon does: the
   process runs no uploader of its own and sends no heartbeat for telemetry
   grants. Otherwise the process uploads its own folder under its own grant
   (S5) when it holds an Agent key, or ships to its own `uploadSink`, or
   leaves the segments on disk. The switch goes both ways within a minute:
   a daemon that starts takes over; one that stops (its file goes stale or
   disappears) hands back to a process that can upload, and `healthz`
   reports `upload_daemon_stale` for one that cannot.
3. **What it writes.** Segments exactly as `spool-format.md` says — and,
   right after a segment is closed (fsynced and renamed from `.open`), its
   **manifest**.

Serverless processes (`on_invoke`, the memory sink) never write a folder;
they flush under their own grant at invocation end as before.

## The segment manifest

```
<spoolDir>/seg-<instanceId>-<epochMinute>-<n>.manifest.json
```

```json
{"format":1,"kind":"segment","segment":"seg-i-7f3a…-29817383-0.ndjson",
 "bytes":18234,"sha256":"sha256:…","rows":12,
 "instanceId":"i-7f3a…","organizationId":"org_…","agentId":"agt_…","target":"prod",
 "closedAt":"2026-09-12T14:04:10.000Z",
 "report":{ …the writer's heartbeat request, without `spool`… }}
```

- Written **after** its segment is closed, with a temp file and a rename:
  a manifest never names a segment that is not complete. The segment is
  never modified after its manifest exists.
- `bytes` and `sha256` are the closed segment file's; `rows` its line count.
- `report` is the writer's own heartbeat request (`schemas/heartbeat.schema.json`
  › `request`) as it stood when the segment closed, **without `spool`**: its
  protocol, SDK, sync mode, generation, apply state, storage protection,
  catalog (model and variable names), lease, apply policy. Content-free by
  the heartbeat's own schema — no prompt text, no values, no end-user
  identifier. The daemon adds `spool` (its view of the host) and sends it
  to obtain that writer's grant, so a process that never talks to
  AirPrompter — a runtime hydrated from the customer's datastore with no
  Agent key — still appears in the fleet view as what it is.
- `instanceId` matches the segment's name; `organizationId`, `agentId`,
  `target` are the writer's scope.

Schema: `schemas/spool-manifest.schema.json`; example `examples/spool-manifest.json`.

## What the daemon does

Every `uploadIntervalSeconds` (the grant's cadence; 300 s until one says
otherwise, with a random phase per host):

1. **Housekeeping** as `spool-format.md` says (quarantine and export caps,
   the host budget, an `.open` segment untouched for an hour closed), plus:
   a manifest whose segment is gone is deleted once it is a minute old;
   an evicted segment takes its manifest with it.
2. **Scan for manifests**, oldest first. For each:
   - **Not ours** — `agentId` or `target` differs from the daemon's → left
     alone for that pair's daemon (never uploaded, never deleted).
   - **Does not match** — the segment is missing, or its size or SHA-256
     differs, or the manifest does not parse, or `instanceId` differs from
     the segment's name → the segment and its manifest move to
     `quarantine/` together.
   - **Ours** → the segment is checked line by line as before (every line a
     `spool-rows` row naming the file's `instanceId`), then uploaded under
     that writer's grant. The grant comes from a heartbeat that is the
     newest manifest `report` for that writer, with `instanceId` and the
     daemon's `spool` block set. `2xx` → the segment is deleted, then its
     manifest.
3. **A closed segment with no manifest** — a third-party writer that
   follows the spool contract without manifests (`examples/spool-writer`),
   a segment reclaimed from a crashed writer, or an SDK before 0.3.0 — is
   uploaded once it is a minute old (the grace a writer has to add its
   manifest), attributed to the daemon's own agent and target, under a
   minimal report (`syncMode: offline`, generation 0, `applyState: active`,
   storage protection `custom`, no models).
4. Refresh `daemon.json`.

Grants, holds, backoff, one segment in flight per host and the
per-writer `dropped` / `quarantinedSegments` / `lastUploadAt` reporting are
unchanged from draft 2 (`spool-format.md` › Upload).

## Operating it

- `airprompter status` reads `daemon.json` (live or stale, pid, version,
  the `upload` block) — and exits non-zero when it is stale, which is what
  the deploy manifests use as a liveness probe.
- `airprompter doctor` checks that the file is live, that its scope is the
  one asked about, and that `spoolDir` is writable.
- `unlock`, `rollback` and `policy` act on the host's store directly — the
  daemon holds no store. A process started from then on serves the change;
  a process already running keeps what it loaded, and is moved by its own
  `ap.unlock()` / `ap.rollback()` / `ap.setApplyPolicy()`, the update
  window, the `onStaged` hook, or — across a fleet — the customer's
  datastore (`../docs/datastore.md`: a rollback there moves every runtime
  on its next `hydrate()`).
- The daemon needs the Agent key only for grants; with
  `--upload-sink otlp` it needs no key at all.

## Vectors

The conformance run validates `examples/daemon.json` and
`examples/spool-manifest.json` against their schemas and refuses the
`refused/daemon.*` and `refused/spool-manifest.*` examples. The SDK suites
(`sdk-typescript/test/telemetryDaemon.test.ts`,
`sdk-python/tests/test_telemetry_daemon.py`) and the CLI's
(`cli/test/daemon.test.ts`) exercise discovery, manifests, the hand-over in
both directions and the daemon's rules end to end.
