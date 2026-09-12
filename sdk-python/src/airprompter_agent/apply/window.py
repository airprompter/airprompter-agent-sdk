"""The update window (T9, D33): the daily wall-clock range, in an IANA zone,
inside which a release staged under ``unlock_required`` activates on its
own. Configured locally as ``apply.window: "02:00-04:00 Europe/Berlin"``
(optionally ``"… mon,tue,fri"``) or as a dict; the manifest may carry the
console's window too, and the LOCAL one wins when both exist — the local
side is never looser than what it has been configured to do.

DST is the zone's business: every instant is read back through
:mod:`zoneinfo`, so a window across a fall-back night lasts the zone's
extra hour and a time that never happens on a spring-forward night lands
where the zone's clock is when that minute would have been. A window whose
end precedes its start runs past midnight and belongs to the day it starts on.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass
from typing import Any, Mapping, Optional, Union
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_TIME = re.compile(r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
_RANGE = re.compile(r"^(\d{2}:\d{2})-(\d{2}:\d{2})$")
_DAY_MS = 86_400_000


@dataclass(frozen=True)
class UpdateWindow:
    timezone: str
    start: str  # "HH:MM", 24-hour
    end: str
    days: Optional[tuple[str, ...]] = None  # days the window OPENS on, in the zone; None = every day

    def to_wire(self) -> dict[str, Any]:
        wire: dict[str, Any] = {"timezone": self.timezone, "start": self.start, "end": self.end}
        if self.days:
            wire["days"] = list(self.days)
        return wire


@dataclass(frozen=True)
class WindowState:
    open: bool
    #: The current opening's start while open; the next opening's start otherwise.
    opens_at_ms: int
    closes_at_ms: int


def is_known_time_zone(timezone: str) -> bool:
    try:
        ZoneInfo(timezone)
        return True
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        return False


def validate_window(window: UpdateWindow) -> UpdateWindow:
    if not _TIME.match(window.start) or not _TIME.match(window.end):
        raise ValueError("apply.window: times are HH:MM, 24-hour")
    if window.start == window.end:
        raise ValueError("apply.window: a window has a length")
    if window.days is not None:
        for day in window.days:
            if day not in DAYS:
                raise ValueError(f'apply.window: unknown day "{day}"')
        if len(window.days) == 0:
            raise ValueError("apply.window: days cannot be empty")
    if not is_known_time_zone(window.timezone):
        raise ValueError(f'apply.window: unknown time zone "{window.timezone}"')
    return window


def parse_window(value: Union[str, Mapping[str, Any], UpdateWindow]) -> UpdateWindow:
    """``"02:00-04:00 Europe/Berlin"`` or ``"22:00-04:00 America/New_York sat,sun"``; raises on a shape it cannot read."""
    if isinstance(value, UpdateWindow):
        return validate_window(value)
    if isinstance(value, Mapping):
        days = value.get("days")
        return validate_window(UpdateWindow(str(value.get("timezone", "")), str(value.get("start", "")), str(value.get("end", "")), tuple(str(d) for d in days) if days is not None else None))
    parts = value.strip().split()
    range_text = parts[0] if parts else ""
    timezone = parts[1] if len(parts) > 1 else ""
    days = tuple(d.strip().lower() for d in parts[2].split(",")) if len(parts) > 2 else None
    match = _RANGE.match(range_text)
    if not match or not timezone:
        raise ValueError(f'apply.window: expected "HH:MM-HH:MM <IANA zone> [days]", got "{value}"')
    return validate_window(UpdateWindow(timezone, match.group(1), match.group(2), days))


def _wall_clock(ms: int, zone: ZoneInfo) -> dt.datetime:
    return dt.datetime.fromtimestamp(ms / 1000, tz=dt.timezone.utc).astimezone(zone)


def _zoned_to_utc_ms(year: int, month: int, day: int, hour: int, minute: int, zone: ZoneInfo) -> int:
    """The earliest instant whose wall clock in the zone reads as asked; a time in a DST gap lands after the jump."""
    guess = int(dt.datetime(year, month, day, hour, minute, tzinfo=dt.timezone.utc).timestamp() * 1000)

    def offset_at(ms: int) -> int:
        wall = _wall_clock(ms, zone)
        return int(dt.datetime(wall.year, wall.month, wall.day, wall.hour, wall.minute, tzinfo=dt.timezone.utc).timestamp() * 1000) - ms

    offsets = sorted({offset_at(guess - _DAY_MS), offset_at(guess), offset_at(guess + _DAY_MS)})
    matches = []
    for offset in offsets:
        candidate = guess - offset
        wall = _wall_clock(candidate, zone)
        if (wall.year, wall.month, wall.day, wall.hour, wall.minute) == (year, month, day, hour, minute):
            matches.append(candidate)
    return min(matches) if matches else guess - max(offsets)


def _minutes_of(hhmm: str) -> int:
    return int(hhmm[:2]) * 60 + int(hhmm[3:5])


def window_state(window: UpdateWindow, now_ms_: float) -> WindowState:
    zone = ZoneInfo(window.timezone)
    now = int(now_ms_)
    start = _minutes_of(window.start)
    end = _minutes_of(window.end)
    wraps = end <= start
    today = _wall_clock(now, zone)
    openings: list[tuple[int, int]] = []
    for offset in range(-1, 9):
        day_ms = _zoned_to_utc_ms(today.year, today.month, today.day, 12, 0, zone) + offset * _DAY_MS
        date = _wall_clock(day_ms, zone)
        if window.days and DAYS[date.weekday()] not in window.days:
            continue
        opens_at = _zoned_to_utc_ms(date.year, date.month, date.day, start // 60, start % 60, zone)
        close_date = dt.date(date.year, date.month, date.day) + dt.timedelta(days=1 if wraps else 0)
        closes_at = _zoned_to_utc_ms(close_date.year, close_date.month, close_date.day, end // 60, end % 60, zone)
        openings.append((opens_at, closes_at))
    for opens_at, closes_at in openings:
        if opens_at <= now < closes_at:
            return WindowState(True, opens_at, closes_at)
    upcoming = next(((o, c) for o, c in openings if o > now), openings[-1])
    return WindowState(False, upcoming[0], upcoming[1])
