// Reading "when does this usage limit reset" out of a failed turn's text. Providers say it in different ways:
// Claude's CLI ends with `|<epoch seconds>` or "resets 3pm (Europe/London)", API errors carry a Retry-After header
// or "try again in 2h 30m", and some messages hold an ISO timestamp. Returns null when nothing usable is found; the
// caller then falls back to a conservative backoff.

const MAX_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;
const UNIT_MS: Record<string, number> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
};

function plausible(at: number, now: number): number | null {
  return Number.isFinite(at) && at > now - 60_000 && at <= now + MAX_AHEAD_MS ? at : null;
}

function offsetMs(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant at which the wall clock in `zone` shows y-mo-d h:mm (mo is 0-based; two passes cover a DST edge). */
function zonedInstant(
  zone: string,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
): number {
  const guess = Date.UTC(y, mo, d, h, mi);
  const first = guess - offsetMs(guess, zone);
  return guess - offsetMs(first, zone);
}

/** The instant at which the wall clock in `zone` shows `hour:minute` on the zone's calendar day `dayShift` from `now`. */
function wallClockInstant(
  now: number,
  zone: string,
  hour: number,
  minute: number,
  dayShift: number,
): number {
  const zoned = new Date(now + offsetMs(now, zone));
  return zonedInstant(
    zone,
    zoned.getUTCFullYear(),
    zoned.getUTCMonth(),
    zoned.getUTCDate() + dayShift,
    hour,
    minute,
  );
}

function parseRelative(text: string, now: number): number | null {
  const match = /\b(?:in|after)\s+((?:\d+\s*[a-z]+[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (!match) return null;
  let total = 0;
  for (const part of match[1].matchAll(/(\d+)\s*(d|h|m|s)[a-z]*/gi)) {
    total += Number(part[1]) * (UNIT_MS[part[2].toLowerCase()] ?? 0);
  }
  return total > 0 ? now + total : null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Claude's CLI: "resets 12:50am (Australia/Brisbane)", and its weekly forms "resets Sep 29 at 8am (...)" and
// "resets Oct 3, 5pm (...)".
const CLOCK =
  /resets?(?:\s+at)?\s+(?:([A-Z][a-z]{2})\s+(\d{1,2})(?:,|\s+at)\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)\))?/i;

function parseClock(text: string, now: number, zoneDefault: string): number | null {
  const clock = CLOCK.exec(text);
  if (!clock || !(clock[5] || clock[4])) return null;
  const month = clock[1] ? MONTHS.indexOf(clock[1].toLowerCase()) : -1;
  if (clock[1] && month < 0) return null;
  let hour = Number(clock[3]);
  const minute = Number(clock[4] ?? "0");
  const meridiem = clock[5]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const zone = clock[6] ?? zoneDefault;
  try {
    if (month >= 0) {
      const year = new Date(now + offsetMs(now, zone)).getUTCFullYear();
      let at = zonedInstant(zone, year, month, Number(clock[2]), hour, minute);
      if (at <= now) at = zonedInstant(zone, year + 1, month, Number(clock[2]), hour, minute);
      return plausible(at, now);
    }
    let at = wallClockInstant(now, zone, hour, minute, 0);
    if (at <= now) at = wallClockInstant(now, zone, hour, minute, 1);
    return plausible(at, now);
  } catch {
    return null;
  }
}

// Codex: "Usage limit reached. Try again at Oct 4, 2026 5:42 PM." in the host's local time.
function parseTryAgainAt(text: string, now: number): number | null {
  const match = /Try again at ([A-Z][a-z]{2} \d{1,2}, \d{4},? \d{1,2}:\d{2} ?[AP]M)/.exec(text);
  if (!match) return null;
  const at = Date.parse(match[1].replace(",", "").replace(/(\d)([AP]M)$/, "$1 $2"));
  return plausible(at, now);
}

export function parseLimitReset(input: {
  text: string;
  now: number;
  retryAfterSeconds?: number | null;
  /** The host's own zone, used when the message names a clock time without one. */
  zone?: string;
}): number | null {
  const { text, now } = input;
  const zoneDefault = input.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (typeof input.retryAfterSeconds === "number" && input.retryAfterSeconds >= 0) {
    return plausible(now + input.retryAfterSeconds * 1000, now);
  }

  const epoch = /\|(\d{10})\b/.exec(text);
  if (epoch) return plausible(Number(epoch[1]) * 1000, now);

  const iso = /\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})/.exec(text);
  if (iso) return plausible(Date.parse(iso[0]), now);

  const header = /retry-after:?\s*(\d+)\b/i.exec(text);
  if (header) return plausible(now + Number(header[1]) * 1000, now);

  const relative = parseRelative(text, now);
  if (relative !== null) return plausible(relative, now);

  const tryAgain = parseTryAgainAt(text, now);
  if (tryAgain !== null) return tryAgain;

  return parseClock(text, now, zoneDefault);
}

/** Conservative wait when the provider gave no reset time: 15, then 30, then 60 minutes, capped at an hour. */
export function backoffMs(attempt: number): number {
  const minutes = [15, 30, 60][Math.min(Math.max(attempt, 0), 2)];
  return minutes * 60_000;
}
