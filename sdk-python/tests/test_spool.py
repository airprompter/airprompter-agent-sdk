"""The spool writer against ``protocol/vectors/spool.json`` and
``feedback.json`` (buckets, minutes, names, rotation, window aggregation,
the feedback catalogue), then the filesystem rules the vectors cannot
express: 0600 files, ``.open`` until fsync + rename, recovery of a crashed
writer's segment, rotation on disk at the minute and at 1 MiB, the
``sent/`` + ``quarantine/`` layout the daemon expects, and both budgets
(serverless buffer, host spool) reporting their loss as a ``dropped`` row.
"""

from __future__ import annotations

import json
import os
import sys

from airprompter_agent._util import instant, iso_ms
from airprompter_agent.spool.feedback import normalize_feedback
from airprompter_agent.spool.writer import (
    LATENCY_BUCKET_EDGES_MS,
    SEGMENT_MAX_BYTES,
    DirectorySink,
    MemorySink,
    Observation,
    SegmentPlanner,
    SpoolWriter,
    WriterIdentity,
    epoch_minute,
    latency_bucket_index,
    minute_of,
    segment_name,
)

from .test_protocol_vectors import vector

T0 = instant("2026-09-12T14:03:10Z")
IDENTITY = WriterIdentity("i-testinstance", "resident", "t/0")
OBSERVATION = Observation(tag="a.b", version_id="v1", arm="none", model="m", status="ok", latency_ms=10)


def _window_key(row):
    return json.dumps([row["minute"], row["tag"], row["versionId"], row["arm"], row["model"], row["status"], row.get("errorClass")])


def _stable(value):
    return json.dumps(value, sort_keys=True)


def test_spool_vectors_buckets_minutes_names_rotation():
    sp = vector("spool.json")
    assert sp["latencyBuckets"]["edges"] == list(LATENCY_BUCKET_EDGES_MS)
    assert sp["segmentMaxBytes"] == SEGMENT_MAX_BYTES
    for c in sp["latencyBuckets"]["cases"]:
        assert latency_bucket_index(c["latencyMs"]) == c["bucket"], f"{c['latencyMs']} ms"
    for c in sp["minutes"]:
        assert minute_of(c["epochMs"]) == c["minute"], c["name"]
        assert epoch_minute(c["epochMs"]) == c["epochMinute"], c["name"]
    for c in sp["segmentNames"]:
        assert segment_name(c["instanceId"], epoch_minute(c["epochMs"]), c["n"]) == c["name"]
    for c in sp["rotation"]:
        planner = SegmentPlanner(c["instanceId"])
        for i, a in enumerate(c["appends"]):
            assert planner.append(a["epochMs"], a["lineBytes"]) == (a["segment"], a["rotated"]), f"{c['name']} append {i}"


def test_spool_vectors_window_aggregation():
    for c in vector("spool.json")["windows"]:
        sink = MemorySink()
        writer = SpoolWriter(sink, WriterIdentity(c["instanceId"], c["instanceClass"], c["sdk"]))
        for event in c["events"]:
            if event["kind"] == "observe":
                writer.observe(Observation.from_wire(event["observation"]), event["at"])
            elif event["kind"] == "feedback":
                fb = event["feedback"]
                writer.outcomes(tag=fb["tag"], version_id=fb["versionId"], arm=fb["arm"], model=fb["model"], outcomes=fb["outcomes"], at_ms=event["at"])
            elif event["kind"] == "refusal":
                writer.refusal(at=iso_ms(event["at"]), reason=event["reason"], generation=event["generation"], tag=event.get("tag"), at_ms=event["at"])
            elif event["kind"] == "close":
                writer.close_windows(event["at"])
        rows = sink.drain()
        windows = sorted((r for r in rows if r["type"] == "window"), key=_window_key)
        expected = sorted(c["expectedWindows"], key=_window_key)
        assert len(windows) == len(expected), c["name"]
        for row, want in zip(windows, expected):
            assert _stable(row) == _stable(want), f"{c['name']}: {row} vs {want}"
        assert _stable([r for r in rows if r["type"] == "refusal"]) == _stable(c["expectedRefusals"]), f"{c['name']}: refusals"


