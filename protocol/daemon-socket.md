# Daemon socket — one sync loop per host

`airprompterd` (`airprompter daemon`) runs the sync loop once per host,
holds the store's key, and serves the verified release to every SDK
process on the host over a local socket. SDKs attach when the socket is
there and run in-process when it is not: **the daemon is an optimization,
never a requirement.**

Status: **draft 2** — matches design ruling 3-A (sync in P2, spool upload
in P4; both shipped). Breaking changes bump `protocol` major.

## Where the socket is

```
<stateDir>/airprompter/<agentId>/<target>/daemon.sock      Unix domain socket, mode 0600, directory 0700
<runtimeDir>/airprompter-<sha256(storeDir) first 16 hex>.sock   when the path above exceeds 100 bytes (Unix socket paths are capped at 104/108): $XDG_RUNTIME_DIR, else $TMPDIR, else the OS temp dir
\\.\pipe\airprompter-<sha256(storeDir) first 16 hex>        Windows named pipe
```

The socket lives inside the store directory the daemon owns. Only the
daemon's user can connect (the directory is `0700`, the socket `0600`);
an SDK refuses a socket owned by another user. A daemon that cannot
obtain the store's key **does not listen** — there is nothing it could
serve that a runtime should trust.

## Framing

Newline-delimited JSON, UTF-8, one object per line, both directions.
Requests carry `id` (any string unique to the connection) and `op`;
responses echo `id` with `ok: true` and the result fields, or `ok: false`
and `error`. The daemon may also send **events** (no `id`) at any time.

```
→ {"id":"1","op":"hello","sdk":"agent-sdk-ts/0.1.0"}
← {"id":"1","ok":true,"daemon":"airprompter-cli/0.1.0","protocol":"0.2.5","agentId":"agt_…","target":"prod","instanceId":"i-…","generation":41,"stagedGeneration":null}
→ {"id":"2","op":"slot"}
← {"id":"2","ok":true,"slot":"A","generation":41,"signingKeyId":"…","manifest":{…},"payloads":[{"contentHash":"sha256:…","bytes":"<base64url>"}]}
← {"event":"generation","generation":42,"stagedGeneration":null}
```

A line longer than 16 MiB, or one that is not a JSON object, closes the
connection.

## Operations

| `op` | Result | Notes |
|---|---|---|
| `hello` | `daemon`, `protocol`, `agentId`, `target`, `instanceId`, `generation`, `stagedGeneration` | First message on a connection; the SDK checks `agentId`/`target` match what it was started with. |
| `slot` | `slot`, `generation`, `signingKeyId`, `manifest`, `payloads[]` | The active, verified release: the manifest envelope and every referenced payload's bytes. Plaintext over the local socket — that is what the store's key protects at rest and the socket's mode protects in transit. |
| `status` | the daemon's status (see below) | |
| `sync` | `outcome` | Run one sync pass now. |
| `unlock` | `generation` or `null` | Activate the staged release for the whole host. |
| `rollback` | `generation`, `forced` | Local rollback to the other slot for the whole host. |
| `healthz` | `ok`, `generation`, `leaseExpired`, `lastSyncAt`, `spoolDepth`, `lastUploadAt`, `backoffUntil` | Also served as HTTP: a connection whose first line is `GET /healthz HTTP/1.x` gets a `200 application/json` (or `503` when nothing verified is active) and is closed. |
| `upload` | `uploaded`, `quarantined`, `dropped`, `held` + the `upload` block below | Run one uploader pass now (an operator's nudge; the cadence is the grant's). `offline` when the daemon has no key. |

Anything else answers `{"ok":false,"error":"unknown_op"}`.

## Events

| `event` | Fields | When |
|---|---|---|
| `generation` | `generation`, `stagedGeneration` | The active or staged generation changed (sync, unlock, rollback). SDKs fetch `slot` again. |
| `shutdown` | — | The daemon is stopping; SDKs keep serving what they hold and reconnect when it is back. |

## Status document

`status` and `airprompter status` (which asks the daemon when the
socket is present) report:

