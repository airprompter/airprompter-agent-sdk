"""Variable sources: values a prompt needs, filled from the customer's own system at render time.

A prompt author declares ``{{customer_tier}}`` in AirPrompter; the application that runs the prompt registers,
once, how to get a customer's tier from its own database. From then on every version that uses the variable is
filled without a change at the call site — and a version that does not use it never causes the lookup. This
module is the registry of those sources and the rules for one of them; ``fill.py`` applies them to a render.

Trust is the load-bearing rule: a callable source is text nobody in AirPrompter reviewed (a CRM notes field, a
CMS row another team writes), so registering one names its trust, and a render fences the value when EITHER the
prompt's declaration or the source says ``end_user``. A literal value is the application's own and defaults to
``operator``. Values never leave the host: nothing here is logged or reported but a variable's name.

A source is a plain callable (run on a worker thread, under its timeout) or a coroutine function (awaited by
``render_async``; the synchronous ``render()`` refuses it with ``VariableSourceRequiredError``).

Example::

    sources = VariableSourceRegistry()
    sources.provide("brand", "Acme")                                       # a literal: operator trust
    sources.provide("customer_tier", VariableSource(                       # a source: trust named, bounded
        resolve=lambda ctx: crm.tier_of(ctx.subject), trust="operator", timeout_seconds=0.5))
    sources.provide("last_ticket", {"resolve": tickets.latest_async, "trust": "end_user"})   # a coroutine function
    sources.names()                                                        # ["brand", "customer_tier", "last_ticket"]
"""

from __future__ import annotations

import inspect
import re
from dataclasses import dataclass
from typing import Any, Callable, Literal, Mapping, Optional, Union

Trust = Literal["operator", "end_user"]

DEFAULT_SOURCE_TIMEOUT_SECONDS = 2.0
DEFAULT_SOURCE_MAX_BYTES = 64 * 1024

_NAME = re.compile(r"^[a-zA-Z0-9_.-]{1,64}$")


@dataclass(frozen=True)
class VariableSourceContext:
    """What a source is told about the render that needs it. Never the prompt text, never other values."""

    #: The slot's tag (a workflow step's step id when a step is rendered).
    tag: str
    #: The variable being filled.
    name: str
    #: The subject the caller rendered for (sticky A/B assignment), when it gave one.
    subject: Optional[str]
    #: The prompt version and the experiment arm the render resolved to; None in managed mode, where the run route resolves them.
    version_id: Optional[str]
    arm: Optional[str]


@dataclass(frozen=True)
class VariableSource:
    """A callable source: how the application fills one variable from its own system.

    ``resolve`` returns the value, or None for "I have none" (a required variable then fails the render). It may be a
    plain callable or a coroutine function. ``trust`` is whose text this is: ``end_user`` fences the value in the
    prompt's delimiters whatever the prompt declared; ``operator`` inserts it raw — only when the prompt's own
    declaration is ``operator`` too. Required: a source with no stated trust is a source nobody thought about."""

    resolve: Callable[[VariableSourceContext], Any]
    trust: Trust
    #: How long one lookup may take before the render fails; 2 s unless told otherwise.
    timeout_seconds: Optional[float] = None
    #: The most bytes (UTF-8) a value may be; a runaway row fails the render instead of flooding the context. 64 KiB unless told otherwise.
    max_bytes: Optional[int] = None


#: What ``provide()`` accepts: a literal, a ``VariableSource``, or its fields as a mapping (``resolve``, ``trust``, ...).
VariableSourceInput = Union[str, VariableSource, Mapping[str, Any]]


@dataclass(frozen=True)
class RegisteredSource:
    """A registered entry, normalised: a literal keeps its text; a source keeps its bounds filled in."""

    kind: Literal["literal", "source"]
    trust: Trust
    value: Optional[str] = None
    source: Optional[VariableSource] = None
    timeout_seconds: float = DEFAULT_SOURCE_TIMEOUT_SECONDS
    max_bytes: int = DEFAULT_SOURCE_MAX_BYTES
    #: True when ``resolve`` is a coroutine function: only ``render_async`` can run it.
    awaitable: bool = False


class VariableSourceRequiredError(Exception):
    """A render needed a coroutine-function source but was called synchronously: use ``render_async()``.
    Identified by ``code`` (``variable_source_required``) and name, never ``isinstance`` (two copies of a package may be loaded)."""

    code = "variable_source_required"

    def __init__(self, tag: str, names: list[str], hint: str = "use render_async()"):
        verb = "come" if len(names) > 1 else "comes"
        super().__init__(f"render {tag}: {', '.join(names)} {verb} from a source that must be awaited — {hint}")
        self.tag = tag
        self.names = list(names)


