"""Protocol 0.3.1 / 0.3.2: the slot's (and a workflow step's) inference settings — ``apply_inference`` on its own, the
LiteLLM keyword arguments, the workflow step, the golden invocation, the digest projection."""

from __future__ import annotations

import shutil
import tempfile
from types import SimpleNamespace

import pytest

from airprompter_agent import apply_inference as exported_apply_inference
from airprompter_agent.integrations.litellm import litellm_inference
from airprompter_agent_core.golden import GOLDEN_SET_FORMAT, GOLDEN_SET_VERSION, run_golden_set
from airprompter_agent_core.protocol.trust import inference_digest_input, release_digest
from airprompter_agent_runtime.inference import apply_inference

from .control_plane import FakeControlPlane
from .test_agent import SCOPE, start

@pytest.fixture
def state_dir():
    path = tempfile.mkdtemp(prefix="ap-inference-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


FULL = {"temperatureMilli": 200, "topPBps": 9000, "maxOutputTokens": 800, "stopSequences": ["\n\nHuman:"], "reasoningEffort": "low"}


def test_apply_inference_model_mismatch_null_keys_and_uncomparable_values():
    assert exported_apply_inference is apply_inference
    skipped = apply_inference("chat", {"model": "gpt-5-mini", "temperature": 1}, FULL, model="gpt-5")
    assert skipped.skipped == "model_mismatch" and skipped.params == {"model": "gpt-5-mini", "temperature": 1}
    assert apply_inference("chat", {"model": "gpt-5"}, FULL, model="gpt-5").skipped is None
    assert apply_inference("chat", {}, FULL, model="gpt-5").skipped is None, "a call that names no model gets the settings"

    assert apply_inference("chat", {}, {"temperatureMilli": None, "topPBps": 9000}).params == {"top_p": 0.9}, "a null key is absent, not temperature 0"

    sentinel = object()
    odd = apply_inference("chat", {"temperature": sentinel, "top_p": None}, {"temperatureMilli": 200, "topPBps": 9000})
    assert odd.params == {"temperature": 0.2, "top_p": 0.9}
    assert odd.overridden == ["temperature"], "an unset top_p is not a disagreement; a sentinel is replaced and reported, never raises"

    ordered = apply_inference("chat", {"max_completion_tokens": 1, "temperature": 1}, {"maxOutputTokens": 800, "temperatureMilli": 200})
    assert ordered.overridden == ["temperature", "max_completion_tokens"]


def test_apply_inference_messages_and_responses_rules():
    both = apply_inference("messages", {"max_tokens": 10}, FULL)
    assert both.params == {"max_tokens": 800, "temperature": 0.2, "stop_sequences": ["\n\nHuman:"]}
    assert both.unsupported == [{"setting": "topPBps", "reason": "one_sampling_parameter"}, {"setting": "reasoningEffort", "reason": "shape"}]
    assert apply_inference("messages", {}, {"topPBps": 9000}).params == {"top_p": 0.9}
    thinking = apply_inference("messages", {"thinking": {"type": "enabled", "budget_tokens": 1024}}, {"temperatureMilli": 200, "maxOutputTokens": 800})
    assert thinking.params == {"thinking": {"type": "enabled", "budget_tokens": 1024}, "max_tokens": 800}
    assert thinking.unsupported == [{"setting": "temperatureMilli", "reason": "thinking"}]

    merged = apply_inference("responses", {"reasoning": {"effort": "low", "summary": "auto"}}, {"reasoningEffort": "low"})
    assert merged.params == {"reasoning": {"effort": "low", "summary": "auto"}} and merged.overridden == []
    replaced = apply_inference("responses", {"reasoning": {"effort": "high", "summary": "auto"}}, {"reasoningEffort": "low"})
    assert replaced.params == {"reasoning": {"effort": "low", "summary": "auto"}} and replaced.overridden == ["reasoning.effort"]
    assert apply_inference("responses", {}, {"reasoningEffort": "medium"}).params == {"reasoning": {"effort": "medium"}}


def test_litellm_inference_keyword_arguments():
    assert litellm_inference(SimpleNamespace(inference=None)) == {}
    assert litellm_inference(SimpleNamespace(inference=FULL)) == {"temperature": 0.2, "top_p": 0.9, "max_completion_tokens": 800, "stop": ["\n\nHuman:"], "reasoning_effort": "low"}


def test_workflow_step_settings_and_golden_invocation(state_dir):
    events: list = []
    plane = FakeControlPlane(SCOPE)
    step_inference = {"temperatureMilli": 0, "maxOutputTokens": 1200}
    variables = [{"name": "doc", "required": True, "trust": "end_user"}, {"name": "lang", "required": True, "trust": "operator"}]
    wf = plane.slot(tag="docs.flow", text="flow", model="gpt-5", steps=[{"text": "Summarise {{doc}}", "inference": step_inference}, {"text": "Translate to {{lang}}"}], variables=variables)
    bare = plane.slot(tag="docs.flow", text="flow", model="gpt-5", steps=[{"text": "Summarise {{doc}}"}, {"text": "Translate to {{lang}}"}], variables=variables)
    assert release_digest([wf]) != release_digest([bare]), "a step's settings are in the release digest"
    assert inference_digest_input({"topPBps": None, "temperatureMilli": 0}) == {"temperatureMilli": 0}, "a null key is unset in the digest input"

    golden = {**plane.slot(tag="support.reply", text="Reply to {{name}}.", model="gpt-5", variables=[{"name": "name", "required": True, "trust": "operator"}]), "inference": FULL}
    plane.promote([wf, golden])
    ap = start(plane, state_dir, logger=events.append)
    flow = ap.workflow("docs.flow")
    assert flow.steps[0].inference == step_inference and flow.steps[1].inference is None
    handed = ap.workflow("docs.flow").steps[0].inference
    handed["temperatureMilli"] = 999  # type: ignore[index]
    assert flow.steps[0].inference == step_inference, "the handed-out block is a copy; the release is untouched"
    import json, pickle
    json.dumps(flow.steps[0].inference)
    pickle.dumps(flow.steps[0])

    calls: list = []

    def create(**params):
        calls.append(params)
        return SimpleNamespace(choices=[SimpleNamespace(finish_reason="stop", message=SimpleNamespace(role="assistant", content="ok"))], usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1))

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    ap.wrap(client).chat.completions.create(model="gpt-5", temperature=1, messages=[{"role": "system", "content": flow.steps[0].text}])
    assert calls[0]["temperature"] == 0 and calls[0]["max_completion_tokens"] == 1200, "the step's own settings"
    ap.wrap(client).chat.completions.create(model="gpt-5", temperature=1, messages=[{"role": "system", "content": flow.steps[1].text}])
    assert calls[1]["temperature"] == 1, "a step without settings leaves the call alone"

    with ap.attribute(flow.steps[0]):
        ap.wrap(client).chat.completions.create(model="gpt-5", temperature=1, messages=[{"role": "user", "content": "unseen"}])
    assert calls[2]["temperature"] == 0, "attribute() on a workflow step carries the step's settings"

    seen: list = []
    golden_set = {"format": GOLDEN_SET_FORMAT, "version": GOLDEN_SET_VERSION, "setId": "gs_1", "minPassBps": 10000, "cases": [{"caseId": "c1", "variables": {"name": "Ada"}, "expect": []}]}
    run_golden_set(slot=golden, arm="none", text="Reply to {{name}}.", golden_set=golden_set, invoke=lambda inv: (seen.append(inv.inference), "Reply to Ada.")[1])
    assert seen == [FULL]
    ap.stop()
