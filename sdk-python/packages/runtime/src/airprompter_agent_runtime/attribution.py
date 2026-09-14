"""Which rendered prompt a provider call belongs to (T33, D65). A wrapped
client sees only the call's parameters; three things can name the slot:

1. an explicit scope — ``with ap.attribute(rendered): client.chat.completions.create(...)``
   (a ``contextvars`` variable, so it follows the call through threads
   started with a copied context and through ``await``);
2. the rendered text itself — every ``render()`` registers the SHA-256 of
   its text; a request whose system / instructions / message text is
   exactly one of the last renders is that render's call;
3. nothing — the call is passed through untouched and never guessed at.

Content is read here only to be hashed: the registry keeps hashes and
dimension names, never a prompt.
"""

from __future__ import annotations

import base64
import contextvars
import hashlib
import threading
from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterable, Iterator, Mapping, Optional


@dataclass(frozen=True)
class Attribution:
    tag: str
    version_id: str
    arm: str
    model: str


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


def hash_text(text: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(text.encode("utf-8")).digest()).rstrip(b"=").decode("ascii")


class RenderRegistry:
    """The last ``capacity`` renders by text hash; the newest wins a collision. Thread-safe."""

    def __init__(self, capacity: int = 256):
        self._capacity = capacity
        self._entries: "OrderedDict[str, Attribution]" = OrderedDict()
        self._lock = threading.Lock()

    def register(self, text: str, attribution: Attribution) -> None:
        key = hash_text(text)
        with self._lock:
            self._entries.pop(key, None)
            self._entries[key] = attribution
            while len(self._entries) > self._capacity:
                self._entries.popitem(last=False)

    def match(self, texts: Iterable[str]) -> Optional[Attribution]:
        """The first text that is a registered render, in the order given."""
        with self._lock:
            for text in texts:
                hit = self._entries.get(hash_text(text))
                if hit is not None:
                    return hit
        return None

    def __len__(self) -> int:
        return len(self._entries)


_REQUEST_TEXT_FIELDS = ("system", "instructions", "messages", "input", "prompt")


def _get(value: Any, name: str) -> Any:
    if isinstance(value, Mapping):
        return value.get(name)
    if isinstance(value, (str, bytes, int, float, bool)) or value is None:
        return None
    try:
        return getattr(value, name, None)
    except Exception:  # noqa: BLE001
        return None


def request_texts(params: Any) -> list[str]:
    """Every string a request carries where a rendered prompt could be, most likely first: ``system`` / ``instructions``
    (Anthropic, Responses), then the messages (``messages``, Responses ``input``, AI SDK ``prompt``) in order — a
    string, or the ``text`` of content parts; dicts or SDK param objects. Never raises on an odd shape."""
    out: list[str] = []

    def collect(value: Any, depth: int) -> None:
        if depth > 4 or value is None:
            return
        if isinstance(value, str):
            if value:
                out.append(value)
            return
        if isinstance(value, (bytes, int, float, bool)):
            return
        if isinstance(value, (list, tuple)):
            for item in value:
                collect(item, depth + 1)
            return
        content = _get(value, "content")
        if content is not None:
            collect(content, depth + 1)
            return
        text = _get(value, "text")
        if isinstance(text, str):
            collect(text, depth + 1)

    if params is None:
        return out
    for field in _REQUEST_TEXT_FIELDS:
        try:
            collect(_get(params, field), 0)
        except Exception:  # noqa: BLE001
            continue
    return out


__all__ = ["Attribution", "RenderRegistry", "attribution_scope", "current_attribution", "hash_text", "request_texts"]
