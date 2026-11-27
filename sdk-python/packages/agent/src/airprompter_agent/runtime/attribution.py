"""Which rendered prompt a direct provider call belongs to when the caller placed the text itself: the explicit scope
``with ap.attribute(rendered):`` sets (a ``contextvars`` variable, so it follows the call through threads started with a
copied context and through ``await``). A call outside any scope and with no slot is not observed: nothing here guesses
from request text.

Example::

    with attribution_scope(Attribution("support.reply", "ver_9", "none", "gpt-5")):
        client.chat.completions.create(...)   # current_attribution() inside is that Attribution
"""

from __future__ import annotations

import contextvars
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator, Mapping, Optional


@dataclass(frozen=True)
class Attribution:
    tag: str
    version_id: str
    arm: str
    model: str
    #: The slot's inference settings, applied to the wrapped call (``inference.py``).
    inference: Optional[Mapping[str, Any]] = None
    audience_ids: Optional[tuple[str,...]] = None
    run_minute: Optional[str] = None
    artifact_id: Optional[str] = None
    #: A workflow step's id. ``tag`` stays the slot's.
    step: Optional[str] = None


_scope: contextvars.ContextVar[Optional[Attribution]] = contextvars.ContextVar("airprompter_attribution", default=None)


def current_attribution() -> Optional[Attribution]:
    """The attribution an enclosing ``attribution_scope`` set, if any."""
    return _scope.get()


@contextmanager
def attribution_scope(attribution: Attribution) -> Iterator[None]:
    """Every wrapped call inside the block is attributed to ``attribution``."""
    token = _scope.set(attribution)
    try:
        yield
    finally:
        _scope.reset(token)


__all__ = ["Attribution", "attribution_scope", "current_attribution"]
