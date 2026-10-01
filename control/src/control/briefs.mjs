// Fulcra Command Centre J1 (CONTRACTS.md §4): the project story. A project's orchestrator (or the prime that
// owns the project, §5) publishes a brief with role_brief_publish; the Organisation view reads the latest one.
// Every revision is kept, because the daily digest (decisions.mjs) reads the history.
//
// Who wrote it is derived from the role grant, never read from input. The server refuses a brief unless the
// calling session holds that project's orchestrator seat, or holds the prime seat that owns the project now.
import { createHash } from 'node:crypto';
import { uuid } from './authority.mjs';
import { assertColumns } from './schema.mjs';
import { validateBrief, briefStale } from '../../orca-organization/shared/cc/brief-rules.mjs';
import { canonicalJson } from '../../orca-organization/shared/cc/decision-rules.mjs';
const keys = (a, names) => a && typeof a === 'object' && !Array.isArray(a) && Object.keys(a).sort().join() === names;
export const STALE_REVISION = 'Changed since you looked; refresh';
// Authored table bounds (CONTRACTS §1 Capacity): refused only at the cap, with a sentence saying so.
export const BRIEF_LIMITS = Object.freeze({ perProject: 1000, briefs: 20000, history: 25000 });
const BRIEF_COLUMNS = 'projectId,revision,json,writtenAt,author';
const HISTORY_COLUMNS = 'id,entityId,action,before,after,previousRevision,revision,actor,note,at';
const fingerprintOf = brief => createHash('sha256').update(canonicalJson(brief)).digest('hex');

