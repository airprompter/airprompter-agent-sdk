"""``airprompter_agent.frameworks.openai`` and ``.anthropic``: each row of the direct-client table over clients shaped
like the real ``openai`` and ``anthropic`` ones (SDK objects, ``stream=True`` streams, the ``.stream()`` helpers, sync and
async), read back as the rows that would upload. The TypeScript twins are ``test/frameworks/{openai,anthropic}.test.ts``."""

from __future__ import annotations

import asyncio
import shutil
import tempfile
from types import SimpleNamespace
from typing import Any

import pytest

from airprompter_agent.frameworks.anthropic import apply_placement as anthropic_placement
from airprompter_agent.frameworks.anthropic import instrument as instrument_anthropic
from airprompter_agent.frameworks.contract import ADAPTER_EVENTS, Approved, InstrumentRuntime
from airprompter_agent.frameworks.openai import apply_placement as openai_placement
from airprompter_agent.frameworks.openai import instrument as instrument_openai

from .control_plane import FakeControlPlane
from .fake_clients import FakeAnthropic, FakeAsyncAnthropic, FakeAsyncOpenAI, FakeOpenAI, StrictAnthropic, StrictAsyncAnthropic, anthropic_message, chat_completion
from .test_agent import SCOPE, start


@pytest.fixture
def state_dir():
    path = tempfile.mkdtemp(prefix="ap-frameworks-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


def start_agent(state_dir: str, slots, events: list | None = None):
    plane = FakeControlPlane(SCOPE)
    plane.promote(slots(plane))
    extra: dict[str, Any] = {"telemetry": {"sink": "memory"}}
    if events is not None:
        extra["logger"] = events.append
    ap = start(plane, state_dir, **extra)

    def rows():
        ap.stop()
        return [r for r in ap.drain_memory_sink() if r["type"] == "window"]

    return ap, rows


def support(plane):
    triage = plane.slot(tag="support.triage", text="Triage for {{team}}.", variables=[{"name": "team", "required": True, "trust": "operator"}], model="gpt-5")
    return [
        {**triage, "outputChecks": [{"kind": "must_not_match", "name": "no-guarantee", "pattern": "refund guaranteed", "flags": "i"}]},
        plane.slot(tag="support.reply", text="Reply politely.", model="claude-haiku-4-5", variables=[]),
    ]


def sealed(plane):
    return [{**plane.slot(tag="support.reply", text="Reply politely.", model="claude-haiku-4-5", variables=[]), "inference": {"temperatureMilli": 200, "topPBps": 9000, "maxOutputTokens": 800, "stopSequences": ["\n\nHuman:"], "reasoningEffort": "low"}}]


def by_key(rows):
    return sorted(rows, key=lambda r: (r["tag"], r["model"], r["status"], r.get("errorClass") or ""))


def test_the_agent_is_an_instrument_runtime(state_dir):
    ap, rows = start_agent(state_dir, support)
    runtime: InstrumentRuntime = ap  # the type check; at run time, every member is there
    assert all(callable(getattr(runtime, name)) for name in ("open_run", "current_run", "with_run", "log", "current_attribution", "begin_observation"))
    rows()


def test_a_slot_inside_a_run_places_the_text_and_the_release_model_on_a_copy_and_writes_one_run_row(state_dir):
    ap, rows = start_agent(state_dir, support)
    client = FakeOpenAI()
    openai = instrument_openai(client, ap, slot="support.triage")
    assert isinstance(openai, FakeOpenAI)
    assert instrument_openai(openai, ap, slot="support.reply") is openai, "instrumenting twice is once: the first slot stays"
    messages = [{"role": "system", "content": "my own prompt"}, {"role": "user", "content": "hi"}]
    with ap.run(subject="u1", variables={"team": "Billing"}):
        reply = openai.chat.completions.create(model="gpt-5", messages=messages)
        openai.chat.completions.create(messages=[{"role": "user", "content": "again"}])
    assert reply.choices[0].message.content == "answer 1 refund guaranteed"
    assert messages[0] == {"role": "system", "content": "my own prompt"}, "the input is never mutated"
    sent, again = client.calls
    assert sent["messages"][0] == {"role": "system", "content": "Triage for Billing."} and len(sent["messages"]) == 2
    assert again["messages"][0] == {"role": "system", "content": "Triage for Billing."}
    assert again["model"] == "gpt-5", "a call that names no model gets the release's"
    out = rows()
    assert [(r["tag"], r["count"], r["modelCalls"], r["agentRun"]) for r in out] == [("support.triage", 1, 2, 1)]
    assert out[0]["checks"] == {"passed": 0, "failed": 2}


def test_no_run_open_each_call_is_a_one_call_run(state_dir):
    ap, rows = start_agent(state_dir, support)
    openai = instrument_openai(FakeOpenAI(), ap, slot="support.reply")
    openai.chat.completions.create(model="claude-haiku-4-5", messages=[])
    openai.chat.completions.create(messages=[])
    out = rows()
    assert [(r["tag"], r["count"], r["agentRun"], r["status"]) for r in out] == [("support.reply", 2, 2, "ok")]


def test_a_different_model_declines_and_sends_the_callers_request_and_model_for_maps_it(state_dir):
    events: list = []
    ap, rows = start_agent(state_dir, support, events)
    client = FakeOpenAI()
    params = {"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}]}
    with ap.run(variables={"team": "Billing"}):
        instrument_openai(client, ap, slot="support.triage").chat.completions.create(**params)
    assert client.calls[0] == params
    assert [e for e in events if e.get("event") == ADAPTER_EVENTS["model_unresolved"]][0]["adapter"] == "openai"
    mapped = instrument_openai(client, ap, slot="support.triage", model_for=lambda release, caller: f"azure-{release}-for-{caller}")
    with ap.run(variables={"team": "Billing"}):
        mapped.chat.completions.create(**params)
    assert client.calls[1]["model"] == "azure-gpt-5-for-gpt-4o"
    out = by_key(rows())
    assert sorted((r["status"], r.get("errorClass") or "", r["count"]) for r in out) == [("error", "model_unresolved", 1), ("ok", "", 1)], "one declined run, one mapped run on the version"
    assert all(r["model"] == "gpt-5" for r in out), "every row names the release's model"


def test_a_stream_inside_the_run_is_measured_to_its_end_and_a_stream_helper_passes_through_once_logged(state_dir):
    events: list = []
    ap, rows = start_agent(state_dir, support, events)
    client = FakeOpenAI()
    openai = instrument_openai(client, ap, slot="support.triage")
    with ap.run(variables={"team": "Billing"}):
        text = "".join(getattr(chunk.choices[0].delta, "content", None) or "" for chunk in openai.chat.completions.create(model="gpt-5", stream=True, messages=[]) if chunk.choices)
    assert text == "streamed answer 1 refund guaranteed"
    helper = {"model": "gpt-5", "messages": [{"role": "user", "content": "hi"}]}
    for _ in range(2):
        with openai.chat.completions.stream(**helper) as stream:
            stream.get_final_completion()
    assert client.calls[1:] == [helper, helper]
    assert len([e for e in events if e.get("event") == ADAPTER_EVENTS["stream_helper_unmeasured"]]) == 1
    out = rows()
    assert [(r["status"], r.get("errorClass"), r["tokens"], r.get("checks")) for r in out] == [("error", "truncated", {"input": 100, "cachedInput": 20, "output": 30}, {"passed": 0, "failed": 1})]


def test_async_clients_place_with_place_async_and_measure(state_dir):
    ap, rows = start_agent(state_dir, support)
    client = FakeAsyncOpenAI()
    openai = instrument_openai(client, ap, slot="support.triage")

    async def go():
        async with ap.run(variables={"team": "Billing"}):
            await openai.chat.completions.create(model="gpt-5", messages=[])
            stream = await openai.chat.completions.create(model="gpt-5", stream=True, messages=[])
            async for _ in stream:
                pass

    asyncio.run(go())
    assert client.calls[0]["messages"][0] == {"role": "system", "content": "Triage for Billing."}
    out = rows()
    assert [(r["modelCalls"], r["agentRun"]) for r in out] == [(2, 1)]


def test_a_passthrough_is_untouched_and_a_failure_is_classified_and_raised(state_dir):
    ap, rows = start_agent(state_dir, support)
    client = FakeOpenAI()
    params = {"model": "gpt-5", "messages": [{"role": "user", "content": "hi"}]}
    with ap.run():
        instrument_openai(client, ap, slot="not.released").chat.completions.create(**params)
    assert client.calls[0] == params
    client.fail = type("RateLimit", (Exception,), {"status_code": 429})("rate limited")
    with pytest.raises(Exception, match="rate limited"):
        with ap.run():
            instrument_openai(client, ap, slot="support.reply").chat.completions.create(messages=[])
    out = rows()
    assert [(r["tag"], r["status"], r.get("errorClass")) for r in out] == [("support.reply", "error", "provider_rate_limited")]


def test_nothing_the_adapter_does_fails_the_call(state_dir):
    log: list = []

    class Broken:
        def place(self, slot):
            raise RuntimeError("exploded")

        def end(self, *a, **k):
            pass

    class Runtime:
        def current_run(self):
            return Broken()

        def open_run(self, *a, **k):
            return Broken()

        def log(self, event):
            log.append(event)

    client = FakeOpenAI()
    completion = instrument_openai(client, Runtime(), slot="s").chat.completions.create(model="gpt-5", messages=[])  # type: ignore[arg-type]
    assert completion.choices[0].message.content == "answer 1 refund guaranteed"
    assert client.calls[0] == {"model": "gpt-5", "messages": []}
    assert [e["event"] for e in log] == [ADAPTER_EVENTS["placement_failed"]]


def test_no_slot_no_scope_is_untouched_and_in_a_scope_the_release_model_gets_the_settings_and_another_goes_out_unobserved(state_dir):
    events: list = []

    def slots(plane):
        return [{**plane.slot(tag="support.reply", text="Reply politely.", model="gpt-5", variables=[]), "inference": {"temperatureMilli": 200, "maxOutputTokens": 800}}]

    ap, rows = start_agent(state_dir, slots, events)
    client = FakeOpenAI()
    openai = instrument_openai(client, ap)
    params = {"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}]}
    openai.chat.completions.create(**params)
    openai.chat.completions.create(**params)
    assert client.calls == [params, params]
    assert [(e["adapter"], e["method"]) for e in events if e.get("event") == ADAPTER_EVENTS["unattributed"]] == [("openai", "chat.completions.create")]
    rendered = ap.prompt("support.reply").render()
    with ap.attribute(rendered):
        openai.chat.completions.create(model="gpt-5", temperature=1, messages=[{"role": "user", "content": rendered.text + " Today is Friday."}])
        openai.chat.completions.create(model="my-azure-deployment", temperature=1, messages=[{"role": "user", "content": rendered.text}])
    scoped, azure = client.calls[2:]
    assert (scoped["model"], scoped["temperature"], scoped["max_completion_tokens"]) == ("gpt-5", 0.2, 800)
    assert (azure["model"], azure["temperature"], "max_completion_tokens" in azure) == ("my-azure-deployment", 1, False)
    out = by_key(rows())
    assert [(r["tag"], r["model"], r["count"]) for r in out] == [("support.reply", "gpt-5", 1)], "another model's numbers never count against this version"
    assert len([e for e in events if e.get("event") == ADAPTER_EVENTS["model_unresolved"]]) == 1


def test_responses_take_the_instructions(state_dir):
    ap, rows = start_agent(state_dir, support)
    client = FakeOpenAI()
    with ap.run(variables={"team": "Billing"}):
        instrument_openai(client, ap, slot="support.triage").responses.create(model="gpt-5", instructions="mine", input="hi")
    assert client.calls[0]["instructions"] == "Triage for Billing."
    out = rows()
    assert (out[0].get("errorClass"), out[0]["tokens"]) == ("truncated", {"input": 45, "cachedInput": 5, "output": 10})


def test_anthropic_system_and_settings_one_sampling_parameter_none_beside_thinking_and_async_streams(state_dir):
    ap, rows = start_agent(state_dir, sealed)
    client = FakeAnthropic()
    anthropic = instrument_anthropic(client, ap, slot="support.reply")
    with ap.run():
        anthropic.messages.create(model="claude-haiku-4-5", max_tokens=100, temperature=1, system="mine", messages=[{"role": "user", "content": "hi"}])
        anthropic.messages.create(max_tokens=100, thinking={"type": "enabled", "budget_tokens": 1024}, messages=[])
    sent, thought = client.calls
    assert (sent["system"], sent["temperature"], "top_p" in sent, sent["max_tokens"], sent["stop_sequences"]) == ("Reply politely.", 0.2, False, 800, ["\n\nHuman:"])
    assert ("temperature" in thought, "top_p" in thought, thought["model"]) == (False, False, "claude-haiku-4-5")
    aclient = instrument_anthropic(FakeAsyncAnthropic(), ap, slot="support.reply")

    async def go():
        async with ap.run():
            stream = await aclient.messages.create(model="claude-haiku-4-5", max_tokens=100, stream=True, messages=[])
            async for _ in stream:
                pass

    asyncio.run(go())
    out = by_key(rows())
    assert [(r["status"], r.get("errorClass"), r["modelCalls"]) for r in out] == [("error", "truncated", 1), ("ok", None, 2)]


def test_a_sealed_setting_the_installed_client_does_not_take_is_left_off_once_logged_and_the_call_is_recorded(state_dir):
    # AIR-2558: anthropic 2.14 dropped `temperature` from `messages.create`, and refuses it with a TypeError before sending.
    events: list = []
    ap, rows = start_agent(state_dir, sealed, events)
    client = StrictAnthropic()
    anthropic = instrument_anthropic(client, ap, slot="support.reply")
    with ap.run():
        for _ in range(2):
            reply = anthropic.messages.create(model="claude-haiku-4-5", max_tokens=100, messages=[{"role": "user", "content": "hi"}])
            assert reply.content[0].text == "strict reply"
    assert client.sent == [{"max_tokens": 800, "model": "claude-haiku-4-5", "system": "Reply politely.", "stop_sequences": ["\n\nHuman:"], "thinking": None}] * 2, "one request per call, with the rest of the placement"
    refused = [e for e in events if e.get("event") == ADAPTER_EVENTS["inference_unsupported"]]
    assert [(e["adapter"], e["slot"], e["method"], e["settings"]) for e in refused] == [("anthropic", "support.reply", "messages.create", [{"setting": "temperatureMilli", "reason": "client"}])], "logged once, not per call"
    aclient = StrictAsyncAnthropic()
    instrumented = instrument_anthropic(aclient, ap, slot="support.reply")

    async def go():
        async with ap.run():
            await instrumented.messages.create(model="claude-haiku-4-5", max_tokens=100, messages=[])

    asyncio.run(go())
    assert aclient.sent == [{"max_tokens": 800, "model": "claude-haiku-4-5", "system": "Reply politely.", "stop_sequences": ["\n\nHuman:"]}]
    out = by_key(rows())
    assert [(r["status"], r["count"], r["modelCalls"]) for r in out] == [("ok", 2, 3)], "both runs recorded, every call counted"


def test_in_a_scope_a_setting_the_client_refuses_is_left_off_and_logged_once_per_slot(state_dir):
    events: list = []

    def two(plane):
        return [{**plane.slot(tag=tag, text="Reply politely.", model="claude-haiku-4-5", variables=[]), "inference": {"temperatureMilli": 200, "maxOutputTokens": 800}} for tag in ("support.reply", "support.other")]

    ap, rows = start_agent(state_dir, two, events)
    client = StrictAnthropic()
    anthropic = instrument_anthropic(client, ap)
    for tag in ("support.reply", "support.other", "support.reply"):
        rendered = ap.prompt(tag).render()
        with ap.attribute(rendered):
            anthropic.messages.create(model="claude-haiku-4-5", max_tokens=100, system=rendered.text, messages=[])
    assert [sent["max_tokens"] for sent in client.sent] == [800, 800, 800]
    refused = [(e["slot"], e["settings"]) for e in events if e.get("event") == ADAPTER_EVENTS["inference_unsupported"]]
    assert refused == [(tag, [{"setting": "temperatureMilli", "reason": "client"}]) for tag in ("support.reply", "support.other")], "once per slot: one client serves every scope"
    assert sorted((r["tag"], r["count"], r["status"]) for r in rows()) == [("support.other", 1, "ok"), ("support.reply", 2, "ok")]


def test_a_keyword_only_the_caller_wrote_is_theirs_even_when_the_client_refuses_it(state_dir):
    def cap_only(plane):
        return [{**plane.slot(tag="support.reply", text="Reply politely.", model="claude-haiku-4-5", variables=[]), "inference": {"maxOutputTokens": 50}}]

    events: list = []
    ap, rows = start_agent(state_dir, cap_only, events)
    strict = StrictAnthropic()
    anthropic = instrument_anthropic(strict, ap, slot="support.reply")
    with ap.run():
        # The slot seals no temperature: the caller's own is the caller's, and the client refuses it as it would bare.
        with pytest.raises(TypeError, match="temperature"):
            anthropic.messages.create(model="claude-haiku-4-5", max_tokens=10, temperature=0.5, messages=[])
    rows()
    other_dir = tempfile.mkdtemp(prefix="ap-frameworks-")
    try:
        ap2, rows2 = start_agent(other_dir, sealed, events)
        anthropic2 = instrument_anthropic(strict, ap2, slot="support.reply")
        with ap2.run():
            # The sealed temperature is not applied beside `thinking`, so the caller's own is theirs here too.
            with pytest.raises(TypeError, match="temperature"):
                anthropic2.messages.create(model="claude-haiku-4-5", max_tokens=10, temperature=1, thinking={"type": "enabled", "budget_tokens": 1024}, messages=[])
        rows2()
    finally:
        shutil.rmtree(other_dir, ignore_errors=True)
    assert strict.sent == [] and not [e for e in events if e.get("event") == ADAPTER_EVENTS["inference_unsupported"] and any(s["reason"] == "client" for s in e["settings"])]


def test_a_signature_that_cannot_be_read_is_read_once_and_leaves_the_placement_whole(state_dir):
    class Create:
        reads = 0

        def __init__(self):
            self.sent: list = []

        @property
        def __signature__(self):
            Create.reads += 1
            raise RuntimeError("no signature here")

        def __call__(self, **params):
            self.sent.append(params)
            return anthropic_message("opaque reply")

    create = Create()
    client = SimpleNamespace(messages=SimpleNamespace(create=create))
    ap, rows = start_agent(state_dir, sealed)
    anthropic = instrument_anthropic(client, ap, slot="support.reply")
    with ap.run():
        for _ in range(2):
            anthropic.messages.create(model="claude-haiku-4-5", max_tokens=100, messages=[])
    assert [sent["temperature"] for sent in create.sent] == [0.2, 0.2], "nothing is left off on a guess"
    assert Create.reads == 1, "read once per method"
    assert [(r["count"], r["modelCalls"]) for r in rows()] == [(1, 2)]


def test_an_openai_release_without_max_completion_tokens_gets_the_sealed_cap_as_max_tokens(state_dir):
    class OldCompletions:
        def __init__(self):
            self.sent: list = []

        def create(self, *, messages: list, model: str, max_tokens: Any = None, temperature: Any = None, stream: Any = None):
            self.sent.append({"model": model, "max_tokens": max_tokens, "temperature": temperature})
            return chat_completion("old answer")

    def capped(plane):
        return [{**plane.slot(tag="support.reply", text="Reply politely.", model="gpt-4o", variables=[]), "inference": {"maxOutputTokens": 300, "temperatureMilli": 200}}]

    events: list = []
    ap, rows = start_agent(state_dir, capped, events)
    completions = OldCompletions()
    client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    openai = instrument_openai(client, ap, slot="support.reply")
    with ap.run():
        openai.chat.completions.create(model="gpt-4o", max_tokens=900, messages=[{"role": "user", "content": "hi"}])
    assert completions.sent == [{"model": "gpt-4o", "max_tokens": 300, "temperature": 0.2}], "the release's cap, on the lever this release has"
    assert not [e for e in events if e.get("event") == ADAPTER_EVENTS["inference_unsupported"]]
    assert [(r["count"], r["status"]) for r in rows()] == [(1, "ok")]


def test_apply_placement_keeps_a_developer_role_and_never_mutates():
    params = {"model": "x", "temperature": 1, "messages": [{"role": "developer", "content": "old"}, {"role": "user", "content": "hi"}]}
    out = openai_placement(params, Approved(slot="s", instructions="new", model="gpt-5", settings={"temperatureMilli": 300, "stopSequences": ["END"]}))
    assert out == {"model": "gpt-5", "temperature": 0.3, "stop": ["END"], "messages": [{"role": "developer", "content": "new"}, {"role": "user", "content": "hi"}]}
    assert params["messages"][0]["content"] == "old" and params["temperature"] == 1
    assert anthropic_placement({"system": [{"type": "text", "text": "old"}], "messages": []}, Approved(slot="s", instructions="new", model="claude-haiku-4-5", settings={})) == {"model": "claude-haiku-4-5", "system": "new", "messages": []}


def test_two_instrumented_clients_with_different_slots_in_one_run_give_two_run_rows(state_dir):
    def slots(plane):
        return [plane.slot(tag="support.triage", text="Triage.", model="gpt-5", variables=[]), plane.slot(tag="support.reply", text="Reply.", model="gpt-5", variables=[])]

    ap, rows = start_agent(state_dir, slots)
    triage = instrument_openai(FakeOpenAI(), ap, slot="support.triage")
    reply = instrument_openai(FakeOpenAI(), ap, slot="support.reply")
    with ap.run():
        triage.chat.completions.create(messages=[])
        reply.chat.completions.create(messages=[])
    out = by_key(rows())
    assert [(r["tag"], r["modelCalls"]) for r in out] == [("support.reply", 1), ("support.triage", 1)]
    assert sum(r.get("agentRun", 0) for r in out) == 1, "one run"


def test_a_stream_the_caller_breaks_out_of_settles_and_ends_the_run_it_opened(state_dir):
    ap, rows = start_agent(state_dir, support)
    openai = instrument_openai(FakeOpenAI(), ap, slot="support.reply")
    for _ in openai.chat.completions.create(stream=True, messages=[]):
        break  # never closed, never exhausted
    assert ap._runs.open_runs == 0, "the one-call run ended when the loop left"
    out = rows()
    assert [(r["tag"], r["count"], r["modelCalls"]) for r in out] == [("support.reply", 1, 1)]


def test_a_cancelled_async_placement_ends_the_run_it_opened(state_dir):
    ap, rows = start_agent(state_dir, support)
    client = FakeAsyncOpenAI()
    openai = instrument_openai(client, ap, slot="support.reply")

    async def go():
        task = asyncio.ensure_future(openai.chat.completions.create(messages=[]))
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        never = openai.chat.completions.create(messages=[])
        never.close()  # created and never awaited: it opened nothing

    asyncio.run(go())
    assert ap._runs.open_runs == 0
    rows()


def test_scope_mode_never_fails_the_call_when_observing_fails(state_dir):
    events: list = []
    ap, rows = start_agent(state_dir, support, events)
    client = FakeOpenAI()
    openai = instrument_openai(client, ap)
    rendered = ap.prompt("support.reply").render()
    original = ap.begin_observation
    ap.begin_observation = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("spool exploded"))  # type: ignore[method-assign]
    try:
        with ap.attribute(rendered):
            completion = openai.chat.completions.create(model="claude-haiku-4-5", messages=[])
    finally:
        ap.begin_observation = original  # type: ignore[method-assign]
    assert completion.choices[0].message.content == "answer 1 refund guaranteed"
    assert [e["event"] for e in events if e.get("adapter") == "openai"] == [ADAPTER_EVENTS["attribution_failed"]]
    rows()


def test_the_intercepted_method_keeps_its_name_and_an_async_one_reads_as_a_coroutine_function(state_dir):
    import inspect

    ap, rows = start_agent(state_dir, support)
    sync, asynchronous = instrument_openai(FakeOpenAI(), ap, slot="support.reply"), instrument_openai(FakeAsyncOpenAI(), ap, slot="support.reply")
    assert sync.chat.completions.create.__name__ == "_chat_create"
    assert not inspect.iscoroutinefunction(sync.chat.completions.create)
    if hasattr(inspect, "markcoroutinefunction"):
        assert inspect.iscoroutinefunction(asynchronous.chat.completions.create), "libraries that route on it see an async client"
    rows()
