"""A spool writer without the SDK (protocol/spool-format.md, D66): what a team
instrumenting a provider SDK themselves needs — minute windows per
(tag, artifactId, versionId, arm, model, status, errorClass, audienceIds,
outcomeRunMinute) where ``count`` means runs, step rows beside them, the fixed
latency buckets, segment naming, ``.open`` → fsync → rename, and rotation on the minute or at
1 MiB. ``airprompterd`` uploads what lands in ``dir``. Standard library only;
``check_vectors.py`` drives it through protocol/vectors/spool.json.

::

    spool = SpoolWriter(dir=f"{state_dir}/airprompter/{agent_id}/{target}/spool/telemetry", instance_id=instance_id, sdk="acme-logger/1.0")
    spool.observe(tag=tag, artifact_id=artifact_id, version_id=version_id, arm=arm, model=model, status="ok", latency_ms=812, tokens={"input": 400, "output": 90})
    spool.record_run({"dimensions": dimensions, "status": "ok", "errorClass": None, "usageSource": "reported", "agentRun": 1, "modelCalls": 5, "latencyMs": 4200, "tokens": tokens, "tools": tools})
    spool.feedback(tag=tag, artifact_id=artifact_id, version_id=version_id, arm=arm, model=model, outcomes={"accepted": True})
    atexit.register(spool.close)
"""

from __future__ import annotations

import json
import math
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Mapping, Optional

LATENCY_BUCKET_EDGES_MS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576, 2097152, 3600000]
STEP_BOUNDS = {"maxLength": 64, "maxPerRun": 32}
SEGMENT_MAX_BYTES = 1024 * 1024
_OUTCOME_NAME = re.compile(r"^[a-z][a-zA-Z0-9]{0,31}$")
_OUTCOME_MINUTE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z$")


def _valid_audience_ids(value: Any) -> bool:
    return isinstance(value, (list, tuple)) and len(value) <= 8 and all(isinstance(item, str) and re.fullmatch(r"aud_[A-Za-z0-9_-]{22}", item) and (index == 0 or value[index - 1] < item) for index, item in enumerate(value))


def _valid_outcome_run_minute(value: Any) -> bool:
    if not isinstance(value, str) or not _OUTCOME_MINUTE.fullmatch(value) or value.startswith("0000-"):
        return False
    try:
        datetime(int(value[0:4]), int(value[5:7]), int(value[8:10]), int(value[11:13]), int(value[14:16]), tzinfo=timezone.utc)
        return True
    except (ValueError, OverflowError):
        return False


def _has_valid_outcome(outcomes: Mapping[str, Any]) -> bool:
    return any(_OUTCOME_NAME.fullmatch(name) and (isinstance(value, bool) or isinstance(value, (int, float)) and math.isfinite(value * value)) for name, value in outcomes.items())


def latency_bucket_index(ms: float) -> int:
    return next((i for i, edge in enumerate(LATENCY_BUCKET_EDGES_MS) if ms <= edge), len(LATENCY_BUCKET_EDGES_MS) - 1)


