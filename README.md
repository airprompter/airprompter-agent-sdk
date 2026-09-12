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

> Status: **protocol 0.1.0 pinned** (`protocol/v0.1.0`); packages are not
> yet published. Follow the repository for the first SDK release.

## Layout

| Path | What it is |
|---|---|
| [`protocol/`](protocol/) | The wire contract: JSON Schemas for manifests, bundles, key-sets, directives and telemetry windows; the **spool format** any instrumentation can write; the assignment-hash specification; conformance vectors; OpenAPI for the customer routes. Versioned independently of the SDKs. |
| [`sdk-typescript/`](sdk-typescript/) | `@airprompter/agent-sdk` for Node 20+. Sync loop, encrypted A/B slot store, rendering, declared output checks, feedback and `runRef`, spool writer, and `ap.wrap()` middleware for the OpenAI, Anthropic and Vercel AI SDK clients. |
| [`sdk-python/`](sdk-python/) | `airprompter-agent` for Python 3.10+. Same protocol, same conformance vectors; wrappers for the `openai`, `anthropic` and LiteLLM clients. |
| [`cli/`](cli/) | `airprompter` — `pull`, `verify`, `apply`, `status`, `diff`, `unlock`, `rollback`, `keygen`, `export-telemetry`, and `airprompter daemon` (`airprompterd`). Shipped as signed single-file executables for macOS, Linux and Windows. |
| [`conformance/`](conformance/) | Runner that executes `protocol/vectors` against every SDK. The hosted service runs the same vectors. |
| [`deploy/`](deploy/) | systemd unit, launchd plist, Windows service wrapper, Docker sidecar and Kubernetes DaemonSet manifests for the daemon. |
| [`examples/`](examples/) | A Node service, a Python worker, a serverless handler, and an air-gapped host. |

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
- **You decide when it goes live.** `unlock_required` targets stage a release and activate only on your operator's command, in your update window, or through your change-control hook.
- **Content-free telemetry.** Minute windows of counts, latency histograms and token sums. No prompt text, no outputs, no end-user identifiers — by schema, not by policy.

## Protocol compatibility

| Protocol | Hosted service | `@airprompter/agent-sdk` | `airprompter-agent` | `airprompter` CLI |
|---|---|---|---|---|
| 0.1 | vendors `protocol/v0.1.0`; routes land per `openapi.yaml` status | — | — | — |

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
