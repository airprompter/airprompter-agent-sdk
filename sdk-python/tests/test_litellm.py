"""``airprompter_agent.frameworks.litellm``: the callback attributes a call only from ``metadata["airprompter"]``, whose
signed run reference is the authority; a forged, unsigned or foreign reference files nothing; a call inside an open run
is recorded into it; with none open, a one-call row is filed. Against LiteLLM's hook signatures, no library installed;
``test_frameworks_live.py`` runs the real ``litellm``."""

from __future__ import annotations

import asyncio
import datetime as dt
import shutil
import tempfile
import types

import pytest

from airprompter_agent.agent import AirPrompterAgent, SyncOptions
from airprompter_agent.core.protocol.trust import public_jwk_of
from airprompter_agent.core.render.run_ref import RunRefFacts, mint_run_ref, new_run_id
from airprompter_agent.frameworks.contract import Approved, Passthrough
from airprompter_agent.frameworks.litellm import AirPrompterLiteLLMCallback, litellm_metadata, litellm_params

from .control_plane import FakeControlPlane


def obj(**fields):
    return types.SimpleNamespace(**fields)


@pytest.fixture
def agent():
    state_dir = tempfile.mkdtemp(prefix="ap-integrations-")
    plane = FakeControlPlane({"organizationId": "org_1", "agentId": "agt_1", "target": "prod"})
    plane.promote([plane.slot(tag="support.triage", text="Triage for {{team}}: {{ticket}}", variables=[{"name": "team", "required": True, "trust": "operator"}, {"name": "ticket", "required": True, "trust": "end_user"}], model="gpt-5"), plane.slot(tag="support.reply", text="Reply.", model="claude-sonnet-5")])
    ap = AirPrompterAgent.start(
        organization_id="org_1", agent_id="agt_1", target="prod", api_key=plane.api_key, base_url="https://api.test", state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, sync=SyncOptions(mode="on_invoke", root_url="https://edge.test/roots/prod/root.json"), transport=plane.transport(), telemetry={"sink": "memory"}
    )
    yield ap
    ap.stop()
    shutil.rmtree(state_dir, ignore_errors=True)


def _windows(ap):
    ap.spool.close_windows(ap._now_ms())
    return [r for r in ap.drain_memory_sink() if r["type"] == "window"]


def test_litellm_callback(agent):
    rendered = agent.prompt("support.triage").render(team="Billing", ticket="refund")
    callback = AirPrompterLiteLLMCallback(agent)
    metadata = litellm_metadata(rendered)
    assert set(metadata["airprompter"]) == {"tag", "runRef"}, "content-free: the tag and the signed reference only"
    assert "Billing" not in str(metadata)
    start = dt.datetime(2026, 9, 12, 14, 3, 10)
    end = start + dt.timedelta(milliseconds=812)
    response = obj(choices=[obj(finish_reason="stop")], usage=obj(prompt_tokens=100, completion_tokens=20))
    callback.log_success_event({"model": "gpt-5", "litellm_params": {"metadata": metadata}}, response, start, end)
    callback.log_failure_event({"model": "gpt-5", "litellm_params": {"metadata": metadata}, "exception": type("RateLimitError", (Exception,), {})("429")}, None, start, end)
    callback.log_success_event({"model": "gpt-5", "litellm_params": {"metadata": {"other": 1}}}, response, start, end)  # no attribution: ignored
    asyncio.run(callback.async_log_success_event({"model": "gpt-5", "metadata": metadata}, response, start, end))
    windows = _windows(agent)
    ok = next(w for w in windows if w["status"] == "ok")
    failed = next(w for w in windows if w["status"] == "error")
    assert ok["count"] == 2 and ok["tokens"] == {"input": 200, "output": 40} and ok["latencyMs"]["sum"] == 1624
    assert failed["errorClass"] == "provider_rate_limited" and failed["count"] == 1
    assert all(w["v"] == 5 and w["artifactId"] == rendered.artifact_id for w in windows)


def test_litellm_callback_preserves_authenticated_audience_dimensions(agent):
    entry = {"tag": "support.triage", "artifactId": "prm_targeted", "versionId": "ver_targeted", "model": "gpt-5", "arm": "candidate", "bucket": 42, "runMinute": "2026-09-12T14:03:00Z", "audienceIds": ["aud_AAAAAAAAAAAAAAAAAAAAAA"]}
    run_ref = mint_run_ref(RunRefFacts("agt_1", "prod", new_run_id(), [entry]), agent._run_ref_key)
    metadata = {"airprompter": {"tag": "support.triage", "versionId": "untrusted", "runRef": run_ref}}
    start = dt.datetime(2026, 9, 12, 14, 3, 10)
    AirPrompterLiteLLMCallback(agent).log_success_event({"model": "gpt-5-mini", "litellm_params": {"metadata": metadata}}, {"usage": {"prompt_tokens": 3, "completion_tokens": 2}}, start, start + dt.timedelta(milliseconds=5))
    assert agent.feedback(run_ref, rating=5, model="gpt-5-mini")
    windows = _windows(agent)
    assert all((window["artifactId"], window["tag"], window["versionId"], window["arm"]) == ("prm_targeted", "support.triage", "ver_targeted", "candidate") for window in windows), "the signed reference is the authority, not the metadata"
    assert next(window for window in windows if window["count"] == 1)["model"] == "gpt-5", "the row names the release's model"
    assert all(window["audienceIds"] == ["aud_AAAAAAAAAAAAAAAAAAAAAA"] for window in windows)
    measured = next(window for window in windows if window["count"] == 1)
    feedback = next(window for window in windows if window.get("outcomes"))
    assert measured["tokens"] == {"input": 3, "output": 2}
    assert feedback["count"] == 0 and feedback["outcomes"] == {"rating": {"n": 1, "sum": 5, "sumSq": 25}}


