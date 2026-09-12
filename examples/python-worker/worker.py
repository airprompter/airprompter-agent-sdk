"""A queue worker on the Python SDK: one resident runtime per process, the
approved `support.triage` prompt rendered per ticket with the ticket text
fenced as end-user input, the Anthropic call observed (latency, usage,
error class — never text), feedback filed later against the run_ref.

    pip install airprompter-agent[anthropic]
    AIRPROMPTER_AGENT_KEY=apa_… AIRPROMPTER_ROOT_JWK='{"kty":"EC",…}' ANTHROPIC_API_KEY=… python worker.py
"""

from __future__ import annotations

import json
import os
import signal

import anthropic

from airprompter_agent import AirPrompterAgent, RenderRefusedError
from airprompter_agent.integrations.anthropic import messages_create

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
client = anthropic.Anthropic()
signal.signal(signal.SIGTERM, lambda *_: ap.stop())


def handle(ticket: dict) -> dict:
    """One queue message: returns the classification and the run_ref to keep beside the ticket."""
    try:
        rendered = ap.prompt("support.triage", subject=ticket["customer_id"]).render(team=ticket["team"], ticket=ticket["text"])
    except RenderRefusedError as refused:
        # A Freeze from the console, or a lapsed lease on a halt target: the worker parks the message and says why.
        return {"parked": refused.reason}
    message = messages_create(ap, rendered, client, messages=[{"role": "user", "content": ticket["text"]}], max_tokens=256)
    return {"classification": message.content[0].text, "run_ref": rendered.run_ref, "version": rendered.version_id, "arm": rendered.arm}


def on_agent_accepted(run_ref: str, accepted: bool, minutes_to_accept: int) -> None:
    """Later, when a human touches the ticket: quality signals ride on the run's window, content-free."""
    ap.feedback(run_ref, accepted=accepted, timeToAcceptMs=minutes_to_accept * 60_000)
