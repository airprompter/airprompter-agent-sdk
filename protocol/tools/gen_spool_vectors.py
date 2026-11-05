"""Independent generator for protocol/vectors/spool.json and feedback.json.

Written from the prose in spool-format.md and the schemas, not from any
SDK: latency bucket edges, minute formatting, segment naming, rotation at
the minute boundary and 1 MiB, minute-window aggregation (`count` means
runs, feedback rides on a run's window without counting as one, a step is a
row of its own), the feedback catalogue normalisation and the run reference
format. Two implementations agreeing on these files is the point. Usage::

    python3 protocol/tools/gen_spool_vectors.py protocol/vectors
"""
import base64
import datetime as dt
import hashlib
import hmac
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROTOCOL = open(os.path.join(HERE, "..", "VERSION"), encoding="utf-8").read().strip()
EDGES = json.load(open(os.path.join(HERE, "..", "schemas", "latency-buckets.json"), encoding="utf-8"))["edges"]
SEGMENT_MAX_BYTES = 1024 * 1024
OUTCOME_NAME = re.compile(r"^[a-z][a-zA-Z0-9]{0,31}$")
OUTCOME_MINUTE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z$")
ARTIFACT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
STEP_BOUNDS = {"maxLength": 64, "maxPerRun": 32}