def test_litellm_callback_rejects_forged_cohort_attribution(agent):
    callback = AirPrompterLiteLLMCallback(agent)
    start = dt.datetime(2026, 9, 12, 14, 3, 10)
    response = {"usage": {"prompt_tokens": 3, "completion_tokens": 2}}
    forged = {"airprompter": {"tag": "forged", "versionId": "forged", "runRef": "forged.token", "artifactId": "prm_forged", "audienceIds": ["aud_AAAAAAAAAAAAAAAAAAAAAA"], "runMinute": "2026-09-12T14:03:00Z"}}
    callback.log_success_event({"model": "gpt-5", "litellm_params": {"metadata": forged}}, response, start, start + dt.timedelta(milliseconds=5))
    assert _windows(agent) == []

    unsigned = {"airprompter": {"tag": "support.unsigned", "versionId": "ver_unsigned", "arm": "none", "model": "gpt-5", "artifactId": "prm_forged", "audienceIds": ["aud_AAAAAAAAAAAAAAAAAAAAAA"], "runMinute": "2026-09-12T14:03:00Z"}}
    callback.log_success_event({"model": "gpt-5-mini", "litellm_params": {"metadata": unsigned}}, response, start, start + dt.timedelta(milliseconds=5))
    assert _windows(agent) == [], "a row needs an artifact id, and unsigned metadata cannot name one"

    no_entries = {"airprompter": {"tag": "x", "versionId": "x", "runRef": mint_run_ref(RunRefFacts("agt_1", "prod", new_run_id(), []), agent._run_ref_key)}}
    callback.log_success_event({"model": "gpt-5", "litellm_params": {"metadata": no_entries}}, response, start, start + dt.timedelta(milliseconds=5))
    assert _windows(agent) == []

    rendered = agent.prompt("support.triage").render(team="Billing", ticket="refund")
    other_tag = {"airprompter": {"tag": "support.reply", "runRef": rendered.run_ref}}
    callback.log_success_event({"model": "gpt-5", "litellm_params": {"metadata": other_tag}}, response, start, start + dt.timedelta(milliseconds=5))
    assert _windows(agent) == [], "a reference that names no entry for this tag is not this call's"
    callback.log_success_event({"model": "gpt-5", "litellm_params": {"metadata": no_entries}}, response, start, start + dt.timedelta(milliseconds=5))
    assert _windows(agent) == []


def test_litellm_callback_reports_a_workflow_step_under_the_slot_tag():
    state_dir = tempfile.mkdtemp(prefix="ap-integrations-")
    plane = FakeControlPlane({"organizationId": "org_1", "agentId": "agt_1", "target": "prod"})
    plane.promote([plane.slot(tag="docs.flow", text="flow", steps=[{"text": "Step one"}])])
    ap = AirPrompterAgent.start(organization_id="org_1", agent_id="agt_1", target="prod", api_key=plane.api_key, base_url="https://api.test", state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, sync=SyncOptions(mode="on_invoke", root_url="https://edge.test/roots/prod/root.json"), transport=plane.transport(), telemetry={"sink": "memory"})
    try:
        step = ap.workflow("docs.flow").steps[0]
        metadata = litellm_metadata(step)
        start = dt.datetime(2026, 9, 12, 14, 3, 10)
        AirPrompterLiteLLMCallback(ap).log_success_event({"model": "gpt-5", "litellm_params": {"metadata": metadata}}, {"usage": {"prompt_tokens": 3, "completion_tokens": 2}}, start, start + dt.timedelta(milliseconds=5))
        ap.spool.close_windows(ap._now_ms())
        rows = ap.drain_memory_sink()
        assert [(row["tag"], row["count"]) for row in rows if row["type"] == "window"] == [("docs.flow", 1)]
        assert [(row["tag"], row["step"]) for row in rows if row["type"] == "step"] == [("docs.flow", "docs.flow#1")]
    finally:
        ap.stop()
        shutil.rmtree(state_dir, ignore_errors=True)


def test_inside_an_open_run_the_call_is_recorded_into_it(agent):
    callback = AirPrompterLiteLLMCallback(agent)
    start = dt.datetime(2026, 9, 12, 14, 3, 10)
    with agent.run(variables={"team": "Billing", "ticket": "refund"}) as run:
        placed = run.place("support.triage")
        assert placed.kind == "approved"
        metadata = litellm_metadata((run, "support.triage"))
        assert set(metadata["airprompter"]) == {"tag", "runRef"}
        for _ in range(2):
            callback.log_success_event({"model": "gpt-5", "litellm_params": {"metadata": litellm_metadata((run, "support.triage"))}}, {"usage": {"prompt_tokens": 3, "completion_tokens": 2}}, start, start + dt.timedelta(milliseconds=5))
    windows = _windows(agent)
    assert [(w["tag"], w["count"], w["modelCalls"], w["agentRun"]) for w in windows] == [("support.triage", 1, 2, 1)], "one run, two model calls"


def test_litellm_params_are_the_release_model_and_settings():
    placed = Approved(slot="s", instructions="x", model="gpt-5", settings={"temperatureMilli": 200, "maxOutputTokens": 800, "stopSequences": ["END"]})
    assert litellm_params(placed) == {"model": "gpt-5", "temperature": 0.2, "max_completion_tokens": 800, "stop": ["END"]}
    assert litellm_params(Passthrough(slot="s", reason="no_slot")) == {}
