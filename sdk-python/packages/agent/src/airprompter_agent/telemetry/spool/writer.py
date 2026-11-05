"""The spool writer (``protocol/spool-format.md``, D52/D66).

Minute windows accumulate in memory per dimension set
``(tag, artifactId, versionId, arm, model, status, errorClass, audienceIds,
outcomeRunMinute)`` and are written as ``window`` rows when the minute
closes. ``count`` means runs, and ``record_run`` is the only thing that
raises it. Step rows are their own rows, kept per run dimensions, step,
status and errorClass, so no window can count one. Segments are append-only
NDJSON under ``<store>/spool/telemetry/``, open as
``seg-<inst>-<epochMinute>-<n>.ndjson.open``, closed by fsync + rename;
rotated at the minute boundary or 1 MiB. Nothing here can carry prompt
text, output, or an end-user identifier — the row shape has no field for
them. Serverless hosts use the memory sink and flush at invocation end.

Example::

    sink = DirectorySink(spool_dir, "i-hostprocess000")   # <store>/spool/telemetry/
    writer = SpoolWriter(sink, WriterIdentity("i-hostprocess000", "resident", "acme/1.0"))
    writer.observe(Observation(tag="support.reply", artifact_id="prm_reply", version_id="ver_9", arm="none", model="gpt-5", status="ok", latency_ms=812,
                               tokens={"input": 640, "output": 120}, usage_source="reported"), now_ms)   # a one-call run
    writer.close_stale_windows(now_ms)   # on the sweep: a minute that has turned is written; the current one stays open
    writer.close_windows(now_ms)         # at shutdown: every window, then the open segment is fsynced and renamed
"""

from __future__ import annotations

import json
import math
import os
import re
import threading
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional, Sequence, Union

from airprompter_agent.core import instant
from airprompter_agent.core._util import fsync_dir, iso_seconds, now_ms
from airprompter_agent.core import FsPort, fs_failure_code, fs_or_default
from airprompter_agent.core import valid_audience_ids, valid_audience_minute
from .manifest import manifest_name_of, write_segment_manifest
from airprompter_agent.core import ERROR_CLASSES, LATENCY_BUCKET_EDGES_MS, SLOT_TAG, STEP_STATUSES, USAGE_SOURCES, WINDOW_STATUSES, Observation, RunDimensions, RunTotals, SpoolRow, StepTotals, count_of, epoch_minute, latency_bucket_index, minute_of, step_name, utf16_length

__all__ = ["ERROR_CLASSES", "LATENCY_BUCKET_EDGES_MS", "Observation", "RunDimensions", "RunTotals", "SpoolRow", "StepTotals", "epoch_minute", "latency_bucket_index", "minute_of", "SEGMENT_MAX_BYTES", "HOST_SPOOL_BUDGET_BYTES", "SERVERLESS_BUFFER_BYTES", "segment_name", "SegmentPlanner", "SpoolSink", "MemorySink", "DirectorySink", "WriterIdentity", "SpoolWriter"]

SEGMENT_MAX_BYTES = 1024 * 1024
#: A host keeps this much closed, unsent spool before the oldest segments are evicted (spool-format.md).
HOST_SPOOL_BUDGET_BYTES = 100 * 1024 * 1024
#: A serverless invocation keeps this much in memory; beyond it the oldest rows go and a ``dropped`` row says so.
SERVERLESS_BUFFER_BYTES = 256 * 1024
_OUTCOME_NAME = re.compile(r"^[a-z][a-zA-Z0-9]{0,31}$")
_ARTIFACT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")


def _valid_outcome_run_minute(value: Any, minute: str) -> bool:
    return valid_audience_minute(value) and instant(value) <= instant(minute)


def _finite(value: Union[int, float]) -> bool:
    try:
        return math.isfinite(value)
    except OverflowError:  # an integer past every double: JavaScript reads it as Infinity
        return False


