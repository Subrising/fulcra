// Track 1 (CONTROLLER-STALLS-PLAN) test data: a seeded, multi-task journal with every table the management reads and
// Controller.history() touch -- sessions in several tasks and modes, thousands of deliveries (creates carry their taskId in
// the body), management requests, root and child routine grants (some revoked, some stale), permission intents in every
// state (routine and question pools), manager grants with workers, links, inbox events and faults, and leadership
// handoffs. The schema comes from the real modules; the rows are inserted directly, so the data can be as varied as a
// long-lived journal without driving months of native traffic. Deterministic per seed.
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ControlStore } from "./store.mjs";
import { Controller } from "./controller.mjs";
import { Events } from "./events.mjs";
import { Manager } from "./manager.mjs";
import { Leadership } from "./leadership.mjs";
import { Permissions } from "./permissions.mjs";

// mulberry32: a small deterministic PRNG, so a failing seed reproduces.
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const uid = (rnd) => {
  const h = () =>
    Math.floor(rnd() * 0x10000)
      .toString(16)
      .padStart(4, "0");
  return `${h()}${h()}-${h()}-4${h().slice(1)}-8${h().slice(1)}-${h()}${h()}${h()}`;
};

/** Build the controller modules over a journal file (the same construction the tests and server use). */
export function modulesFor(dir, file = path.join(dir, "journal.sqlite")) {
  const store = new ControlStore(file);
  const native = { route: () => undefined };
  const control = new Controller({ store, native, authority: async () => ({}) });
  control.events = new Events(control, path.join(dir, "grants/inbox"));
  control.manager = new Manager(control, path.join(dir, "grants/manager"));
  control.leadership = new Leadership(control);
  control.permissions = new Permissions(control);
  return { store, control };
}

