# Conformance

Executes `protocol/vectors/` against every SDK: assignment hashing,
manifest verification (including the refusal cases — expired root
metadata, unknown signing key, generation rollback, hash mismatch), spool
segment writing and rotation, and feedback-signal validation. The hosted
service runs the same vectors; the compatibility table in the root README
is generated from this run.
