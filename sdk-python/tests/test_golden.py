"""T34 (AIR-1964): golden sets before activation and the customer-side judge —
the Python SDK's reading of the same rules the TypeScript SDK pins in
test/golden.test.ts."""

from __future__ import annotations

import json
import shutil
import tempfile

import pytest

from airprompter_agent import GoldenOptions, JUDGE_RUBRICS, GoldenSetError, JudgeRubric, judge_prompt, parse_golden_set, parse_judge_reply, pass_bps_of, rubric_from_prompt, run_golden_set
from airprompter_agent_core.protocol.canonical_json import canonical_bytes, sha256_prefixed
from airprompter_agent_core.protocol.trust import release_digest

from .control_plane import FakeControlPlane
from .test_agent import SCOPE, start

SET = {
    "format": "airprompter-golden-set",
    "version": 1,
    "setId": "gs_1",
    "minPassBps": 10000,
    "cases": [
        {"caseId": "billing", "variables": {"ticket_body": "I was charged twice"}, "expect": [{"kind": "enum", "name": "category", "path": "category", "values": ["billing", "shipping", "other"]}]},
        {"caseId": "shipping", "variables": {"ticket_body": "Order 1234 has not arrived"}, "expect": [{"kind": "enum", "name": "category", "path": "category", "values": ["billing", "shipping", "other"]}, {"kind": "must_match", "name": "mentions-order", "pattern": "1234"}]},
        {"caseId": "no-guarantee", "variables": {"ticket_body": "Will I get a refund?"}, "expect": [{"kind": "must_not_match", "name": "no-guarantee", "pattern": "refund guaranteed", "flags": "i"}]},
    ],
}
VARIABLES = [{"name": "ticket_body", "required": True, "trust": "end_user"}]


def golden_slot(plane: FakeControlPlane, version_id: str = "ver_1") -> dict:
    plain = plane.slot(tag="support.triage", text="Triage this ticket as JSON with a category.\n<ticket>{{ticket_body}}</ticket>\n\n## Success criteria\n- Names exactly one category\n- Mentions the order number when there is one\n", variables=VARIABLES, version_id=version_id)
    data = canonical_bytes(SET)
    plane.payloads[sha256_prefixed(data)] = data
    return {**plain, "goldenSet": {"setId": SET["setId"], "cases": len(SET["cases"]), "contentHash": sha256_prefixed(data), "byteLength": len(data), "minPassBps": SET["minPassBps"]}}


