# Writing telemetry windows without the SDK

The local spool is a public contract (`protocol/spool-format.md`, D66): any
process that writes a valid closed segment into
`<stateDir>/airprompter/<agentId>/<target>/spool/telemetry/` is picked up by
`airprompterd` and uploaded under the host's grant. These two files are the
whole of what a team instrumenting a provider SDK themselves needs — ~100
lines each, no dependencies, the same vectors the SDKs pass:

| File | Language | Checked by |
| --- | --- | --- |
| [`typescript/spool-writer.mjs`](typescript/spool-writer.mjs) | Node 20+, ESM | `conformance/run.mjs` (in process) |
| [`python/spool_writer.py`](python/spool_writer.py) | Python 3.10+, stdlib | [`python/check_vectors.py`](python/check_vectors.py), run by `conformance/run.mjs` |

Both implement, from `protocol/spool-format.md`:

- one `window` row per minute per `(tag, versionId, arm, model, status, errorClass)`;
- latency into the 16 fixed bucket edges (`protocol/schemas/latency-buckets.json`) plus the rounded sum;
- tokens as uncached input, cached input and output — split OpenAI's `cached_tokens` out of `prompt_tokens` yourself (the SDKs' `normalizeUsage` shows how);
- `checks` counters and feedback `outcomes` (`{n, sum}` per declared signal name; booleans as 1/0) that ride on the `ok` window and never add to `count`;
- segment naming `seg-<instanceId>-<epochMinute>-<n>.ndjson`, written as `.open`, `fsync`, then renamed; a new segment on a new minute or when a line would push past 1 MiB; a sealed segment is never reopened.

```js
import { SpoolWriter } from "./spool-writer.mjs";

const spool = new SpoolWriter({ dir: `${stateDir}/airprompter/${agentId}/${target}/spool/telemetry`, instanceId, sdk: "acme-logger/1.0" });
const started = Date.now();
const completion = await openai.chat.completions.create({ model, messages });
spool.observe({ tag, versionId, arm, model, status: "ok", latencyMs: Date.now() - started, tokens: { input: completion.usage.prompt_tokens - cached, cachedInput: cached, output: completion.usage.completion_tokens } });
spool.feedback({ tag, versionId, arm, model, outcomes: { accepted: true } });   // later, from anywhere on the host
process.on("beforeExit", () => spool.close());
```

`tag`, `versionId` and `arm` come from the release you rendered (or from the
`runRef` a compatible endpoint returned). The `sdk` field names *your*
writer: ingest keys on it, so a misreporting writer is isolated without
blaming the fleet.

What must never be in a row: prompt text, model output, end-user
identifiers, error messages, stack traces. The row shape has no field for
them and ingest drops unknown fields; the `runRef` stays on your side.

The daemon itself (`airprompterd`, `cli/`) validates every row against
`protocol/schemas/spool-rows.schema.json` before upload and quarantines a
segment it cannot parse, so a mistake here costs one segment, never the
fleet's data.
