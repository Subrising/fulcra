// Pure: the Claude CLI usage-limit line -> { kind, reset, zone, resetAt }. No imports, so the Command Centre plugin
// (fulcra ask) and the controller (usage-limits.mjs) both bundle it. Moved from usage-limits.mjs unchanged (0.2.16.2).
export const MAX_RESET_AHEAD_MS = 8 * 86400000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// The CLI's limit line, whole. "You've hit your session limit · resets 12:50am (Australia/Brisbane)" and its weekly
// form with a date: the CLI writes "resets Sep 29 at 8am (...)" (H7: the real weekly line of 26 Sep, which the H6 grammar
// missed) and "resets Oct 3, 5pm (...)" is accepted too; the legacy "Claude AI usage limit reached|<epoch seconds>".
const LINE =
  /^You(?:'|’)ve hit your ([A-Za-z][A-Za-z0-9 -]{0,23}) limit · resets ((?:[A-Z][a-z]{2} \d{1,2}(?:,| at) )?\d{1,2}(?::\d{2})?(?:am|pm))(?: \(([A-Za-z]+(?:\/[A-Za-z0-9_+-]+){0,2})\))?$/;
const LEGACY = /^Claude AI usage limit reached\|(\d{10})$/;
const WHEN = /^(?:([A-Z][a-z]{2}) (\d{1,2})(?:,| at) )?(\d{1,2})(?::(\d{2}))?(am|pm)$/;

function zoneOffset(zone, instant) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(new Date(instant))
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second) -
    Math.floor(instant / 1000) * 1000
  );
}
function localParts(zone, instant) {
  const o = zoneOffset(zone, instant),
    d = new Date(instant + o);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate() };
}
// Local wall-clock (y, mo, d, h, mi) in zone -> UTC instant (two passes cover a DST edge).
function fromLocal(zone, y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo, d, h, mi);
  let t = guess - zoneOffset(zone, guess);
  t = guess - zoneOffset(zone, t);
  return t;
}
const validZone = (zone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};
// A revoked or invalid account token (FU-112). The CLI ends every turn with one line such as "Failed to authenticate.
// API Error: 401 {...OAuth token has been revoked...}". Matched on the whole single line only, so prose that mentions a
// token never counts. A token is a property of the account, not a usage window: there is no reset time.
const REVOKED_LINE =
  /^(?:Failed to authenticate\b|API Error: 401\b|(?:Invalid|Expired) (?:bearer )?token\b|OAuth token (?:has been )?(?:revoked|expired|invalid)\b)[^\n]{0,300}$/i;
const REVOKED_WORDS = /revoked|invalid|expired|authentication_error|401|unauthori[sz]ed|\/login/i;
export function parseRevokedLine(text) {
  if (typeof text !== "string") return null;
  const line = text.trim();
  if (line.length > 400 || !REVOKED_LINE.test(line) || !REVOKED_WORDS.test(line)) return null;
  return { kind: "revoked", reset: null, zone: null, resetAt: null };
}
// Pure. Returns null when the text is not the CLI's limit line; otherwise { kind, reset, zone, resetAt } where resetAt
// is null if the time cannot be resolved (then nothing is resumed automatically; the stop is still recorded).
export function parseLimitLine(
  text,
  at,
  fallbackZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
) {
  if (typeof text !== "string" || text.length > 200 || !Number.isFinite(at)) return null;
  const legacy = LEGACY.exec(text);
  if (legacy) {
    const t = Number(legacy[1]) * 1000;
    return {
      kind: "usage",
      reset: legacy[1],
      zone: null,
      resetAt: t > at && t - at <= MAX_RESET_AHEAD_MS ? new Date(t).toISOString() : null,
    };
  }
  const m = LINE.exec(text);
  if (!m) return null;
  const [, kind, reset, named] = m,
    zone = named ?? fallbackZone,
    w = WHEN.exec(reset);
  const out = { kind: kind.toLowerCase(), reset, zone: named ?? null, resetAt: null };
  if (!w || !validZone(zone)) return out;
  const [, mon, day, hh, mm = "0", ap] = w,
    h = Number(hh),
    mi = Number(mm);
  if (h < 1 || h > 12 || mi > 59) return out;
  const hour = (h % 12) + (ap === "pm" ? 12 : 0),
    now = localParts(zone, at);
  let t;
  if (mon) {
    const mo = MONTHS.indexOf(mon);
    if (mo < 0) return out;
    t = fromLocal(zone, now.y, mo, Number(day), hour, mi);
    if (t <= at) t = fromLocal(zone, now.y + 1, mo, Number(day), hour, mi);
  } else {
    t = fromLocal(zone, now.y, now.mo, now.d, hour, mi);
    if (t <= at) {
      const next = localParts(zone, t + 26 * 3600000);
      t = fromLocal(zone, next.y, next.mo, next.d, hour, mi);
    }
  }
  if (t > at && t - at <= MAX_RESET_AHEAD_MS) out.resetAt = new Date(t).toISOString();
  return out;
}
