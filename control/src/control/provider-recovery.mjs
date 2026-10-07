// H7 items 3 and 4. A delegated session whose provider runtime broke is restarted with its history by the controller,
// instead of sitting in the error state until the prime reloads it by hand.
//
// Live, 26 Sep 09:41: the Codex login refreshed and three running Codex workers failed with "unexpected status 401
// Unauthorized: Incorrect API key provided" (daemon log). The prime reloaded each one with refresh_agent_request, which
// the native guard counts as HUMAN input (it interrupts), so every reload ended in a takeover ("Native input identity
// changed; explicit handback required", transfers gen 5) and a hand re-delegation. A failed tool-surface refresh leaves
// the agent in "MCP refresh failed; explicit close recovery required", where the daemon refuses every operation.
//
// Recognised (status 'error' only, from the daemon's own lastError):
//   refresh -- the explicit-close-recovery state a failed tool refresh leaves (any provider);
//   auth    -- a Codex app-server that lost its credentials or its binary (401/unauthorized, app-server exited, binary);
//   quota   -- a Codex turn stopped by its usage limit. Resumed only when a FRESH quota read says ordinary usage is
//              allowed again (quota-wait.mjs quotaDecision: reset times are observations, never a permission), re-read
//              every QUOTA_POLL_MS for at most a day.
// The restart is the daemon's fenced in-place reconnect (agent.mcp.refresh with reconnect: the same path a tool refresh
// takes, admitted by the guard's mcpRefreshAdmission -- delegated, live, no human input, no pending delivery), which
// closes the provider runtime and resumes the SAME provider session with its timeline; it is not human input and
// changes no prompt identity. It needs the H7 host (cc/h7-host-recovery): an older host refuses a session in error,
// and that refusal is recorded, bounded and retried like any other failure.
// Then, for an auth or quota stop that interrupted a controller instruction, ONE continuation is sent (derived id, every
// send fence, automated traffic). A human-held session is never touched: its row is recorded 'held'.
// Bounds: one row per EPISODE -- a (session, generation, error text) seen again only after the session was observed out
// of that error (review H7 B2: keyed by the text alone, the constant explicit-close-recovery text or a repeat of the
// same 401 was recovered once per session, ever) -- MAX_ATTEMPTS restarts with backoff, MAX_RECOVERIES_PER_DAY a session.
import { createHash } from "node:crypto";
import {
  transientNetworkError,
  endingNetworkError,
  NETWORK_BACKOFF_MS,
} from "./transient-network.mjs";
import { assertColumns } from "./schema.mjs";
import { uuid, RecipientBusy } from "./authority.mjs";
import { quotaDecision } from "./quota-wait.mjs";
import {
  rotateOnLimit,
  rotationOf,
  rotateDelay,
  rotationNote,
  codexResetAt,
  fencedRelaunch,
} from "./account-rotation.mjs";

export const REFRESH = /explicit close recovery/i;
export const AUTH =
  /\b401\b|unauthori[sz]ed|incorrect api key|invalid api key|api key (?:expired|revoked)|token (?:expired|invalid|revoked)|refresh[_ ]token|app-server exited|binary (?:not found|changed|replaced|missing)|failed to initialize sqlite state runtime/i;
export const QUOTA = /usage limit|rate limit|quota|\b429\b|too many requests/i;
export const MAX_ATTEMPTS = 5,
  BACKOFF_MS = [15000, 60000, 300000, 900000, 1800000],
  MAX_RECOVERIES_PER_DAY = 4,
  QUOTA_POLL_MS = 300000,
  QUOTA_MAX_POLLS = 288;
const COLUMNS =
  "id,session,generation,provider,kind,error,lastInstruction,state,attempts,nextAt,continuation,outcome,at,episode,cleared";