def epoch_minute(epoch_ms: float) -> int:
    return int(epoch_ms // 60000)


def minute_of(epoch_ms: float) -> str:
    return datetime.fromtimestamp(epoch_minute(epoch_ms) * 60, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def segment_name(instance_id: str, minute: int, n: int) -> str:
    return f"seg-{instance_id}-{minute}-{n}.ndjson"


class SpoolWriter:
    def __init__(self, *, dir: Optional[str] = None, instance_id: str, instance_class: str = "resident", sdk: str = "spool-writer-example/1.0", now=lambda: time.time() * 1000):  # noqa: A002
        self.dir, self.instance_id, self.instance_class, self.sdk, self.now = dir, instance_id, instance_class, sdk, now
        self.open: dict[str, dict[str, Any]] = {}
        self.open_steps: dict[str, dict[str, Any]] = {}
        self.step_names: dict[str, set[str]] = {}
        self.open_minute: Optional[str] = None
        self.seg_minute: Optional[int] = None
        self.seg_bytes, self.seg_n, self.sealed = 0, -1, False
        self.fd: Optional[int] = None
        self.seg_path = ""
        self.emitted: list[dict[str, Any]] = []
        if dir:
            os.makedirs(dir, mode=0o700, exist_ok=True)

    def record_run(self, run: Mapping[str, Any], at: Optional[float] = None) -> dict[str, Any]:
        """One run's totals: the only place ``count`` rises. Moments are over the run's totals, never per model call."""
        at = self.now() if at is None else at
        d = run["dimensions"]
        audience_ids = tuple(d["audienceIds"]) if "audienceIds" in d else None
        row = self._window(at, d["tag"], d["versionId"], d["arm"], d["model"], run["status"], run.get("errorClass"), run.get("usageSource") or "reported", artifact_id=d.get("artifactId"), audience_ids=audience_ids)
        if row.get("outcomeRunMinute") == row["minute"]:
            del row["outcomeRunMinute"]
        row["count"] += 1
        row["agentRun"] += run["agentRun"]
        row["modelCalls"] += _count_of(run["modelCalls"])
        row["tools"]["calls"] += _count_of(run["tools"]["calls"])
        row["tools"]["errors"] += _count_of(run["tools"]["errors"])
        row["latencyMs"]["buckets"][latency_bucket_index(run["latencyMs"])] += 1
        row["latencyMs"]["sum"] += _rounded_ms(run["latencyMs"])
        t = {name: _count_of(value) for name, value in run["tokens"].items()}
        row["tokens"]["input"] += t["input"]
        row["tokens"]["output"] += t["output"]
        if t["cachedInput"]:
            row["tokens"]["cachedInput"] = row["tokens"].get("cachedInput", 0) + t["cachedInput"]
        sq = row.setdefault("tokensSq", {"input": 0, "cachedInput": 0, "output": 0, "inputOutput": 0, "inputCached": 0, "cachedOutput": 0})
        sq["input"] += t["input"] ** 2
        sq["cachedInput"] += t["cachedInput"] ** 2
        sq["output"] += t["output"] ** 2
        sq["inputOutput"] += t["input"] * t["output"]
        sq["inputCached"] += t["input"] * t["cachedInput"]
        sq["cachedOutput"] += t["cachedInput"] * t["output"]
        checks = run.get("checks")
        if checks:
            previous = row.get("checks", {"passed": 0, "failed": 0})
            row["checks"] = {"passed": previous["passed"] + checks["passed"], "failed": previous["failed"] + checks["failed"]}
        return row

    def record_step(self, step: Mapping[str, Any], at: Optional[float] = None) -> None:
        """One step's totals: a row of its own, never a window. Past either cap in STEP_BOUNDS the name is written as ``other``."""
        at = self.now() if at is None else at
        d = step["dimensions"]
        _check_dimensions(at, d.get("artifactId"), tuple(d["audienceIds"]) if "audienceIds" in d else None, None)
        minute = self._turn_minute(at)
        scope = json.dumps([d["tag"], d["artifactId"], d["versionId"], d["arm"], d["model"], d.get("audienceIds")])
        names = self.step_names.setdefault(scope, set())
        name = step["step"] if _valid_step(step["step"]) else "other"
        if name != "other" and name not in names:
            if len(names) >= STEP_BOUNDS["maxPerRun"]:
                name = "other"
            else:
                names.add(name)
        key = json.dumps([scope, name, step["status"], step.get("errorClass")])
        row = self.open_steps.get(key)
        if row is None:
            row = {"type": "step", "v": 1, "artifactId": d["artifactId"], "minute": minute, "instanceId": self.instance_id, "instanceClass": self.instance_class, "tag": d["tag"], "versionId": d["versionId"], "arm": d["arm"], "model": d["model"], "step": name, "status": step["status"], "errorClass": step.get("errorClass"), "usageSource": step.get("usageSource") or "reported", "modelCalls": 0, "latencyMs": {"buckets": [0] * len(LATENCY_BUCKET_EDGES_MS), "sum": 0}, "tokens": {"input": 0, "output": 0}, "tools": {"calls": 0, "errors": 0}, "sdk": self.sdk}
            if "audienceIds" in d:
                row["audienceIds"] = list(d["audienceIds"])
            self.open_steps[key] = row
        for index, count in enumerate(step["latency"]["buckets"]):
            row["latencyMs"]["buckets"][index] += _count_of(count)
            row["modelCalls"] += _count_of(count)  # the histogram counts the model calls: the validator holds the two equal
        row["latencyMs"]["sum"] += _rounded_ms(step["latency"]["sum"])
        tokens = {name: _count_of(value) for name, value in step["tokens"].items()}
        row["tokens"]["input"] += tokens["input"]
        row["tokens"]["output"] += tokens["output"]
        if tokens["cachedInput"]:
            row["tokens"]["cachedInput"] = row["tokens"].get("cachedInput", 0) + tokens["cachedInput"]
        row["tools"]["calls"] += _count_of(step["tools"]["calls"])
        row["tools"]["errors"] += _count_of(step["tools"]["errors"])

    def observe(self, *, tag: str, version_id: str, model: str, latency_ms: float, artifact_id: Optional[str] = None, arm: str = "none", status: str = "ok", error_class: Optional[str] = None, usage_source: str = "reported", audience_ids: Optional[tuple[str, ...]] = None, tokens: Optional[Mapping[str, int]] = None, tool_calls: Optional[Mapping[str, int]] = None, step: Optional[str] = None, checks: Optional[Mapping[str, int]] = None, outcomes: Optional[Mapping[str, Any]] = None, at: Optional[float] = None) -> None:
        """A one-call run: latency, tokens, status and error class, never text, ids or messages. A step row only when it names a step."""
        at = self.now() if at is None else at
        dimensions: dict[str, Any] = {"tag": tag, "artifactId": artifact_id, "versionId": version_id, "arm": arm, "model": model}
        if audience_ids is not None:
            dimensions["audienceIds"] = list(audience_ids)
        given = tokens or {}
        totals = {"input": given.get("input", 0), "cachedInput": given.get("cachedInput", 0), "output": given.get("output", 0)}
        tools = {"calls": (tool_calls or {}).get("calls", 0), "errors": (tool_calls or {}).get("errors", 0)}
        run: dict[str, Any] = {"dimensions": dimensions, "status": status, "errorClass": error_class, "usageSource": usage_source, "agentRun": 1, "modelCalls": 1, "latencyMs": latency_ms, "tokens": totals, "tools": tools}
        if checks:
            run["checks"] = {"passed": checks.get("passed", 0), "failed": checks.get("failed", 0)}
        row = self.record_run(run, at)
        if outcomes:
            _merge_outcomes(row, outcomes)
        if step is not None:
            buckets = [0] * len(LATENCY_BUCKET_EDGES_MS)
            buckets[latency_bucket_index(latency_ms)] = 1
            self.record_step({"dimensions": dimensions, "step": step, "status": "ok" if status == "ok" else "error", "errorClass": error_class, "usageSource": usage_source, "modelCalls": 1, "latency": {"buckets": buckets, "sum": _rounded_ms(latency_ms)}, "tokens": totals, "tools": tools}, at)

    def feedback(self, *, tag: str, version_id: str, model: str, outcomes: Mapping[str, Any], artifact_id: Optional[str] = None, arm: str = "none", audience_ids: Optional[tuple[str, ...]] = None, outcome_run_minute: Optional[str] = None, at: Optional[float] = None) -> None:
        """Feedback filed against a run: rides on the run's ``ok`` window for this minute, never adds to count or latency."""
        at = self.now() if at is None else at
        if not _has_valid_outcome(outcomes) or artifact_id is None:
            return
        if audience_ids is not None and not _valid_audience_ids(audience_ids):
            return
        if outcome_run_minute is not None and (not _valid_outcome_run_minute(outcome_run_minute) or outcome_run_minute > minute_of(at)):
            return
        if outcome_run_minute is None:
            minute = minute_of(at)
            if self.open_minute != minute:
                return
            key = json.dumps([tag, artifact_id, version_id, arm, model, "ok", None, audience_ids, None])
            row = self.open.get(key)
            if row is None or row["count"] == 0:
                return
            _merge_outcomes(row, outcomes)
            return
        _merge_outcomes(self._window(at, tag, version_id, arm, model, "ok", None, "reported", artifact_id=artifact_id, audience_ids=audience_ids, outcome_run_minute=outcome_run_minute), outcomes)

    def _turn_minute(self, at: float) -> str:
        minute = minute_of(at)
        if self.open_minute is not None and self.open_minute != minute:
            self.close(at)
        self.open_minute = minute
        return minute

    def _window(self, at: float, tag: str, version_id: str, arm: str, model: str, status: str, error_class: Optional[str], usage_source: str, *, artifact_id: Optional[str] = None, audience_ids: Optional[tuple[str, ...]] = None, outcome_run_minute: Optional[str] = None) -> dict[str, Any]:
        _check_dimensions(at, artifact_id, audience_ids, outcome_run_minute)
        minute = self._turn_minute(at)
        outcome_key = None if outcome_run_minute == minute else outcome_run_minute
        key = json.dumps([tag, artifact_id, version_id, arm, model, status, error_class, audience_ids, outcome_key])
        row = self.open.get(key)
        if row is None:
            row = {"type": "window", "v": 4, "artifactId": artifact_id, "minute": minute, "instanceId": self.instance_id, "instanceClass": self.instance_class, "tag": tag, "versionId": version_id, "arm": arm, "model": model, "status": status, "errorClass": error_class, "usageSource": usage_source, "count": 0, "modelCalls": 0, "agentRun": 0, "tools": {"calls": 0, "errors": 0}, "latencyMs": {"buckets": [0] * len(LATENCY_BUCKET_EDGES_MS), "sum": 0}, "tokens": {"input": 0, "output": 0}, "sdk": self.sdk}
            if audience_ids is not None:
                row["audienceIds"] = list(audience_ids)
            if outcome_run_minute is not None:
                row["outcomeRunMinute"] = outcome_run_minute
            self.open[key] = row
        return row

    def close(self, at: Optional[float] = None) -> None:
        """Writes the open minute's rows to a segment (``.open``, fsync, rename) and starts a new minute."""
        at = self.now() if at is None else at
        rows = [*self.open.values(), *self.open_steps.values()]
        self.open.clear()
        self.open_steps.clear()
        self.step_names.clear()
        self.open_minute = None
        for row in rows:
            self._append(json.dumps(row, separators=(",", ":")) + "\n", at)
        self.emitted.extend(rows)
        if self.fd is not None:
            self._seal()

    def plan_segment(self, epoch_ms: float, line_bytes: int) -> tuple[str, bool]:
        """Which segment a line lands in: a new one on a new minute or when this line would push past 1 MiB."""
        minute = epoch_minute(epoch_ms)
        rotated = self.sealed or self.seg_minute != minute or self.seg_bytes + line_bytes > SEGMENT_MAX_BYTES
        self.sealed = False
        if rotated:
            self.seg_n = self.seg_n + 1 if self.seg_minute == minute else 0
            self.seg_minute, self.seg_bytes = minute, 0
        self.seg_bytes += line_bytes
        return segment_name(self.instance_id, self.seg_minute, self.seg_n), rotated

    def _append(self, line: str, at: float) -> None:
        data = line.encode("utf-8")
        segment, rotated = self.plan_segment(at, len(data))
        if not self.dir:
            return
        if rotated and self.fd is not None:
            self._seal()
        if self.fd is None:
            self.seg_path = os.path.join(self.dir, segment)
            self.fd = os.open(self.seg_path + ".open", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        os.write(self.fd, data)

    def _seal(self) -> None:
        assert self.fd is not None
        os.fsync(self.fd)
        os.close(self.fd)
        os.rename(self.seg_path + ".open", self.seg_path)
        self.fd = None
        self.sealed = True  # a later line in the same minute opens the next segment, never this sealed one


def _count_of(value: Any) -> int:
    """A count a row may carry: a non-negative integer, whatever a caller handed in."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return 0
    return min(9007199254740991, max(0, int(value)))


def _rounded_ms(value: float) -> int:
    return max(0, math.floor(value + 0.5)) if math.isfinite(value) else 0





def _valid_step(value: Any) -> bool:
    return isinstance(value, str) and 1 <= len(value) <= STEP_BOUNDS["maxLength"] and not re.search("[\\x00-\\x1f\\x7f]", value)


def _check_dimensions(at: float, artifact_id: Optional[str], audience_ids: Optional[tuple[str, ...]], outcome_run_minute: Optional[str]) -> None:
    if not isinstance(artifact_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", artifact_id):
        raise ValueError("telemetry_artifact_id_invalid")
    if audience_ids is not None and not _valid_audience_ids(audience_ids):
        raise ValueError("telemetry_audience_ids_invalid")
    if outcome_run_minute is not None and (not _valid_outcome_run_minute(outcome_run_minute) or outcome_run_minute > minute_of(at)):
        raise ValueError("telemetry_outcome_run_minute_invalid")


def _merge_outcomes(row: dict[str, Any], outcomes: Mapping[str, Any]) -> None:
    for name, value in outcomes.items():
        numeric = (1 if value else 0) if isinstance(value, bool) else value
        if not _OUTCOME_NAME.match(name) or not isinstance(numeric, (int, float)) or numeric != numeric or numeric in (float("inf"), float("-inf")):
            continue
        current = row.get("outcomes", {}).get(name, {"n": 0, "sum": 0, "sumSq": 0})
        merged = {"n": current["n"] + 1, "sum": current["sum"] + numeric, "sumSq": current["sumSq"] + numeric * numeric}
        if not math.isfinite(merged["sum"]) or not math.isfinite(merged["sumSq"]):
            continue  # null in a row would cost the whole segment
        row.setdefault("outcomes", {})[name] = merged
