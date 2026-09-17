"""Independent generator for protocol/vectors/otel-mapping.json (S13).

Written from the prose in docs/telemetry.md › "Exporting to OpenTelemetry"
and spool-format.md, not from any SDK: how a spool segment's rows become one
OTLP/HTTP JSON ExportMetricsServiceRequest — the resource, the scope, the
duration histogram in seconds with the spool's fixed buckets, the token,
check, feedback, refusal and dropped sums (delta, monotonic), the attribute
names, the minute's start and end in nanoseconds. Two implementations
agreeing on this file is the point. Usage::

    python3 protocol/tools/gen_otel_vectors.py protocol/vectors/otel-mapping.json
"""
import datetime as dt
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROTOCOL = open(os.path.join(HERE, "..", "VERSION"), encoding="utf-8").read().strip()
EDGES = json.load(open(os.path.join(HERE, "..", "schemas", "latency-buckets.json"), encoding="utf-8"))["edges"]

DELTA = 1  # AGGREGATION_TEMPORALITY_DELTA
SCOPE_NAME = "airprompter"


def nanos(iso: str) -> str:
    text = iso.replace("Z", "+00:00")
    return str(int(dt.datetime.fromisoformat(text).timestamp()) * 1_000_000_000)


def attr(key, value):
    if isinstance(value, bool):
        return {"key": key, "value": {"boolValue": value}}
    if isinstance(value, int):
        return {"key": key, "value": {"intValue": str(value)}}
    if isinstance(value, float):
        return {"key": key, "value": {"doubleValue": value}}
    return {"key": key, "value": {"stringValue": str(value)}}


def resource_of(rows, extra):
    first = rows[0]
    sdk = str(first.get("sdk") or "")
    name, _, version = sdk.partition("/")
    attrs = [attr("service.instance.id", first["instanceId"])]
    if first.get("instanceClass"):
        attrs.append(attr("airprompter.instance.class", first["instanceClass"]))
    if name:
        attrs.append(attr("telemetry.sdk.name", name))
    if version:
        attrs.append(attr("telemetry.sdk.version", version))
    for key in sorted(extra):
        attrs.append(attr(key, extra[key]))
    return {"attributes": attrs}


def window_attrs(row):
    attrs = [
        attr("gen_ai.request.model", row["model"]),
        attr("airprompter.prompt.tag", row["tag"]),
        attr("airprompter.prompt.version", row["versionId"]),
        attr("airprompter.prompt.arm", row["arm"]),
        attr("airprompter.status", row["status"]),
        attr("airprompter.usage.source", row["usageSource"]),
    ]
    if row.get("errorClass"):
        attrs.append(attr("error.type", row["errorClass"]))
    return attrs


def sum_point(value, attrs, start, end):
    return {"attributes": attrs, "startTimeUnixNano": start, "timeUnixNano": end, "asInt": str(int(value))}


def sum_metric(name, unit, points, description):
    return {"name": name, "description": description, "unit": unit, "sum": {"aggregationTemporality": DELTA, "isMonotonic": True, "dataPoints": points}}


def to_otlp(rows, resource_extra=None, sdk_version="0.1.0"):
    """The mapping, as prose says it: one request per segment; one data point per row per metric."""
    resource_extra = resource_extra or {}
    duration, tokens, checks, feedback_n, feedback_sum, refusals, dropped_segments, dropped_bytes = [], [], [], [], [], [], [], []
    for row in rows:
        if row["type"] == "window":
            start = nanos(row["minute"])
            end = str(int(start) + 60 * 1_000_000_000)
            attrs = window_attrs(row)
            duration.append({
                "attributes": attrs,
                "startTimeUnixNano": start,
                "timeUnixNano": end,
                "count": str(row["count"]),
                "sum": row["latencyMs"]["sum"] / 1000,
                "bucketCounts": [str(c) for c in row["latencyMs"]["buckets"]],
                "explicitBounds": [edge / 1000 for edge in EDGES[:-1]],
            })
            t = row["tokens"]
            for kind, value in (("input", t.get("input", 0)), ("cached_input", t.get("cachedInput", 0)), ("output", t.get("output", 0))):
                tokens.append(sum_point(value, attrs + [attr("gen_ai.token.type", kind)], start, end))
            if row.get("checks"):
                for outcome in ("passed", "failed"):
                    checks.append(sum_point(row["checks"][outcome], attrs + [attr("airprompter.check.outcome", outcome)], start, end))
            for signal in sorted(row.get("outcomes") or {}):
                stat = row["outcomes"][signal]
                feedback_n.append(sum_point(stat["n"], attrs + [attr("airprompter.feedback.signal", signal)], start, end))
                feedback_sum.append({"attributes": attrs + [attr("airprompter.feedback.signal", signal)], "startTimeUnixNano": start, "timeUnixNano": end, "asDouble": float(stat["sum"])})
        elif row["type"] == "refusal":
            at = nanos(row["at"][:19] + "Z") if len(row["at"]) > 20 else nanos(row["at"])
            attrs = [attr("airprompter.refusal.reason", row["reason"]), attr("airprompter.generation", row["generation"])]
            if row.get("tag"):
                attrs.append(attr("airprompter.prompt.tag", row["tag"]))
            refusals.append(sum_point(1, attrs, at, at))
        elif row["type"] == "dropped":
            at = nanos(row["at"][:19] + "Z") if len(row["at"]) > 20 else nanos(row["at"])
            dropped_segments.append(sum_point(row["segments"], [], at, at))
            dropped_bytes.append(sum_point(row["bytes"], [], at, at))
    metrics = []
    if duration:
        metrics.append({"name": "gen_ai.client.operation.duration", "description": "Model call duration per prompt, version, arm and model; the spool's minute window as a delta histogram.", "unit": "s", "histogram": {"aggregationTemporality": DELTA, "dataPoints": duration}})
    if tokens:
        metrics.append(sum_metric("airprompter.tokens", "{token}", tokens, "Tokens per window by gen_ai.token.type (input, cached_input, output)."))
    if checks:
        metrics.append(sum_metric("airprompter.checks", "{check}", checks, "Declared output checks per window by outcome."))
    if feedback_n:
        metrics.append(sum_metric("airprompter.feedback.count", "{signal}", feedback_n, "Feedback signals recorded per window."))
        metrics.append({"name": "airprompter.feedback.sum", "description": "The sum of a feedback signal's values per window (a rate is sum / count).", "unit": "1", "sum": {"aggregationTemporality": DELTA, "isMonotonic": False, "dataPoints": feedback_sum}})
    if refusals:
        metrics.append(sum_metric("airprompter.refusals", "{refusal}", refusals, "Renders refused, by reason and generation."))
    if dropped_segments:
        metrics.append(sum_metric("airprompter.spool.dropped_segments", "{segment}", dropped_segments, "Spool segments evicted by a budget: the loss, reported."))
        metrics.append(sum_metric("airprompter.spool.dropped_bytes", "By", dropped_bytes, "Bytes evicted by a budget."))
    return {"resourceMetrics": [{"resource": resource_of(rows, resource_extra), "scopeMetrics": [{"scope": {"name": SCOPE_NAME, "version": sdk_version}, "metrics": metrics}]}]}


