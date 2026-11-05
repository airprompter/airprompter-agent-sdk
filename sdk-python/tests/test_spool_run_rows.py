"""The run as the unit: ``record_run`` is the only thing that raises ``count``, a step is a row of its own, and the two
row forms hold the validator's rules. Parity with ``sdk-typescript/test/spoolRunRows.test.ts``. The shared cases live in
``protocol/vectors/spool.json``; this file proves the rules the vectors cannot say, such as what a call does not touch.
"""

from __future__ import annotations

import json

import pytest

from airprompter_agent_core._util import instant
from airprompter_agent_core.telemetry.rows import count_of, step_name, utf16_length, valid_step_name
from airprompter_agent_telemetry.otel import spool_rows_to_otlp
from airprompter_agent_telemetry.spool.writer import LATENCY_BUCKET_EDGES_MS, MemorySink, Observation, RunDimensions, RunTotals, SpoolWriter, StepTotals, WriterIdentity, _row_bytes, latency_bucket_index
from airprompter_agent_telemetry.uploader import inspect_segment, validate_spool_row

T0 = instant("2026-09-12T14:03:10Z")
IDENTITY = WriterIdentity("i-testinstance", "resident", "t/0")
DIMENSIONS = RunDimensions(tag="support.reply", artifact_id="prm_1", version_id="ver_1", arm="none", model="gpt-5")
KEYS = {"tag": "support.reply", "artifact_id": "prm_1", "version_id": "ver_1", "arm": "none", "model": "gpt-5"}


def run(**patch) -> RunTotals:
    fields = {"dimensions": DIMENSIONS, "status": "ok", "error_class": None, "usage_source": "reported", "agent_run": 1, "model_calls": 1, "latency_ms": 100, "tokens": {"input": 10, "cachedInput": 0, "output": 5}, "tools": {"calls": 0, "errors": 0}}
    return RunTotals(**{**fields, **patch})


def histogram(*latencies: float) -> dict:
    buckets = [0] * len(LATENCY_BUCKET_EDGES_MS)
    for ms in latencies:
        buckets[latency_bucket_index(ms)] += 1
    return {"buckets": buckets, "sum": sum(latencies)}


def step(name: str, **patch) -> StepTotals:
    fields = {"dimensions": DIMENSIONS, "step": name, "status": "ok", "error_class": None, "usage_source": "reported", "model_calls": 2, "latency": histogram(100, 200), "tokens": {"input": 10, "cachedInput": 2, "output": 5}, "tools": {"calls": 1, "errors": 0}}
    return StepTotals(**{**fields, **patch})


def writing():
    sink = MemorySink()
    writer = SpoolWriter(sink, IDENTITY)

    def rows() -> list[dict]:
        writer.close_windows(T0)
        return sink.drain()

    return writer, rows


def windows(rows):
    return [row for row in rows if row["type"] == "window"]


def steps(rows):
    return [row for row in rows if row["type"] == "step"]


def refused(row, reason):
    verdict = validate_spool_row(row)
    assert (verdict.ok, verdict.reason) == (False, reason), row


def test_record_run_is_the_only_thing_that_raises_count():
    writer, rows = writing()
    writer.record_run(run(), T0)
    writer.record_step(step("a"), T0)
    writer.record_step(step("b"), T0)
    writer.checks(**KEYS, passed=1, failed=0, at_ms=T0)
    writer.outcomes(**KEYS, outcomes={"thumbs": True}, at_ms=T0)
    [row] = windows(rows())
    assert row["count"] == 1, "a step, a check and an outcome add no run"
    assert row["outcomes"] == {"thumbs": {"n": 1, "sum": 1, "sumSq": 1}}
    assert row["checks"] == {"passed": 1, "failed": 0}


def test_record_step_writes_a_type_step_row_and_no_window():
    writer, rows = writing()
    writer.record_step(step("support.reply#1"), T0)
    written = rows()
    assert windows(written) == [], "no window at all"
    [row] = steps(written)
    assert row["tag"] == "support.reply", "the slot tag"
    assert row["step"] == "support.reply#1", "the step id"
    assert row["v"] == 1
    assert sum(row["latencyMs"]["buckets"]) == row["modelCalls"], "bucket total equals modelCalls"
    assert validate_spool_row(row).ok


