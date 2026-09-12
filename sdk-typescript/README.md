# @airprompter/agent-sdk (TypeScript)

Node 20+, ESM and CJS, no runtime dependencies beyond `node:crypto`.

Planned modules: `store/` (encrypted A/B slot store, atomic apply,
anti-rollback), `verify/` (root metadata, manifest signature, payload
hashes), `sync/` (resident, on-invoke, daemon-attached), `render/`
(variables with trust levels and delimiters), `checks/` (declared output
checks), `feedback/` (`runRef`, signal catalogue), `spool/` (segment writer
per `protocol/spool-format.md`), `wrap/` (middleware for the `openai` and
`@anthropic-ai/sdk` clients and a Vercel AI SDK `wrapLanguageModel`
middleware — the SDK never vendors provider code).

Optional key providers ship as separate packages:
`@airprompter/keyprovider-aws-kms`, `-vault`, `-os-keystore`.
