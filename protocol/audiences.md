# Audience targeting · protocol 2.0.0

An audience is either **All devices** (`{ "mode": "all" }`) or a non-empty list of tag conditions (`{ "mode": "tags", "conditions": [...] }`). Each condition is `key is value` or `key contains value`. Multiple conditions are an implicit conjunction: every condition must match. `device_id is device-042` targets one device through the same editor used for regions and other arbitrary SDK tags.

Matching is case sensitive and does not trim or normalize Unicode. Schema length limits count Unicode scalar values: 64 for keys and 256 for values. Unpaired UTF-16 surrogates are refused before matching so every SDK reaches the same decision. Missing keys never match. There is no separate group/single-target shape and no configurable all/any selector.

The SDK accepts local tags at start, through `setTags` / `set_tags`, and on a prompt handle. Call tags override process tags. Each render captures an immutable local snapshot before awaiting variable sources. Values remain local: no observed values, value hashes, or device directory are registered.

Every SDK heartbeat advertises protocol **2.0.0** with `capabilities: ["audience"]`. The first heartbeat carries no registration. After the authenticated service response echoes the same protocol and capability, later heartbeats may register bounded tag key names and prompt tags/display names. Registration never contains tag values.

The operator supplies selector values in AirPrompter. These authored values are part of the signed rule and are visible to every recipient of the Agent/environment broadcast. They are not a device inventory. Every recipient verifies the release before evaluating the rule locally. A nonmatching recipient serves the promoted slot with arm `none`; a matching recipient enters the experiment's sticky allocation and signed ramp. Percentage applies within the matching audience. A single device receives the candidate deterministically only at 100% with instance allocation.

## Compatibility

Targeted releases require protocol **2.0.0**, `requiredCapabilities: ["audience"]`, and bounded observations, even when the selector covers all devices. Each per-prompt experiment names its observed audience explicitly. The SDK refuses targeted envelopes from other protocol majors, missing or unknown capabilities, selectors with undeclared fields, and conditions without an explicit `is` or `contains` operator. Non-targeted major-zero manifests remain readable.

SDK packages advance together to 0.5.0. The hosted service must echo support before registration, mint immutable audience IDs, and publish compatible signed releases.

## Observation and feedback

The service mints an opaque `aud_` ID for an immutable prompt audience and publishes its observation start before activation, allowing a prospective baseline. The SDK records up to eight sorted, unique matching audience IDs per run, including overlapping audiences without duplicating the run. An empty list means no observed audience matched.

A content-free authenticated run reference freezes the Team prompt artifact ID, version, arm, audience IDs, and original UTC minute. It contains no local tags, user identity, or device identity. Delayed feedback remains attributed to that original series and cohort even after tags or releases change. Version-3 spool windows require `artifactId` and may carry audience IDs. Feedback-only rows have zero run count and measurements and carry `outcomeRunMinute`; ingestion folds them into the original cohort without adding a run. `thumbs` is `{n, sum}`: good = sum, bad = n−sum, Good rate = sum/n. No feedback yields null.

Rendered text alone cannot disambiguate equal text from different cohorts. A bounded text registry keeps such entries ambiguous until eviction; callers use explicit attribution with the captured render. Explicit observation and wrapper scopes preserve original memberships and minute.

Metrics remain in the dedicated Metrics surface. Every observed prompt/version series for a selected slot shares the same graphs. Latency shows **p50 and p90 together** on a common millisecond axis; compute quantiles from merged histograms and never average bucket percentiles. Token usage compares input and output per run, and feedback compares good and bad counts. Missing observations remain gaps with sample counts. Existing Overview p95 behavior stays compatible.

Bounds and refusal parity are covered by the canonical JSON schemas, shared `vectors/audiences.json`, the independent conformance predicate, and both SDK test suites. The vector generator preserves review-owned expected answers rather than deriving them from an SDK matcher.
