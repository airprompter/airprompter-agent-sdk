"""``airprompter_agent.frameworks.litellm``: the callback attributes a call only from ``metadata["airprompter"]``, whose
signed run reference is the authority; a forged, unsigned or foreign reference files nothing; a call inside an open run
is recorded into it; with none open, a one-call row is filed. Against LiteLLM's hook signatures, no library installed;
``test_frameworks_live.py`` runs the real ``litellm``."""

from __future__ import annotations

import asyncio
import datetime as dt
from dataclasses import replace
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
    AirPrompterLiteLLMCallback(agent).log_success_event({"model": "gpt-5", "litellm_params": {"metadata": metadata}}, {"usage": {"prompt_tokens": 3, "completion_tokens": 2}}, start, start + dt.timedelta(milliseconds=5))
    assert agent.feedback(run_ref, rating=5, model="gpt-5")
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
        AirPrompterLiteLLMCallback(ap).log_success_event({"model": step.model, "litellm_params": {"metadata": metadata}}, {"usage": {"prompt_tokens": 3, "completion_tokens": 2}}, start, start + dt.timedelta(milliseconds=5))
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
        assert set(metadata["airprompter"]) == {"tag", "runRef", "run"}, "content-free; marked as the run's"
        for _ in range(2):
            callback.log_success_event({"model": "gpt-5", "litellm_params": {"metadata": litellm_metadata((run, "support.triage"))}}, {"usage": {"prompt_tokens": 3, "completion_tokens": 2}}, start, start + dt.timedelta(milliseconds=5))
    windows = _windows(agent)
    assert [(w["tag"], w["count"], w["modelCalls"], w["agentRun"]) for w in windows] == [("support.triage", 1, 2, 1)], "one run, two model calls"


def test_litellm_params_are_the_release_model_and_settings():
    placed = Approved(slot="s", instructions="x", model="gpt-5", settings={"temperatureMilli": 200, "maxOutputTokens": 800, "stopSequences": ["END"]})
    assert litellm_params(placed) == {"model": "gpt-5", "temperature": 0.2, "max_completion_tokens": 800, "stop": ["END"]}
    assert litellm_params(Passthrough(slot="s", reason="no_slot")) == {}


def _success(callback, metadata, model="gpt-5"):
    start = dt.datetime(2026, 9, 12, 14, 3, 10)
    callback.log_success_event({"model": model, "litellm_params": {"metadata": metadata}}, {"usage": {"prompt_tokens": 3, "completion_tokens": 2}}, start, start + dt.timedelta(milliseconds=5))


def test_a_logger_thread_without_the_callers_context_records_into_the_run_the_reference_names(agent):
    import threading

    callback = AirPrompterLiteLLMCallback(agent)
    with agent.run(variables={"team": "Billing", "ticket": "refund"}) as a:
        a.place("support.triage")
        metadata = litellm_metadata((a, "support.triage"))
        # A plain thread: no copied context, as LiteLLM's logging pool gives.
        worker = threading.Thread(target=_success, args=(callback, metadata))
        worker.start()
        worker.join()
        with agent.run(subject="other") as b:
            b.place("support.reply")
            _success(callback, metadata)  # inside run B, but the reference names A
    windows = _windows(agent)
    by_tag = {w["tag"]: w for w in windows}
    assert (by_tag["support.triage"]["count"], by_tag["support.triage"]["modelCalls"]) == (1, 2), "both calls on A, the run the reference names"
    assert by_tag.get("support.reply", {}).get("modelCalls", 0) == 0, "run B is untouched"


def test_a_late_record_for_an_ended_run_is_dropped_with_one_log_never_counted_twice(agent):
    callback = AirPrompterLiteLLMCallback(agent)
    logged: list = []
    callback._ap = type("Spy", (), {"__getattr__": lambda self, name: getattr(agent, name), "log": lambda self, event: logged.append(event)})()
    with agent.run(variables={"team": "Billing", "ticket": "refund"}) as run:
        run.place("support.triage")
        metadata = litellm_metadata((run, "support.triage"))
    _success(callback, metadata)  # LiteLLM logged it after the block ended
    windows = _windows(agent)
    assert [(w["tag"], w["count"], w.get("modelCalls")) for w in windows] == [("support.triage", 1, 0)], "the run counted once; the late call is not a second row"
    assert [e["event"] for e in logged] == ["adapter_late_record"]


