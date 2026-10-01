// G-FIXES-REPORT.md mutation run (Tally E2E gaps G1-G9). Not a test file (no .test. in the name).
//
//   node src/control/g-fixes.mutations.mjs [ID...]
//
// Same contract as seat-inbox.mutations.mjs: apply exact-anchor edits, run the named suite, require the named test
// to FAIL, restore the original bytes in a finally. An anchor that is not exactly once aborts the run.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), at = f => path.join(here, f);
const JCT = at('journal-capacity.test.mjs'), JC = at('journal-capacity.mjs'), MG = at('manager.mjs'), EV = at('events.mjs');
const BD = at('bindings.mjs'), SD = at('seating-defaults.test.mjs'), RS = at('role-sessions.mjs'), PM = at('permissions.mjs'), RC = at('role-channels.mjs'), HN = at('held-notifier.mjs'), SI = at('seat-inbox.test.mjs');
const M = [
  { id: 'G2', why: 'wakes stop at the old half-way mark again', suite: at('events.test.mjs'), expect: 'a journal past the old half-way mark', edits: [[EV, 'if (deliveryCount(this.db) >= AUTOMATION_LIMIT) {', 'if (deliveryCount(this.db) >= 500) {']] },
  { id: 'G3a', why: 'manager creation stops at the old 498', suite: at('manager.test.mjs'), expect: 'a granted manager creates up to maxWorkers', edits: [[MG, 'if (journal >= AUTOMATION_LIMIT - 2) throw', 'if (journal >= 498) throw']] },
  { id: 'G3b', why: 'one message for both limits again', suite: at('manager.test.mjs'), expect: 'a granted manager creates up to maxWorkers', edits: [[MG, 'throw Error(`Supervision link capacity reached before creation: ${links} live links and ${reserved} pending creations of 32`);', "throw Error('Supervision link or wake capacity reached before creation');"]] },
  { id: 'G2b', why: 'a manager grant issues no inbox again', suite: at('manager.test.mjs'), expect: 'a manager grant issues the manager inbox', edits: [[MG, 'const inboxFile = this.control.events?.issueInbox(s) ?? null;', 'const inboxFile = null;']] },
  { id: 'G1a', why: 'seating issues no grants again', suite: SD, expect: 'G1: seating a delegated orchestrator', edits: [[BD, '    await this.seatingGrants(a, outcome.result);\n', '']] },
  { id: 'G1b', why: 'a pending seating grant is never honoured at delegation', suite: SD, expect: 'G1: seated under human control', edits: [[BD, "get(id)) return this.issuePending(id);", "get(id)) return null;"]] },
  { id: 'G1c', why: 'a pending grant is not pinned to its seat and revision', suite: SD, expect: 'G1: seated under human control', edits: [[BD, "    this.db.prepare('DELETE FROM role_grant_pending WHERE session=? AND NOT EXISTS", "    if (0) this.db.prepare('DELETE FROM role_grant_pending WHERE session=? AND NOT EXISTS"], [BD, "if (!bound || bound.state !== 'assigned' || bound.session !== id || bound.revision !== pending.revision) {", "if (false) {"]] },
  { id: 'G1d', why: 'seating grants manager authority without the operator asking', suite: SD, expect: 'G1: seating a delegated orchestrator', edits: [[BD, '    if (a.manager) await this.seatManager(a, result);', '    await this.seatManager(a, result);']] },
  { id: 'G4', why: 'the default role-session allowance back to 2', suite: at('seating-defaults.test.mjs'), expect: 'seating confers a bounded default allowance', edits: [[at('role-sessions.mjs'), 'export const DEFAULT_SEAT_SESSIONS = 8;', 'export const DEFAULT_SEAT_SESSIONS = 2;']] },
  { id: 'G7a', why: 'any session is inspectable, not only the seat\u2019s own', suite: SD, expect: 'only sessions this seat started', edits: [[RS, "if (!owner || owner.declaredBy !== 'project-orchestrator' || owner.parentSession !== callerId) throw", "if (!owner) throw"]] },
  { id: 'G7b', why: 'the final reply is read from the start of the timeline, not the recorded pre-send position', suite: SD, expect: 'G7: the orchestrator reads', edits: [[RS, 'await this.control.native.completion(a.targetSessionId, last.id, { cursor });', "await this.control.native.completion(a.targetSessionId, last.id, { cursor: { epoch: cursor.epoch, seq: 0 } });"]] },
  { id: 'G8a', why: 'a follow-up reaches a session a human took over', suite: SD, expect: 'G8: a follow-up', edits: [[RS, "if (!target || target.mode !== 'delegated') throw Error('A human has taken", "if (!target) throw Error('A human has taken"]] },
  { id: 'G8b', why: 'follow-ups are unbounded', suite: SD, expect: 'G8: a follow-up', edits: [[RS, "get(a.targetSessionId).n >= MAX_SESSION_FOLLOWUPS) throw", "get(a.targetSessionId).n >= Infinity) throw"]] },
  { id: 'G9a', why: 'role ownership is not an ownership link again', suite: SD, expect: 'G9:', edits: [[PM, "const owner = this.control.roleSessions?.owner(id), seat =", "const owner = null, seat ="]] },
  { id: 'G9b', why: 'inherited authority survives a vacated orchestrator seat', suite: SD, expect: 'G9:', edits: [[PM, "|| !seat || seat.state !== 'assigned' || seat.session !== owner.parentSession) throw Error('Inherited routine grant has no ownership link');", ") throw Error('Inherited routine grant has no ownership link');"]] },
  { id: 'G6a', why: 'a held message notifies nobody again', suite: SI, expect: 'G6: a held message notifies', edits: [[RC, "      this.noticing = this.noticeHeld().catch(", "      this.noticing = Promise.resolve([]).catch("], [RC, 'this.deliverPending().then(() => this.noticeHeld())', 'this.deliverPending()']] },
  { id: 'G6b', why: 'the untrusted text travels in the notice', suite: SI, expect: 'G6: a held message notifies', edits: [[RC, "SELECT messageId,fromSeat,toSeat FROM role_channel_messages m WHERE state='held'", "SELECT messageId,fromSeat,toSeat,text FROM role_channel_messages m WHERE state='held'"], [RC, 'messageIds: batch.map(r => r.messageId) });', 'messageIds: batch.map(r => r.messageId), texts: batch.map(r => r.text) });']] },
  { id: 'G6c', why: 'every pump pass notifies again', suite: SI, expect: 'G6: a held message notifies', edits: [[RC, " AND NOT EXISTS (SELECT 1 FROM role_held_notices n WHERE n.messageId=m.messageId) ORDER BY rowid LIMIT 32", " ORDER BY rowid LIMIT 32"], [RC, "INSERT OR IGNORE INTO role_held_notices VALUES (?,?,?,?,'sending')", "INSERT OR REPLACE INTO role_held_notices VALUES (?,?,?,?,'sending')"]] },
  { id: 'G6d', why: 'the notifier accepts any seat text into the AppleScript', suite: SI, expect: 'G6: the macOS notifier', edits: [[HN, "if (!SEAT.test(n.seat) || !Array.isArray(n.fromSeats)", "if (!Array.isArray(n.fromSeats)"]] },
  { id: 'G3d', why: 'the staged quota-wait imports an unstaged module again (H5 build finding)', suite: at('staged-imports.test.mjs'), expect: 'every staged controller module imports only', edits: [[at('quota-wait.mjs'), 'export const QUOTA_JOURNAL_CAPACITY = 10000;', "import { JOURNAL_CAPACITY as _J } from './journal-capacity.mjs';\nexport const QUOTA_JOURNAL_CAPACITY = 10000;"]] },
  { id: 'G3e', why: 'the staged capacity copy drifts from the controller', suite: JCT, expect: 'staged quota-wait copy', edits: [[at('quota-wait.mjs'), 'export const QUOTA_JOURNAL_CAPACITY = 10000;', 'export const QUOTA_JOURNAL_CAPACITY = 1000;']] },
  { id: 'RG1a', why: 'REVIEW-G G-1: a seat-conferred manager grant outlives the seat', suite: SD, expect: 'G-1: manager authority conferred by seating ends', edits: [[BD, "    if (!row) return null;\n    if (this.row(role, seat)?.session === id) return null;", "    return null;\n    if (this.row(role, seat)?.session === id) return null;"]] },
  { id: 'RG1b', why: 'REVIEW-G G-1: the seat revokes an operator manager-grant too (no epoch match)', suite: SD, expect: 'G-1: an operator manager-grant stays session-bound', edits: [[BD, "DELETE FROM manager_grants WHERE supervisor=? AND epoch=?').run(id, row.epoch)", "DELETE FROM manager_grants WHERE supervisor=?').run(id)"]] },
  { id: 'RG3', why: 'REVIEW-G G-3 (H6: live-grant case): a manager request on a reaffirmation over a live grant vanishes again', suite: SD, expect: 'G-1: an operator manager-grant stays session-bound', edits: [[BD, "        if (live) result.defaults.managerGrant = { issued: false, blocked:", "        if (live) void { issued: false, blocked:"]] },
  { id: 'RG2a', why: 'REVIEW-G G-2: automated sends use the manual reserve again', suite: SD, expect: 'G-2: automated and model-driven sends', edits: [[at('controller.mjs'), "if (!existing && (AUTOMATED_SOURCES.has(supervision?.source?.kind) || supervision?.automated) && deliveryCount(this.store.db) >= AUTOMATION_LIMIT)", "if (false)"], [at('controller.mjs'), "    if (n >= AUTOMATION_LIMIT) throw new Error(`Journal automation budget reached: ${n}", "    if (false) throw new Error(`Journal automation budget reached: ${n}"]] },
  { id: 'RG2b', why: 'REVIEW-G G-2: follow-ups are not counted as automated', suite: SD, expect: 'G-2: automated and model-driven sends', edits: [[at('controller.mjs'), "new Set(['role-brief', 'role-followup', 'role-channel', 'manager', 'event', 'leadership'])", "new Set(['role-brief', 'role-channel', 'manager', 'event', 'leadership'])"]] },
  { id: 'RG6', why: 'REVIEW-G G-6: the sender waits for the notifier again', suite: SI, expect: 'REVIEW-G G-6: a slow notifier', edits: [[RC, "      this.noticing = this.noticeHeld().catch(", "      this.noticing = await this.noticeHeld().catch("]] },
  { id: 'RX5', why: 'REVIEW-G X5: no re-check after the owned-session inspect', suite: SD, expect: 'REVIEW-G X5:', edits: [[RS, "    this.control.bindings.checkRole(row.id, capability); this.ownedByCaller(row.id, a.targetSessionId);\n    const o = current.observed", "    const o = current.observed"]] },
  { id: 'RX2', why: 'REVIEW-G X2: no seat re-check at the follow-up dispatch', suite: SD, expect: 'REVIEW-G X2:', edits: [[RS, "{ source: binding, check: () => { this.control.bindings.checkRole(row.id, capability); this.ownedByCaller(row.id, a.targetSessionId); } }", "{ source: binding }"]] },
  { id: 'RG1c', why: 'REVIEW-G G-1: grantSeated no longer re-checks the seat', suite: SD, expect: 'REVIEW-G G-1: grantSeated re-checks', edits: [[MG, " if (!stillSeated()) throw Error('The seat changed during the manager grant'); return s; };", " return s; };"]] },
  { id: 'RG1d', why: 'REVIEW-G G-1: the seat record is written after an await again (the pre-fix order)', suite: SD, expect: 'REVIEW-G G-1: a seat vacated just after', edits: [[BD, "seated,\n          epoch => this.db.prepare('INSERT OR REPLACE INTO seat_manager_grants VALUES (?,?,?,?,?,?)').run(a.sessionId, a.role, a.seat, result.revision, epoch, new Date().toISOString()));", "seated);\n        if (seated()) this.db.prepare('INSERT OR REPLACE INTO seat_manager_grants VALUES (?,?,?,?,?,?)').run(a.sessionId, a.role, a.seat, result.revision, g.epoch, new Date().toISOString());"]] },
  { id: 'RG4', why: 'REVIEW-G G-4 (X1): the lost-seat check in ownedByCaller', suite: SD, expect: 'G-4: an orchestrator holding two seats', edits: [[RS, "if (seat.state !== 'assigned' || seat.sessionId !== callerId) throw Error('You no longer hold the project seat", "if (false) throw Error('You no longer hold the project seat"]] },
  { id: 'G3c', why: 'journal capacity back to 1000', suite: at('journal-capacity.test.mjs'), expect: 'past the old 1000-row cap', edits: [[JC, 'export const JOURNAL_CAPACITY = 10000;', 'export const JOURNAL_CAPACITY = 1000;']] },
];
export { M };

