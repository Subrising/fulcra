import { reconcileBootstrap } from "./native-bootstrap.mjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertColumns } from "./schema.mjs";

export const COMPACTION_WINDOW_MS = 10 * 60_000;
export const COMPACTION_STALL_MS = 15 * 60_000;
export const COMPACTION_COUNT = 3;
export const MAX_CONTEXT_ROTATIONS_PER_DAY = 2;
// Fresh start (UX round 2): a lead also starts fresh when its provider-reported context passes this share of the
// window, but only while idle, and at most once per cool-down. Both count toward the same daily cap.
export const CONTEXT_FRESH_START_RATIO = 0.6;
export const FRESH_START_COOLDOWN_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Why the context trigger would fire, or null. Never mid-turn, never while a provider subagent (background work)
 * or a permission prompt is open, and only on the provider's own reported numbers.
 */
export function idleUsage(usage) {
  return Boolean(
    usage && usage.status === "idle" && !(usage.background > 0) && !(usage.pending > 0),
  );
}
export function contextTrigger(usage) {
  if (!idleUsage(usage)) return null;
  const used = Number(usage.used),
    limit = Number(usage.limit);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0 || used < 0) return null;
  const ratio = used / limit;
  return ratio >= CONTEXT_FRESH_START_RATIO
    ? `Context reached ${Math.round(ratio * 100)}% of the window`
    : null;
}

/**
 * The main assistant routes; project detail stays with each lead. Its handoff carries only a short board: one line
 * per project lead from the recorded role bindings. Null for any other session.
 */
export function mainAssistantBoard(bindings, store, sessionId) {
  if (!bindings?.primes || !bindings?.directory) return null;
  if (!bindings.primes().some((p) => p.state === "assigned" && p.sessionId === sessionId))
    return null;
  return bindings
    .directory()
    .bindings.filter((b) => b.role === "project-orchestrator" && b.state === "assigned")
    .slice(0, 32)
    .map((b) => {
      const lead = b.sessionId ? store.get(b.sessionId) : null;
      return {
        projectId: b.projectId,
        leadSessionId: b.sessionId,
        lead: !lead ? "missing" : lead.mode === "delegated" ? "with Fulcra" : "held by you",
      };
    });
}

const CONTINUATION = {
  compaction:
    "The controller stopped a compaction loop and started a fresh provider context under this same Paseo conversation.",
  context:
    "Your context was getting full, so the controller started a fresh provider context under this same Paseo conversation.",
  manual:
    "You asked for a fresh start, so the controller started a fresh provider context under this same Paseo conversation.",
};

// Only canonical provider compaction rows count. Row starts deduplicate loading/completed updates.
// Model text about compaction, quota and token estimates have no effect.
export function observeCompactions(saved, page, now) {
  if (page.error || page.gap || page.reset || page.staleCursor || !page.epoch)
    throw Error("Compaction timeline continuity unavailable");
  if (!saved || saved.epoch !== page.epoch) {
    const tail = page.entries.at(-1);
    // Historical completions are a baseline. A current loading row starts a new wall-clock
    // observation, so an already-stuck running compaction is eventually stopped after restart.
    const open =
      page.status === "running" &&
      tail?.item?.type === "compaction" &&
      tail.item.status === "loading"
        ? { seq: tail.seqStart, at: now, manual: tail.item.trigger === "manual" }
        : null;
    return { epoch: page.epoch, seq: page.maxSeq, seen: [], open, recent: [], preview: "" };
  }
  const state = structuredClone(saved);
  for (const e of [...page.entries].sort((a, b) => a.seqStart - b.seqStart)) {
    if (e.seqEnd <= state.seq) continue;
    const item = e.item;
    if (item?.type === "compaction") {
      const unseen = !state.seen.includes(e.seqStart);
      if (unseen) state.seen.push(e.seqStart);
      // Native adapters emit separate loading/completed rows; they are one operation.
      // Repeated loading statuses while open are observations of the same operation.
      if (item.status === "loading" && !state.open) {
        state.open = { seq: e.seqStart, at: now, manual: item.trigger === "manual" };
        if (unseen && !state.open.manual) state.recent.push(now);
      } else if (item.status === "completed") {
        if (!state.open && unseen && item.trigger !== "manual") state.recent.push(now);
        state.open = null;
      }
    } else if (
      item?.type === "user_message" ||
      item?.type === "tool_call" ||
      (item?.type === "assistant_message" && String(item.text ?? "").trim())
    ) {
      state.recent = [];
      state.open = null;
      if (item.type === "assistant_message") state.preview = String(item.text).slice(-3000);
    }
    state.seq = Math.max(state.seq, e.seqEnd);
  }
  state.seen = state.seen.slice(-64);
  state.recent = state.recent
    .filter((at) => now - at <= COMPACTION_WINDOW_MS)
    .slice(-COMPACTION_COUNT);
  // A short page can be behind the live end. Advance only through rows actually read.
  state.reason =
    state.recent.length >= COMPACTION_COUNT
      ? "Repeated compaction without useful output"
      : state.open &&
          !state.open.manual &&
          now - state.open.at >= COMPACTION_STALL_MS &&
          page.status === "running"
        ? "Compaction did not finish within 15 minutes"
        : null;
  return state;
}

