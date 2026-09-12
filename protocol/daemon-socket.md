# Daemon socket — one sync loop per host

`airprompterd` (`airprompter daemon`) runs the sync loop once per host,
holds the store's key, and serves the verified release to every SDK
process on the host over a local socket. SDKs attach when the socket is
there and run in-process when it is not: **the daemon is an optimization,
never a requirement.**

Status: **draft 1** — matches design ruling 3-A (sync in P2, spool upload
in P4). Breaking changes bump `protocol` major.

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
| `healthz` | `ok`, `generation`, `leaseExpired`, `lastSyncAt` | Also served as HTTP: a connection whose first line is `GET /healthz HTTP/1.x` gets a `200 application/json` (or `503` when nothing verified is active) and is closed. |

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
 "rssBytes":58000000}
```

## What an SDK does in `daemon` mode

1. Resolve the socket path from its own `stateDir`, `agentId`, `target`.
2. If it exists and is owned by the current user, connect, `hello`,
   check scope, `slot`, and serve. On `generation` events, `slot` again.
   `unlock()` / `rollback()` / `syncNow()` are forwarded. Telemetry goes
   to the SDK's own spool segments under the same store's
   `spool/telemetry/` (each writer has its own `instanceId`, so names
   never collide); the daemon uploads them (P4).
3. If the socket is absent at start: run in-process (`resident`) from
   the process's own store, and say so in the log (`daemon_absent`).
   If the daemon goes away later (`daemon_lost`): keep serving what is
   held and reconnect on the poll interval — the release in memory is
   the last verified one, and the daemon's store is what it will serve
   again. Nothing the application calls changes.
