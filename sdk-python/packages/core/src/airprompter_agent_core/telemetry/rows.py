"""The telemetry row schemas (``protocol/spool-format.md``, D52/D66): what a spool segment carries, and nothing
else. There is no field for prompt text, output, or an end-user identifier — the shape is the privacy rule. Pure: the
spool writer (``airprompter_agent_telemetry``) and the wrappers (``airprompter_agent_runtime``) both build on these
without importing each other (S10).

Example::

    observation = Observation(tag="support.reply", version_id="ver_9", arm="none", model="gpt-5", status="ok", latency_ms=812.5,
                              tokens={"input": 640, "output": 120}, usage_source="reported")
    latency_bucket_index(812.5)    # 10: the 512–1024 ms bucket
    minute_of(1_789_221_790_123)   # "2026-09-12T14:03:00Z" — the window a row lands in
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Optional, Union

from .._util import iso_seconds

LATENCY_BUCKET_EDGES_MS = (1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 65536)

ERROR_CLASSES = ("render_missing_variable", "context_length_exceeded", "output_schema_invalid", "truncated", "content_filter", "provider_error", "provider_timeout", "provider_rate_limited")

SpoolRow = dict[str, Any]


@dataclass
class Observation:
    tag: str
    version_id: str
    arm: str
    model: str
    status: str  # "ok" | "error" | "refused"
    latency_ms: float
    error_class: Optional[str] = None
    tokens: Optional[Mapping[str, int]] = None  # input / cachedInput / output
    usage_source: Optional[str] = None  # "reported" | "measured" | "estimated" | "unavailable"
    checks: Optional[Mapping[str, int]] = None  # passed / failed
    outcomes: Optional[Mapping[str, Union[int, float, bool]]] = None

    @classmethod
    def from_wire(cls, row: Mapping[str, Any]) -> "Observation":
        """The protocol's camelCase shape (as the conformance vectors carry it)."""
        return cls(
            tag=row["tag"],
            version_id=row["versionId"],
            arm=row["arm"],
            model=row["model"],
            status=row["status"],
            latency_ms=row["latencyMs"],
            error_class=row.get("errorClass"),
            tokens=row.get("tokens"),
            usage_source=row.get("usageSource"),
            checks=row.get("checks"),
            outcomes=row.get("outcomes"),
        )


def latency_bucket_index(latency_ms: float) -> int:
    for index, edge in enumerate(LATENCY_BUCKET_EDGES_MS):
        if latency_ms <= edge:
            return index
    return len(LATENCY_BUCKET_EDGES_MS) - 1


def minute_of(epoch_ms: float) -> str:
    return iso_seconds(int(epoch_ms) // 60000 * 60000)


def epoch_minute(epoch_ms: float) -> int:
    return int(epoch_ms) // 60000
