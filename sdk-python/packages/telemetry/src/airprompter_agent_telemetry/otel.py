"""The spool as an OpenTelemetry exporter (S13).

A segment's rows become one OTLP/HTTP JSON ``ExportMetricsServiceRequest``
— ``gen_ai.client.operation.duration`` as a delta histogram in seconds with
the spool's fixed buckets, the token / check / feedback / refusal / dropped
sums — and go to the collector the customer already runs, never to
AirPrompter: no Agent key, no grant, no second sidecar. ``OtlpUploadSink`` is
an ``UploadSink`` for ``SpoolUploader``; the uploader still owns the spool
(sweep, budget, quarantine, delete on ack); this module only maps and
exports.

Rules:

- **Drop and count on a collector's refusal.** A collector that answers
  4xx / 5xx has decided: the segment is dropped, counted (``droppedSegments``
  in status, ``segment_dropped_by_sink`` in the log) and the next one is
  tried — never a spool that fills behind a misconfigured collector. A
  ``429`` / ``503`` with ``Retry-After`` is a hold for that long, the segment
  kept. A collector that never answered (connection refused, timeout — a
  restart mid-pass) has not decided: ``failed``, the segment kept under the
  uploader's backoff and the budget, so a blip does not wipe a backlog.
- **Nothing here reads a prompt.** The attribute keys are a closed set; the
  rows carry no text.
- **Exporter-pluggable.** ``endpoint`` uses httpx and the OTLP/HTTP JSON
  encoding (no OpenTelemetry dependency); ``exporter`` takes any callable
  ``(request) -> ExportResult | None`` — the OpenTelemetry SDK's own OTLP
  exporter wrapped in a few lines, or the customer's — so the protobuf and
  gRPC paths need no code here.

Every SDK's bridge must produce byte-for-byte ``protocol/vectors/otel-mapping.json``;
parity with ``sdk-typescript/packages/otel-bridge``.
"""

from __future__ import annotations

import datetime as dt
import json
import re
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional, Union

import httpx

from airprompter_agent_core import SDK_VERSION
from airprompter_agent_core._util import iso_ms
from airprompter_agent_core.telemetry.upload_sink import UploadOutcome, UploadSegment
from .spool.writer import LATENCY_BUCKET_EDGES_MS

OTLP_SCOPE_NAME = "airprompter"
_DELTA = 1  # AGGREGATION_TEMPORALITY_DELTA
_ISO = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$")

Attribute = dict[str, Any]


def otlp_attribute(key: str, value: Union[str, int, float, bool]) -> Attribute:
    if isinstance(value, bool):
        return {"key": key, "value": {"boolValue": value}}
    if isinstance(value, int):
        return {"key": key, "value": {"intValue": str(value)}}
    if isinstance(value, float):
        return {"key": key, "value": {"intValue": str(int(value))}} if value.is_integer() else {"key": key, "value": {"doubleValue": value}}
    return {"key": key, "value": {"stringValue": str(value)}}


def _nanos(iso: str) -> str:
    """Whole seconds of an RFC 3339 instant, in nanoseconds as a string (the fraction is floored, as the TypeScript bridge does)."""
    match = _ISO.match(iso)
    if match is None:
        raise ValueError(f"not an RFC 3339 instant: {iso!r}")
    base, zone = match.groups()
    parsed = dt.datetime.fromisoformat(base + ("+00:00" if zone == "Z" else zone))
    return f"{int(parsed.timestamp())}000000000"


def _minute_end(start: str) -> str:
    return str(int(start) + 60_000_000_000)


def _window_attributes(row: Mapping[str, Any]) -> list[Attribute]:
    attrs = [
        otlp_attribute("gen_ai.request.model", row["model"]),
        otlp_attribute("airprompter.prompt.tag", row["tag"]),
        otlp_attribute("airprompter.prompt.version", row["versionId"]),
        otlp_attribute("airprompter.prompt.arm", row["arm"]),
        otlp_attribute("airprompter.status", row["status"]),
        otlp_attribute("airprompter.usage.source", row["usageSource"]),
    ]
    if row.get("errorClass"):
        attrs.append(otlp_attribute("error.type", row["errorClass"]))
    return attrs


def _point(value: Union[int, float], attributes: list[Attribute], start: str, end: str) -> dict[str, Any]:
    return {"attributes": attributes, "startTimeUnixNano": start, "timeUnixNano": end, "asInt": str(int(value))}


def _sum_metric(name: str, unit: str, points: list[dict[str, Any]], description: str, monotonic: bool = True) -> dict[str, Any]:
    return {"name": name, "description": description, "unit": unit, "sum": {"aggregationTemporality": _DELTA, "isMonotonic": monotonic, "dataPoints": points}}


