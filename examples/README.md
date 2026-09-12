# Examples

Planned:

- `node-service/` — an Express service rendering a slot with `ap.wrap(openai)`
- `python-worker/` — a queue worker using the `anthropic` client wrapper
- `serverless/` — an AWS Lambda handler with the vendored bundle and on-invoke sync
- `air-gapped/` — applying an `.apbundle` from a file and exporting telemetry
- `spool-writer/` — writing telemetry windows to the spool **without** the SDK, in TypeScript and Python, for teams that instrument the open-source provider SDKs themselves
