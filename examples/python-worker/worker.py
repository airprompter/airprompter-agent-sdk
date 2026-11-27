"""A queue worker on the Python SDK: one resident runtime per process, the
approved `support.triage` prompt placed on the Anthropic call per ticket, with
the ticket text fenced as end-user input, the call measured into the run
(latency, usage, error class — never text), feedback filed later against the
run_ref.

Usage::

    pip install airprompter-agent[anthropic]
    AIRPROMPTER_AGENT_KEY=apa_… AIRPROMPTER_ROOT_JWK='{"kty":"EC",…}' ANTHROPIC_API_KEY=… python worker.py
"""

from __future__ import annotations

import json
import os
import signal

import anthropic

from airprompter_agent import AirPrompterAgent
from airprompter_agent.frameworks.anthropic import instrument

ap = AirPrompterAgent.start(
    organization_id=os.environ["AIRPROMPTER_ORG_ID"],
    agent_id=os.environ["AIRPROMPTER_AGENT_ID"],
    target="prod",
    api_key=os.environ.get("AIRPROMPTER_AGENT_KEY"),  # absent: serve the last verified release, never call home
    root={"pinned": json.loads(os.environ["AIRPROMPTER_ROOT_JWK"])},
    sync={"mode": "resident", "poll_seconds": 30, "edge_pointer_url": os.environ.get("AIRPROMPTER_EDGE_POINTER_URL")},
    apply={"window": "02:00-04:00 Europe/Berlin"},  # releases staged under unlock_required go live on their own at night
    models=["claude-sonnet-5", "claude-haiku-4-5"],  # what this worker can call; promotion refuses a slot whose model is absent
)
# Every messages.create on this client gets the approved text as `system`, the release's model and its settings.
# The worker can call either model it declares, so whichever the release pins is the one sent.
client = instrument(anthropic.Anthropic(), ap, slot="support.triage", model_for=lambda release, _caller: release)
signal.signal(signal.SIGTERM, lambda *_: ap.stop())


def handle(ticket: dict) -> dict:
    """One queue message: returns the classification and the run_ref to keep beside the ticket."""
    with ap.run(subject=ticket["customer_id"], variables={"team": ticket["team"], "ticket": ticket["text"]}) as run:
        # A Freeze or a slot with nothing to serve is a passthrough: the worker's own model runs, and it says so.
        message = client.messages.create(model="claude-sonnet-5", max_tokens=256, messages=[{"role": "user", "content": ticket["text"]}])
        # What the call ran on: "approved" (the release's text and model), or "passthrough" (a Freeze, nothing promoted, a decline).
        served = run.place("support.triage").kind
        return {"classification": message.content[0].text, "run_ref": run.run_ref, "served": served}


def on_agent_accepted(run_ref: str, accepted: bool, minutes_to_accept: int) -> None:
    """Later, when a human touches the ticket: quality signals ride on the run's window, content-free."""
    ap.feedback(run_ref, accepted=accepted, timeToAcceptMs=minutes_to_accept * 60_000)
