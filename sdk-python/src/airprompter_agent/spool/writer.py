"""The spool writer (``protocol/spool-format.md``, D52/D66).

Minute windows accumulate in memory per dimension set
``(tag, versionId, arm, model, status, errorClass)`` and are written as
``window`` rows when the minute closes. Segments are append-only NDJSON
under ``<store>/spool/telemetry/``, open as
``seg-<inst>-<epochMinute>-<n>.ndjson.open``, closed by fsync + rename;
rotated at the minute boundary or 1 MiB. Nothing here can carry prompt
text, output, or an end-user identifier — the row shape has no field for
them. Serverless hosts use the memory sink and flush at invocation end.
"""

from __future__ import annotations

import json
import math
import os
import re
import threading
from dataclasses import dataclass
from typing import Any, Mapping, Optional, Union

from .._util import fsync_dir, iso_seconds, now_ms

LATENCY_BUCKET_EDGES_MS = (1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 65536)
SEGMENT_MAX_BYTES = 1024 * 1024
#: A host keeps this much closed, unsent spool before the oldest segments are evicted (spool-format.md).
HOST_SPOOL_BUDGET_BYTES = 100 * 1024 * 1024
#: A serverless invocation keeps this much in memory; beyond it the oldest rows go and a ``dropped`` row says so.
SERVERLESS_BUFFER_BYTES = 256 * 1024

ERROR_CLASSES = ("render_missing_variable", "context_length_exceeded", "output_schema_invalid", "truncated", "content_filter", "provider_error", "provider_timeout", "provider_rate_limited")
_OUTCOME_NAME = re.compile(r"^[a-z][a-zA-Z0-9]{0,31}$")

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


