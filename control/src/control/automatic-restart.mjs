import { bindBootstrapAfterRestart } from "./native-bootstrap.mjs";
import { childId, resumeGate } from "./recovery.mjs";
import { assertColumns } from "./schema.mjs";
import { bootChainVerdict } from "./boot-chain.mjs";

export const RESTART_SETTLE_MS = 30000,
  RESTART_STAGGER_MS = 3000,
  RESTART_ATTEMPTS = 3;
const COLUMNS =
  "id,interruption,session,generation,previousBoot,boot,state,attempts,nextAt,continuation,outcome,at";
const REASON = "Automatically continue the confirmed turn interrupted by a clean host restart";

// A restart revokes first. Only the journaled original delegation plus a sealed human-input chain can
// authorise its recovery. No external instruction is replayed, and an unsealed crash remains held.
export class AutomaticRestarts {
  constructor(control, { now = Date.now, currentBoot, timers = true } = {}) {
    this.control = control;
    this.store = control.store;
    this.db = this.store.db;
    this.now = now;
    this.currentBoot = currentBoot;
    this.timers = timers;
    this.settleAt = now() + RESTART_SETTLE_MS;
    this.dispatchAfter = this.settleAt;
    this.ticking = null;
    this.timer = null;
    this.stopped = false;
    this.lastError = null;
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS automatic_restart_resumes(id TEXT PRIMARY KEY,interruption TEXT UNIQUE NOT NULL,session TEXT NOT NULL,generation INTEGER NOT NULL,previousBoot TEXT NOT NULL,boot TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL,nextAt TEXT,continuation TEXT NOT NULL,outcome TEXT,at TEXT NOT NULL);`,
    );
    assertColumns(this.db, "automatic_restart_resumes", COLUMNS);
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS automatic_restart_once ON automatic_restart_resumes(session,boot)",
    );
  }
  alive() {
    if (this.stopped || this.control.closing)
      throw Error("Controller is closing; restart continuation withheld");
  }
  row(id) {
    return this.db.prepare("SELECT * FROM automatic_restart_resumes WHERE id=?").get(id);
  }
  iso(t = this.now()) {
    return new Date(t).toISOString();
  }
  finish(id, state, outcome, nextAt = null) {
    this.db
      .prepare("UPDATE automatic_restart_resumes SET state=?,outcome=?,nextAt=?,at=? WHERE id=?")
      .run(state, String(outcome).slice(0, 500), nextAt, this.iso(), id);
    this.control.recovery.invalidate();
  }
  proof(i, session, current) {
    this.alive();
    const mark = i?.observed?.interruptedTurn;
    if (
      !i ||
      i.cause !== "boot" ||
      !i.previousBoot ||
      i.previousBoot === i.observedBoot ||
      !mark ||
      !["running", "initializing"].includes(mark.previousStatus) ||
      !i.expectedAt ||
      mark.lastUserMessageAt !== i.expectedAt ||
      !current?.interruptedTurn ||
      current.interruptedTurn.lastUserMessageAt !== i.expectedAt ||
      current.interruptedTurn.previousStatus !== mark.previousStatus
    )
      throw Error("No confirmed interrupted controller turn; automatic restart recovery withheld");
    if ((i.observed.pending ?? 0) > 0)
      throw Error(
        "The interrupted session was waiting on a permission decision; human recovery required",
      );
    if (
      !i.observed.nativeId ||
      current.nativeId !== i.observed.nativeId ||
      current.boot !== i.observedBoot
    )
      throw Error("Native session or boot changed since the interrupted turn");
    const dispatch = this.store.delivery(i.expected);
    if (
      !dispatch ||
      dispatch.id !== i.lastDispatch?.id ||
      dispatch.kind !== "send" ||
      dispatch.session !== i.session ||
      dispatch.state !== "delivered" ||
      dispatch.result?.generation !== i.fromGeneration ||
      dispatch.result?.outputContext?.boot !== i.previousBoot
    )
      throw Error(
        "The original controller dispatch is not acknowledged at the original delegation",
      );
    const verdict = resumeGate(
      i,
      session,
      current,
      this.control.recovery.facts(i, session, i.toGeneration),
    );
    if (!verdict.allow) throw Error(verdict.reason);
    if (!this.control.bootChainDir)
      throw Error("No owned sealed boot chain; automatic recovery requires human-input proof");
    const chain = bootChainVerdict({
      dir: this.control.bootChainDir,
      currentBoot: current.boot,
      grantBoot: i.previousBoot,
      grantedAt: i.grantedAt,
      session: i.session,
    });
    if (chain.state !== "clean") throw Error("Restart recovery held: " + chain.reason);
    if (
      this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_bootstrap'")
        .get()
    )
      bindBootstrapAfterRestart(this.db, {
        session: i.session,
        delivery: dispatch.id,
        previousBoot: i.previousBoot,
        nativeId: current.nativeId,
      });
    return {
      state: "clean",
      previousBoot: i.previousBoot,
      boot: current.boot,
      path: chain.path,
      nativeId: current.nativeId,
      interruptedTurn: mark,
      delivery: dispatch.id,
      fromGeneration: i.fromGeneration,
      toGeneration: i.toGeneration,
    };
  }
  async discover() {
    const boot = this.currentBoot?.();
    if (!boot) return;
    // Observe through the existing takeover path: a boot change still revokes every old delegation.
    const stale = this.store
      .list()
      .map(({ id }) => this.store.get(id))
      .filter((s) => s.mode === "delegated" && s.boot && s.boot !== boot);
    if (stale.length > 1000) {
      this.lastError = {
        message: "More than 1000 stale delegations; automatic restart discovery requires a human",
        at: this.iso(),
      };
      return;
    }
    for (const s of stale) {
      this.alive();
      try {
        const snapshot = await this.control.native.snapshot(s.id);
        if (
          snapshot.interruptedTurn?.lastUserMessageAt === s.expectedAt &&
          ["running", "initializing"].includes(snapshot.interruptedTurn?.previousStatus)
        )
          await this.control.inspect(s.id);
      } catch (error) {
        this.lastError = { message: error.message, at: this.iso() };
      }
    }
    const interruptions = this.db
      .prepare(
        "SELECT * FROM session_interruptions WHERE state='open' AND cause='boot' ORDER BY rowid LIMIT 64",
      )
      .all();
    for (const raw of interruptions) {
      this.alive();
      if (!raw.previousBoot || !raw.observedBoot) continue;
      if (this.db.prepare("SELECT count(*) n FROM automatic_restart_resumes").get().n >= 1000) {
        this.lastError = {
          message: "Automatic restart history is full; recovery requires a human",
          at: this.iso(),
        };
        break;
      }
      const id = childId(raw.id, "automatic-restart");
      this.db
        .prepare(
          "INSERT OR IGNORE INTO automatic_restart_resumes VALUES (?,?,?,?,?,?,'ready',0,?,?,NULL,?)",
        )
        .run(
          id,
          raw.id,
          raw.session,
          raw.toGeneration,
          raw.previousBoot,
          raw.observedBoot,
          this.iso(Math.max(this.settleAt, Date.parse(raw.at) + RESTART_SETTLE_MS)),
          childId(id, "continuation"),
          this.iso(),
        );
    }
  }
  async due(row) {
    this.alive();
    if (
      typeof this.control.native.automaticResumeEnabled !== "function" ||
      !(await this.control.native.automaticResumeEnabled(row.session))
    )
      return this.finish(
        row.id,
        "declined",
        "Automatic resume was off after the restart; resume this session by hand",
      );
    const snapshot = await this.control.native.snapshot(row.session);
    this.alive();
    if (snapshot.labels?.["fulcra.limit-resume"] === "off")
      return this.finish(row.id, "declined", "This session opted out of automatic resume");
    const prior = this.store.delivery(row.id);
    if (
      prior &&
      !(
        prior.state === "delivered" &&
        prior.result?.automaticRestartProof &&
        prior.result.continuation?.state === "pending"
      )
    )
      return this.finish(
        row.id,
        "failed",
        "A previous resume operation is settled or uncertain; it will not be replayed",
      );
    if (!prior) {
      const i = this.control.recovery.row(row.interruption);
      const current = await this.control.native.inspect(row.session);
      this.alive();
      try {
        this.proof(i, this.store.get(row.session), current);
      } catch (error) {
        return this.finish(row.id, "held", error.message);
      }
    }
    if (row.attempts >= RESTART_ATTEMPTS)
      return this.finish(row.id, "failed", "Automatic restart retry budget exhausted");
    this.db
      .prepare(
        "UPDATE automatic_restart_resumes SET state='inflight',attempts=attempts+1,at=? WHERE id=?",
      )
      .run(this.iso(), row.id);
    const assertRow = () => {
      this.alive();
      const current = this.row(row.id);
      if (current?.state !== "inflight" || current.continuation !== row.continuation)
        throw Error("Automatic restart operation changed");
    };
    try {
      const result = await this.control.recovery.resume(
        {
          sessionId: row.session,
          interruptionId: row.interruption,
          expectedGeneration: row.generation,
          messageId: row.id,
          reason: REASON,
        },
        {
          automaticCheck: (i, s, current) => {
            assertRow();
            return this.proof(i, s, current);
          },
          continuationCheck: (resume) => {
            assertRow();
            const interruption = this.control.recovery.row(row.interruption),
              s = this.store.get(row.session);
            if (
              interruption?.state !== "resumed" ||
              interruption.resolution?.by !== "automatic-restart" ||
              interruption.resolution.messageId !== row.id ||
              s?.mode !== "delegated" ||
              s.generation !== resume.result.generation ||
              s.boot !== row.boot
            )
              throw Error("Original automatic restart authority changed before continuation");
          },
        },
      );
      const state = result.result?.continuation?.state;
      if (state === "delivered")
        this.finish(
          row.id,
          "resumed",
          "One restart continuation acknowledged; task completion remains unproven",
        );
      else if (state === "pending" && row.attempts + 1 < RESTART_ATTEMPTS)
        this.finish(
          row.id,
          "ready",
          "Continuation busy; retrying the same durable identity",
          this.iso(this.now() + RESTART_SETTLE_MS),
        );
      else
        this.finish(
          row.id,
          "failed",
          `Continuation ${state ?? result.state}; explicit recovery required`,
        );
    } catch (error) {
      this.finish(row.id, "failed", error.message);
    }
    this.dispatchAfter = this.now() + RESTART_STAGGER_MS;
  }
  tick() {
    if (this.stopped || this.control.closing) return Promise.resolve();
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      await this.discover();
      if (this.now() < Math.max(this.settleAt, this.dispatchAfter)) return;
      const row = this.db
        .prepare(
          "SELECT * FROM automatic_restart_resumes WHERE (state IN ('ready','inflight') OR (state='held' AND attempts=0)) AND (nextAt IS NULL OR nextAt<=?) ORDER BY coalesce(nextAt,at),rowid LIMIT 1",
        )
        .get(this.iso());
      if (row) await this.due(row);
    })()
      .catch((error) => {
        this.lastError = { message: error.message, at: this.iso() };
      })
      .finally(() => {
        this.ticking = null;
        this.schedule();
      });
    return this.ticking;
  }
  schedule() {
    if (!this.timers || this.stopped || this.control.closing || this.timer) return;
    const due = this.db
      .prepare(
        "SELECT min(nextAt) at FROM automatic_restart_resumes WHERE state='ready' AND nextAt IS NOT NULL",
      )
      .get().at;
    if (!due) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.tick();
      },
      Math.max(
        1,
        Date.parse(due) - this.now(),
        this.settleAt - this.now(),
        this.dispatchAfter - this.now(),
      ),
    );
    this.timer.unref();
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    await this.ticking;
  }
  status() {
    return {
      items: this.db
        .prepare("SELECT * FROM automatic_restart_resumes ORDER BY rowid DESC LIMIT 64")
        .all(),
      error: this.lastError,
    };
  }
}