```json
{"daemon":"airprompter-cli/0.1.0","pid":4242,"startedAt":"…","uptimeSeconds":1234,
 "instanceId":"i-…","generation":41,"stagedGeneration":null,"applyState":"active",
 "lastRefusal":null,"storageProtection":"file_key","signingKeyId":"…",
 "leaseExpiresAt":"…","leaseExpired":false,"lastContactAt":"…","lastSyncAt":"…","lastSyncOutcome":"unchanged",
 "consecutiveFailures":0,"nextSyncAt":"…","clients":2,
 "spool":{"depthSegments":3,"depthBytes":18234},
 "upload":{"lastUploadAt":"…","lastError":null,"backoffUntil":null,"attempt":0,"inFlight":false,
           "intervalSeconds":300,"nextPassAt":"…","sentSegments":41,"quarantinedSegments":1,"droppedSegments":0,
           "grants":[{"instanceId":"i-…","expiresAt":"…"}],"depth":{"segments":3,"bytes":18234}},
 "rssBytes":58000000}
```

`upload` is `null` when the daemon runs without an Agent key (offline:
the spool stays on disk as the export).

## The uploader (P4)

The daemon uploads **every** closed segment in `spool/telemetry/`, from
its own writer, from the SDK processes attached to it, and from any third
party that writes the spool contract (`spool-format.md`):

1. Sweep `sent/` and `quarantine/` past 24 h; enforce the host budget
   across all writers (oldest unsent segments first; the loss is one
   `dropped` row under the daemon's own `instanceId`, written as its own
   segment and uploaded like any other).
2. For each closed segment, oldest first: every line must be a
   `spool-rows` row and its `instanceId` must be the one in the file
   name (the prefix the object will land under is authoritative at
   ingest, so the daemon refuses on the host what the processor would
   quarantine in the bucket). A segment with any bad line moves to
   `quarantine/` whole and is never uploaded; a partial last line (a
   crashed writer) is skipped, not sent. The log names the line and the
   field, never the value.
3. **One grant per writer.** A grant covers one instance prefix. The
   daemon obtains a grant for a writer by sending a heartbeat that names
   that writer's `instanceId` (`sdk.name: airprompterd`, the host's
   spool state, the daemon's own generation and apply state), and holds
   it until a minute before `expiresAt`. A writer that has nothing to
   upload gets no heartbeat, so a process that exited stops being
   reported once its last segment is gone.
4. POST the segment as the presigned form (`fields` verbatim, then
   `key = keyPrefix + segment name`, `Content-Type`, `file`). `2xx` →
   `sent/`. A `403` naming an expired policy → one fresh grant, one
   retry. A hold (`retryAfterSeconds`, no grant) → wait exactly that
   long. Anything else → exponential backoff with full jitter, 1 s base,
   5 min cap, one segment in flight per host, then stop the pass.
5. Passes run every `uploadIntervalSeconds` from the last grant (default
   300), with a random phase offset per host, or when `upload` is asked.

Every heartbeat the daemon sends carries `spool.droppedSegments`,
`spool.quarantinedSegments`, `spool.lastUploadAt` and
`spool.backoffUntil`, so the fleet view shows a host that is silently
failing to upload.

## What an SDK does in `daemon` mode

1. Resolve the socket path from its own `stateDir`, `agentId`, `target`.
2. If it exists and is owned by the current user, connect, `hello`,
   check scope, `slot`, and serve. On `generation` events, `slot` again.
   `unlock()` / `rollback()` / `syncNow()` are forwarded. Telemetry goes
   to the SDK's own spool segments under the same store's
   `spool/telemetry/` (each writer has its own `instanceId`, so names
   never collide); the daemon uploads them under a grant it obtains for
   that writer (above). An attached process sends no heartbeat of its
   own: the daemon reports for it.
3. If the socket is absent at start: run in-process (`resident`) from
   the process's own store, and say so in the log (`daemon_absent`).
   If the daemon goes away later (`daemon_lost`): keep serving what is
   held and reconnect on the poll interval — the release in memory is
   the last verified one, and the daemon's store is what it will serve
   again. Nothing the application calls changes.
