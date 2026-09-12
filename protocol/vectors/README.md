# Conformance vectors

Machine-readable cases every SDK must pass. Planned files:

- `assignment.json` — `(salt, subject, weights) → arm` cases for the sticky hash
- `manifest-verify.json` — accept and refuse cases: valid chain, expired root metadata, unknown signing key, generation rollback, payload hash mismatch, wrong org/agent/target
- `spool.json` — segment naming, rotation at minute boundary and 1 MiB, closing rules, row validation against the schemas
- `feedback.json` — accepted and rejected signal payloads
