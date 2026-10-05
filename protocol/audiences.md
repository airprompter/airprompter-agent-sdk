# Audience targeting · protocol 1.0.0

An audience is either **All devices**, or one list of exact `key=value` conditions with **All** / **Any** matching. `device_id=device-042` is an ordinary condition. Multiple regions, users or devices use the same rule editor. Missing keys never equal empty strings; matching is case sensitive and does not trim or normalize Unicode.

The SDK accepts local tags at start, through `setTags` / `set_tags`, and on a prompt handle. Call tags override process tags. Each render captures an immutable local snapshot before awaiting variable sources. Values remain local: no observed values, value hashes or device directory are registered. After an authenticated service capability response, heartbeat registration carries only bounded tag key names and prompt tags/display names. A signed audience release also establishes that capability. Old services receive their existing heartbeat shape.

The operator supplies selector values in AirPrompter. These authored values are part of the signed rule and are visible to every recipient of the Agent/environment broadcast. They are not a device inventory. Every recipient verifies the release before evaluating the rule locally. A nonmatching recipient serves the promoted slot, with arm `none`; a matching recipient enters the experiment's existing sticky allocation and signed ramp. Percentage applies within the matching audience. A single device is guaranteed the candidate only at 100% with instance allocation.

## Compatibility

Every major-1 release requires protocol **1.0.0**, `requiredCapabilities: ["audience_v1"]`, and bounded observations, even when its selector covers all devices. Each per-prompt experiment also names its observed audience explicitly. Earlier SDKs accept any minor within major 0 and would ignore new targeting fields: a 0.4.0 release using this wire is therefore unsafe. Major 1 makes those SDKs refuse the update and retain their last verified release. New SDKs still accept legacy major-0 releases. Unknown major-1 versions, missing capability negotiation, unknown capabilities and malformed audience rules are refused before payload application.

SDK packages advance together to 0.4.0. This source change does not publish packages, deploy a service, create a live experiment or activate a ramp. The hosted service must advertise support before registration, mint immutable audience IDs, and publish compatible signed releases.

## Observation and feedback

The service mints an opaque `aud_` ID for an immutable prompt audience and publishes its observation start before activation, allowing a prospective baseline. The SDK records up to eight sorted, unique matching audience IDs per run, including overlapping audiences without duplicating the run. An empty list means no observed audience matched; it is distinct from legacy telemetry without the extension.

A content-free authenticated run reference freezes audience IDs, original UTC minute, version and arm. It contains no local tags, user or device identity. Delayed feedback remains attributed to that original cohort even after tags or releases change. Version-2 spool windows preserve these dimensions. Feedback-only rows have zero run count and measurements and carry `outcomeRunMinute`; ingestion folds them into the original cohort without adding a run. `thumbs` is `{n, sum}`: good = sum, bad = n−sum, Good rate = sum/n. No feedback yields null, not a bad rating. Run references do not uniquely identify every run, so response coverage must remain unavailable unless a later deduplication contract proves it.

Rendered text alone cannot disambiguate equal text from different cohorts. A bounded text registry keeps such entries ambiguous until eviction; callers use explicit attribution with the captured render. Explicit observation and wrapper scopes preserve original memberships and minute.

Metrics remain in the dedicated Metrics surface. A and B share the same latency graph, with **p50 and p90 both shown** on a common millisecond axis. Compute quantiles from the merged latency histogram; never average bucket percentiles. Token usage compares uncached input, cached input and output per run. Before/after uses equal elapsed windows and actual dates; concurrent comparisons use the same timestamps. Missing observations remain gaps with sample counts. Existing Overview p95 behavior stays compatible.

Bounds and refusal parity are covered by the canonical JSON schemas, shared `vectors/audiences.json`, the independent conformance predicate, and both SDK test suites. The vector generator preserves review-owned expected answers rather than deriving them from an SDK matcher.