const digest = (x) => createHash("sha256").update(x).digest("hex");
const derived = (x, purpose) => {
  const h = digest(`${x}:${purpose}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

// Pure: which recoverable failure a native snapshot shows, or null.
export function classify(a) {
  if (a?.status !== "error") return null;
  const e = String(a.lastError ?? "");
  if (transientNetworkError(e)) return "network";
  if (REFRESH.test(e)) return "refresh";
  if (a.provider !== "codex") return null;
  if (QUOTA.test(e) && !/\b401\b|unauthori[sz]ed/i.test(e)) return "quota";
  return AUTH.test(e) ? "auth" : null;
}
export function continuationText(r, rotation = null) {
  const what =
    r.kind === "network"
      ? "a temporary network failure"
      : r.kind === "quota"
        ? rotation?.to
          ? "its usage limit"
          : "its usage limit, which has now lifted"
        : "a provider failure, and the controller restarted it with its history";
  return (
    `[Orca controller: your previous turn stopped at ${what} ("${r.error.slice(0, 200)}", recorded ${r.at}).${rotation?.to ? " " + rotationNote(rotation) : ""}]\n` +
    "Continue exactly where you stopped. First check your working tree, git log and any receipts or artifacts to see how far that turn got, " +
    "and do NOT repeat an external action (push, merge, deploy, message, channel send, session start, or a write outside your directory) unless you have verified it did not happen."
  );
}

export class ProviderRecovery {
  constructor(control, { now = Date.now } = {}) {
    this.control = control;
    this.store = control.store;
    this.db = this.store.db;
    this.now = now;
    this.flights = new Map();
    this.networkSeen = new Map();
    this.ticking = null;
    this.lastError = null;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS provider_recoveries(id TEXT PRIMARY KEY,session TEXT NOT NULL,generation INTEGER NOT NULL,provider TEXT NOT NULL,kind TEXT NOT NULL,error TEXT NOT NULL,lastInstruction TEXT,state TEXT NOT NULL,attempts INTEGER NOT NULL,nextAt TEXT,continuation TEXT,outcome TEXT,at TEXT NOT NULL,episode INTEGER NOT NULL,cleared INTEGER NOT NULL)",
    );
    assertColumns(this.db, "provider_recoveries", COLUMNS);
  }
  iso(t = this.now()) {
    return new Date(t).toISOString();
  }
  row(id) {
    return this.db.prepare("SELECT * FROM provider_recoveries WHERE id=?").get(id) ?? null;
  }
  finish(id, state, outcome, extra = {}) {
    this.db
      .prepare(
        "UPDATE provider_recoveries SET state=?,outcome=?,continuation=coalesce(?,continuation),at=? WHERE id=?",
      )
      .run(state, String(outcome).slice(0, 500), extra.continuation ?? null, this.iso(), id);
  }
  // A native update of one of our sessions: in a recoverable error it is observed; out of one, every finished episode of
  // it is marked cleared, so the next occurrence of the same failure is a new episode.
  onAgent(a) {
    if (!uuid(a?.id) || !this.store.get(a.id)) return null;
    if (classify(a)) return this.observe(a.id);
    if (a.provider === "claude" && a.status === "idle") {
      if (a.updatedAt && this.networkSeen.get(a.id) === a.updatedAt) return null;
      this.networkSeen.set(a.id, a.updatedAt);
      if (this.networkSeen.size > 1024)
        this.networkSeen.delete(this.networkSeen.keys().next().value);
      // Idle is out of any reported error, but its last message may still be a network failure:
      // network episodes clear only once that ending is gone.
      this.cleared(a.id, "AND kind!='network'");
      return this.observe(a.id).then((found) => found ?? this.cleared(a.id));
    }
    return this.cleared(a.id);
  }
  cleared(id, only = "") {
    this.db
      .prepare(
        `UPDATE provider_recoveries SET cleared=1 WHERE session=? AND cleared=0 AND state!='waiting' ${only}`,
      )
      .run(id);
    return null;
  }
  observe(id) {
    if (this.flights.has(id)) return this.flights.get(id);
    const flight = this.observeOnce(id)
      .catch((e) => {
        this.lastError = { session: id, message: e.message, at: this.iso() };
        return null;
      })
      .finally(() => this.flights.delete(id));
    this.flights.set(id, flight);
    return flight;
  }
  async failure(id) {
    const a = await this.control.native.snapshot(id);
    if (classify(a) || a?.status !== "idle" || a.provider !== "claude") return a;
    const tail = await this.control.native.limitTail?.(id);
    const last = tail?.entries?.at(-1);
    const error =
      last?.item?.type === "assistant_message" &&
      (tail.maxSeq === undefined || last.seqEnd === tail.maxSeq) &&
      endingNetworkError(last.item.text);
    return error ? { ...a, status: "error", lastError: error } : a;
  }
  async networkEnabled(id) {
    if ((await this.control.native.automaticResumeEnabled?.(id)) !== true) return false;
    // The per-session opt-out is read fresh at every gate, like the host toggle.
    const snapshot = await this.control.native.snapshot(id);
    return snapshot?.labels?.["fulcra.limit-resume"] !== "off";
  }
  async observeOnce(id) {
    const s = this.store.get(id);
    if (!s) return null;
    const a = await this.failure(id),
      kind = classify(a);
    if (!kind) return null;
    if (
      kind === "network" &&
      (!(await this.networkEnabled(id)) || !s.expected || a.pendingPermissions?.length)
    )
      return null;
    const error = String(a.lastError).slice(0, 1000),
      base = `${id}:${s.generation}:${digest(error)}`;
    // The newest episode of this failure: still open, or finished and not yet seen cleared -> the same occurrence.
    const prior = this.db
      .prepare(
        "SELECT * FROM provider_recoveries WHERE session=? AND generation=? AND error=? ORDER BY episode DESC LIMIT 1",
      )
      .get(id, s.generation, error);
    if (prior && (prior.state === "waiting" || !prior.cleared)) return prior;
    const episode = (prior?.episode ?? -1) + 1,
      rid = derived(`${base}:${episode}`, "provider-recovery");
    const last =
      this.db
        .prepare(
          "SELECT id FROM deliveries WHERE session=? AND kind='send' AND state='delivered' ORDER BY rowid DESC LIMIT 1",
        )
        .get(id)?.id ?? null;
    const inserted = this.db
      .prepare(
        "INSERT OR IGNORE INTO provider_recoveries VALUES (?,?,?,?,?,?,?,?,0,?,NULL,NULL,?,?,0)",
      )
      .run(
        rid,
        id,
        s.generation,
        a.provider,
        kind,
        error,
        last,
        s.mode === "delegated" ? "waiting" : "held",
        this.iso(
          this.now() +
            (kind === "network"
              ? (NETWORK_BACKOFF_MS[this.networkCount(id)] ?? NETWORK_BACKOFF_MS.at(-1))
              : BACKOFF_MS[0]),
        ),
        this.iso(),
        episode,
      );
    if (Number(inserted.changes) && s.mode !== "delegated")
      this.finish(rid, "held", "Under human control; the controller does not restart it");
    // Update-7: a Codex usage limit with an account pool -> the next account, restarted in seconds (not after the reset).
    if (Number(inserted.changes) && kind === "quota") {
      const rotation = await rotateOnLimit(this.control, {
        session: id,
        provider: "codex",
        resetAt: codexResetAt(error, this.now()),
        note: error.slice(0, 200),
        stopId: rid,
        now: this.now(),
        delegated: s.mode === "delegated",
      });
      if (rotation?.to && s.mode === "delegated")
        this.db
          .prepare("UPDATE provider_recoveries SET nextAt=?,outcome=?,at=? WHERE id=?")
          .run(
            this.iso(this.now() + rotateDelay()),
            `moving to account "${rotation.toName}"`,
            this.iso(),
            rid,
          );
    }
    return this.row(rid);
  }
  tick() {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      for (const r of this.db
        .prepare(
          "SELECT * FROM provider_recoveries WHERE state='waiting' AND nextAt<=? ORDER BY nextAt LIMIT 8",
        )
        .all(this.iso())) {
        try {
          await this.due(r);
        } catch (e) {
          this.lastError = { session: r.session, message: e.message, at: this.iso() };
        }
      }
    })().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }
  networkCount(id) {
    return this.db
      .prepare(
        "SELECT count(*) n FROM provider_recoveries WHERE session=? AND kind='network' AND state='recovered' AND at>?",
      )
      .get(id, this.iso(this.now() - 30 * 60_000)).n;
  }
  networkCurrent(r) {
    const current = this.store.get(r.session);
    const last = this.db
      .prepare(
        "SELECT id FROM deliveries WHERE session=? AND kind='send' AND state='delivered' ORDER BY rowid DESC LIMIT 1",
      )
      .get(r.session)?.id;
    return (
      current?.mode === "delegated" &&
      current.generation === r.generation &&
      last === r.lastInstruction
    );
  }
  retry(r, outcome) {
    const attempts = r.attempts + 1;
    if (attempts >= (r.kind === "network" ? NETWORK_BACKOFF_MS.length : MAX_ATTEMPTS))
      return this.finish(r.id, "failed", `${outcome}; gave up after ${attempts} attempts`);
    this.db
      .prepare("UPDATE provider_recoveries SET attempts=?,nextAt=?,outcome=?,at=? WHERE id=?")
      .run(
        attempts,
        this.iso(
          this.now() + (r.kind === "network" ? NETWORK_BACKOFF_MS[attempts] : BACKOFF_MS[attempts]),
        ),
        String(outcome).slice(0, 500),
        this.iso(),
        r.id,
      );
  }
  async due(row) {
    let r = row;
    const s = this.store.get(r.session);
    if (!s) return this.finish(r.id, "superseded", "The session is no longer enrolled");
    if (s.mode !== "delegated")
      return this.finish(r.id, "held", "Under human control; the controller does not restart it");
    if (s.generation !== r.generation)
      return this.finish(
        r.id,
        "superseded",
        "Session control changed since the failure was recorded",
      );
    if (
      r.kind === "network" &&
      (!(await this.networkEnabled(r.session)) || !this.networkCurrent(r))
    )
      return this.finish(
        r.id,
        "held",
        "Automatic resume is off or the interrupted instruction changed",
      );
    const a = await this.failure(r.session);
    if (classify(a) !== r.kind || String(a.lastError).slice(0, 1000) !== r.error) {
      this.finish(r.id, "superseded", "The session is no longer in that failure; nothing was done");
      this.db.prepare("UPDATE provider_recoveries SET cleared=1 WHERE id=?").run(r.id);
      return;
    }
    const today = this.db
      .prepare(
        "SELECT count(*) n FROM provider_recoveries WHERE session=? AND state='recovered' AND at>?",
      )
      .get(r.session, this.iso(this.now() - 86400000)).n;
    if (
      today >= MAX_RECOVERIES_PER_DAY ||
      (r.kind === "network" && this.networkCount(r.session) >= NETWORK_BACKOFF_MS.length)
    )
      return this.finish(
        r.id,
        "held-back",
        `Already restarted ${today} times in 24 h; left for a human`,
      );
    const rotation = r.kind === "quota" ? rotationOf(r.id, this.control) : null;
    if (r.kind === "quota" && !rotation?.to) {
      let decision;
      try {
        decision = quotaDecision(
          (await this.control.native.quota?.(r.session)) ?? null,
          undefined,
          this.now(),
        );
      } catch (e) {
        decision = { state: "unknown", reason: e.message };
      }
      if (decision.state !== "ready") {
        if (r.attempts + 1 >= QUOTA_MAX_POLLS)
          return this.finish(
            r.id,
            "failed",
            `Usage still not permitted after a day: ${decision.reason}`,
          );
        this.db
          .prepare(
            "UPDATE provider_recoveries SET attempts=attempts+1,nextAt=?,outcome=?,at=? WHERE id=?",
          )
          .run(
            this.iso(this.now() + QUOTA_POLL_MS),
            `waiting for usage: ${decision.reason}`.slice(0, 500),
            this.iso(),
            r.id,
          );
        return;
      }
      // Usage is permitted again: the polls were waiting, not failed restarts, so the restart attempts start from zero.
      this.db.prepare("UPDATE provider_recoveries SET attempts=0 WHERE id=?").run(r.id);
      r = { ...r, attempts: 0 };
    }
    if (typeof this.control.native.recover !== "function")
      return this.finish(
        r.id,
        "failed",
        "This controller’s native adapter cannot restart a session",
      );
    let result;
    try {
      result = rotation?.to
        ? await fencedRelaunch(this.control, r.session, r.generation, rotation.to, this.now)
        : await this.control.exclusive(r.session, async () => {
            const cur = this.store.get(r.session);
            if (cur?.mode !== "delegated" || cur.generation !== r.generation)
              throw Error("Session control changed");
            const observed = await this.control.native.inspect(r.session);
            if (
              observed.archivedAt ||
              (observed.boot ?? null) !== cur.boot ||
              observed.humanAt >= cur.grantedAt ||
              this.control.promptIdentityChanged(observed, cur)
            ) {
              this.control.takeover(
                r.session,
                "Native input identity changed before a provider restart; handback required",
                { observed, cause: this.control.recovery?.cause(cur, observed) },
              );
              throw Error("Human activity or changed identity revoked delegation");
            }
            if (
              r.kind === "network" &&
              (!(await this.networkEnabled(r.session)) || !this.networkCurrent(r))
            )
              throw Error("Automatic resume is off or the interrupted instruction changed");
            return this.control.native.recover(r.session);
          });
    } catch (e) {
      if (/revoked delegation|control changed/i.test(e.message))
        return this.finish(r.id, "held", e.message);
      return this.retry(r, `restart failed: ${e.message}`);
    }
    if (result?.outcome !== "refreshed")
      return this.retry(
        r,
        `the host refused the restart: ${result?.outcome ?? "no result"}${result?.reason ? " (" + result.reason + ")" : ""}`,
      );
    this.finish(
      r.id,
      "recovered",
      rotation?.to
        ? `Restarted in place with its history on account "${rotation.toName}"`
        : "Restarted in place with its history",
    );
    // H6/H7: the interrupted controller instruction is continued once, if it had not ended.
    if (r.kind === "refresh" || !r.lastInstruction) return;
    // The failure itself ended that turn (review H7: a failed turn may read as 'ended'), so it is continued once.
    try {
      const continuation = derived(r.id, "provider-recovery-continue");
      if (r.kind === "network") {
        if (!(await this.networkEnabled(r.session)) || !this.networkCurrent(r))
          throw Error("Automatic resume is off or the interrupted instruction changed");
        this.db
          .prepare("UPDATE provider_recoveries SET continuation=? WHERE id=?")
          .run(continuation, r.id);
      }
      const sent = await this.control.send(
        { sessionId: r.session, messageId: continuation, text: continuationText(r, rotation) },
        undefined,
        r.generation,
        {
          automated: "provider-recovery",
          check: () => {
            const cur = this.store.get(r.session);
            if (
              cur?.mode !== "delegated" ||
              cur.generation !== r.generation ||
              (r.kind === "network" && !this.networkCurrent(r))
            )
              throw Error("Session control changed");
          },
        },
      );
      this.finish(
        r.id,
        "recovered",
        `Restarted in place with its history; continuation ${sent.state}`,
        { continuation },
      );
    } catch (e) {
      this.finish(
        r.id,
        "recovered",
        `Restarted in place with its history; continuation not sent: ${e instanceof RecipientBusy ? "busy" : e.message}`,
      );
    }
  }
  status() {
    const rows = this.db
      .prepare(
        "SELECT * FROM provider_recoveries ORDER BY (state='waiting') DESC, rowid DESC LIMIT 64",
      )
      .all();
    return {
      waiting: rows.filter((r) => r.state === "waiting").length,
      recoveries: rows.map((r) => ({
        id: r.id,
        sessionId: r.session,
        provider: r.provider,
        kind: r.kind,
        error: r.error.slice(0, 200),
        state: r.state,
        attempts: r.attempts,
        nextAt: r.nextAt,
        continuation: r.continuation,
        outcome: r.outcome,
        at: r.at,
      })),
      error: this.lastError,
    };
  }
}
