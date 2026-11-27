"""The run: one request, one version per slot, one count. Drives a real agent over the fake control plane with a fake
clock and the memory sink, so what these tests read is the window row that would upload. Twins of
``sdk-typescript/test/runSession.test.ts``, one per rule, plus the Python-only paths: ``with`` and ``async with``,
sync ``place`` beside ``place_async``, and threads crossing the session.
"""

from __future__ import annotations

import asyncio
import base64
import json
import shutil
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Optional

import pytest

from airprompter_agent.agent import AirPrompterAgent, RenderRefusedError
from airprompter_agent.core._util import iso_ms, now_ms
from airprompter_agent.core.protocol.trust import public_jwk_of, release_digest
from airprompter_agent.runtime.run import Approved, Passthrough

from .control_plane import FakeControlPlane

SCOPE = {"organizationId": "org_1", "agentId": "agt_run", "target": "prod"}
TAG = "support.reply"
OTHER = "support.classify"
MINUTE = 60_000


class Fixture:
    def __init__(self) -> None:
        self.plane = FakeControlPlane(SCOPE)
        # The fake plane signs with the real clock, so the agent's clock starts there too.
        self.t0 = float(now_ms() // MINUTE * MINUTE)
        self.clock = [self.t0]
        self.plane.now = lambda: self.clock[0]
        self.events: list[dict[str, Any]] = []
        self.dirs: list[str] = []
        self.agents: list[AirPrompterAgent] = []

    def advance(self, ms: float) -> None:
        self.clock[0] += ms

    def start(self, **extra: Any) -> AirPrompterAgent:
        state_dir = tempfile.mkdtemp(prefix="ap-run-")
        self.dirs.append(state_dir)
        options: dict[str, Any] = {
            "organization_id": "org_1", "agent_id": SCOPE["agentId"], "target": SCOPE["target"], "api_key": self.plane.api_key, "base_url": "https://api.test",
            "state_dir": state_dir, "root": {"pinned": public_jwk_of(self.plane.root_key)},
            "sync": {"mode": "resident", "poll_seconds": 3600, "root_url": "https://edge.test/roots/prod/root.json"},
            "transport": self.plane.transport(), "telemetry": {"sink": "memory"}, "now": lambda: self.clock[0], "logger": self.events.append,
            **extra,
        }
        agent = AirPrompterAgent.start(**options)
        self.agents.append(agent)
        return agent

    def slot_of(self, text: str, version_id: str, **extra: Any) -> dict[str, Any]:
        return self.plane.slot(tag=extra.pop("tag", TAG), text=text, version_id=version_id, model="gpt", variables=extra.pop("variables", []), **extra)

    def rows(self, ap: AirPrompterAgent) -> list[dict[str, Any]]:
        """Window rows with a count."""
        return [row for row in self.all_rows(ap) if row.get("type") == "window" or "count" in row]

    def counted(self, ap: AirPrompterAgent) -> list[dict[str, Any]]:
        return [row for row in self.rows(ap) if row.get("count", 0) > 0]

    def all_rows(self, ap: AirPrompterAgent) -> list[dict[str, Any]]:
        ap.spool.close_windows(self.clock[0] + 120_000)
        return ap.drain_memory_sink()

    def named(self, event: str) -> list[dict[str, Any]]:
        return [entry for entry in self.events if entry.get("event") == event]


@pytest.fixture
def fx():
    fixture = Fixture()
    yield fixture
    for agent in fixture.agents:
        try:
            agent.stop()
        except Exception:  # noqa: BLE001 — a test that stopped it already
            pass
    for path in fixture.dirs:
        shutil.rmtree(path, ignore_errors=True)


def experiment(control: dict, candidate: dict, candidate_bps: int = 5000, subject_key: str = "request") -> dict[str, Any]:
    return {
        "experimentId": "exp_1", "tag": TAG, "salt": "AAECAwQFBgcICQoLDA0ODw", "subjectKey": subject_key,
        "arms": [
            {"arm": "control", "weightBps": 10_000 - candidate_bps, "releaseDigest": release_digest([control]), "overrides": []},
            {"arm": "candidate", "weightBps": candidate_bps, "releaseDigest": release_digest([candidate]), "overrides": [candidate]},
        ],
    }


def run_id_of(run_ref: str) -> str:
    """The run id a reference carries: the third element of its signed body. Tests only; ``ap.explain`` is the public read."""
    body = run_ref[: run_ref.rindex(".")]
    return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))[2]


def usage(input: int, output: int) -> dict[str, Any]:
    return {"input": input, "cached_input": 0, "output": output, "source": "reported"}


def disable(scope: str, **fields: str) -> dict[str, Any]:
    return {"kind": "disable", "scope": scope, **fields, "issuedAt": iso_ms(now_ms())}


def text_of(placed) -> Optional[str]:
    return placed.instructions if isinstance(placed, Approved) else None


def needs_name(fx: Fixture, tag: str = TAG, text: str = "Hello {{name}}", version_id: str = "ver_a") -> dict:
    return fx.slot_of(text, version_id, tag=tag, variables=[{"name": "name", "required": True, "trust": "operator"}])


def test_no_subject_never_uses_the_instance_id_1000_runs_split_near_the_weights(fx):
    a, b = fx.slot_of("Version A", "ver_a"), fx.slot_of("Version B", "ver_b")
    fx.plane.promote([a], experiments=[experiment(a, b, 2000)])
    ap = fx.start()
    seen: dict[str, int] = {}
    for _ in range(1000):
        with ap.run() as run:
            placed = run.place(TAG)
        assert placed.kind == "approved"
        seen[placed.instructions] = seen.get(placed.instructions, 0) + 1
    assert 140 < seen.get("Version B", 0) < 260, f"candidate share near 20 %: {seen}"
    direct = {ap.prompt(TAG).render({}).text for _ in range(200)}
    assert len(direct) == 2, "the direct path no longer hashes the instance either"
    ap.stop()


def test_subject_key_instance_still_uses_the_instance_id_so_the_whole_process_lands_on_one_arm(fx):
    a, b = fx.slot_of("Version A", "ver_a"), fx.slot_of("Version B", "ver_b")
    fx.plane.promote([a], experiments=[experiment(a, b, 5000, "instance")])
    ap = fx.start()
    texts = set()
    for i in range(100):
        with ap.run(subject=f"user-{i}") as run:
            texts.add(text_of(run.place(TAG)))
    assert len(texts) == 1
    ap.stop()


def test_prompt_takes_one_id_so_needs_and_render_read_the_same_arm_with_no_subject(fx):
    a = fx.slot_of("A {{x}}", "ver_a", variables=[{"name": "x", "required": True, "trust": "operator"}])
    b = fx.slot_of("Version B", "ver_b")
    fx.plane.promote([a], experiments=[experiment(a, b)])
    ap = fx.start()
    for _ in range(40):
        prompt = ap.prompt(TAG)
        needs = prompt.needs()
        text = prompt.render({"x": "1"} if len(needs) == 1 else {}).text
        assert text == ("A 1" if len(needs) == 1 else "Version B"), "the arm needs() read is the arm render() used"
    ap.stop()