def _has_valid_outcome(outcomes: Mapping[str, Union[int, float, bool]]) -> bool:
    return isinstance(outcomes, Mapping) and any(isinstance(name, str) and _OUTCOME_NAME.fullmatch(name) and (isinstance(value, bool) or isinstance(value, (int, float)) and _finite(value * value)) for name, value in outcomes.items())


def _row_bytes(row: Mapping[str, Any]) -> bytes:
    # A lone surrogate has no UTF-8 form: it goes as the JSON escape, which is what JSON.stringify writes.
    return (json.dumps(row, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8", "backslashreplace")


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
    """Where rows go: a directory of segments, or memory (serverless). `kind` says which, as data; never branch on the class."""

    kind: str = "custom"

    def append(self, row: SpoolRow, now_ms_: float) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def flush(self, now_ms_: Optional[float] = None) -> None:  # pragma: no cover - interface
        raise NotImplementedError


def _dropped_row(instance_id: str, at_ms: float, segments: int, byte_count: int) -> SpoolRow:
    return {"type": "dropped", "v": 1, "at": iso_seconds(at_ms), "instanceId": instance_id, "segments": segments, "bytes": byte_count}


class MemorySink(SpoolSink):
    kind = "memory"
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
    """Segments on disk, through an ``FsPort``. Never raises on the request path: a full disk, an I/O error or a
    file a sibling process took away are counted on ``faults``, reported as a ``dropped`` row when writing works
    again, and never surfaced to the caller as an exception (S2)."""

    kind = "directory"

    def __init__(
        self,
        directory: str,
        instance_id: str,
        budget_bytes: int = HOST_SPOOL_BUDGET_BYTES,
        fs: Optional[FsPort] = None,
        *,
        manifest: Optional[Callable[[], Optional[Mapping[str, Any]]]] = None,
        now: Optional[Callable[[], float]] = None,
    ):
        """``manifest``: called at every close for ``{"organizationId", "agentId", "target", "report"}`` — the
        writer's scope and heartbeat report — and written beside the segment for the telemetry daemon
        (``protocol/daemon.md``); returning ``None`` writes none."""
        self.dir = directory
        self._manifest = manifest
        self._now = now
        self._instance_id = instance_id
        self._budget = budget_bytes
        self._fs = fs_or_default(fs)
        self._fd: Optional[int] = None
        self._open_path: Optional[str] = None
        self._planner = SegmentPlanner(instance_id)
        self._lock = threading.RLock()
        self.faults: dict[str, Any] = {"pendingRows": 0, "pendingBytes": 0, "byCode": {}, "last": None}
        if self._open_dir():
            self._recover_open_segments()

    def _open_dir(self) -> bool:
        directory = self.dir
        return self._guard("open_spool", lambda: (self._fs.mkdirp(os.path.join(directory, "exported"), 0o700), self._fs.mkdirp(os.path.join(directory, "quarantine"), 0o700)))

    def move_to(self, directory: str, now_ms_: float) -> None:
        """Write to another folder from the next row on (``protocol/daemon.md``: a telemetry daemon published one). The
        open segment is closed where it is, with its manifest; closed segments stay where they are. Never raises."""
        with self._lock:
            if directory == self.dir:
                return
            self.flush(now_ms_)
            self.dir = directory
            self._open_dir()

    def _write_manifest(self, segment: str) -> bool:
        """The segment's manifest, after the segment is closed. A failure is counted, never raised: the daemon uploads a
        manifest-less segment after its grace."""
        source = self._manifest
        if source is None:
            return False

        def write() -> None:
            try:
                context = source()
                if context:
                    write_segment_manifest(
                        self._fs,
                        self.dir,
                        segment,
                        organization_id=context["organizationId"],
                        agent_id=context["agentId"],
                        target=context["target"],
                        report=context["report"],
                        closed_at_ms=self._now() if self._now else now_ms(),
                    )
            except OSError:
                raise
            except Exception as error:  # the report is the agent's status: never let it break the request path
                raise OSError(f"manifest: {error}") from error

        return self._guard("write_manifest", write)

    def _drop_manifest(self, segment: str) -> None:
        """An evicted segment takes its manifest with it."""
        path = os.path.join(self.dir, manifest_name_of(segment))
        try:
            if self._fs.exists(path):
                self._fs.unlink(path)
        except OSError:
            pass  # gone already: the daemon's sweep deletes an orphan manifest anyway

    def _guard(self, step: str, run: Any) -> bool:
        """Run a filesystem step; a failure is counted by code and returns False. The sink never raises."""
        try:
            run()
            return True
        except OSError as error:
            code = fs_failure_code(error)
            self.faults["byCode"][code] = self.faults["byCode"].get(code, 0) + 1
            self.faults["last"] = f"{step}: {code}"
            return False

    def _recover_open_segments(self) -> None:
        """A writer that crashed left ``.open`` files; the same writer closes them on its next start (a partial last line is the daemon's to skip)."""
        prefix = f"seg-{self._instance_id}-"
        names: list[str] = []
        self._guard("list_spool", lambda: names.extend(self._fs.list(self.dir)))
        for name in names:
            if name.startswith(prefix) and name.endswith(".ndjson.open"):
                path = os.path.join(self.dir, name)

                def recover(path: str = path) -> None:
                    fd = self._fs.open(path, "r+")
                    try:
                        self._fs.fsync(fd)
                    finally:
                        self._fs.close(fd)
                    self._fs.rename(path, path[: -len(".open")])

                if self._guard("recover_open_segment", recover):
                    self._write_manifest(name[: -len(".open")])

    def _lose(self, rows: int, byte_count: int) -> None:
        self.faults["pendingRows"] += rows
        self.faults["pendingBytes"] += byte_count

    def _report_pending_loss(self, now_ms_: float) -> None:
        """Rows lost to failures become one ``dropped`` row (rows counted as ``segments``, as the memory sink does)."""
        if self.faults["pendingRows"] == 0 or self._fd is None:
            return
        line = _row_bytes(_dropped_row(self._instance_id, now_ms_, self.faults["pendingRows"], self.faults["pendingBytes"]))
        fd = self._fd
        if self._guard("write_dropped_row", lambda: self._fs.write(fd, line)):
            self.faults["pendingRows"] = 0
            self.faults["pendingBytes"] = 0
        else:
            self._close_open()

    def append(self, row: SpoolRow, now_ms_: float) -> None:
        line = _row_bytes(row)
        with self._lock:
            segment, rotated = self._planner.append(now_ms_, len(line))
            if rotated or self._fd is None:
                self.flush(now_ms_)

                def open_segment() -> None:
                    # A name already on disk (a previous process of the same instance in the same minute) is skipped, never appended to.
                    name = segment
                    while self._fs.exists(os.path.join(self.dir, name)) or self._fs.exists(os.path.join(self.dir, f"{name}.open")):
                        self._planner.n += 1
                        name = segment_name(self._instance_id, self._planner.open_minute or 0, self._planner.n)
                    open_path = os.path.join(self.dir, f"{name}.open")
                    self._fd = self._fs.open(open_path, "a", 0o600)
                    self._open_path = open_path

                if not self._guard("open_segment", open_segment):
                    self._fd = None
                    self._open_path = None
                    self._lose(1, len(line))
                    return
                self._report_pending_loss(now_ms_)
                if self._fd is None:
                    self._lose(1, len(line))
                    return
            fd = self._fd
            if not self._guard("write_row", lambda: self._fs.write(fd, line)):
                # What was written before this row is good; close the segment and count the row.
                self._close_open()
                self._lose(1, len(line))

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
        fd = self._fd
        open_path = self._open_path
        self._fd = None
        self._open_path = None
        synced = self._guard("fsync_segment", lambda: self._fs.fsync(fd))
        self._guard("close_segment", lambda: self._fs.close(fd))
        # A segment that did not fsync is not closed: it stays ``.open`` for the next start to recover.
        if synced and self._guard("close_segment", lambda: self._fs.rename(open_path, open_path[: -len(".open")])):
            self._guard("fsync_dir", lambda: fsync_dir(self.dir))
            self._write_manifest(os.path.basename(open_path)[: -len(".open")])

    def _enforce_budget(self) -> Optional[tuple[int, int]]:
        """Over the host budget: evict the OLDEST closed, unsent segments and say how much went. A file a sibling took away is skipped."""
        sizes: list[tuple[str, int]] = []
        for name in self.closed_segments():
            self._guard("stat_segment", lambda name=name: sizes.append((name, self._fs.stat(os.path.join(self.dir, name))[0])))
        total = sum(size for _name, size in sizes)
        evicted = 0
        evicted_bytes = 0
        for name, size in sizes:
            if total <= self._budget:
                break
            removed = self._guard("evict_segment", lambda name=name: self._fs.unlink(os.path.join(self.dir, name)))
            total -= size
            if not removed:
                continue
            self._drop_manifest(name)
            evicted += 1
            evicted_bytes += size
        return (evicted, evicted_bytes) if evicted > 0 else None

    def closed_segments(self) -> list[str]:
        names: list[str] = []
        self._guard("list_spool", lambda: names.extend(self._fs.list(self.dir)))
        return sorted(name for name in names if name.startswith("seg-") and name.endswith(".ndjson"))

    def depth(self) -> dict[str, int]:
        segments = self.closed_segments()
        total = 0
        for name in segments:
            def add(name: str = name) -> None:
                nonlocal total
                total += self._fs.stat(os.path.join(self.dir, name))[0]

            self._guard("stat_segment", add)
        return {"segments": len(segments), "bytes": total}


@dataclass
class WriterIdentity:
    instance_id: str
    instance_class: str  # "resident" | "ephemeral"
    sdk: str


def _rounded_ms(latency_ms: float) -> int:
    """Half rounds up, as Math.round does; Python's round() would take 812.5 to 812 and the vectors would split the SDKs."""
    return max(0, int(math.floor(latency_ms + 0.5))) if _finite(latency_ms) else 0


def _empty_histogram() -> dict[str, Any]:
    return {"buckets": [0] * len(LATENCY_BUCKET_EDGES_MS), "sum": 0}


def _member(value: Any, name: str) -> Any:
    """A member of a caller's mapping, whatever the caller handed in: anything else has no members."""
    return value.get(name) if isinstance(value, Mapping) else None


def _token_counts(tokens: Any) -> tuple[int, int, int]:
    return count_of(_member(tokens, "input")), count_of(_member(tokens, "cachedInput")), count_of(_member(tokens, "output"))


def _tool_counts(tools: Any) -> tuple[int, int]:
    return count_of(_member(tools, "calls")), count_of(_member(tools, "errors"))


def _add_tokens(row: SpoolRow, tokens: tuple[int, int, int]) -> None:
    tokens_in, cached, tokens_out = tokens
    row["tokens"]["input"] += tokens_in
    row["tokens"]["output"] += tokens_out
    if cached:
        row["tokens"]["cachedInput"] = (row["tokens"].get("cachedInput") or 0) + cached


def _add_tools(row: SpoolRow, tools: tuple[int, int]) -> None:
    row["tools"]["calls"] += tools[0]
    row["tools"]["errors"] += tools[1]


def _add_checks(row: SpoolRow, passed: int, failed: int) -> None:
    current = row.get("checks") or {"passed": 0, "failed": 0}
    row["checks"] = {"passed": current["passed"] + passed, "failed": current["failed"] + failed}


def _merge_outcomes(row: SpoolRow, outcomes: Mapping[str, Union[int, float, bool]]) -> None:
    for name, value in outcomes.items() if isinstance(outcomes, Mapping) else ():
        if not isinstance(name, str) or not _OUTCOME_NAME.fullmatch(name):
            continue
        if isinstance(value, bool):
            numeric: Union[int, float] = 1 if value else 0
        elif isinstance(value, (int, float)):
            numeric = value
        else:
            continue
        # Past every double, an integer would raise in the sums below where JavaScript reads Infinity.
        if not _finite(numeric * numeric):
            continue
        current = (row.get("outcomes") or {}).get(name) or {"n": 0, "sum": 0, "sumSq": 0}
        merged = {"n": current["n"] + 1, "sum": current["sum"] + numeric, "sumSq": current["sumSq"] + numeric * numeric}
        # A value that would leave a total infinite would serialise as null and cost the whole segment.
        if not _finite(merged["sum"]) or not _finite(merged["sumSq"]):
            continue
        row.setdefault("outcomes", {})[name] = merged


def _check_dimensions(*, artifact_id: Any, audience_ids: Optional[Sequence[str]], outcome_run_minute: Optional[str], minute: str, tag: Any, version_id: Any, arm: Any, model: Any, status: Any, usage_source: Any, error_class: Any, statuses: Sequence[str] = WINDOW_STATUSES) -> None:
    """A writer produces only what the validator takes: a bad observation raises here, before any row moves, and ``observe`` and ``report`` drop and log it."""
    if not isinstance(artifact_id, str) or not _ARTIFACT_ID.fullmatch(artifact_id):
        raise ValueError("telemetry_artifact_id_invalid")
    if audience_ids is not None and not valid_audience_ids(audience_ids):
        raise ValueError("telemetry_audience_ids_invalid")
    if outcome_run_minute is not None and not _valid_outcome_run_minute(outcome_run_minute, minute):
        raise ValueError("telemetry_outcome_run_minute_invalid")
    if not isinstance(tag, str) or len(tag) > 128 or not SLOT_TAG.fullmatch(tag):
        raise ValueError("telemetry_tag_invalid")
    if not isinstance(version_id, str) or utf16_length(version_id) > 128:
        raise ValueError("telemetry_version_id_invalid")
    if not isinstance(arm, str) or len(arm) > 32 or not SLOT_TAG.fullmatch(arm):
        raise ValueError("telemetry_arm_invalid")
    if not isinstance(model, str) or utf16_length(model) > 128:
        raise ValueError("telemetry_model_invalid")
    if status not in statuses:
        raise ValueError("telemetry_status_invalid")
    if usage_source is not None and usage_source not in USAGE_SOURCES:
        raise ValueError("telemetry_usage_source_invalid")
    if error_class is not None and error_class not in ERROR_CLASSES:
        raise ValueError("telemetry_error_class_invalid")


def _window_key(tag: str, artifact_id: Optional[str], version_id: str, arm: str, model: str, status: str, error_class: Optional[str], audience_ids: Optional[Sequence[str]], outcome_run_minute: Optional[str]) -> str:
    return json.dumps([tag, artifact_id, version_id, arm, model, status, error_class, audience_ids, outcome_run_minute], separators=(",", ":"))


class SpoolWriter:
    """Accumulates runs into minute windows and steps into step rows, and hands closed rows to the sink."""

    def __init__(self, sink: SpoolSink, identity: WriterIdentity):
        self._sink = sink
        self._identity = identity
        self._open: dict[str, SpoolRow] = {}
        self._open_steps: dict[str, SpoolRow] = {}
        #: The step names counted against ``STEP_BOUNDS["maxPerRun"]``, per run dimensions, for the open minute.
        self._step_names: dict[str, set[str]] = {}
        self._open_minute: Optional[str] = None
        self._lock = threading.RLock()

    def _turn_minute(self, at_ms: float) -> str:
        """Measurements belong to the minute they complete. Reopening a sealed minute would emit the same ingest SET key
        twice and lose the earlier aggregate. Only feedback carries its original run minute separately."""
        minute = minute_of(at_ms)
        if self._open_minute is not None and self._open_minute != minute:
            self.close_windows(at_ms)
        self._open_minute = minute
        return minute

    def _window(self, *, tag: str, version_id: str, artifact_id: Optional[str], arm: str, model: str, status: str, error_class: Optional[str], usage_source: Optional[str], at_ms: float, audience_ids: Optional[Sequence[str]] = None, outcome_run_minute: Optional[str] = None) -> SpoolRow:
        _check_dimensions(artifact_id=artifact_id, audience_ids=audience_ids, outcome_run_minute=outcome_run_minute, minute=minute_of(at_ms), tag=tag, version_id=version_id, arm=arm, model=model, status=status, usage_source=usage_source, error_class=error_class)
        minute = self._turn_minute(at_ms)
        outcome_key = None if outcome_run_minute == minute else outcome_run_minute
        key = _window_key(tag, artifact_id, version_id, arm, model, status, error_class, audience_ids, outcome_key)
        row = self._open.get(key)
        if row is None:
            row = {
                "type": "window",
                "v": 4,
                "artifactId": artifact_id,
                **({"audienceIds": list(audience_ids)} if audience_ids is not None else {}),
                **({"outcomeRunMinute": outcome_run_minute} if outcome_run_minute else {}),
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
                "modelCalls": 0,
                "agentRun": 0,
                "tools": {"calls": 0, "errors": 0},
                "latencyMs": _empty_histogram(),
                "tokens": {"input": 0, "output": 0},
                "sdk": self._identity.sdk,
            }
            self._open[key] = row
        return row

    def record_run(self, totals: RunTotals, at_ms: float) -> None:
        """One run's totals, in the minute it ended: the only place ``count`` increases. Moments are over the run's totals, never per model call."""
        with self._lock:
            self._add_run(totals, at_ms)

    def _add_run(self, totals: RunTotals, at_ms: float) -> SpoolRow:
        dimensions = totals.dimensions
        # All that a caller's value can raise on, before any row moves: a run never leaves half a row.
        bucket = latency_bucket_index(totals.latency_ms)
        latency_sum = _rounded_ms(totals.latency_ms)
        tokens_in, cached, tokens_out = _token_counts(totals.tokens)
        tools = _tool_counts(totals.tools)
        row = self._window(tag=dimensions.tag, version_id=dimensions.version_id, artifact_id=dimensions.artifact_id, arm=dimensions.arm, model=dimensions.model, status=totals.status, error_class=totals.error_class, usage_source=totals.usage_source, at_ms=at_ms, audience_ids=dimensions.audience_ids)
        if row.get("outcomeRunMinute") == row["minute"]:
            row.pop("outcomeRunMinute")
        row["count"] += 1
        row["agentRun"] += totals.agent_run
        row["modelCalls"] += count_of(totals.model_calls)
        _add_tools(row, tools)
        row["latencyMs"]["buckets"][bucket] += 1
        row["latencyMs"]["sum"] += latency_sum
        _add_tokens(row, (tokens_in, cached, tokens_out))
        moments = row.setdefault("tokensSq", {"input": 0, "cachedInput": 0, "output": 0, "inputOutput": 0, "inputCached": 0, "cachedOutput": 0})
        moments["input"] += tokens_in * tokens_in
        moments["cachedInput"] += cached * cached
        moments["output"] += tokens_out * tokens_out
        moments["inputOutput"] += tokens_in * tokens_out
        moments["inputCached"] += tokens_in * cached
        moments["cachedOutput"] += cached * tokens_out
        if totals.checks is not None:
            _add_checks(row, count_of(_member(totals.checks, "passed")), count_of(_member(totals.checks, "failed")))
        return row

    def record_step(self, totals: StepTotals, at_ms: float) -> None:
        """One step's totals: writes a step row and touches no window. A name past ``STEP_BOUNDS`` is written as ``other``; run sessions apply the same caps per run first."""
        dimensions = totals.dimensions
        with self._lock:
            _check_dimensions(artifact_id=dimensions.artifact_id, audience_ids=dimensions.audience_ids, outcome_run_minute=None, minute=minute_of(at_ms), tag=dimensions.tag, version_id=dimensions.version_id, arm=dimensions.arm, model=dimensions.model, status=totals.status, usage_source=totals.usage_source, error_class=totals.error_class, statuses=STEP_STATUSES)
            counts = [count_of(count) for count in totals.latency["buckets"][: len(LATENCY_BUCKET_EDGES_MS)]]
            latency_sum = _rounded_ms(totals.latency["sum"])
            tokens = _token_counts(totals.tokens)
            tools = _tool_counts(totals.tools)
            minute = self._turn_minute(at_ms)
            scope = _window_key(dimensions.tag, dimensions.artifact_id, dimensions.version_id, dimensions.arm, dimensions.model, "", None, dimensions.audience_ids, None)
            step = step_name(totals.step, self._step_names.setdefault(scope, set()))
            key = json.dumps([scope, step, totals.status, totals.error_class], separators=(",", ":"))
            row = self._open_steps.get(key)
            if row is None:
                row = {
                    "type": "step",
                    "v": 1,
                    "artifactId": dimensions.artifact_id,
                    **({"audienceIds": list(dimensions.audience_ids)} if dimensions.audience_ids is not None else {}),
                    "minute": minute,
                    "instanceId": self._identity.instance_id,
                    "instanceClass": self._identity.instance_class,
                    "tag": dimensions.tag,
                    "versionId": dimensions.version_id,
                    "arm": dimensions.arm,
                    "model": dimensions.model,
                    "step": step,
                    "status": totals.status,
                    "errorClass": totals.error_class,
                    "usageSource": totals.usage_source,
                    "modelCalls": 0,
                    "latencyMs": _empty_histogram(),
                    "tokens": {"input": 0, "output": 0},
                    "tools": {"calls": 0, "errors": 0},
                    "sdk": self._identity.sdk,
                }
                self._open_steps[key] = row
            # The histogram holds one entry per model call, so it is what counts them: the validator holds the two equal.
            for index, count in enumerate(counts):
                row["latencyMs"]["buckets"][index] += count
                row["modelCalls"] += count
            row["latencyMs"]["sum"] += latency_sum
            _add_tokens(row, tokens)
            _add_tools(row, tools)

    def observe(self, observation: Observation, at_ms: float) -> None:
        """A one-call run: one run row, and a step row only when the observation names a step (a workflow step reported outside a run)."""
        step = observation.step
        dimensions = RunDimensions(tag=observation.tag, artifact_id=observation.artifact_id, version_id=observation.version_id, arm=observation.arm, model=observation.model, audience_ids=observation.audience_ids, run_minute=observation.run_minute)
        tokens = {name: _member(observation.tokens, name) or 0 for name in ("input", "cachedInput", "output")}
        tools = {name: _member(observation.tool_calls, name) or 0 for name in ("calls", "errors")}
        usage_source = "reported" if observation.usage_source is None else observation.usage_source
        with self._lock:
            row = self._add_run(RunTotals(dimensions=dimensions, status=observation.status, error_class=observation.error_class, usage_source=usage_source, agent_run=1, model_calls=1, latency_ms=observation.latency_ms, tokens=tokens, tools=tools, checks=observation.checks), at_ms)
            if observation.outcomes:
                _merge_outcomes(row, observation.outcomes)
            if step is None:
                return
            latency = _empty_histogram()
            latency["buckets"][latency_bucket_index(observation.latency_ms)] = 1
            latency["sum"] = _rounded_ms(observation.latency_ms)
            self.record_step(StepTotals(dimensions=dimensions, step=step, status="ok" if observation.status == "ok" else "error", error_class=observation.error_class, usage_source=usage_source, model_calls=1, latency=latency, tokens=tokens, tools=tools), at_ms)

    def _measured_row(self, *, tag: str, artifact_id: Optional[str], version_id: str, arm: str, model: str, audience_ids: Optional[Sequence[str]], at_ms: float) -> Optional[SpoolRow]:
        """The open measured row these dimensions name, if a run has landed on it this minute."""
        if self._open_minute != minute_of(at_ms):
            return None
        row = self._open.get(_window_key(tag, artifact_id, version_id, arm, model, "ok", None, audience_ids, None))
        return row if row is not None and row["count"] > 0 else None

    def checks(self, *, tag: str, version_id: str, artifact_id: Optional[str] = None, arm: str, model: str, passed: int, failed: int, at_ms: float, audience_ids: Optional[Sequence[str]] = None, run_minute: Optional[str] = None) -> None:
        """T29: output-check counts against a run already counted (an app that evaluated after the fact): the run's window, no extra count. A window holding no run takes none."""
        with self._lock:
            row = self._measured_row(tag=tag, artifact_id=artifact_id, version_id=version_id, arm=arm, model=model, audience_ids=audience_ids, at_ms=at_ms)
            if row is not None:
                _add_checks(row, passed, failed)

    def outcomes(self, *, tag: str, version_id: str, artifact_id: Optional[str] = None, arm: str, model: str, outcomes: Mapping[str, Union[int, float, bool]], at_ms: float, audience_ids: Optional[Sequence[str]] = None, outcome_run_minute: Optional[str] = None) -> None:
        """Quality signals against a run already counted: they ride on the run's window (status ok) and never add to ``count``."""
        with self._lock:
            if not _has_valid_outcome(outcomes) or artifact_id is None:
                return
            if audience_ids is not None and not valid_audience_ids(audience_ids):
                return
            if outcome_run_minute is None:
                row = self._measured_row(tag=tag, artifact_id=artifact_id, version_id=version_id, arm=arm, model=model, audience_ids=audience_ids, at_ms=at_ms)
                if row is not None:
                    _merge_outcomes(row, outcomes)
                return
            if not _valid_outcome_run_minute(outcome_run_minute, minute_of(at_ms)):
                return
            _merge_outcomes(self._window(tag=tag, version_id=version_id, artifact_id=artifact_id, arm=arm, model=model, status="ok", error_class=None, usage_source=None, at_ms=at_ms, audience_ids=audience_ids, outcome_run_minute=outcome_run_minute), outcomes)

    def refusal(self, *, at: str, reason: str, generation: int, tag: Optional[str], at_ms: float) -> None:
        self._sink.append({"type": "refusal", "v": 1, "instanceId": self._identity.instance_id, "at": at, "reason": reason, "generation": generation, "tag": tag}, at_ms)

    def close_windows(self, at_ms: float) -> None:
        """Write every open window and step row, and close the segment. Called at the minute boundary, at shutdown, and at invocation end on serverless."""
        with self._lock:
            for row in self._open.values():
                self._sink.append(row, at_ms)
            for row in self._open_steps.values():
                self._sink.append(row, at_ms)
            self._open.clear()
            self._open_steps.clear()
            self._step_names.clear()
            self._open_minute = None
            self._sink.flush(at_ms)

    def close_stale_windows(self, at_ms: float) -> None:
        """S6: close the windows of a minute that has passed (and the segment with them) without touching the current minute — the
        runtime's spool timer calls this, so an idle writer never leaves the last minute of a burst parked in an ``.open`` file."""
        with self._lock:
            stale = self._open_minute is not None and self._open_minute != minute_of(at_ms)
        if stale:
            self.close_windows(at_ms)

    @property
    def open_window_count(self) -> int:
        return len(self._open)
