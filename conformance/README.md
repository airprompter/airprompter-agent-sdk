# Conformance

`npm ci && npm test` here runs, against `../protocol`:

1. every `schemas/*.schema.json` compiles as JSON Schema 2020-12 (strict);
2. every `examples/*.json` validates against its schema and every
   `examples/refused/*.json` is refused;
3. the rules a schema cannot express hold on every example manifest and
   bundle — the release digest reproduces from the slots, each arm's digest
   reproduces from slots + overrides, countersignatures cover every arm on
   a countersign target, a bundle carries every referenced payload and the
   bytes hash to their `contentHash`;
4. the reference implementations in `reference.mjs` pass every vector in
   `vectors/`.

`npm run lint:openapi` lints `openapi.yaml`.

The reference implementations are the smallest correct versions of the
protocol's pure functions (canonical JSON, sticky assignment, step
ordering). SDKs may copy them; they must pass the same vectors either way.
Manifest signature verification with real keys joins this runner with the
trust-chain ticket, and each SDK's spool writer and feedback validator are
exercised here once they exist. The compatibility table in the root README
is generated from this run.