def test_a_call_sent_under_another_model_is_not_counted_against_the_version(agent):
    callback = AirPrompterLiteLLMCallback(agent)
    logged: list = []
    callback._ap = type("Spy", (), {"__getattr__": lambda self, name: getattr(agent, name), "log": lambda self, event: logged.append(event)})()
    rendered = agent.prompt("support.triage").render(team="Billing", ticket="refund")
    _success(callback, litellm_metadata(rendered), model="gpt-5-mini")
    _success(callback, litellm_metadata(rendered), model="gpt-5-mini")
    _success(callback, litellm_metadata(rendered), model="openai/gpt-5")
    _success(callback, litellm_metadata(rendered, model="azure/my-gpt5-deployment"), model="azure/my-gpt5-deployment")
    windows = _windows(agent)
    assert [(w["tag"], w["model"], w["count"]) for w in windows] == [("support.triage", "gpt-5", 2)], "the release's model, by its id or the id the call site named"
    assert [e["event"] for e in logged] == ["model_unresolved"], "logged once per model"


def test_a_run_resumed_under_the_same_id_on_another_version_does_not_take_an_older_call(agent):
    callback = AirPrompterLiteLLMCallback(agent)
    with agent.run(variables={"team": "Billing", "ticket": "refund"}) as run:
        run.place("support.triage")
        metadata = litellm_metadata((run, "support.triage"))
        ref = run.run_ref
    entry = agent.explain(ref)[0]
    forged_entry = {**entry, "versionId": "ver_other"}
    stale = {"airprompter": {"tag": "support.triage", "runRef": mint_run_ref(RunRefFacts("agt_1", "prod", agent._runs._host.parse_run_ref(ref).run_id, [forged_entry]), agent._run_ref_key), "run": True}}
    resumed = agent.open_run(resume=ref, variables={"team": "Billing", "ticket": "refund"})
    resumed.place("support.triage")
    _success(callback, stale)
    resumed.end()
    windows = _windows(agent)
    assert sum(w.get("modelCalls", 0) for w in windows) == 0, "the resumed run serves another version than the call's reference"
    assert metadata["airprompter"]["run"] is True


def test_an_alias_of_the_release_model_counts_with_or_without_litellms_stripped_prefix_and_by_router_group(agent):
    callback = AirPrompterLiteLLMCallback(agent)
    rendered = agent.prompt("support.triage").render(team="Billing", ticket="refund")
    named = litellm_metadata(rendered, model="azure/prod-gpt5")
    _success(callback, named, model="prod-gpt5")  # LiteLLM logs the id without its provider prefix
    _success(callback, named, model="azure/prod-gpt5")
    start = dt.datetime(2026, 9, 12, 14, 3, 10)
    grouped = {"airprompter": litellm_metadata(rendered)["airprompter"], "model_group": "gpt-5"}
    callback.log_success_event({"model": "some-deployment-id", "litellm_params": {"metadata": grouped}}, {"usage": {"prompt_tokens": 3, "completion_tokens": 2}}, start, start + dt.timedelta(milliseconds=5))
    windows = _windows(agent)
    assert [(w["tag"], w["model"], w["count"]) for w in windows] == [("support.triage", "gpt-5", 3)], "every alias counts under the release's model"


def test_a_prompt_rendered_inside_a_run_is_marked_as_the_runs_so_a_late_record_is_dropped_not_doubled(agent):
    callback = AirPrompterLiteLLMCallback(agent)
    with agent.run(variables={"team": "Billing", "ticket": "refund"}):
        inside = agent.prompt("support.triage").render(team="Billing", ticket="refund")
    outside = agent.prompt("support.triage").render(team="Billing", ticket="refund")
    assert inside._run_bound and not outside._run_bound
    # Internal: not in the repr, and not in equality (`Rendered` is promised, its `_run_bound` is not).
    assert "_run_bound" not in repr(inside) and inside == replace(inside, _run_bound=False)
    assert litellm_metadata(inside)["airprompter"].get("run") is True and "run" not in litellm_metadata(outside)["airprompter"]
    _success(callback, litellm_metadata(inside))  # LiteLLM logged it after the run ended
    windows = _windows(agent)
    assert sum(w["count"] for w in windows) == 1, "the run counted once; the late record is not a second row"