def test_subject_is_subject_then_conversation_id_then_the_run_id(fx):
    a, b = fx.slot_of("Version A", "ver_a"), fx.slot_of("Version B", "ver_b")
    fx.plane.promote([a], experiments=[experiment(a, b)])
    ap = fx.start()

    def text(**fields: Any) -> Optional[str]:
        return text_of(ap.open_run(**fields).place(TAG))

    for i in range(20):
        assert text(subject=f"u{i}") == text(conversation_id=f"u{i}"), "conversation_id hashes like a subject"
        assert text(subject=f"u{i}", conversation_id="other") == text(subject=f"u{i}")
        ref = ap.open_run().run_ref
        assert text(resume=ref) == text(subject=run_id_of(ref)), "the run id hashes like a subject"
    ap.stop()


def test_a_ramp_step_and_a_release_swap_keep_the_pin_and_its_text_and_the_next_run_moves(fx):
    a, b = fx.slot_of("Version A", "ver_a"), fx.slot_of("Version B", "ver_b")
    fx.plane.promote([a], experiments=[experiment(a, b, 0)])
    ap = fx.start()
    run = ap.open_run(subject="ann")
    first = run.place(TAG)
    assert text_of(first) == "Version A"
    fx.plane.promote([fx.slot_of("Version C", "ver_c")])
    ap.sync_now()
    assert ap.generation == 2
    assert run.place(TAG) == first, "the old payload is gone from the store, and the run still holds its text"
    run.record_model_call(TAG, model="gpt", latency_ms=1, usage=usage(1, 1))
    run.end()
    with ap.run(subject="ann") as next_run:
        assert text_of(next_run.place(TAG)) == "Version C"
    ap.stop()


def test_a_slot_disable_gives_passthrough_at_the_next_place_even_for_a_pinned_slot_and_the_row_keeps_the_pin(fx):
    a = fx.slot_of("Version A", "ver_a")
    fx.plane.promote([a])
    ap = fx.start()
    run = ap.open_run(subject="ann")
    assert run.place(TAG).kind == "approved"
    run.record_model_call(TAG, model="gpt", latency_ms=1, usage=usage(5, 5))
    fx.plane.promote([a], directives=[disable("slot", tag=TAG)])
    ap.sync_now()
    assert run.place(TAG) == Passthrough(TAG, "slot_disabled")
    run.end()
    assert [(row["versionId"], row["count"], row["tokens"]["input"]) for row in fx.counted(ap)] == [("ver_a", 1, 5)]
    ap.stop()


def test_a_disabled_pinned_arm_re_places_on_the_control_and_the_run_stays_counted_on_the_arm_it_started_on(fx):
    a, b = fx.slot_of("Version A", "ver_a"), fx.slot_of("Version B", "ver_b")
    split = experiment(a, b, 10_000)
    fx.plane.promote([a], experiments=[split])
    ap = fx.start()
    run = ap.open_run(subject="ann")
    assert text_of(run.place(TAG)) == "Version B"
    run.record_model_call(TAG, model="gpt", latency_ms=1, usage=usage(5, 5))
    fx.plane.promote([a], experiments=[split], directives=[disable("arm", arm="candidate", experimentId="exp_1")])
    ap.sync_now()
    assert text_of(run.place(TAG)) == "Version A"
    run.record_model_call(TAG, model="gpt", latency_ms=1, usage=usage(5, 5))
    run.end()
    assert [(row["arm"], row["count"], row["tokens"]["input"]) for row in fx.counted(ap)] == [("candidate", 1, 10)]
    assert len(fx.named("run_replaced")) == 1
    ap.stop()


def test_each_reason_returns_passthrough_and_raises_nothing(fx):
    ap = fx.start()
    assert ap.open_run().place(TAG) == Passthrough(TAG, "no_verified_release")
    fx.plane.promote([fx.slot_of("Version A", "ver_a"), needs_name(fx, "needs.variable", version_id="ver_b"), fx.slot_of("Off", "ver_c", tag="off.slot")], directives=[disable("slot", tag="off.slot")])
    ap.sync_now()
    assert ap.open_run().place("nothing.here") == Passthrough("nothing.here", "no_slot")
    assert ap.open_run().place("needs.variable") == Passthrough("needs.variable", "variables_unfilled")
    assert ap.open_run().place("off.slot") == Passthrough("off.slot", "slot_disabled")
    assert ap.open_run(variables={"name": "Ann"}).place("needs.variable").kind == "approved"
    ap.stop()


def test_a_run_that_started_as_a_passthrough_stays_one_a_promotion_reaches_the_next_run(fx):
    ap = fx.start()
    run = ap.open_run(subject="ann")
    assert run.place(TAG).kind == "passthrough"
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap.sync_now()
    assert run.place(TAG).kind == "passthrough"
    assert ap.open_run(subject="ann").place(TAG).kind == "approved"
    ap.stop()


def test_two_concurrent_place_calls_render_once(fx):
    fx.plane.promote([needs_name(fx)])
    ap = fx.start()
    calls = [0]

    async def name(_context) -> str:
        calls[0] += 1
        await asyncio.sleep(0.005)
        return "Ann"

    ap.variables.provide("name", {"resolve": name, "trust": "operator"})
    run = ap.open_run()

    async def both():
        return await asyncio.gather(run.place_async(TAG), run.place_async(TAG))

    one, two = asyncio.run(both())
    assert calls[0] == 1
    assert one == two and text_of(one) == "Hello Ann"
    ap.stop()


