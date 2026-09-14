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

`node live.mjs --base-url <url> --root <root.pub.json> --api-key <key>`
(S12) exercises a **running** registry over HTTP with the same schemas and
the same trust chain: the root, the edge pointer, the manifest (401 without
a key, 403/404 for another agent, 304 on its ETag, verified against the
root the caller pins), every referenced payload fetched and hashed, the
catalogue, the heartbeat (a schema-valid answer, a lease in the future, a
400 for a field the schema does not name). `airprompter dev` is the target
CI runs it against; Hangar and the hosted service are the same target with
their own URL, root and key.

The reference implementations are the smallest correct versions of the
protocol's pure functions (canonical JSON, sticky assignment, step
ordering). SDKs may copy them; they must pass the same vectors either way.
Manifest signature verification with real keys joins this runner with the
trust-chain ticket, and each SDK's spool writer and feedback validator are
exercised here once they exist. The compatibility table in the root README
is generated from this run.
