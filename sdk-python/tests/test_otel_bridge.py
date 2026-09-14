"""S13: the spool as an OpenTelemetry exporter. Parity with ``sdk-typescript/test/otelBridge.test.ts``.

The mapping reproduces ``protocol/vectors/otel-mapping.json`` byte for byte;
the sink drops and counts on a collector's refusal, keeps an unanswered
segment under backoff, holds on ``Retry-After``,
never reads a prompt, and sends the headers it was given; the uploader
deletes a dropped segment and counts it; the facade runs the bridge
in-process with no key at all (a vendored bundle, offline) and never asks
for a grant.
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile

import httpx
import pytest

from airprompter_agent import AirPrompterAgent
from airprompter_agent.agent import SyncOptions, TelemetryOptions
from airprompter_agent_core._util import b64url_encode, instant, iso_ms
from airprompter_agent_core.bundle.apbundle import create_plaintext_bundle
from airprompter_agent_core.protocol.trust import public_jwk_of
from airprompter_agent_core.telemetry.upload_sink import UploadOutcome, UploadSegment, UploadSink
from airprompter_agent_sync.store.slot_store import SlotStore
from airprompter_agent_telemetry.otel import ExportResult, OtlpUploadSink, spool_rows_to_otlp
from airprompter_agent_telemetry.uploader import SpoolUploader

from .control_plane import FakeControlPlane

VECTORS = os.path.join(os.path.dirname(__file__), "..", "..", "protocol", "vectors")
SCOPE = {"organizationId": "org_1", "agentId": "agt_otel", "target": "prod"}
KW = {"organization_id": "org_1", "agent_id": "agt_otel", "target": "prod"}
T0 = 1_789_300_800_000.0


def canonical(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


@pytest.fixture
def state_dir():
    path = tempfile.mkdtemp(prefix="ap-otel-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


def test_mapping_reproduces_the_protocol_vectors_byte_for_byte():
    with open(os.path.join(VECTORS, "otel-mapping.json"), encoding="utf-8") as f:
        doc = json.load(f)
    assert doc["scope"] == "airprompter"
    for case in doc["cases"]:
        produced = spool_rows_to_otlp(case["rows"], resource=case["resource"], sdk_version="0.1.0")
        assert canonical(produced) == canonical(case["expected"]), case["name"]
        # The closed attribute set: nothing that could carry text.
        keys = {a["key"] for rm in produced["resourceMetrics"] for sm in rm["scopeMetrics"] for m in sm["metrics"] for kind in ("histogram", "sum") for p in m.get(kind, {}).get("dataPoints", []) for a in p["attributes"]}
        assert keys <= {"gen_ai.request.model", "gen_ai.token.type", "airprompter.prompt.tag", "airprompter.prompt.version", "airprompter.prompt.arm", "airprompter.status", "airprompter.usage.source", "error.type", "airprompter.check.outcome", "airprompter.feedback.signal", "airprompter.refusal.reason", "airprompter.generation"}
    assert spool_rows_to_otlp([])["resourceMetrics"][0]["scopeMetrics"][0]["metrics"] == [], "empty rows: a request with no metrics"


class Collector:
    """An OTLP/HTTP collector on an httpx transport: records every request; scripted answers."""

    def __init__(self, answers=None):
        self.requests: list[dict] = []
        self.answers = list(answers or [])

    def transport(self) -> httpx.BaseTransport:
        def handle(request: httpx.Request) -> httpx.Response:
            self.requests.append({"url": str(request.url), "headers": dict(request.headers), "body": json.loads(request.content)})
            status, headers = self.answers.pop(0) if self.answers else (200, {})
            return httpx.Response(status, headers=headers, json={})

        return httpx.MockTransport(handle)


WINDOW = {"type": "window", "v": 1, "minute": "2026-09-12T14:03:00Z", "instanceId": "i-writer-a", "instanceClass": "resident", "tag": "support.triage", "versionId": "rev-4", "arm": "candidate", "model": "claude-sonnet-5", "status": "ok", "errorClass": None, "usageSource": "reported", "count": 1, "latencyMs": {"buckets": [0] * 16, "sum": 12}, "tokens": {"input": 3, "output": 4}, "sdk": "agent-sdk-py/0.1.0"}


def segment(name: str = "seg-i-writer-a-1-1.ndjson") -> UploadSegment:
    data = (json.dumps(WINDOW) + "\n").encode("utf-8")
    return UploadSegment(instance_id="i-writer-a", segment=name, rows=[WINDOW], data=data)


def test_sink_exports_with_headers_drops_and_counts_on_failure_holds_on_retry_after():
    collector = Collector(answers=[(200, {}), (500, {}), (503, {"retry-after": "7"}), (429, {})])
    sink = OtlpUploadSink(endpoint="http://collector.test/v1/metrics", headers={"authorization": "Bearer t"}, resource={"service.name": "support-bot"}, transport=collector.transport(), now_ms=lambda: T0)
    assert isinstance(sink, UploadSink) and sink.kind == "otlp"
    assert sink.ship(segment()) == UploadOutcome("ok")
    assert collector.requests[0]["headers"]["authorization"] == "Bearer t"
    assert collector.requests[0]["headers"]["content-type"] == "application/json"
    body = collector.requests[0]["body"]
    assert [m["name"] for m in body["resourceMetrics"][0]["scopeMetrics"][0]["metrics"]] == ["gen_ai.client.operation.duration", "airprompter.tokens"]
    assert {"key": "service.name", "value": {"stringValue": "support-bot"}} in body["resourceMetrics"][0]["resource"]["attributes"]
    assert sink.ship(segment()) == UploadOutcome("dropped", reason="http_500"), "a collector's failure drops and counts; never holds the spool"
    assert sink.ship(segment()) == UploadOutcome("hold", reason="http_503", retry_after_ms=7000), "Retry-After is the one hold"
    assert sink.ship(segment()) == UploadOutcome("dropped", reason="http_429"), "a 429 with no Retry-After is a drop"
    assert sink.status() == {"exported": 1, "dropped": 2, "lastExportAt": iso_ms(T0), "lastError": "http_429"}

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    unreachable = OtlpUploadSink(endpoint="http://collector.test/v1/metrics", transport=httpx.MockTransport(down))
    assert unreachable.ship(segment()).status == "failed", "unanswered is not a decision: kept under backoff"
    raising = OtlpUploadSink(exporter=lambda request: (_ for _ in ()).throw(RuntimeError("boom")))
    assert raising.ship(segment()) == UploadOutcome("dropped", reason="exporter:boom")
    custom = OtlpUploadSink(exporter=lambda request: ExportResult(True))
    assert custom.ship(segment()) == UploadOutcome("ok")
    with pytest.raises(ValueError):
        OtlpUploadSink()


def test_uploader_deletes_and_counts_a_segment_the_sink_dropped(state_dir):
    directory = os.path.join(state_dir, "spool")
    os.makedirs(directory)
    collector = Collector(answers=[(500, {}), (200, {})])
    events: list[dict] = []
    for name in ("seg-i-writer-a-1-1.ndjson", "seg-i-writer-a-2-1.ndjson"):
        with open(os.path.join(directory, name), "wb") as f:
            f.write((json.dumps(WINDOW) + "\n").encode("utf-8"))
    sink = OtlpUploadSink(endpoint="http://collector.test/v1/metrics", transport=collector.transport(), now_ms=lambda: T0)
    uploader = SpoolUploader(directory=directory, instance_id="i-hostprocess000", sink=sink, now_ms=lambda: T0, rand=lambda: 0.5, logger=events.append)
    result = uploader.run_once()
    assert (len(result.uploaded), result.dropped, result.held) == (1, 1, False), "one dropped, the next still tried"
    assert [n for n in os.listdir(directory) if n.startswith("seg-")] == [], "the dropped segment is gone, the shipped one acknowledged"
    dropped = [e for e in events if e.get("event") == "segment_dropped_by_sink"]
    assert len(dropped) == 1 and dropped[0]["sink"] == "otlp" and dropped[0]["reason"] == "http_500"
    status = uploader.status()
    assert (status["sink"], status["droppedSegments"], status["sentSegments"], status["grants"], status["lastError"]) == ("otlp", 1, 1, [], None)
    with pytest.raises(ValueError):
        SpoolUploader(directory=directory, instance_id="i-hostprocess000")


def test_facade_runs_the_bridge_offline_with_no_key_and_asks_no_grant(state_dir):
    plane = FakeControlPlane(SCOPE)
    plane.promote([plane.slot(tag="support.reply", text="Reply warmly {{name}}", variables=[{"name": "name", "required": False, "trust": "operator"}])])
    bundle = create_plaintext_bundle({"createdAt": iso_ms(instant("2026-09-13T00:00:00Z")), "notAfter": "2027-01-01T00:00:00Z", "manifest": plane.manifest, "keySet": plane.root, "payloads": [{"contentHash": h, "byteLength": len(b), "bytes": b64url_encode(b)} for h, b in plane.payloads.items()]})
    collector = Collector()
    sink = OtlpUploadSink(endpoint="http://collector.test/v1/metrics", resource={"service.name": "support-bot"}, transport=collector.transport())
    events: list[dict] = []
    clock = {"ms": T0}
    ap = AirPrompterAgent.start(**KW, state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, vendored_bundle={"bundle": bundle}, sync=SyncOptions(mode="resident", poll_seconds=3600), telemetry=TelemetryOptions(upload_sink=sink), now=lambda: clock["ms"], random=lambda: 0.5, logger=events.append)
    try:
        started = [e for e in events if e.get("event") == "uploader_started"]
        assert len(started) == 1 and started[0]["sink"] == "otlp", "no key, a vendored bundle: the uploader still runs, to the customer's sink"
        r = ap.prompt("support.reply").render(name="Ada")
        ap.report(tag=r.tag, version_id=r.version_id, arm=r.arm, model=r.model, status="ok", latency_ms=12, tokens={"input": 3, "output": 4})
        ap.spool.close_windows(clock["ms"])
        assert ap.upload_now() == {"uploaded": 1, "quarantined": 0, "dropped": 0, "held": False}
        assert len(collector.requests) == 1
        text = json.dumps(collector.requests[0]["body"])
        assert "Reply warmly" not in text and "Ada" not in text, "no prompt text, no variable value"
        assert "gen_ai.client.operation.duration" in text and '"service.name"' in text
        assert plane.grants == [] and plane.uploads == [], "AirPrompter was never asked for a grant and received nothing"
        spool = os.path.join(SlotStore.path(state_dir=state_dir, agent_id=SCOPE["agentId"], target=SCOPE["target"]), "spool", "telemetry")
        assert [n for n in os.listdir(spool) if n.startswith("seg-") and n.endswith(".ndjson")] == []
        assert ap.status().upload["sink"] == "otlp"
    finally:
        ap.stop()
