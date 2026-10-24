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
// RESUME (FU-490). At resetAt + 2 min the stop is re-verified -- the same limit message is still the newest entry and no
// human input arrived since -- and then ONE continuation is sent to the session on the SAME account (it moves only if rotateOnLimit is on or the token is revoked). A delegated session is sent through control.send (every fence); a human-held session through the
// native adapter, once, after the same re-check. Its message id is derived from the stop, so a retry can never send
// twice. A busy session is retried with backoff, bounded. If the continued turn stops at a limit again soon after, or
// the resume fails or cannot be timed, ONE BLOCKED line goes to the session's parent (wakes.limitBlocked), never silent.
// The stops live in the journal, so a pending resume survives a daemon restart.
// Everything is visible in recovery-status (usageLimits).
import { createHash } from "node:crypto";
import { assertColumns } from "./schema.mjs";
import { uuid, RecipientBusy } from "./authority.mjs";
import {
  rotateOnLimit,
  pooledSession,
  rotationOf,
  rotateDelay,
  rotationNote,
  fencedRelaunch,
} from "./account-rotation.mjs";
// The limit-line parser lives with the Command Centre plugin, which bundles it on its own (fulcra ask, FU-58).
import {
  parseLimitLine,
  parseRevokedLine,
  MAX_RESET_AHEAD_MS,
} from "../../orca-organization/server/limit-line.mjs";
export { parseLimitLine, parseRevokedLine, MAX_RESET_AHEAD_MS };

export const RESUME_DELAY_MS = 120000,
  MAX_ATTEMPTS = 6,
  RETRY_BASE_MS = 60000,
  AGAIN_WINDOW_MS = 3600000; // a stop this soon after a resume is the continued turn stopping again