def count_of(value):
    """A count a row may carry: a non-negative integer, whatever a caller handed in."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return 0
    return min(9007199254740991, max(0, int(value)))

def rounded_ms(value):
    return max(0, int(math.floor(value + 0.5))) if math.isfinite(value) else 0

def valid_step(value):
    return isinstance(value, str) and 1 <= len(value) <= STEP_BOUNDS["maxLength"] and not re.search("[\\x00-\\x1f\\x7f]", value)

def valid_outcome_run_minute(value):
    if not isinstance(value, str) or not OUTCOME_MINUTE.fullmatch(value) or value.startswith("0000-"):
        return False
    try:
        dt.datetime(int(value[0:4]), int(value[5:7]), int(value[8:10]), int(value[11:13]), int(value[14:16]), tzinfo=dt.timezone.utc)
        return True
    except (ValueError, OverflowError):
        return False

def valid_audience_ids(value):
    return isinstance(value, (list, tuple)) and len(value) <= 8 and all(isinstance(item, str) and re.fullmatch(r"aud_[A-Za-z0-9_-]{22}", item) and (index == 0 or value[index - 1] < item) for index, item in enumerate(value))

def has_valid_outcome(outcomes):
    return any(OUTCOME_NAME.fullmatch(name) and (isinstance(value, bool) or isinstance(value, (int, float)) and math.isfinite(value * value)) for name, value in outcomes.items())

# ----------------------------------------------------------------------------- pure functions

def bucket_index(latency_ms: float) -> int:
    for index, edge in enumerate(EDGES):
        if latency_ms <= edge:
            return index
    return len(EDGES) - 1

def minute_of(epoch_ms: int) -> str:
    return dt.datetime.fromtimestamp(epoch_ms // 60000 * 60, tz=dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def iso_of(epoch_ms: int) -> str:
    seconds, millis = divmod(epoch_ms, 1000)
    base = dt.datetime.fromtimestamp(seconds, tz=dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    return f"{base}.{millis:03d}Z"

def epoch_minute(epoch_ms: int) -> int:
    return epoch_ms // 60000

def segment_name(instance_id: str, minute: int, n: int) -> str:
    return f"seg-{instance_id}-{minute}-{n}.ndjson"

class Planner:
    """Which segment an appended line lands in (spool-format.md › Segment files)."""

    def __init__(self, instance_id: str):
        self.instance_id = instance_id
        self.open_minute = None
        self.open_bytes = 0
        self.n = 0

    def append(self, epoch_ms: int, line_bytes: int):
        minute = epoch_minute(epoch_ms)
        rotated = self.open_minute is None or minute != self.open_minute or self.open_bytes + line_bytes > SEGMENT_MAX_BYTES
        if rotated:
            self.n = self.n + 1 if minute == self.open_minute else 0
            self.open_minute = minute
            self.open_bytes = 0
        self.open_bytes += line_bytes
        return segment_name(self.instance_id, self.open_minute, self.n), rotated

class Aggregator:
    """Minute windows per dimension set; feedback merges outcomes without a count."""

    def __init__(self, instance_id: str, instance_class: str, sdk: str):
        self.identity = (instance_id, instance_class, sdk)
        self.open = {}
        self.open_steps = {}
        self.step_names = {}
        self.open_minute = None
        self.emitted = []
        self.emitted_steps = []

    def _turn_minute(self, at: int) -> str:
        minute = minute_of(at)
        if self.open_minute is not None and self.open_minute != minute:
            self.close(at)
        self.open_minute = minute
        return minute

    @staticmethod
    def _check(at: int, artifact_id, audience_ids, outcome_run_minute=None):
        if not isinstance(artifact_id, str) or not ARTIFACT_ID.fullmatch(artifact_id):
            raise ValueError("telemetry_artifact_id_invalid")
        if audience_ids is not None and not valid_audience_ids(audience_ids):
            raise ValueError("telemetry_audience_ids_invalid")
        if outcome_run_minute is not None and (not valid_outcome_run_minute(outcome_run_minute) or outcome_run_minute > minute_of(at)):
            raise ValueError("telemetry_outcome_run_minute_invalid")

    def _window(self, at: int, tag, version_id, arm, model, status, error_class, usage_source, *, artifact_id=None, audience_ids=None, outcome_run_minute=None):
        self._check(at, artifact_id, audience_ids, outcome_run_minute)
        minute = self._turn_minute(at)
        outcome_key = None if outcome_run_minute == minute else outcome_run_minute
        key = (tag, artifact_id, version_id, arm, model, status, error_class, tuple(audience_ids) if audience_ids is not None else None, outcome_key)
        row = self.open.get(key)
        if row is None:
            row = {
                "type": "window", "v": 4, "artifactId": artifact_id, "minute": minute,
                "instanceId": self.identity[0], "instanceClass": self.identity[1],
                "tag": tag, "versionId": version_id, "arm": arm, "model": model, "status": status,
                "errorClass": error_class, "usageSource": usage_source or "reported", "count": 0,
                "modelCalls": 0, "agentRun": 0, "tools": {"calls": 0, "errors": 0},
                "latencyMs": {"buckets": [0] * len(EDGES), "sum": 0}, "tokens": {"input": 0, "output": 0},
                "sdk": self.identity[2],
            }
            if audience_ids is not None: row["audienceIds"] = list(audience_ids)
            if outcome_run_minute is not None: row["outcomeRunMinute"] = outcome_run_minute
            self.open[key] = row
        return row

    def record_run(self, at: int, r: dict):
        """One run's totals: the only place `count` rises. Moments are over the run's totals, never per model call."""
        d = r["dimensions"]
        row = self._window(at, d["tag"], d["versionId"], d["arm"], d["model"], r["status"], r.get("errorClass"), r.get("usageSource"), artifact_id=d.get("artifactId"), audience_ids=d.get("audienceIds"))
        if row.get("outcomeRunMinute") == row["minute"]:
            row.pop("outcomeRunMinute")
        row["count"] += 1
        row["agentRun"] += r["agentRun"]
        row["modelCalls"] += count_of(r["modelCalls"])
        row["tools"]["calls"] += count_of(r["tools"]["calls"])
        row["tools"]["errors"] += count_of(r["tools"]["errors"])
        row["latencyMs"]["buckets"][bucket_index(r["latencyMs"])] += 1
        row["latencyMs"]["sum"] += rounded_ms(r["latencyMs"])  # half up, as the format says
        t = {k: count_of(v) for k, v in r["tokens"].items()}
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
        if "checks" in r:
            checks = row.setdefault("checks", {"passed": 0, "failed": 0})
            checks["passed"] += r["checks"]["passed"]
            checks["failed"] += r["checks"]["failed"]
        return row

    def record_step(self, at: int, r: dict):
        """One step's totals: a row of its own; no window changes. The cap holds per run dimensions within the open minute."""
        d = r["dimensions"]
        self._check(at, d.get("artifactId"), d.get("audienceIds"))
        minute = self._turn_minute(at)
        dimension_key = (d["tag"], d["artifactId"], d["versionId"], d["arm"], d["model"], tuple(d["audienceIds"]) if "audienceIds" in d else None)
        names = self.step_names.setdefault(dimension_key, set())
        step = r["step"] if valid_step(r["step"]) else "other"
        if step != "other" and step not in names:
            if len(names) >= STEP_BOUNDS["maxPerRun"]:
                step = "other"
            else:
                names.add(step)
        key = (dimension_key, step, r["status"], r.get("errorClass"))
        row = self.open_steps.get(key)
        if row is None:
            row = {
                "type": "step", "v": 1, "artifactId": d["artifactId"], "minute": minute,
                "instanceId": self.identity[0], "instanceClass": self.identity[1],
                "tag": d["tag"], "versionId": d["versionId"], "arm": d["arm"], "model": d["model"], "step": step, "status": r["status"],
                "errorClass": r.get("errorClass"), "usageSource": r.get("usageSource") or "reported", "modelCalls": 0,
                "latencyMs": {"buckets": [0] * len(EDGES), "sum": 0}, "tokens": {"input": 0, "output": 0}, "tools": {"calls": 0, "errors": 0},
                "sdk": self.identity[2],
            }
            if "audienceIds" in d: row["audienceIds"] = list(d["audienceIds"])
            self.open_steps[key] = row
        for index, count in enumerate(r["latency"]["buckets"]):
            row["latencyMs"]["buckets"][index] += count_of(count)
            row["modelCalls"] += count_of(count)  # the histogram counts the model calls: the validator holds the two equal
        row["latencyMs"]["sum"] += rounded_ms(r["latency"]["sum"])
        tokens = {k: count_of(v) for k, v in r["tokens"].items()}
        row["tokens"]["input"] += tokens["input"]
        row["tokens"]["output"] += tokens["output"]
        if tokens["cachedInput"]:
            row["tokens"]["cachedInput"] = row["tokens"].get("cachedInput", 0) + tokens["cachedInput"]
        row["tools"]["calls"] += count_of(r["tools"]["calls"])
        row["tools"]["errors"] += count_of(r["tools"]["errors"])

    def observe(self, at: int, o: dict):
        """A one-call run: one run row, and a step row only when the observation names a step."""
        tokens = {"input": (o.get("tokens") or {}).get("input", 0), "cachedInput": (o.get("tokens") or {}).get("cachedInput", 0), "output": (o.get("tokens") or {}).get("output", 0)}
        tools = {"calls": (o.get("toolCalls") or {}).get("calls", 0), "errors": (o.get("toolCalls") or {}).get("errors", 0)}
        slot_tag = o["tag"]
        step = o.get("step")
        dimensions = {**{k: o[k] for k in ("artifactId", "versionId", "arm", "model", "audienceIds") if k in o}, "tag": slot_tag}
        run = {"dimensions": dimensions, "status": o["status"], "errorClass": o.get("errorClass"), "usageSource": o.get("usageSource"), "agentRun": 1, "modelCalls": 1, "latencyMs": o["latencyMs"], "tokens": tokens, "tools": tools}
        if "checks" in o:
            run["checks"] = {"passed": o["checks"].get("passed", 0), "failed": o["checks"].get("failed", 0)}
        row = self.record_run(at, run)
        if "outcomes" in o:
            merge_outcomes(row, o["outcomes"])
        if step is not None:
            buckets = [0] * len(EDGES)
            buckets[bucket_index(o["latencyMs"])] = 1
            self.record_step(at, {"dimensions": dimensions, "step": step, "status": "ok" if o["status"] == "ok" else "error", "errorClass": o.get("errorClass"), "usageSource": o.get("usageSource"), "modelCalls": 1, "latency": {"buckets": buckets, "sum": rounded_ms(o["latencyMs"])}, "tokens": tokens, "tools": tools})

    def outcomes(self, at: int, f: dict):
        if not has_valid_outcome(f["outcomes"]) or "artifactId" not in f:
            return
        if "audienceIds" in f and not valid_audience_ids(f["audienceIds"]):
            return
        if "outcomeRunMinute" in f and (not valid_outcome_run_minute(f["outcomeRunMinute"]) or f["outcomeRunMinute"] > minute_of(at)):
            return
        if "outcomeRunMinute" not in f:
            minute = minute_of(at)
            if self.open_minute != minute:
                return
            key = (f["tag"], f.get("artifactId"), f["versionId"], f["arm"], f["model"], "ok", None, tuple(f["audienceIds"]) if "audienceIds" in f else None, None)
            row = self.open.get(key)
            if row is None or row["count"] == 0:
                return
            merge_outcomes(row, f["outcomes"])
            return
        merge_outcomes(self._window(at, f["tag"], f["versionId"], f["arm"], f["model"], "ok", None, None, artifact_id=f.get("artifactId"), audience_ids=f.get("audienceIds"), outcome_run_minute=f.get("outcomeRunMinute")), f["outcomes"])

    def close(self, at: int):
        self.emitted.extend(self.open.values())
        self.emitted_steps.extend(self.open_steps.values())
        self.open = {}
        self.open_steps = {}
        self.step_names = {}
        self.open_minute = None

