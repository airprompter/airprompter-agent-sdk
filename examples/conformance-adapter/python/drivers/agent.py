"""The agent driver (Python): the SDK's own run API with no framework, for the kinds about where a run lives, as
``conformance/frameworks/drivers/agent.mjs`` does for TypeScript.

- ``two-store``: a run on agent A; ``ap.feedback`` on agent B over another store sharing A's run-reference secret, on
  C after a rotation (the old secret among its previous ones), and on D with another secret (False). B, C and D hold
  no release: feedback reads the reference alone.
- ``split-invocation``: A renders the prompt; only the run reference crosses to B, which holds no release and reports
  the model step with ``ap.report_run``: one run row, on the version and arm the reference names.

Example::

    result = drive_run(ap=ap, fixture=fixture, clock=clock, host=host)
"""
from __future__ import annotations

from typing import Any

from drivers.program import run_input


def drive_run(*, ap: Any, fixture: dict, clock: Any, host: Any, **_: Any) -> dict:
    slot = fixture["agent"]["slot"]
    turn = fixture["recorded"]["turns"][0]
    usage = turn.get("usage") or {}
    latency = turn.get("latencyMs", 100)
    if fixture["kind"] == "two-store":
        with ap.run(run_input(fixture.get("input"))) as run:
            placed = run.place(slot)
            clock.ms += latency
            run.record_model_call(slot, model=placed.model if placed.kind == "approved" else "none", latency_ms=latency, usage={"input": usage.get("input", 0), "cachedInput": usage.get("cachedInput", 0), "output": usage.get("output", 0), "source": "reported"})
            run_ref = run.run_ref
        agent = fixture["agent"]
        shared = host.start_agent(release=False)
        rotated = host.start_agent(release=False, run_ref_secret=agent["rotatedSecret"], run_ref_previous_secrets=[agent["sharedSecret"]])
        stranger = host.start_agent(release=False, run_ref_secret=agent["otherSecret"])
        explained = shared.explain(run_ref)
        results = {
            "feedback": [shared.feedback(run_ref, {"thumbs": "up"}), rotated.feedback(run_ref, {"rating": 4}), stranger.feedback(run_ref, {"rating": 1})],
            "explained": [len(explained) if explained is not None else None, stranger.explain(run_ref)],
        }
        return {"calls": [], "runRefs": [run_ref], "results": results}
    if fixture["kind"] == "split-invocation":
        subject = (fixture.get("input") or {}).get("subject")
        rendered = ap.prompt(slot, **({"subject": subject} if subject else {})).render((fixture.get("input") or {}).get("variables") or {})
        clock.ms += latency
        reporter = host.start_agent(release=False)
        reported = reporter.report_run(rendered.run_ref, input_tokens=usage.get("input", 0), cached_input_tokens=usage.get("cachedInput", 0), output_tokens=usage.get("output", 0), latency_ms=latency)
        return {"calls": [], "runRefs": [rendered.run_ref], "results": {"reported": reported, "servedVersion": rendered.version_id, "servedArm": rendered.arm}}
    raise ValueError(f"the agent driver has no {fixture['kind']} case")
