"""Canonical JSON per ``protocol/canonical-json.md``: the bytes under every digest and signature.

Two runtimes in two languages must produce the same bytes from the same
value, so nothing here is left to :mod:`json`'s defaults: members sort by
UTF-16 code units (not code points — astral keys sort *before* U+E000–U+FFFF),
strings escape exactly what ``JSON.stringify`` escapes, numbers are safe
integers only, and anything JSON cannot carry is refused rather than dropped.
"""

from __future__ import annotations

import hashlib
import math
from typing import Any

CanonicalJsonRefusal = str  # "undefined_value" | "non_integer_number" | "non_finite_number" | "unsafe_integer" | "unsupported_type" | "cycle"

MAX_SAFE_INTEGER = 2**53 - 1


class _Undefined:
    """The one value JSON has no spelling for. Python has no ``undefined``; this sentinel stands in so an encoder refuses it the way the TypeScript SDK refuses ``undefined`` (never silently dropped)."""

    __slots__ = ()

    def __repr__(self) -> str:
        return "UNDEFINED"


UNDEFINED = _Undefined()


class CanonicalJsonError(ValueError):
    def __init__(self, reason: CanonicalJsonRefusal, path: str):
        super().__init__(f"{reason} at {path}")
        self.reason = reason
        self.path = path


def _escape_string(text: str) -> str:
    out = ['"']
    for ch in text:
        code = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\f":
            out.append("\\f")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif code < 0x20 or 0xD800 <= code <= 0xDFFF:
            # C0 controls, and a lone surrogate (which UTF-8 cannot carry): escaped the way well-formed JSON.stringify does.
            out.append(f"\\u{code:04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _utf16_key(key: str) -> bytes:
    return key.encode("utf-16-be", "surrogatepass")


def _encode(value: Any, path: str, stack: set[int]) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is UNDEFINED:
        raise CanonicalJsonError("undefined_value", path)
    if isinstance(value, str):
        return _escape_string(value)
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise CanonicalJsonError("unsafe_integer", path)
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise CanonicalJsonError("non_finite_number", path)
        if value != int(value):
            raise CanonicalJsonError("non_integer_number", path)
        # JavaScript has one number type: 2.0 is the integer 2 there, so it is here.
        as_int = int(value)
        if abs(as_int) > MAX_SAFE_INTEGER:
            raise CanonicalJsonError("unsafe_integer", path)
        return str(as_int)
    if isinstance(value, (list, tuple)):
        marker = id(value)
        if marker in stack:
            raise CanonicalJsonError("cycle", path)
        stack.add(marker)
        try:
            parts = [_encode(item, f"{path}[{index}]", stack) for index, item in enumerate(value)]
        finally:
            stack.discard(marker)
        return "[" + ",".join(parts) + "]"
    if isinstance(value, dict):
        marker = id(value)
        if marker in stack:
            raise CanonicalJsonError("cycle", path)
        for key in value:
            if not isinstance(key, str):
                raise CanonicalJsonError("unsupported_type", f"{path}.{key!r}")
        stack.add(marker)
        try:
            parts = [f"{_escape_string(key)}:{_encode(value[key], f'{path}.{key}', stack)}" for key in sorted(value, key=_utf16_key)]
        finally:
            stack.discard(marker)
        return "{" + ",".join(parts) + "}"
    # datetimes, bytes, sets, Decimals, dataclasses, arbitrary objects: refused, never guessed at.
    raise CanonicalJsonError("unsupported_type", path)


def canonical_json(value: Any) -> str:
    return _encode(value, "$", set())


def canonical_bytes(value: Any) -> bytes:
    return canonical_json(value).encode("utf-8")


def sha256_prefixed(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()
