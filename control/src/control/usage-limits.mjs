// H6 item 6. Claude usage-limit auto-resume.
//
// Live incident, 24->25 Sep: at about 21:45 every Claude session stopped with "You've hit your session limit · resets
// 12:50am (Australia/Brisbane)" and nothing resumed them for 9 h. Codex has a structured quota read and quota-wait
// parks and replays controller sends; Claude has neither, so a Claude turn that hits the limit simply ends.
//
// DETECTION is structural. The Claude CLI ends such a turn with one synthetic assistant message whose whole text is
// its fixed limit line. A stop is recorded only when ALL of: the session is a Claude session this controller enrolled;
// the daemon reports it idle; the newest timeline entry (by sequence) is an assistant_message; and that message's
// ENTIRE text parses under the CLI's grammar below (anchored, one line). User text is never examined -- only the
// assistant item that ends the turn, and only as a whole. The reset instant is resolved from the line's wall-clock
// time and IANA zone against the message's own timestamp (or the session's updatedAt), never against "now", so a
// stop observed hours later (a controller restart) still resolves to the right reset.
//
// RESUME. At resetAt + jitter the stop is re-verified -- the same limit message is still the newest entry and no
// human input arrived since -- and then, for a DELEGATED session only, one controller continuation is sent through
// control.send (every fence: generation, native identity, human-input fence, idleness, task authority, allowance,
// and the journal's automation limit, since it is automated traffic). Its message id is derived from the stop, so a
// retry can never send twice. A busy session is retried with backoff, bounded; a session that stops again is a new
// stop, and at most MAX_RESUMES_PER_DAY are resumed per session per 24 h before it is left to a human.
// A HUMAN-HELD session is never sent anything: its human is notified once (metadata only), and that is all.
// Everything is visible in recovery-status (usageLimits).
import { createHash } from "node:crypto";
import { assertColumns } from "./schema.mjs";
import { uuid, RecipientBusy } from "./authority.mjs";
import {
  rotateOnLimit,
  rotationOf,
  rotateDelay,
  rotationNote,
  fencedRelaunch,
} from "./account-rotation.mjs";

export const RESUME_JITTER_MS = [30000, 120000],
  MAX_ATTEMPTS = 6,
  RETRY_BASE_MS = 60000,
  MAX_RESUMES_PER_DAY = 3,
  MAX_RESET_AHEAD_MS = 8 * 86400000;