def test_a_workflow_step_inside_a_run_is_that_runs_in_context_and_a_late_record_is_dropped_not_doubled():
    state_dir = tempfile.mkdtemp(prefix="ap-integrations-")
    plane = FakeControlPlane({"organizationId": "org_1", "agentId": "agt_1", "target": "prod"})
    plane.promote([plane.slot(tag="docs.flow", text="flow", steps=[{"text": "Step one"}])])
    ap = AirPrompterAgent.start(organization_id="org_1", agent_id="agt_1", target="prod", api_key=plane.api_key, base_url="https://api.test", state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, sync=SyncOptions(mode="on_invoke", root_url="https://edge.test/roots/prod/root.json"), transport=plane.transport(), telemetry={"sink": "memory"})
    try:
        callback = AirPrompterLiteLLMCallback(ap)
        with ap.run(subject="u1"):
            step = ap.workflow("docs.flow").steps[0]
            assert step._run_bound
            _success(callback, litellm_metadata(step), model=step.model)  # in context: the open run takes it
        _success(callback, litellm_metadata(step), model=step.model)  # late: dropped
        assert not ap.workflow("docs.flow").steps[0]._run_bound
        ap.spool.close_windows(ap._now_ms())
        rows = [row for row in ap.drain_memory_sink() if row["type"] == "window"]
        assert (sum(r["count"] for r in rows), sum(r.get("modelCalls", 0) for r in rows)) == (1, 1), "one run with its one in-context call; the late one is no second row"
    finally:
        ap.stop()
        shutil.rmtree(state_dir, ignore_errors=True)


# ---------------------------------------------------------------------------------------------- protocol 4.1.0: the pre-call hook (AIR-2547)


def _call(metadata, call_id, model="gpt-5"):
    """What LiteLLM hands both hooks of one call: the same ``litellm_call_id``, the caller's metadata."""
    return {"model": model, "litellm_call_id": call_id, "litellm_params": {"metadata": metadata}}


def _settle(callback, kwargs):
    start = dt.datetime(2026, 9, 12, 14, 3, 10)
    callback.log_success_event(kwargs, {"usage": {"prompt_tokens": 3, "completion_tokens": 2}}, start, start + dt.timedelta(milliseconds=5))


def test_a_call_whose_log_lands_after_the_run_ended_writes_calls_not_reported(agent):
    callback = AirPrompterLiteLLMCallback(agent)
    logged: list = []
    callback._ap = type("Spy", (), {"__getattr__": lambda self, name: getattr(agent, name), "log": lambda self, event: logged.append(event)})()
    with agent.run(variables={"team": "Billing", "ticket": "refund"}) as run:
        run.place("support.triage")
        kwargs = _call(litellm_metadata((run, "support.triage")), "call-1")
        callback.log_pre_api_call("gpt-5", [], kwargs)  # in the caller's context, before the request
    _settle(callback, kwargs)  # the logger fired after the block ended: dropped
    [row] = _windows(agent)
    assert (row["count"], row["modelCalls"], row["usageSource"], row["callsReportedRuns"]) == (1, 0, "unavailable", 0), "the row says the call was not measured, never that none was made"
    assert not callback._open, "the late record closes what the pre-call hook opened"
    assert [e["event"] for e in logged] == ["adapter_late_record"], "one log for the late record"


def test_a_call_logged_in_time_is_measured_and_a_retry_opens_it_once(agent):
    callback = AirPrompterLiteLLMCallback(agent)
    with agent.run(variables={"team": "Billing", "ticket": "refund"}) as run:
        run.place("support.triage")
        kwargs = _call(litellm_metadata((run, "support.triage")), "call-1")
        callback.log_pre_api_call("gpt-5", [], kwargs)
        callback.log_pre_api_call("gpt-5", [], kwargs)  # LiteLLM's retry of the same call
        _settle(callback, kwargs)
    [row] = _windows(agent)
    assert (row["modelCalls"], row["usageSource"], row["callsReportedRuns"]) == (1, "reported", 1)


