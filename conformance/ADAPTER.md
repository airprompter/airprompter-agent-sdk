# The conformance adapter contract

`@airprompter/protocol-conformance` runs every vector in `protocol/vectors`
against an SDK it never imports. The SDK answers through an **adapter**:
nineteen operations, JSON in, JSON out. The harness owns the vectors and
the verdicts; the adapter owns only the answers.

```sh
npx airprompter-conformance --adapter ./my-sdk-adapter.mjs
npx airprompter-conformance --adapter-command "python3 adapter.py"
npx airprompter-conformance --adapter-command "./my-sdk-adapter" --only trust-manifest,otel
```

Exit `0` only when every section that ran passed and none was skipped;
`--allow-skips` accepts a partial adapter (a section skipped is reported,
never counted as passed); `1` on any failure; `2` on a usage error.
`--json` prints the report as one document. The vectors are bundled with
the package; `--vectors <dir>` points at another `protocol/` checkout.

## Two transports

**An ES module** (`--adapter <file.mjs>`): `export const ops = { … }` (or a
default export) with one function per operation, sync or async, taking the
arguments object and returning the result object. A refusal the protocol
names is thrown as any error with a string `reason` property.

**A JSON-lines process** (`--adapter-command "<cmd>"`): the harness spawns
the command and writes one request per line on its stdin; the process
answers one line per request on its stdout, in any order:

```
→ {"id": 1, "fn": "capabilities", "args": {}}
← {"id": 1, "result": {"ops": ["canonicalJson", "assignArm", …]}}
→ {"id": 2, "fn": "assignArm", "args": {"salt": "…", "subject": "user-1", "arms": […]}}
← {"id": 2, "result": {"subjectHash": "…", "bucket": 934, "arm": "control"}}
→ {"id": 3, "fn": "assignArm", "args": {"salt": "…", "subject": "user-1", "arms": [{"arm": "only", "weightBps": 10000}]}}
← {"id": 3, "error": {"reason": "too_few_arms", "message": "…"}}
```

`capabilities` is asked first and must answer; an operation not listed
skips its sections. Lines the harness cannot parse as JSON are ignored (a
process may log to stdout), so an adapter must write each answer as one
complete document followed by `\n`. The harness escapes U+2028 and U+2029
in what it writes (a line reader that treats them as newlines would cut a
canonical-JSON vector in two); an adapter should split on `\n` only. An
operation with no answer in 20 s is a failure. stderr is passed through.

The reference adapter (`adapters/reference.mjs`, exported as
`@airprompter/protocol-conformance/reference`) is the yardstick;
`examples/conformance-adapter/python/adapter.py` in the SDK repository is a
complete JSON-lines adapter over the Python SDK.

## The operations

Field names are the protocol's (camelCase). Every number is a JSON number;
bytes travel base64url. `→` is the arguments object, `←` the result object;
"refuses" names the `error.reason` values the vectors expect.

| Section | Operation | → | ← |
|---|---|---|---|
| canonical-json | `canonicalJson` | `{ json }` — the input as raw JSON text (parse it yourself; the vectors include integers at the safe boundary) | `{ text, sha256 }` — the canonical form and `sha256:<hex>` of its UTF-8 bytes; refuses `non_integer_number`, `unsafe_integer` |
| workflow-steps | `orderedSteps` | `{ slotTag, steps }` | `{ order: [stepId…] }`; refuses `slot_tag_grammar`, `step_ordinal_gap`, `step_tag_mismatch` |
| assignment, ramp | `assignArm` | `{ salt, subject, arms: [{ arm, weightBps }] }` | `{ subjectHash, bucket, arm }` — the arm's **name**; refuses `salt_invalid`, `too_few_arms`, `weight_invalid`, `weights_not_10000` |
| ramp | `validateRamp` | `{ ramp, armCount }` | `{ ok: true }`; refuses `ramp_invalid` |
| ramp | `rampWeightsAt` | `{ arms, ramp, nowMs }` | `{ weightBps: [n…] }` |
| ramp | `effectiveArms` | `{ arms, ramp, disabledArms: [name…], nowMs }` | `{ arms: [{ arm, weightBps }] }` — the arms in force now, a disabled arm's share back on the control |
| trust-root | `verifyRootMetadata` | `{ candidate, now, trusted? , pinned?: { purpose, environment, pinnedRoot } }` — one of `trusted` (a root document) or `pinned` (derive the trusted root from the pinned key) | `{ ok, reason? }` |
| trust-manifest | `verifyManifest` | `{ manifest, root, now, scope, storedGeneration, payloads: [{ contentHash, bytes }] \| null, countersignRoot \| null, requireCountersign }` | `{ ok, signingKeyId?, generation?, reason? }` |
| spool-basics | `latencyBucketIndex` | `{ latencyMs }` | `{ bucket }` |
| spool-basics | `minuteOf` | `{ epochMs }` | `{ minute, epochMinute }` |
| spool-basics | `segmentName` | `{ instanceId, epochMs, n }` | `{ name }` |
| spool-rotation | `planSegments` | `{ instanceId, appends: [{ epochMs, lineBytes }] }` | `{ plan: [{ segment, rotated }] }` — one entry per append, in order, from one planner |
| spool-windows | `aggregateWindows` | `{ instanceId, instanceClass, sdk, events: [{ kind: observe \| feedback \| close, at, observation? \| feedback? }] }` | `{ windows: [row…] }` — the window rows the spool writer emitted, any order |
| feedback | `normalizeFeedback` | `{ signals }` | `{ normalized: { accepted, outcomes, rejected } }` |
| checks | `evaluateChecks` | `{ checks, input: { text, outputTokens } }` | `{ evaluation: { passed, failed, results } }` |
| checks | `patternRefusal` | `{ pattern }` | `{ refusal }` — a reason or `null` |
| checks | `checksRefusals` | `{ checks }` | `{ refusals: [{ name, reason }] }` |
| checks | `projectChecks` | `{ checks }` | `{ projected: [check…] }` |
| otel | `spoolRowsToOtlp` | `{ rows, resource, sdkVersion }` | `{ request }` — one OTLP/HTTP JSON `ExportMetricsServiceRequest` |

Results are compared key-order-insensitively; a refusal is compared by
`reason` alone. A canonical-JSON refusal the vectors express only in
JavaScript (an `undefined` member, a non-finite number, a `Date`, a cycle)
is not sent to any adapter.
