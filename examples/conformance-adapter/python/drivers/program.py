"""The developer's program a direct-client fixture describes, as ``conformance/frameworks/drivers/program.mjs`` runs it
for TypeScript: inside ``ap.run(...)`` (or with no run), each step calls a client until the model stops asking for
tools, running the tools itself in between. The framework driver supplies the one call.

Example::

    refs = run_program(ap, fixture, lambda step, history, run: chat_turn(clients[step.get("client", 0)], step, history))
"""
from __future__ import annotations

from typing import Any, Callable, Optional

from airprompter_agent import RunInput

MAX_TURNS_PER_STEP = 12


def run_input(fields: Optional[dict]) -> RunInput:
    fields = fields or {}
    return RunInput(subject=fields.get("subject"), conversation_id=fields.get("conversationId"), tags=fields.get("tags"), variables=fields.get("variables"))


def run_program(ap: Any, fixture: dict, call: Callable[[dict, list, Any], list], *, scope: Optional[str] = None) -> list:
    """Runs every step; answers the run references read after each step (the latest value, read late)."""
    refs: list = []
    agent = fixture["agent"]

    def body(run: Any) -> None:
        for step in agent["steps"]:
            history: list = []
            for _ in range(MAX_TURNS_PER_STEP):
                if not call(step, history, run):
                    break
            if step.get("setTags") and run is not None:
                run.set_tags(step["setTags"])
            if run is not None:
                refs.append(run.run_ref)

    if (scope or agent.get("scope") or "run") == "run":
        with ap.run(run_input(fixture.get("input"))) as run:
            body(run)
    else:
        body(None)
    return refs


def model_for_of(mapping: Optional[dict]) -> Optional[Callable[..., Optional[str]]]:
    """``model_for`` from a fixture's map: the release's id to the id this client sends; ``None`` (or a missing id) declines."""
    if mapping is None:
        return None
    return lambda release_model_id, *_: mapping.get(release_model_id)


def seen_with_baseline(provider: Any, baseline: Any) -> list:
    """What the provider saw, with ``untouched`` when the bare client's run of the same program sent the same bytes."""
    seen = provider.seen()
    if baseline is None:
        return seen
    return [{**call, "untouched": i < len(baseline.calls) and baseline.calls[i]["request"] == provider.calls[i]["request"]} for i, call in enumerate(seen)]


def feedback_of(ap: Any, fixture: dict, refs: list) -> Optional[dict]:
    """``agent.feedback``: signals filed on the run's last reference after the program, as an application's thumbs-up does."""
    signals = fixture["agent"].get("feedback")
    return {"feedback": ap.feedback(refs[-1], signals)} if signals and refs else None
