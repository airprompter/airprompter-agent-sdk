"""S2 (AIR-1970): the spool never raises on the request path, and what it cannot keep it says.

The TypeScript cases, over the Python ``MemoryFs``: a full disk, an I/O error on fsync, two writers over budget
with a crash mid-open, a sibling that takes a file away, no daemon at all.
"""

from __future__ import annotations

import json

from airprompter_agent_telemetry.spool.writer import HOST_SPOOL_BUDGET_BYTES, DirectorySink
from airprompter_agent_core.testing import MemoryFs

DIR = "/state/airprompter/agt_1/prod/spool/telemetry"
MINUTE = 1_789_300_800_000.0  # 2026-09-13T12:00:00Z
REPORT_SEGMENT_BYTES = 160


def row(n: int, at: float, instance_id: str = "i-writer-a") -> dict:
    from airprompter_agent_core._util import iso_seconds

    return {"type": "refusal", "v": 1, "at": iso_seconds(at), "instanceId": instance_id, "reason": "lease_expired", "generation": n, "tag": None}


def rows_on_disk(fs: MemoryFs, directory: str = DIR) -> list[dict]:
    out: list[dict] = []
    for name in sorted(n for n in fs.list(directory) if n.startswith("seg-") and n.endswith(".ndjson")):
        for line in fs.read_file(f"{directory}/{name}").decode("utf-8").split("\n"):
            if line:
                out.append(json.loads(line))
    return out


def closed_bytes(fs: MemoryFs) -> int:
    return sum(fs.stat(f"{DIR}/{n}")[0] for n in fs.list(DIR) if n.startswith("seg-") and n.endswith(".ndjson"))


def test_full_disk_is_counted_and_reported_once_when_writing_works_again() -> None:
    fs = MemoryFs()
    sink = DirectorySink(DIR, "i-writer-a", HOST_SPOOL_BUDGET_BYTES, fs)
    sink.append(row(1, MINUTE), MINUTE)
    fs.capacity_bytes = fs.bytes_used()
    sink.append(row(2, MINUTE + 1000), MINUTE + 1000)
    sink.append(row(3, MINUTE + 2000), MINUTE + 2000)
    assert sink.faults["byCode"]["ENOSPC"] == 2
    assert sink.faults["pendingRows"] == 2
    assert "ENOSPC" in sink.faults["last"]
    fs.capacity_bytes = float("inf")
    sink.append(row(4, MINUTE + 60_000), MINUTE + 60_000)
    sink.flush(MINUTE + 60_000)
    rows = rows_on_disk(fs)
    dropped = [r for r in rows if r["type"] == "dropped"]
    assert len(dropped) == 1
    assert dropped[0]["segments"] == 2
    assert dropped[0]["bytes"] > 0
    assert sink.faults["pendingRows"] == 0
    assert [r["generation"] for r in rows if r["type"] == "refusal"] == [1, 4]


def test_eio_on_fsync_leaves_the_segment_open_for_the_next_start() -> None:
    fs = MemoryFs()
    sink = DirectorySink(DIR, "i-writer-a", HOST_SPOOL_BUDGET_BYTES, fs)
    sink.append(row(1, MINUTE), MINUTE)
    fs.fail_next("fsync", "EIO")
    sink.flush(MINUTE)
    assert sink.faults["byCode"]["EIO"] == 1
    assert any(n.endswith(".ndjson.open") for n in fs.list(DIR))
    again = DirectorySink(DIR, "i-writer-a", HOST_SPOOL_BUDGET_BYTES, fs)
    assert again.faults["last"] is None
    assert not any(n.endswith(".ndjson.open") for n in fs.list(DIR))
    assert len(rows_on_disk(fs)) == 1


def test_two_writers_over_budget_with_a_crash_mid_open() -> None:
    fs = MemoryFs()
    budget = 4096
    a = DirectorySink(DIR, "i-writer-a", budget, fs)
    b = DirectorySink(DIR, "i-writer-b", budget, fs)
    for minute in range(8):
        at = MINUTE + minute * 60_000
        for n in range(5):
            a.append(row(minute * 10 + n, at), at)
            b.append(row(minute * 10 + n, at, "i-writer-b"), at)
        a.flush(at)
        b.flush(at)
    assert closed_bytes(fs) <= budget + 2 * REPORT_SEGMENT_BYTES
    dropped = [r for r in rows_on_disk(fs) if r["type"] == "dropped"]
    assert dropped and all(r["segments"] >= 1 and r["bytes"] > 0 for r in dropped)
    first_minute = int(MINUTE // 60_000)
    assert not any(f"-{first_minute}-" in n for n in fs.list(DIR) if n.endswith(".ndjson"))
    a.append(row(99, MINUTE + 9 * 60_000), MINUTE + 9 * 60_000)
    assert any(n.startswith("seg-i-writer-a-") and n.endswith(".open") for n in fs.list(DIR))
    restarted = DirectorySink(DIR, "i-writer-a", budget, fs)
    assert not any(n.startswith("seg-i-writer-a-") and n.endswith(".open") for n in fs.list(DIR))
    restarted.append(row(100, MINUTE + 10 * 60_000), MINUTE + 10 * 60_000)
    restarted.flush(MINUTE + 10 * 60_000)
    assert closed_bytes(fs) <= budget + 2 * REPORT_SEGMENT_BYTES


def test_a_segment_a_sibling_took_away_is_skipped_not_raised() -> None:
    fs = MemoryFs()
    sink = DirectorySink(DIR, "i-writer-a", 512, fs)
    for minute in range(4):
        at = MINUTE + minute * 60_000
        sink.append(row(minute, at), at)
        sink.flush(at)
    fs.fail_next("stat", "ENOENT")
    sink.depth()
    assert sink.faults["byCode"]["ENOENT"] == 1


def test_no_daemon_and_no_grant_the_writer_alone_caps_the_tree() -> None:
    fs = MemoryFs()
    budget = 2048
    sink = DirectorySink(DIR, "i-writer-a", budget, fs)
    for minute in range(60):
        at = MINUTE + minute * 60_000
        for n in range(4):
            sink.append(row(minute * 10 + n, at), at)
        sink.flush(at)
        assert closed_bytes(fs) <= budget + REPORT_SEGMENT_BYTES, f"minute {minute}"
    assert [r for r in rows_on_disk(fs) if r["type"] == "dropped"]
    assert sink.faults["pendingRows"] == 0
