# Support

| I need… | Go to |
|---|---|
| Help using the SDK, CLI or daemon; "is this expected?"; design questions | [GitHub Discussions](https://github.com/airprompter/airprompter-agent-sdk/discussions) |
| To report a bug in this repository | [New issue → Bug report](https://github.com/airprompter/airprompter-agent-sdk/issues/new?template=bug_report.yml) — `airprompter doctor` output attached (it prints no key and no prompt text) |
| To propose a change to the protocol or an SDK | [New issue → Feature request](https://github.com/airprompter/airprompter-agent-sdk/issues/new?template=feature_request.yml), or a pull request per [CONTRIBUTING.md](CONTRIBUTING.md) |
| To report a security vulnerability | **security@airprompter.com** — never a public issue. See [SECURITY.md](SECURITY.md) |
| Help with your AirPrompter workspace, billing, a release that will not promote, or anything that needs your account | support@airprompter.com from the address on the account, or the in-app help |

Issues here are for the open-source code. Anything that needs your
organization's data — a promotion, a key, a release — is answered by
AirPrompter support, not in a public issue; please do not paste keys,
release digests you consider private, or prompt text into an issue.

## What to include in a bug report

- Which package and version (`npm ls @airprompter/agent-sdk`, `pip show airprompter-agent`, `airprompter --version`)
- The protocol version the runtime reports (`ap.status().protocol`, `airprompter status`)
- The output of `airprompter doctor` or `healthz()` — both are content-free
- The smallest reproduction you can manage against the fake control plane in
  `sdk-typescript/packages/core/src/testing/` or `sdk-python/tests/control_plane.py`

## Response times

Maintainers triage issues and discussions within a few business days.
Security reports are acknowledged within two business days.