def main(out_path: str) -> None:
    buckets = [0] * len(EDGES)
    buckets[5] = 2
    buckets[7] = 1
    window = {
        "type": "window", "v": 1, "minute": "2026-09-12T14:03:00Z", "instanceId": "i-writer-a", "instanceClass": "resident",
        "tag": "support.triage", "versionId": "rev-4", "arm": "candidate", "model": "claude-sonnet-5", "status": "ok", "errorClass": None,
        "usageSource": "reported", "count": 3, "latencyMs": {"buckets": buckets, "sum": 250}, "tokens": {"input": 900, "cachedInput": 300, "output": 210},
        "checks": {"passed": 5, "failed": 1}, "outcomes": {"accepted": {"n": 2, "sum": 2}, "rating": {"n": 1, "sum": 4}}, "sdk": "agent-sdk-ts/0.1.0",
    }
    error_window = {
        "type": "window", "v": 1, "minute": "2026-09-12T14:03:00Z", "instanceId": "i-writer-a", "instanceClass": "resident",
        "tag": "support.triage", "versionId": "rev-4", "arm": "control", "model": "claude-sonnet-5", "status": "error", "errorClass": "provider_timeout",
        "usageSource": "unavailable", "count": 1, "latencyMs": {"buckets": [0] * 15 + [1], "sum": 30000}, "tokens": {"input": 0, "output": 0}, "sdk": "agent-sdk-ts/0.1.0",
    }
    refusal = {"type": "refusal", "v": 1, "at": "2026-09-12T14:03:07Z", "instanceId": "i-writer-a", "reason": "lease_expired", "generation": 41, "tag": None}
    dropped = {"type": "dropped", "v": 1, "at": "2026-09-12T14:04:00Z", "instanceId": "i-writer-a", "segments": 2, "bytes": 1048576}
    cases = [
        {"name": "one window with every field: the duration histogram in seconds, the three token sums, checks, feedback count and sum", "rows": [window], "resource": {"service.name": "support-bot"}, "expected": to_otlp([window], {"service.name": "support-bot"})},
        {"name": "an error window: error.type carries the class; unavailable usage; the overflow bucket", "rows": [error_window], "resource": {}, "expected": to_otlp([error_window])},
        {"name": "a segment of mixed rows: two windows, a refusal, a dropped row — one request, one resource, one scope", "rows": [window, error_window, refusal, dropped], "resource": {"service.name": "support-bot", "deployment.environment": "prod"}, "expected": to_otlp([window, error_window, refusal, dropped], {"service.name": "support-bot", "deployment.environment": "prod"})},
    ]
    doc = {
        "$comment": "Generated by protocol/tools/gen_otel_vectors.py; every SDK's OpenTelemetry bridge must produce exactly `expected` from `rows` (OTLP/HTTP JSON encoding, ExportMetricsServiceRequest). Timestamps are the window's minute and its end, in nanoseconds as strings; sums are delta and monotonic except feedback.sum; the duration histogram carries the spool's fixed buckets in seconds with the last bucket as overflow.",
        "protocol": PROTOCOL,
        "scope": SCOPE_NAME,
        "explicitBoundsSeconds": [edge / 1000 for edge in EDGES[:-1]],
        "cases": cases,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "vectors", "otel-mapping.json"))