def test_a_step_name_past_either_cap_is_written_as_other():
    writer, rows = writing()
    for i in range(40):
        writer.record_step(step(f"node-{i}"), T0)
    writer.record_step(step("x" * 65), T0)
    writer.record_step(step("😀" * 64), T0)
    written = steps(rows())
    names = [row["step"] for row in written]
    assert len([name for name in names if name != "other"]) == 32, "maxPerRun: the distinct names; the 64-character name found the cap spent"
    assert next(row for row in written if row["step"] == "other")["modelCalls"] == 2 * 10, "eight past the cap and the two past maxLength fold into other"


def test_a_name_is_counted_in_characters_and_a_control_character_or_lone_surrogate_is_refused():
    writer, rows = writing()
    writer.record_step(step("😀" * 64), T0)
    assert [row["step"] for row in steps(rows())] == ["😀" * 64]
    for name in ("", "a\nb", "a\x7fb", "a\ud800b", 5, None):
        assert valid_step_name(name) is False, repr(name)
        assert step_name(name, set()) == "other", repr(name)
    assert step_name("other", {f"n{i}" for i in range(32)}) == "other"
    seen = {f"n{i}" for i in range(32)}
    assert step_name("n3", seen) == "n3", "a name already counted stays itself past the cap"


def test_two_record_run_calls_for_one_run_add_two_to_count_and_one_to_agent_run():
    writer, rows = writing()
    writer.record_run(run(agent_run=1), T0)
    writer.record_run(run(agent_run=0), T0)
    [row] = windows(rows())
    assert (row["count"], row["agentRun"]) == (2, 1)


def test_moments_are_over_each_runs_totals_five_calls_in_one_run_square_the_total():
    writer, rows = writing()
    writer.record_run(run(model_calls=5, tokens={"input": 1000, "cachedInput": 200, "output": 300}, tools={"calls": 2, "errors": 1}), T0)
    [row] = windows(rows())
    assert row["tokensSq"] == {"input": 1_000_000, "cachedInput": 40_000, "output": 90_000, "inputOutput": 300_000, "inputCached": 200_000, "cachedOutput": 60_000}
    assert (row["count"], row["modelCalls"], row["tools"]) == (1, 5, {"calls": 2, "errors": 1})


def test_the_validator_takes_each_form_and_refuses_a_crossed_one():
    writer, rows = writing()
    writer.record_run(run(status="error", error_class="model_unresolved"), T0)
    writer.record_run(run(status="interrupted"), T0)
    writer.record_step(step("a"), T0)
    writer.outcomes(**KEYS, outcome_run_minute="2026-09-12T14:02:00Z", outcomes={"rating": 4}, at_ms=T0)
    written = rows()
    for row in written:
        verdict = validate_spool_row(row)
        assert verdict.ok and verdict.row == row and verdict.stripped == [], row
    run_row = next(row for row in windows(written) if row["status"] == "error")
    step_row = steps(written)[0]
    feedback = next(row for row in windows(written) if row["count"] == 0)
    assert run_row["errorClass"] == "model_unresolved"
    assert next(row for row in windows(written) if row["status"] == "interrupted")["errorClass"] is None, "interrupted counts as a run, not as an error"
    refused({**step_row, "tokensSq": run_row["tokensSq"]}, "unknown_field:tokensSq")
    for name in ("count", "outcomes", "checks"):
        refused({**step_row, name: 1}, f"unknown_field:{name}")
    refused({**run_row, "step": "a"}, "unknown_field:step")
    assert validate_spool_row({**step_row, name: 1}).later is False, "a crossed row is corrupt, not later"
    refused({**step_row, "modelCalls": 3}, "histogram")
    for row, reason in (({**step_row, "status": "interrupted"}, "a closed list per row type"), ({**run_row, "status": "paused"}, "a status a later writer may add"), ({**run_row, "status": ["unhashable"]}, "and never an exception")):
        verdict = validate_spool_row(row)
        assert (verdict.ok, verdict.reason, verdict.later) == (False, "status", True), reason
    for name in ("errorClass", "usageSource"):
        assert validate_spool_row({**run_row, name: "a" * 32}).ok, f"a later {name}: any slug of 32"
        refused({**run_row, name: "a" * 33}, name)
    assert validate_spool_row({"type": "refusal", "v": 1, "at": "2026-09-12T14:03:00Z", "instanceId": "i-testinstance", "reason": "a" * 32, "generation": 1, "tag": None}).ok
    refused({"type": "refusal", "v": 1, "at": "2026-09-12T14:03:00Z", "instanceId": "i-testinstance", "reason": "a" * 33, "generation": 1, "tag": None}, "reason")
    refused({**step_row, "step": ""}, "step")
    assert validate_spool_row({**step_row, "v": 2}).later is True, "a later row version is skipped, not corrupt"
    refused({**step_row, "v": 2}, "v")
    refused({**run_row, "agentRun": 2}, "agentRun")
    refused({key: value for key, value in run_row.items() if key != "tokensSq"}, "tokensSq")
    refused({**run_row, "tokensSq": {**run_row["tokensSq"], "inputOutput": -1}}, "tokensSq")
    refused({**run_row, "latencyMs": {**run_row["latencyMs"], "buckets": [0] * len(LATENCY_BUCKET_EDGES_MS)}}, "histogram")
    refused({key: value for key, value in run_row.items() if key != "artifactId"}, "artifactId")
    refused({**feedback, "tokensSq": run_row["tokensSq"]}, "feedback_measurements")
    refused({**feedback, "modelCalls": 1}, "feedback_measurements")
    refused({**feedback, "outcomes": {"rating": {"n": 1, "sum": 4}}}, "outcomes:rating")