def spool_rows_to_otlp(rows: list[Mapping[str, Any]], *, resource: Optional[Mapping[str, Union[str, int, float, bool]]] = None, sdk_version: str = SDK_VERSION) -> dict[str, Any]:
    """A segment's rows as one OTLP/HTTP JSON request. Empty rows give a request with no metrics."""
    first = rows[0] if rows else None
    sdk_name, _, sdk_ver = str((first or {}).get("sdk") or "").partition("/")
    attributes: list[Attribute] = [otlp_attribute("service.instance.id", first["instanceId"])] if first else []
    if first and first.get("instanceClass"):
        attributes.append(otlp_attribute("airprompter.instance.class", first["instanceClass"]))
    if sdk_name:
        attributes.append(otlp_attribute("telemetry.sdk.name", sdk_name))
    if sdk_ver:
        attributes.append(otlp_attribute("telemetry.sdk.version", sdk_ver))
    for key in sorted(resource or {}):
        attributes.append(otlp_attribute(key, (resource or {})[key]))
    duration: list[dict[str, Any]] = []
    tokens: list[dict[str, Any]] = []
    checks: list[dict[str, Any]] = []
    feedback_count: list[dict[str, Any]] = []
    feedback_sum: list[dict[str, Any]] = []
    refusals: list[dict[str, Any]] = []
    dropped_segments: list[dict[str, Any]] = []
    dropped_bytes: list[dict[str, Any]] = []
    bounds = [edge / 1000 for edge in LATENCY_BUCKET_EDGES_MS[:-1]]
    for row in rows:
        kind = row.get("type")
        if kind == "window":
            start = _nanos(row["minute"])
            end = _minute_end(start)
            attrs = _window_attributes(row)
            duration.append({"attributes": attrs, "startTimeUnixNano": start, "timeUnixNano": end, "count": str(row["count"]), "sum": row["latencyMs"]["sum"] / 1000, "bucketCounts": [str(c) for c in row["latencyMs"]["buckets"]], "explicitBounds": bounds})
            t = row.get("tokens") or {}
            for token_kind, value in (("input", t.get("input") or 0), ("cached_input", t.get("cachedInput") or 0), ("output", t.get("output") or 0)):
                tokens.append(_point(value, attrs + [otlp_attribute("gen_ai.token.type", token_kind)], start, end))
            if row.get("checks"):
                for outcome in ("passed", "failed"):
                    checks.append(_point(row["checks"][outcome], attrs + [otlp_attribute("airprompter.check.outcome", outcome)], start, end))
            for signal in sorted(row.get("outcomes") or {}):
                stat = row["outcomes"][signal]
                signal_attrs = attrs + [otlp_attribute("airprompter.feedback.signal", signal)]
                feedback_count.append(_point(stat["n"], signal_attrs, start, end))
                feedback_sum.append({"attributes": signal_attrs, "startTimeUnixNano": start, "timeUnixNano": end, "asDouble": float(stat["sum"])})
        elif kind == "refusal":
            at = _nanos(row["at"])
            attrs = [otlp_attribute("airprompter.refusal.reason", row["reason"]), otlp_attribute("airprompter.generation", row["generation"])]
            if row.get("tag"):
                attrs.append(otlp_attribute("airprompter.prompt.tag", row["tag"]))
            refusals.append(_point(1, attrs, at, at))
        elif kind == "dropped":
            at = _nanos(row["at"])
            dropped_segments.append(_point(row["segments"], [], at, at))
            dropped_bytes.append(_point(row["bytes"], [], at, at))
    metrics: list[dict[str, Any]] = []
    if duration:
        metrics.append({"name": "gen_ai.client.operation.duration", "description": "Model call duration per prompt, version, arm and model; the spool's minute window as a delta histogram.", "unit": "s", "histogram": {"aggregationTemporality": _DELTA, "dataPoints": duration}})
    if tokens:
        metrics.append(_sum_metric("airprompter.tokens", "{token}", tokens, "Tokens per window by gen_ai.token.type (input, cached_input, output)."))
    if checks:
        metrics.append(_sum_metric("airprompter.checks", "{check}", checks, "Declared output checks per window by outcome."))
    if feedback_count:
        metrics.append(_sum_metric("airprompter.feedback.count", "{signal}", feedback_count, "Feedback signals recorded per window."))
        metrics.append(_sum_metric("airprompter.feedback.sum", "1", feedback_sum, "The sum of a feedback signal's values per window (a rate is sum / count).", monotonic=False))
    if refusals:
        metrics.append(_sum_metric("airprompter.refusals", "{refusal}", refusals, "Renders refused, by reason and generation."))
    if dropped_segments:
        metrics.append(_sum_metric("airprompter.spool.dropped_segments", "{segment}", dropped_segments, "Spool segments evicted by a budget: the loss, reported."))
        metrics.append(_sum_metric("airprompter.spool.dropped_bytes", "By", dropped_bytes, "Bytes evicted by a budget."))
    return {"resourceMetrics": [{"resource": {"attributes": attributes}, "scopeMetrics": [{"scope": {"name": OTLP_SCOPE_NAME, "version": sdk_version}, "metrics": metrics}]}]}