def _row_bytes(row: Mapping[str, Any]) -> bytes:
    return (json.dumps(row, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def latency_bucket_index(latency_ms: float) -> int:
    for index, edge in enumerate(LATENCY_BUCKET_EDGES_MS):
        if latency_ms <= edge:
            return index
    return len(LATENCY_BUCKET_EDGES_MS) - 1


def minute_of(epoch_ms: float) -> str:
    return iso_seconds(int(epoch_ms) // 60000 * 60000)


def epoch_minute(epoch_ms: float) -> int:
    return int(epoch_ms) // 60000


def segment_name(instance_id: str, minute: int, n: int) -> str:
    return f"seg-{instance_id}-{minute}-{n}.ndjson"


class SegmentPlanner:
    """Which segment an appended line lands in: a new one on a new minute, or when the line would push past 1 MiB. Pure; ``protocol/vectors/spool.json`` pins it."""

    def __init__(self, instance_id: str):
        self.instance_id = instance_id
        self.open_minute: Optional[int] = None
        self.open_bytes = 0
        self.n = 0

    def append(self, epoch_ms: float, line_bytes: int) -> tuple[str, bool]:
        minute = epoch_minute(epoch_ms)
        rotated = self.open_minute is None or minute != self.open_minute or self.open_bytes + line_bytes > SEGMENT_MAX_BYTES
        if rotated:
            self.n = self.n + 1 if minute == self.open_minute else 0
            self.open_minute = minute
            self.open_bytes = 0
        self.open_bytes += line_bytes
        return segment_name(self.instance_id, self.open_minute or 0, self.n), rotated


class SpoolSink:
    """Where rows go: a directory of segments, or memory (serverless)."""

    def append(self, row: SpoolRow, now_ms_: float) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def flush(self, now_ms_: Optional[float] = None) -> None:  # pragma: no cover - interface
        raise NotImplementedError


def _dropped_row(instance_id: str, at_ms: float, segments: int, byte_count: int) -> SpoolRow:
    return {"type": "dropped", "v": 1, "at": iso_seconds(at_ms), "instanceId": instance_id, "segments": segments, "bytes": byte_count}


class MemorySink(SpoolSink):
    """The serverless buffer: rows in memory up to ``budget_bytes`` (256 KiB by default). When a row would push past the
    budget the OLDEST rows are evicted and counted; the next drain (invocation end) hands back the surviving rows
    followed by one ``dropped`` row carrying the count and the bytes lost, so an over-chatty invocation is reported, never silent."""

    def __init__(self, identity: Optional[Mapping[str, str]] = None, budget_bytes: int = SERVERLESS_BUFFER_BYTES):
        self.rows: list[SpoolRow] = []
        self._identity = dict(identity) if identity else None
        self._budget = budget_bytes
        self._bytes = 0
        self._dropped_rows = 0
        self._dropped_bytes = 0
        self._lock = threading.Lock()

    def append(self, row: SpoolRow, now_ms_: float = 0) -> None:
        size = len(_row_bytes(row))
        with self._lock:
            self.rows.append(row)
            self._bytes += size
            while self._bytes > self._budget and len(self.rows) > 1:
                oldest = self.rows.pop(0)
                lost = len(_row_bytes(oldest))
                self._bytes -= lost
                self._dropped_rows += 1
                self._dropped_bytes += lost

    def flush(self, now_ms_: Optional[float] = None) -> None:
        return None

    def drain(self, at_ms: Optional[float] = None) -> list[SpoolRow]:
        """The buffered rows, then a ``dropped`` row when eviction happened since the last drain."""
        with self._lock:
            rows = self.rows
            self.rows = []
            self._bytes = 0
            if self._dropped_rows > 0 and self._identity:
                rows.append(_dropped_row(self._identity["instanceId"], now_ms() if at_ms is None else at_ms, self._dropped_rows, self._dropped_bytes))
                self._dropped_rows = 0
                self._dropped_bytes = 0
            return rows

    @property
    def dropped(self) -> dict[str, int]:
        return {"rows": self._dropped_rows, "bytes": self._dropped_bytes}


class DirectorySink(SpoolSink):
    def __init__(self, directory: str, instance_id: str, budget_bytes: int = HOST_SPOOL_BUDGET_BYTES):
        self.dir = directory
        self._instance_id = instance_id
        self._budget = budget_bytes
        self._fd: Optional[int] = None
        self._open_path: Optional[str] = None
        self._planner = SegmentPlanner(instance_id)
        self._lock = threading.RLock()
        os.makedirs(os.path.join(directory, "sent"), mode=0o700, exist_ok=True)
        os.makedirs(os.path.join(directory, "quarantine"), mode=0o700, exist_ok=True)
        self._recover_open_segments()

    def _recover_open_segments(self) -> None:
        """A writer that crashed left ``.open`` files; the same writer closes them on its next start (a partial last line is the daemon's to skip)."""
        prefix = f"seg-{self._instance_id}-"
        for name in os.listdir(self.dir):
            if name.startswith(prefix) and name.endswith(".ndjson.open"):
                path = os.path.join(self.dir, name)
                fd = os.open(path, os.O_RDWR)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
                os.replace(path, path[: -len(".open")])

    def append(self, row: SpoolRow, now_ms_: float) -> None:
        line = _row_bytes(row)
        with self._lock:
            segment, rotated = self._planner.append(now_ms_, len(line))
            if rotated or self._fd is None:
                self.flush(now_ms_)
                # A name already on disk (a previous process of the same instance in the same minute) is skipped, never appended to.
                name = segment
                while os.path.exists(os.path.join(self.dir, name)) or os.path.exists(os.path.join(self.dir, f"{name}.open")):
                    self._planner.n += 1
                    name = segment_name(self._instance_id, self._planner.open_minute or 0, self._planner.n)
                self._open_path = os.path.join(self.dir, f"{name}.open")
                self._fd = os.open(self._open_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            os.write(self._fd, line)

    def flush(self, now_ms_: Optional[float] = None) -> None:
        with self._lock:
            if self._fd is None or not self._open_path:
                return
            self._close_open()
            # Over budget after this close: evict the oldest, then write the loss as its own small closed segment, at once.
            evicted = self._enforce_budget()
            if evicted:
                at = now_ms() if now_ms_ is None else now_ms_
                self.append(_dropped_row(self._instance_id, at, evicted[0], evicted[1]), at)
                self._close_open()

    def _close_open(self) -> None:
        if self._fd is None or not self._open_path:
            return
        os.fsync(self._fd)
        os.close(self._fd)
        os.replace(self._open_path, self._open_path[: -len(".open")])
        fsync_dir(self.dir)
        self._fd = None
        self._open_path = None

    def _enforce_budget(self) -> Optional[tuple[int, int]]:
        """Over the host budget: evict the OLDEST closed, unsent segments and say how much went (spool-format.md)."""
        sizes = [(name, os.path.getsize(os.path.join(self.dir, name))) for name in self.closed_segments()]
        total = sum(size for _name, size in sizes)
        evicted = 0
        evicted_bytes = 0
        for name, size in sizes:
            if total <= self._budget:
                break
            os.remove(os.path.join(self.dir, name))
            total -= size
            evicted += 1
            evicted_bytes += size
        return (evicted, evicted_bytes) if evicted > 0 else None

    def closed_segments(self) -> list[str]:
        return sorted(name for name in os.listdir(self.dir) if name.startswith("seg-") and name.endswith(".ndjson"))

    def depth(self) -> dict[str, int]:
        segments = self.closed_segments()
        return {"segments": len(segments), "bytes": sum(os.path.getsize(os.path.join(self.dir, name)) for name in segments)}


@dataclass
class WriterIdentity:
    instance_id: str
    instance_class: str  # "resident" | "ephemeral"
    sdk: str


def _merge_outcomes(row: SpoolRow, outcomes: Mapping[str, Union[int, float, bool]]) -> None:
    merged = row.setdefault("outcomes", {})
    for name, value in outcomes.items():
        if not isinstance(name, str) or not _OUTCOME_NAME.match(name):
            continue
        if isinstance(value, bool):
            numeric: Union[int, float] = 1 if value else 0
        elif isinstance(value, (int, float)) and math.isfinite(value):
            numeric = value
        else:
            continue
        current = merged.get(name) or {"n": 0, "sum": 0}
        merged[name] = {"n": current["n"] + 1, "sum": current["sum"] + numeric}


class SpoolWriter:
    """Accumulates observations into minute windows and hands closed windows to the sink."""

    def __init__(self, sink: SpoolSink, identity: WriterIdentity):
        self._sink = sink
        self._identity = identity
        self._open: dict[str, SpoolRow] = {}
        self._open_minute: Optional[str] = None
        self._lock = threading.RLock()

    def _window(self, *, tag: str, version_id: str, arm: str, model: str, status: str, error_class: Optional[str], usage_source: Optional[str], at_ms: float) -> SpoolRow:
        minute = minute_of(at_ms)
        if self._open_minute is not None and self._open_minute != minute:
            self.close_windows(at_ms)
        self._open_minute = minute
        key = " ".join([tag, version_id, arm, model, status, error_class or ""])
        row = self._open.get(key)
        if row is None:
            row = {
                "type": "window",
                "v": 1,
                "minute": minute,
                "instanceId": self._identity.instance_id,
                "instanceClass": self._identity.instance_class,
                "tag": tag,
                "versionId": version_id,
                "arm": arm,
                "model": model,
                "status": status,
                "errorClass": error_class,
                "usageSource": usage_source or "reported",
                "count": 0,
                "latencyMs": {"buckets": [0] * len(LATENCY_BUCKET_EDGES_MS), "sum": 0},
                "tokens": {"input": 0, "output": 0},
                "sdk": self._identity.sdk,
            }
            self._open[key] = row
        return row

    def observe(self, observation: Observation, at_ms: float) -> None:
        with self._lock:
            row = self._window(tag=observation.tag, version_id=observation.version_id, arm=observation.arm, model=observation.model, status=observation.status, error_class=observation.error_class, usage_source=observation.usage_source, at_ms=at_ms)
            row["count"] += 1
            bucket = latency_bucket_index(observation.latency_ms)
            row["latencyMs"]["buckets"][bucket] += 1
            # Half rounds up, as Math.round does; Python's round() would take 812.5 to 812 and the vectors would split the SDKs.
            row["latencyMs"]["sum"] += max(0, int(math.floor(observation.latency_ms + 0.5)))
            tokens = observation.tokens or {}
            row["tokens"]["input"] += tokens.get("input") or 0
            row["tokens"]["output"] += tokens.get("output") or 0
            if tokens.get("cachedInput"):
                row["tokens"]["cachedInput"] = (row["tokens"].get("cachedInput") or 0) + tokens["cachedInput"]
            if observation.checks is not None:
                current = row.get("checks") or {"passed": 0, "failed": 0}
                row["checks"] = {"passed": current["passed"] + (observation.checks.get("passed") or 0), "failed": current["failed"] + (observation.checks.get("failed") or 0)}
            if observation.outcomes:
                _merge_outcomes(row, observation.outcomes)

    def checks(self, *, tag: str, version_id: str, arm: str, model: str, passed: int, failed: int, at_ms: float) -> None:
        """T29: output-check counts against a run already counted (an app that evaluated after the fact): the run's window, no extra count."""
        with self._lock:
            row = self._window(tag=tag, version_id=version_id, arm=arm, model=model, status="ok", error_class=None, usage_source=None, at_ms=at_ms)
            current = row.get("checks") or {"passed": 0, "failed": 0}
            row["checks"] = {"passed": current["passed"] + passed, "failed": current["failed"] + failed}

    def outcomes(self, *, tag: str, version_id: str, arm: str, model: str, outcomes: Mapping[str, Union[int, float, bool]], at_ms: float) -> None:
        """Quality signals against a run already counted: they ride on the run's window (status ok) and never add to ``count``."""
        with self._lock:
            _merge_outcomes(self._window(tag=tag, version_id=version_id, arm=arm, model=model, status="ok", error_class=None, usage_source=None, at_ms=at_ms), outcomes)

    def refusal(self, *, at: str, reason: str, generation: int, tag: Optional[str], at_ms: float) -> None:
        self._sink.append({"type": "refusal", "v": 1, "instanceId": self._identity.instance_id, "at": at, "reason": reason, "generation": generation, "tag": tag}, at_ms)

    def close_windows(self, at_ms: float) -> None:
        """Write every open window and close the segment. Called at the minute boundary, at shutdown, and at invocation end on serverless."""
        with self._lock:
            for row in self._open.values():
                self._sink.append(row, at_ms)
            self._open.clear()
            self._open_minute = None
            self._sink.flush(at_ms)

    @property
    def open_window_count(self) -> int:
        return len(self._open)