def test_writers_hold_their_side_counts_are_non_negative_integers_and_a_total_stays_finite():
    assert [count_of(value) for value in (3, 3.9, -2, True, None, "7", float("nan"), float("inf"), 10**400, 2**60)] == [3, 3, 0, 0, 0, 0, 0, 0, 0, 2**53 - 1]
    writer, rows = writing()
    writer.record_run(run(model_calls=2.5, tokens={"input": -5, "cachedInput": 1.5, "output": float("nan")}, tools={"calls": -1, "errors": 2.9}, checks={"passed": -1, "failed": 1}), T0)
    writer.observe(Observation(tag="support.reply", artifact_id="prm_1", version_id="ver_1", arm="none", model="gpt-5", status="ok", latency_ms=float("inf"), outcomes={"score": 1e200, "other": 2}), T0)
    written = rows()
    [row] = windows(written)
    assert validate_spool_row(json.loads(json.dumps(row, allow_nan=False))).ok, row
    assert (row["modelCalls"], row["tools"], row["checks"], row["tokens"]) == (3, {"calls": 0, "errors": 2}, {"passed": 0, "failed": 1}, {"input": 0, "output": 0, "cachedInput": 1})
    assert row["outcomes"] == {"other": {"n": 1, "sum": 2, "sumSq": 4}}, "a value whose square is not finite is skipped"
    assert row["latencyMs"]["sum"] == 100, "an infinite latency rounds to nothing"
    writer, rows = writing()
    writer.observe(Observation(tag="support.reply", artifact_id="prm_1", version_id="ver_1", arm="none", model="gpt-5", status="ok", latency_ms=1, outcomes={"score": 1.5}), T0)
    writer.observe(Observation(tag="support.reply", artifact_id="prm_1", version_id="ver_1", arm="none", model="gpt-5", status="ok", latency_ms=1, outcomes={"score": 10**400}), T0)
    [row] = windows(rows())
    assert row["outcomes"] == {"score": {"n": 1, "sum": 1.5, "sumSq": 2.25}}, "an integer past every double is skipped, beside a float total too"


GOOD = {"tag": "support.reply", "artifact_id": "prm_1", "version_id": "ver_1", "arm": "none", "model": "gpt-5", "status": "ok", "latency_ms": 5}


