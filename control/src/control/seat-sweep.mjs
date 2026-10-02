import fs from "node:fs";
// Stage 2 (STAGE2-DESIGN.md s3): after a verified daemon restart, re-pin every seat whose evidence is
// complete, without a human trigger. The authority is never the restart -- anyone who can restart the
// daemon can mint a verified boot -- it is the shared seat gate (Controller.sweepSeat), including R9: the pinned
// guard's durable human-input log must vouch for every boot since the grant, or the seat declines and the
// operator trigger remains the only way back.
//
// Called from exactly two places in server.mjs: once before the control socket listens, and on the
// watchdog tick (decision D1, because whether the controller survives a daemon-only restart is not
// known). Both are safe under either lock order; the tick is inert once each seat has had its one
// attempt at this boot, costing one indexed SELECT.
export const MODES = ["off", "report", "on"];
export const MODE_FILE = "seat-sweep.mode";

// The prime's switch (decision D2). Absent, unreadable, not private, or not exactly one of MODES means off.
// Read on every sweep, so writing `off` stops the next tick without restarting anything.
export function sweepMode(home) {
  const file = `${home}/${MODE_FILE}`;
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return { mode: "off", reason: "No mode file; the sweep is off by default" };
  }
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > 64
  )
    return {
      mode: "off",
      reason: "The mode file is not a small private regular file; the sweep stays off",
    };
  let text;
  try {
    text = fs.readFileSync(file, "utf8").trim();
  } catch {
    return { mode: "off", reason: "The mode file is unreadable; the sweep stays off" };
  }
  return MODES.includes(text)
    ? { mode: text, reason: null }
    : { mode: "off", reason: "The mode file does not name a mode; the sweep stays off" };
}

// Seats this boot has not yet swept. The boot comes from verifyActivation(), never from a caller, and
// the row's own gate re-checks everything; this query only chooses whom to ask.
// H7 item 4 (G18): a seat's TEAM is re-established with it -- the manager workers attached to a seated supervisor at
// their current generations, and the sessions a seat holder started (recorded parent == current holder), in both cases
// only while that seat holder is itself under delegated control (a human-held seat's team is the human's). The gate is
// the seat’s own gate, unchanged: quiescent, fresh human-input counter, a complete and clean durable
// human-input log, the exact prompt identity the controller recorded, task authority. Only its scope widens.
export function ownedBySeat(db, id) {
  const has = (t) =>
    Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t));
  if (!has("role_bindings")) return false;
  if (
    has("event_links") &&
    has("manager_workers") &&
    db
      .prepare(`SELECT 1 FROM event_links l JOIN manager_workers w ON w.worker=l.worker AND w.supervisor=l.supervisor AND w.phase='attached'
      JOIN sessions s ON s.id=l.worker AND s.generation=l.workerGeneration JOIN sessions p ON p.id=l.supervisor AND p.mode='delegated' AND p.generation=l.supervisorGeneration
      WHERE l.worker=? AND EXISTS (SELECT 1 FROM role_bindings b WHERE b.session=l.supervisor AND b.state='assigned')`)
      .get(id)
  )
    return true;
  if (
    has("session_ownership") &&
    db
      .prepare(`SELECT 1 FROM session_ownership o JOIN deliveries d ON d.id=o.request AND d.kind='create' AND d.state='delivered' AND json_valid(d.result)
      JOIN role_bindings b ON b.role='project-orchestrator' AND b.seat=o.seat AND b.state='assigned' AND b.session=o.parentSession
      JOIN sessions h ON h.id=o.parentSession AND h.mode='delegated'
      WHERE o.declaredBy='project-orchestrator' AND json_extract(d.result,'$.id')=?`)
      .get(id)
  )
    return true;
  return false;
}
export function sweepCandidates(db, currentBoot) {
  const stale = db
    .prepare(`SELECT s.id, EXISTS (SELECT 1 FROM role_bindings b WHERE b.session=s.id AND b.state='assigned') seated FROM sessions s
    WHERE s.mode='delegated' AND s.boot IS NOT NULL AND s.boot != ?
      AND NOT EXISTS (SELECT 1 FROM seat_sweeps w WHERE w.session=s.id AND w.boot=?)
    ORDER BY s.id`)
    .all(currentBoot, currentBoot);
  // Seats first, then their teams.
  return [
    ...stale.filter((r) => r.seated).map((r) => r.id),
    ...stale.filter((r) => !r.seated && ownedBySeat(db, r.id)).map((r) => r.id),
  ];
}

const passes = new WeakMap();
/**
 * One pass. Never throws: every per-seat outcome, including errors, is returned for the log.
 * @param {any} control  the Controller
 * @param {{home:string, currentBoot:() => string}} options
 */
export function sweepSeats(control, { home, currentBoot }) {
  // A tick that arrives while a pass is running joins it rather than starting a second.
  if (passes.has(control)) return passes.get(control);
  const pass = (async () => {
    const { mode, reason } = sweepMode(home);
    if (mode === "off" || control.closing) return { mode, reason, results: [] };
    let boot;
    try {
      boot = currentBoot();
    } catch (e) {
      return {
        mode,
        reason: "The current daemon boot could not be verified: " + e.message,
        results: [],
      };
    }
    const hasBindings = control.store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='role_bindings'")
      .get();
    if (!hasBindings) return { mode, reason: "No role bindings exist", results: [] };
    const results = [];
    for (const id of sweepCandidates(control.store.db, boot)) {
      if (control.closing) break;
      try {
        results.push({ id, ...(await control.sweepSeat(id, { report: mode === "report" })) });
      } catch (e) {
        results.push({ id, error: e.message });
      }
    }
    return { mode, reason, boot, results };
  })().finally(() => {
    passes.delete(control);
  });
  passes.set(control, pass);
  return pass;
}
