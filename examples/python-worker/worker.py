"""A queue worker on the Python SDK: one resident runtime per process, the
approved `support.triage` prompt placed on the Anthropic call per ticket, with
the ticket text fenced as end-user input, the call measured into the run
(latency, usage, error class — never text), feedback filed later against the
run_ref.

Usage::

    pip install airprompter-agent[anthropic]
    AIRPROMPTER_ORG_ID=org_… AIRPROMPTER_AGENT_ID=agt_… AIRPROMPTER_AGENT_KEY=apa_… ANTHROPIC_API_KEY=… python worker.py

It pins AirPrompter's production root, whose root document the SDK reads from
https://api.airprompter.com/roots/prod/root.json by itself. Pinning another root (your own service, or the local
registry ``airprompter dev`` prints, or AirPrompter's dev deployment)? Set both ``AIRPROMPTER_ROOT_JWK`` to its key
and ``AIRPROMPTER_ROOT_URL`` to its root document: a syncing runtime with any other root and no root URL refuses to
start, so the worker refuses one without the other.
"""

from __future__ import annotations

import json
import os
import signal

import anthropic

from airprompter_agent import AirPrompterAgent
from airprompter_agent.frameworks.anthropic import instrument

# AirPrompter's production root key (ceremony of 2026-11-27, key id 044af6e8…1793), copied into source: the trust
# anchor. `sdk-python/tests/test_root_url_default.py` checks it equals the SDK's `HOSTED_ROOTS["prod"]`.
PRODUCTION_ROOT = {
    "kty": "EC",
    "crv": "P-256",
    "x": "hYhEFO-xyNoWyt5x0BgshEmNXPN1_mzDLISlT4nTDzE",
    "y": "OTbj5sdj8qKiIPzCsrdD297_vlNqahPTZWGgoa9cOtE",
}
ROOT_JWK = os.environ.get("AIRPROMPTER_ROOT_JWK")
ROOT_URL = os.environ.get("AIRPROMPTER_ROOT_URL")
if bool(ROOT_JWK) != bool(ROOT_URL):
    raise SystemExit("set AIRPROMPTER_ROOT_JWK and AIRPROMPTER_ROOT_URL together, or neither for AirPrompter's production root")

ap = AirPrompterAgent.start(
    organization_id=os.environ["AIRPROMPTER_ORG_ID"],
    agent_id=os.environ["AIRPROMPTER_AGENT_ID"],
    target="prod",
    api_key=os.environ.get("AIRPROMPTER_AGENT_KEY"),  # absent: serve the last verified release, never call home
    root={"pinned": json.loads(ROOT_JWK) if ROOT_JWK else PRODUCTION_ROOT},
    sync={"mode": "resident", "poll_seconds": 30, "root_url": ROOT_URL, "edge_pointer_url": os.environ.get("AIRPROMPTER_EDGE_POINTER_URL")},
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