const COLUMNS =
  "id,session,generation,mode,provider,turnId,seq,messageId,line,stoppedAt,resetAt,lastUserMessageAt,lastInstruction,state,attempts,nextAt,continuation,outcome,at";
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
  // FU-112: a revoked or invalid account token ends the turn the same way; it has no reset time.
  const parsed = parseLimitLine(last.item.text, stoppedAt) ?? parseRevokedLine(last.item.text);
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
  if (parseRevokedLine(stop.line))
    return (
      `[Orca controller: your previous turn stopped because the token of your account was revoked or invalid ("${String(stop.line).slice(0, 200)}", recorded ${stop.stoppedAt}). ` +
      `${rotation?.to ? rotationNote(rotation) : "No other account was ready."}]\n` +
      "Continue exactly where you stopped. First check your working tree, git log and any receipts or artifacts to see how far that turn got, " +
      "and do NOT repeat an external action (push, merge, deploy, message, channel send, session start, or a write outside your directory) unless you have verified it did not happen."
    );
  return (
    (rotation?.to
      ? `[Orca controller: your previous turn stopped at the Claude usage limit ("${stop.line}", recorded ${stop.stoppedAt}). ${rotationNote(rotation)}]\n`
      : `[Orca controller: your previous turn stopped at the Claude usage limit ("${stop.line}", recorded ${stop.stoppedAt}); the limit has now reset.]\n`) +
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
    if (a?.provider !== "claude" || a.status !== "idle" || !uuid(a.id)) return null;
    // A Claude session this controller did not enrol (for example `fulcra run --output-schema`) is never resumed or
    // moved, but its account is still marked limited, so the pool skips it (FU-61).
    // One read per daemon update. The map is trimmed here, before the not-enrolled branch, so it cannot grow without end.
    if (this.seen.get(a.id) === a.updatedAt) return null;
    this.seen.set(a.id, a.updatedAt);
    if (this.seen.size > 1024) this.seen.delete(this.seen.keys().next().value);
    if (!this.store.get(a.id)) return this.observePoolOnly(a.id);
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
  async observePoolOnly(id) {
    try {
      if (typeof this.control.native?.limitTail !== "function") return null;
      if (!pooledSession(this.control, id)) return null;
      const stop = detectStop(await this.control.native.limitTail(id));
      if (!stop) return null;
      await rotateOnLimit(this.control, {
        session: id,
        provider: "claude",
        resetAt: stop.resetAt,
        stoppedAt: stop.stoppedAt,
        note: stop.line,
        stopId: derived(`${id}:${stop.seq}`, "usage-limit-stop"),
        now: this.now(),
        delegated: false,
        kind: stop.kind,
      });
    } catch (e) {
      this.lastError = { message: e.message, at: this.iso() };
    }
    return null;
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
    // The continued turn stopping at a limit again soon after a resume is reported up, not resumed in a loop.
    const prior = this.db
      .prepare(
        "SELECT at FROM usage_limit_stops WHERE session=? AND state='resumed' AND seq<? ORDER BY seq DESC LIMIT 1",
      )
      .get(id, row.seq);
    const again =
      Boolean(prior) && Date.parse(row.stoppedAt) - Date.parse(prior.at) <= AGAIN_WINDOW_MS;
    const at = this.iso();
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO usage_limit_stops VALUES (@id,@session,@generation,@mode,@provider,@turnId,@seq,@messageId,@line,@stoppedAt,@resetAt,@lastUserMessageAt,@lastInstruction,@state,0,@nextAt,NULL,NULL,@at)`,
      )
      .run({
        ...row,
        state: again ? "blocked" : "waiting",
        nextAt: row.resetAt && !again ? this.iso(Date.parse(row.resetAt) + RESUME_DELAY_MS) : null,
        at,
      });
    if (!Number(inserted.changes)) return this.row(row.id);
    // The account is marked limited. The session moves to another account only when rotateOnLimit is on (or the
    // token is revoked); otherwise it stays on its account and is continued there after the reset.
    const rotation = await rotateOnLimit(this.control, {
      session: id,
      provider: "claude",
      resetAt: row.resetAt,
      stoppedAt: row.stoppedAt,
      note: row.line,
      stopId: row.id,
      now: this.now(),
      delegated: s.mode === "delegated",
      kind: stop.kind,
    });
    if (rotation?.to && s.mode === "delegated") {
      this.db
        .prepare("UPDATE usage_limit_stops SET state='waiting',nextAt=?,outcome=?,at=? WHERE id=?")
        .run(
          this.iso(this.now() + rotateDelay(this.random)),
          `moving to account "${rotation.toName}"`,
          this.iso(),
          row.id,
        );
      return this.row(row.id);
    }
    if (again)
      this.block(
        row,
        "blocked",
        "The continued turn stopped at the usage limit again; not resumed a second time",
      );
    else if (stop.kind === "revoked")
      this.block(
        row,
        "unresolved",
        "The account token is revoked or invalid and no other account is ready; nothing is resumed automatically",
      );
    else if (!row.resetAt)
      this.block(
        row,
        "unresolved",
        "The reset time could not be resolved from the limit line; nothing is resumed automatically",
      );
    return this.row(row.id);
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
  // A stop that cannot be continued: record why, and send ONE BLOCKED line to the session's parent (once per stop).
  block(r, state, outcome) {
    this.finish(r.id, state, outcome);
    try {
      this.control.wakes?.limitBlocked?.(r.session, {
        stopId: r.id,
        line: r.line,
        resetAt: r.resetAt ?? null,
        reason: String(outcome).slice(0, 300),
      });
    } catch (e) {
      this.lastError = { message: e.message, at: this.iso() };
    }
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
    const delegated = s.mode === "delegated";
    if (delegated && s.generation !== r.generation)
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
    const continuation = derived(r.id, "usage-limit-continue");
    // A revoked token (FU-112) moved the session to another account: relaunch in place first, so the continuation
    // runs on it. A usage-limit stop never has a rotation.
    const rotation = delegated ? rotationOf(r.id, this.control) : null;
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
          return this.block(
            r,
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
      let state;
      if (delegated) {
        const d = await this.control.send(
          {
            sessionId: r.session,
            messageId: continuation,
            text: continuationText(r, rotation),
          },
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
        state = d.state === "delivered" ? "resumed" : "uncertain";
      } else {
        // A human-held session has no journal send. Mark the stop first, so a crash cannot send twice.
        if ((await this.control.native.inspect(r.session))?.status !== "idle")
          throw new RecipientBusy("Session is not idle");
        this.finish(r.id, "resumed", "Continuation sent", { continuation });
        try {
          await this.control.native.send(r.session, continuationText(r), continuation);
        } catch (e) {
          this.block(r, "failed", `Continuation not sent: ${e.message}`);
        }
        return;
      }
      this.finish(r.id, state, `Continuation ${state === "resumed" ? "delivered" : "uncertain"}`, {
        continuation,
      });
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
        this.block(
          r,
          "failed",
          `${e instanceof RecipientBusy ? `Still busy after ${attempts} attempts` : e.message}`,
        );
    }
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
        interruptedTurn: {
          turnId: r.turnId,
          seq: r.seq,
          lastInstruction: r.lastInstruction,
        },
        at: r.at,
      })),
      error: this.lastError,
    };
  }
}
