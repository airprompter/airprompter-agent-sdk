"""The run session: what one request is. See ``types.py`` for the shape an adapter sees, ``session.py`` for the rules,
and ``pin.py`` for what a reduction does to a pinned slot. Nothing here imports the telemetry or sync code: rows leave
through ``RunRecorder``.

Example::

    from airprompter_agent.runtime.run import RunRegistry, RunInput

    runs = RunRegistry(host, recorder)
    with runs.run(RunInput(subject=user_id)) as run:
        run.place("support.reply")
"""

from .pin import PinVerdict, pin_verdict
from .ports import RunHost, RunRecorder
from .registry import DEFAULT_RUN_IDLE_TIMEOUT_MS, MAX_OPEN_RUNS, Run, RunRegistry, RunScope
from .session import Session
from .types import UNAVAILABLE_REASONS, AgentRuntime, Approved, ModelResolver, Passthrough, Placement, RunInput, RunSession

__all__ = [
    "DEFAULT_RUN_IDLE_TIMEOUT_MS",
    "MAX_OPEN_RUNS",
    "UNAVAILABLE_REASONS",
    "AgentRuntime",
    "Approved",
    "ModelResolver",
    "Passthrough",
    "PinVerdict",
    "Placement",
    "Run",
    "RunHost",
    "RunInput",
    "RunRecorder",
    "RunRegistry",
    "RunScope",
    "RunSession",
    "Session",
    "pin_verdict",
]
