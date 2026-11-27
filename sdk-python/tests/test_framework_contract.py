"""``airprompter_agent.frameworks.contract``: the helpers every adapter uses, over a release with three slots (sealed
settings, a different model, no settings). With ``test_render_and_hpke.py`` the pair proves that what the resolver
renders is what reaches the call. The TypeScript twin is ``test/frameworkContract.test.ts``."""

from __future__ import annotations

import asyncio
import shutil
import tempfile

import pytest

from airprompter_agent.frameworks.contract import ADAPTER_EVENTS, acquire_run, begin_measure, choose_model, measure_call, measure_call_async, settings_for

from .control_plane import FakeControlPlane
from .test_agent import SCOPE, start


@pytest.fixture
def state_dir():
    path = tempfile.mkdtemp(prefix="ap-contract-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


def agent(state_dir):
    plane = FakeControlPlane(SCOPE)
    plane.promote([
        {**plane.slot(tag="with.settings", text="Sealed.", model="gpt-5", variables=[]), "inference": {"temperatureMilli": 250, "topPBps": 9500, "maxOutputTokens": 600, "stopSequences": ["END"]}},
        plane.slot(tag="other.model", text="Elsewhere.", model="claude-haiku-4-5", variables=[]),
        plane.slot(tag="no.settings", text="Plain.", model="gpt-5", variables=[]),
        {**plane.slot(tag="checked", text="Checked.", model="gpt-5", variables=[]), "outputChecks": [{"kind": "must_match", "name": "signed", "pattern": "Regards"}]},
        plane.slot(tag="failing", text="Failing.", model="gpt-5", variables=[]),
    ])
    ap = start(plane, state_dir, telemetry={"sink": "memory"})

    def rows():
        ap.stop()
        return [r for r in ap.drain_memory_sink() if r["type"] == "window"]

    return ap, rows


def test_choose_model_in_order(state_dir):
    ap, rows = agent(state_dir)
    caller = object()
    with ap.run() as run:
        sealed, elsewhere = run.place("with.settings"), run.place("other.model")
        built = object()
        assert choose_model(release_model_id=sealed.model, caller_model=caller, caller_model_id="gpt-5", model_for=lambda *_: built, resolve=lambda _: None) is built, "model_for first"
        assert choose_model(release_model_id=sealed.model, caller_model=caller, caller_model_id="gpt-5", resolve=lambda _: built) is caller, "the caller's model on a matching id"
        assert choose_model(release_model_id=elsewhere.model, caller_model=caller, caller_model_id="gpt-5", resolve=lambda id: id) == "claude-haiku-4-5", "the resolver's string is for the adapter to build"
        assert choose_model(release_model_id=elsewhere.model, caller_model=caller, caller_model_id="gpt-5") is None, "nothing left: the adapter declines"
    rows()


def test_settings_for_converts_reports_unmapped_and_overridden(state_dir):
    ap, rows = agent(state_dir)
    with ap.run() as run:
        sealed, plain = run.place("with.settings"), run.place("no.settings")
        mapped = settings_for(sealed.settings, {"temperatureMilli": "temperature", "topPBps": "top_p", "maxOutputTokens": "max_tokens"}, {"temperature": 1, "top_p": 0.95})
        assert mapped.values == {"temperature": 0.25, "top_p": 0.95, "max_tokens": 600}
        assert mapped.unsupported == ["stopSequences"] and mapped.overridden == ["temperature"]
        empty = settings_for(plain.settings, {"temperatureMilli": "temperature"})
        assert (empty.values, empty.unsupported, empty.overridden) == ({}, [], [])
    rows()


def test_measure_call_records_usage_finish_and_checks_and_reraises_and_begin_measure_settles_once(state_dir):
    ap, rows = agent(state_dir)
    result = {"choices": [{"finish_reason": "length", "message": {"content": "cut, no signature"}}], "usage": {"prompt_tokens": 10, "completion_tokens": 4}}
    with ap.run() as run:
        run.place("checked")
        assert measure_call(run, "checked", lambda: result, model="gpt-5") is result

    class Slow(Exception):
        status_code = 504

    with pytest.raises(Slow):
        with ap.run() as run:
            run.place("failing")
            measure_call(run, "failing", lambda: (_ for _ in ()).throw(Slow("slow")), model="gpt-5")
    clock = [1000.0]
    ended = []
    with ap.run() as run:
        run.place("no.settings")
        measure = begin_measure(run, "no.settings", model="gpt-5", now=lambda: clock[0], on_settled=lambda: ended.append(1), read=lambda framework: {"usage": {"input_tokens": framework["n"], "output_tokens": 1}})
        clock[0] += 250
        measure.settle({"n": 7})
        measure.settle({"n": 99})
        measure.fail(RuntimeError("late"))
        assert measure.settled and ended == [1], "settles once"

    async def go():
        async with ap.run() as run:
            run.place("with.settings")

            async def call():
                return {"usage": {"input_tokens": 2, "output_tokens": 2}}

            await measure_call_async(run, "with.settings", call, model="gpt-5")

    asyncio.run(go())
    by_tag = {r["tag"]: r for r in rows()}
    assert (by_tag["checked"]["errorClass"], by_tag["checked"]["tokens"], by_tag["checked"]["checks"]) == ("truncated", {"input": 10, "output": 4}, {"passed": 0, "failed": 1})
    assert (by_tag["failing"]["errorClass"], by_tag["failing"]["usageSource"]) == ("provider_timeout", "unavailable")
    assert (by_tag["no.settings"]["tokens"]["input"], by_tag["no.settings"]["modelCalls"]) == (7, 1)
    assert by_tag["with.settings"]["modelCalls"] == 1


def test_acquire_run_and_the_event_vocabulary(state_dir):
    ap, rows = agent(state_dir)
    with ap.run() as run:
        assert acquire_run(ap) == (run, False)
    opened, owned = acquire_run(ap)
    assert owned
    opened.end()
    assert set(ADAPTER_EVENTS) == {"unattributed", "stream_helper_unmeasured", "model_unresolved", "placement_failed", "inference_overridden", "inference_unsupported", "tap_failed", "attribution_failed"}
    assert ADAPTER_EVENTS["unattributed"] == "adapter_unattributed", "the same names as TypeScript's ADAPTER_EVENTS"
    rows()