def merge_outcomes(row: dict, outcomes: dict):
    for name, value in outcomes.items():
        if not OUTCOME_NAME.match(name):
            continue
        if isinstance(value, bool):
            value = 1 if value else 0
        elif not isinstance(value, (int, float)) or value != value or value in (float("inf"), float("-inf")):
            continue
        current = row.get("outcomes", {}).get(name, {"n": 0, "sum": 0, "sumSq": 0})
        merged = {"n": current["n"] + 1, "sum": current["sum"] + value, "sumSq": current["sumSq"] + value * value}
        if not math.isfinite(merged["sum"]) or not math.isfinite(merged["sumSq"]):
            continue  # a total that serialises as null would cost the whole segment
        row.setdefault("outcomes", {})[name] = merged

# Feedback catalogue (feedback-signals.schema.json) → window outcomes.
BOOLEAN_SIGNALS = ["flagged", "accepted", "edited", "regenerated", "copied", "followUp", "escalated", "abandoned", "corrected", "resolved", "reopened", "converted", "refunded", "slaMet"]
UNIT_SIGNALS = ["editDistanceRatio", "judgeScore"]
COUNT_SIGNALS = ["regenerations", "timeToAcceptMs"]
# T34: written by the runtime on a window (a golden-set run), never accepted from ap.feedback(); reserved so custom cannot shadow it.
RUNTIME_SIGNALS = ["goldenPass"]
CATALOGUE = set(["thumbs", "rating", "correctedValue", "custom"] + BOOLEAN_SIGNALS + UNIT_SIGNALS + COUNT_SIGNALS + RUNTIME_SIGNALS)

def is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and v not in (float("inf"), float("-inf"))

def normalize_feedback(signals: dict):
    outcomes, rejected = {}, {}
    for name, value in signals.items():
        if name == "thumbs":
            if value in ("up", "down"):
                outcomes["thumbs"] = value == "up"
            else:
                rejected[name] = "invalid_value"
        elif name == "rating":
            if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 5:
                outcomes["rating"] = value
            else:
                rejected[name] = "invalid_value"
        elif name in BOOLEAN_SIGNALS:
            if isinstance(value, bool):
                outcomes[name] = value
            else:
                rejected[name] = "invalid_value"
        elif name in UNIT_SIGNALS:
            if is_number(value) and 0 <= value <= 1:
                outcomes[name] = value
            else:
                rejected[name] = "invalid_value"
        elif name in COUNT_SIGNALS:
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                outcomes[name] = value
            else:
                rejected[name] = "invalid_value"
        elif name == "correctedValue":
            # Needs the slot's declared output enum to aggregate per value; a writer without it does not record it.
            rejected[name] = "needs_slot_enum" if isinstance(value, str) and len(value) <= 64 else "invalid_value"
        elif name in RUNTIME_SIGNALS:
            rejected[name] = "reserved_name"
        elif name == "custom":
            if not isinstance(value, dict) or len(value) > 8:
                rejected[name] = "invalid_value"
                continue
            for custom_name, custom_value in value.items():
                if not OUTCOME_NAME.match(custom_name):
                    rejected[f"custom.{custom_name}"] = "invalid_name"
                elif custom_name in CATALOGUE:
                    rejected[f"custom.{custom_name}"] = "reserved_name"
                elif isinstance(custom_value, bool) or is_number(custom_value):
                    outcomes[custom_name] = custom_value
                else:
                    rejected[f"custom.{custom_name}"] = "invalid_value"
        else:
            rejected[name] = "unknown_signal"
    return outcomes, rejected

# ----------------------------------------------------------------------------- vectors

T0 = 1789221790000  # 2026-09-12T14:03:10Z
INSTANCE = "i-7f3aQx9kLmN2pQ"
SDK = "agent-sdk-ts/0.1.0"