_REASON_TEXT = {
    "threw": "threw",
    "timeout": "timed out",
    "empty": "returned nothing for a required variable",
    "too_large": "returned more than its byte bound",
    "not_text": "returned something other than text",
    "unfenceable": "is end_user trust but the slot declares operator, and a hosted run cannot fence it — declare the variable end_user in AirPrompter",
}

Reason = Literal["threw", "timeout", "empty", "too_large", "not_text", "unfenceable"]


class VariableSourceError(Exception):
    """A source threw, timed out, answered nothing for a required variable, answered more than its byte bound or not
    text — or cannot be fenced where it is going. ``code`` is ``variable_source``; ``reason`` says which."""

    code = "variable_source"

    def __init__(self, tag: str, variable: str, reason: Reason, cause: Optional[BaseException] = None):
        super().__init__(f"render {tag}: source for {variable} {_REASON_TEXT[reason]}")
        self.tag = tag
        self.variable = variable
        self.reason = reason
        if cause is not None:
            self.__cause__ = cause


class VariableSourceRegistry:
    """The application's sources by variable name. One registry per agent; the facade exposes it as ``ap.variables``.
    Names are keys, not scopes: a source that must answer differently for two prompts reads ``context.tag``.
    Safe to call from any thread: each entry is replaced whole, and a fill reads an entry once."""

    def __init__(self, initial: Optional[Mapping[str, VariableSourceInput]] = None):
        self._entries: dict[str, RegisteredSource] = {}
        for name, source in (initial or {}).items():
            self.provide(name, source)

    def provide(self, name: str, source: VariableSourceInput) -> None:
        """Register (or replace) how a variable is filled."""
        if not isinstance(name, str) or not _NAME.match(name):
            raise ValueError(f"variable source: {name!r} is not a variable name")
        if isinstance(source, str):
            self._entries[name] = RegisteredSource(kind="literal", trust="operator", value=source)
            return
        if isinstance(source, Mapping):
            unknown = sorted(set(source) - {"resolve", "trust", "timeout_seconds", "max_bytes"})
            if unknown:
                raise ValueError(f"variable source {name}: unknown field{'s' if len(unknown) > 1 else ''} {', '.join(unknown)}")
            source = VariableSource(resolve=source.get("resolve"), trust=source.get("trust"), timeout_seconds=source.get("timeout_seconds"), max_bytes=source.get("max_bytes"))  # type: ignore[arg-type]
        if not isinstance(source, VariableSource) or not callable(source.resolve):
            raise ValueError(f"variable source {name}: resolve must be callable")
        if source.trust not in ("operator", "end_user"):
            raise ValueError(f'variable source {name}: trust must be "operator" or "end_user"')
        timeout_seconds = DEFAULT_SOURCE_TIMEOUT_SECONDS if source.timeout_seconds is None else float(source.timeout_seconds)
        max_bytes = DEFAULT_SOURCE_MAX_BYTES if source.max_bytes is None else int(source.max_bytes)
        if not timeout_seconds > 0 or not max_bytes > 0:
            raise ValueError(f"variable source {name}: timeout_seconds and max_bytes must be positive")
        self._entries[name] = RegisteredSource(kind="source", trust=source.trust, source=source, timeout_seconds=timeout_seconds, max_bytes=max_bytes, awaitable=inspect.iscoroutinefunction(source.resolve))

    def revoke(self, name: str) -> bool:
        """Forget a source; renders that need the variable fail from now on unless the call site supplies it."""
        return self._entries.pop(name, None) is not None

    def get(self, name: str) -> Optional[RegisteredSource]:
        """The fill's view (the value or the callable itself); an application reads ``describe()``."""
        return self._entries.get(name)

    def has(self, name: str) -> bool:
        return name in self._entries

    def describe(self, name: str) -> Optional[dict[str, str]]:
        """What is registered under a name, without the value or the callable: fit to print."""
        entry = self._entries.get(name)
        return {"kind": entry.kind, "trust": entry.trust} if entry else None

    def names(self) -> list[str]:
        """The variable names this application can fill — content-free, fit for a log line or a heartbeat."""
        return sorted(self._entries)


def is_variable_source_error(error: Any) -> bool:
    """The check callers use in place of ``isinstance`` (an error may come from another copy of this package)."""
    return type(error).__name__ == "VariableSourceError" and getattr(error, "code", None) == "variable_source"


def is_variable_source_required_error(error: Any) -> bool:
    return type(error).__name__ == "VariableSourceRequiredError" and getattr(error, "code", None) == "variable_source_required"
