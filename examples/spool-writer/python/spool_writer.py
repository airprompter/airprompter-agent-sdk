"""A spool writer without the SDK (protocol/spool-format.md, D66): what a team
instrumenting a provider SDK themselves needs — minute windows per
(tag, artifactId, versionId, arm, model, status, errorClass, audienceIds,
outcomeRunMinute), the fixed latency buckets,
segment naming, ``.open`` → fsync → rename, and rotation on the minute or at
1 MiB. ``airprompterd`` uploads what lands in ``dir``. Standard library only;
``check_vectors.py`` drives it through protocol/vectors/spool.json.

::

    spool = SpoolWriter(dir=f"{state_dir}/airprompter/{agent_id}/{target}/spool/telemetry", instance_id=instance_id, sdk="acme-logger/1.0")
    spool.observe(tag=tag, version_id=version_id, arm=arm, model=model, status="ok", latency_ms=812, tokens={"input": 400, "output": 90})
    spool.feedback(tag=tag, version_id=version_id, arm=arm, model=model, outcomes={"accepted": True})
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

LATENCY_BUCKET_EDGES_MS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 65536]
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
    return any(_OUTCOME_NAME.fullmatch(name) and (isinstance(value, bool) or isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)) for name, value in outcomes.items())


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
        self.open_minute: Optional[str] = None
        self.seg_minute: Optional[int] = None
        self.seg_bytes, self.seg_n, self.sealed = 0, -1, False
        self.fd: Optional[int] = None
        self.seg_path = ""
        self.emitted: list[dict[str, Any]] = []
        if dir:
            os.makedirs(dir, mode=0o700, exist_ok=True)

    def observe(self, *, tag: str, version_id: str, model: str, latency_ms: float, artifact_id: Optional[str] = None, arm: str = "none", status: str = "ok", error_class: Optional[str] = None, usage_source: str = "reported", audience_ids: Optional[tuple[str, ...]] = None, run_minute: Optional[str] = None, tokens: Optional[Mapping[str, int]] = None, checks: Optional[Mapping[str, int]] = None, outcomes: Optional[Mapping[str, Any]] = None, at: Optional[float] = None) -> None:
        """One model call: latency, tokens, status and error class — never text, ids or messages."""
        row = self._window(self.now() if at is None else at, tag, version_id, arm, model, status, error_class, usage_source, artifact_id=artifact_id, audience_ids=audience_ids, run_minute=run_minute)
        if row.get("outcomeRunMinute") == row["minute"]:
            row.pop("outcomeRunMinute")
        row["count"] += 1
        row["latencyMs"]["buckets"][latency_bucket_index(latency_ms)] += 1
        row["latencyMs"]["sum"] += max(0, int(latency_ms + 0.5))
        tokens = tokens or {}
        row["tokens"]["input"] += tokens.get("input", 0)
        row["tokens"]["output"] += tokens.get("output", 0)
        if tokens.get("cachedInput"):
            row["tokens"]["cachedInput"] = row["tokens"].get("cachedInput", 0) + tokens["cachedInput"]
        if checks:
            previous = row.get("checks") or {"passed": 0, "failed": 0}
            row["checks"] = {"passed": previous["passed"] + checks.get("passed", 0), "failed": previous["failed"] + checks.get("failed", 0)}
        if outcomes:
            _merge_outcomes(row, outcomes)

    def feedback(self, *, tag: str, version_id: str, model: str, outcomes: Mapping[str, Any], artifact_id: Optional[str] = None, arm: str = "none", audience_ids: Optional[tuple[str, ...]] = None, outcome_run_minute: Optional[str] = None, at: Optional[float] = None) -> None:
        """Feedback filed against a run: rides on the run's ``ok`` window for this minute, never adds to count or latency."""
        at = self.now() if at is None else at
        if not _has_valid_outcome(outcomes):
            return
        if audience_ids is not None and not _valid_audience_ids(audience_ids):
            return
        if outcome_run_minute is not None and ((artifact_id is None and audience_ids is None) or not _valid_outcome_run_minute(outcome_run_minute) or outcome_run_minute > minute_of(at)):
            return
        if (audience_ids is not None or artifact_id is not None) and outcome_run_minute is None:
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

    def _window(self, at: float, tag: str, version_id: str, arm: str, model: str, status: str, error_class: Optional[str], usage_source: str, *, artifact_id: Optional[str] = None, audience_ids: Optional[tuple[str, ...]] = None, outcome_run_minute: Optional[str] = None, run_minute: Optional[str] = None) -> dict[str, Any]:
        minute = minute_of(at)
        if artifact_id is not None and (not isinstance(artifact_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", artifact_id)):
            raise ValueError("telemetry_artifact_id_invalid")
        if audience_ids is not None and not _valid_audience_ids(audience_ids):
            raise ValueError("telemetry_audience_ids_invalid")
        if outcome_run_minute is not None and ((artifact_id is None and audience_ids is None) or not _valid_outcome_run_minute(outcome_run_minute) or outcome_run_minute > minute):
            raise ValueError("telemetry_outcome_run_minute_invalid")
        if self.open_minute is not None and self.open_minute != minute:
            self.close(at)
        self.open_minute = minute
        outcome_key = None if outcome_run_minute == minute else outcome_run_minute
        key = json.dumps([tag, artifact_id, version_id, arm, model, status, error_class, audience_ids, outcome_key])
        row = self.open.get(key)
        if row is None:
            row = {"type": "window", "v": 3 if artifact_id is not None else 2 if audience_ids is not None else 1, "minute": minute, "instanceId": self.instance_id, "instanceClass": self.instance_class, "tag": tag, "versionId": version_id, "arm": arm, "model": model, "status": status, "errorClass": error_class, "usageSource": usage_source, "count": 0, "latencyMs": {"buckets": [0] * 16, "sum": 0}, "tokens": {"input": 0, "output": 0}, "sdk": self.sdk}
            if artifact_id is not None:
                row["artifactId"] = artifact_id
            if audience_ids is not None:
                row["audienceIds"] = list(audience_ids)
            if outcome_run_minute is not None:
                row["outcomeRunMinute"] = outcome_run_minute
            self.open[key] = row
        return row

    def close(self, at: Optional[float] = None) -> None:
        """Writes the open minute's rows to a segment (``.open``, fsync, rename) and starts a new minute."""
        at = self.now() if at is None else at
        rows = list(self.open.values())
        self.open.clear()
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


def _merge_outcomes(row: dict[str, Any], outcomes: Mapping[str, Any]) -> None:
    merged = row.setdefault("outcomes", {})
    for name, value in outcomes.items():
        numeric = (1 if value else 0) if isinstance(value, bool) else value
        if not _OUTCOME_NAME.match(name) or not isinstance(numeric, (int, float)) or numeric != numeric or numeric in (float("inf"), float("-inf")):
            continue
        current = merged.get(name, {"n": 0, "sum": 0})
        merged[name] = {"n": current["n"] + 1, "sum": current["sum"] + numeric}