def spool_vectors():
    buckets = [{"latencyMs": ms, "bucket": bucket_index(ms)} for ms in [0, 0.4, 1, 1.5, 2, 3, 4, 5, 8, 16, 17, 32, 64, 128, 129, 256, 512, 513, 812, 1024, 1025, 1201, 2048, 4096, 8192, 8193, 16384, 16385, 30000, 32768, 32769, 65536, 65537, 131072, 200000, 262144, 262145, 524288, 600000, 1048576, 2097152, 2097153, 3600000, 3600001, 7200000]]
    minutes = [
        {"name": "ten seconds into the minute", "epochMs": T0, "minute": minute_of(T0), "epochMinute": epoch_minute(T0)},
        {"name": "exactly on the minute", "epochMs": T0 - 10000, "minute": minute_of(T0 - 10000), "epochMinute": epoch_minute(T0 - 10000)},
        {"name": "last millisecond of the minute", "epochMs": T0 + 49999, "minute": minute_of(T0 + 49999), "epochMinute": epoch_minute(T0 + 49999)},
        {"name": "first millisecond of the next minute", "epochMs": T0 + 50000, "minute": minute_of(T0 + 50000), "epochMinute": epoch_minute(T0 + 50000)},
        {"name": "epoch", "epochMs": 0, "minute": minute_of(0), "epochMinute": 0},
        {"name": "day boundary", "epochMs": 1789257599999, "minute": minute_of(1789257599999), "epochMinute": epoch_minute(1789257599999)},
    ]
    names = [
        {"instanceId": INSTANCE, "epochMs": T0, "n": 0, "name": segment_name(INSTANCE, epoch_minute(T0), 0)},
        {"instanceId": INSTANCE, "epochMs": T0, "n": 7, "name": segment_name(INSTANCE, epoch_minute(T0), 7)},
        {"instanceId": "i-a.b_c~d", "epochMs": T0 + 60000, "n": 0, "name": segment_name("i-a.b_c~d", epoch_minute(T0 + 60000), 0)},
    ]

    def rotation(name, appends, note):
        planner = Planner(INSTANCE)
        segments, out = [], []
        for epoch_ms, line_bytes in appends:
            seg, rotated = planner.append(epoch_ms, line_bytes)
            out.append({"epochMs": epoch_ms, "lineBytes": line_bytes, "segment": seg, "rotated": rotated})
            if rotated:
                segments.append({"name": seg, "rows": 0, "bytes": 0})
            segments[-1]["rows"] += 1
            segments[-1]["bytes"] += line_bytes
        return {"name": name, "note": note, "instanceId": INSTANCE, "appends": out, "segments": segments}

    big = 300 * 1024
    rotations = [
        rotation("one minute, a few rows", [(T0, 200), (T0 + 5000, 210), (T0 + 49999, 190)], "all rows within one minute share one segment"),
        rotation("minute boundary", [(T0, 200), (T0 + 50000, 200), (T0 + 50001, 200)], "the first row after the minute turns opens a new segment with n=0"),
        rotation("1 MiB within a minute", [(T0, big), (T0 + 1, big), (T0 + 2, big), (T0 + 3, big), (T0 + 4, 100)], "the fourth 300 KiB row would exceed 1 MiB: it opens n=1 in the same minute; the small row follows it"),
        rotation("exactly 1 MiB fits", [(T0, SEGMENT_MAX_BYTES - 1), (T0 + 1, 1), (T0 + 2, 1)], "a segment may reach exactly 1 MiB; the next byte rotates"),
        rotation("a line larger than the cap", [(T0, SEGMENT_MAX_BYTES + 1), (T0 + 1, 10)], "an oversize line still lands in a segment of its own; the next line rotates again"),
        rotation("n resets on a new minute", [(T0, big), (T0 + 1, big), (T0 + 2, big), (T0 + 3, big), (T0 + 50000, 10)], "n counts within a minute only"),
        rotation("gap of many minutes", [(T0, 10), (T0 + 3600000, 10)], "the epochMinute in the name is the append's minute, not a counter"),
    ]

    def windows(name, note, events, instance_class="resident"):
        agg = Aggregator(INSTANCE, instance_class, SDK)
        refusals = []
        for event in events:
            kind = event["kind"]
            if kind == "observe":
                agg.observe(event["at"], event["observation"])
            elif kind == "recordRun":
                agg.record_run(event["at"], event["run"])
            elif kind == "recordStep":
                agg.record_step(event["at"], event["step"])
            elif kind == "feedback":
                agg.outcomes(event["at"], event["feedback"])
            elif kind == "refusal":
                refusals.append({"type": "refusal", "v": 1, "at": iso_of(event["at"]), "instanceId": INSTANCE, "reason": event["reason"], "generation": event["generation"], "tag": event.get("tag")})
            elif kind == "close":
                agg.close(event["at"])
        return {"name": name, "note": note, "instanceId": INSTANCE, "instanceClass": instance_class, "sdk": SDK, "events": events, "expectedWindows": agg.emitted, "expectedSteps": agg.emitted_steps, "expectedRefusals": refusals}

    triage = {"tag": "support.triage", "artifactId": "prm_support_triage", "versionId": "ver_triage_7", "arm": "none", "model": "claude-haiku-4-5"}
    ok = lambda **k: {**triage, "status": "ok", **k}
    # What a run session hands the writer at `end`: one run's totals, however many calls it made.
    dims = {k: triage[k] for k in ("tag", "artifactId", "versionId", "arm", "model")}
    reply = {"tag": "support.reply", "artifactId": "prm_support_reply", "versionId": "ver_reply_3", "arm": "candidate", "model": "gpt-5"}
    def run(dimensions=dims, *, status="ok", error_class=None, usage="reported", agent_run=1, model_calls=1, latency=1000, tokens=(0, 0, 0), tools=(0, 0)):
        return {"dimensions": dimensions, "status": status, "errorClass": error_class, "usageSource": usage, "agentRun": agent_run, "modelCalls": model_calls, "latencyMs": latency, "tokens": {"input": tokens[0], "cachedInput": tokens[1], "output": tokens[2]}, "tools": {"calls": tools[0], "errors": tools[1]}}
    def step(name, dimensions=dims, *, status="ok", error_class=None, usage="reported", latencies=(100,), tokens=(0, 0, 0), tools=(0, 0)):
        histogram = [0] * len(EDGES)
        for ms in latencies:
            histogram[bucket_index(ms)] += 1
        return {"dimensions": dimensions, "step": name, "status": status, "errorClass": error_class, "usageSource": usage, "modelCalls": len(latencies), "latency": {"buckets": histogram, "sum": sum(latencies)}, "tokens": {"input": tokens[0], "cachedInput": tokens[1], "output": tokens[2]}, "tools": {"calls": tools[0], "errors": tools[1]}}
    window_cases = [
        windows("two runs and feedback on one window", "feedback merges outcomes into the runs' window (status ok) and never adds to count or latency", [
            {"kind": "observe", "at": T0, "observation": ok(latencyMs=812, tokens={"input": 400, "output": 90, "cachedInput": 100}, checks={"passed": 1})},
            {"kind": "observe", "at": T0 + 1000, "observation": ok(latencyMs=1201, tokens={"input": 380, "output": 70})},
            {"kind": "feedback", "at": T0 + 2000, "feedback": {**triage, "outcomes": {"thumbs": True, "rating": 4, "accepted": True}}},
            {"kind": "close", "at": T0 + 3000},
        ]),
        windows("dimension sets split windows", "status, errorClass, arm and model each open their own window; ordering of rows is not significant", [
            {"kind": "observe", "at": T0, "observation": ok(latencyMs=5)},
            {"kind": "observe", "at": T0 + 1, "observation": {**triage, "status": "error", "errorClass": "provider_timeout", "latencyMs": 30000}},
            {"kind": "observe", "at": T0 + 2, "observation": ok(arm="candidate", latencyMs=6)},
            {"kind": "observe", "at": T0 + 3, "observation": ok(model="gpt-5", latencyMs=7)},
            {"kind": "observe", "at": T0 + 4, "observation": ok(versionId="ver_triage_8", latencyMs=8)},
            {"kind": "observe", "at": T0 + 5, "observation": {**triage, "status": "refused", "latencyMs": 0}},
            {"kind": "observe", "at": T0 + 6, "observation": ok(latencyMs=9, usageSource="estimated")},
            {"kind": "close", "at": T0 + 10},
        ]),
        windows("prompt artifacts split otherwise equal versions", "artifactId is a dimension: two Team prompts that both have version 1 never merge after a slot changes prompts", [
            {"kind": "observe", "at": T0, "observation": ok(artifactId="prm_support_alpha", versionId="ver_1", latencyMs=10)},
            {"kind": "observe", "at": T0 + 1, "observation": ok(artifactId="prm_support_beta", versionId="ver_1", latencyMs=20)},
            {"kind": "close", "at": T0 + 2},
        ]),
        windows("artifact-aware delayed feedback", "delayed feedback keeps the stable prompt identity and original run minute without requiring an observed audience", [
            {"kind": "feedback", "at": T0 + 60000, "feedback": {**triage, "artifactId": "prm_support_alpha", "outcomeRunMinute": minute_of(T0), "outcomes": {"thumbs": True}}},
            {"kind": "close", "at": T0 + 60001},
        ]),
        windows("artifact feedback in its run minute merges", "an authenticated run minute equal to the filing minute is normalized onto the observed window, including when feedback arrives first", [
            {"kind": "feedback", "at": T0, "feedback": {**triage, "artifactId": "prm_support_alpha", "outcomeRunMinute": minute_of(T0), "outcomes": {"thumbs": True}}},
            {"kind": "observe", "at": T0 + 1, "observation": ok(artifactId="prm_support_alpha", latencyMs=10)},
            {"kind": "close", "at": T0 + 2},
        ]),
        windows("unattributed feedback is ignored", "feedback cannot create a zero-run row without an authenticated outcomeRunMinute", [
            {"kind": "feedback", "at": T0, "feedback": {**triage, "artifactId": "prm_support_alpha", "outcomes": {"thumbs": True}}},
            {"kind": "feedback", "at": T0 + 1, "feedback": {**triage, "audienceIds": ["aud_AAAAAAAAAAAAAAAAAAAAAA"], "outcomes": {"thumbs": False}}},
            {"kind": "close", "at": T0 + 2},
        ]),
        windows("invalid outcome attribution is ignored", "writers refuse malformed or impossible run minutes, feedback with no artifact, and non-opaque audience ids before a row is created", [
            {"kind": "feedback", "at": T0, "feedback": {**triage, "artifactId": "prm_support_alpha", "outcomeRunMinute": "not-a-minute", "outcomes": {"thumbs": True}}},
            {"kind": "feedback", "at": T0 + 1, "feedback": {**triage, "artifactId": "prm_support_alpha", "outcomeRunMinute": "2026-02-30T14:03:00Z", "outcomes": {"thumbs": True}}},
            {"kind": "feedback", "at": T0 + 2, "feedback": {k: v for k, v in {**triage, "outcomeRunMinute": minute_of(T0), "outcomes": {"thumbs": True}}.items() if k != "artifactId"}},
            {"kind": "feedback", "at": T0 + 3, "feedback": {**triage, "artifactId": "prm_support_alpha", "audienceIds": ["raw-device-value"], "outcomeRunMinute": minute_of(T0), "outcomes": {"thumbs": True}}},
            {"kind": "feedback", "at": T0 + 4, "feedback": {**triage, "artifactId": "prm_support_alpha", "outcomeRunMinute": minute_of(T0 + 60000), "outcomes": {"thumbs": True}}},
            {"kind": "feedback", "at": T0 + 5, "feedback": {**triage, "artifactId": "prm_support_alpha", "outcomeRunMinute": minute_of(T0), "outcomes": {"Bad-Name": 1}}},
            {"kind": "close", "at": T0 + 6},
        ]),
        windows("same-minute feedback finds measured runs", "without outcomeRunMinute, feedback may attach only to an already measured matching run in the open minute", [
            {"kind": "observe", "at": T0, "observation": ok(artifactId="prm_support_alpha", latencyMs=10)},
            {"kind": "feedback", "at": T0 + 1, "feedback": {**triage, "artifactId": "prm_support_alpha", "outcomes": {"thumbs": True}}},
            {"kind": "observe", "at": T0 + 2, "observation": ok(audienceIds=["aud_AAAAAAAAAAAAAAAAAAAAAA"], latencyMs=20)},
            {"kind": "feedback", "at": T0 + 3, "feedback": {**triage, "audienceIds": ["aud_AAAAAAAAAAAAAAAAAAAAAA"], "outcomes": {"thumbs": False}}},
            {"kind": "close", "at": T0 + 4},
        ]),
        windows("late completion never reopens a sealed minute", "runMinute is feedback attribution only; observations aggregate by completion minute so a sealed SET key is never replaced", [
            {"kind": "observe", "at": T0, "observation": ok(artifactId="prm_support_alpha", runMinute=minute_of(T0), latencyMs=10)},
            {"kind": "close", "at": T0 + 1},
            {"kind": "observe", "at": T0 + 60000, "observation": ok(artifactId="prm_support_alpha", runMinute=minute_of(T0), latencyMs=20)},
            {"kind": "close", "at": T0 + 60001},
        ]),
        windows("the minute turns", "an observation in a new minute closes every open window first; the new minute's windows close at the explicit close", [
            {"kind": "observe", "at": T0, "observation": ok(latencyMs=100)},
            {"kind": "observe", "at": T0 + 49999, "observation": ok(latencyMs=200)},
            {"kind": "observe", "at": T0 + 50000, "observation": ok(latencyMs=300)},
            {"kind": "close", "at": T0 + 60000},
        ]),
        windows("outcome names are filtered, values coerced", "booleans count 1/0; names outside ^[a-z][a-zA-Z0-9]{0,31}$ and non-finite numbers are dropped silently", [
            {"kind": "observe", "at": T0, "observation": ok(latencyMs=1, outcomes={"accepted": True, "rating": 3, "edited": False})},
            {"kind": "observe", "at": T0 + 1, "observation": ok(latencyMs=1, outcomes={"accepted": False, "rating": 5, "Bad-Name": 1, "x" * 33: 1, "9lead": 1})},
            {"kind": "feedback", "at": T0 + 2, "feedback": {**triage, "outcomes": {"accepted": True, "editDistanceRatio": 0.25}}},
            {"kind": "close", "at": T0 + 3},
        ]),
        windows("feedback before any run opens the window", "feedback on a run from an earlier minute yields a window with count 0 (it is not a run), no moments and every measure zero; usageSource defaults to reported", [
            {"kind": "feedback", "at": T0 + 60000, "feedback": {**triage, "outcomeRunMinute": minute_of(T0), "outcomes": {"thumbs": False, "rating": 4}}},
            {"kind": "close", "at": T0 + 60001},
        ]),
        windows("latency edges and the sum", "each bucket counts ≤ its edge; sum is the rounded, non-negative total", [
            {"kind": "observe", "at": T0, "observation": ok(latencyMs=1)},
            {"kind": "observe", "at": T0, "observation": ok(latencyMs=1024)},
            {"kind": "observe", "at": T0, "observation": ok(latencyMs=1025)},
            {"kind": "observe", "at": T0, "observation": ok(latencyMs=65537)},
            {"kind": "observe", "at": T0, "observation": ok(latencyMs=2.4)},
            {"kind": "observe", "at": T0, "observation": ok(latencyMs=2.5)},
            {"kind": "close", "at": T0 + 1},
        ]),
        windows("refusals are rows of their own", "a refusal is appended as it happens, never windowed; close emits nothing when nothing was observed", [
            {"kind": "refusal", "at": T0, "reason": "forced_downgrade", "generation": 41, "tag": None},
            {"kind": "refusal", "at": T0 + 500, "reason": "lease_expired", "generation": 42, "tag": "support.triage"},
            {"kind": "close", "at": T0 + 1000},
        ]),
        windows("ephemeral instance closes at invocation end", "serverless hosts flush at the end of every invocation; a window can hold one run", [
            {"kind": "observe", "at": T0, "observation": ok(latencyMs=50, tokens={"input": 10, "output": 5})},
            {"kind": "close", "at": T0 + 60},
            {"kind": "observe", "at": T0 + 70, "observation": ok(latencyMs=60, tokens={"input": 10, "output": 5})},
            {"kind": "close", "at": T0 + 130},
        ], instance_class="ephemeral"),
        windows("five model calls and two tool calls in one run", "count 1, agentRun 1, modelCalls 5, and tokensSq over the run's totals, not per call", [
            {"kind": "recordRun", "at": T0, "run": run(model_calls=5, latency=4200, tokens=(1000, 200, 300), tools=(2, 0))},
            {"kind": "close", "at": T0 + 1},
        ]),
        windows("correlated tokens: every moment is its own number", "input and output rise together, so a dropped product term cannot pass: the three squares and three products are each summed over runs", [
            {"kind": "recordRun", "at": T0, "run": run(latency=100, tokens=(10, 3, 20))},
            {"kind": "recordRun", "at": T0 + 1, "run": run(latency=200, tokens=(100, 7, 210))},
            {"kind": "recordRun", "at": T0 + 2, "run": run(latency=300, tokens=(1000, 11, 1900))},
            {"kind": "feedback", "at": T0 + 3, "feedback": {**triage, "outcomes": {"rating": 3}}},
            {"kind": "feedback", "at": T0 + 4, "feedback": {**triage, "outcomes": {"rating": 5, "judgeScore": 0.25}}},
            {"kind": "close", "at": T0 + 5},
        ]),
        windows("two slots in one run", "two run rows, each count 1; agentRun 1 on the first only, so an agent-wide total counts the run once", [
            {"kind": "recordRun", "at": T0, "run": run(agent_run=1, model_calls=2, latency=900, tokens=(40, 0, 10))},
            {"kind": "recordRun", "at": T0, "run": run(reply, agent_run=0, model_calls=1, latency=900, tokens=(20, 0, 5), tools=(1, 1))},
            {"kind": "close", "at": T0 + 1},
        ]),
        windows("two recordRun calls for one run on one key", "agentRun 1 then 0 on the same dimensions: count rises by 2, agentRun by 1", [
            {"kind": "recordRun", "at": T0, "run": run(agent_run=1, latency=10)},
            {"kind": "recordRun", "at": T0 + 1, "run": run(agent_run=0, latency=10)},
            {"kind": "close", "at": T0 + 2},
        ]),
        windows("workflow slot, three steps inside a run", "one tag; three type step rows, each with its own step id in step and the slot tag in tag; one run row; step rows add nothing to the window", [
            {"kind": "recordStep", "at": T0, "step": step("docs.flow#1", dims, latencies=(300, 400), tokens=(50, 0, 20), tools=(1, 0))},
            {"kind": "recordStep", "at": T0 + 1, "step": step("docs.flow#2", dims, latencies=(500,), tokens=(30, 10, 10), tools=(2, 1))},
            {"kind": "recordStep", "at": T0 + 2, "step": step("docs.flow#3", dims, status="error", error_class="provider_timeout", latencies=(30000,), usage="unavailable")},
            {"kind": "recordRun", "at": T0 + 3, "run": run(status="error", error_class="provider_timeout", model_calls=4, latency=31000, tokens=(80, 10, 30), tools=(3, 1))},
            {"kind": "close", "at": T0 + 4},
        ]),
        windows("one-call run", "observe writes a run row and no step row", [
            {"kind": "observe", "at": T0, "observation": ok(latencyMs=812, tokens={"input": 400, "output": 90}, toolCalls={"calls": 1, "errors": 0})},
            {"kind": "close", "at": T0 + 1},
        ]),
        windows("a step reported outside a run", "observe with step: one run row, count 1, and one step row with the same totals; tag stays the slot's", [
            {"kind": "observe", "at": T0, "observation": ok(latencyMs=812, tokens={"input": 400, "cachedInput": 50, "output": 90}, toolCalls={"calls": 2, "errors": 1}, step="docs.flow#2")},
            {"kind": "close", "at": T0 + 1},
        ]),
        windows("step name past maxPerRun", "32 distinct names stand; the 33rd and 34th are written as other, and a name already seen keeps its row", [
            *[{"kind": "recordStep", "at": T0, "step": step(f"node-{i}", dims)} for i in range(1, 35)],
            {"kind": "recordStep", "at": T0, "step": step("node-1", dims)},
            {"kind": "close", "at": T0 + 1},
        ]),
        windows("step name past maxLength", "a name of 65 characters, an empty name and a control character are each written as other; 64 characters stand", [
            {"kind": "recordStep", "at": T0, "step": step("n" * 64, dims)},
            {"kind": "recordStep", "at": T0, "step": step("n" * 65, dims)},
            {"kind": "recordStep", "at": T0, "step": step("", dims)},
            {"kind": "recordStep", "at": T0, "step": step("bad\u0007name", dims)},
            {"kind": "close", "at": T0 + 1},
        ]),
        windows("interrupted", "an idle end counts one run on its own row, and it is not an error", [
            {"kind": "recordRun", "at": T0, "run": run(status="interrupted", latency=900000)},
            {"kind": "close", "at": T0 + 1},
        ]),
        windows("model_unresolved is an error run", "a release whose model cannot run here is an error row a gate can see", [
            {"kind": "recordRun", "at": T0, "run": run(status="error", error_class="model_unresolved", model_calls=0, latency=0, usage="unavailable")},
            {"kind": "close", "at": T0 + 1},
        ]),
        windows("whatever a caller hands in, a writer writes counts", "tool and token counts clamp to non-negative integers, so a row always passes the validator", [
            {"kind": "observe", "at": T0, "observation": ok(latencyMs=10, tokens={"input": 2.7, "cachedInput": -3, "output": 4}, toolCalls={"calls": 1.5, "errors": -1})},
            {"kind": "close", "at": T0 + 1},
        ]),
        windows("a step's latency sum is rounded", "half up, as a run's is; the histogram counts the model calls", [
            {"kind": "recordStep", "at": T0, "step": {**step("docs.flow#1", dims, latencies=(4,)), "modelCalls": 7, "latency": {"buckets": step("x", dims, latencies=(4,))["latency"]["buckets"], "sum": 12.5}}},
            {"kind": "close", "at": T0 + 1},
        ]),
        windows("a total that would not be finite is skipped", "1e200 squared overflows: that signal is skipped on this row and the others land", [
            {"kind": "observe", "at": T0, "observation": ok(latencyMs=10, outcomes={"score": 1e200, "accepted": True})},
            {"kind": "close", "at": T0 + 1},
        ]),
        windows("an outcome that cannot be written makes no row", "a feedback-only row with nothing in it would not pass the validator", [
            {"kind": "feedback", "at": T0 + 60000, "feedback": {**triage, "outcomeRunMinute": minute_of(T0), "outcomes": {"score": 1e200}}},
            {"kind": "close", "at": T0 + 60001},
        ]),
        windows("a long run stays below the last bucket", "a 200-second run lands in the 262,144 ms bucket, so p95 does not saturate", [
            {"kind": "recordRun", "at": T0, "run": run(latency=200000)},
            {"kind": "close", "at": T0 + 1},
        ]),
    ]
    return {
        "protocol": PROTOCOL,
        "description": "Spool writer conformance (spool-format.md): latency bucket index, minute formatting, segment naming, rotation, and minute-window aggregation. `count` means runs. Rows compare as sets (order of emission is not significant).",
        "segmentMaxBytes": SEGMENT_MAX_BYTES,
        "stepBounds": STEP_BOUNDS,
        "latencyBuckets": {"edges": EDGES, "cases": buckets},
        "minutes": minutes,
        "segmentNames": names,
        "rotation": rotations,
        "invalidArtifactIds": [
            {"name": "absent", "reason": "telemetry_artifact_id_invalid"},
            {"name": "empty", "artifactId": "", "reason": "telemetry_artifact_id_invalid"},
            {"name": "unicode", "artifactId": "prm_😀", "reason": "telemetry_artifact_id_invalid"},
            {"name": "slash", "artifactId": "prm/support", "reason": "telemetry_artifact_id_invalid"},
            {"name": "leading punctuation", "artifactId": "_prm_support", "reason": "telemetry_artifact_id_invalid"},
        ],
        "windows": window_cases,
        "tolerance": tolerance_cases(),
    }

