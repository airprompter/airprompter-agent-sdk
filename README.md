# AirPrompter Agent SDK

Client-side software for **AirPrompter Team Agents**: the SDKs, CLI, telemetry
daemon and wire protocol that let an application owned by you (or by a company you
work with) run prompts and workflows that were approved in AirPrompter —
behind your own firewall, on your own model keys, with a local copy that
survives restarts and works offline.

AirPrompter is the control plane: it holds approved versions, seals them
into signed releases, and decides what a target *may* run. Your runtime is
the data plane: it pulls, verifies, stores encrypted, decides *when* a
release goes live, calls the model, and reports content-free measurements.
Nothing in AirPrompter can open a connection to you, read your end-user
content, or make bytes live on a locked runtime.

> Status: **protocol 3.0.0** (`protocol/v3.0.0`) and **SDK 1.0.0-rc.0**, the release candidate for 1.0.0.
> One SDK release publishes five lockstep npm packages and five lockstep
> PyPI distributions through the repository release workflow.

## Layout

| Path | What it is |
|---|---|
| [`protocol/`](protocol/) | The wire contract: JSON Schemas for manifests, bundles, key-sets, directives and telemetry windows; the **spool format** any instrumentation can write; the assignment-hash specification; conformance vectors; OpenAPI for the customer routes. Versioned independently of the SDKs. |
| [`sdk-typescript/`](sdk-typescript/) | One package for Node 20+, `@airprompter/agent-sdk`: the agent (`AirPrompterAgent`) at the root and its parts behind subpaths, `/core` (the protocol, pure), `/sync` (pull, the encrypted A/B slot store, the apply policy, the daemon client), `/runtime` (render and assign over a release you hold, the provider wrappers), `/telemetry` (the spool and its uploader), `/testing` (the CI kit) and `/frameworks/langchain`. Optional beside it, one version, each taking the SDK as a peer: `@airprompter/agent-otel`, and `@airprompter/datastore-s3`, `-postgres`, `-redis` — your own datastore carrying releases to your runtimes ([docs/datastore.md](docs/datastore.md)). |
| [`sdk-python/`](sdk-python/) | The same for Python 3.10+: one distribution, `airprompter-agent`, with `airprompter_agent.core`, `.sync`, `.runtime` and `.telemetry`, plus the optional `airprompter-agent-otel` and `airprompter-datastore-s3`, `-postgres` and `-redis` (the same tables, keys and objects as the TypeScript adapters). Same protocol, same conformance vectors; wrappers for the `openai`, `anthropic` and LiteLLM clients. |
| [`cli/`](cli/) | `airprompter` — `pull`, `verify`, `apply`, `status`, `diff`, `unlock`, `rollback`, `keygen`, `export-telemetry`, `import-telemetry`, `login` + `import` (your prompts become reviewable versions), `dev` (a directory served as a registry: live sync while you edit, and the conformance target), and `airprompter daemon` (`airprompterd`). Shipped as signed single-file executables for macOS, Linux and Windows. |
| [`conformance/`](conformance/) | Runner that executes `protocol/vectors` against every SDK, and `live.mjs` — the same schemas and trust chain over HTTP against a running registry (`airprompter dev`, Hangar, or the hosted service). The hosted service runs the same vectors. |
| [`docs/`](docs/) | Customer documentation over the contract: the [threat model as written](docs/threat-model.md) with every claim mapped to a row and a vector, [key handling](docs/key-handling.md), [change-control recipes](docs/change-control.md), the [spool contract and OpenTelemetry mapping](docs/telemetry.md), [ingest — your prompts become approved versions](docs/ingest.md), [operator tooling — doctor, healthz, validate, the verify action, the conformance harness](docs/operator-tooling.md), [change notification — the pointer-first pull and the proposed nudge](docs/change-notification.md), [variables from your system](docs/variables.md), and the conformance suite read as narrative. Link-checked in CI. |
| [`deploy/`](deploy/) | systemd unit, launchd plist, Windows service wrapper, Docker sidecar and Kubernetes DaemonSet manifests for the telemetry daemon (`airprompterd` ships the spool SDK processes write; it serves no release — [`protocol/daemon.md`](protocol/daemon.md)). |
| [`examples/`](examples/) | A Python worker, and [`spool-writer/`](examples/spool-writer/) — telemetry windows written to the spool **without** the SDK, in TypeScript and Python, for teams instrumenting the provider SDKs themselves (checked by the conformance runner). |

## How the pieces fit

```
your application ──(render / wrap)──▶ SDK ──▶ encrypted slot store (A/B, restart-safe, offline)
        │                              │
        │  metrics: tokens, latency,   ▼
        │  error class, output checks,  spool/  ◀── any instrumentation may write here (protocol/spool-format.md)
        │  feedback (numbers only)      │
        ▼                               ▼
   your model provider          airprompterd ──PUT under a 15-minute presigned grant──▶ your prefix in AirPrompter's S3
```

- **Pull only.** Every connection is opened by your side over outbound HTTPS.
- **Verified before staged.** Offline root of trust → signing key → signed manifest → content-addressed payloads → monotonic generation.
- **You decide when it goes live.** `unlock_required` targets stage a release and activate only on your operator's command, in your update window, or through your change-control hook. The policy itself is yours too: a host pins it on first use, the console can tighten it and never loosen it, and only an operator on the host can loosen it (`airprompter policy set`).
- **Content-free telemetry.** Minute windows of counts, latency histograms and token sums. No prompt text, no outputs, no end-user identifiers — by schema, not by policy.

## Protocol

This SDK speaks protocol 3.x. The hosted service vendors the same tag
(manifest, payload and key routes shipped). The `airprompter` CLI on `main` — pull, verify, apply,
status, diff, keygen, daemon — is built and smoke-tested on three
platforms in CI (release tag pending signing identities).

## Supply chain

Every release is built on GitHub Actions from a tag: npm packages publish
with provenance, PyPI packages through trusted publishing, binaries are
signed keyless with cosign, and every artifact ships an SPDX SBOM
(`.github/workflows/release.yml`). No token that can publish lives in this
repository. The platform root public keys are pinned in SDK source, so a
key change is a visible commit.

## Licence

BSD-3-Clause. See [LICENSE](LICENSE). "AirPrompter" is a trademark; see [TRADEMARKS.md](TRADEMARKS.md).

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability and for the threat model this software is built against.

## Contributing and support

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) (set-up, what a change needs, the DCO sign-off) and the [Code of Conduct](CODE_OF_CONDUCT.md). Versions and what changed in each: [CHANGELOG.md](CHANGELOG.md) for the SDKs and CLI, [protocol/CHANGELOG.md](protocol/CHANGELOG.md) for the wire. Where to ask what: [SUPPORT.md](SUPPORT.md).