@pytest.mark.parametrize(
    "message, change",
    [
        ("telemetry_tag_invalid", {"tag": "docs.flow#2"}),
        ("telemetry_tag_invalid", {"tag": "Upper"}),
        ("telemetry_tag_invalid", {"tag": "a" * 129}),
        ("telemetry_tag_invalid", {"tag": "support.reply\n"}),
        ("telemetry_tag_invalid", {"tag": None}),
        ("telemetry_arm_invalid", {"arm": "Upper"}),
        ("telemetry_arm_invalid", {"arm": "a" * 33}),
        ("telemetry_model_invalid", {"model": "m" * 129}),
        ("telemetry_model_invalid", {"model": "\U0001f600" * 65}),
        ("telemetry_model_invalid", {"model": None}),
        ("telemetry_version_id_invalid", {"version_id": "v" * 129}),
        ("telemetry_version_id_invalid", {"version_id": "\U0001f600" * 65}),
        ("telemetry_status_invalid", {"status": "paused"}),
        ("telemetry_status_invalid", {"status": ["unhashable"]}),
        ("telemetry_usage_source_invalid", {"usage_source": "guessed"}),
        ("telemetry_usage_source_invalid", {"usage_source": ""}),
        ("telemetry_error_class_invalid", {"status": "error", "error_class": "exploded"}),
    ],
)
def test_a_writer_takes_a_bad_observation_as_a_refusal_to_write_the_row_never_exists(message, change):
    writer, rows = writing()
    with pytest.raises(ValueError, match=message):
        writer.observe(Observation(**{**GOOD, **change}), T0)
    assert rows() == [], "nothing was written"


def test_a_step_status_is_the_step_list_and_a_step_row_refuses_a_step_in_tag():
    writer, rows = writing()
    with pytest.raises(ValueError, match="telemetry_status_invalid"):
        writer.record_step(step("a", status="interrupted"), T0)
    with pytest.raises(ValueError, match="telemetry_tag_invalid"):
        writer.record_step(step("a", dimensions=RunDimensions(tag="docs.flow#2", artifact_id="prm_1", version_id="ver_1", arm="none", model="gpt-5")), T0)
    assert rows() == [], "nothing was written"


@pytest.mark.parametrize("bad", [{"latency_ms": None}, {"latency_ms": "slow"}, {"latency_ms": []}])
def test_a_value_only_python_raises_on_leaves_no_partial_row(bad):
    writer, rows = writing()
    writer.observe(Observation(**GOOD), T0)
    with pytest.raises(TypeError):
        writer.observe(Observation(**{**GOOD, "tag": "support.other", **bad}), T0)
    with pytest.raises(TypeError):
        writer.record_step(step("a", latency={"buckets": None, "sum": 1}), T0)
    written = rows()
    assert [row["tag"] for row in windows(written)] == ["support.reply"], "the bad run opened no window"
    assert steps(written) == [], "the bad step opened no row"


def test_values_javascript_reads_as_no_member_count_as_nothing_on_both_paths():
    writer, rows = writing()
    writer.observe(Observation(**GOOD, tokens=[1], tool_calls="x", checks=7, outcomes="x y"), T0)  # type: ignore[arg-type]
    writer.record_run(run(tokens="x", tools=[1], checks=7), T0)
    writer.record_step(step("a", tokens=[], tools=7), T0)
    written = rows()
    for row in written:
        assert validate_spool_row(row).ok, row
    assert sum(row["count"] for row in windows(written)) == 2


def test_a_lone_surrogate_goes_as_its_json_escape_and_a_length_is_counted_as_javascript_counts_it():
    assert [utf16_length(value) for value in ("abc", "\U0001f600", "\ud800")] == [3, 2, 1]
    written, rows = writing()
    written.record_run(run(), T0)
    row = rows()[0]
    assert validate_spool_row({**row, "model": "\U0001f600" * 65}).reason == "model", "130 units past the 128 another reader holds"
    assert validate_spool_row({**row, "model": "\U0001f600" * 64}).ok
    sink = MemorySink()
    writer = SpoolWriter(sink, IDENTITY)
    writer.observe(Observation(**{**GOOD, "model": "m\ud800"}), T0)
    writer.close_windows(T0 + 120_000)
    data = b"".join(_row_bytes(row) for row in sink.drain())
    assert b"\\ud800" in data, "an escape, as JSON.stringify writes it"
    assert inspect_segment(data, "i-testinstance", T0).invalid == []