def test_the_pre_call_hook_opens_nothing_for_a_call_it_would_not_count(agent):
    callback = AirPrompterLiteLLMCallback(agent)
    with agent.run(variables={"team": "Billing", "ticket": "refund"}) as run:
        run.place("support.triage")
        metadata = litellm_metadata((run, "support.triage"))
        callback.log_pre_api_call("gpt-4o", [], _call(metadata, "other-model", model="gpt-4o"))  # another model's call
        callback.log_pre_api_call("gpt-5", [], _call({"other": 1}, "no-attribution"))
        callback.log_pre_api_call("gpt-5", [], {"model": "gpt-5", "litellm_params": {"metadata": metadata}})  # no call id
    [row] = _windows(agent)
    assert (row["modelCalls"], row["callsReportedRuns"]) == (0, 1), "a run whose only calls were not its own made no model call"
    assert not callback._open


def test_open_calls_are_bounded_and_an_ended_runs_calls_go_first(agent, monkeypatch):
    from airprompter_agent.frameworks import litellm as module

    monkeypatch.setattr(module, "OPEN_CALLS_MAX", 2)
    callback = AirPrompterLiteLLMCallback(agent)
    live = agent.open_run(variables={"team": "Billing", "ticket": "refund"})
    live.place("support.triage")
    metadata = litellm_metadata((live, "support.triage"))
    callback.log_pre_api_call("gpt-5", [], _call(metadata, "call-0"))  # the oldest, on a live run
    with agent.run(variables={"team": "Billing", "ticket": "refund"}) as ended:
        ended.place("support.triage")
        callback.log_pre_api_call("gpt-5", [], _call(litellm_metadata((ended, "support.triage")), "never-logged"))  # an abandoned stream
    callback.log_pre_api_call("gpt-5", [], _call(metadata, "call-1"))
    assert list(callback._open) == ["call-0", "call-1"], "the ended run's call went first, though call-0 is older"
    callback.log_pre_api_call("gpt-5", [], _call(metadata, "call-2"))
    assert list(callback._open) == ["call-1", "call-2"], "past the cap with every run live, the oldest goes"
    live.end()
    rows = _windows(agent)
    assert [row["callsReportedRuns"] for row in rows] == [0], "both runs share one row; neither is measured"
    assert sum(row["count"] for row in rows) == 2


def test_a_log_on_a_thread_without_the_callers_context_settles_the_call_the_pre_call_hook_opened():
    """A workflow step inside ``ap.run``: its own reference names no run, so the pre-call hook finds the run in the
    caller's context; a sync stream's log fires on a thread without it, and still settles the call on that run."""
    import threading

    state_dir = tempfile.mkdtemp(prefix="ap-integrations-")
    plane = FakeControlPlane({"organizationId": "org_1", "agentId": "agt_1", "target": "prod"})
    plane.promote([plane.slot(tag="docs.flow", text="flow", steps=[{"text": "Step one"}])])
    ap = AirPrompterAgent.start(organization_id="org_1", agent_id="agt_1", target="prod", api_key=plane.api_key, base_url="https://api.test", state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, sync=SyncOptions(mode="on_invoke", root_url="https://edge.test/roots/prod/root.json"), transport=plane.transport(), telemetry={"sink": "memory"})
    try:
        callback = AirPrompterLiteLLMCallback(ap)
        logged: list = []
        callback._ap = type("Spy", (), {"__getattr__": lambda self, name: getattr(ap, name), "log": lambda self, event: logged.append(event)})()
        with ap.run(subject="u1"):
            step = ap.workflow("docs.flow").steps[0]
            kwargs = _call(litellm_metadata(step), "step-call", model=step.model)
            callback.log_pre_api_call(step.model, [], kwargs)
            worker = threading.Thread(target=_settle, args=(callback, kwargs))
            worker.start()
            worker.join()
        ap.spool.close_windows(ap._now_ms())
        rows = [row for row in ap.drain_memory_sink() if row["type"] == "window" and row["count"] > 0]
        assert [(r["count"], r["modelCalls"], r["usageSource"], r["callsReportedRuns"]) for r in rows] == [(1, 1, "reported", 1)], rows
        assert not [e for e in logged if e["event"] == "adapter_late_record"], "in time: not a late record"
    finally:
        ap.stop()
        shutil.rmtree(state_dir, ignore_errors=True)
