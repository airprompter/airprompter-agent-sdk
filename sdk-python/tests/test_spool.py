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

import pytest

from airprompter_agent.core._util import instant, iso_ms, iso_seconds
from airprompter_agent.core.telemetry.rows import STEP_BOUNDS, RunTotals, StepTotals
from airprompter_agent.core.telemetry.feedback import normalize_feedback
from airprompter_agent.telemetry.spool.writer import (
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
from airprompter_agent.core.telemetry.upload_sink import UploadOutcome, UploadSegment
from airprompter_agent.telemetry.uploader import SpoolUploader, inspect_segment, validate_spool_row

from .test_protocol_vectors import vector

T0 = instant("2026-09-12T14:03:10Z")
IDENTITY = WriterIdentity("i-testinstance", "resident", "t/0")
OBSERVATION = Observation(tag="a.b", artifact_id="art_1", version_id="v1", arm="none", model="m", status="ok", latency_ms=10)


def _window_key(row):
    return json.dumps([row["minute"], row["tag"], row["versionId"], row["arm"], row["model"], row["status"], row.get("errorClass")])


def _step_key(row):
    return json.dumps([row["minute"], row["tag"], row["step"], row["status"]])


def _stable(value):
    return json.dumps(value, sort_keys=True)


def test_spool_vectors_buckets_minutes_names_rotation():
    sp = vector("spool.json")
    assert sp["latencyBuckets"]["edges"] == list(LATENCY_BUCKET_EDGES_MS)
    assert sp["segmentMaxBytes"] == SEGMENT_MAX_BYTES
    assert sp["stepBounds"] == STEP_BOUNDS
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
            elif event["kind"] == "recordRun":
                writer.record_run(RunTotals.from_wire(event["run"]), event["at"])
            elif event["kind"] == "recordStep":
                writer.record_step(StepTotals.from_wire(event["step"]), event["at"])
            elif event["kind"] == "feedback":
                fb = event["feedback"]
                writer.outcomes(tag=fb["tag"], artifact_id=fb.get("artifactId"), version_id=fb["versionId"], arm=fb["arm"], model=fb["model"], outcomes=fb["outcomes"], at_ms=event["at"], audience_ids=tuple(fb["audienceIds"]) if "audienceIds" in fb else None, outcome_run_minute=fb.get("outcomeRunMinute"))
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
        steps = sorted((r for r in rows if r["type"] == "step"), key=_step_key)
        assert _stable(steps) == _stable(sorted(c["expectedSteps"], key=_step_key)), f"{c['name']}: step rows"
        assert _stable([r for r in rows if r["type"] == "refusal"]) == _stable(c["expectedRefusals"]), f"{c['name']}: refusals"


def test_feedback_vectors():
    for c in vector("feedback.json")["cases"]:
        got = normalize_feedback(c["signals"])
        assert _stable({"accepted": got.accepted, "outcomes": got.outcomes, "rejected": got.rejected}) == _stable(c["expected"]), f"{c['name']}: {got}"


def test_audience_manual_checks_only_attach_to_a_measured_open_run():
    sink=MemorySink(); writer=SpoolWriter(sink,IDENTITY)
    audience_ids=("aud_AAAAAAAAAAAAAAAAAAAAAA",)
    dimensions={"tag":"support.reply","artifact_id":"art_1","version_id":"ver_1","arm":"candidate","model":"gpt-5","audience_ids":audience_ids,"run_minute":"2026-09-12T14:03:00Z"}
    writer.checks(**dimensions,passed=1,failed=0,at_ms=T0)
    assert sink.drain() == [], "checks alone cannot create a zero-run row"
    writer.observe(Observation(tag=dimensions["tag"],artifact_id=dimensions["artifact_id"],version_id=dimensions["version_id"],arm=dimensions["arm"],model=dimensions["model"],status="ok",latency_ms=10,audience_ids=audience_ids,run_minute=dimensions["run_minute"]),T0)
    writer.checks(**dimensions,passed=1,failed=0,at_ms=T0)
    writer.close_windows(T0)
    rows=[r for r in sink.drain() if r.get("type")=="window"]
    assert len(rows)==1 and rows[0]["v"]==4 and rows[0]["count"]==1
    assert rows[0]["audienceIds"]==list(audience_ids) and rows[0]["checks"]=={"passed":1,"failed":0}


def test_a_long_run_has_a_bucket_of_its_own_and_p95_does_not_saturate():
    sink = MemorySink()
    writer = SpoolWriter(sink, IDENTITY)
    assert len(LATENCY_BUCKET_EDGES_MS) == 23
    for _ in range(20):
        writer.observe(Observation(tag="a.b", artifact_id="art_1", version_id="v1", arm="none", model="m", status="ok", latency_ms=200_000), T0)
    writer.close_windows(T0)
    row = next(r for r in sink.drain() if r["type"] == "window")
    buckets = row["latencyMs"]["buckets"]
    assert buckets[LATENCY_BUCKET_EDGES_MS.index(262144)] == 20
    assert buckets[-1] == 0, "nothing saturates the last bucket"
    seen = 0
    for index, count in enumerate(buckets):
        seen += count
        if seen >= 19:
            break
    assert LATENCY_BUCKET_EDGES_MS[index] == 262144


def test_artifact_aware_windows_reject_noncanonical_artifact_identities_from_shared_vectors():
    writer = SpoolWriter(MemorySink(), IDENTITY)
    for case in vector("spool.json")["invalidArtifactIds"]:
        with pytest.raises(ValueError, match=case["reason"]):
            writer.observe(Observation(tag="a.b", artifact_id=case.get("artifactId"), version_id="v1", arm="none", model="m", status="ok", latency_ms=10), T0)


BASE_ROW = {
    "type": "window", "v": 4, "artifactId": "art_1", "minute": "2026-09-12T14:03:00Z", "instanceId": "i-testinstance", "instanceClass": "resident",
    "tag": "a.b", "versionId": "v1", "arm": "none", "model": "m", "status": "ok", "errorClass": None, "usageSource": "reported",
    "count": 1, "modelCalls": 1, "agentRun": 1, "tools": {"calls": 0, "errors": 0}, "latencyMs": {"buckets": [1] + [0] * 22, "sum": 1}, "tokens": {"input": 0, "output": 0},
    "tokensSq": {"input": 0, "cachedInput": 0, "output": 0, "inputOutput": 0, "inputCached": 0, "cachedOutput": 0}, "sdk": "t/0",
}


def test_uploader_rejects_noncanonical_artifact_identities_from_shared_vectors():
    assert validate_spool_row(BASE_ROW).ok, validate_spool_row(BASE_ROW).reason
    for case in vector("spool.json")["invalidArtifactIds"]:
        row = {**BASE_ROW, "artifactId": case["artifactId"]} if "artifactId" in case else {key: value for key, value in BASE_ROW.items() if key != "artifactId"}
        verdict = validate_spool_row(row)
        assert not verdict.ok and verdict.reason == "artifactId", case["name"]


def test_uploader_refuses_every_older_window_row_and_a_step_in_tag():
    for version in (1, 2, 3, True):
        verdict = validate_spool_row({**BASE_ROW, "v": version})
        assert not verdict.ok and verdict.reason == "v", version
    refused = validate_spool_row({**BASE_ROW, "tag": "onboarding.flow#1"})
    assert not refused.ok and refused.reason == "tag", "a step never rides in tag"
    hostile = validate_spool_row({**BASE_ROW, "errorClass": [], "tokensSq": {**BASE_ROW["tokensSq"], "input": 10**400}})
    assert not hostile.ok and hostile.reason == "errorClass" and hostile.later is False, "an unhashable value is a reason, never an exception"
    huge = validate_spool_row({**BASE_ROW, "tokensSq": {**BASE_ROW["tokensSq"], "input": 10**400}})
    assert not huge.ok and huge.reason == "tokensSq"


def test_spool_vectors_a_reader_tolerates_what_a_later_3x_wrote_and_only_corruption_quarantines():
    ordered = lambda values: sorted(values, key=_stable)  # noqa: E731
    cases = vector("spool.json")["tolerance"]
    assert len(cases) >= 4, "the vector carries the cases"
    for c in cases:
        inspection = inspect_segment(("\n".join(c["lines"]) + "\n").encode("utf-8"), c["instanceId"], c["nowMs"])
        assert inspection.rows == c["expected"]["rows"], f"{c['name']}: rows"
        assert inspection.invalid == c["expected"]["invalid"], f"{c['name']}: invalid"
        assert inspection.skipped == c["expected"]["skipped"], f"{c['name']}: skipped"
        assert ordered(inspection.stripped) == ordered(c["expected"]["stripped"]), f"{c['name']}: stripped"
        shipped = inspection.payload.decode("utf-8")
        for entry in c["expected"]["stripped"]:
            assert f'"{entry["field"].split(".")[-1]}"' not in shipped, f"{c['name']}: {entry['field']} left the host"


def test_a_reader_takes_the_shape_of_a_later_value_and_strips_what_it_cannot_vouch_for():
    stripped = validate_spool_row({**BASE_ROW, "prompt": "the secret text", "tokens": {"input": 1, "output": 2, "text": "leak"}})
    assert stripped.ok and "prompt" not in stripped.row and "text" not in stripped.row["tokens"], "an unknown field never leaves the host"
    assert stripped.stripped == ["prompt", "tokens.text"]
    nested = validate_spool_row({**BASE_ROW, "tools": {"calls": 0, "errors": 0, "name": "x"}, "latencyMs": {**BASE_ROW["latencyMs"], "text": "x"}, "tokensSq": {**BASE_ROW["tokensSq"], "text": "x"}, "checks": {"passed": 1, "text": "x"}, "outcomes": {"rating": {"n": 1, "sum": 4, "sumSq": 16, "text": "x"}}})
    assert nested.ok and sorted(nested.stripped) == ["checks.text", "latencyMs.text", "outcomes.rating.text", "tokensSq.text", "tools.name"]
    assert "text" not in json.dumps(nested.row) and "name" not in nested.row["tools"], "nothing it cannot vouch for leaves the host"
    assert validate_spool_row({**BASE_ROW, "status": "error", "errorClass": "exploded", "usageSource": "guessed"}).ok, "a later value is any slug"
    for row, reason in (({**BASE_ROW, "errorClass": "Not A Slug"}, "errorClass"), ({**BASE_ROW, "usageSource": "Not A Slug"}, "usageSource")):
        verdict = validate_spool_row(row)
        assert (verdict.ok, verdict.reason, verdict.later) == (False, reason, False), row
    later = validate_spool_row({**BASE_ROW, "status": "Not A Slug"})
    assert (later.ok, later.reason, later.later) == (False, "status", True), "a status off the closed list is a later writer's"
    assert validate_spool_row({"type": "refusal", "v": 1, "at": "2026-09-12T14:03:00Z", "instanceId": "i-testinstance", "reason": "bored", "generation": 1, "tag": None}).ok
    for row in ({**BASE_ROW, "type": "trace"}, {**BASE_ROW, "v": 5}, {"type": 7}):
        assert validate_spool_row(row).later is True, row


def test_a_cleaned_segment_ships_its_rows_and_says_so(tmp_path):
    directory = str(tmp_path)
    clean = json.dumps(BASE_ROW, separators=(",", ":"))
    lines = [json.dumps({**BASE_ROW, "future": 1}, separators=(",", ":")), json.dumps({"type": "trace", "v": 1, "instanceId": "i-testinstance"}, separators=(",", ":"))]
    with open(os.path.join(directory, "seg-i-testinstance-1-0.ndjson"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n{\"partial")
    untouched = (clean + "\n").encode("utf-8")
    assert inspect_segment(untouched, "i-testinstance", T0).payload == untouched, "nothing changed: the file's own bytes"
    events: list[dict] = []
    shipped: list[UploadSegment] = []

    class Keeping:
        kind = "keeping"

        def ship(self, segment: UploadSegment) -> UploadOutcome:
            shipped.append(segment)
            return UploadOutcome("ok")

    uploader = SpoolUploader(directory=directory, instance_id="i-testinstance", sink=Keeping(), now_ms=lambda: T0, rand=lambda: 0.5, logger=events.append)
    result = uploader.run_once()
    assert result.quarantined == [] and len(shipped) == 1
    rows = [json.loads(line) for line in shipped[0].data.decode("utf-8").strip().split("\n")]
    assert [row["type"] for row in rows] == ["window", "dropped"] and "future" not in rows[0]
    assert (rows[1]["segments"], rows[1]["lines"], rows[1]["bytes"], rows[1]["at"]) == (0, 1, len(lines[1]) + 1, iso_seconds(T0))
    assert [(e["segment"], e["skippedRows"], e["strippedFields"]) for e in events if e.get("event") == "segment_cleaned"] == [("seg-i-testinstance-1-0.ndjson", 1, 1)]


def test_outcomes_without_a_run_minute_require_an_open_measured_run_and_an_artifact_id():
    sink = MemorySink()
    writer = SpoolWriter(sink, IDENTITY)
    audience_ids = ("aud_AAAAAAAAAAAAAAAAAAAAAA",)
    base = {"tag": "a.b", "version_id": "v1", "arm": "none", "model": "m", "at_ms": T0}

    writer.outcomes(**base, artifact_id="prm_support_alpha", outcomes={"thumbs": True})
    writer.outcomes(**base, artifact_id="prm_support_alpha", audience_ids=audience_ids, outcomes={"thumbs": False})
    writer.close_windows(T0)
    assert sink.drain() == [], "unattributed outcomes cannot create zero-run rows"

    writer.observe(Observation(tag="a.b", artifact_id="prm_support_alpha", version_id="v1", arm="none", model="m", status="ok", latency_ms=10), T0)
    writer.outcomes(**base, artifact_id="prm_support_alpha", outcomes={"thumbs": True})
    writer.outcomes(**base, outcomes={"thumbs": True})
    writer.observe(Observation(tag="a.b", artifact_id="prm_support_alpha", version_id="v1", arm="none", model="m", status="ok", latency_ms=10, audience_ids=audience_ids), T0)
    writer.outcomes(**base, artifact_id="prm_support_alpha", audience_ids=audience_ids, outcomes={"thumbs": False})
    writer.close_windows(T0)
    rows = [row for row in sink.drain() if row["type"] == "window"]
    assert [(row["v"], row["count"], row["outcomes"]["thumbs"]) for row in rows] == [
        (4, 1, {"n": 1, "sum": 1, "sumSq": 1}),
        (4, 1, {"n": 1, "sum": 0, "sumSq": 0}),
    ]


def test_outcome_attribution_rejects_invalid_minutes_and_malformed_audience_ids():
    sink = MemorySink()
    writer = SpoolWriter(sink, IDENTITY)
    base = {"tag": "a.b", "version_id": "v1", "arm": "none", "model": "m", "at_ms": T0}
    writer.outcomes(**base, artifact_id="prm_support_alpha", outcome_run_minute="not-a-minute", outcomes={"thumbs": True})
    writer.outcomes(**base, artifact_id="prm_support_alpha", outcome_run_minute="2026-02-30T14:03:00Z", outcomes={"thumbs": True})
    writer.outcomes(**base, outcome_run_minute=minute_of(T0), outcomes={"thumbs": True})
    writer.outcomes(**base, artifact_id="prm_support_alpha", audience_ids=("raw-device-value",), outcome_run_minute=minute_of(T0), outcomes={"thumbs": True})
    writer.outcomes(**base, artifact_id="prm_support_alpha", outcome_run_minute=minute_of(T0 + 60_000), outcomes={"thumbs": True})
    writer.outcomes(**base, artifact_id="prm_support_alpha", outcome_run_minute=minute_of(T0), outcomes={"Bad-Name": 1})
    writer.close_windows(T0)
    assert sink.drain() == []
    with pytest.raises(ValueError, match="telemetry_audience_ids_invalid"):
        writer.observe(Observation(tag="a.b", artifact_id="art_1", version_id="v1", arm="none", model="m", status="ok", latency_ms=10, audience_ids=("raw-device-value",)), T0)


def _segments(directory):
    return sorted(n for n in os.listdir(directory) if n.startswith("seg-") and n.endswith(".ndjson"))


def test_on_disk_layout_and_minute_segments(tmp_path):
    directory = str(tmp_path)
    sink = DirectorySink(directory, "i-testinstance")
    assert sorted(os.listdir(directory)) == ["exported", "quarantine"]
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
        f.write('{"type":"window","v":4,"partial')
    DirectorySink(directory, "i-otherinstance")
    assert open_name in os.listdir(directory), "another instance's writer does not close it"
    restarted = DirectorySink(directory, "i-testinstance")
    closed = open_name[: -len(".open")]
    assert closed in os.listdir(directory), "closed on restart"
    assert open_name not in os.listdir(directory)
    lines = open(os.path.join(directory, closed), encoding="utf-8").read().split("\n")
    assert lines[1].startswith('{"type":"window","v":4,"partial'), "the partial last line is left for the daemon to skip"
    restarted.append({"type": "refusal", "v": 1, "at": iso_ms(T0), "instanceId": "i-testinstance", "reason": "disabled", "generation": 3, "tag": None}, T0 + 1)
    restarted.flush(T0 + 1)
    assert _segments(directory) == [segment_name("i-testinstance", epoch_minute(T0), n) for n in (0, 1)]


def test_memory_sink_budget_reports_loss_on_drain():
    sink = MemorySink({"instanceId": "i-7f3aQx9kLmN2pQ"}, 2048)
    writer = SpoolWriter(sink, WriterIdentity("i-7f3aQx9kLmN2pQ", "ephemeral", "agent-sdk-python/0.1.0"))
    now = instant("2026-09-12T14:03:00Z")
    for i in range(20):
        writer.observe(Observation(tag=f"slot.{i}", artifact_id="art_1", version_id="v", arm="none", model="m", status="ok", latency_ms=10 + i, tokens={"input": 1, "output": 1}), now)
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
        w2.observe(Observation(tag=f"slot.{i}", artifact_id="art_1", version_id="v", arm="none", model="m", status="ok", latency_ms=10, tokens={"input": 1, "output": 1}), now)
    w2.close_windows(now + 60_000)
    assert not [r for r in roomy.drain() if r["type"] == "dropped"]


def test_host_spool_budget_evicts_oldest_and_writes_dropped_segment(tmp_path):
    directory = str(tmp_path)
    sink = DirectorySink(directory, "i-7f3aQx9kLmN2pQ", 2200)
    writer = SpoolWriter(sink, WriterIdentity("i-7f3aQx9kLmN2pQ", "resident", "agent-sdk-python/0.1.0"))
    now = instant("2026-09-12T14:03:00Z")
    for _minute in range(6):
        writer.observe(Observation(tag="support.triage", artifact_id="art_1", version_id="v", arm="none", model="m", status="ok", latency_ms=100, tokens={"input": 10, "output": 5}), now)
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
    assert total <= 2200 + 900, f"within the budget plus one segment ({total})"