export function writeCompactionHandoff(directory, id, value) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(directory) !== directory) throw Error("Handoff directory contains a symlink");
  const file = path.join(directory, `${id}.json`);
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const dir = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
  return file;
}

export class CompactionLoops {
  constructor(control, { home, now = Date.now } = {}) {
    this.control = control;
    this.db = control.store.db;
    this.home = home;
    this.now = now;
    this.flights = new Map();
    this.ticking = null;
    this.stopped = false;
    this.lastError = null;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS compaction_observations(session TEXT PRIMARY KEY,generation INTEGER NOT NULL,observation TEXT NOT NULL); CREATE TABLE IF NOT EXISTS context_rotations(id TEXT PRIMARY KEY,session TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,handoff TEXT,outcome TEXT,at INTEGER NOT NULL,previous TEXT,current TEXT)",
    );
    assertColumns(this.db, "compaction_observations", "session,generation,observation");
    assertColumns(
      this.db,
      "context_rotations",
      "id,session,generation,state,handoff,outcome,at,previous,current",
    );
  }
  onAgent(a) {
    return a?.id ? this.observe(a.id) : null;
  }
  observe(id) {
    if (this.stopped || this.control.closing || this.flights.has(id)) return this.flights.get(id);
    const s = this.control.store.get(id);
    if (s?.mode !== "delegated" || this.control.native.route?.(id)) return null;
    const flight = this.once(id)
      .catch((e) => {
        this.lastError = { sessionId: id, message: e.message, at: this.now() };
      })
      .finally(() => this.flights.delete(id));
    this.flights.set(id, flight);
    return flight;
  }
  async once(id) {
    const s = this.control.store.get(id);
    const old = this.db.prepare("SELECT * FROM compaction_observations WHERE session=?").get(id);
    const saved = old?.generation === s.generation ? JSON.parse(old.observation) : null;
    const page = await this.control.native.compactionTail?.(
      id,
      saved ? { epoch: saved.epoch, seq: saved.seq } : null,
    );
    if (this.stopped || this.control.closing) return;
    if (!page) return this.contextCheck(s, saved);
    const cur = this.control.store.get(id);
    if (cur?.mode !== "delegated" || cur.generation !== s.generation) return;
    const observed = observeCompactions(saved, page, this.now());
    this.db
      .prepare("INSERT OR REPLACE INTO compaction_observations VALUES (?,?,?)")
      .run(id, s.generation, JSON.stringify(observed));
    if (!observed.reason || page.hasNewer) return;
    const prior = this.db
      .prepare(
        "SELECT * FROM context_rotations WHERE session=? AND generation=? ORDER BY at DESC LIMIT 1",
      )
      .get(id, s.generation);
    if (prior && !["rotated"].includes(prior.state)) return; // ambiguous/failing operations are never replayed
    await this.rotate(s, observed);
  }
  latestRotation(id, generation) {
    return this.db
      .prepare(
        "SELECT * FROM context_rotations WHERE session=? AND generation=? ORDER BY at DESC LIMIT 1",
      )
      .get(id, generation);
  }
  rotatedToday(id) {
    return this.db
      .prepare(
        "SELECT count(*) n FROM context_rotations WHERE session=? AND state='rotated' AND at>?",
      )
      .get(id, this.now() - 86_400_000).n;
  }
  /** The idle-time context trigger. Never pauses at the daily cap; it simply waits for tomorrow. */
  async contextCheck(s, saved) {
    const usage = await this.control.native.contextUsage?.(s.id);
    if (!usage || this.stopped || this.control.closing) return;
    const reason = contextTrigger(usage);
    if (!reason) return;
    const cur = this.control.store.get(s.id);
    if (cur?.mode !== "delegated" || cur.generation !== s.generation) return;
    const prior = this.latestRotation(s.id, s.generation);
    if (prior && prior.state !== "rotated") return; // ambiguous/failing operations are never replayed
    if (prior && this.now() - prior.at < FRESH_START_COOLDOWN_MS) return;
    // Usage survives a rotation until the next turn, so only a turn started after it counts.
    if (prior && !(Date.parse(usage.lastUserMessageAt ?? "") > prior.at)) return;
    if (this.rotatedToday(s.id) >= MAX_CONTEXT_ROTATIONS_PER_DAY) return;
    await this.rotate(s, { ...saved, reason }, { trigger: "context" });
  }
  /**
   * Fresh start from the app (operator-only RPC session-fresh-start). Same rotate() path and fences as a compaction
   * rotation; the messageId is the rotation id, so a retried request reports the recorded outcome and never rotates
   * twice. A human-held, busy, remote or uncertain session is refused in plain words.
   */
  async freshStart(a) {
    if (
      !a ||
      !UUID.test(a.messageId ?? "") ||
      !UUID.test(a.sessionId ?? "") ||
      typeof a.reason !== "string" ||
      a.reason.trim().length < 12
    )
      throw Error("Invalid fresh start");
    const recorded = (row) => ({ state: row.state, outcome: row.outcome ?? null });
    const existing = this.db.prepare("SELECT * FROM context_rotations WHERE id=?").get(a.messageId);
    if (existing) {
      if (existing.session !== a.sessionId) throw Error("Fresh start id already used");
      return recorded(existing);
    }
    const refused = (error) => ({ state: "refused", error });
    if (this.stopped || this.control.closing) return refused("Fulcra is shutting down.");
    const s = this.control.store.get(a.sessionId);
    if (!s) return refused("That session is not saved here.");
    if (s.mode !== "delegated")
      return refused(
        "This session is under your direct control. Hand it back before a fresh start.",
      );
    if (this.control.native.route?.(s.id))
      return refused("This session runs on another computer. Start it fresh there.");
    if (this.flights.has(s.id))
      return refused("A check is running for this session. Try again shortly.");
    // Registered before the first await, so a double tap or the automatic check cannot start a second rotation.
    const flight = (async () => {
      const usage = await this.control.native.contextUsage?.(s.id);
      if (!usage) return refused("This session could not be read.");
      if (!idleUsage(usage)) return refused("It is working right now. Try again when it is idle.");
      // A held row may hide a rotation the host did make, so it is never retried, even by hand. A refused row
      // is the host's definite "nothing happened", so a retry is safe.
      const prior = this.latestRotation(s.id, s.generation);
      if (prior && !["rotated", "refused"].includes(prior.state))
        return refused(
          "An earlier fresh start has no confirmed result yet; it is held for review.",
        );
      if (this.rotatedToday(s.id) >= MAX_CONTEXT_ROTATIONS_PER_DAY)
        return refused(`Fresh start limit reached for today (${MAX_CONTEXT_ROTATIONS_PER_DAY}).`);
      const old = this.db
        .prepare("SELECT * FROM compaction_observations WHERE session=?")
        .get(s.id);
      const saved = old?.generation === s.generation ? JSON.parse(old.observation) : {};
      await this.rotate(
        s,
        { ...saved, reason: `Fresh start requested: ${a.reason.trim()}`.slice(0, 500) },
        { rotationId: a.messageId, trigger: "manual" },
      );
      const row = this.db.prepare("SELECT * FROM context_rotations WHERE id=?").get(a.messageId);
      return row ? recorded(row) : refused(this.lastError?.message ?? "Fresh start was refused.");
    })().finally(() => this.flights.delete(s.id));
    this.flights.set(s.id, flight);
    return flight;
  }
  async rotate(s, observed, { rotationId = randomUUID(), trigger = "compaction" } = {}) {
    const control = this.control;
    let pauseOnly = false;
    const check = () => {
      const cur = control.store.get(s.id);
      if (
        this.stopped ||
        control.closing ||
        cur?.mode !== "delegated" ||
        cur.generation !== s.generation ||
        cur.boot !== s.boot ||
        cur.grantedAt !== s.grantedAt ||
        cur.expected !== s.expected ||
        cur.authority !== s.authority
      )
        throw Error("Original compaction ownership changed");
    };
    try {
      await control.exclusive(s.id, async () => {
        check();
        const rotated = this.rotatedToday(s.id);
        // Manual and context starts never pause and need the session idle at the moment of rotation.
        if (trigger !== "compaction") {
          if (rotated >= MAX_CONTEXT_ROTATIONS_PER_DAY)
            throw Error("Daily fresh start limit reached");
          const usage = await control.native.contextUsage?.(s.id);
          check();
          if (!usage || !idleUsage(usage) || (trigger === "context" && !contextTrigger(usage)))
            throw Error("Session is no longer idle below its context check; not rotated");
        } else pauseOnly = rotated >= MAX_CONTEXT_ROTATIONS_PER_DAY;
        const before = await control.native.inspect(s.id);
        check();
        if (
          before.archivedAt ||
          before.boot !== s.boot ||
          before.humanAt >= s.grantedAt ||
          control.promptIdentityChanged(before, s)
        )
          throw Error("Human input or changed native identity; rotation refused");
        // The first-delivery binding is normally completed by the next controller send. Complete it now, from this
        // observation of the original runtime, because after the rotation that runtime no longer exists.
        reconcileBootstrap(this.db, before);
        const snapshot = await control.native.snapshot(s.id);
        const expected = await control.native.contextRotationState(s.id);
        check();
        if (
          !expected?.sessionId ||
          expected.sessionId !== before.nativeId ||
          snapshot.cwd !== s.cwd
        )
          throw Error("Original provider context unavailable");
        const last = this.db
          .prepare(
            "SELECT id,body FROM deliveries WHERE session=? AND kind='send' AND state='delivered' ORDER BY rowid DESC LIMIT 1",
          )
          .get(s.id);
        const handoff = writeCompactionHandoff(
          path.join(this.home, "context-handoffs"),
          rotationId,
          {
            rotationId,
            sessionId: s.id,
            taskId: s.task,
            cwd: s.cwd,
            generation: s.generation,
            reason: observed.reason,
            trigger,
            instructionId: last?.id ?? null,
            instruction: last ? JSON.parse(last.body).text : null,
            recentOutput: observed.preview ?? "",
            timeline: { epoch: observed.epoch ?? null, seq: observed.seq ?? null },
            board: mainAssistantBoard(control.bindings, control.store, s.id),
            previousPersistence: snapshot.persistence,
            parent:
              snapshot.labels?.["fulcra.parent-session"] ??
              snapshot.labels?.["paseo.parent-agent-id"] ??
              null,
            note: "History remains in the original Paseo conversation. Check files, git log and receipts before repeating any external action.",
          },
        );
        this.db
          .prepare("INSERT INTO context_rotations VALUES (?,?,?,'rotating',?,?,?, ?,NULL)")
          .run(
            rotationId,
            s.id,
            s.generation,
            handoff,
            observed.reason,
            this.now(),
            expected.sessionId,
          );
        check();
        const reply = await control.native.rotateContext({
          agentId: s.id,
          rotationId,
          expected: {
            provider: expected.provider,
            sessionId: expected.sessionId,
            configRevision: expected.configRevision,
          },
          ...(pauseOnly ? { pauseOnly: true } : {}),
        });
        check();
        if (
          reply.rotationId !== rotationId ||
          reply.previousSessionId !== expected.sessionId ||
          (reply.outcome === "rotated" &&
            (!reply.sessionId || reply.sessionId === expected.sessionId))
        )
          throw Error("Context rotation receipt mismatch");
        this.db
          .prepare("UPDATE context_rotations SET state=?,outcome=?,current=? WHERE id=?")
          .run(
            reply.outcome,
            reply.reason ??
              (pauseOnly
                ? "Rotation limit reached; stopped for review"
                : "Fresh provider context; retained conversation history"),
            reply.sessionId,
            rotationId,
          );
        if (reply.outcome !== "rotated") return;
        // The rotation's own continuation is admitted against the fresh native session, so the binding moves with it.
        this.db
          .prepare("UPDATE native_bootstrap SET nativeId=? WHERE session=? AND nativeId=?")
          .run(reply.sessionId, s.id, expected.sessionId);
        // The interrupted instruction can never complete on the old native context. Settle its
        // pending parent events so the link is not faulted; the continuation below is tracked afresh.
        if (
          this.db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='event_pending'")
            .get()
        )
          this.db
            .prepare(
              "UPDATE event_pending SET state='not-delivered' WHERE worker=? AND generation=? AND native=? AND state='pending'",
            )
            .run(s.id, s.generation, expected.sessionId);
        this.db
          .prepare(
            "UPDATE compaction_observations SET observation=? WHERE session=? AND generation=?",
          )
          .run(
            JSON.stringify({ ...observed, seen: [], recent: [], open: null, reason: null }),
            s.id,
            s.generation,
          );
      });
      if (
        this.db.prepare("SELECT state FROM context_rotations WHERE id=?").get(rotationId)?.state !==
        "rotated"
      )
        return;
      check();
      const row = this.db
        .prepare("SELECT handoff FROM context_rotations WHERE id=?")
        .get(rotationId);
      // This is a new journaled controller instruction under the original generation, through every normal send fence.
      await control.send(
        {
          sessionId: s.id,
          messageId: rotationId,
          text: `${CONTINUATION[trigger] ?? CONTINUATION.compaction} Read the private file-backed handoff at ${row.handoff}. Resume the recorded task from the artifacts and retained conversation history. Verify receipts and git state before repeating any external action.${mainAssistantBoard(control.bindings, control.store, s.id) ? " You are the main assistant: route work to project leads and keep only the short board from the handoff; project detail stays with each lead." : ""}`,
        },
        undefined,
        s.generation,
        { automated: "context-rotation", check },
      );
    } catch (e) {
      this.db
        .prepare(
          "UPDATE context_rotations SET state=CASE WHEN state='rotated' THEN 'rotated' ELSE 'held' END,outcome=? WHERE id=?",
        )
        .run(`Stopped for review: ${e.message}`.slice(0, 500), rotationId);
      this.lastError = { sessionId: s.id, message: e.message, at: this.now() };
    }
  }
  tick() {
    if (this.stopped || this.control.closing) return;
    return (this.ticking ??= (async () => {
      for (const { id } of this.db
        .prepare("SELECT id FROM sessions WHERE mode='delegated' ORDER BY rowid DESC LIMIT 64")
        .all())
        await this.observe(id);
    })().finally(() => {
      this.ticking = null;
    }));
  }
  async stop() {
    this.stopped = true;
    await Promise.allSettled([this.ticking, ...this.flights.values()]);
  }
  status() {
    return {
      // The app shows Fresh start only when this is true (control/orca-organization/client/fresh-start.ts).
      freshStart: true,
      contextTrigger: CONTEXT_FRESH_START_RATIO,
      rotations: this.db
        .prepare(
          "SELECT id,session AS sessionId,state,handoff,outcome,at,previous AS previousSessionId,current AS sessionIdAfter FROM context_rotations ORDER BY at DESC LIMIT 64",
        )
        .all(),
      error: this.lastError,
    };
  }
}