const COLUMNS =
  "id,session,generation,mode,provider,turnId,seq,messageId,line,stoppedAt,resetAt,lastUserMessageAt,lastInstruction,state,attempts,nextAt,continuation,outcome,at";
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
// Pure. A timeline tail -> the stop it ends with, or null.
export function detectStop(tail) {
  if (
    tail?.provider !== "claude" ||
    tail.status !== "idle" ||
    !Array.isArray(tail.entries) ||
    !tail.entries.length
  )
    return null;
  const last = [...tail.entries].sort((a, b) => a.seqEnd - b.seqEnd).at(-1);
  if (
    !Number.isSafeInteger(last?.seqEnd) ||
    (tail.maxSeq !== undefined && last.seqEnd !== tail.maxSeq)
  )
    return null; // something newer exists
  if (last.item?.type !== "assistant_message") return null;
  const stoppedAt = Date.parse(last.timestamp ?? tail.updatedAt ?? "");
  const parsed = parseLimitLine(last.item.text, stoppedAt);
  if (!parsed) return null;
  return {
    turnId: last.turnId ?? null,
    seq: last.seqEnd,
    messageId: String(last.item.messageId ?? ""),
    line: last.item.text,
    stoppedAt: new Date(stoppedAt).toISOString(),
    ...parsed,
  };
}
export function continuationText(stop, rotation = null) {
  const lead = rotation?.to
    ? `[Orca controller: your previous turn stopped at the Claude usage limit ("${stop.line}", recorded ${stop.stoppedAt}). ${rotationNote(rotation)}]\n`
    : `[Orca controller: your previous turn stopped at the Claude usage limit ("${stop.line}", recorded ${stop.stoppedAt}); the limit has now reset.]\n`;
  return (
    lead +
    "Continue exactly where you stopped. First check your working tree, git log and any receipts or artifacts to see how far that turn got, " +
    "and do NOT repeat an external action (push, merge, deploy, message, channel send, session start, or a write outside your directory) unless you have verified it did not happen."
  );
}
const derived = (id, purpose) => {
  const h = createHash("sha256").update(`${id}:${purpose}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export class UsageLimits {
  constructor(control, { now = Date.now, random = Math.random } = {}) {
    this.control = control;
    this.store = control.store;
    this.db = this.store.db;
    this.now = now;
    this.random = random;
    this.flights = new Map();
    this.seen = new Map();
    this.ticking = null;
    this.lastError = null;
    this.relaunched = new Set();
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS usage_limit_stops(id TEXT PRIMARY KEY,session TEXT NOT NULL,generation INTEGER NOT NULL,mode TEXT NOT NULL,provider TEXT NOT NULL,turnId TEXT,seq INTEGER NOT NULL,messageId TEXT NOT NULL,line TEXT NOT NULL,stoppedAt TEXT NOT NULL,resetAt TEXT,lastUserMessageAt TEXT,lastInstruction TEXT,state TEXT NOT NULL,attempts INTEGER NOT NULL,nextAt TEXT,continuation TEXT,outcome TEXT,at TEXT NOT NULL,UNIQUE(session,seq))`,
    );
    assertColumns(this.db, "usage_limit_stops", COLUMNS);
  }
  iso(t = this.now()) {
    return new Date(t).toISOString();
  }
  // A native agent update: a Claude session of ours that went idle may have stopped at the limit. Single flight per
  // session, and only once per daemon update (updatedAt), so a burst of updates costs one timeline read.
  onAgent(a) {
    if (a?.provider !== "claude" || a.status !== "idle" || !uuid(a.id) || !this.store.get(a.id))
      return null;
    if (this.seen.get(a.id) === a.updatedAt) return null;
    this.seen.set(a.id, a.updatedAt);
    if (this.seen.size > 1024) this.seen.delete(this.seen.keys().next().value);
    return this.observe(a.id);
  }
  observe(id) {
    if (this.flights.has(id)) return this.flights.get(id);
    const flight = this.observeOnce(id)
      .catch((e) => {
        this.lastError = { message: e.message, at: this.iso() };
        return null;
      })
      .finally(() => this.flights.delete(id));
    this.flights.set(id, flight);
    return flight;
  }
  async observeOnce(id) {
    if (typeof this.control.native?.limitTail !== "function") return null;
    const s = this.store.get(id);
    if (!s) return null;
    const tail = await this.control.native.limitTail(id),
      stop = detectStop(tail);
    if (!stop) return null;
    const last =
      this.db
        .prepare(
          "SELECT id FROM deliveries WHERE session=? AND kind='send' AND state='delivered' ORDER BY rowid DESC LIMIT 1",
        )
        .get(id)?.id ?? null;
    const row = {
      id: derived(`${id}:${stop.seq}`, "usage-limit-stop"),
      session: id,
      generation: s.generation,
      mode: s.mode,
      provider: "claude",
      turnId: stop.turnId,
      seq: stop.seq,
      messageId: stop.messageId,
      line: stop.line.slice(0, 200),
      stoppedAt: stop.stoppedAt,
      resetAt: stop.resetAt,
      lastUserMessageAt: tail.lastUserMessageAt ?? null,
      lastInstruction: last,
    };
    const at = this.iso();
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO usage_limit_stops VALUES (@id,@session,@generation,@mode,@provider,@turnId,@seq,@messageId,@line,@stoppedAt,@resetAt,@lastUserMessageAt,@lastInstruction,'waiting',0,@nextAt,NULL,NULL,@at)`,
      )
      .run({
        ...row,
        nextAt: row.resetAt ? this.iso(Date.parse(row.resetAt) + this.jitter()) : null,
        at,
      });
    if (!Number(inserted.changes)) return this.row(row.id);
    // Update-7: with an account pool, the session moves to the next account now instead of waiting for the reset.
    const rotation = await rotateOnLimit(this.control, {
      session: id,
      provider: "claude",
      resetAt: row.resetAt,
      note: row.line,
      stopId: row.id,
      now: this.now(),
      delegated: s.mode === "delegated",
    });
    if (rotation?.to && s.mode === "delegated") {
      this.db
        .prepare("UPDATE usage_limit_stops SET nextAt=?,outcome=?,at=? WHERE id=?")
        .run(
          this.iso(this.now() + rotateDelay(this.random)),
          `moving to account "${rotation.toName}"`,
          this.iso(),
          row.id,
        );
      return this.row(row.id);
    }
    if (!row.resetAt)
      this.finish(
        row.id,
        "unresolved",
        "The reset time could not be resolved from the limit line; nothing is resumed automatically",
      );
    return this.row(row.id);
  }
  jitter() {
    const [lo, hi] = RESUME_JITTER_MS;
    return Math.round(lo + (hi - lo) * this.random());
  }
  row(id) {
    return this.db.prepare("SELECT * FROM usage_limit_stops WHERE id=?").get(id) ?? null;
  }
  finish(id, state, outcome, extra = {}) {
    this.db
      .prepare(
        "UPDATE usage_limit_stops SET state=?,outcome=?,continuation=coalesce(?,continuation),at=? WHERE id=?",
      )
      .run(state, String(outcome).slice(0, 500), extra.continuation ?? null, this.iso(), id);
  }
  // Watchdog: every due stop, one at a time.
  tick() {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      const due = this.db
        .prepare(
          "SELECT * FROM usage_limit_stops WHERE state='waiting' AND nextAt IS NOT NULL AND nextAt<=? ORDER BY nextAt LIMIT 16",
        )
        .all(this.iso());
      for (const r of due) {
        try {
          await this.due(r);
        } catch (e) {
          this.lastError = { message: e.message, at: this.iso() };
        }
      }
    })().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }
  async due(r) {
    const s = this.store.get(r.session);
    if (!s) return this.finish(r.id, "superseded", "The session is no longer enrolled");
    // Human-held: notify only, once. Never a send.
    if (s.mode !== "delegated") return this.notify(r, s);
    if (s.generation !== r.generation)
      return this.finish(r.id, "superseded", "Session control changed since the stop was recorded");
    // Still exactly at this stop, and nobody has spoken since.
    const tail = await this.control.native.limitTail(r.session),
      stop = detectStop(tail);
    if (
      !stop ||
      stop.seq !== r.seq ||
      stop.messageId !== r.messageId ||
      (tail.lastUserMessageAt ?? null) !== (r.lastUserMessageAt ?? null)
    )
      return this.finish(
        r.id,
        "superseded",
        "The session moved on since it stopped at the limit; nothing was sent",
      );
    const recent = this.db
      .prepare(
        "SELECT count(*) n FROM usage_limit_stops WHERE session=? AND state='resumed' AND at>?",
      )
      .get(r.session, this.iso(this.now() - 86400000)).n;
    if (recent >= MAX_RESUMES_PER_DAY) {
      this.finish(
        r.id,
        "held-back",
        `This session was already resumed ${recent} times in 24 h; left for a human`,
      );
      return this.notify(this.row(r.id), s, true);
    }
    const continuation = derived(r.id, "usage-limit-continue");
    // Update-7: moved to another account -> relaunch in place first, so the continuation runs on the new account.
    const rotation = rotationOf(r.id, this.control);
    if (rotation?.to && !this.relaunched.has(r.id)) {
      try {
        const res = await fencedRelaunch(
          this.control,
          r.session,
          r.generation,
          rotation.to,
          this.now,
        );
        if (res?.outcome !== "refreshed")
          throw Error(`the host refused the relaunch: ${res?.outcome ?? "no result"}`);
        this.relaunched.add(r.id); // a busy retry of the continuation does not relaunch again
      } catch (e) {
        if (/revoked delegation|control changed/i.test(e.message))
          return this.finish(r.id, "held-back", e.message);
        const attempts = r.attempts + 1;
        if (attempts >= MAX_ATTEMPTS)
          return this.finish(
            r.id,
            "failed",
            `Relaunch on account "${rotation.toName}" failed after ${attempts} attempts: ${e.message}`,
          );
        this.db
          .prepare("UPDATE usage_limit_stops SET attempts=?,nextAt=?,outcome=?,at=? WHERE id=?")
          .run(
            attempts,
            this.iso(this.now() + RETRY_BASE_MS * 2 ** (attempts - 1)),
            `relaunch failed; retrying: ${e.message}`.slice(0, 500),
            this.iso(),
            r.id,
          );
        return;
      }
    }
    try {
      const d = await this.control.send(
        { sessionId: r.session, messageId: continuation, text: continuationText(r, rotation) },
        undefined,
        r.generation,
        {
          automated: "usage-limit-resume",
          check: () => {
            const now = this.row(r.id),
              cur = this.store.get(r.session);
            if (
              now?.state !== "waiting" ||
              cur?.mode !== "delegated" ||
              cur.generation !== r.generation
            )
              throw Error("The stop is no longer waiting");
          },
        },
      );
      this.finish(
        r.id,
        d.state === "delivered" ? "resumed" : "uncertain",
        `Continuation ${d.state}`,
        { continuation },
      );
    } catch (e) {
      const attempts = r.attempts + 1;
      if (e instanceof RecipientBusy && attempts < MAX_ATTEMPTS) {
        this.db
          .prepare("UPDATE usage_limit_stops SET attempts=?,nextAt=?,outcome=?,at=? WHERE id=?")
          .run(
            attempts,
            this.iso(this.now() + RETRY_BASE_MS * 2 ** (attempts - 1)),
            "busy; retrying",
            this.iso(),
            r.id,
          );
      } else
        this.finish(
          r.id,
          "failed",
          `${e instanceof RecipientBusy ? `Still busy after ${attempts} attempts` : e.message}`,
        );
    }
  }
  async notify(r, s, heldBack = false) {
    const notify = this.control.limitNotifier;
    let outcome = "no notifier configured";
    if (typeof notify === "function") {
      try {
        await notify({
          session: r.session,
          resetAt: r.resetAt,
          reset: r.line.replace(/^.* resets /, "").slice(0, 60),
          heldBack,
        });
        outcome = "human notified";
      } catch (e) {
        outcome = "notification failed: " + String(e?.message ?? e).slice(0, 200);
      }
    }
    if (!heldBack)
      this.finish(
        r.id,
        "notified",
        `${s.mode === "delegated" ? "Held back" : "Under human control; nothing was sent"}; ${outcome}`,
      );
    else
      this.db
        .prepare("UPDATE usage_limit_stops SET outcome=outcome||? WHERE id=?")
        .run(`; ${outcome}`, r.id);
  }
  // For recovery-status: open stops first, then the recent history.
  status() {
    const rows = this.db
      .prepare(
        "SELECT * FROM usage_limit_stops ORDER BY (state='waiting') DESC, rowid DESC LIMIT 64",
      )
      .all();
    return {
      waiting: rows.filter((r) => r.state === "waiting").length,
      stops: rows.map((r) => ({
        id: r.id,
        sessionId: r.session,
        mode: r.mode,
        line: r.line,
        stoppedAt: r.stoppedAt,
        resetAt: r.resetAt,
        nextAt: r.nextAt,
        state: r.state,
        attempts: r.attempts,
        continuation: r.continuation,
        outcome: r.outcome,
        interruptedTurn: { turnId: r.turnId, seq: r.seq, lastInstruction: r.lastInstruction },
        at: r.at,
      })),
      error: this.lastError,
    };
  }
}
