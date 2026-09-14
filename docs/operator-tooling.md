# Operator tooling: doctor, healthz, validate, the verify action, the conformance harness

Five tools for the people who run hosts and pipelines rather than write
agents (S14). Each one has a vector; each rule below names it.

## `airprompter doctor` — every reason a host is not serving, with the remedy

```sh
AIRPROMPTER_AGENT_KEY=… airprompter doctor --org org_… --agent agt_… --environment prod \
  --root ./root.jwk.json [--state-dir …] [--base-url …] [--edge-pointer-url …] [--spool-budget-bytes …] [--json]
```

Nine checks, each `ok`, `warn`, `fail` or `skip`, printed with what to do
next; `--json` gives the same as `{ ok, checks: [{ name, level, detail,
remedy? }] }`.

| Check | Fails when | Warns when |
|---|---|---|
| `source` | the API refuses the key (401), the key is for another agent or environment (403 with the mismatch named), the API is unreachable or unhealthy | no release is promoted yet (404) |
| `edge_pointer` (with `--edge-pointer-url`) | — | the pointer is unreachable or stale (the runtime falls back to the manifest route) |
| `root` (with `--root`) | the file is missing, is neither a pinned JWK nor a root document, or is a root document that has lapsed | — |
| `store` | no store on this host, the store key cannot be obtained, `store.json` is unreadable | — |
| `active_release` | no active release; the active slot does not re-verify as the runtime would on start (the reason is named) | — |
| `lease` | — | the lease lapsed from issue and no runtime or daemon is in contact (`degrade` or `halt` named) |
| `key_protection` | — | `file_key` (the store key is a file next to the store) |
| `policy_pin` | — | no apply policy pinned yet |
| `spool` / `quarantine` / `last_upload` | — | closed segments at ≥ 80 % of the budget, or at the budget (eviction); quarantined segments present; the last upload over a day old with segments waiting |
| `daemon` | the socket exists but is not ours or does not answer (a stale socket); the daemon's healthz is failing | the daemon's healthz is degraded |

Rules: doctor **reads only** — it never creates a store, writes a file or
sends a heartbeat (the source check is a manifest GET). A key comes from
the environment (`--api-key-env`, default `AIRPROMPTER_AGENT_KEY`), never
argv; with no key the source is skipped, not failed (an offline host).
Exit `0` when no check fails — warnings print but do not fail — and `1`
otherwise. Nothing printed is prompt text. Vector:
`cli/test/doctor.test.ts`.

## In-process `healthz` — the probe answer, in the SDK

Today only the daemon answered `GET /healthz`. Now every runtime does:

```ts
// TypeScript: any framework
app.get("/healthz", ap.healthzHandler());          // Node http-shaped (req, res)
const { status, headers, body } = healthzResponse(ap.healthz());  // or build your own
```

```python
# Python: any framework
code, headers, body = ap.healthz_response()          # 200 / 503, {"content-type": …}, JSON
doc = ap.healthz()                                   # the document
```

The document is the same everywhere — the SDKs, the daemon's `/healthz`
and its `healthz` op — with `ok` as the liveness answer and `status` as
the one degraded middle:

- **failing** (`ok: false`, 503): nothing verified to serve (generation 0);
  the lease lapsed under `onLeaseExpiry: "halt"` (every render refuses).
- **degraded** (`ok: true`, 200): the lease lapsed under `degrade` (serving
  the last verified release); three or more consecutive sync failures; the
  uploader is backing off; a forced downgrade is in force; the daemon this
  process attached to is gone (serving what it holds); the spool is at 80 %
  of its budget or more.
- **ok** otherwise. `reasons` names every rule that fired, in that order,
  and `failing` beats `degraded`.

