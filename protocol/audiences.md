# Audience targeting · protocol 3.x

An audience is either **All devices** (`{ "mode": "all" }`) or a condition tree (`{ "mode": "when", "when": … }`). Every SDK evaluates it locally against tags the application set. `matchesAudience` is the one predicate, and `validAudienceManifest` is where a manifest's selectors are checked.

## Conditions

| Condition | True when |
| -- | -- |
| `{ "all": [ … ] }` | every item is true (1 to 16 items) |
| `{ "any": [ … ] }` | at least one item is true (1 to 16 items) |
| `{ "not": … }` | the item is false |
| `{ "key": "region", "is": "eu-west-1" }` | the tag equals the value |
| `{ "key": "roles", "contains": "admin" }` | the tag contains the value, which is not empty |
| `{ "key": "region", "in": ["eu-west-1", "eu-central-1"] }` | the tag equals one of 1 to 64 unique values |
| `{ "key": "age", "range": { "gte": 18, "lt": 65 } }` | the tag is a decimal in the half-open range; at least one bound, each a safe integer (magnitude at most 2^53 − 1). A fractional tag value is fine |

A leaf alone is depth 1 and each `all`, `any` or `not` adds one, so `all(any(not(leaf)))` is the deepest tree, depth 4. A tree holds at most 32 leaves. The schema pins the depth; the leaf count is `validAudienceManifest`'s.

A selector this reader cannot read loads and matches nothing, whatever sits around the part it cannot read, under `not` and `any` too. An experiment audience it cannot read takes arm `none`, and an observation captures no cohort. An unknown `audienceId` and a selector that differs from its observation stay refused.

A missing key is false for every leaf, and a `not` around that leaf is true. `range` reads the tag as a finite decimal, an optional minus sign then ASCII digits with an optional fraction. Anything else (a word, an empty value, an exponent, a leading plus or space, hexadecimal, `Infinity`, a non-ASCII digit) is false, not an error.

Matching is case sensitive and does not trim or normalize Unicode. Schema length limits count Unicode scalar values: 64 for keys and 256 for values. Unpaired UTF-16 surrogates are refused before matching so every SDK reaches the same decision.

`device_id is device-042` targets one device through the same editor used for regions and other arbitrary SDK tags. There is no separate group or single-target shape.

## Tags

The SDK accepts local tags at start, through `setTags` / `set_tags`, and on a prompt handle. Call tags override process tags. Each render captures an immutable local snapshot before awaiting variable sources. Values remain local: no observed values, value hashes, or device directory are registered.

Every heartbeat may register bounded tag key names and prompt tags with display names. Registration never contains tag values.

The operator supplies selector values in AirPrompter. These authored values are part of the signed rule and are visible to every recipient of the Agent/environment broadcast. They are not a device inventory. Every recipient verifies the release before evaluating the rule locally. A nonmatching recipient serves the promoted slot with arm `none`; a matching recipient enters the experiment's sticky allocation and signed ramp. Percentage applies within the matching audience. A single device receives the candidate deterministically only at 100% with instance allocation.

## In a manifest

`observations` is optional. An experiment may name an audience; when it does, the manifest carries an observation with the same `audienceId`, `tag` and selector. An experiment with no audience allocates across the whole fleet. Selectors with undeclared fields are refused.

## Observation and feedback

The service mints an opaque `aud_` ID for an immutable prompt audience and publishes its observation start before activation, allowing a prospective baseline. The SDK records up to eight sorted, unique matching audience IDs per run, including overlapping audiences without duplicating the run. An empty list means no observed audience matched.

A content-free authenticated run reference freezes the Team prompt artifact ID, version, arm, audience IDs, and original UTC minute for each slot. It contains no local tags, user identity, or device identity. Delayed feedback remains attributed to that original series and cohort even after tags or releases change. Window rows require `artifactId` and may carry audience IDs. Feedback-only rows have zero run count and measurements and carry `outcomeRunMinute`; ingestion folds them into the original cohort without adding a run. `thumbs` is `{n, sum, sumSq}`: good = sum, bad = n−sum, Good rate = sum/n. No feedback yields null.

Rendered text alone cannot disambiguate equal text from different cohorts. A bounded text registry keeps such entries ambiguous until eviction; callers use explicit attribution with the captured render. Explicit observation and wrapper scopes preserve original memberships and minute.

Metrics remain in the dedicated Metrics surface. Every observed prompt/version series for a selected slot shares the same graphs. Latency shows **p50 and p90 together** on a common millisecond axis; compute quantiles from merged histograms and never average bucket percentiles. Token usage compares input and output per run, and feedback compares good and bad counts. Missing observations remain gaps with sample counts.

Bounds and refusal parity are covered by the canonical JSON schemas, shared `vectors/audiences.json`, the independent conformance predicate, and both SDK test suites. `tools/gen_audience_vectors.mjs` holds the expected answers by hand rather than deriving them from an SDK matcher.