function failing(suite) {
  let out;
  try { out = execFileSync(process.execPath, ['--test', '--test-reporter=tap', suite], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { out = String(e.stdout ?? ''); }
  return [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map(x => x[1]);
}
const only = process.argv.slice(2);
let bad = 0;
for (const m of M.filter(x => !only.length || only.includes(x.id))) {
  const originals = new Map();
  try {
    for (const [file, from, to] of m.edits) {
      const text = originals.get(file) ?? fs.readFileSync(file, 'utf8'); originals.set(file, text);
      const current = fs.readFileSync(file, 'utf8');
      if (current.split(from).length !== 2) throw Error(`${m.id}: anchor does not occur exactly once in ${path.basename(file)}`);
      fs.writeFileSync(file, current.replace(from, () => to));
    }
    const failed = failing(m.suite), killed = failed.some(name => name.includes(m.expect));
    if (!killed) bad++;
    console.log(`${killed ? 'KILLED  ' : 'SURVIVED'} ${m.id.padEnd(5)} ${m.why} -> expected red: "${m.expect}"; red: ${failed.length ? failed.map(n => n.slice(0, 40)).join(' | ') : 'none'}`);
  } finally {
    for (const [file, text] of originals) fs.writeFileSync(file, text);
  }
}
console.log(bad ? `${bad} mutation(s) SURVIVED` : 'all mutations killed');
process.exitCode = bad ? 1 : 0;