def test_feedback_vectors():
    for c in vector("feedback.json")["cases"]:
        got = normalize_feedback(c["signals"])
        assert _stable({"accepted": got.accepted, "outcomes": got.outcomes, "rejected": got.rejected}) == _stable(c["expected"]), f"{c['name']}: {got}"


def _segments(directory):
    return sorted(n for n in os.listdir(directory) if n.startswith("seg-") and n.endswith(".ndjson"))


def test_on_disk_layout_and_minute_segments(tmp_path):
    directory = str(tmp_path)
    sink = DirectorySink(directory, "i-testinstance")
    assert sorted(os.listdir(directory)) == ["quarantine", "sent"]
    writer = SpoolWriter(sink, IDENTITY)
    writer.observe(OBSERVATION, T0)
    writer.observe(OBSERVATION, T0 + 60_000)  # the minute turned: closes the first window into the first segment
    names = _segments(directory)
    assert names == [f"seg-i-testinstance-{epoch_minute(T0 + 60_000)}-0.ndjson"], "the closed minute's windows are written, fsynced and closed at once, in a segment named for the write time"
    if sys.platform != "win32":
        assert os.stat(os.path.join(directory, names[0])).st_mode & 0o777 == 0o600
    sink.append({"type": "refusal", "v": 1, "at": iso_ms(T0 + 61_000), "instanceId": "i-testinstance", "reason": "disabled", "generation": 1, "tag": None}, T0 + 61_000)
    assert any(n.endswith(".ndjson.open") for n in os.listdir(directory)), "a segment being written carries .open"
    writer.close_windows(T0 + 120_000)
    names = _segments(directory)
    assert names == [f"seg-i-testinstance-{epoch_minute(T0 + 60_000)}-0.ndjson", f"seg-i-testinstance-{epoch_minute(T0 + 60_000)}-1.ndjson", f"seg-i-testinstance-{epoch_minute(T0 + 120_000)}-0.ndjson"]
    assert not any(n.endswith(".open") for n in os.listdir(directory))
    rows = [json.loads(line) for n in names for line in open(os.path.join(directory, n), encoding="utf-8").read().strip().split("\n")]
    assert [r["minute"] if r["type"] == "window" else r["type"] for r in rows] == ["2026-09-12T14:03:00Z", "refusal", "2026-09-12T14:04:00Z"]
    assert sink.depth() == {"segments": 3, "bytes": sum(os.path.getsize(os.path.join(directory, n)) for n in names)}


def test_on_disk_rotation_at_1mib(tmp_path):
    directory = str(tmp_path)
    sink = DirectorySink(directory, "i-testinstance")
    writer = SpoolWriter(sink, IDENTITY)
    row = {"at": iso_ms(T0), "reason": "lease_expired", "generation": 1, "tag": None}
    line_bytes = len((json.dumps({"type": "refusal", "v": 1, "instanceId": "i-testinstance", **row}, separators=(",", ":")) + "\n").encode("utf-8"))
    per_segment = SEGMENT_MAX_BYTES // line_bytes
    for i in range(per_segment * 2 + 1):
        writer.refusal(at=row["at"], reason="lease_expired", generation=1, tag=None, at_ms=T0 + i)
    sink.flush(T0)
    names = _segments(directory)
    assert names == [segment_name("i-testinstance", epoch_minute(T0), n) for n in (0, 1, 2)]
    for name in names:
        assert os.path.getsize(os.path.join(directory, name)) <= SEGMENT_MAX_BYTES, name
    assert os.path.getsize(os.path.join(directory, names[0])) == per_segment * line_bytes
    assert os.path.getsize(os.path.join(directory, names[2])) == line_bytes


