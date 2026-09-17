# airprompter CLI

One binary, shipped as signed single-file executables for macOS, Linux
and Windows, so Python users never install Node. It shares the
TypeScript SDK's modules: what `verify` refuses, the runtime refuses too.

```
airprompter pull     Fetch and verify the current release; write an encrypted .apbundle (--check compares the vendored one)
airprompter verify   Run the verification chain on a bundle or a state directory and print the reasons
airprompter apply    Stage a bundle into the store and activate it per the environment's policy
airprompter status   Active and staged generation, lease, storage protection, spool depth, last upload
airprompter unlock   Make the staged release live on this host (the operator's unlock; --generation N to name it)
airprompter rollback The previous release on this host live again, now and offline (the other slot; a step below the stored generation is a forced downgrade, reported)
airprompter policy   Show or set the apply policy this host holds (an update may tighten it; only this loosens it)
airprompter doctor   Every reason this host is not serving the release it should, with the remedy (source, root, store, lease, key protection, spool, daemon, policy pin)
airprompter diff     What a bundle would change against the active release on this host, or against another bundle (--against)
airprompter keygen   Generate a distribution or countersign keypair
airprompter daemon   airprompterd: one sync loop and one shared store per host, served to SDKs over a local socket
airprompter export-telemetry   Pack the spool's unsent segments into one file for a host that never calls home
airprompter import-telemetry   Upload an exported telemetry file through the grant path on a connected host (idempotent)
airprompter telemetry verify   Prove the spool's disk budget is an invariant, on this machine, with no registry
airprompter telemetry validate <segment>…   A third-party writer's segments against the spool contract, line by line
airprompter dev <dir>   Serve a directory of prompts as a registry over the protocol's routes (dev key, dev root, hot reload; --daemon serves the host's SDKs too)
airprompter login    Sign in as a workspace member and print the session token the write commands read (never an API key)
airprompter import   A directory, a JSON/CSV export or a SQL query result becomes workspace prompts with reviewable versions (--dry-run plans)
```

`doctor`, `telemetry validate`, the in-process `healthz`, the verify
GitHub Action (`action/verify`) and the published conformance harness are
described in [`docs/operator-tooling.md`](../docs/operator-tooling.md).

Coming with a later ticket: `countersign` (T10).

## The daemon

```bash
AIRPROMPTER_AGENT_KEY=… airprompter daemon \
  --org org_… --agent agt_… --environment prod \
  --root ./airprompter-root.jwk.json --root-url https://<edge>/roots/prod/root.json \
  --edge-pointer-url https://<edge>/g/<token>/generation.json --poll-seconds 30 --json
```

The daemon is the runtime every SDK process runs, once per host: the
same store, the same verification, the same apply policy — and a local
socket (`<store>/daemon.sock`, mode `0600`; a named pipe on Windows)
over which SDK processes started with `sync.mode: "daemon"` receive the
verified release, `generation` events, and host-wide `unlock` /
`rollback`. A process that finds no socket syncs in-process from its own
store; a daemon that cannot obtain the store's key does not listen. Logs
are one JSON object per line on stderr and never carry prompt text.
`GET /healthz` on the socket answers `200` with a verified release active
and `503` without (with `spoolDepth`, `lastUploadAt`, `backoffUntil`);
`airprompter status` asks the daemon when it is there.

With an Agent key the daemon also **uploads the spool**: every closed
segment under the store's `spool/telemetry/` — its own, the attached SDK
processes', and any third-party writer's — is checked line by line
against the spool contract (a failing segment is quarantined whole, never
sent), then POSTed straight to S3 under a presigned grant the daemon's
heartbeat obtains **per writer** (a grant covers one instance prefix; the
heartbeat names the writer). Acknowledged segments are deleted (S6 — the
key is the file name, a replay is idempotent; `.last-upload` stamps the
last one); failures back off with full jitter (1 s → 5 min); a
hold from the grant issuer is honoured for exactly `retryAfterSeconds`;
over the host budget (`--spool-budget-bytes`, 100 MiB) the oldest unsent
segments go and the loss is reported as a `dropped` row. Passes run every
`--upload-interval-seconds` (300) until a grant says otherwise; `--no-upload`
leaves the spool on disk. `status` shows the uploader's state; the
socket's `upload` op runs a pass now.
Service manifests for systemd, launchd, Windows (WinSW), Docker and
Kubernetes are in [`../deploy/`](../deploy/); the wire format is
[`../protocol/daemon-socket.md`](../protocol/daemon-socket.md).

