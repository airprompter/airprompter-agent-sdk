"""The open runs of one agent. ``open`` is get-or-create on a resume reference's run id, so a hook can always ask for
the run it belongs to. With no live run it opens a new one with the same id: a repeat resume then finds it, and the
subject hashes the same, so a resume after a sweep keeps its arm and counts as a new run. An idle sweep ends what no
hook will end, such as a model error a framework gives no hook for. A scope held by ``with_run`` keeps a run alive.
The registry holds the recorder, so rows can be written after a session ends.

The current run lives in a ``contextvars.ContextVar`` held per registry, so two agents in one process never see each
other's run. A thread does not inherit it: hand the run to a worker, or run the worker in ``contextvars.copy_context()``.

Example::

    runs = RunRegistry(host, recorder)
    with runs.run(RunInput(subject=user_id)) as run:   # or ``async with``; an exception ends it with its class
        runs.current() is run                         # True in here, across awaits
        runs.open(RunInput(resume=run.run_ref)) is run  # True while it is live
    runs.sweep()  # on a timer; ends runs idle past host.idle_timeout_ms
"""

from __future__ import annotations

import contextvars
import threading
from typing import Any, Callable, Mapping, Optional

from airprompter_agent.core import ReleaseSlot, new_run_id

from ..observe import classify_error
from .ports import RunHost, RunRecorder
from .session import Session
from .types import RunInput

DEFAULT_RUN_IDLE_TIMEOUT_MS = 15 * 60_000
#: Past this many open runs, the one idle longest ends by the idle rule.
MAX_OPEN_RUNS = 10_000
#: Names logged once per process, per kind.
MAX_NAMES_SAID = 64


class _Hooks:
    def __init__(self, registry: "RunRegistry", recorder: RunRecorder):
        self._registry = registry
        self.recorder = recorder

    def forget(self, session: Session) -> None:
        with self._registry._lock:
            if self._registry._live.get(session.run_id) is session:
                del self._registry._live[session.run_id]

    def first_time(self, kind: str, key: str) -> bool:
        with self._registry._lock:
            names = self._registry._said.setdefault(kind, set())
            if key in names or len(names) >= MAX_NAMES_SAID:
                return False
            names.add(key)
            return True


class RunScope:
    """``with_run``: the run is current inside the block, and the sweep skips it while the block is open. Sync or async."""

    def __init__(self, registry: "RunRegistry", session: Session):
        self._registry = registry
        self._session = session
        self._token: Optional[contextvars.Token] = None
        self._leave: Optional[Callable[[], None]] = None

    def _open(self) -> Session:
        self._leave = self._session.enter()
        self._token = self._registry._scope.set(self._session)
        return self._session

    def _close(self) -> None:
        if self._token is not None:
            self._registry._scope.reset(self._token)
            self._token = None
        if self._leave is not None:
            self._leave()
            self._leave = None

    def __enter__(self) -> Session:
        return self._open()

    def __exit__(self, *exc: Any) -> None:
        self._close()

    async def __aenter__(self) -> Session:
        return self._open()

    async def __aexit__(self, *exc: Any) -> None:
        self._close()


class Run:
    """``ap.run(...)``: one request as one run, as ``with`` or ``async with``. It opens on enter and ends on exit, with
    the class of an exception that leaves the block; the exception is never swallowed. A run parked inside stays open."""

    def __init__(self, registry: "RunRegistry", input: RunInput):
        self._registry = registry
        self._input = input
        self._scope: Optional[RunScope] = None

    def _open(self) -> Session:
        session = self._registry.open(self._input)
        self._scope = RunScope(self._registry, session)
        return self._scope._open()

    def _close(self, error: Optional[BaseException]) -> None:
        scope, self._scope = self._scope, None
        if scope is None:
            return
        scope._close()
        if error is None:
            scope._session.end()
        else:
            scope._session.end(error_class=classify_error(error))

    def __enter__(self) -> Session:
        return self._open()

    def __exit__(self, _type: Any, error: Optional[BaseException], _tb: Any) -> bool:
        self._close(error)
        return False

    async def __aenter__(self) -> Session:
        return self._open()

    async def __aexit__(self, _type: Any, error: Optional[BaseException], _tb: Any) -> bool:
        self._close(error)
        return False


