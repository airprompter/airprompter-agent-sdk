# airprompter CLI

One binary, shipped as signed single-file executables for macOS, Linux
and Windows, so Python users never install Node. It shares the
TypeScript SDK's modules: what `verify` refuses, the runtime refuses too.

```
airprompter pull     Fetch and verify the current release; write an encrypted .apbundle (--check compares the vendored one)
airprompter verify   Run the verification chain on a bundle or a state directory and print the reasons
airprompter apply    Stage a bundle into the store and activate it per the environment's policy
airprompter status   Active and staged generation, lease, storage protection, spool depth, last upload
airprompter diff     What a bundle would change against the active release on this host
airprompter keygen   Generate a distribution or countersign keypair
```

Coming with later tickets: `unlock`, `rollback` (T9), `countersign`
(T10), `export-telemetry` (T16), `daemon` / `airprompterd` (T26).

## The contract scripts can rely on

- **Exit codes**: `0` ok · `1` refused (verification failed, apply refused,
  the fetch was denied — reason on stderr) · `2` usage · `3` stale
  (`pull --check` only).
- **`--json`**: one JSON document on stdout, always the last line; on a
  refusal it carries `{ ok: false, error, exitCode, step?, reason? }`.
- **Secrets never travel on argv.** The Agent key is read from
  `AIRPROMPTER_AGENT_KEY` (or the variable named by `--api-key-env`);
  private keys come from files the CLI wrote with mode `0600`.
- **Nothing printed is prompt text**, at any verbosity. `pull`, `verify`,
  `diff` and `status` describe releases in generations, digests, ids,
  models, variable names and counts. The bundle on disk is ciphertext
  unless you asked for `--plaintext` on `dev`.

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
stages and says so. A generation below the stored one is refused unless
`--force`, and then it is a forced downgrade stamped on evidence. The
state directory defaults to the OS state directory (`$XDG_STATE_HOME`,
`~/Library/Application Support`, `%LOCALAPPDATA%`); pass `--state-dir`
to match what the runtime was started with.

`keygen` refuses to write a private key inside a git worktree unless
`--allow-worktree`: the one way a key ends up in a repository is by
being written next to the code.

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
