"""T29: the output-check evaluator agrees with the reference on every vector; checks travel in the manifest, run inside
observe() on the provider's answer without the text leaving, and count on the run's window."""

from __future__ import annotations

import json
import os
import shutil
import tempfile

import pytest

from airprompter_agent_core.checks import checks_refusals, evaluate_checks, pattern_refusal, project_checks
from airprompter_agent_core.protocol.trust import release_digest

from .control_plane import FakeControlPlane
from .test_agent import SCOPE, start

VECTORS = os.path.join(os.path.dirname(__file__), "..", "..", "protocol", "vectors", "checks.json")


@pytest.fixture
def state_dir():
    path = tempfile.mkdtemp(prefix="ap-checks-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


def test_check_vectors():
    with open(VECTORS, encoding="utf-8") as handle:
        doc = json.load(handle)
    for case in doc["evaluations"]:
        assert evaluate_checks(case["checks"], case["input"]["text"], case["input"]["outputTokens"]) == case["expected"], case["name"]
    for case in doc["patterns"]:
        assert pattern_refusal(case["pattern"]) == case["refusal"], case["pattern"][:40]
    for case in doc["declarations"]:
        assert checks_refusals(case["checks"]) == case["refusals"], case["name"]
    assert project_checks(doc["projection"]["checks"]) == doc["projection"]["expected"]
    assert len(doc["evaluations"]) >= 20


def test_checks_run_inside_observe_and_count_on_the_window(state_dir):
    plane = FakeControlPlane(SCOPE)
    output_checks = [
        {"kind": "enum", "name": "category", "path": "category", "values": ["billing", "shipping", "other"]},
        {"kind": "must_not_match", "name": "no-guarantee", "pattern": "refund guaranteed", "flags": "i"},
        {"kind": "length", "name": "band", "maxTokens": 50},
    ]
    plain = plane.slot(tag="support.triage", text="Triage.", version_id="ver_1")
    checked = {**plain, "outputChecks": output_checks}
    assert release_digest([checked]) != release_digest([plain]), "checks are part of the release"
    plane.promote([checked])
    ap = start(plane, state_dir, telemetry={"sink": "memory"})
    rendered = ap.prompt("support.triage").render()
    ap.observe(rendered, lambda: {"choices": [{"message": {"content": json.dumps({"category": "billing", "note": "Refund Guaranteed!"})}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 20}})
    ap.observe(rendered, lambda: {"content": [{"type": "text", "text": json.dumps({"category": "other"})}], "stop_reason": "end_turn", "usage": {"input_tokens": 10, "output_tokens": 5}})
    ap.observe(rendered, lambda: {"usage": {"input_tokens": 1, "output_tokens": 1}})
    manual = ap.checks(rendered, json.dumps({"category": "shipping", "pad": "x" * 380}))
    assert [(r["name"], r["verdict"], r.get("reason")) for r in manual["results"]] == [("category", "pass", None), ("no-guarantee", "pass", None), ("band", "fail", "too_long")]
    ap.stop()
    windows = [r for r in ap.drain_memory_sink() if r.get("type") == "window"]
    assert len(windows) == 1
    assert windows[0]["count"] == 3
    assert windows[0]["checks"] == {"passed": 7, "failed": 2}
    assert "Guaranteed" not in json.dumps(windows), "no output text on the wire"
