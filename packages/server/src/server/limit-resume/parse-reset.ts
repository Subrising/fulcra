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

/** The instant at which the wall clock in `zone` shows `hour:minute` on the zone's calendar day `dayShift` from `now`. */
function wallClockInstant(
  now: number,
  zone: string,
  hour: number,
  minute: number,
  dayShift: number,
): number {
  const zoned = new Date(now + offsetMs(now, zone));
  const guess = Date.UTC(
    zoned.getUTCFullYear(),
    zoned.getUTCMonth(),
    zoned.getUTCDate() + dayShift,
    hour,
    minute,
  );
  let instant = guess - offsetMs(guess, zone);
  instant = guess - offsetMs(instant, zone);
  return instant;
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

function parseClock(text: string, now: number, zoneDefault: string): number | null {
  const clock =
    /resets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\))?/i.exec(
      text,
    );
  if (clock && (clock[3] || clock[2])) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] ?? "0");
    const meridiem = clock[3]?.toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return null;
    const zone = clock[4] ?? zoneDefault;
    try {
      let at = wallClockInstant(now, zone, hour, minute, 0);
      if (at <= now) at = wallClockInstant(now, zone, hour, minute, 1);
      return plausible(at, now);
    } catch {
      return null;
    }
  }
  return null;
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

  return parseClock(text, now, zoneDefault);
}

/** Conservative wait when the provider gave no reset time: 15, then 30, then 60 minutes, capped at an hour. */
export function backoffMs(attempt: number): number {
  const minutes = [15, 30, 60][Math.min(Math.max(attempt, 0), 2)];
  return minutes * 60_000;
}