WILD = [None, float("nan"), float("inf"), -1, 1.5, 1e308, 10**400, "", "x y", "Not Slug", "a#1", "A", "x" * 200, "\U0001f600" * 65, "\ud800", [], {}, True]
NESTED = {"tokens": {"input": 3, "cachedInput": 1, "output": 2}, "tool_calls": {"calls": 1, "errors": 0}, "checks": {"passed": 1, "failed": 0}, "outcomes": {"rating": 4}}


def test_no_writer_input_quarantines_a_segment_what_the_writer_takes_the_validator_takes():
    good = {**GOOD, **NESTED, "step": "s1"}
    quarantined: list[str] = []

    def attempt(observation: dict, label: str) -> None:
        sink = MemorySink()
        writer = SpoolWriter(sink, IDENTITY)
        try:
            writer.observe(Observation(**observation), T0)
        except Exception:  # noqa: BLE001 - dropped and logged by ``observe`` and ``report``
            pass
        writer.close_windows(T0 + 120_000)
        data = b"".join(_row_bytes(row) for row in sink.drain())
        invalid = inspect_segment(data, "i-testinstance", T0).invalid
        if invalid:
            quarantined.append(f"{label}: {invalid}")

    for name in [*good, "usage_source", "error_class", "audience_ids", "run_minute"]:
        for value in WILD:
            attempt({**good, name: value}, f"{name}={value!r:.40}")
    for outer, members in NESTED.items():
        for inner in members:
            for value in WILD:
                attempt({**good, outer: {**members, inner: value}}, f"{outer}.{inner}={value!r:.40}")
    assert quarantined == []


def test_a_skipped_line_is_a_line_the_dropped_row_says_so_and_names_no_segment():
    writer, rows = writing()
    writer.record_run(run(), T0)
    row = rows()[0]
    inspection = inspect_segment(f"{json.dumps(row)}\n{json.dumps({**row, 'v': 5})}\n".encode("utf-8"), row["instanceId"], T0)
    dropped = next(entry for entry in inspection.rows if entry["type"] == "dropped")
    assert (dropped["segments"], dropped["lines"]) == (0, 1)
    again = validate_spool_row(dropped)
    assert again.ok and again.row == dropped and again.stripped == [], "the row it writes is a row it reads, whole"
    assert validate_spool_row({**dropped, "lines": 0}).reason == "lines"
    assert validate_spool_row({key: value for key, value in dropped.items() if key != "lines"}).reason == "segments", "no lines, then at least one segment"
    metrics = spool_rows_to_otlp(inspection.rows)["resourceMetrics"][0]["scopeMetrics"][0]["metrics"]
    segments = next((metric for metric in metrics if "dropped" in metric["name"] and "segment" in metric["name"]), None)
    assert '"asInt": "1"' not in json.dumps(segments), segments


def test_record_step_counts_model_calls_from_the_histogram_and_rounds_the_sum():
    writer, rows = writing()
    latency = histogram(100, 200, 300)
    writer.record_step(step("a", model_calls=99, latency={"buckets": [*latency["buckets"], 5], "sum": 600.5}), T0)
    writer.record_step(step("a", model_calls=1, latency={"buckets": [-1, *latency["buckets"][1:]], "sum": float("nan")}), T0)
    [row] = steps(rows())
    assert (row["modelCalls"], row["latencyMs"]["sum"]) == (6, 601), "the validator holds the two equal"
    assert validate_spool_row(row).ok, row


def test_otel_a_segment_with_step_rows_gives_the_same_metrics_as_without_them():
    writer, rows = writing()
    writer.record_run(run(tokens={"input": 7, "cachedInput": 1, "output": 3}), T0)
    writer.record_step(step("a"), T0)
    writer.record_step(step("b"), T0)
    written = rows()
    without = [row for row in written if row["type"] != "step"]
    assert len(written) - len(without) == 2
    assert spool_rows_to_otlp(written) == spool_rows_to_otlp(without)
    foreign = {**steps(written)[0], "instanceId": "i-otherinstance", "instanceClass": "ephemeral", "sdk": "other/9"}
    assert spool_rows_to_otlp([foreign, *without]) == spool_rows_to_otlp(without), "a step row first names no resource"
    alone = spool_rows_to_otlp(steps(written))["resourceMetrics"][0]
    assert (alone["scopeMetrics"][0]["metrics"], alone["resource"]["attributes"]) == ([], []), "step rows alone are no metrics and no resource"