def test_crashed_writer_segment_recovered_by_same_instance(tmp_path):
    directory = str(tmp_path)
    first = DirectorySink(directory, "i-testinstance")
    first.append({"type": "refusal", "v": 1, "at": iso_ms(T0), "instanceId": "i-testinstance", "reason": "disabled", "generation": 3, "tag": None}, T0)
    # No flush: the process dies here. Simulate a partial trailing line too.
    open_name = next(n for n in os.listdir(directory) if n.endswith(".open"))
    with open(os.path.join(directory, open_name), "a", encoding="utf-8") as f:
        f.write('{"type":"window","v":1,"partial')
    DirectorySink(directory, "i-otherinstance")
    assert open_name in os.listdir(directory), "another instance's writer does not close it"
    restarted = DirectorySink(directory, "i-testinstance")
    closed = open_name[: -len(".open")]
    assert closed in os.listdir(directory), "closed on restart"
    assert open_name not in os.listdir(directory)
    lines = open(os.path.join(directory, closed), encoding="utf-8").read().split("\n")
    assert lines[1].startswith('{"type":"window","v":1,"partial'), "the partial last line is left for the daemon to skip"
    restarted.append({"type": "refusal", "v": 1, "at": iso_ms(T0), "instanceId": "i-testinstance", "reason": "disabled", "generation": 3, "tag": None}, T0 + 1)
    restarted.flush(T0 + 1)
    assert _segments(directory) == [segment_name("i-testinstance", epoch_minute(T0), n) for n in (0, 1)]


def test_memory_sink_budget_reports_loss_on_drain():
    sink = MemorySink({"instanceId": "i-7f3aQx9kLmN2pQ"}, 2048)
    writer = SpoolWriter(sink, WriterIdentity("i-7f3aQx9kLmN2pQ", "ephemeral", "agent-sdk-python/0.1.0"))
    now = instant("2026-09-12T14:03:00Z")
    for i in range(20):
        writer.observe(Observation(tag=f"slot.{i}", version_id="v", arm="none", model="m", status="ok", latency_ms=10 + i, tokens={"input": 1, "output": 1}), now)
    now += 60_000
    writer.close_windows(now)
    rows = sink.drain(now)
    windows = [r for r in rows if r["type"] == "window"]
    dropped = [r for r in rows if r["type"] == "dropped"]
    assert len(dropped) == 1, "one dropped row"
    assert len(windows) + dropped[0]["segments"] == 20, "every window is either kept or counted as dropped"
    assert 1 <= len(windows) < 20
    assert windows[-1]["tag"] == "slot.19", "the newest survive; the oldest went"
    assert dropped[0]["bytes"] > 0
    assert sink.drain(now) == [], "drained, and the loss is not reported twice"
    roomy = MemorySink({"instanceId": "i-7f3aQx9kLmN2pQ"})
    w2 = SpoolWriter(roomy, WriterIdentity("i-7f3aQx9kLmN2pQ", "ephemeral", "agent-sdk-python/0.1.0"))
    for i in range(20):
        w2.observe(Observation(tag=f"slot.{i}", version_id="v", arm="none", model="m", status="ok", latency_ms=10, tokens={"input": 1, "output": 1}), now)
    w2.close_windows(now + 60_000)
    assert not [r for r in roomy.drain() if r["type"] == "dropped"]


def test_host_spool_budget_evicts_oldest_and_writes_dropped_segment(tmp_path):
    directory = str(tmp_path)
    sink = DirectorySink(directory, "i-7f3aQx9kLmN2pQ", 1500)
    writer = SpoolWriter(sink, WriterIdentity("i-7f3aQx9kLmN2pQ", "resident", "agent-sdk-python/0.1.0"))
    now = instant("2026-09-12T14:03:00Z")
    for _minute in range(6):
        writer.observe(Observation(tag="support.triage", version_id="v", arm="none", model="m", status="ok", latency_ms=100, tokens={"input": 10, "output": 5}), now)
        now += 60_000
        writer.close_windows(now)
    segments = _segments(directory)
    assert len(segments) >= 3, f"segments left: {segments}"
    rows = [json.loads(line) for n in segments for line in open(os.path.join(directory, n), encoding="utf-8").read().strip().split("\n")]
    dropped = [r for r in rows if r["type"] == "dropped"]
    assert dropped, "the loss is reported"
    windows_kept = len([r for r in rows if r["type"] == "window"])
    assert windows_kept + sum(r["segments"] for r in dropped) >= 6
    assert windows_kept < 6
    for row in dropped:
        assert row["bytes"] > 0
        assert len(row["at"]) == 20 and row["at"].endswith("Z")
        assert sorted(row) == ["at", "bytes", "instanceId", "segments", "type", "v"]
    total = sum(os.path.getsize(os.path.join(directory, n)) for n in segments)
    assert total <= 1500 + 400, f"within the budget plus one segment ({total})"
