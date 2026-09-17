# AirPrompter Agent SDK

Client-side software for **AirPrompter Team Agents**: the SDKs, CLI, daemon
and wire protocol that let an application owned by you (or by a company you
work with) run prompts and workflows that were approved in AirPrompter —
behind your own firewall, on your own model keys, with a local copy that
survives restarts and works offline.

AirPrompter is the control plane: it holds approved versions, seals them
into signed releases, and decides what a target *may* run. Your runtime is
the data plane: it pulls, verifies, stores encrypted, decides *when* a
release goes live, calls the model, and reports content-free measurements.
Nothing in AirPrompter can open a connection to you, read your end-user
content, or make bytes live on a locked runtime.

> Status: **protocol 0.3.4** (`protocol/v0.3.4`); `sdk-typescript/` builds
> its five packages and passes every vector but is not yet published to
> npm. Follow the repository for the first SDK release.

## Layout

| Path | What it is |
|---|---|
| [`protocol/`](protocol/) | The wire contract: JSON Schemas for manifests, bundles, key-sets, directives and telemetry windows; the **spool format** any instrumentation can write; the assignment-hash specification; conformance vectors; OpenAPI for the customer routes. Versioned independently of the SDKs. |
| [`sdk-typescript/`](sdk-typescript/) | Five packages for Node 20+, one version, released in lockstep: `@airprompter/agent-core` (the protocol, pure), `-sync` (pull, the encrypted A/B slot store, the apply policy, the daemon client), `-runtime` (render and assign over a release you hold, the provider wrappers, hosted mode), `-telemetry` (the spool and its uploader), and `@airprompter/agent-sdk` (the facade, `AirPrompterAgent`). Install what you use. |
| [`sdk-python/`](sdk-python/) | The same five for Python 3.10+: `airprompter-agent-core`, `-sync`, `-runtime`, `-telemetry` and `airprompter-agent`. Same protocol, same conformance vectors; wrappers for the `openai`, `anthropic` and LiteLLM clients. |
| [`protocol/compatible-endpoints.md`](protocol/compatible-endpoints.md) | Hosted mode without any SDK of ours: the OpenAI and Anthropic SDKs pointed at `…/v1/agents/{agentId}/{openai\|anthropic}` with `model: "slot:<tag>"` — the mapping, what is refused, the answer shapes. |
| [`cli/`](cli/) | `airprompter` — `pull`, `verify`, `apply`, `status`, `diff`, `unlock`, `rollback`, `keygen`, `export-telemetry`, `import-telemetry`, `login` + `import` (your prompts become reviewable versions), `dev` (a directory served as a registry: live sync while you edit, and the conformance target), and `airprompter daemon` (`airprompterd`). Shipped as signed single-file executables for macOS, Linux and Windows. |
| [`conformance/`](conformance/) | Runner that executes `protocol/vectors` against every SDK, and `live.mjs` — the same schemas and trust chain over HTTP against a running registry (`airprompter dev`, Hangar, or the hosted service). The hosted service runs the same vectors. |
| [`docs/`](docs/) | Customer documentation over the contract: the [threat model as written](docs/threat-model.md) with every claim mapped to a row and a vector, [key handling](docs/key-handling.md), [change-control recipes](docs/change-control.md), the [spool contract and OpenTelemetry mapping](docs/telemetry.md), [ingest — your prompts become approved versions](docs/ingest.md), [operator tooling — doctor, healthz, validate, the verify action, the conformance harness](docs/operator-tooling.md), [change notification — the pointer-first pull and the proposed nudge](docs/change-notification.md), [variables from your system](docs/variables.md), and the conformance suite read as narrative. Link-checked in CI. |
| [`deploy/`](deploy/) | systemd unit, launchd plist, Windows service wrapper, Docker sidecar and Kubernetes DaemonSet manifests for the daemon. |
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

## Protocol compatibility

The hosted service vendors `protocol/v0.3.4` (manifest, payload and key
routes shipped). The `airprompter` CLI on `main` — pull, verify, apply,
status, diff, keygen, daemon — is built and smoke-tested on three
platforms in CI (release tag pending signing identities). The packages:

<!-- compat-table:start -->
| Package | Version | Protocol | Vectors and examples exercised | Conformance |
|---|---|---|---|---|
| `@airprompter/agent-core` | 0.2.12 | 0.3.4 | `canonical-json.json`, `manifest-verify.json`, `assignment.json`, `ramp.json`, `workflow-steps.json`, `checks.json` | green |
| `@airprompter/agent-sync` | 0.2.12 | 0.3.4 | `examples/store.v1.json`, `examples/store.v2.json`, `examples/refused/*` | green |
| `@airprompter/agent-runtime` | 0.2.12 | 0.3.4 | `ramp.json (walked by `ReleaseResolver` over a bundle release)` | green |
| `@airprompter/agent-telemetry` | 0.2.12 | 0.3.4 | `spool.json`, `feedback.json` | green |
| `@airprompter/otel-bridge` | 0.2.12 | 0.3.4 | `otel-mapping.json` | green |
| `@airprompter/agent-sdk` | 0.2.12 | 0.3.4 | `examples/heartbeat.*.json`, `examples/edge-pointer.json` | green |

Generated by `sdk-typescript/scripts/compat-table.mjs` from the conformance run on protocol `0.3.4` (Node 24). One version across the six packages; `@airprompter/agent-sdk` exact-pins its siblings; `@airprompter/otel-bridge` is optional and pins core.
<!-- compat-table:end -->

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
