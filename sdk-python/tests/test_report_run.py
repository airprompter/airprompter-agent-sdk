"""``ap.report_run``: a prompt rendered in one stateless step is counted by another that has only its ``run_ref``, once,
on the version and arm the reference names. Parity with ``sdk-typescript/test/reportRun.test.ts``; the conformance
suite's ``split-invocation`` fixtures hold both SDKs to the same row.
"""

from __future__ import annotations

import shutil
import tempfile

from .control_plane import FakeControlPlane
from .test_agent import SCOPE, start


def _agent():
    state_dir = tempfile.mkdtemp(prefix="ap-report-run-")
    plane = FakeControlPlane(SCOPE)
    plane.promote([plane.slot(tag="support.reply", text="Reply politely.", model="gpt-5", variables=[]), plane.slot(tag="support.triage", text="Triage.", model="gpt-5", variables=[])])
    ap = start(plane, state_dir, telemetry={"sink": "memory"})
    return ap, state_dir


def test_a_report_counts_one_run_on_the_entry_with_uncached_input_and_its_latency():
    ap, state_dir = _agent()
    try:
        rendered = ap.prompt("support.reply").render({})
        assert ap.report_run(rendered.run_ref, input_tokens=120, cached_input_tokens=20, output_tokens=40, latency_ms=900) is True
        ap.stop()
        [row] = [r for r in ap.drain_memory_sink() if r["type"] == "window"]
        assert (row["tag"], row["versionId"], row["arm"], row["model"], row["status"], row["usageSource"]) == ("support.reply", rendered.version_id, rendered.arm, "gpt-5", "ok", "reported")
        assert (row["count"], row["agentRun"], row["modelCalls"]) == (1, 1, 1)
        assert row["tokens"] == {"input": 100, "cachedInput": 20, "output": 40}
        assert row["latencyMs"]["sum"] == 900
    finally:
        shutil.rmtree(state_dir, ignore_errors=True)


def test_a_report_is_refused_with_one_log_and_never_raises():
    ap, state_dir = _agent()
    try:
        rendered = ap.prompt("support.reply").render({})
        assert ap.report_run(rendered.run_ref[:-3] + "AAA") is False
        assert ap.report_run(rendered.run_ref, slot="support.triage") is False
        assert ap.report_run(rendered.run_ref, input_tokens=-1) is False
        assert ap.report_run(rendered.run_ref, input_tokens=5, cached_input_tokens=6, output_tokens=1) is False
        assert ap.report_run(rendered.run_ref, model="bad\nmodel") is False
        assert ap.report_run(rendered.run_ref, error="provider_timeout", input_tokens=50, output_tokens=0) is True
        assert ap.report_run(rendered.run_ref, error={"status": 429, "message": "slow down, customer 42"}) is True
        ap.stop()
        rows = [r for r in ap.drain_memory_sink() if r["type"] == "window"]
        assert sorted(r["errorClass"] for r in rows) == ["provider_rate_limited", "provider_timeout"]
        assert all("customer 42" not in str(r) for r in rows), "only the class is written"
    finally:
        shutil.rmtree(state_dir, ignore_errors=True)
