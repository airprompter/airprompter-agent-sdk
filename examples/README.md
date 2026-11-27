# Examples

- [`spool-writer/`](spool-writer/) — writing telemetry windows to the spool **without** the SDK, in TypeScript and Python, for teams that instrument the open-source provider SDKs themselves. Both writers pass `protocol/vectors/spool.json` under `conformance/run.mjs`.
- [`python-worker/`](python-worker/) — a queue worker using the `anthropic` client wrapper.

Planned:

- `node-service/` — an Express service serving a slot through `instrument(openai, ap, { slot })`
- `serverless/` — an AWS Lambda handler with the vendored bundle and on-invoke sync
- `air-gapped/` — applying an `.apbundle` from a file and exporting telemetry