# ---------------------------------------------------------------------------
# The sink
# ---------------------------------------------------------------------------


@dataclass
class ExportResult:
    ok: bool
    reason: Optional[str] = None
    retry_after_ms: Optional[int] = None


#: Deliver one request; ``None`` or ``ExportResult(ok=True)`` on success; raise or return ``ExportResult(ok=False, …)`` on failure.
Exporter = Callable[[dict[str, Any]], Optional[ExportResult]]


def http_json_exporter(*, endpoint: str, headers: Optional[Mapping[str, str]] = None, transport: Optional[httpx.BaseTransport] = None, timeout: float = 10.0) -> Exporter:
    """OTLP/HTTP with the JSON encoding over httpx: the exporter that needs no dependency."""

    def export(request: dict[str, Any]) -> Optional[ExportResult]:
        try:
            with httpx.Client(transport=transport, timeout=timeout) as http:
                response = http.post(endpoint, headers={"content-type": "application/json", **dict(headers or {})}, content=json.dumps(request, separators=(",", ":")).encode("utf-8"))
        except httpx.TimeoutException:
            return ExportResult(False, "network:timeout")
        except Exception as error:  # noqa: BLE001 — the network is a reason, never an exception on this path
            return ExportResult(False, f"network:{error or 'error'}")
        if 200 <= response.status_code < 300:
            return ExportResult(True)
        retry_after = response.headers.get("retry-after")
        retry_after_ms = int(retry_after) * 1000 if response.status_code in (429, 503) and retry_after and retry_after.isdigit() else None
        return ExportResult(False, f"http_{response.status_code}", retry_after_ms)

    return export


class OtlpUploadSink:
    """An ``UploadSink`` that exports each segment as OTLP metrics; drop-and-count on failure, hold on ``Retry-After``."""

    kind = "otlp"

    def __init__(
        self,
        *,
        endpoint: Optional[str] = None,
        headers: Optional[Mapping[str, str]] = None,
        resource: Optional[Mapping[str, Union[str, int, float, bool]]] = None,
        sdk_version: str = SDK_VERSION,
        exporter: Optional[Exporter] = None,
        transport: Optional[httpx.BaseTransport] = None,
        timeout: float = 10.0,
        now_ms: Optional[Callable[[], float]] = None,
    ):
        if exporter is None:
            if not endpoint:
                raise ValueError("OtlpUploadSink: an endpoint or an exporter is required")
            exporter = http_json_exporter(endpoint=endpoint, headers=headers, transport=transport, timeout=timeout)
        self._exporter = exporter
        self._resource = dict(resource or {})
        self._sdk_version = sdk_version
        self._now_ms = now_ms or (lambda: time.time() * 1000)
        self.exported = 0
        self.dropped = 0
        self.last_export_at: Optional[str] = None
        self.last_error: Optional[str] = None

    def status(self) -> dict[str, Any]:
        return {"exported": self.exported, "dropped": self.dropped, "lastExportAt": self.last_export_at, "lastError": self.last_error}

    def ship(self, segment: UploadSegment) -> UploadOutcome:
        request = spool_rows_to_otlp(segment.rows, resource=self._resource, sdk_version=self._sdk_version)
        try:
            result = self._exporter(request)
        except Exception as error:  # noqa: BLE001
            result = ExportResult(False, f"exporter:{error or 'error'}")
        if result is None or result.ok:
            self.exported += 1
            self.last_export_at = iso_ms(self._now_ms())
            self.last_error = None
            return UploadOutcome("ok")
        self.last_error = result.reason or "failed"
        if result.retry_after_ms is not None and result.retry_after_ms > 0:
            return UploadOutcome("hold", reason=self.last_error, retry_after_ms=result.retry_after_ms)
        # Unanswered (the network, a timeout): not a decision; kept under backoff, bounded by the budget.
        if self.last_error.startswith("network:"):
            return UploadOutcome("failed", reason=self.last_error)
        # Answered: drop and count; the collector's refusal never holds the spool.
        self.dropped += 1
        return UploadOutcome("dropped", reason=self.last_error)


__all__ = ["OTLP_SCOPE_NAME", "ExportResult", "Exporter", "OtlpUploadSink", "http_json_exporter", "otlp_attribute", "spool_rows_to_otlp"]
