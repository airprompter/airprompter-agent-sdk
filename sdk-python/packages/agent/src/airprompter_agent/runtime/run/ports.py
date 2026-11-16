"""What a run needs from the facade. ``runtime.run`` decides; ``agent.py`` wires the active release, the lease, the
refusal stamp, the run reference key and the spool through these ports, because the runtime never imports the
telemetry or sync code. The recorder is held by the registry, not by a session, so a row can still be written after a
session ends. A port never takes the agent's own lock: a session calls it while holding its own.

Example::

    class Recorder:
        def record_run(self, totals, now_ms): spool.record_run(totals, now_ms)
        def record_step(self, totals, now_ms): spool.record_step(totals, now_ms)
        def count_passthrough(self, reason): counts[reason] = counts.get(reason, 0) + 1

    runs = RunRegistry(host, Recorder())
"""

from __future__ import annotations

from typing import Any, Mapping, Optional, Protocol, Sequence, Union

from airprompter_agent.core import RunRefFacts, RunTotals, StepTotals

from ..release.resolver import ReleaseResolver
from ..variables import VariableSourceRegistry


class RunRecorder(Protocol):
    def record_run(self, totals: RunTotals, now_ms: float) -> None: ...

    def record_step(self, totals: StepTotals, now_ms: float) -> None: ...

    def count_passthrough(self, reason: str) -> None:
        """``runCounters.passthrough`` on the heartbeat: an open map of reason to count."""
        ...


class RunHost(Protocol):
    variables: VariableSourceRegistry
    idle_timeout_ms: float

    def release(self) -> Union[ReleaseResolver, str]:
        """The resolver over the active release, or why there is none: ``no_verified_release`` or ``awaiting_unlock``."""
        ...

    def tags_for(self, overrides: Optional[Mapping[str, str]] = None) -> Mapping[str, str]:
        """The process tags merged with these. Raises on tags ``copy_audience_tags`` refuses; the session catches it."""
        ...

    def register_label(self, tag: str) -> None: ...

    def stamp_lease(self) -> None:
        """Stamps a lapsed lease. A lapsed lease never stops rendering."""
        ...

    def stamp_disabled(self, generation: int, tag: Optional[str]) -> None: ...

    def checks_for(self, tag: str, arm: str) -> Sequence[Mapping[str, Any]]:
        """The output checks the active release declares for a slot on an arm."""
        ...

    def mint_run_ref(self, run_id: str, entries: Sequence[Mapping[str, Any]]) -> str: ...

    def parse_run_ref(self, run_ref: str) -> Optional[RunRefFacts]:
        """The facts, or None when the reference does not verify."""
        ...

    def log(self, event: Mapping[str, Any]) -> None: ...

    def now(self) -> float: ...
