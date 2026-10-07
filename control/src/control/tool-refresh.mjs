// H6 item 5 (G5). Which Orca tool surface each session runs, and bringing a seat's up to this release's.
//
// A session's surface is recorded at creation (the create result's toolSurface) and replaced by every successful
// refresh here. A session with neither -- every session created before H6 -- is 'unrecorded' and treated as stale.
//
// Surfaces refresh through native.refreshTools (the daemon's fenced agent.mcp.refresh):
//   - an operator asks: sessions-refresh-tools {sessionId, expectedGeneration};
//   - an operator reaffirms a seat whose holder is delegated (bindings.assign awaits it and reports it);
//   - a seat holder or manager is handed back (Controller.handback starts it after its lock is released).
//   - startup and idle events bring delegated sessions onto the current runtime after an upgrade.
// Automatic refreshes are best-effort: outcomes are recorded and reported. Handback/reaffirmation refresh seat
// holders and managers; runtime reconciliation also updates workers whose helper paths belong to an older build.
// The refresh runs under the session's exclusive lock, so no controller send interleaves with it, and it needs the
// session delegated and idle (the daemon's own admission refuses otherwise); nothing here grants anything.
import path from "node:path";
import { assertColumns } from "./schema.mjs";
import { uuid } from "./authority.mjs";
import { TOOL_SURFACE } from "./tool-surface.mjs";

export class ToolSurfaces {
  constructor(control) {
    this.control = control;
    this.store = control.store;
    this.db = this.store.db;
    this.pending = null;
    this.lastError = null;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS session_tool_surfaces(session TEXT PRIMARY KEY,surface TEXT,generation INTEGER,lastOutcome TEXT NOT NULL,lastReason TEXT,at TEXT NOT NULL)",
    );
    assertColumns(
      this.db,
      "session_tool_surfaces",
      "session,surface,generation,lastOutcome,lastReason,at",
    );
  }
  recorded(id) {
    const refreshed = this.db
      .prepare("SELECT surface FROM session_tool_surfaces WHERE session=? AND surface IS NOT NULL")
      .get(id)?.surface;
    if (refreshed) return refreshed;
    const created = this.db
      .prepare(
        "SELECT result FROM deliveries WHERE kind='create' AND state='delivered' AND json_extract(result,'$.id')=?",
      )
      .get(id);
    return created ? (JSON.parse(created.result).toolSurface ?? null) : null;
  }
  describe(id) {
    const recorded = this.recorded(id),
      last =
        this.db
          .prepare("SELECT lastOutcome,lastReason,at FROM session_tool_surfaces WHERE session=?")
          .get(id) ?? null;
    return {
      current: TOOL_SURFACE,
      recorded,
      state: recorded === TOOL_SURFACE ? "current" : recorded ? "stale" : "unrecorded",
      lastAttempt: last
        ? { outcome: last.lastOutcome, reason: last.lastReason, at: last.at }
        : null,
    };
  }
  record(id, generation, outcome, reason, surface) {
    this.db
      .prepare(`INSERT INTO session_tool_surfaces VALUES (?,?,?,?,?,?) ON CONFLICT(session) DO UPDATE SET
      surface=coalesce(excluded.surface,surface),generation=excluded.generation,lastOutcome=excluded.lastOutcome,lastReason=excluded.lastReason,at=excluded.at`)
      .run(
        id,
        surface ?? null,
        generation,
        outcome,
        reason ? String(reason).slice(0, 500) : null,
        new Date().toISOString(),
      );
  }
  // The operator route and the one the automatic paths use.
  async refresh(id, { expectedGeneration, cause = "operator" } = {}) {
    if (
      !uuid(id) ||
      (expectedGeneration !== undefined && !Number.isSafeInteger(expectedGeneration))
    )
      throw Error("Invalid tool refresh");
    if (typeof this.control.native?.refreshTools !== "function")
      throw Error("This controller’s native adapter cannot refresh tool surfaces");
    return this.control.exclusive(id, async () => {
      const s = this.store.get(id);
      if (!s) throw Error("Session not enrolled");
      if (expectedGeneration !== undefined && s.generation !== expectedGeneration)
        throw Error("Control changed; refresh before refreshing tools");
      if (s.mode !== "delegated")
        throw Error(
          "A tool refresh needs the session under delegated control; hand it back first (a handback of a seat refreshes it)",
        );
      const messageId = path.basename(s.cwd);
      if (!uuid(messageId))
        throw Error(
          "This session has no controller-created identity to derive its grant paths from",
        );
      const previous = this.describe(id);
      let result;
      try {
        result = await this.control.native.refreshTools(id, messageId);
      } catch (e) {
        this.record(id, s.generation, "failed", `${cause}: ${e.message}`, null);
        // H7 item 4: a failed refresh must not leave the agent in explicit close recovery. Its restart is queued now
        // (provider-recovery.mjs records it if the daemon left the session in that state); not awaited, since the
        // restart takes this session's lock, held until we return. A daemon update would queue it too.
        void this.control.providerRecovery?.observe(id);
        throw e;
      }
      this.record(id, s.generation, result.outcome, cause, result.surface);
      return {
        sessionId: id,
        outcome: result.outcome,
        surface: result.surface,
        previous: previous.recorded,
        previousState: previous.state,
        cause,
        grantsAuthority: false,
      };
    });
  }
  // Seat holders and managers only; a session already on this release's surface is left alone.
  eligible(id) {
    const s = this.store.get(id);
    if (!s || s.mode !== "delegated" || this.describe(id).state === "current") return false;
    const seat = this.db
      .prepare("SELECT 1 FROM role_bindings WHERE session=? AND state='assigned'")
      .get(id);
    const manager =
      this.has("manager_grants") &&
      this.db
        .prepare("SELECT 1 FROM manager_grants WHERE supervisor=? AND generation=?")
        .get(id, s.generation);
    return Boolean(seat || manager);
  }
  has(t) {
    return Boolean(
      this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t),
    );
  }
  // Best-effort: never throws; the outcome is in the record and in describe().
  async automatic(id, cause) {
    if (!this.eligible(id)) return null;
    try {
      return await this.refresh(id, { cause });
    } catch (e) {
      this.lastError = { message: e.message, at: new Date().toISOString() };
      return { sessionId: id, outcome: "failed", reason: e.message, cause, grantsAuthority: false };
    }
  }
  afterDelegation(id) {
    if (!this.eligible(id)) return null;
    return (this.pending = this.automatic(id, "handback"));
  }
  // Existing event reconciliation supplies retries; never reload a human-held or busy session.
  // A refusal is visible, and is retried at most once per watchdog interval.
  async reconcile() {
    const candidates = this.store
      .list()
      .filter((session) => session.mode === "delegated")
      .map((session) => ({ session, surface: this.describe(session.id) }))
      .filter(
        ({ surface }) =>
          surface.state !== "current" &&
          (!surface.lastAttempt || Date.now() - Date.parse(surface.lastAttempt.at) >= 30000),
      )
      .sort(
        (a, b) =>
          (Date.parse(a.surface.lastAttempt?.at) || 0) -
          (Date.parse(b.surface.lastAttempt?.at) || 0),
      )
      .slice(0, 8);
    for (const { session } of candidates) {
      try {
        await this.refresh(session.id, {
          expectedGeneration: session.generation,
          cause: "runtime",
        });
      } catch (error) {
        if (this.store.get(session.id)?.generation === session.generation)
          this.record(session.id, session.generation, "failed", `runtime: ${error.message}`, null);
        this.lastError = { message: error.message, at: new Date().toISOString() };
      }
    }
  }
}
