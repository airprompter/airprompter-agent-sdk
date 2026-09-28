"""``protocol/daemon.md`` (draft 3): the telemetry daemon ships telemetry and nothing else. Parity with
``sdk-typescript/test/telemetryDaemon.test.ts``.

``sync.mode="daemon"`` is refused at start. An SDK writes its spool to the folder the daemon publishes in
``daemon.json`` (unless told otherwise), adds a manifest beside every closed segment, and runs no uploader of its own
while a live daemon ships that folder — taking the upload back when the daemon's file goes stale. A process hydrated
from the customer's datastore does exactly the same: its release never comes from the daemon. The uploader honours
manifests: another pair's segments are left alone, a segment that does not match its manifest is quarantined with it,
a manifest-less segment waits out the grace, the writer's report rides to its grant, and an orphan manifest is swept.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest

from airprompter_agent import AirPrompterAgent
from airprompter_agent.agent import SPOOL_DIR_ENV, AgentStartError, SyncOptions, TelemetryOptions
from airprompter_agent_core._util import iso_ms
from airprompter_agent_core.bundle.apbundle import DistributionKey
from airprompter_agent_core.bundle.hpke import generate_x25519_key_pair
from airprompter_agent_core.control.client import SyncClient
from airprompter_agent_core.ports import fs_or_default
from airprompter_agent_core.protocol.trust import public_jwk_of, trusted_root_from_pinned_key
from airprompter_agent_sync import MemoryReleaseDatastore, pull_to_datastore
from airprompter_agent_sync.store.slot_store import SlotStore
from airprompter_agent_telemetry.spool.manifest import MANIFEST_GRACE_MS, manifest_name_of, read_segment_manifest, sha256_hex, write_daemon_discovery, write_segment_manifest
from airprompter_agent_telemetry.spool.writer import DirectorySink, Observation, SpoolWriter, WriterIdentity, epoch_minute, segment_name
from airprompter_agent_telemetry.uploader import GrantDecision, SpoolUploader, UploadGrant

from .control_plane import FakeControlPlane

SCOPE = {"organizationId": "org_1", "agentId": "agt_1", "target": "prod"}
KW = {"organization_id": "org_1", "agent_id": "agt_1", "target": "prod"}
T0 = 1_790_503_210_000.0  # 2026-09-27T10:00:10Z
PROTOCOL = Path(__file__).resolve().parents[2] / "protocol"
FS = fs_or_default(None)


class Clock:
    def __init__(self, ms: float):
        self.ms = ms

    def __call__(self) -> float:
        return self.ms


def store_dir_of(state_dir: str) -> str:
    return SlotStore.path(state_dir=state_dir, agent_id=SCOPE["agentId"], target=SCOPE["target"])


def segments_in(directory: str) -> list[str]:
    return sorted(n for n in os.listdir(directory) if re.match(r"^seg-.*\.ndjson$", n)) if os.path.isdir(directory) else []


def manifests_in(directory: str) -> list[str]:
    return sorted(n for n in os.listdir(directory) if n.endswith(".manifest.json")) if os.path.isdir(directory) else []


def discovery(spool_dir: str, heartbeat_at_ms: float, **overrides):
    return {
        "format": 1,
        "kind": "daemon",
        "daemon": {"name": "airprompterd", "version": "0.3.0"},
        "pid": 4242,
        "organizationId": SCOPE["organizationId"],
        "agentId": SCOPE["agentId"],
        "target": SCOPE["target"],
        "spoolDir": spool_dir,
        "startedAt": iso_ms(heartbeat_at_ms),
        "heartbeatAt": iso_ms(heartbeat_at_ms),
        "uploadIntervalSeconds": 300,
        "sink": "airprompter",
        "upload": {"lastUploadAt": None, "backoffUntil": None, "sentSegments": 0, "quarantinedSegments": 0, "droppedSegments": 0, "depthSegments": 0, "depthBytes": 0},
        **overrides,
    }


def new_plane(clock: Clock) -> FakeControlPlane:
    plane = FakeControlPlane(SCOPE)
    plane.grant_base_url = "https://bucket.test"
    plane.now = clock
    plane.promote([plane.slot(tag="support.reply", text="Reply.")])
    return plane


def online_host(state_dir: str, clock: Clock, plane: FakeControlPlane | None = None, telemetry: TelemetryOptions | None = None, **extra):
    plane = plane or new_plane(clock)
    ap = AirPrompterAgent.start(
        **KW,
        api_key=plane.api_key,
        base_url="https://api.test",
        state_dir=state_dir,
        root={"pinned": public_jwk_of(plane.root_key)},
        sync=SyncOptions(mode="resident", poll_seconds=3600, root_url="https://edge.test/roots/prod/root.json"),
        transport=plane.transport(),
        now=clock,
        random=lambda: 0.5,
        telemetry=telemetry or TelemetryOptions(),
        **extra,
    )
    deadline = time.time() + 5
    while ap.status().heartbeat["last_at"] is None and time.time() < deadline:
        time.sleep(0.02)
    return plane, ap


def report_one(ap: AirPrompterAgent) -> None:
    r = ap.prompt("support.reply").render()
    ap.report(tag=r.tag, version_id=r.version_id, arm=r.arm, model=r.model, status="ok", latency_ms=12)


@pytest.fixture
def dirs():
    made: list[str] = []

    def make(prefix: str = "ap-tdaemon-") -> str:
        path = tempfile.mkdtemp(prefix=prefix)
        made.append(path)
        return path

    yield make
    for path in made:
        shutil.rmtree(path, ignore_errors=True)


def test_sync_mode_daemon_is_refused_at_start(dirs):
    state_dir = dirs()
    plane = FakeControlPlane(SCOPE)
    for sync in ({"mode": "daemon"}, {"daemon_socket_path": "/run/x.sock"}):
        with pytest.raises(AgentStartError) as raised:
            AirPrompterAgent.start(**KW, state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, sync=sync)
        assert raised.value.code == "invalid_options" and "removed in 0.3.0" in str(raised.value)
    assert not os.path.exists(os.path.join(store_dir_of(state_dir), "store.json")), "refused before the store was touched"


def test_every_closed_segment_gets_a_manifest_with_the_writers_report_without_spool(dirs):
    state_dir = dirs()
    clock = Clock(T0)
    _, ap = online_host(state_dir, clock, telemetry=TelemetryOptions(upload=False))
    try:
        report_one(ap)
        ap.spool.close_windows(clock.ms)
        directory = os.path.join(store_dir_of(state_dir), "spool", "telemetry")
        [segment] = segments_in(directory)
        assert manifests_in(directory) == [manifest_name_of(segment)]
        read = read_segment_manifest(FS, directory, segment)
        assert read and read["ok"]
        manifest = read["manifest"]
        data = Path(directory, segment).read_bytes()
        assert (manifest["bytes"], manifest["sha256"], manifest["rows"], manifest["instanceId"]) == (len(data), sha256_hex(data), 1, ap.instance_id)
        assert {k: manifest[k] for k in ("organizationId", "agentId", "target")} == SCOPE
        for field in json.loads((PROTOCOL / "schemas" / "spool-manifest.schema.json").read_text())["required"]:
            assert field in manifest, field
        request = json.loads((PROTOCOL / "schemas" / "heartbeat.schema.json").read_text())["$defs"]["request"]
        assert "spool" not in manifest["report"], "the daemon adds its own view of the spool"
        for key in manifest["report"]:
            assert key in request["properties"], f"report.{key} is a heartbeat field"
        for key in request["required"]:
            assert key == "spool" or key in manifest["report"], f"report.{key} is present"
        assert manifest["report"]["instanceId"] == ap.instance_id
        assert "Reply." not in json.dumps(manifest), "content-free"
    finally:
        ap.stop()


def test_a_live_daemons_folder_then_stale_then_back(dirs):
    state_dir, shared = dirs(), dirs("ap-tdaemon-shared-")
    clock = Clock(T0)
    store_dir = store_dir_of(state_dir)
    os.makedirs(store_dir, exist_ok=True)
    write_daemon_discovery(FS, store_dir, discovery(shared, clock.ms))
    events: list[dict] = []
    _, ap = online_host(state_dir, clock, logger=events.append)
    try:
        placement = ap.status().telemetry
        assert (placement["spool_dir"], placement["spool_dir_from"], placement["uploaded_by"], placement["daemon"]["live"]) == (shared, "daemon", "daemon", True)
        assert ap.status().upload is None and ap.upload_now() is None, "no uploader of its own"
        report_one(ap)
        ap.spool.close_windows(clock.ms)
        assert len(segments_in(shared)) == 1 and len(manifests_in(shared)) == 1, "the segment and its manifest are in the daemon's folder"
        assert ap.healthz()["telemetry"] == {"uploadedBy": "daemon", "daemon": "live"}

        # The daemon stops refreshing: ten minutes on, its file is stale. The SDK writes to its store's folder and uploads itself.
        clock.ms += 11 * 60_000
        placement = ap.check_telemetry_daemon()
        assert (placement["spool_dir"], placement["spool_dir_from"], placement["uploaded_by"], placement["daemon"]["live"]) == (os.path.join(store_dir, "spool", "telemetry"), "default", "self", False)
        assert ap.status().upload is not None, "the uploader is back"
        assert "upload_daemon_stale" not in ap.healthz()["reasons"], "stale, but this process uploads"
        assert any(e.get("event") == "spool_moved" for e in events)

        # The daemon comes back: the SDK hands the upload over again.
        write_daemon_discovery(FS, store_dir, discovery(shared, clock.ms))
        placement = ap.check_telemetry_daemon()
        assert (placement["spool_dir"], placement["uploaded_by"]) == (shared, "daemon")
        assert ap.status().upload is None
        assert any(e.get("event") == "upload_handed_to_daemon" for e in events)
    finally:
        ap.stop()


def test_an_explicit_folder_wins_the_option_then_the_environment(dirs, monkeypatch):
    state_dir, shared, mine, env_dir = dirs(), dirs("ap-tdaemon-shared-"), dirs("ap-tdaemon-mine-"), dirs("ap-tdaemon-env-")
    clock = Clock(T0)
    store_dir = store_dir_of(state_dir)
    os.makedirs(store_dir, exist_ok=True)
    write_daemon_discovery(FS, store_dir, discovery(shared, clock.ms))
    monkeypatch.setenv(SPOOL_DIR_ENV, env_dir)
    plane = new_plane(clock)
    _, first = online_host(state_dir, clock, plane, telemetry=TelemetryOptions(spool_dir=mine))
    t = first.status().telemetry
    assert (t["spool_dir"], t["spool_dir_from"], t["uploaded_by"]) == (mine, "option", "self")
    first.stop()
    _, second = online_host(state_dir, clock, plane)
    t = second.status().telemetry
    assert (t["spool_dir"], t["spool_dir_from"], t["uploaded_by"]) == (env_dir, "env", "self")
    second.stop()
    # The daemon names the same folder the environment does: it ships it.
    write_daemon_discovery(FS, store_dir, discovery(env_dir, clock.ms))
    _, third = online_host(state_dir, clock, plane)
    t = third.status().telemetry
    assert (t["spool_dir_from"], t["uploaded_by"]) == ("env", "daemon")
    third.stop()


def test_offline_with_a_stale_daemon_nothing_uploads_and_healthz_says_so(dirs):
    state_dir = dirs()
    clock = Clock(T0)
    store_dir = store_dir_of(state_dir)
    plane, seed = online_host(state_dir, clock, telemetry=TelemetryOptions(upload=False))
    seed.stop()
    write_daemon_discovery(FS, store_dir, discovery(os.path.join(store_dir, "spool", "telemetry"), clock.ms - 20 * 60_000))
    ap = AirPrompterAgent.start(**KW, state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, now=clock)
    try:
        assert ap.status().telemetry["uploaded_by"] == "none"
        healthz = ap.healthz()
        assert "upload_daemon_stale" in healthz["reasons"] and healthz["ok"] is True
        assert healthz["telemetry"] == {"uploadedBy": "none", "daemon": "stale"}
    finally:
        ap.stop()


def test_a_process_hydrated_from_the_datastore_sends_its_telemetry_to_the_daemons_folder(dirs):
    state_dir, shared = dirs(), dirs("ap-tdaemon-shared-")
    plane = FakeControlPlane(SCOPE)
    fleet = generate_x25519_key_pair()
    datastore = MemoryReleaseDatastore()
    plane.promote([plane.slot(tag="support.reply", text="From the datastore.", version_id="ver_eu")])
    client = SyncClient(base_url="https://api.test", agent_id=SCOPE["agentId"], target=SCOPE["target"], api_key=plane.api_key, transport=plane.transport())
    trusted_root = trusted_root_from_pinned_key(purpose="platform", environment="prod", pinned_root=public_jwk_of(plane.root_key))
    edge = httpx.Client(transport=plane.transport())
    now = lambda: datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")  # noqa: E731
    pulled = pull_to_datastore(datastore=datastore, region="eu", client=client, scope=SCOPE, trusted_root=trusted_root, fetch_root=lambda: edge.get("https://edge.test/roots/prod/root.json").json(), now=now, distribution_public_key=fleet.public_raw)
    assert pulled.status == "ok"
    store_dir = store_dir_of(state_dir)
    os.makedirs(store_dir, exist_ok=True)
    write_daemon_discovery(FS, store_dir, discovery(shared, time.time() * 1000))

    def no_network(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline", request=request)

    ap = AirPrompterAgent.start(**KW, state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, transport=httpx.MockTransport(no_network), distribution_key=DistributionKey(fleet.private_key, fleet.public_raw), datastore={"store": datastore, "region": "eu"})
    try:
        assert ap.generation == 1
        assert ap.status().datastore["rows_from"] == "region"
        assert ap.prompt("support.reply").render().text == "From the datastore."
        report_one(ap)
        ap.spool.close_windows(time.time() * 1000)
        assert ap.status().telemetry["uploaded_by"] == "daemon"
        [manifest] = manifests_in(shared)
        report = json.loads(Path(shared, manifest).read_text())["report"]
        assert (report["syncMode"], report["generation"]["active"]) == ("offline", 1), "the daemon reports it as what it is"
    finally:
        ap.stop()


def _window_row(instance_id: str, minute_ms: float) -> dict:
    minute = datetime.fromtimestamp(int(minute_ms // 60_000) * 60, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"type": "window", "v": 1, "minute": minute, "instanceId": instance_id, "instanceClass": "resident", "tag": "support.reply", "versionId": "ver_1", "arm": "none", "model": "gpt-5", "status": "ok", "errorClass": None, "usageSource": "reported", "count": 1, "latencyMs": {"buckets": [0] * 10 + [1] + [0] * 5, "sum": 812}, "tokens": {"input": 4, "output": 2}, "sdk": "agent-sdk-py/0.3.0"}


def test_the_uploader_honours_manifests(dirs):
    directory = dirs("ap-tdaemon-up-")
    clock = Clock(T0)
    asked: list[tuple[str, object]] = []
    shipped: list[str] = []

    def grant_for(instance_id, report=None):
        asked.append((instance_id, report))
        return GrantDecision("grant", grant=UploadGrant(grant_id="g", url="https://bucket.test/up", fields={}, key_prefix="p/", expires_at=iso_ms(clock.ms + 900_000), max_object_bytes=1024 * 1024))

    def bucket(request: httpx.Request) -> httpx.Response:
        shipped.append(re.search(rb'filename="([^"]+)"', request.content).group(1).decode())
        return httpx.Response(204)

    uploader = SpoolUploader(directory=directory, instance_id="i-daemonDDDDDDDD", scope={"agentId": SCOPE["agentId"], "target": SCOPE["target"]}, grant_for=grant_for, transport=httpx.MockTransport(bucket), now_ms=clock, rand=lambda: 0)
    report = {"protocol": "0.3.4", "instanceId": "i-writerAAAAAAAA", "sdk": {"name": "agent-sdk-python", "version": "0.3.0"}, "syncMode": "offline", "generation": {"active": 3}, "applyState": "active", "storageProtection": "file_key", "catalog": {"models": []}, "lease": {"expired": False}}

    def write(instance_id: str, scope):
        name = segment_name(instance_id, epoch_minute(clock.ms), 0)
        Path(directory, name).write_text(json.dumps(_window_row(instance_id, clock.ms)) + "\n")
        if scope:
            write_segment_manifest(FS, directory, name, organization_id=SCOPE["organizationId"], agent_id=scope[0], target=scope[1], report=report, closed_at_ms=clock.ms)
        return name

    try:
        ours = write("i-writerAAAAAAAA", (SCOPE["agentId"], SCOPE["target"]))
        theirs = write("i-writerBBBBBBBB", ("agt_other", "prod"))
        tampered = write("i-writerCCCCCCCC", (SCOPE["agentId"], SCOPE["target"]))
        Path(directory, tampered).write_text((json.dumps(_window_row("i-writerCCCCCCCC", clock.ms)) + "\n") * 2)
        bare = write("i-writerEEEEEEEE", None)
        Path(directory, "seg-i-goneGGGGGGGG-1-0.manifest.json").write_text("{}")

        result = uploader.run_once()
        assert result.uploaded == [ours], "ours now; the bare one waits for its writer's manifest"
        assert result.quarantined == [tampered]
        assert os.path.exists(os.path.join(directory, "quarantine", tampered)) and os.path.exists(os.path.join(directory, "quarantine", manifest_name_of(tampered))), "the pair moves together"
        assert not os.path.exists(os.path.join(directory, manifest_name_of(ours))), "acknowledged: the segment, then its manifest"
        assert asked == [("i-writerAAAAAAAA", report)], "the writer's own report rides to its grant"
        assert os.path.exists(os.path.join(directory, theirs)) and os.path.exists(os.path.join(directory, manifest_name_of(theirs))), "another pair's: never uploaded, never deleted"
        assert uploader.status()["foreignSegments"] == 1

        clock.ms += MANIFEST_GRACE_MS
        result = uploader.run_once()
        assert result.uploaded == [bare], "past the grace it goes, under the uploader's own scope"
        assert asked[-1] == ("i-writerEEEEEEEE", None)
        assert not os.path.exists(os.path.join(directory, "seg-i-goneGGGGGGGG-1-0.manifest.json")), "an orphan manifest is swept once past the grace"
        assert os.path.exists(os.path.join(directory, theirs))
        assert shipped == [ours, bare]
    finally:
        uploader.stop()


def test_the_sinks_own_eviction_takes_each_manifest_with_it(dirs):
    directory = dirs("ap-tdaemon-evict-")
    context = {"organizationId": SCOPE["organizationId"], "agentId": SCOPE["agentId"], "target": SCOPE["target"], "report": {"protocol": "0.3.4"}}
    sink = DirectorySink(directory, "i-writerAAAAAAAA", 900, manifest=lambda: context, now=lambda: T0)
    writer = SpoolWriter(sink, WriterIdentity("i-writerAAAAAAAA", "resident", "agent-sdk-py/0.3.0"))
    for i in range(4):
        writer.observe(Observation(tag="support.reply", version_id="ver_1", arm="none", model="gpt-5", status="ok", latency_ms=10), T0 + i * 60_000)
        writer.close_windows(T0 + i * 60_000)
    segments = segments_in(directory)
    assert len(segments) < 5, "the budget evicted some"
    assert manifests_in(directory) == sorted(manifest_name_of(s) for s in segments), "a manifest for every segment left, none for an evicted one"