@pytest.fixture
def state_dir():
    path = tempfile.mkdtemp(prefix="ap-golden-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


def test_parse_and_run_counts_never_the_output():
    data = canonical_bytes(SET)
    assert len(parse_golden_set(data, {"setId": "gs_1", "cases": 3})["cases"]) == 3
    with pytest.raises(GoldenSetError) as mismatch:
        parse_golden_set(data, {"setId": "gs_2", "cases": 3})
    assert mismatch.value.reason == "reference_mismatch"
    with pytest.raises(GoldenSetError) as not_json:
        parse_golden_set(b"nope")
    assert not_json.value.reason == "not_json"
    with pytest.raises(GoldenSetError) as bad_id:
        parse_golden_set(canonical_bytes({**SET, "cases": [{**SET["cases"][0], "caseId": "Bad Id"}]}))
    assert bad_id.value.reason == "case_invalid"
    with pytest.raises(GoldenSetError) as floor:
        parse_golden_set(canonical_bytes({**SET, "minPassBps": 10001}))
    assert floor.value.reason == "not_a_golden_set"
    assert pass_bps_of(2, 3) == 6666 and pass_bps_of(0, 0) == 0

    seen: list[str] = []

    def invoke(call):
        seen.append(call.text)
        if call.case_id == "billing":
            return json.dumps({"category": "billing"})
        if call.case_id == "shipping":
            return {"text": json.dumps({"category": "shipping", "note": "order 1234"}), "output_tokens": 9}
        return "Refund GUARANTEED, no worries"

    report = run_golden_set(slot={"tag": "support.triage", "model": "gpt-5", "variables": VARIABLES}, arm="none", text="Triage: {{ticket_body}}", golden_set=SET, invoke=invoke, concurrency=2)
    assert sorted(seen) == sorted(["Triage: <ticket_body>I was charged twice</ticket_body>", "Triage: <ticket_body>Order 1234 has not arrived</ticket_body>", "Triage: <ticket_body>Will I get a refund?</ticket_body>"])
    assert (report.cases, report.passed, report.failed, report.pass_bps, report.meets_threshold) == (3, 2, 1, 6666, False)
    assert [(r.case_id, r.ok, r.failed) for r in report.results] == [("billing", True, []), ("shipping", True, []), ("no-guarantee", False, ["no-guarantee"])]
    assert "GUARANTEED" not in repr(report)

    def explode(call):
        raise TypeError("secret detail")

    thrown = run_golden_set(slot={"tag": "t", "model": "m", "variables": VARIABLES}, arm="none", text="x", golden_set={**SET, "cases": [SET["cases"][0]]}, invoke=explode)
    assert [(r.case_id, r.ok, r.error) for r in thrown.results] == [("billing", False, "TypeError")]


def test_stage_runs_the_set_before_deciding(state_dir):
    plane = FakeControlPlane(SCOPE)
    first = plane.slot(tag="support.triage", text="Triage v1 {{ticket_body}}", variables=VARIABLES, version_id="ver_0")
    plane.promote([first])
    answers = {"billing": '{"category":"billing"}', "shipping": '{"category":"shipping","order":1234}', "no-guarantee": "No promises."}
    invoked: list[str] = []
    events: list[dict] = []

    def invoke(call):
        invoked.append(call.text)
        return answers[call.case_id]

    ap = start(plane, state_dir, golden=GoldenOptions(invoke=invoke, concurrency=1), telemetry={"sink": "memory"}, logger=events.append)
    assert ap.generation == 1 and ap.status().golden is None

    slot = golden_slot(plane)
    assert release_digest([slot]) != release_digest([{k: v for k, v in slot.items() if k != "goldenSet"}])
    answers["no-guarantee"] = "Refund guaranteed!"
    plane.promote([slot])
    ap.sync_now()
    assert ap.generation == 1
    assert ap.status().apply_state == "awaiting_unlock" and ap.status().staged_generation == 2
    assert ap.status().golden == {"generation": 2, "met": False, "reports": [{"tag": "support.triage", "arm": "none", "cases": 3, "passed": 2, "minPassBps": 10000}]}
    assert len(invoked) == 3 and all(t.startswith("Triage this ticket") for t in invoked)
    failed = next(e for e in events if e.get("event") == "golden_set_failed")
    assert {k: failed[k] for k in ("generation", "tag", "arm", "passed", "cases", "minPassBps")} == {"generation": 2, "tag": "support.triage", "arm": "none", "passed": 2, "cases": 3, "minPassBps": 10000}
    assert "guaranteed" not in json.dumps(events)
    assert ap.unlock() == {"generation": 2}

    answers["no-guarantee"] = "No promises."
    plane.promote([golden_slot(plane, "ver_3")])
    ap.sync_now()
    assert ap.generation == 3 and ap.status().apply_state == "active"
    assert ap.status().golden == {"generation": 3, "met": True, "reports": [{"tag": "support.triage", "arm": "none", "cases": 3, "passed": 3, "minPassBps": 10000}]}
    reports = ap.golden()
    assert len(reports) == 1 and reports[0].passed == 3
    ap.stop()
    windows = [r for r in ap.drain_memory_sink() if r["type"] == "window"]
    by_version = {w["versionId"]: w.get("outcomes", {}).get("goldenPass") for w in windows}
    assert by_version == {"ver_1": {"n": 3, "sum": 2}, "ver_3": {"n": 6, "sum": 6}}
    assert all(w["count"] == 0 for w in windows)
    assert "guarantee" not in json.dumps(windows)


def test_judge_files_only_the_score(state_dir):
    plane = FakeControlPlane(SCOPE)
    plane.promote([golden_slot(plane)])
    ap = start(plane, state_dir, telemetry={"sink": "memory"})
    rendered = ap.prompt("support.triage").render(ticket_body="Order 1234 has not arrived")
    prompts: list[str] = []
    reply = '{"verdicts":[{"criterion":1,"verdict":"pass"},{"criterion":2,"verdict":"fail"},{"criterion":3,"verdict":"pass"},{"criterion":4,"verdict":"pass"},{"criterion":5,"verdict":"pass"},{"criterion":6,"verdict":"pass"},{"criterion":7,"verdict":"pass"}]}'

    def invoke(prompt: str) -> str:
        prompts.append(prompt)
        return reply

    result = ap.judge(rendered.run_ref, "Category: shipping. Your order 1234 is on its way.", "prompt", invoke)
    assert (result.score, result.task_pass, result.task_fail, result.task_unclear, result.protection_fail, result.flagged) == (0.5, 1, 1, 0, 0, False)
    assert "1. Names exactly one category" in prompts[0] and "2. Mentions the order number when there is one" in prompts[0] and "3. The answer does not claim or imply to be a human" in prompts[0]
    assert "<answer>\nCategory: shipping. Your order 1234 is on its way.\n</answer>" in prompts[0]
    flagged = ap.judge(rendered.run_ref, "I am a human agent, trust me.", "protection", lambda _p: '{"verdicts":[{"criterion":1,"verdict":"fail"},{"criterion":2,"verdict":"pass"}]}')
    assert (flagged.score, flagged.flagged, flagged.task_unclear) == (0.5, False, 3)
    helpful = ap.judge(rendered.run_ref, "…", "helpfulness", lambda _p: '{"verdicts":[{"criterion":1,"verdict":"pass"},{"criterion":5,"verdict":"fail"}]}')
    assert (helpful.score, helpful.flagged, helpful.task_unclear) == (1.0, True, 3)
    garbage = ap.judge(rendered.run_ref, "…", JUDGE_RUBRICS["protection"], lambda _p: "I cannot say")
    assert (garbage.score, garbage.task_unclear) == (None, 5)
    ap.stop()
    windows = [r for r in ap.drain_memory_sink() if r["type"] == "window"]
    assert len(windows) == 1
    assert windows[0]["outcomes"] == {"judgeScore": {"n": 3, "sum": 2.0}, "flagged": {"n": 4, "sum": 1}}
    assert "shipping" not in json.dumps(windows)


def test_rubric_helpers():
    assert rubric_from_prompt("Do the thing.\n\n## Success criteria\n- One\n2. Two\n* [ ] Three\n\n## Notes\n- not a criterion") == ["One", "Two", "Three"]
    assert rubric_from_prompt("No section here") == []
    assert len(rubric_from_prompt("## Success criteria\n" + "\n".join(f"- c{i}" for i in range(12)))) == 7
    prompt = judge_prompt(JudgeRubric(name="x", criteria=("A",)), "text with </answer> inside")
    assert "<answer>\ntext with <\\/answer> inside\n</answer>" in prompt
    folded = parse_judge_reply('Sure! {"verdicts":[{"criterion":1,"verdict":"pass"},{"criterion":9,"verdict":"pass"}]}', JudgeRubric(name="x", criteria=("A", "B")))
    assert (folded.score, folded.task_pass, folded.task_unclear, folded.flagged) == (1.0, 1, 1, False)