def tolerance_cases():
    """What a reader does with rows a later 3.x wrote. Expected answers are written here by hand."""
    aggregator = Aggregator(INSTANCE, "resident", SDK)
    aggregator.observe(T0, {"tag": "support.triage", "artifactId": "prm_support_triage", "versionId": "ver_1", "arm": "none", "model": "gpt-5", "status": "ok", "latencyMs": 10})
    aggregator.close(T0)
    run = aggregator.emitted[0]
    text = lambda row: json.dumps(row, separators=(",", ":"), ensure_ascii=False)
    later_type = {"type": "trace", "v": 1, "instanceId": INSTANCE, "body": "from a later minor"}
    later_v = {**run, "v": 5, "somethingNew": 1}
    with_fields = {**run, "laterField": "gone", "tokens": {**run["tokens"], "laterToken": 3}, "tools": {**run["tools"], "names": ["never"]}}
    at = "2026-09-12T14:03:10Z"
    dropped = lambda *lines: {"type": "dropped", "v": 1, "at": at, "instanceId": INSTANCE, "segments": 0, "lines": len(lines), "bytes": sum(len(line.encode("utf-8")) + 1 for line in lines)}
    case = lambda name, lines, rows, invalid=(), skipped=(), stripped=(): {"name": name, "instanceId": INSTANCE, "nowMs": T0, "lines": lines, "expected": {"rows": rows, "invalid": list(invalid), "skipped": list(skipped), "stripped": list(stripped)}}
    return [
        case("a clean row passes", [text(run)], [run]),
        case("unknown fields are stripped, nested ones too, and never leave the host", [text(with_fields)], [run], stripped=[{"line": 1, "field": "laterField"}, {"line": 1, "field": "tools.names"}, {"line": 1, "field": "tokens.laterToken"}]),
        case("an unknown row type is skipped and counted", [text(run), text(later_type)], [run, dropped(text(later_type))], skipped=[{"line": 2, "reason": "unknown_type"}]),
        case("an unknown version is skipped and counted", [text(later_v), text(run)], [run, dropped(text(later_v))], skipped=[{"line": 1, "reason": "v"}]),
        case("a later error class is taken", [text({**run, "status": "error", "errorClass": "guardrail_tripped"})], [{**run, "status": "error", "errorClass": "guardrail_tripped"}]),
        case("a later status is skipped and counted: a closed list per row type", [text({**run, "status": "paused"}), text(run)], [run, dropped(text({**run, "status": "paused"}))], skipped=[{"line": 1, "reason": "status"}]),
        case("a step member on a window row is a crossed row", [text({**run, "step": "a"})], [], invalid=[{"line": 1, "reason": "unknown_field:step"}]),
        case("a line that is not JSON is corruption", [text(run), "{not json"], [run], invalid=[{"line": 2, "reason": "not_json"}]),
        case("a row from another instance is corruption", [text({**run, "instanceId": "i-someone-else"})], [], invalid=[{"line": 1, "reason": "instance_mismatch"}]),
    ]

