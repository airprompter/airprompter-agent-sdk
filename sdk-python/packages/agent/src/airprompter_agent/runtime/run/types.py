"""The run: one user request to an agent, from its first model call to its last, across tools, steps, sub-agents and
several prompts. One run holds one version per slot, chosen at that slot's first ``place``, and one run reference that
grows an entry per slot. An adapter sees only these types; it never renders, assigns, reads a manifest or writes a row.

``place`` is synchronous and ``place_async`` awaits: a sync hook runs sync variable sources only, as ``render()`` does,
and a coroutine source there answers ``passthrough variables_unfilled``.

Example::

    with ap.run(subject=user_id) as run:
        placed = run.place("support.reply")
        if placed.kind != "approved":
            return call_model(own_prompt, own_model)  # the framework's own prompt runs; a kind a later minor adds is handled too
        reply = call_model(placed.instructions, placed.model)
        run.record_model_call("support.reply", model=placed.model, latency_ms=300, usage=normalize_usage(reply))
    # one run row per slot the run pinned, ``agentRun`` 1 on the first only
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, ContextManager, Mapping, Optional, Protocol, TypeVar, Union

#: Why a slot passes through: the framework's own prompt and model run unchanged.
UNAVAILABLE_REASONS = ("no_verified_release", "awaiting_unlock", "slot_disabled", "no_slot", "slot_kind_unsupported", "model_unresolved", "variables_unfilled")

TModel = TypeVar("TModel")


@dataclass(frozen=True)
class RunInput:
    subject: Optional[str] = None
    conversation_id: Optional[str] = None
    #: Values never leave the process.
    tags: Optional[Mapping[str, str]] = None
    variables: Optional[Mapping[str, Any]] = None
    #: A run reference. ``open_run`` is get-or-create on its run id: a live run comes back, and with none a new run opens with that id.
    resume: Optional[str] = None


@dataclass(frozen=True)
class Approved:
    slot: str
    instructions: str
    model: str
    #: The sealed inference block, as the version declared it.
    settings: Mapping[str, Any]
    kind: str = field(default="approved", init=False)


@dataclass(frozen=True)
class Passthrough:
    slot: str
    reason: str  # one of UNAVAILABLE_REASONS
    kind: str = field(default="passthrough", init=False)


Placement = Union[Approved, Passthrough]


class RunSession(Protocol):
    """What one request is. Every method is safe from any thread."""

    @property
    def run_ref(self) -> str:
        """Re-minted when a new slot pins: re-read it, never cache it. It carries the run id from the start."""
        ...

    def set_tags(self, tags: Mapping[str, str]) -> None: ...

    def slot_for(self, slots: Union[str, Mapping[str, str]], name: Optional[str] = None) -> Optional[str]: ...

    def place(self, slot: str) -> Placement:
        """Never raises for unavailability: it answers a passthrough."""
        ...

    async def place_async(self, slot: str) -> Placement: ...

    def decline(self, slot: str, reason: str = "model_unresolved") -> Placement: ...

    def record_model_call(self, slot: str, *, model: str, latency_ms: float, step: Optional[str] = None, usage: Any = None, error_class: Optional[str] = None, output_text: Optional[str] = None) -> None: ...

    def record_tool_call(self, slot: str, *, ok: bool, step: Optional[str] = None) -> None: ...

    def end(self, error_class: Optional[str] = None, interrupted: bool = False) -> None:
        """Idempotent. ``interrupted=True`` parks the run until a resume or the idle sweep ends it."""
        ...


class AgentRuntime(Protocol):
    def open_run(self, input: Optional[RunInput] = None, /, **fields: Any) -> RunSession: ...

    def current_run(self) -> Optional[RunSession]: ...

    def with_run(self, run: RunSession) -> ContextManager[RunSession]: ...

    def log(self, event: Mapping[str, Any]) -> None: ...


#: Maps a release's model id onto the framework's model object, or returns the id for the adapter to build.
ModelResolver = Callable[[str, TModel], Union[TModel, str]]
