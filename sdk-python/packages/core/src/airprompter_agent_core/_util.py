"""Small shared helpers: base64url without padding, RFC 3339 instants, ISO formatting the way the protocol writes it.

Example::

    instant("2026-09-12T14:03:10.123Z")   # 1789221790123 — epoch milliseconds; an offset is honoured
    iso_ms(1_789_221_790_123)             # "2026-09-12T14:03:10.123Z"
    b64url_encode(bytes([0, 255]))        # "AP8" — no padding, URL-safe
    random_id("i-")                       # "i-YwN9yAmSX4YlvxN4": an instance id
"""

from __future__ import annotations

import base64
import datetime as dt
import os
import re
import time
from typing import Union

Number = Union[int, float]

_RFC3339 = re.compile(r"^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$")


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def b64url_decode(text: str) -> bytes:
    padded = text + "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(padded)


def now_ms() -> int:
    return int(time.time() * 1000)


def instant(text: str) -> int:
    """An RFC 3339 timestamp as epoch milliseconds. Timestamps compare as instants, never as strings."""
    match = _RFC3339.match(text.strip())
    if not match:
        raise ValueError(f"not an RFC 3339 timestamp: {text}")
    year, month, day, hour, minute, second = (int(match.group(i)) for i in range(1, 7))
    fraction = match.group(7) or ""
    millis = int((fraction + "000")[:3]) if fraction else 0
    base = dt.datetime(year, month, day, hour, minute, second, tzinfo=dt.timezone.utc)
    epoch = int(base.timestamp()) * 1000 + millis
    if match.group(8):
        sign = 1 if match.group(8) == "+" else -1
        offset = sign * (int(match.group(9)) * 3600 + int(match.group(10)) * 60) * 1000
        epoch -= offset
    return epoch


def iso_ms(epoch_ms: Number) -> str:
    """``2026-09-12T14:03:10.123Z`` — what ``Date#toISOString`` writes."""
    seconds, millis = divmod(int(epoch_ms), 1000)
    base = dt.datetime.fromtimestamp(seconds, tz=dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    return f"{base}.{millis:03d}Z"


def iso_seconds(epoch_ms: Number) -> str:
    """``2026-09-12T14:03:10Z`` — the spool's second-precision stamps."""
    return dt.datetime.fromtimestamp(int(epoch_ms) // 1000, tz=dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def random_id(prefix: str = "i-", nbytes: int = 12) -> str:
    return prefix + b64url_encode(os.urandom(nbytes))


def fsync_path(path: str) -> None:
    fd = os.open(path, os.O_RDWR)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def fsync_dir(path: str) -> None:
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return  # Directory fsync is best effort on platforms that refuse it.
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)
