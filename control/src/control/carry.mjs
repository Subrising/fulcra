// H7 item 4 (G18, hit three times on 25-26 Sep). A re-delegation of the SAME session carries forward the team
// authority it held at its last delegated generation.
//
// Every takeover bumps a session's generation, and everything pinned to the old generation died with it. The role
// credential already came back through handback (bindings.reissueRole), but nothing else did. Live, after the 18:30 and
// 12:23 host restarts: the orchestrator's manager_assign_worker and manager_workers answered "Manager authority revoked or
// invalid"; once the prime re-issued manager authority, every worker read "orphaned" (their links named the old
// generations) and every assignment "Worker is not currently delegated to this manager"; routine grants were gone too.
//
// Carried, in the handback's own transaction, for this session only and only from the generation it was last delegated
// at (the newest earlier 'delegated' transfer): its manager grant (same epoch and token, so the grant file stays valid
// and its workers stay its workers), its supervisor inbox credential, the supervision links it heads, the supervision
// link naming it as a worker (with its manager_workers row), and its unrevoked routine grant.
// Not carried: anything from an OLDER generation, anything explicitly revoked (a revoked routine grant; a manager grant
// a seat released, whose row no longer exists), a seat-conferred manager grant whose seat this session no longer holds
// at that revision, and a worker link whose manager has since started a new epoch or whose task differs.
// Nothing new is conferred and no bound is exceeded (the live routine-grant bound is re-checked): every row keeps its epoch, cap and reason; only the generation it is
// pinned to follows the session. Every later use re-proves the rest (manager.check, events.valid, permissions.binding
// and the native guard all re-check delegation, boot, human input and task authority).
import { LIVE_GRANT_LIMIT } from "./permissions.mjs";
export function carryAuthority(db, id) {
  const has = (t) =>
    Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t));
  const s = db.prepare("SELECT * FROM sessions WHERE id=?").get(id);
  const none = {
    from: null,
    to: s?.generation ?? null,
    managerGrant: 0,
    inbox: 0,
    supervisorLinks: 0,
    workerLink: 0,
    routineGrant: 0,
  };
  if (!s || s.mode !== "delegated") return none;
  const from = db
    .prepare(
      "SELECT generation FROM transfers WHERE session=? AND mode='delegated' AND generation<? ORDER BY generation DESC LIMIT 1",
    )
    .get(id, s.generation)?.generation;
  if (!Number.isSafeInteger(from)) return none;
  const to = s.generation,
    n = (r) => Number(r.changes),
    out = { ...none, from };
  // 1. The manager grant this session holds, and what hangs off it.
  const grant =
    has("manager_grants") && db.prepare("SELECT * FROM manager_grants WHERE supervisor=?").get(id);
  if (grant && grant.generation === from) {
    const seat =
      has("seat_manager_grants") &&
      db
        .prepare("SELECT * FROM seat_manager_grants WHERE session=? AND epoch=?")
        .get(id, grant.epoch);
    const seatHeld =
      !seat ||
      Boolean(
        db
          .prepare(
            "SELECT 1 FROM role_bindings WHERE role=? AND seat=? AND session=? AND revision=? AND state='assigned'",
          )
          .get(seat.role, seat.seat, id, seat.revision),
      );
    if (seatHeld)
      out.managerGrant = n(
        db
          .prepare(
            "UPDATE manager_grants SET generation=? WHERE supervisor=? AND epoch=? AND generation=?",
          )
          .run(to, id, grant.epoch, from),
      );
  }
  // The links it heads follow only a carried manager grant, or plain supervision (an operator's events-attach) by a
  // session that never had a manager team. A manager grant that was NOT carried (released with its seat, or older)
  // leaves its links where they were: dead with the old generation.
  const team =
    has("manager_workers") &&
    db.prepare("SELECT 1 FROM manager_workers WHERE supervisor=? LIMIT 1").get(id);
  if (has("event_links") && (out.managerGrant || (!grant && !team)))
    out.supervisorLinks = n(
      db
        .prepare(
          "UPDATE event_links SET supervisorGeneration=? WHERE supervisor=? AND supervisorGeneration=?",
        )
        .run(to, id, from),
    );
  if (has("event_credentials") && (out.managerGrant || out.supervisorLinks))
    out.inbox = n(
      db
        .prepare("UPDATE event_credentials SET generation=? WHERE supervisor=? AND generation=?")
        .run(to, id, from),
    );
  // 2. The link naming this session as a worker: only while its manager is still the same manager epoch and task.
  const link = has("event_links") && db.prepare("SELECT * FROM event_links WHERE worker=?").get(id);
  if (link && link.workerGeneration === from) {
    const supervisor = db.prepare("SELECT * FROM sessions WHERE id=?").get(link.supervisor);
    const owned =
      has("manager_workers") &&
      db
        .prepare(
          "SELECT * FROM manager_workers WHERE worker=? AND supervisor=? AND phase='attached'",
        )
        .get(id, link.supervisor);
    const manager =
      has("manager_grants") &&
      db.prepare("SELECT * FROM manager_grants WHERE supervisor=?").get(link.supervisor);
    const sameManager =
      !owned || Boolean(manager && owned.epoch === manager.epoch && owned.generation === from);
    if (supervisor && supervisor.task === s.task && sameManager) {
      out.workerLink = n(
        db
          .prepare(
            "UPDATE event_links SET workerGeneration=? WHERE worker=? AND epoch=? AND workerGeneration=?",
          )
          .run(to, id, link.epoch, from),
      );
      if (out.workerLink && owned)
        db.prepare(
          "UPDATE manager_workers SET generation=? WHERE worker=? AND supervisor=? AND phase='attached' AND generation=?",
        ).run(to, id, link.supervisor, from);
    }
  }
  // 3. The routine (shared-file) grant, if nobody revoked it -- and only while the live bound has room (review H7 M3):
  // while the session was taken over its row was not live, so others may have filled the bound since. Then it stays
  // inert and an operator re-grants it deliberately (permissions.grant counts the bound, B1).
  if (has("permission_grants")) {
    const live = db
      .prepare(
        "SELECT count(*) n FROM permission_grants g JOIN sessions x ON x.id=g.session AND x.mode='delegated' AND x.generation=g.generation WHERE g.revoked=0",
      )
      .get().n;
    if (live < LIVE_GRANT_LIMIT)
      out.routineGrant = n(
        db
          .prepare(
            "UPDATE permission_grants SET generation=? WHERE session=? AND revoked=0 AND generation=?",
          )
          .run(to, id, from),
      );
  }
  return out;
}
