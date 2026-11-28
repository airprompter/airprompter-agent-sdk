"""AIR-2261: ``stop()`` sends the runs it ends, within a bound. Parity with ``sdk-typescript/test/stopUpload.test.ts``.

A short-lived process that serves a run and calls ``stop()`` has uploaded it before ``stop()`` returns; a pass in flight at
``stop()`` does not hide the last segment; a bucket that never answers costs at most ``stop_upload_timeout_ms`` and the
pass's daemon thread never holds the interpreter's exit, with the row kept for the next start; ``0`` makes no pass; a
start on an unknown signing key logs what to check.

Usage::

    $ python -m pytest tests/test_stop_upload.py
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
from pathlib import Path
from typing import Callable, Optional

import httpx
import pytest

from airprompter_agent import AirPrompterAgent
from airprompter_agent.agent import SyncOptions, TelemetryOptions
from airprompter_agent.core.protocol.trust import public_jwk_of
from airprompter_agent.sync.store.slot_store import SlotStore

from .control_plane import FakeControlPlane, transport_of

SCOPE = {"organizationId": "org_1", "agentId": "agt_stop", "target": "prod"}
KW = {"organization_id": "org_1", "agent_id": "agt_stop", "target": "prod"}
T0 = 1_789_300_800_000.0
BUCKET = "https://bucket.test"


class Clock:
    def __init__(self, ms: float):
        self.ms = ms

    def __call__(self) -> float:
        return self.ms


class BucketTransport(httpx.BaseTransport):
    """The plane's transport, with the bucket's POSTs routed through ``bucket`` (to delay, hang or count them)."""

    def __init__(self, plane: FakeControlPlane, bucket: Callable[[httpx.Request, httpx.BaseTransport], httpx.Response]):
        self._real = plane.httpx_transport()
        self._bucket = bucket

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        if str(request.url).startswith(BUCKET):
            return self._bucket(request, self._real)
        return self._real.handle_request(request)


def plane() -> FakeControlPlane:
    p = FakeControlPlane(SCOPE)
    p.grant_base_url = BUCKET
    p.promote([p.slot(tag="support.reply", text="Reply.")])
    return p


def start(p: FakeControlPlane, state_dir: str, *, telemetry: Optional[TelemetryOptions] = None, mode: str = "resident", transport: Optional[httpx.BaseTransport] = None, clock: Optional[Clock] = None, events: Optional[list] = None) -> AirPrompterAgent:
    clock = clock or Clock(T0)
    ap = AirPrompterAgent.start(
        **KW,
        api_key=p.api_key,
        base_url="https://api.test",
        state_dir=state_dir,
        root={"pinned": public_jwk_of(p.root_key)},
        sync=SyncOptions(mode=mode, poll_seconds=3600, root_url="https://edge.test/roots/prod/root.json"),
        transport=transport_of(transport) if transport else p.transport(),
        now=clock,
        random=lambda: 0.5,
        telemetry=telemetry or TelemetryOptions(),
        **({"logger": events.append} if events is not None else {}),
    )
    if mode == "resident":
        deadline = time.time() + 5
        while ap.status().heartbeat["last_at"] is None and time.time() < deadline:
            time.sleep(0.02)
    return ap


def unsent(state_dir: str) -> list[str]:
    folder = os.path.join(SlotStore.path(state_dir=state_dir, agent_id=SCOPE["agentId"], target=SCOPE["target"]), "spool", "telemetry")
    return [n for n in os.listdir(folder) if n.startswith("seg-") and n.endswith(".ndjson")]


def serve_one(ap: AirPrompterAgent, latency_ms: int = 12) -> None:
    r = ap.prompt("support.reply").render()
    ap.report(tag=r.tag, artifact_id=r.artifact_id, version_id=r.version_id, arm=r.arm, model=r.model, status="ok", latency_ms=latency_ms)


def rows_of(p: FakeControlPlane, key: str) -> list[dict]:
    return [json.loads(line) for line in p.objects[key].decode("utf-8").strip().split("\n")]


@pytest.fixture
def state_dir():
    path = tempfile.mkdtemp(prefix="ap-stop-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


def test_a_process_that_serves_one_run_and_stops_has_uploaded_it(state_dir):
    p = plane()
    ap = start(p, state_dir)
    serve_one(ap)
    assert p.uploads == [], "nothing sent yet: the window is still open"
    ap.stop()
    assert len(p.uploads) == 1, "stop() ended the run, closed the window and sent it"
    assert [row["type"] for row in rows_of(p, p.uploads[0])] == ["window"]
    assert unsent(state_dir) == []


def test_a_pass_in_flight_at_stop_still_lets_the_last_segment_go(state_dir):
    p = plane()
    gate = threading.Event()
    posts = []

    def bucket(request: httpx.Request, real: httpx.BaseTransport) -> httpx.Response:
        posts.append(1)
        if len(posts) == 1:
            gate.wait(5)
        return real.handle_request(request)

    clock = Clock(T0)
    ap = start(p, state_dir, transport=BucketTransport(p, bucket), clock=clock)
    serve_one(ap, 11)
    ap.spool.close_windows(clock.ms)
    in_flight: dict = {}
    first = threading.Thread(target=lambda: in_flight.update(ap.upload_now() or {}))
    first.start()
    time.sleep(0.05)
    clock.ms += 60_000  # the next minute: its own segment name
    serve_one(ap, 22)
    stopping = threading.Thread(target=ap.stop)
    stopping.start()
    time.sleep(0.05)
    gate.set()
    first.join(5)
    stopping.join(5)
    assert in_flight == {"uploaded": 1, "quarantined": 0, "dropped": 0, "held": False}
    assert len(p.uploads) == 2, "the segment closed at stop() went after the pass in flight"
    assert [rows_of(p, key)[0]["latencyMs"]["sum"] for key in p.uploads] == [11, 22]
    assert unsent(state_dir) == []


def test_a_bucket_that_never_answers_returns_at_the_bound_and_keeps_the_row(state_dir):
    p = plane()
    events: list = []
    release = threading.Event()

    def hang(request: httpx.Request, real: httpx.BaseTransport) -> httpx.Response:
        release.wait(10)
        return httpx.Response(503)

    ap = start(p, state_dir, telemetry=TelemetryOptions(stop_upload_timeout_ms=150), transport=BucketTransport(p, hang), events=events)
    serve_one(ap)
    began = time.monotonic()
    ap.stop()
    took = time.monotonic() - began
    assert 0.14 <= took < 1.5, f"stop() took {took:.3f} s"
    assert any(e.get("event") == "stop_upload_bounded" and e.get("boundMs") == 150 for e in events)
    release.set()  # the abandoned pass ends with a 503: the segment stays
    deadline = time.time() + 5
    while any(t.name == "airprompter-stop-upload" for t in threading.enumerate()) and time.time() < deadline:
        time.sleep(0.02)
    assert p.uploads == []
    assert len(unsent(state_dir)) == 1, "the row stays in the spool"
    nxt = start(p, state_dir)
    nxt.stop()
    assert len(p.uploads) == 1, "the next process sent what the last one kept"
    assert unsent(state_dir) == []


@pytest.mark.parametrize("telemetry", [TelemetryOptions(stop_upload_timeout_ms=0), TelemetryOptions(upload=False)], ids=["zero", "upload_off"])
def test_no_pass_at_stop(state_dir, telemetry):
    p = plane()
    ap = start(p, state_dir, telemetry=telemetry)
    serve_one(ap)
    ap.stop()
    assert p.uploads == []
    assert len(unsent(state_dir)) == 1, "the closed segment waits in the spool"


def test_memory_sink_stop_flushes_the_buffer(state_dir):
    p = plane()
    ap = start(p, state_dir, telemetry=TelemetryOptions(sink="memory"), mode="on_invoke")
    serve_one(ap)
    ap.stop()
    assert len(p.uploads) == 1, "the memory sink's run went at stop()"
    assert ap.flush_telemetry() == {"status": "nothing"}


def test_unknown_signing_key_logs_what_to_check(state_dir):
    p = plane()
    stranger = public_jwk_of(FakeControlPlane(SCOPE).root_key)  # another root: names none of this plane's signing keys
    events: list = []
    ap = AirPrompterAgent.start(**KW, api_key=p.api_key, base_url="https://api.dev.test", state_dir=state_dir, root={"pinned": stranger, "hosted_environment": "prod"}, sync=SyncOptions(mode="on_invoke", root_url="https://edge.test/roots/prod/root.json"), transport=p.transport(), now=Clock(T0), logger=events.append)
    ap.stop()
    refused = next((e for e in events if e.get("reason") == "unknown_signing_key"), None)
    assert refused is not None, [(e.get("event"), e.get("reason")) for e in events]
    for said in ['root["pinned"]', "https://api.dev.test", 'hosted_environment"] ("prod")', "sync.root_url", "agent key"]:
        assert said in refused["hint"], f"{said} in: {refused['hint']}"


def test_a_real_process_whose_bucket_never_answers_exits_soon_after_stop(tmp_path: Path):
    tests = Path(__file__).resolve().parent
    script = tmp_path / "child.py"
    script.write_text(textwrap.dedent(f"""
        import sys, threading, httpx
        sys.path.insert(0, {str(tests.parent)!r})
        from tests.control_plane import FakeControlPlane, transport_of
        from tests.test_stop_upload import BucketTransport, KW, SCOPE, BUCKET
        from airprompter_agent import AirPrompterAgent
        from airprompter_agent.agent import SyncOptions, TelemetryOptions
        from airprompter_agent.core.protocol.trust import public_jwk_of
        p = FakeControlPlane(SCOPE)
        p.grant_base_url = BUCKET
        p.promote([p.slot(tag="support.reply", text="Reply.")])
        never = threading.Event()
        transport = transport_of(BucketTransport(p, lambda request, real: (never.wait(), httpx.Response(200))[1]))
        ap = AirPrompterAgent.start(**KW, api_key=p.api_key, base_url="https://api.test", state_dir={str(tmp_path / "state")!r},
            root={{"pinned": public_jwk_of(p.root_key)}}, sync=SyncOptions(mode="resident", poll_seconds=3600, root_url="https://edge.test/roots/prod/root.json"),
            transport=transport, telemetry=TelemetryOptions(stop_upload_timeout_ms=300))
        r = ap.prompt("support.reply").render()
        ap.report(tag=r.tag, artifact_id=r.artifact_id, version_id=r.version_id, arm=r.arm, model=r.model, status="ok", latency_ms=5)
        ap.stop()
        print("stopped", flush=True)
    """))
    began = time.monotonic()
    done = subprocess.run([sys.executable, str(script)], capture_output=True, text=True, timeout=30)
    took = time.monotonic() - began
    assert done.returncode == 0, done.stderr
    assert "stopped" in done.stdout
    assert took < 15, f"the process exited {took:.1f} s after start; a pass holding the exit would never end"
