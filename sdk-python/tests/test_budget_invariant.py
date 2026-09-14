"""S6 (AIR-1974): the disk budget is a published invariant. Parity with ``sdk-typescript/test/budgetInvariant.test.ts``.

    tree ≤ budget + (writers × 1 MiB open) + quarantine cap + exported cap
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import time

import pytest

from airprompter_agent import AirPrompterAgent
from airprompter_agent.agent import SyncOptions
from airprompter_agent_core.protocol.trust import public_jwk_of
from airprompter_agent_telemetry.spool.writer import SEGMENT_MAX_BYTES, MemorySink, Observation, SpoolWriter, WriterIdentity, epoch_minute, segment_name
from airprompter_agent_sync.store.key_provider import file_key
from airprompter_agent_sync.store.slot_store import SlotStore
from airprompter_agent_telemetry.uploader import OPEN_SEGMENT_RECLAIM_MS, QUARANTINE_CAP_BYTES, SEGMENT_NAME, GrantDecision, SpoolUploader
from airprompter_agent_core.testing import MemoryFs

from .control_plane import FakeControlPlane

T0 = 1_789_300_810_000.0  # 2026-09-13T12:00:10Z
WRITER_A = "i-writerAAAAAAAA"
WRITER_B = "i-writerBBBBBBBB"
DIR = "/spool"


def iso_minute(ms: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:00Z", time.gmtime(ms / 1000))


def window_row(instance_id: str, minute: str) -> dict:
    return {"type": "window", "v": 1, "minute": minute, "instanceId": instance_id, "instanceClass": "resident", "tag": "support.reply", "versionId": "ver_1", "arm": "none", "model": "gpt-5", "status": "ok", "errorClass": None, "usageSource": "reported", "count": 1, "latencyMs": {"buckets": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0], "sum": 812}, "tokens": {"input": 40, "output": 9}, "sdk": "agent-sdk-py/0.1.0"}


def segment(fs: MemoryFs, instance_id: str, minute_ms: float, n: int, rows: list[dict], open_: bool = False) -> str:
    name = segment_name(instance_id, epoch_minute(minute_ms), n) + (".open" if open_ else "")
    fs.write_file(os.path.join(DIR, name), "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows).encode("utf-8"), 0o600)
    return name


def closed(fs: MemoryFs) -> list[str]:
    return sorted(n for n in fs.list(DIR) if SEGMENT_NAME.match(n))


def sink_absent(_instance_id: str) -> GrantDecision:
    return GrantDecision("unavailable", reason="sink_absent")


def test_two_writers_over_budget_with_a_crash_mid_open():
    fs = MemoryFs()
    fs.clock_ms = T0
    fs.mkdirp(DIR, 0o700)
    events: list[dict] = []
    uploader = SpoolUploader(directory=DIR, instance_id="i-hostprocess000", grant_for=sink_absent, fs=fs, now_ms=lambda: fs.clock_ms, rand=lambda: 0.5, logger=events.append, budget_bytes=900, quarantine_cap_bytes=4096, exported_cap_bytes=4096)
    names = []
    for i in range(5):
        fs.clock_ms = T0 + i * 60_000
        writer = WRITER_A if i % 2 == 0 else WRITER_B
        names.append(segment(fs, writer, fs.clock_ms, 0, [window_row(writer, iso_minute(fs.clock_ms))]))
    each = fs.stat(os.path.join(DIR, names[0]))[0]
    assert each * 3 > 900 >= each * 2, f"segment {each} bytes"
    fs.clock_ms = T0 - 2 * 60 * 60_000
    abandoned = segment(fs, "i-crashed0000000", fs.clock_ms, 0, [window_row("i-crashed0000000", "2026-09-13T10:00:00Z")], open_=True)
    fs.clock_ms = T0 + 5 * 60_000
    live = segment(fs, WRITER_A, fs.clock_ms, 0, [window_row(WRITER_A, "2026-09-13T12:05:00Z")], open_=True)

    result = uploader.run_once()
    assert uploader.status()["reclaimedSegments"] == 1, "the abandoned .open was closed"
    assert any(e.get("event") == "open_segment_reclaimed" and e.get("segment") == abandoned[: -len(".open")] for e in events)
    assert result.dropped == 4, "six closed segments, two fit in 900: the reclaimed one and the three oldest went"
    assert result.held is True
    remaining = closed(fs)
    dropped = next(n for n in remaining if n.startswith("seg-i-hostprocess000-"))
    assert sorted(n for n in remaining if n != dropped) == sorted([names[3], names[4]]), "exactly the oldest unsent segments were evicted"
    row = json.loads(fs.read_file(os.path.join(DIR, dropped)).decode("utf-8").strip())
    reclaimed_bytes = len(json.dumps(window_row("i-crashed0000000", "2026-09-13T10:00:00Z"), separators=(",", ":")).encode("utf-8")) + 1
    assert (row["type"], row["segments"], row["bytes"], row["instanceId"]) == ("dropped", 4, each * 3 + reclaimed_bytes, "i-hostprocess000")
    assert fs.exists(os.path.join(DIR, live)), "the live writer's .open is not touched"
    assert not fs.exists(os.path.join(DIR, abandoned))
    tree = uploader.status()["tree"]
    assert (tree["openSegments"], tree["quarantineBytes"], tree["exportedBytes"]) == (1, 0, 0)
    assert tree["totalBytes"] <= uploader.bound(1)
    assert uploader.status()["depth"]["bytes"] <= 900
    assert uploader.bound(2) == 900 + 2 * SEGMENT_MAX_BYTES + 4096 + 4096


def test_quarantine_and_exported_are_capped_oldest_first():
    fs = MemoryFs()
    fs.clock_ms = T0
    fs.mkdirp(DIR, 0o700)
    uploader = SpoolUploader(directory=DIR, instance_id="i-hostprocess000", grant_for=sink_absent, fs=fs, now_ms=lambda: fs.clock_ms, rand=lambda: 0.5, quarantine_cap_bytes=1000, exported_cap_bytes=500)
    bad = []
    for i in range(6):
        fs.clock_ms = T0 + i * 60_000
        bad.append(segment(fs, "i-thirdparty0000", fs.clock_ms, 0, [{**window_row("i-thirdparty0000", "2026-09-13T12:00:00Z"), "prompt": "You are a helpful assistant"}]))
    uploader.run_once()
    assert uploader.status()["quarantinedSegments"] == 6
    uploader.run_once()
    kept = sorted(fs.list(os.path.join(DIR, "quarantine")))
    assert uploader.status()["tree"]["quarantineBytes"] <= 1000
    assert 1 <= len(kept) < 6
    assert kept == bad[6 - len(kept):], "the newest survive; the oldest went"
    assert uploader.status()["capEvictedFiles"] == 6 - len(kept)
    for i in range(3):
        fs.write_file(os.path.join(DIR, "exported", segment_name(WRITER_A, epoch_minute(T0) + i, 0)), b"x" * 300, 0o600)
    uploader.run_once()
    assert uploader.status()["tree"]["exportedBytes"] <= 500
    assert len(fs.list(os.path.join(DIR, "exported"))) == 1
    assert QUARANTINE_CAP_BYTES == 10 * 1024 * 1024 and OPEN_SEGMENT_RECLAIM_MS == 60 * 60 * 1000


def test_stale_windows_close_on_the_sweep_never_the_current_minute():
    sink = MemorySink({"instanceId": WRITER_A})
    writer = SpoolWriter(sink, WriterIdentity(WRITER_A, "resident", "test/0"))
    clock = T0
    writer.observe(Observation(tag="support.reply", version_id="ver_1", arm="none", model="gpt-5", status="ok", latency_ms=5, usage_source="unavailable"), clock)
    assert writer.open_window_count == 1
    writer.close_stale_windows(clock + 10_000)
    assert writer.open_window_count == 1, "the same minute: the window stays open, no split row"
    clock += 60_000
    writer.close_stale_windows(clock)
    assert writer.open_window_count == 0
    assert len(sink.drain(clock)) == 1


@pytest.fixture
def state_dir():
    path = tempfile.mkdtemp(prefix="ap-instances-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


def test_every_process_is_its_own_instance_and_the_run_ref_key_is_the_stores(state_dir):
    scope = {"organizationId": "org_1", "agentId": "agt_workers", "target": "prod"}
    kw = {"organization_id": "org_1", "agent_id": "agt_workers", "target": "prod"}
    plane = FakeControlPlane(scope)
    plane.grant_base_url = "https://bucket.test"
    plane.now = lambda: T0
    plane.promote([plane.slot(tag="support.reply", text="Reply.")])

    def start() -> AirPrompterAgent:
        return AirPrompterAgent.start(**kw, api_key=plane.api_key, base_url="https://api.test", state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, sync=SyncOptions(mode="resident", poll_seconds=3600, root_url="https://edge.test/roots/prod/root.json"), transport=plane.transport(), now=lambda: T0, random=lambda: 0.5)

    a = start()
    b = start()
    try:
        store = SlotStore.open(state_dir=state_dir, agent_id="agt_workers", target="prod", key_provider=file_key(os.path.join(SlotStore.path(state_dir=state_dir, agent_id="agt_workers", target="prod"), "store.key")))
        assert a.instance_id != b.instance_id, "N workers are N instances"
        assert store.instance_id not in (a.instance_id, b.instance_id), "the store's id is the store's, not a process's"
        assert a._run_ref_key == b._run_ref_key, "the runRef key is the store's: a run_ref minted by one worker parses in another"
        rendered = a.prompt("support.reply").render()
        assert b.feedback(rendered.run_ref, thumbs="up") is True
        deadline = time.time() + 5
        while (a.status().heartbeat["last_at"] is None or b.status().heartbeat["last_at"] is None) and time.time() < deadline:
            time.sleep(0.02)
        assert {h["instanceId"] for h in plane.heartbeats} >= {a.instance_id, b.instance_id}, "the fleet sees both"
        for ap in (a, b):
            r = ap.prompt("support.reply").render()
            ap.report(tag=r.tag, version_id=r.version_id, arm=r.arm, model=r.model, status="ok", latency_ms=3)
            ap.spool.close_windows(T0)
        spool = os.path.join(SlotStore.path(state_dir=state_dir, agent_id="agt_workers", target="prod"), "spool", "telemetry")
        assert len([n for n in os.listdir(spool) if SEGMENT_NAME.match(n)]) >= 2, "two writers, their segments, one spool"
        result = a.upload_now()
        assert result["uploaded"] >= 2 and result["held"] is False
        assert {k.split("/")[5] for k in plane.uploads} == {a.instance_id, b.instance_id}
        assert {g["instanceId"] for g in plane.grants} >= {a.instance_id, b.instance_id}, "one grant per writer"
        assert [n for n in os.listdir(spool) if SEGMENT_NAME.match(n)] == [], "deleted on ack"
    finally:
        a.stop()
        b.stop()