# ----------------------------------------------------------------------------- run references

RUN_REF_MAX_ENTRIES = 8
RUN_REF_MAX_TOKEN_LENGTH = 12288
RUN_REF_READ_MAX_ENTRIES = 32
RUN_REF_READ_MAX_TOKEN_LENGTH = 40960

def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")

def run_ref_key_from(secret: str, agent_id: str, target: str) -> bytes:
    return hmac.new(secret.encode("utf-8"), f"airprompter runRef v1\0{agent_id}\0{target}".encode("utf-8"), hashlib.sha256).digest()

def run_ref_token(body_elements, key: bytes) -> str:
    body = json.dumps(body_elements, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return f"{b64url(body)}.{b64url(hmac.new(key, body, hashlib.sha256).digest())[:22]}"

def run_ref_vectors():
    secret, agent, target = "ap_test_shared_secret", "agt_4e8c1b6d", "prod"
    key = run_ref_key_from(secret, agent, target)
    previous = "ap_test_previous_secret"
    run_id = "AAECAwQFBgcICQoLDA0ODw"
    minute = "2026-09-12T14:03:00Z"
    entry = {"tag": "support.triage", "artifactId": "prm_support_triage", "versionId": "ver_triage_7", "model": "claude-haiku-4-5", "arm": "none", "bucket": None, "runMinute": minute}
    worst = lambda i: {"tag": (f"{i}." + "t" * 128)[:128], "artifactId": (f"{i}." + "a" * 128)[:128], "versionId": "v" * 128, "model": "m" * 128, "arm": "a" * 32, "bucket": 9999, "runMinute": minute, "audienceIds": [f"aud_{chr(65 + n) * 22}" for n in range(8)]}
    def facts(entries, **extra):
        return {"agentId": agent, "target": target, "runId": run_id, "entries": entries, **extra}
    def body(f):
        return [f["agentId"], f["target"], f["runId"], f["entries"], *f.get("extra", [])]
    def minted(name, f, token_key=key, **rest):
        token = run_ref_token(body(f), token_key)
        return {"name": name, "facts": f, "token": token, **rest}
    eight = facts([worst(i) for i in range(8)])
    nine = facts([worst(i) for i in range(9)])
    thirty_two = facts([{**entry, "tag": f"slot.{i}"} for i in range(32)])
    extended = facts([{**entry, "laterField": {"kept": True}}], extra=[{"addedBy": "a later minor"}, 7])
    one = minted("one entry", facts([entry]))
    tokens = [
        one,
        minted("audience memberships ride their entry", facts([{**entry, "arm": "candidate", "bucket": 42, "audienceIds": ["aud_AAAAAAAAAAAAAAAAAAAAAA"]}])),
        minted("two entries", facts([entry, {**entry, "tag": "support.reply", "arm": "candidate", "bucket": 7}])),
        minted("no entries", facts([]), note="a ref with no entries parses, and feedback on it returns false"),
        minted("eight worst-case entries", eight, note="the largest ref a mint may write"),
        minted("32 entries read", thirty_two, mintRefused=True, note="readers accept 32 entries; minting stops at 8"),
        minted("a fifth body element and unknown entry keys", extended, note="both survive parse and re-mint, so a 1.0 host can grow a ref a later SDK wrote"),
    ]
    forged = one["token"].rsplit(".", 1)
    return {
        "bounds": {"maxEntries": RUN_REF_MAX_ENTRIES, "maxTokenLength": RUN_REF_MAX_TOKEN_LENGTH, "readMaxEntries": RUN_REF_READ_MAX_ENTRIES, "readMaxTokenLength": RUN_REF_READ_MAX_TOKEN_LENGTH},
        "keys": [
            {"name": "a known secret, agent and target", "secret": secret, "agentId": agent, "target": target, "keyHex": key.hex()},
            {"name": "a custom stage", "secret": secret, "agentId": agent, "target": "qa", "keyHex": run_ref_key_from(secret, agent, "qa").hex()},
            {"name": "the previous secret", "secret": previous, "agentId": agent, "target": target, "keyHex": run_ref_key_from(previous, agent, target).hex()},
        ],
        "keyHex": key.hex(),
        "tokens": tokens,
        "mintRefused": [{"name": "a ninth entry", "facts": nine}, {"name": "two entries with one tag", "facts": facts([entry, entry])}],
        "rotation": {"name": "a token minted under a previous key parses with that key listed", "token": run_ref_token(body(facts([entry])), run_ref_key_from(previous, agent, target)), "facts": facts([entry]), "currentKeyHex": key.hex(), "previousKeyHex": run_ref_key_from(previous, agent, target).hex()},
        "refused": [
            {"name": "a forged entry fails the MAC", "token": f"{b64url(json.dumps(body(facts([{**entry, 'arm': 'candidate'}])), separators=(',', ':')).encode())}.{forged[1]}"},
            {"name": "another key", "token": run_ref_token(body(facts([entry])), b"\x01" * 32)},
            {"name": "a body with no runId", "token": run_ref_token([agent, target], key)},
            {"name": "33 entries", "token": run_ref_token(body(facts([{**entry, "tag": f"slot.{i}"} for i in range(33)])), key)},
            {"name": "no dot", "token": "AAAA"},
            {"name": "a short MAC", "token": one["token"].rsplit(".", 1)[0] + ".abc"},
        ],
    }

def feedback_vectors():
    def case(name, signals, note=None):
        outcomes, rejected = normalize_feedback(signals)
        entry = {"name": name, "signals": signals, "expected": {"accepted": bool(outcomes), "outcomes": outcomes, "rejected": rejected}}
        if note:
            entry["note"] = note
        return entry
    cases = [
        case("thumbs up", {"thumbs": "up"}, "thumbs is stored as a boolean: up = true"),
        case("thumbs down", {"thumbs": "down"}),
        case("thumbs sideways", {"thumbs": "sideways"}),
        case("rating in range", {"rating": 5}),
        case("rating zero", {"rating": 0}),
        case("rating six", {"rating": 6}),
        case("rating fractional", {"rating": 4.5}),
        case("rating as string", {"rating": "4"}),
        case("every boolean", {b: (i % 2 == 0) for i, b in enumerate(BOOLEAN_SIGNALS)}),
        case("boolean as number", {"accepted": 1}),
        case("unit ratios", {"editDistanceRatio": 0.25, "judgeScore": 1}),
        case("unit ratio above one", {"editDistanceRatio": 1.5}),
        case("counts", {"regenerations": 3, "timeToAcceptMs": 0}),
        case("negative count", {"timeToAcceptMs": -1}),
        case("fractional count", {"regenerations": 1.5}),
        case("free text is refused", {"freeText": "the answer was wrong"}, "unknown names never reach the spool"),
        case("prompt-like keys are refused", {"prompt": "…", "output": "…", "userId": "u_1"}),
        case("mixed valid and invalid", {"thumbs": "up", "comment": "great", "rating": 9}, "accepted when at least one signal is valid; the rest are named in rejected"),
        case("corrected value needs the slot enum", {"corrected": True, "correctedValue": "refund"}),
        case("a runtime-only signal is refused from feedback", {"goldenPass": True}, "goldenPass is written by the runtime's golden-set run (T34), never by ap.feedback(); custom cannot shadow it either"),
        case("custom cannot shadow a runtime-only signal", {"custom": {"goldenPass": True, "handoff": True}}),
        case("custom signals", {"custom": {"stepsTaken": 4, "usedTool": True}}),
        case("custom bad name", {"custom": {"Steps": 1, "steps_taken": 1}}),
        case("custom reserved name", {"custom": {"rating": 1}}),
        case("custom too many", {"custom": {f"s{i}": i for i in range(9)}}),
        case("custom non-numeric value", {"custom": {"note": "text"}}),
        case("custom string number", {"custom": {"score": "1"}}),
        case("empty", {}),
    ]
    return {
        "protocol": PROTOCOL,
        "description": "ap.feedback(runRef, signals) normalisation against feedback-signals.schema.json: what becomes a window outcome, what is rejected and why. `accepted` is the call's return value. `runRef` pins the one token form (spool-format.md › Run reference): a token minted in either SDK parses in the other.",
        "cases": cases,
        "runRef": run_ref_vectors(),
    }

def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "vectors")
    os.makedirs(out, exist_ok=True)
    for name, document in (("spool.json", spool_vectors()), ("feedback.json", feedback_vectors())):
        with open(os.path.join(out, name), "w", encoding="utf-8") as f:
            json.dump(document, f, indent=2, ensure_ascii=False)
            f.write("\n")
    print(f"wrote {out}/spool.json and feedback.json")

if __name__ == "__main__":
    main()