export class Briefs {
  constructor(control, { now = Date.now } = {}) {
    this.control = control; this.store = control.store; this.db = this.store.db; this.now = now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS cc_project_briefs(projectId TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,writtenAt TEXT NOT NULL,author TEXT NOT NULL,PRIMARY KEY(projectId,revision));
      CREATE TABLE IF NOT EXISTS cc_brief_history(id TEXT PRIMARY KEY,entityId TEXT NOT NULL,action TEXT NOT NULL,before TEXT,after TEXT NOT NULL,previousRevision INTEGER NOT NULL,revision INTEGER NOT NULL,actor TEXT NOT NULL,note TEXT NOT NULL,at TEXT NOT NULL);`);
    assertColumns(this.db, 'cc_project_briefs', BRIEF_COLUMNS);
    assertColumns(this.db, 'cc_brief_history', HISTORY_COLUMNS);
  }
  iso() { return new Date(this.now()).toISOString(); }
  // CONTRACTS §1 Capacity (v1.14, R-C-J1-2): how full each bound is, for the Inbox's 90% attention item. The
  // per-project cap is reported per project. There is no archive for briefs yet (a documented v1 exception).
  capacityUsage() {
    const out = [[this.count('cc_project_briefs') / BRIEF_LIMITS.briefs, 'project updates', null], [this.count('cc_brief_history') / BRIEF_LIMITS.history, 'project update history', null]]
      .map(([ratio, what, projectId]) => ({ ratio, what, projectId }));
    for (const r of this.db.prepare('SELECT projectId, count(*) n FROM cc_project_briefs GROUP BY projectId HAVING n >= ?').all(Math.ceil(BRIEF_LIMITS.perProject * 0.9)))
      out.push({ ratio: Number(r.n) / BRIEF_LIMITS.perProject, what: "one project's updates", projectId: r.projectId });
    return out;
  }
  count(sql, ...args) { return Number(this.db.prepare(`SELECT count(*) n FROM ${sql}`).get(...args).n); }
  latestRow(projectId) { return this.db.prepare('SELECT * FROM cc_project_briefs WHERE projectId=? ORDER BY revision DESC LIMIT 1').get(projectId) ?? null; }
  latest(projectId) { const r = this.latestRow(projectId); return r ? JSON.parse(r.json) : null; }
  // §4.2 authorship: this project's seated orchestrator, or the prime that owns the project (§5.2).
  author(sessionId, capability, projectId) {
    const s = this.control.bindings.checkRole(sessionId, capability);
    const seats = this.db.prepare("SELECT role,seat FROM role_bindings WHERE session=? AND state='assigned'").all(s.id);
    if (seats.some(r => r.role === 'project-orchestrator' && r.seat === projectId)) return { seat: projectId, sessionId: s.id };
    const owner = this.control.remits?.ownerOf(projectId);
    if (owner?.primeSeat && seats.some(r => r.role === 'prime' && r.seat === owner.primeSeat)) return { seat: owner.primeSeat, sessionId: s.id };
    throw Error('Only this project\'s orchestrator, or the prime that owns it, can publish its brief');
  }

  // ---- Agent side (role lane) ---------------------------------------------------------------------------------
  publish(a, capability) {
    if (!keys(a, 'brief,expectedRevision,messageId,sessionId') || !uuid(a.messageId) || !Number.isSafeInteger(a.expectedRevision) || a.expectedRevision < 0) throw Error('Invalid brief; it takes messageId, expectedRevision (0 for the first brief) and brief');
    const { brief: body, warnings } = validateBrief(a.brief);
    const author = this.author(a.sessionId, capability, body.projectId);
    const fingerprint = fingerprintOf(body);
    return this.store.atomic(() => {
      const prior = this.db.prepare('SELECT * FROM cc_brief_history WHERE id=?').get(a.messageId);
      if (prior) {
        const after = JSON.parse(prior.after);
        if (prior.action !== 'published' || prior.entityId !== body.projectId || after.fingerprint !== fingerprint || after.author.sessionId !== author.sessionId) throw Error('Message identity already used');
        const row = this.db.prepare('SELECT json FROM cc_project_briefs WHERE projectId=? AND revision=?').get(body.projectId, prior.revision);
        return { brief: JSON.parse(row.json), warnings, resend: true };
      }
      const current = this.latestRow(body.projectId), revision = current?.revision ?? 0;
      if (revision !== a.expectedRevision) throw Error(`${STALE_REVISION}: the latest brief is revision ${revision}`);
      if (this.count('cc_project_briefs WHERE projectId=?', body.projectId) >= BRIEF_LIMITS.perProject || this.count('cc_project_briefs') >= BRIEF_LIMITS.briefs || this.count('cc_brief_history') >= BRIEF_LIMITS.history)
        throw Error('The brief store is full; nothing was published. Archiving old briefs arrives in a later Fulcra update');
      const writtenAt = this.iso(), next = revision + 1;
      // Key order as §4.1 writes it.
      const brief = { version: 1, projectId: body.projectId, revision: next, author, writtenAt, health: body.health, headline: body.headline, now: body.now,
        next: body.next, needsYou: body.needsYou, risks: body.risks, shipped: body.shipped, evidence: body.evidence };
      this.db.prepare('INSERT INTO cc_project_briefs VALUES (?,?,?,?,?)').run(body.projectId, next, JSON.stringify(brief), writtenAt, `seat:${author.seat}`);
      this.db.prepare('INSERT INTO cc_brief_history VALUES (?,?,?,?,?,?,?,?,?,?)').run(a.messageId, body.projectId, 'published', null, JSON.stringify({ fingerprint, author, revision: next }), revision, next, `seat:${author.seat}`, 'Published', writtenAt);
      return { brief, warnings, resend: false,
        note: warnings.length ? 'Published. Some wording may be hard for a busy reader; see warnings and consider publishing a plainer revision.' : 'Published.' };
    });
  }

  // ---- App side (operator gate): the brief plus what the journal observes about the project -------------------
  // Sessions are counted by the plugin from the live fleet; the journal adds decisions, held messages and the
  // latest recorded activity. `stale` is recomputed there once fleet activity is merged in.
  read(a) {
    if (!keys(a, 'projectId') || !uuid(a.projectId)) throw Error('Invalid brief read');
    const observedAt = this.iso(), brief = this.latest(a.projectId);
    const openDecisions = this.has('cc_decisions') ? this.count("cc_decisions WHERE projectId=? AND state='open'", a.projectId) : 0;
    const heldMessages = this.has('role_channel_messages') ? this.count("role_channel_messages WHERE state='held' AND fromSeat=?", a.projectId) : 0;
    const times = [];
    if (this.has('cc_decisions')) times.push(this.db.prepare('SELECT max(updatedAt) at FROM cc_decisions WHERE projectId=?').get(a.projectId).at);
    if (this.has('role_channel_messages')) times.push(this.db.prepare('SELECT max(at) at FROM role_channel_messages WHERE fromSeat=? OR toSeat=?').get(a.projectId, a.projectId).at);
    const lastActivityAt = times.filter(Boolean).sort().at(-1) ?? null;
    return { version: 1, observedAt, projectId: a.projectId, brief, journal: { openDecisions, heldMessages, lastActivityAt },
      stale: brief ? briefStale({ writtenAt: brief.writtenAt, lastActivityAt, now: this.now() }) : false };
  }
  has(table) { return Boolean(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)); }
}