class RunRegistry:
    def __init__(self, host: RunHost, recorder: RunRecorder):
        self._host = host
        self._lock = threading.Lock()
        self._live: dict[str, Session] = {}
        self._said: dict[str, set[str]] = {}
        self._scope: contextvars.ContextVar[Optional[Session]] = contextvars.ContextVar(f"airprompter_run_{id(self):x}", default=None)
        self._hooks = _Hooks(self, recorder)

    def open(self, input: Optional[RunInput] = None) -> Session:
        input = input or RunInput()
        self.sweep()
        run_id: Optional[str] = None
        if input.resume is not None:
            facts = self._host.parse_run_ref(input.resume) if isinstance(input.resume, str) else None
            run_id = facts.run_id if facts is not None else None
            if run_id is None:
                self._host.log({"event": "run_resume_refused"})
        while True:
            with self._lock:
                existing = self._live.get(run_id) if run_id is not None else None
                if existing is None:
                    oldest = self._oldest() if len(self._live) >= MAX_OPEN_RUNS else None
                    if oldest is None:
                        session = Session(run_id or new_run_id(), input, self._host, self._hooks)
                        self._live[session.run_id] = session
                        return session
            if existing is not None:
                existing.resumed(input)
                if not existing.is_ended:
                    return existing
                continue  # it ended under us: open its successor
            oldest.end_idle()

    def _find_live(self, run_ref: Any) -> Optional[Session]:
        """Internal (AIR-2231, the adapter contract only): the live run a verified reference names, or None. Lookup only:
        it never opens, extends, resumes or revives a run, and an unknown, ended, parked, idle-expired or badly signed
        reference answers None. The reference verifies only under this agent's own key, so it cannot name another agent's or
        another process's run: those are not in this registry."""
        if not isinstance(run_ref, str):
            return None
        facts = self._host.parse_run_ref(run_ref)
        if facts is None:
            return None
        with self._lock:
            session = self._live.get(facts.run_id)
        if session is None or session.is_ended or getattr(session, "_parked", False) or session.idle(self._host.now()):
            return None
        return session

    def current(self) -> Optional[Session]:
        """Only an open run of this registry: work a scope left running after ``end`` must not write to a run already counted."""
        session = self._scope.get()
        if session is None:
            return None
        with self._lock:
            return session if self._live.get(session.run_id) is session else None

    def with_run(self, run: Session) -> RunScope:
        return RunScope(self, run)

    def run(self, input: Optional[RunInput] = None) -> Run:
        return Run(self, input or RunInput())

    def take(self, observation: Any) -> bool:
        """The current run takes an observation of a slot it pinned; False sends it on as a one-call run."""
        run = self.current()
        return run.take(observation) if run is not None else False

    def render_failed(self, slot: str) -> bool:
        """A direct-path render failure inside the current run marks that slot's row; False writes the one-call error row."""
        run = self.current()
        return run.render_failed(slot) if run is not None else False

    def resolve_through(self, slot: str, subject: Optional[str], tags: Optional[Mapping[str, str]], resolve: Callable[[Optional[str], Optional[Mapping[str, str]]], ReleaseSlot], *, entry: bool) -> tuple[ReleaseSlot, Optional[Session]]:
        """The version the direct path serves inside the current run, pinned there; outside a run, ``resolve`` decides alone."""
        run = self.current()
        if run is None:
            return resolve(subject, tags), None
        if tags:
            run.set_tags(tags)
        return run.resolve_through(slot, lambda run_subject, run_tags: resolve(run_subject, run_tags), entry=entry), run

    def sweep(self) -> None:
        now_ms = self._host.now()
        with self._lock:
            sessions = list(self._live.values())
        for session in sessions:
            if session.idle(now_ms):
                session.end_idle()

    def end_all(self) -> None:
        with self._lock:
            sessions = list(self._live.values())
        for session in sessions:
            session.end_idle()

    @property
    def open_runs(self) -> int:
        with self._lock:
            return len(self._live)

    def _oldest(self) -> Optional[Session]:
        """The session idle longest outside any ``with_run`` scope; the oldest overall only when every one is scoped."""
        eligible = [session for session in self._live.values() if not session.scoped]
        return min(eligible or self._live.values(), key=lambda session: session.last_active, default=None)