def test_five_model_calls_and_end_give_one_count_summed_tokens_and_wall_clock_latency(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    run = ap.open_run(subject="ann")
    run.place(TAG)
    for _ in range(5):
        fx.advance(1000)
        run.record_model_call(TAG, model="gpt", latency_ms=400, usage=usage(10, 5))
    run.end()
    [row] = fx.counted(ap)
    assert (row["count"], row["tokens"]["input"], row["tokens"]["output"], row["latencyMs"]["sum"], row["status"], row["usageSource"]) == (1, 50, 25, 5000, "ok", "reported")
    ap.stop()


def test_end_twice_writes_once_and_a_pinned_slot_with_no_model_call_writes_model_calls_0(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    silent = ap.open_run()
    silent.place(TAG)
    silent.end()
    run = ap.open_run()
    run.place(TAG)
    run.record_model_call(TAG, model="gpt", latency_ms=1, usage=usage(1, 1))
    run.end()
    run.end()
    run.record_model_call(TAG, model="gpt", latency_ms=1, usage=usage(9, 9))
    run.end(error_class="provider_error")
    # usageSource is in the window key (v5): the silent run is `unavailable`, the other `reported`, so two rows.
    assert sorted((row["usageSource"], row["count"], row["modelCalls"], row["tokens"]["input"], row["status"]) for row in fx.counted(ap)) == [("reported", 1, 1, 1, "ok"), ("unavailable", 1, 0, 0, "ok")]
    assert len(fx.named("run_late_record")) == 1
    ap.stop()


def test_status_is_the_class_end_carries_else_the_last_model_calls_class_and_a_recovered_failure_is_ok(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()

    def once(calls: list[Optional[str]], carried: Optional[str] = None) -> None:
        run = ap.open_run()
        run.place(TAG)
        for error_class in calls:
            run.record_model_call(TAG, model="gpt", latency_ms=1, usage=usage(1, 1), error_class=error_class)
        run.end(error_class=carried)

    once(["provider_error", None])
    once([None, "truncated"])
    once([None], "provider_rate_limited")
    summary = sorted((row["status"], row["errorClass"] or "", row["count"]) for row in fx.counted(ap))
    assert summary == [("error", "provider_rate_limited", 1), ("error", "truncated", 1), ("ok", "", 1)]
    ap.stop()


class SlowDown(Exception):
    status = 429


def test_ap_run_ends_the_run_with_the_raised_errors_class_and_does_not_swallow_it(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    with pytest.raises(SlowDown, match="slow"):
        with ap.run() as run:
            assert ap.current_run() is run
            run.place(TAG)
            run.record_model_call(TAG, model="gpt", latency_ms=1)
            raise SlowDown("slow")
    assert ap.current_run() is None
    [row] = fx.counted(ap)
    assert (row["count"], row["status"], row["errorClass"], row["usageSource"]) == (1, "error", "provider_rate_limited", "unavailable")
    ap.stop()


def test_async_with_ap_run_sets_and_resets_the_run_in_its_own_task_and_ends_it_with_the_raised_class(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()

    async def request() -> None:
        async with ap.run() as run:
            assert ap.current_run() is run
            other = asyncio.create_task(asyncio.sleep(0, result=ap.current_run()))
            assert await other is run, "a task created inside the block copies the context"
            await run.place_async(TAG)
            raise SlowDown("slow")

    with pytest.raises(SlowDown):
        asyncio.run(request())
    assert ap.current_run() is None
    assert [(row["status"], row["errorClass"]) for row in fx.counted(ap)] == [("error", "provider_rate_limited")]
    ap.stop()


def test_the_sweep_ends_an_idle_run_with_the_last_errors_class(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    run = ap.open_run()
    run.place(TAG)
    run.record_model_call(TAG, model="gpt", latency_ms=1, error_class="provider_error")
    fx.advance(15 * MINUTE - 1)
    ap.open_run()
    assert fx.counted(ap) == [], "not yet idle"
    fx.advance(1)
    ap.open_run()
    assert [(row["count"], row["errorClass"]) for row in fx.counted(ap)] == [(1, "provider_error")]
    ap.stop()


def test_the_sweep_skips_a_run_inside_an_open_with_run_including_one_whose_coroutine_is_pending(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    run = ap.open_run()
    run.place(TAG)
    run.record_model_call(TAG, model="gpt", latency_ms=1)

    async def scenario() -> None:
        finish = asyncio.Event()

        async def tool() -> None:
            async with ap.with_run(run):
                await finish.wait()

        task = asyncio.create_task(tool())
        await asyncio.sleep(0)
        fx.advance(60 * MINUTE)
        ap.open_run()
        assert fx.counted(ap) == [], "a long tool does not end a live run"
        finish.set()
        await task

    asyncio.run(scenario())
    assert ap.open_run(resume=run.run_ref) is run, "the run is still live, and idle time restarts when the tool returns"
    fx.advance(15 * MINUTE)
    ap.open_run()
    assert len(fx.counted(ap)) == 1
    ap.stop()


def test_open_run_with_resume_is_get_or_create_after_a_sweep_repeated_resumes_are_one_new_session_on_the_same_subject(fx):
    a, b = fx.slot_of("Version A", "ver_a"), fx.slot_of("Version B", "ver_b")
    fx.plane.promote([a], experiments=[experiment(a, b)])
    ap = fx.start()
    run = ap.open_run(subject="ann")
    assert ap.open_run(resume=run.run_ref) is run
    before = run.place(TAG)
    old = run.run_ref
    fx.advance(15 * MINUTE)
    resumed = ap.open_run(resume=old, subject="ann")
    assert resumed is not run
    assert run_id_of(resumed.run_ref) == run_id_of(old)
    assert ap.open_run(resume=old, subject="ann") is resumed
    assert resumed.place(TAG) == before, "sticky assignment keeps the arm"
    ap.stop()


def test_stop_ends_open_runs_before_the_windows_close(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    run = ap.open_run()
    run.place(TAG)
    run.record_model_call(TAG, model="gpt", latency_ms=1, usage=usage(3, 3))
    ap.stop()
    written = [row for row in ap.drain_memory_sink() if row.get("count", 0) > 0]
    assert [(row["count"], row["tokens"]["input"]) for row in written] == [(1, 3)]


def test_a_label_the_heartbeat_cannot_carry_does_not_stop_a_served_call(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a", tag="Odd_Tag")])
    ap = fx.start()
    assert text_of(ap.open_run().place("Odd_Tag")) == "Version A"
    assert len(fx.named("run_label_invalid")) == 1
    ap.stop()


def test_a_slot_name_no_release_can_hold_is_no_slot_not_a_raise(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    assert ap.open_run().place("Not A Valid Tag") == Passthrough("Not A Valid Tag", "no_slot")
    ap.stop()


def test_an_ended_run_is_not_current_so_work_left_running_after_it_cannot_write_to_a_run_already_counted(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    run = ap.open_run()
    with ap.with_run(run):
        assert ap.current_run() is run
        run.end()
        assert ap.current_run() is None
    ap.stop()


def test_a_swept_runs_latency_stops_at_its_last_activity_not_after_the_idle_wait(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    run = ap.open_run()
    run.place(TAG)
    fx.advance(2000)
    run.record_model_call(TAG, model="gpt", latency_ms=2000, error_class="provider_error")
    fx.advance(15 * MINUTE)
    ap.open_run()
    assert [row["latencyMs"]["sum"] for row in fx.counted(ap)] == [2000]
    ap.stop()


def test_stop_during_an_open_scope_keeps_the_time_up_to_now(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    run = ap.open_run()
    run.place(TAG)
    run.record_model_call(TAG, model="gpt", latency_ms=1)
    with ap.with_run(run):
        fx.advance(600_000)
        ap.stop()
    assert [row["latencyMs"]["sum"] for row in ap.drain_memory_sink() if row.get("count", 0) > 0] == [600_000]


def test_the_spool_timer_runs_the_sweep(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    ticks: list = []

    class Inert:
        def cancel(self) -> None:
            pass

    ap._arm = lambda _delay, fn: ticks.append(fn) or Inert()  # type: ignore[method-assign]
    ap._schedule_spool_close()
    run = ap.open_run()
    run.place(TAG)
    run.record_model_call(TAG, model="gpt", latency_ms=1, usage=usage(1, 1))
    fx.advance(15 * MINUTE)
    ticks[0]()
    assert [row["count"] for row in fx.counted(ap)] == [1], "no open_run here: only the timer can have swept it"
    ap.stop()


def test_invoke_sweeps_at_both_edges_on_a_serverless_host(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start(sync={"mode": "on_invoke", "root_url": "https://edge.test/roots/prod/root.json"})
    ap.flush_telemetry = lambda: {}  # type: ignore[method-assign]  # keep the rows here to read them
    run = ap.open_run()
    run.place(TAG)
    run.record_model_call(TAG, model="gpt", latency_ms=1, usage=usage(1, 1))
    fx.advance(15 * MINUTE)
    ap.invoke(lambda: None)
    assert [row["count"] for row in fx.counted(ap)] == [1]
    ap.stop()


def test_a_tool_call_keeps_a_run_from_looking_idle(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    run = ap.open_run()
    run.place(TAG)
    fx.advance(14 * MINUTE)
    run.record_tool_call(TAG, ok=True)
    fx.advance(14 * MINUTE)
    assert ap.open_run(resume=run.run_ref) is run
    ap.stop()


def test_a_lapsed_lease_keeps_serving_a_first_placement_and_a_pinned_one_and_stamps_once(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")], lease_seconds=60)
    ap = fx.start()
    run = ap.open_run()
    assert run.place(TAG).kind == "approved"
    fx.advance(120_000)
    assert run.place(TAG).kind == "approved"
    assert ap.open_run().place(TAG).kind == "approved"
    ap.stop()
    refusals = [row["reason"] for row in ap.drain_memory_sink() if row.get("type") == "refusal"]
    assert refusals == ["lease_expired"]


def test_run_tags_reach_the_experiments_audience_and_their_names_reach_the_heartbeat(fx):
    a, b = fx.slot_of("Version A", "ver_a"), fx.slot_of("Version B", "ver_b")
    audience = {"audienceId": "aud_AAAAAAAAAAAAAAAAAAAAAA", "selector": {"mode": "when", "when": {"key": "plan", "is": "pro"}}}
    fx.plane.promote([a], experiments=[{**experiment(a, b, 10_000), "audience": audience}], observations=[{**audience, "tag": TAG, "observeFrom": "2026-01-01T00:00:00Z"}])
    ap = fx.start()
    assert text_of(ap.open_run(subject="ann", tags={"plan": "pro"}).place(TAG)) == "Version B"
    assert text_of(ap.open_run(subject="ann", tags={"plan": "free"}).place(TAG)) == "Version A"
    ap.heartbeat_now()
    ap.heartbeat_now()
    assert ap.heartbeat_body()["registration"]["tagKeys"] == ["plan"]
    ap.stop()


def test_run_ref_has_no_entries_until_a_slot_is_placed_and_its_run_id_is_fixed_at_open(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    run = ap.open_run()
    first = run.run_ref
    assert ap.explain(first) == []
    run.place(TAG)
    assert [entry["tag"] for entry in ap.explain(run.run_ref)] == [TAG]
    assert run_id_of(run.run_ref) == run_id_of(first)
    ap.stop()


# ---------------------------------------------------------------------------------------------- AIR-2242: the full run


def two_slots(fx: Fixture) -> list[dict]:
    return [fx.slot_of("Version A", "ver_a"), fx.slot_of("Classify", "ver_c", tag=OTHER)]


def test_rows_five_model_calls_two_tools_and_two_steps_give_one_run_row_and_step_rows_of_their_own_type(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    with ap.run(subject="ann") as run:
        run.place(TAG)
        for i in range(5):
            run.record_model_call(TAG, step="plan" if i < 3 else "reply", model="gpt", latency_ms=100, usage=usage(10, 2))
        run.record_tool_call(TAG, step="plan", ok=True)
        run.record_tool_call(TAG, ok=False)
    written = fx.all_rows(ap)
    windows = [row for row in written if row["type"] == "window" and row.get("count", 0) > 0]
    assert [(row["count"], row["modelCalls"], row["agentRun"], row["tools"]["calls"], row["tools"]["errors"], row["tokens"]["input"]) for row in windows] == [(1, 5, 1, 2, 1, 50)]
    steps = sorted((row["step"], row["modelCalls"], row["tools"]["calls"], row.get("count")) for row in written if row["type"] == "step")
    assert steps == [("plan", 3, 1, None), ("reply", 2, 0, None)]
    ap.stop()


def test_two_slots_in_one_run_write_two_run_rows_whose_agent_run_sums_to_1_under_one_growing_ref_with_one_run_id(fx):
    fx.plane.promote(two_slots(fx))
    ap = fx.start()
    refs = []
    with ap.run(subject="ann") as run:
        refs.append(run.run_ref)
        run.place(OTHER)
        run.record_model_call(OTHER, model="gpt", latency_ms=1, usage=usage(1, 1))
        refs.append(run.run_ref)
        run.place(TAG)
        run.record_model_call(TAG, model="gpt", latency_ms=1, usage=usage(2, 2))
        refs.append(run.run_ref)
    assert [[entry["tag"] for entry in ap.explain(ref)] for ref in refs] == [[], [OTHER], [OTHER, TAG]]
    assert len({run_id_of(ref) for ref in refs}) == 1
    assert sorted((row["tag"], row["count"], row["agentRun"]) for row in fx.counted(ap)) == [(OTHER, 1, 1), (TAG, 1, 0)]
    ap.stop()


def test_rule_2_a_frozen_experiment_every_arm_disabled_passes_a_pinned_slot_through(fx):
    a, b = fx.slot_of("Version A", "ver_a"), fx.slot_of("Version B", "ver_b")
    split = experiment(a, b)
    fx.plane.promote([a], experiments=[split])
    ap = fx.start()
    run = ap.open_run(subject="ann")
    assert run.place(TAG).kind == "approved"
    fx.plane.promote([a], experiments=[split], directives=[disable("arm", arm="candidate", experimentId="exp_1"), disable("arm", arm="control", experimentId="exp_1")])
    ap.sync_now()
    assert run.place(TAG) == Passthrough(TAG, "slot_disabled")
    ap.stop()


def test_rule_3_repeated_resume_returns_one_live_session_merging_tags_and_keeping_the_subject(fx):
    a, b = fx.slot_of("Version A", "ver_a"), fx.slot_of("Version B", "ver_b")
    fx.plane.promote([a], experiments=[experiment(a, b)])
    ap = fx.start()
    run = ap.open_run(subject="ann")
    before = run.place(TAG)
    for i in range(3):
        assert ap.open_run(resume=run.run_ref, subject=f"other-{i}", tags={"plan": "pro"}) is run
    assert run.subject == "ann"
    assert run.place(TAG) == before
    ap.stop()


def test_rule_3_after_a_sweep_the_same_old_ref_on_every_hook_of_a_two_call_resume_is_one_new_run_on_the_same_arm(fx):
    a, b = fx.slot_of("Version A", "ver_a"), fx.slot_of("Version B", "ver_b")
    fx.plane.promote([a], experiments=[experiment(a, b)])
    ap = fx.start()
    first = ap.open_run()
    placed = first.place(TAG)
    first.record_model_call(TAG, model="gpt", latency_ms=1)
    old = first.run_ref
    fx.advance(15 * MINUTE)
    sessions = {id(first)}
    for _hook in range(2):
        resumed = ap.open_run(resume=old)
        sessions.add(id(resumed))
        assert resumed.place(TAG) == placed, "no subject: the run id hashes the same, so the arm holds"
        resumed.record_model_call(TAG, model="gpt", latency_ms=1)
        assert run_id_of(resumed.run_ref) == run_id_of(old)
    assert len(sessions) == 2, "two sessions in all, not four"
    ap.open_run(resume=old).end()
    assert [row["count"] for row in fx.counted(ap)] == [1, 1], "the resume after the sweep counts as a second run"
    ap.stop()


def test_rule_3_a_forged_ref_opens_a_new_run_and_logs_run_resume_refused_without_raising(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    run = ap.open_run()
    forged = run.run_ref[:-3] + "AAA"
    opened = ap.open_run(resume=forged)
    assert opened is not run
    assert run_id_of(opened.run_ref) != run_id_of(run.run_ref)
    assert len(fx.named("run_resume_refused")) == 1
    assert ap.open_run(resume="not a ref") is not None
    ap.stop()


def test_rule_4_each_of_the_seven_reasons_is_a_passthrough_and_nothing_raises(fx):
    ap = fx.start()
    assert ap.open_run().place(TAG) == Passthrough(TAG, "no_verified_release")
    fx.plane.promote([
        fx.slot_of("Version A", "ver_a"),
        needs_name(fx, "needs.variable", version_id="ver_b"),
        fx.slot_of("Off", "ver_c", tag="off.slot"),
        fx.slot_of("flow", "ver_f", tag="a.flow", steps=[{"text": "Step one"}]),
    ], directives=[disable("slot", tag="off.slot")])
    ap.sync_now()

    def reason(slot: str) -> str:
        placed = ap.open_run().place(slot)
        return placed.reason if isinstance(placed, Passthrough) else placed.kind

    assert reason("nothing.here") == "no_slot"
    assert reason("needs.variable") == "variables_unfilled"
    assert reason("off.slot") == "slot_disabled"
    assert reason("a.flow") == "slot_kind_unsupported"
    run = ap.open_run()
    run.place(TAG)
    assert run.decline(TAG, "model_unresolved") == Passthrough(TAG, "model_unresolved")
    ap.stop()
    locked = Fixture()
    try:
        locked.plane.promote([locked.slot_of("Version A", "ver_a")], apply_policy="unlock_required")
        waiting = locked.start()
        assert waiting.open_run().place(TAG) == Passthrough(TAG, "awaiting_unlock")
        waiting.stop()
    finally:
        for path in locked.dirs:
            shutil.rmtree(path, ignore_errors=True)


def test_rule_4_decline_writes_one_error_row_however_many_calls_follow_and_carries_agent_run_1_when_it_is_first(fx):
    fx.plane.promote(two_slots(fx))
    ap = fx.start()
    with ap.run() as run:
        run.place(TAG)
        run.decline(TAG, "model_unresolved")
        for _ in range(3):
            assert run.place(TAG) == Passthrough(TAG, "model_unresolved")
        run.place(OTHER)
        run.record_model_call(OTHER, model="gpt", latency_ms=1)
    rows = sorted((row["tag"], row["status"], row["errorClass"] or "", row["agentRun"]) for row in fx.counted(ap))
    assert rows == [(OTHER, "ok", "", 0), (TAG, "error", "model_unresolved", 1)]
    assert ap.heartbeat_body()["runCounters"]["passthrough"] == {"model_unresolved": 1}
    assert [entry["tag"] for entry in ap.explain(run.run_ref)] == [OTHER], "a declined version leaves the reference"
    ap.stop()


def test_rule_4_a_missing_variable_writes_one_error_row_against_its_version_however_many_places_follow(fx):
    fx.plane.promote([needs_name(fx)])
    ap = fx.start()
    with ap.run() as run:
        for _ in range(3):
            assert run.place(TAG).kind == "passthrough"
    assert [(row["versionId"], row["count"], row["status"], row["errorClass"]) for row in fx.counted(ap)] == [("ver_a", 1, "error", "render_missing_variable")]
    ap.stop()


def test_rule_4_sync_place_runs_sync_sources_only_and_a_coroutine_source_there_is_variables_unfilled(fx):
    fx.plane.promote([needs_name(fx), needs_name(fx, OTHER, "Hi {{name}}", "ver_c")])
    ap = fx.start()

    async def name(_context) -> str:
        return "Ann"

    ap.variables.provide("name", {"resolve": name, "trust": "operator"})
    with ap.run() as run:
        assert run.place(TAG) == Passthrough(TAG, "variables_unfilled")
    ap.variables.provide("name", {"resolve": lambda _context: "Bo", "trust": "operator"})
    with ap.run() as run:
        assert text_of(run.place(OTHER)) == "Hi Bo", "a plain callable runs on the sync path"
    ap.stop()


def test_rule_5_the_sweep_writes_interrupted_when_no_record_carried_an_error(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    run = ap.open_run()
    run.place(TAG)
    run.record_model_call(TAG, model="gpt", latency_ms=1)
    fx.advance(15 * MINUTE)
    ap.open_run()
    assert [(row["status"], row["errorClass"]) for row in fx.counted(ap)] == [("interrupted", None)]
    ap.stop()


def test_rule_5_a_parked_run_survives_ap_runs_end_resumes_in_process_and_writes_one_row(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    with ap.run(subject="ann") as run:
        run.place(TAG)
        run.record_model_call(TAG, model="gpt", latency_ms=1, usage=usage(1, 1))
        run.end(interrupted=True)  # a person must approve before it goes on
        ref = run.run_ref
    assert fx.counted(ap) == [], "ap.run's own end does not close a parked run"
    with ap.run(resume=ref) as resumed:
        assert run_id_of(resumed.run_ref) == run_id_of(ref)
        resumed.place(TAG)
        resumed.record_model_call(TAG, model="gpt", latency_ms=1, usage=usage(2, 2))
    assert [(row["count"], row["modelCalls"], row["tokens"]["input"], row["status"]) for row in fx.counted(ap)] == [(1, 2, 3, "ok")]
    ap.stop()


def test_rule_5_the_sweep_skips_an_adapters_tool_call_whose_coroutine_is_pending_inside_with_run(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()

    async def scenario() -> None:
        finish = asyncio.Event()
        placed = asyncio.Event()

        async def request() -> None:
            async with ap.run() as run:
                await run.place_async(TAG)
                placed.set()
                async with ap.with_run(run):
                    await finish.wait()
                run.record_tool_call(TAG, ok=True)

        task = asyncio.create_task(request())
        await placed.wait()
        fx.advance(60 * MINUTE)
        ap.open_run()
        assert fx.counted(ap) == []
        finish.set()
        await task

    asyncio.run(scenario())
    assert [(row["status"], row["tools"]["calls"]) for row in fx.counted(ap)] == [("ok", 1)]
    ap.stop()


def test_rule_6_no_rendered_text_output_text_or_tag_value_reaches_the_ref_or_any_log_event(fx):
    fx.plane.promote([needs_name(fx, text="SECRET-PROMPT {{name}}")])
    ap = fx.start()
    with ap.run(subject="SECRET-SUBJECT", tags={"plan": "SECRET-TAG"}, variables={"name": "SECRET-NAME"}) as run:
        run.set_tags({"late": "SECRET-LATE"})
        run.place(TAG)
        run.record_model_call(TAG, model="gpt", latency_ms=1, output_text="SECRET-OUTPUT")
        run.slot_for({"known": TAG}, "SECRET-UNMAPPED-NAME-IS-A-NAME")
        ref = run.run_ref
    body = ref[: ref.rindex(".")]
    decoded = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)).decode("utf-8")
    logged = json.dumps(fx.events)
    for secret in ("SECRET-PROMPT", "SECRET-SUBJECT", "SECRET-TAG", "SECRET-NAME", "SECRET-LATE", "SECRET-OUTPUT"):
        assert secret not in decoded, f"{secret} is not in the ref"
        assert secret not in logged, f"{secret} is not in a log event"
    ap.stop()


def test_rule_7_feedback_reaches_each_entry_once_slot_names_one_and_model_without_slot_on_two_entries_is_refused(fx):
    a, b = fx.slot_of("Version A", "ver_a"), fx.slot_of("Version B", "ver_b")
    other = fx.slot_of("Classify", "ver_c", tag=OTHER)
    split = experiment(a, b, 10_000)
    split["arms"][0]["releaseDigest"] = release_digest(sorted([a, other], key=lambda s: s["tag"]))
    split["arms"][1]["releaseDigest"] = release_digest(sorted([b, other], key=lambda s: s["tag"]))
    fx.plane.promote([a, other], experiments=[split])
    ap = fx.start()
    with ap.run(subject="ann") as run:
        run.place(TAG)
        run.place(OTHER)
        run.record_model_call(TAG, model="gpt", latency_ms=1)
        ref = run.run_ref
    fx.rows(ap)
    assert ap.feedback(ref, {"thumbs": "up"}) is True
    assert ap.feedback(ref, {"thumbs": "down"}, slot=OTHER) is True
    assert ap.feedback(ref, {"thumbs": "down"}, slot="never.used") is False
    assert ap.feedback(ref, {"thumbs": "down"}, model="gpt-x") is False
    assert [entry["rejected"] for entry in fx.named("feedback_rejected")] == [{"model": "slot_required"}]
    assert ap.feedback(ref, {"thumbs": "down"}, model="gpt-x", slot=TAG) is True
    outcomes = sorted((row["tag"], row["arm"], row["versionId"], row["outcomes"]["thumbs"]["n"]) for row in fx.rows(ap) if row.get("outcomes"))
    # Feedback on one window merges; the model override is its own window.
    assert outcomes == [(OTHER, "none", "ver_c", 2), (TAG, "candidate", "ver_b", 1), (TAG, "candidate", "ver_b", 1)]
    ap.stop()


def test_rule_7_a_ref_minted_before_a_release_swap_files_on_its_own_version_explain_decodes_it_and_none_for_a_forged_one(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    with ap.run() as run:
        run.place(TAG)
        ref = run.run_ref
    fx.plane.promote([fx.slot_of("Version C", "ver_c")])
    ap.sync_now()
    fx.rows(ap)
    assert ap.feedback(ref, thumbs="up") is True
    assert [row["versionId"] for row in fx.rows(ap) if row.get("outcomes")] == ["ver_a"]
    assert [(entry["tag"], entry["versionId"], entry["arm"]) for entry in ap.explain(ref)] == [(TAG, "ver_a", "none")]
    assert ap.explain(ref[:-2] + "xx") is None
    ap.stop()


def test_rule_7_the_ref_stops_at_eight_entries_and_a_ninth_slot_is_served_and_measured_with_one_log(fx):
    tags = [f"slot{i}" for i in range(9)]
    fx.plane.promote([fx.slot_of(f"Text {tag}", f"ver_{tag}", tag=tag) for tag in tags])
    ap = fx.start()
    with ap.run() as run:
        for tag in tags:
            assert run.place(tag).kind == "approved"
            run.record_model_call(tag, model="gpt", latency_ms=1)
            run.run_ref
        ref = run.run_ref
    assert [entry["tag"] for entry in ap.explain(ref)] == tags[:8]
    assert len(fx.counted(ap)) == 9
    assert len(fx.named("run_ref_slots_capped")) == 1
    ap.stop()


def test_rule_8_concurrent_place_calls_on_two_slots_render_each_once(fx):
    fx.plane.promote([needs_name(fx), needs_name(fx, OTHER, "Hi {{name}}", "ver_c")])
    ap = fx.start()
    calls = [0]

    async def name(_context) -> str:
        calls[0] += 1
        await asyncio.sleep(0.005)
        return "Ann"

    ap.variables.provide("name", {"resolve": name, "trust": "operator"})
    run = ap.open_run()

    async def all_four():
        return await asyncio.gather(run.place_async(TAG), run.place_async(OTHER), run.place_async(TAG), run.place_async(OTHER))

    asyncio.run(all_four())
    assert calls[0] == 2
    ap.stop()


def test_rule_8_threads_placing_one_slot_at_once_render_it_once_with_the_fill_outside_the_lock(fx):
    fx.plane.promote([needs_name(fx)])
    ap = fx.start()
    calls = [0]
    counted = threading.Lock()

    def name(_context) -> str:
        with counted:
            calls[0] += 1
        time.sleep(0.05)
        return "Ann"

    ap.variables.provide("name", {"resolve": name, "trust": "operator"})
    run = ap.open_run()
    with ThreadPoolExecutor(max_workers=8) as pool:
        placed = list(pool.map(lambda _: run.place(TAG), range(8)))
        # While a fill is in flight another thread still records: the session lock is not held across the fill.
        list(pool.map(lambda _: run.record_tool_call(TAG, ok=True), range(4)))
    assert calls[0] == 1
    assert {text_of(entry) for entry in placed} == {"Hello Ann"}
    run.end()
    assert [(row["count"], row["tools"]["calls"]) for row in fx.counted(ap)] == [(1, 4)]
    ap.stop()


def test_rule_8_a_sync_and_an_async_caller_share_one_placement(fx):
    fx.plane.promote([needs_name(fx)])
    ap = fx.start()
    calls = [0]
    release = threading.Event()

    def name(_context) -> str:
        calls[0] += 1
        release.wait(2)
        return "Ann"

    ap.variables.provide("name", {"resolve": name, "trust": "operator"})
    run = ap.open_run()
    with ThreadPoolExecutor(max_workers=1) as pool:
        sync_side = pool.submit(run.place, TAG)

        async def async_side():
            while calls[0] == 0:
                await asyncio.sleep(0.001)
            waiting = asyncio.create_task(run.place_async(TAG))
            await asyncio.sleep(0.01)
            release.set()
            return await waiting

        from_async = asyncio.run(async_side())
        assert sync_side.result() == from_async
    assert calls[0] == 1
    ap.stop()


def test_rule_9_a_tag_set_after_the_first_slot_reaches_the_second_slots_rule_and_does_not_move_the_first(fx):
    a, b = fx.slot_of("Version A", "ver_a"), fx.slot_of("Version B", "ver_b")
    c, d = fx.slot_of("Classify A", "ver_c", tag=OTHER), fx.slot_of("Classify B", "ver_d", tag=OTHER)
    selector = {"mode": "when", "when": {"key": "intent", "is": "billing"}}

    def audience_of(tag: str) -> dict:
        return {"audienceId": "aud_AAAAAAAAAAAAAAAAAAAAAA" if tag == TAG else "aud_BBBBBBBBBBBBBBBBBBBBBB", "selector": selector}

    def arms(candidate: dict, experiment_id: str, tag: str) -> dict:
        base = sorted([c, a], key=lambda s: s["tag"])
        return {
            "experimentId": experiment_id, "tag": tag, "salt": "AAECAwQFBgcICQoLDA0ODw", "subjectKey": "request", "audience": audience_of(tag),
            "arms": [
                {"arm": "control", "weightBps": 0, "releaseDigest": release_digest(base), "overrides": []},
                {"arm": "candidate", "weightBps": 10_000, "releaseDigest": release_digest([candidate if slot["tag"] == tag else slot for slot in base]), "overrides": [candidate]},
            ],
        }

    fx.plane.promote([c, a], experiments=[arms(d, "exp_c", OTHER), arms(b, "exp_a", TAG)], observations=[{**audience_of(tag), "tag": tag, "observeFrom": "2026-01-01T00:00:00Z"} for tag in (OTHER, TAG)])
    ap = fx.start()
    with ap.run(subject="ann") as run:
        assert text_of(run.place(OTHER)) == "Classify A", "no intent yet: outside the audience"
        run.set_tags({"intent": "billing"})
        assert text_of(run.place(TAG)) == "Version B", "the late tag reaches the later slot's rule"
        assert text_of(run.place(OTHER)) == "Classify A", "the pinned slot never moves"
    ap.stop()


def test_rule_10_an_unmapped_name_and_a_slot_absent_from_the_release_each_log_once_and_count(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    for _ in range(2):
        with ap.run() as run:
            assert run.slot_for({"agent": TAG}, "agent") == TAG
            assert run.slot_for({"agent": TAG, "default": TAG}, "anything") == TAG
            assert run.slot_for({"agent": TAG}, "tools") is None
            assert run.slot_for({"agent": TAG}, "tools") is None
            assert run.slot_for({"typo": "support.rpely"}, "typo") is None
            assert run.slot_for(TAG) == TAG
    assert len(fx.named("run_step_unmapped")) == 1
    assert len(fx.named("run_slot_not_in_release")) == 1
    assert ap.heartbeat_body()["runCounters"]["passthrough"] == {"unmapped_step": 2, "slot_not_in_release": 2}
    ap.stop()


def test_rule_11_one_run_placed_log_per_slot_ids_only(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    with ap.run() as run:
        for _ in range(3):
            run.place(TAG)
        run.place("nothing.here")
    placed = [{key: event.get(key) for key in ("event", "slot", "versionId", "artifactId", "arm", "reason")} for event in fx.named("run_placed")]
    assert placed == [
        {"event": "run_placed", "slot": TAG, "versionId": "ver_a", "artifactId": f"art_{TAG}", "arm": "none", "reason": None},
        {"event": "run_placed", "slot": "nothing.here", "versionId": None, "artifactId": None, "arm": None, "reason": "no_slot"},
    ]
    ap.stop()


def test_declared_output_checks_read_output_text_once_and_count_on_the_run_row(fx):
    fx.plane.promote([{**fx.slot_of("Version A", "ver_a"), "outputChecks": [{"kind": "must_match", "name": "signed", "pattern": "Regards"}]}])
    ap = fx.start()
    with ap.run() as run:
        run.place(TAG)
        run.record_model_call(TAG, model="gpt", latency_ms=1, output_text="Kind Regards")
        run.record_model_call(TAG, model="gpt", latency_ms=1, output_text="bye")
        run.record_model_call(TAG, model="gpt", latency_ms=1)
    assert [row["checks"] for row in fx.counted(ap)] == [{"passed": 1, "failed": 1}]
    ap.stop()


def test_direct_path_ap_prompt_then_ap_observe_inside_ap_run_is_one_run_row_and_the_rendered_ref_is_the_runs(fx):
    fx.plane.promote(two_slots(fx))
    ap = fx.start()
    with ap.run(subject="ann") as run:
        run.place(OTHER)
        rendered = ap.prompt(TAG).render()
        assert run_id_of(rendered.run_ref) == run_id_of(run.run_ref)
        assert [entry["tag"] for entry in ap.explain(rendered.run_ref)] == [OTHER, TAG]
        ap.observe(rendered, lambda: {"usage": {"input_tokens": 4, "output_tokens": 2}})
        ap.observe(rendered, lambda: {"usage": {"input_tokens": 4, "output_tokens": 2}})
    rows = sorted((row["tag"], row["count"], row["modelCalls"], row["tokens"]["input"], row["agentRun"]) for row in fx.counted(ap))
    assert rows == [(OTHER, 1, 0, 0, 1), (TAG, 1, 2, 8, 0)]
    ap.stop()


def test_direct_path_a_render_failure_inside_a_run_marks_the_slots_row_instead_of_a_one_call_row(fx):
    fx.plane.promote([needs_name(fx)])
    ap = fx.start()
    with ap.run() as run:
        prompt = ap.prompt(TAG)
        for _ in range(2):
            with pytest.raises(Exception):
                prompt.render()
        assert run.is_ended is False
    assert [(row["count"], row["status"], row["errorClass"]) for row in fx.counted(ap)] == [(1, "error", "render_missing_variable")]
    ap.stop()


def test_direct_path_ap_workflow_inside_a_run_pins_so_every_call_keeps_one_arm(fx):
    a = fx.slot_of("flow", "ver_a", steps=[{"text": "Step A"}])
    b = fx.slot_of("flow", "ver_b", steps=[{"text": "Step B"}])
    fx.plane.promote([a], experiments=[experiment(a, b)])
    ap = fx.start()
    for _ in range(5):
        with ap.run():
            assert len({ap.workflow(TAG).arm for _ in range(10)}) == 1, "one arm per run"
    ap.stop()


def test_two_agents_in_one_process_b_current_run_is_none_inside_a_run(fx):
    two = Fixture()
    try:
        fx.plane.promote([fx.slot_of("Version A", "ver_a")])
        two.plane.promote([two.slot_of("Version A", "ver_a")])
        a = fx.start()
        b = two.start()
        with a.run() as run:
            assert a.current_run() is run
            assert b.current_run() is None
        a.stop()
        b.stop()
    finally:
        for path in two.dirs:
            shutil.rmtree(path, ignore_errors=True)


def test_start_with_nothing_promoted_starts_at_generation_0_and_says_why(fx):
    ap = fx.start()
    assert ap.generation == 0
    [line] = fx.named("started_without_release")
    assert "no release promoted to prod for agt_run on prod" in line["reason"]
    assert ap.healthz()["status"] == "degraded" and ap.healthz_response()[0] == 200
    with pytest.raises(Exception, match="no active release"):
        ap.prompt(TAG).render()
    ap.stop()


# ---------------------------------------------------------------------------------------------- protocol 3.1.0: toolsReported


def test_tools_reported_comes_from_a_tool_hook_or_tools_observed_and_is_false_without_either(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    with ap.run() as run:
        run.place(TAG)
        run.record_model_call(TAG, step="plan", model="gpt", latency_ms=1, usage=usage(1, 1))
        run.record_tool_call(TAG, ok=True)
    with ap.run() as run:
        run.place(TAG)
        run.record_model_call(TAG, step="plan", model="gpt", latency_ms=1, usage=usage(1, 1))
    with ap.run() as run:
        run.place(TAG)
        run.record_model_call(TAG, step="plan", model="gpt", latency_ms=1, usage=usage(1, 1), tools_observed=True)
    written = fx.all_rows(ap)
    windows = sorted((row["toolsReported"], row["count"], row["tools"]["calls"]) for row in written if row["type"] == "window" and row.get("count", 0) > 0)
    assert windows == [(False, 1, 0), (True, 2, 1)], "no hook: false; a tool hook or tools_observed: true, with calls 0 when none ran"
    assert sorted((row["toolsReported"], row["modelCalls"]) for row in written if row["type"] == "step") == [(False, 1), (True, 2)]
    ap.stop()


def test_take_reports_tools_when_the_observation_carries_tool_calls(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    with ap.run():
        rendered = ap.prompt(TAG).render()
        ap.observe(rendered, lambda: {"usage": {"input_tokens": 1, "output_tokens": 1}}, tool_calls={"calls": 0, "errors": 0})
    assert [(row["toolsReported"], row["tools"]["calls"]) for row in fx.counted(ap)] == [(True, 0)]
    ap.stop()


# ---------------------------------------------------------------------------------------------- review fixes


def test_concurrent_places_after_the_pinned_arm_is_disabled_all_get_the_re_placed_control(fx):
    """A caller holding the settled pin while another re-places it waits for the new pin; it never reads a dropped answer."""
    a = needs_name(fx, text="A {{name}}", version_id="ver_a")
    b = needs_name(fx, text="B {{name}}", version_id="ver_b")
    split = experiment(a, b, 10_000)
    fx.plane.promote([a], experiments=[split])
    ap = fx.start()
    re_placing = threading.Event()
    armed = [False]

    def name(_context) -> str:
        if armed[0]:
            re_placing.set()  # the re-place has dropped the old answer and is rendering the control
            time.sleep(0.1)
        return "Ann"

    ap.variables.provide("name", {"resolve": name, "trust": "operator"})
    run = ap.open_run(subject="ann")
    assert text_of(run.place(TAG)) == "B Ann"
    fx.plane.promote([a], experiments=[split], directives=[disable("arm", arm="candidate", experimentId="exp_1")])
    ap.sync_now()
    armed[0] = True
    original = run._pin_sync

    def late_pin(slot, stale=None):
        got = original(slot, stale)
        if threading.current_thread().name == "late" and stale is None and not re_placing.is_set():
            re_placing.wait(2)  # holds the old, settled pin until the other caller is mid re-place
        return got

    run._pin_sync = late_pin
    results: dict[str, Any] = {}

    def call(label: str) -> None:
        try:
            results[label] = run.place(TAG)
        except BaseException as error:  # noqa: BLE001 — the bug raised here
            results[label] = error

    late = threading.Thread(target=call, args=("late",), name="late")
    late.start()
    time.sleep(0.05)
    first = threading.Thread(target=call, args=("first",), name="first")
    first.start()
    late.join(5)
    first.join(5)
    assert {label: text_of(placed) if not isinstance(placed, BaseException) else repr(placed) for label, placed in results.items()} == {"first": "A Ann", "late": "A Ann"}
    assert len(fx.named("run_replaced")) == 1
    ap.stop()


def test_after_a_re_place_the_direct_path_folds_the_new_arm_into_the_slots_one_row(fx):
    a, b = fx.slot_of("Version A", "ver_a"), fx.slot_of("Version B", "ver_b")
    split = experiment(a, b, 10_000)
    fx.plane.promote([a], experiments=[split])
    ap = fx.start()
    with ap.run(subject="ann"):
        first = ap.prompt(TAG).render()
        assert first.text == "Version B"
        ap.observe(first, lambda: {"usage": {"input_tokens": 1, "output_tokens": 1}})
        fx.plane.promote([a], experiments=[split], directives=[disable("arm", arm="candidate", experimentId="exp_1")])
        ap.sync_now()
        second = ap.prompt(TAG).render()
        assert second.text == "Version A"
        ap.observe(second, lambda: {"usage": {"input_tokens": 1, "output_tokens": 1}})
    assert [(row["arm"], row["count"], row["modelCalls"]) for row in fx.counted(ap)] == [("candidate", 1, 2)], "one request, one row, no one-call run"
    ap.stop()


def test_a_slot_disable_keeps_the_direct_path_pin_so_a_re_enable_serves_the_same_version(fx):
    a, b = fx.slot_of("Version A", "ver_a"), fx.slot_of("Version B", "ver_b")
    fx.plane.promote([a], experiments=[experiment(a, b, 10_000)])
    ap = fx.start()
    with ap.run(subject="ann"):
        assert ap.prompt(TAG).render().text == "Version B"
        fx.plane.promote([a], experiments=[experiment(a, b, 10_000)], directives=[disable("slot", tag=TAG)])
        ap.sync_now()
        with pytest.raises(RenderRefusedError):
            ap.prompt(TAG).render()
        fx.plane.promote([a], experiments=[experiment(a, b, 0)])  # re-enabled, and the ramp moved to control meanwhile
        ap.sync_now()
        assert ap.prompt(TAG).render().text == "Version B", "the run stays on the version it pinned"
    ap.stop()


def test_needs_and_variables_inside_a_run_read_the_arm_render_uses(fx):
    a = fx.slot_of("A {{x}}", "ver_a", variables=[{"name": "x", "required": True, "trust": "operator"}])
    b = fx.slot_of("Version B", "ver_b")
    fx.plane.promote([a], experiments=[experiment(a, b)])
    ap = fx.start()
    for i in range(40):
        with ap.run(subject=f"user-{i}"):
            prompt = ap.prompt(TAG)
            needs = prompt.needs()
            assert [v["name"] for v in prompt.variables()] == (["x"] if needs else [])
            text = prompt.render({"x": "1"} if needs else {}).text
            assert text == ("A 1" if needs else "Version B"), "the arm needs() read is the arm render() used"
    ap.stop()


def test_the_open_run_cap_never_ends_a_run_inside_an_open_with_run(fx, monkeypatch):
    import airprompter_agent.runtime.run.registry as registry

    monkeypatch.setattr(registry, "MAX_OPEN_RUNS", 3)
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    busy = ap.open_run()
    with ap.with_run(busy):
        fx.advance(1)
        idle = ap.open_run()
        fx.advance(1)
        ap.open_run()
        fx.advance(1)
        ap.open_run()
        assert busy.is_ended is False, "the oldest is inside a scope: it is not the one to go"
        assert idle.is_ended is True
    ap.stop()


def test_a_direct_path_pin_writes_one_run_placed_log(fx):
    fx.plane.promote([fx.slot_of("Version A", "ver_a")])
    ap = fx.start()
    with ap.run():
        ap.prompt(TAG).render()
        ap.prompt(TAG).render()
    placed = [{key: event.get(key) for key in ("slot", "versionId", "artifactId", "arm")} for event in fx.named("run_placed")]
    assert placed == [{"slot": TAG, "versionId": "ver_a", "artifactId": f"art_{TAG}", "arm": "none"}]
    ap.stop()


def test_a_run_ref_entry_that_cannot_be_minted_is_left_out_alone(fx):
    fx.plane.promote(two_slots(fx))
    ap = fx.start()
    with ap.run() as run:
        run.place(OTHER)
        run.place(TAG)
        state = run._states[TAG]
        state.pin.entry = {**state.pin.entry, "runMinute": "not a minute"}
        run._minted = None
        assert [entry["tag"] for entry in ap.explain(run.run_ref)] == [OTHER]
    ap.stop()


def test_the_internal_lookup_finds_only_a_live_run_by_its_verified_reference_and_never_opens_extends_or_revives_one(fx):
    """AIR-2231, exception granted by the orchestrator: one read-only lookup in the registry, for adapters whose hooks run
    without the caller's context. The twin is runSession.test.ts › the internal lookup."""
    fx.plane.promote([fx.slot_of("Hello", "ver_1")])
    ap = fx.start()
    registry = ap._runs
    run = ap.open_run(subject="u1")
    run.place(TAG)
    ref = run.run_ref
    touched = run.last_active
    fx.advance(1_000)
    assert registry._find_live(ref) is run, "the live run its reference names"
    assert run.last_active == touched, "a lookup does not extend the run"
    opened = registry.open_runs
    for bad in (None, 42, "", "not.a.ref", ref[:-4] + "AAAA", ref + "x"):
        assert registry._find_live(bad) is None, bad
    run.end()
    assert registry._find_live(ref) is None, "an ended run is not revived"
    assert registry.open_runs == opened - 1, "nothing was opened"
    idle = ap.open_run(subject="u2")
    idle.place(TAG)
    idle_ref = idle.run_ref
    fx.advance(ap._runs._host.idle_timeout_ms + 1)
    assert registry._find_live(idle_ref) is None, "an idle-expired run is not found, though the sweep has not ended it yet"
    assert not idle.is_ended, "the lookup ends nothing either"
    from airprompter_agent.core import RunRefFacts, mint_run_ref
    # The same run id under another key, as another agent or process would sign it.
    foreign = mint_run_ref(RunRefFacts(SCOPE["agentId"], SCOPE["target"], run_id_of(ref), []), b"\x02" * 32)
    assert registry._find_live(foreign) is None, "a reference signed under another key names no run"
    assert "_find_run" not in dir(__import__("airprompter_agent")), "not on the package root"
    import airprompter_agent.frameworks.contract as contract
    assert "_find_run" not in contract.__all__ and not hasattr(ap, "find_run"), "internal: not on the contract's public list, not on ap"