/** Fill a fresh journal. scale 1 ~ the live journal's order of magnitude for these tables. */
export function generate(dir, { seed = 1, scale = 1, intents = 700 } = {}) {
  const rnd = prng(seed),
    pick = (xs) => xs[Math.floor(rnd() * xs.length)],
    n = (k) => Math.max(1, Math.round(k * scale));
  const { store, control } = modulesFor(dir),
    db = store.db,
    now = Date.parse("2026-09-26T00:00:00Z");
  const at = () => new Date(now - Math.floor(rnd() * 86400000 * 14)).toISOString();
  const tasks = Array.from({ length: 6 }, () => uid(rnd));
  const sessions = Array.from({ length: n(150) }, () => ({
    id: uid(rnd),
    task: pick(tasks),
    mode: pick(["delegated", "delegated", "human"]),
    generation: 1 + Math.floor(rnd() * 6),
  }));
  db.exec("BEGIN");
  const ins = (table, row) =>
    db
      .prepare(
        `INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
          .map(() => "?")
          .join(",")})`,
      )
      .run(...Object.values(row));
  for (const s of sessions)
    ins("sessions", {
      id: s.id,
      task: s.task,
      cwd: path.join(dir, "tasks", s.id),
      mode: s.mode,
      generation: s.generation,
      token: null,
      expected: null,
      authority: "key",
      expectedAt: null,
      boot: "b1",
      grantedAt: 1,
    });
  const deliveryIds = [];
  for (let i = 0; i < n(6000); i++) {
    const s = pick(sessions),
      kind = pick(["send", "send", "send", "create", "wake", "handback"]),
      id = uid(rnd);
    deliveryIds.push(id);
    const body =
      kind === "create"
        ? {
            taskId: rnd() < 0.9 ? s.task : pick(tasks),
            provider: "claude",
            title: "job " + i,
            text: "x".repeat(Math.floor(rnd() * 800)),
          }
        : { text: "y".repeat(Math.floor(rnd() * 1200)) };
    ins("deliveries", {
      id,
      session: rnd() < 0.05 ? null : s.id,
      kind,
      body: JSON.stringify(body),
      state: pick([
        "delivered",
        "delivered",
        "delivered",
        "refused",
        "intent",
        "uncertain",
        "queued",
        "abandoned",
      ]),
      result: rnd() < 0.7 ? JSON.stringify({ id: s.id, generation: s.generation }) : null,
    });
  }
  // Leadership candidates: human sessions created as supervisor-capable (a delivered create naming their id and cwd).
  for (const s of sessions)
    if (s.mode === "human" && rnd() < 0.5)
      ins("deliveries", {
        id: uid(rnd),
        session: s.id,
        kind: "create",
        body: JSON.stringify({ taskId: s.task, provider: "claude", title: "capable" }),
        state: "delivered",
        result: JSON.stringify({
          id: s.id,
          cwd: path.join(dir, "tasks", s.id),
          managerToolsVersion: "1",
        }),
      });
  const requestable = deliveryIds.filter(() => rnd() < 0.02); // management requests that became deliveries (id UNIQUE)
  for (let i = 0; i < n(80); i++)
    ins("management_requests", {
      fingerprint: uid(rnd),
      id: rnd() < 0.5 && requestable.length ? requestable.pop() : uid(rnd),
      body: rnd() < 0.95 ? JSON.stringify({ taskId: pick(tasks), kind: "create" }) : "{not json",
    });
  // Routine grants: roots (their own rootSession) and children, some revoked, some at a stale generation.
  const roots = [];
  for (const s of sessions) {
    if (rnd() < 0.55) continue;
    const root = roots.length && rnd() < 0.6 ? pick(roots) : null,
      epoch = uid(rnd);
    const g = {
      session: s.id,
      generation: rnd() < 0.85 ? s.generation : s.generation + 1,
      epoch,
      rootSession: root ? root.session : s.id,
      rootEpoch: root ? root.epoch : epoch,
      revoked: rnd() < 0.2 ? 1 : 0,
      reason: "grant " + s.id.slice(0, 8),
    };
    ins("permission_grants", g);
    if (!root) roots.push(g);
  }
  const grantRows = db.prepare("SELECT * FROM permission_grants").all(),
    pools = [...new Set(grantRows.map((g) => g.rootEpoch))];
  const intentCols = db
    .prepare("PRAGMA table_info(permission_intents)")
    .all()
    .map((c) => c.name);
  for (let i = 0; i < n(intents); i++) {
    const question = rnd() < 0.1,
      g = pick(grantRows);
    const row = {
      id: uid(rnd),
      identity: uid(rnd),
      session: g.session,
      pool: question ? "question:" + g.session : pick(pools),
      state: pick([
        "verified",
        "verified",
        "superseded",
        "escalated",
        "intent",
        "uncertain",
        "acknowledged",
        "cancelling",
        "incident",
        "answered",
      ]),
      body: JSON.stringify({ kind: question ? "question-answer" : "routine" }),
      result:
        rnd() < 0.6
          ? JSON.stringify({ note: "n" + i, verification: pick(["verified", "failed"]) })
          : null,
      created: at(),
    };
    for (const c of intentCols) if (!(c in row)) row[c] = null;
    ins("permission_intents", Object.fromEntries(intentCols.map((c) => [c, row[c]])));
  }
  // Managers: supervisors with workers, links, events and faults.
  const supervisors = sessions.filter(() => rnd() < 0.14);
  const freeRequests = deliveryIds.filter(() => rnd() < 0.05); // native creation requests a worker row may point at (UNIQUE)
  for (const sup of supervisors) {
    const epoch = uid(rnd);
    ins("manager_grants", {
      supervisor: sup.id,
      generation: rnd() < 0.8 ? sup.generation : sup.generation + 1,
      epoch,
      token: uid(rnd),
      maxWorkers: 1 + Math.floor(rnd() * 6),
      reason: "manager " + sup.id.slice(0, 8),
    });
    for (let w = 0; w < 1 + Math.floor(rnd() * 4); w++) {
      const worker = rnd() < 0.85 ? pick(sessions) : null,
        phase = pick(["attached", "attached", "creating", "failed"]);
      if (worker && db.prepare("SELECT 1 FROM manager_workers WHERE worker=?").get(worker.id))
        continue;
      ins("manager_workers", {
        request: uid(rnd),
        supervisor: sup.id,
        epoch: rnd() < 0.85 ? epoch : uid(rnd),
        body: "{}",
        worker: worker?.id ?? null,
        generation: worker?.generation ?? null,
        phase,
        nativeRequest: rnd() < 0.7 && freeRequests.length ? freeRequests.pop() : uid(rnd),
      });
      if (
        worker &&
        rnd() < 0.8 &&
        !db.prepare("SELECT 1 FROM event_links WHERE worker=?").get(worker.id)
      )
        ins("event_links", {
          worker: worker.id,
          supervisor: sup.id,
          epoch: uid(rnd),
          workerGeneration: worker.generation,
          supervisorGeneration: sup.generation,
          observed: "{}",
          reason: "link",
        });
      if (worker && rnd() < 0.6)
        ins("event_inbox", {
          id: uid(rnd),
          identity: uid(rnd),
          worker: worker.id,
          supervisor: sup.id,
          epoch,
          kind: pick(["turn-ended", "permission", "error"]),
          payload: "{}",
          state: pick(["queued", "delivered"]),
          consumed: rnd() < 0.5 ? at() : null,
          at: at(),
        });
      if (
        worker &&
        rnd() < 0.1 &&
        !db.prepare("SELECT 1 FROM event_faults WHERE worker=?").get(worker.id)
      )
        ins("event_faults", { worker: worker.id, reason: "fault", at: at() });
    }
  }
  // Leadership handoffs (their wakes are deliveries), across and within tasks.
  for (let i = 0; i < n(40); i++) {
    const src = pick(sessions),
      dst = rnd() < 0.7 ? pick(sessions.filter((s) => s.task === src.task)) : pick(sessions);
    const workers = Array.from(
      { length: Math.floor(rnd() * 3) },
      () => (rnd() < 0.8 ? pick(sessions.filter((s) => s.task === src.task)) : pick(sessions)).id,
    );
    ins("leadership_handoffs", {
      id: uid(rnd),
      source: src.id,
      destination: dst.id,
      generation: dst.generation,
      boot: "b1",
      grantedAt: 1,
      wakeId: pick(deliveryIds) + "-" + i,
      context: "c".repeat(Math.floor(rnd() * 900)),
      workers: JSON.stringify(workers),
      predecessors: "[]",
      state: pick(["pending", "consumed", "superseded-by-takeover"]),
      consumed: null,
      note: null,
      at: at(),
    });
  }
  db.exec("COMMIT");
  return { store, control, tasks, sessions, file: path.join(dir, "journal.sqlite") };
}
export const canonical = (x) =>
  JSON.stringify(x, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
export const OLD_HISTORY_SQL = `SELECT id,session,kind,state FROM (
      SELECT d.id,d.session,d.kind,d.state,d.rowid AS sequence FROM deliveries d LEFT JOIN sessions s ON s.id=d.session WHERE s.task=? OR (d.kind='create' AND json_extract(d.body,'$.taskId')=?)
      UNION ALL SELECT r.id,NULL,'create','prepared',r.rowid FROM management_requests r WHERE json_valid(r.body) AND json_extract(r.body,'$.taskId')=? AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.id=r.id)
    ) ORDER BY (state IN ('intent','uncertain','prepared','queued')) DESC,sequence DESC LIMIT 1000`;
export { randomUUID };

// The pre-Track-1 permissions-status per-row status(), VERBATIM from 2fbca3ee (only `this.` -> `p.`): the independent
// reference the equality test compares statusMany() against, so a bug shared by status() and statusMany() is still caught.
export function oldStatus(p, id) {
  // capacity is reported even for a session that holds no grant: the failure this fixes was invisible
  // precisely because nothing surfaced how much of the bound was occupied, or by what.
  const g = p.grantRow(id);
  if (!g)
    return {
      sessionId: id,
      active: false,
      remaining: 0,
      pool: null,
      reason: "No routine-file grant",
      pending: [],
      recent: [],
      capacity: p.capacity(),
    };
  let active = true,
    reason = g.reason;
  try {
    p.binding(id);
  } catch (e) {
    active = false;
    reason = e.message;
  }
  if (
    p.db.prepare("SELECT count(*) n FROM permission_intents WHERE pool NOT LIKE 'question:%'").get()
      .n >= 1000
  ) {
    active = false;
    reason = "Permission journal capacity reached; routine handling is suspended pending retention";
  }
  const rows = p.db
    .prepare(
      "SELECT id,session,state,result,created FROM permission_intents WHERE pool=? ORDER BY rowid DESC LIMIT 1000",
    )
    .all(g.rootEpoch);
  const pending = rows
    .filter(
      (r) => ["intent", "uncertain", "cancelling"].includes(r.state) || r.state === "acknowledged",
    )
    .map((r) => ({ id: r.id, sessionId: r.session, state: r.state }));
  return {
    sessionId: id,
    active,
    remaining: Math.max(0, 100 - rows.filter((r) => r.state !== "escalated").length),
    pool: g.rootSession,
    reason,
    pending,
    capacity: p.capacity(),
    superseded: p.supersededCount(g.rootEpoch),
    recent: rows
      .filter((r) => r.session === id)
      .slice(0, 10)
      .map((r) => ({ id: r.id, state: r.state, result: r.result ? JSON.parse(r.result) : null })),
  };
}
