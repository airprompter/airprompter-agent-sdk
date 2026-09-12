"""Independent generator for protocol/vectors/spool.json and feedback.json.

Written from the prose in spool-format.md and the schemas, not from any
SDK: latency bucket edges, minute formatting, segment naming, rotation at
the minute boundary and 1 MiB, minute-window aggregation (feedback rides
on a run's window without counting as a run), and the feedback catalogue
normalisation. Two implementations agreeing on these files is the point.

    python3 protocol/tools/gen_spool_vectors.py protocol/vectors
"""
import datetime as dt
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
        self.open_minute = None
        self.emitted = []

    def _window(self, at: int, tag, version_id, arm, model, status, error_class, usage_source):
        minute = minute_of(at)
        if self.open_minute is not None and self.open_minute != minute:
            self.close(at)
        self.open_minute = minute
        key = (tag, version_id, arm, model, status, error_class)
        row = self.open.get(key)
        if row is None:
            row = {
                "type": "window", "v": 1, "minute": minute,
                "instanceId": self.identity[0], "instanceClass": self.identity[1],
                "tag": tag, "versionId": version_id, "arm": arm, "model": model, "status": status,
                "errorClass": error_class, "usageSource": usage_source or "reported", "count": 0,
                "latencyMs": {"buckets": [0] * len(EDGES), "sum": 0}, "tokens": {"input": 0, "output": 0},
                "sdk": self.identity[2],
            }
            self.open[key] = row
        return row

    def observe(self, at: int, o: dict):
        row = self._window(at, o["tag"], o["versionId"], o["arm"], o["model"], o["status"], o.get("errorClass"), o.get("usageSource"))
        row["count"] += 1
        row["latencyMs"]["buckets"][bucket_index(o["latencyMs"])] += 1
        row["latencyMs"]["sum"] += max(0, int(math.floor(o["latencyMs"] + 0.5)))  # half up, as the format says
        tokens = o.get("tokens") or {}
        row["tokens"]["input"] += tokens.get("input", 0)
        row["tokens"]["output"] += tokens.get("output", 0)
        if tokens.get("cachedInput"):
            row["tokens"]["cachedInput"] = row["tokens"].get("cachedInput", 0) + tokens["cachedInput"]
        if "checks" in o:
            checks = row.setdefault("checks", {"passed": 0, "failed": 0})
            checks["passed"] += o["checks"].get("passed", 0)
            checks["failed"] += o["checks"].get("failed", 0)
        if "outcomes" in o:
            merge_outcomes(row, o["outcomes"])

    def outcomes(self, at: int, f: dict):
        merge_outcomes(self._window(at, f["tag"], f["versionId"], f["arm"], f["model"], "ok", None, None), f["outcomes"])

    def close(self, at: int):
        self.emitted.extend(self.open.values())
        self.open = {}
        self.open_minute = None

def merge_outcomes(row: dict, outcomes: dict):
    target = row.setdefault("outcomes", {})
    for name, value in outcomes.items():
        if not OUTCOME_NAME.match(name):
            continue
        if isinstance(value, bool):
            value = 1 if value else 0
        elif not isinstance(value, (int, float)) or value != value or value in (float("inf"), float("-inf")):
            continue
        current = target.get(name, {"n": 0, "sum": 0})
        target[name] = {"n": current["n"] + 1, "sum": current["sum"] + value}

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
    buckets = [{"latencyMs": ms, "bucket": bucket_index(ms)} for ms in [0, 0.4, 1, 1.5, 2, 3, 4, 5, 8, 16, 17, 32, 64, 128, 129, 256, 512, 513, 812, 1024, 1025, 1201, 2048, 4096, 8192, 8193, 16384, 16385, 30000, 65536, 65537, 600000]]
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
            elif kind == "feedback":
                agg.outcomes(event["at"], event["feedback"])
            elif kind == "refusal":
                refusals.append({"type": "refusal", "v": 1, "at": iso_of(event["at"]), "instanceId": INSTANCE, "reason": event["reason"], "generation": event["generation"], "tag": event.get("tag")})
            elif kind == "close":
                agg.close(event["at"])
        return {"name": name, "note": note, "instanceId": INSTANCE, "instanceClass": instance_class, "sdk": SDK, "events": events, "expectedWindows": agg.emitted, "expectedRefusals": refusals}

    triage = {"tag": "support.triage", "versionId": "ver_triage_7", "arm": "none", "model": "claude-haiku-4-5"}
    ok = lambda **k: {**triage, "status": "ok", **k}
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
        windows("feedback before any run opens the window", "feedback alone yields a window with count 0 (it is not a run); usageSource defaults to reported", [
            {"kind": "feedback", "at": T0, "feedback": {**triage, "outcomes": {"thumbs": False}}},
            {"kind": "close", "at": T0 + 1},
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
    ]
    return {
        "protocol": PROTOCOL,
        "description": "Spool writer conformance (spool-format.md): latency bucket index, minute formatting, segment naming, rotation, and minute-window aggregation. Windows compare as sets (order of emission is not significant).",
        "segmentMaxBytes": SEGMENT_MAX_BYTES,
        "latencyBuckets": {"edges": EDGES, "cases": buckets},
        "minutes": minutes,
        "segmentNames": names,
        "rotation": rotations,
        "windows": window_cases,
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
        "description": "ap.feedback(runRef, signals) normalisation against feedback-signals.schema.json: what becomes a window outcome, what is rejected and why. `accepted` is the call's return value.",
        "cases": cases,
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