The rest of the document is what a probe dashboard wants next to the
verdict: `generation`, `stagedGeneration`, `applyState`, `source`,
`leaseExpiresAt` / `leaseExpired` / `onLeaseExpiry`, `lastSyncAt` /
`lastSyncOutcome` / `consecutiveSyncFailures`, `forcedDowngrade`,
`daemon`, `spool` (with `budgetBytes`), `lastUploadAt`, `backoffUntil`.
`Cache-Control: no-store`; `HEAD` is answered; other methods get 405.
Vectors: `sdk-typescript/test/healthz.test.ts`,
`sdk-python/tests/test_healthz.py`.

## `airprompter telemetry validate <segment>…` — a third-party writer's segments

```sh
airprompter telemetry validate spool/seg-i-abc123-29821660-0.ndjson [more…] [--instance-id …] [--json]
```

Every line through the uploader's own inspection (`inspectSegment`), so a
segment that passes here is never quarantined there. Reasons name the line
and the field, never a value (`line 2: unknown_field:prompt`, `line 3:
instance_mismatch`, `line 4: not_json`); a partial last line (a crashed
writer) is skipped, not failed; a file not named
`seg-<instanceId>-<epochMinute>-<n>.ndjson` needs `--instance-id`; a
segment over the 1 MiB cap is refused. Exit `0` when every segment fits,
`1` when any would be quarantined. Vector:
`cli/test/telemetryValidate.test.ts`.

## The verify action — `airprompter verify` on every bundle a pull request commits

```yaml
- uses: airprompter/airprompter-agent-sdk/action/verify@cli/v0.1.0
  with:
    bundle: bundles/*.apbundle     # one per line for several
    org: org_…
    agent: agt_…
    environment: prod
    root: keys/root.prod.jwk.json
    # distribution-key: ${{ runner.temp }}/prod.key.json   # written from a secret by an earlier step, for encrypted bundles
```

Rules (vector: `cli/test/action.test.ts`; the action runs on itself in
this repository's CI):

- The executable comes from the `cli/vX.Y.Z` GitHub release the action
  is used at (or `version:`), and runs only after its SHA-256 matched the
  release's `.sha256` and — by default — its Sigstore bundle verified
  against this repository's release workflow identity with cosign (add
  `sigstore/cosign-installer` to the job, or set `verify-signature: false`).
  `binary:` skips the download for a CLI the job already has.
- Every bundle is verified; a refusal names the step and the reason in
  the job summary and as an annotation, and the good ones still show as
  verified. A glob that matches nothing is an error, never a green run.
- A distribution key reaches the CLI as a file path, never as a value.
- Outputs: `ok`, `generation`, `release-digest`, `report` (a JSON file with
  every bundle's `--json` document). `fail-on-expiring: true` fails a
  bundle inside the CLI's expiry warning window.
- Nothing printed is prompt text: the CLI's `--json` document is what is
  shown, and it never carries a payload.

## `@airprompter/protocol-conformance` — the harness, published

The vectors every SDK must pass, as a package any SDK can run:

```sh
npx airprompter-conformance --adapter ./adapter.mjs                # an ES module
npx airprompter-conformance --adapter-command "python3 adapter.py"  # any process, JSON lines
```

The harness owns the vectors (bundled: `protocol/vectors`, the schemas
they need, `VERSION`) and the verdicts; the SDK owns only the answers,
through nineteen JSON-only operations (`conformance/ADAPTER.md`). A
section whose operation the adapter lacks is **skipped and reported**,
never passed (`--allow-skips` accepts a partial adapter deliberately).
Exit `0` / `1` / `2`; `--json` prints the report. Two adapters ship as
proof: `adapters/agent-sdk.mjs` (the TypeScript packages, from their built
dist) and `examples/conformance-adapter/python/adapter.py` (the Python SDK
over JSON lines, in a process the harness never imports); CI runs both,
plus the reference. Vectors: `conformance/test/harness.test.mjs` — a wrong
answer fails by vector name with the difference; a JSON-lines adapter is
driven over a real pipe; `npm pack` produces a self-contained package.
