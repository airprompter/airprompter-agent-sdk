"""The telemetry row schemas (``protocol/spool-format.md``, D52/D66): what a spool segment carries, and nothing
else. There is no field for prompt text, output, or an end-user identifier — the shape is the privacy rule. Pure: the
spool writer (``airprompter_agent.telemetry``) and the wrappers (``airprompter_agent.runtime``) both build on these
without importing each other (S10).

``count`` means runs. A window row is a run row (``count`` above 0: the run totals and ``tokensSq``) or a feedback-only
row (``count: 0`` with ``outcomeRunMinute``: outcomes, every measure zero). A step is its own row type, so no fold over
windows can count one.

Example::

    observation = Observation(tag="support.reply", artifact_id="prm_reply", version_id="ver_9", arm="none", model="gpt-5", status="ok", latency_ms=812.5,
                              tokens={"input": 640, "output": 120}, usage_source="reported")
    latency_bucket_index(812.5)    # 10: the 512–1024 ms bucket; anything past the last edge lands in it
    minute_of(1_789_221_790_123)   # "2026-09-12T14:03:00Z" — the window a row lands in
    step_name("planner", seen)     # the name, or "other" past either cap in STEP_BOUNDS
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any, Mapping, Optional, Sequence, Union

from .._util import iso_seconds

#: ``protocol/schemas/latency-buckets.json``: up to one hour; an idle sweep ends a run at 15 minutes by default.
LATENCY_BUCKET_EDGES_MS = (1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576, 2097152, 3600000)

#: The only two caps on a step name. A name past either is written as ``other``.
STEP_BOUNDS = {"maxLength": 64, "maxPerRun": 32}

#: The largest count a row carries, as ``Number.MAX_SAFE_INTEGER`` bounds it in the TypeScript SDK.
_MAX_COUNT = 2**53 - 1

#: The grammar of a slot tag and of an arm. Match it with ``fullmatch``.
SLOT_TAG = re.compile(r"[a-z0-9]+(?:[._-][a-z0-9]+)*")
#: What a writer may put in a row, per row type. A reader's list is the same; a later value is skipped, not refused.
WINDOW_STATUSES = ("ok", "error", "refused", "interrupted")
STEP_STATUSES = ("ok", "error")
USAGE_SOURCES = ("reported", "measured", "estimated", "unavailable")
ERROR_CLASSES = ("render_missing_variable", "context_length_exceeded", "output_schema_invalid", "truncated", "content_filter", "provider_error", "provider_timeout", "provider_rate_limited", "model_unresolved")

SpoolRow = dict[str, Any]


def _audience_ids_of(row: Mapping[str, Any]) -> Optional[tuple[str, ...]]:
    return tuple(row["audienceIds"]) if "audienceIds" in row else None


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
    run_minute: Optional[str] = None
    audience_ids: Optional[tuple[str, ...]] = None
    outcome_run_minute: Optional[str] = None
    #: Required by the writer: it raises ``telemetry_artifact_id_invalid`` without one.
    artifact_id: Optional[str] = None
    #: An opaque step name: a ``<slotTag>#<ordinal>`` step id, or a framework node or agent name.
    step: Optional[str] = None
    tool_calls: Optional[Mapping[str, int]] = None  # calls / errors

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
            run_minute=row.get("runMinute"),
            audience_ids=_audience_ids_of(row),
            outcome_run_minute=row.get("outcomeRunMinute"),
            artifact_id=row.get("artifactId"),
            step=row.get("step"),
            tool_calls=row.get("toolCalls"),
        )


@dataclass
class RunDimensions:
    tag: str
    artifact_id: Optional[str]
    version_id: str
    arm: str
    model: str
    audience_ids: Optional[Sequence[str]] = None
    run_minute: Optional[str] = None

    @classmethod
    def from_wire(cls, row: Mapping[str, Any]) -> "RunDimensions":
        return cls(tag=row["tag"], artifact_id=row.get("artifactId"), version_id=row["versionId"], arm=row["arm"], model=row["model"], audience_ids=_audience_ids_of(row), run_minute=row.get("runMinute"))


@dataclass
class RunTotals:
    """One run's totals on one slot. The only thing that adds to ``count``."""

    dimensions: RunDimensions
    status: str  # "ok" | "error" | "interrupted"
    error_class: Optional[str]
    usage_source: str
    #: 1 when this is the first slot of its run, so an agent-wide total counts a two-slot run once.
    agent_run: int
    model_calls: int
    #: Run wall-clock.
    latency_ms: float
    tokens: Mapping[str, int]  # input / cachedInput / output
    tools: Mapping[str, int]  # calls / errors
    checks: Optional[Mapping[str, int]] = None  # passed / failed

    @classmethod
    def from_wire(cls, row: Mapping[str, Any]) -> "RunTotals":
        return cls(dimensions=RunDimensions.from_wire(row["dimensions"]), status=row["status"], error_class=row.get("errorClass"), usage_source=row["usageSource"], agent_run=row["agentRun"], model_calls=row["modelCalls"], latency_ms=row["latencyMs"], tokens=row["tokens"], tools=row["tools"], checks=row.get("checks"))


@dataclass
class StepTotals:
    """One step's totals. ``latency`` holds each model call's latency; its bucket total equals ``model_calls``."""

    dimensions: RunDimensions
    step: str
    status: str  # "ok" | "error"
    error_class: Optional[str]
    usage_source: str
    model_calls: int
    latency: Mapping[str, Any]  # buckets / sum
    tokens: Mapping[str, int]  # input / cachedInput / output
    tools: Mapping[str, int]  # calls / errors

    @classmethod
    def from_wire(cls, row: Mapping[str, Any]) -> "StepTotals":
        return cls(dimensions=RunDimensions.from_wire(row["dimensions"]), step=row["step"], status=row["status"], error_class=row.get("errorClass"), usage_source=row["usageSource"], model_calls=row["modelCalls"], latency=row["latency"], tokens=row["tokens"], tools=row["tools"])


def latency_bucket_index(latency_ms: float) -> int:
    for index, edge in enumerate(LATENCY_BUCKET_EDGES_MS):
        if latency_ms <= edge:
            return index
    return len(LATENCY_BUCKET_EDGES_MS) - 1


def valid_step_name(name: Any) -> bool:
    """A name the step grammar admits: 1 to 64 characters, no control character, no lone surrogate."""
    if not isinstance(name, str) or not 1 <= len(name) <= STEP_BOUNDS["maxLength"]:
        return False
    return not any(ord(char) < 0x20 or ord(char) == 0x7F or 0xD800 <= ord(char) <= 0xDFFF for char in name)


def step_name(name: Any, seen: set[str]) -> str:
    """The name to write: itself, or ``other`` past either cap. ``seen`` holds the names already counted against ``maxPerRun``."""
    if not valid_step_name(name):
        return "other"
    if name == "other" or name in seen:
        return name
    if len(seen) >= STEP_BOUNDS["maxPerRun"]:
        return "other"
    seen.add(name)
    return name


def count_of(value: Any) -> int:
    """A count a row may carry: a non-negative integer, whatever a caller handed in."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    try:
        return min(_MAX_COUNT, max(0, int(value))) if math.isfinite(value) else 0
    except OverflowError:  # an integer past every double: JavaScript reads it as Infinity
        return 0


def utf16_length(value: str) -> int:
    """A string's length as the other SDK and every JavaScript reader count it: a character past U+FFFF is two."""
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def minute_of(epoch_ms: float) -> str:
    return iso_seconds(int(epoch_ms) // 60000 * 60000)


def epoch_minute(epoch_ms: float) -> int:
    return int(epoch_ms) // 60000