## The contract scripts can rely on

- **Exit codes**: `0` ok · `1` refused (verification failed, apply refused,
  the fetch was denied — reason on stderr) · `2` usage · `3` stale
  (`pull --check` only) · `4` partial (`import` only: some items failed
  and the output names each; the others landed).
- **`--json`**: one JSON document on stdout, always the last line; on a
  refusal it carries `{ ok: false, error, exitCode, step?, reason? }`.
- **Secrets never travel on argv.** The Agent key is read from
  `AIRPROMPTER_AGENT_KEY` (or the variable named by `--api-key-env`);
  private keys come from files the CLI wrote with mode `0600`; the session
  token `import` needs is read from `AIRPROMPTER_SESSION_TOKEN` (printed by
  `login`, whose password comes from `AIRPROMPTER_PASSWORD` or a terminal
  prompt).
- **Nothing printed is prompt text**, at any verbosity. `pull`, `verify`,
  `diff` and `status` describe releases in generations, digests, ids,
  models, variable names and counts. The bundle on disk is ciphertext
  unless you asked for `--plaintext` on `dev`.

## Live sync while you edit (`dev`)

`airprompter dev ./prompts` serves a directory of prompt files as a registry
over the protocol's routes — a dev key, a dev root kept beside the prompts,
every save a generation, `unlock_required` honoured locally, `--daemon` for
the host's SDKs — and it is the conformance target `conformance/live.mjs`
exercises beside the hosted service. The recipe is
[`../docs/change-control.md` §8](../docs/change-control.md#8-live-sync-while-you-edit-airprompter-dev-s12).

```bash
airprompter dev ./prompts --port 4180
AIRPROMPTER_AGENT_KEY=apa_dev_local airprompter pull --org org_dev --agent agt_dev --environment dev \
  --root ./prompts/.airprompter-dev/root.pub.json --base-url http://127.0.0.1:4180 --out ./release.apbundle --plaintext
node ../conformance/live.mjs --base-url http://127.0.0.1:4180 --root ./prompts/.airprompter-dev/root.pub.json --api-key apa_dev_local
```

## Bringing your prompts in (`import`)

The other direction: a directory of prompt files, a JSON or CSV export, or
the rows of a database query become workspace prompts with reviewable
versions — idempotently, so the same command runs on every merge or on a
schedule. `airprompter login` prints the session token it needs (team
writes are a signed-in member's, never an API key's).

```bash
eval "$(airprompter login --email you@example.com)"      # password from AIRPROMPTER_PASSWORD or the terminal
airprompter import --workspace ws_… --collection col_… --from ./prompts --key git:prompts --category support --platform claude --dry-run
airprompter import --workspace ws_… --collection col_… --from rows.json --key postgres:prompts --map key=slug,title=name,content=body --platform claude
```

The prompt id is derived from (workspace, import key, item key): unchanged
content writes nothing, changed content is a new version submitted for
review, a new key is a new prompt. The round trip for each habit is
[`../docs/ingest.md`](../docs/ingest.md).

## Vendoring a bundle in CI

```bash
# once, outside any repository: the target's distribution keypair
airprompter keygen --purpose distribution --out ~/.config/airprompter/prod
# register ~/.config/airprompter/prod.pub.json on the environment (Agent › Settings)

# in the build: the current release, encrypted to that key
AIRPROMPTER_AGENT_KEY=… airprompter pull \
  --org org_… --agent agt_… --environment prod \
  --root ./airprompter-root.jwk.json --root-url https://<edge>/roots/prod/root.json \
  --distribution-key ./prod.pub.json \
  --out airprompter.bundle.apbundle

# in a scheduled job: fail when the vendored bundle falls behind
AIRPROMPTER_AGENT_KEY=… airprompter pull --check --max-behind 2 \
  --org org_… --agent agt_… --environment prod --out airprompter.bundle.apbundle
```

`airprompter diff <new.apbundle> --against <old.apbundle>` compares two
update files with no store — the pull request's before and after — slot
by slot (versions, models, variable contracts, steps, policy, lease), and
names a bundle that goes backwards in generation (`direction: backward`,
a printed warning), because every host refuses one. `docs/change-control.md`
› 7 is the CI recipe.

`pull` writes `<out>.meta.json` beside the bundle: generation, release
digest, timestamps, encryption scheme and recipient key id — nothing
else. `--check` reads that sidecar and the current manifest and exits `3`
when the vendored generation is more than `--max-behind` behind (default
`0`: any newer generation is stale).

`--root` takes either the environment's pinned root public key (a JWK —
what the console shows) or a full signed `root.json`. A pinned key alone
cannot name the signing keys, so `pull` also needs `--root-url` (the
edge's `root.json`, verified against the pinned key before use) or a root
document.

## On a host

```bash
airprompter verify airprompter.bundle.apbundle --org … --agent … --environment prod \
  --root ./airprompter-root.jwk.json --distribution-key ~/.config/airprompter/prod.key.json
airprompter diff   airprompter.bundle.apbundle --org … --agent … --environment prod --distribution-key …
airprompter apply  airprompter.bundle.apbundle --org … --agent … --environment prod --root … --distribution-key …
airprompter status --agent … --environment prod
```

`apply` runs the identical chain the runtime runs (root → manifest
signature → payload hashes → generation counter), stages into the
inactive slot, and activates under `auto`; under `unlock_required` it
stages and says so. With `--golden` (T34) both `verify` and `apply` run the
release's golden sets first — `--run "<command>"` runs a program once per
case (the case as JSON on stdin: `tag`, `caseId`, `text`, `model`, `arm`,
`variables`; the answer on stdout) or `--outputs answers.json` takes what a
harness already produced (`{"<tag>/<caseId>": "…"}`); `verify` refuses and
`apply` stages without activating when a set falls below its floor, and
only counts are printed (`protocol/golden-sets.md`). A generation below the stored one is refused unless
`--force`, and then it is a forced downgrade stamped on evidence. The
state directory defaults to the OS state directory (`$XDG_STATE_HOME`,
`~/Library/Application Support`, `%LOCALAPPDATA%`); pass `--state-dir`
to match what the runtime was started with.

`airprompter telemetry verify --budget <bytes> --sink-absent` (S6) is the
proof that the spool cannot fill the disk: on a filling in-memory
filesystem with no registry behind it, two writers write past the budget,
a third crashed mid-open an hour ago, a fourth is live, and a buggy
third-party writer overfilled `quarantine/`; one pass has to leave the tree
under `budget + writers × 1 MiB + quarantine cap + exported cap` and say
what it evicted in one `dropped` row with the right byte count. It prints
the tree before and after, the eviction, the row, the bound and each check;
exit 0 when the invariant holds (`--json` for the same as one document).

The apply policy is the host's (S4): the first update file `apply` verifies
pins it in `store.json`; a later file may tighten it (`auto` →
`unlock_required`) and never loosen it — `apply` says so when the file's
value differs from the pin. `airprompter policy show` prints what is in
force and where it came from; `airprompter policy set auto|unlock_required
[--by …]` is the operator's act that loosens (or tightens by hand), logged,
and host-wide through the daemon when one runs. Loosening is not an unlock:
a release already staged still waits for `airprompter unlock`.

`keygen` refuses to write a private key inside a git worktree unless
`--allow-worktree`: the one way a key ends up in a repository is by
being written next to the code.

## A host that never calls home

An environment whose hosts have no route to AirPrompter is served by a
file. In Agent › Settings › Environments the console offers **Download
update file** on an environment whose sync mode is offline and whose
distribution key is registered: the promoted release, its payloads and
the environment's root document, sealed to that key — the same
`.apbundle` `pull` writes, built by the platform. The file is good for
90 days by default (`notAfter`; a year at most) and the console, `verify`
and `apply` all warn inside the last 30.

```bash
# on the connected side: download the update file from the console, carry it across
# on the host:
airprompter verify agt_…-prod-g12.apbundle --org … --agent … --environment prod \
  --root ./airprompter-root.jwk.json --distribution-key ~/.config/airprompter/prod.key.json
airprompter apply  agt_…-prod-g12.apbundle --org … --agent … --environment prod --root … --distribution-key …

# telemetry back: pack what the SDKs on this host spooled
airprompter export-telemetry --org … --agent … --environment prod --out 2026-09-12.aptelemetry
# carry the file to a host that can reach AirPrompter, then:
AIRPROMPTER_AGENT_KEY=… airprompter import-telemetry --org … --agent … --environment prod --in 2026-09-12.aptelemetry
```

`export-telemetry` packs every closed segment in `spool/telemetry/` that
has at least one valid row (a segment with none is left in place and
named on stderr), verbatim, and moves the packed ones to
`spool/telemetry/exported/` so the next export packs only what is new
(`--keep` leaves them; what sits in `exported/` for more than a week is
swept by the next export). The file carries the scope, the store's active
generation and the segments; no prompt text, no responses — the spool
never holds any. `import-telemetry` heartbeats once per instance the
file names (as that instance, `syncMode: offline`, with the exported
generation), takes the grant to that instance's prefix and posts each
segment under its own name: the same path the daemon uploads by, so
importing the same file twice re-puts the same keys and counts nothing
twice. A hold is reported with the platform's retry and exits `1`; a
file for another agent or environment is a usage error before any
network.

### Custody of the distribution key

The private half of the distribution key opens every update file sealed
to it — it is, in effect, the environment's data-encryption key. Keep it
where the runtime reads it and nowhere else (`keygen` writes it `0600`
and refuses a git worktree); never copy it beside the update file.
Re-key at least every 90 days: `keygen` a new pair, register the new
public key on the environment, download a fresh update file, then retire
the old private key once the hosts have applied it. Nothing about a
downloaded file needs to be secret beyond that key — the file is
ciphertext, its name carries only the agent, environment and generation.

## Building

```
npm ci
npm test                      # the CLI as a function, against the SDK's fake control plane
npm run bundle                # dist/airprompter.cjs (node dist/airprompter.cjs …)
npm run build:sea -- --out dist/airprompter-$(uname -s | tr A-Z a-z)-$(uname -m)
node scripts/smoke.mjs dist/airprompter-…   # the binary smoke test CI runs on every platform
```

The executable is a Node single-executable application: the running
`node` binary with the bundled CLI injected (about 65 MiB; Go remains the
documented path if size becomes a customer objection, D51). CI builds and
smoke-tests it on Linux, macOS and Windows on every push; `cli/vX.Y.Z`
tags build all four artifacts, sign them with cosign (keyless, Sigstore),
attach an SBOM, and — when the identities are configured as repository
secrets — Developer ID-sign and notarize the macOS binary
(`APPLE_CERTIFICATE_P12`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_TEAM_ID`,
`APPLE_APP_PASSWORD`) and Authenticode-sign the Windows binary
(`WINDOWS_CERTIFICATE_PFX`, `WINDOWS_CERTIFICATE_PASSWORD`). Each release
artifact ships with a `.provenance.txt` naming the platform signature
applied, so an ad-hoc-signed build is never mistaken for a notarized one.
