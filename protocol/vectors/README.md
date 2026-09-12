# Conformance vectors

Machine-readable cases every SDK must pass.

- `canonical-json.json` — canonical text and SHA-256 for representative values, a two-pin release and a workflow pin with steps; plus the inputs an encoder must refuse (see `../canonical-json.md`)
- `workflow-steps.json` — the `<slot tag>#<ordinal>` step-tag scheme, ordinal ordering the `workflow()` iterator must honour, and the refusals (tag mismatch, ordinal gap, `#` in a slot tag)

Planned files:

- `assignment.json` — `(salt, subject, weights) → arm` cases for the sticky hash
- `manifest-verify.json` — accept and refuse cases: valid chain, expired root metadata, unknown signing key, generation rollback, payload hash mismatch, wrong org/agent/target
- `spool.json` — segment naming, rotation at minute boundary and 1 MiB, closing rules, row validation against the schemas
- `feedback.json` — accepted and rejected signal payloads
