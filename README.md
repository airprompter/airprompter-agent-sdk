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

> Status: **protocol 0.2.5** (`protocol/v0.2.5`); `sdk-typescript/` builds
> and passes every vector but is not yet published to npm. Follow the
> repository for the first SDK release.

## Layout

| Path | What it is |
|---|---|
| [`protocol/`](protocol/) | The wire contract: JSON Schemas for manifests, bundles, key-sets, directives and telemetry windows; the **spool format** any instrumentation can write; the assignment-hash specification; conformance vectors; OpenAPI for the customer routes. Versioned independently of the SDKs. |
| [`sdk-typescript/`](sdk-typescript/) | `@airprompter/agent-sdk` for Node 20+. Sync loop, encrypted A/B slot store, rendering, declared output checks, feedback and `runRef`, spool writer, and `ap.wrap()` middleware for the OpenAI, Anthropic and Vercel AI SDK clients. |
| [`sdk-python/`](sdk-python/) | `airprompter-agent` for Python 3.10+. Same protocol, same conformance vectors; wrappers for the `openai`, `anthropic` and LiteLLM clients. |
| [`protocol/compatible-endpoints.md`](protocol/compatible-endpoints.md) | Hosted mode without any SDK of ours: the OpenAI and Anthropic SDKs pointed at `…/v1/agents/{agentId}/{openai\|anthropic}` with `model: "slot:<tag>"` — the mapping, what is refused, the answer shapes. |
| [`cli/`](cli/) | `airprompter` — `pull`, `verify`, `apply`, `status`, `diff`, `unlock`, `rollback`, `keygen`, `export-telemetry`, `import-telemetry`, and `airprompter daemon` (`airprompterd`). Shipped as signed single-file executables for macOS, Linux and Windows. |
| [`conformance/`](conformance/) | Runner that executes `protocol/vectors` against every SDK. The hosted service runs the same vectors. |
| [`docs/`](docs/) | Customer documentation over the contract: the [threat model as written](docs/threat-model.md) with every claim mapped to a row and a vector, [key handling](docs/key-handling.md), [change-control recipes](docs/change-control.md), the [spool contract and OpenTelemetry mapping](docs/telemetry.md), and the conformance suite read as narrative. Link-checked in CI. |
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

| Protocol | Hosted service | `@airprompter/agent-sdk` | `airprompter-agent` | `airprompter` CLI |
|---|---|---|---|---|
| 0.2 | vendors `protocol/v0.2.5`; manifest, payload and key routes shipped | `sdk-typescript` main (unpublished) | — | `cli` main: pull, verify, apply, status, diff, keygen (built and smoke-tested on three platforms in CI; release tag pending signing identities) |

Generated from the conformance run once SDK packages exist; until then this
table is maintained by hand with each protocol tag.

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
