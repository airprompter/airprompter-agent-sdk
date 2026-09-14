/**
 * The update window (T9, D33): the daily wall-clock range, in an IANA zone,
 * inside which a release staged under `unlock_required` activates on its
 * own. Configured locally as `apply.window: "02:00-04:00 Europe/Berlin"`
 * (optionally `"… mon,tue,fri"`) or as an object; the manifest may carry the
 * console's window too, and the LOCAL one wins when both exist — the local
 * side is never looser than what it has been configured to do.
 *
 * DST is the zone's business: every instant is read back through `Intl`,
 * so a window across a fall-back night lasts the zone's extra hour and a
 * time that never happens on a spring-forward night lands where the
 * zone's clock is when that minute would have been. A window whose end
 * precedes its start runs past midnight and belongs to the day it starts on.
 */

export type WindowDay = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface UpdateWindow {
  timezone: string;
  /** "HH:MM", 24-hour. */
  start: string;
  end: string;
  /** Days the window OPENS on, in the zone; absent = every day. */
  days?: WindowDay[];
}

export interface WindowState {
  open: boolean;
  /** The current opening's start while open; the next opening's start otherwise. */
  opensAtMs: number;
  closesAtMs: number;
}

const DAYS: WindowDay[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** `"02:00-04:00 Europe/Berlin"` or `"22:00-04:00 America/New_York sat,sun"`; throws on a shape it cannot read. */
export function parseWindow(input: string | UpdateWindow): UpdateWindow {
  if (typeof input !== "string") return validateWindow(input);
  const parts = input.trim().split(/\s+/);
  const range = parts[0] ?? "";
  const timezone = parts[1] ?? "";
  const days = parts[2] ? parts[2].split(",").map((d) => d.trim().toLowerCase()) : undefined;
  const match = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(range);
  if (!match || !timezone) throw new Error(`apply.window: expected "HH:MM-HH:MM <IANA zone> [days]", got "${input}"`);
  return validateWindow({ timezone, start: match[1]!, end: match[2]!, ...(days ? { days: days as WindowDay[] } : {}) });
}

export function validateWindow(window: UpdateWindow): UpdateWindow {
  if (!TIME.test(window.start) || !TIME.test(window.end)) throw new Error("apply.window: times are HH:MM, 24-hour");
  if (window.start === window.end) throw new Error("apply.window: a window has a length");
  if (window.days) {
    for (const day of window.days) if (!DAYS.includes(day)) throw new Error(`apply.window: unknown day "${day}"`);
    if (window.days.length === 0) throw new Error("apply.window: days cannot be empty");
  }
  if (!isKnownTimeZone(window.timezone)) throw new Error(`apply.window: unknown time zone "${window.timezone}"`);
  return window;
}

export function isKnownTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

type WallClock = { year: number; month: number; day: number; hour: number; minute: number; weekday: WindowDay };
const WEEKDAY: Record<string, WindowDay> = { Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun" };

function wallClock(ms: number, timezone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), hour: Number(get("hour")) % 24, minute: Number(get("minute")), weekday: WEEKDAY[get("weekday")] ?? "mon" };
}

/** The earliest instant whose wall clock in the zone reads as asked; a time in a DST gap lands after the jump. */
function zonedToUtc(local: { year: number; month: number; day: number; hour: number; minute: number }, timezone: string): number {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const offsetAt = (ms: number) => {
    const wall = wallClock(ms, timezone);
    return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - ms;
  };
  const offsets = [...new Set([offsetAt(guess - 86_400_000), offsetAt(guess), offsetAt(guess + 86_400_000)])];
  const matches = offsets
    .map((offset) => guess - offset)
    .filter((candidate) => {
      const wall = wallClock(candidate, timezone);
      return wall.year === local.year && wall.month === local.month && wall.day === local.day && wall.hour === local.hour && wall.minute === local.minute;
    })
    .sort((a, b) => a - b);
  return matches.length > 0 ? matches[0]! : guess - Math.max(...offsets);
}

const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function windowState(window: UpdateWindow, nowMs: number): WindowState {
  const start = minutesOf(window.start);
  const end = minutesOf(window.end);
  const wraps = end <= start;
  const today = wallClock(nowMs, window.timezone);
  const openings: Array<{ opensAtMs: number; closesAtMs: number }> = [];
  for (let offset = -1; offset <= 8; offset += 1) {
    const dayMs = zonedToUtc({ year: today.year, month: today.month, day: today.day, hour: 12, minute: 0 }, window.timezone) + offset * 86_400_000;
    const date = wallClock(dayMs, window.timezone);
    if (window.days && !window.days.includes(date.weekday)) continue;
    const opensAtMs = zonedToUtc({ year: date.year, month: date.month, day: date.day, hour: Math.floor(start / 60), minute: start % 60 }, window.timezone);
    const closeDate = new Date(Date.UTC(date.year, date.month - 1, date.day + (wraps ? 1 : 0)));
    const closesAtMs = zonedToUtc({ year: closeDate.getUTCFullYear(), month: closeDate.getUTCMonth() + 1, day: closeDate.getUTCDate(), hour: Math.floor(end / 60), minute: end % 60 }, window.timezone);
    openings.push({ opensAtMs, closesAtMs });
  }
  for (const opening of openings) if (opening.opensAtMs <= nowMs && nowMs < opening.closesAtMs) return { open: true, ...opening };
  const next = openings.find((opening) => opening.opensAtMs > nowMs) ?? openings[openings.length - 1]!;
  return { open: false, ...next };
}
