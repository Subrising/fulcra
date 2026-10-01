// Fulcra Command Centre J4 (CONTRACTS.md §2.2): links between refs, with provenance. The controller is the
// only writer and enforces every rule here, whatever the caller already checked:
//   - only the allowed pairs of §2.2 are stored;
//   - a manual link overrides an inferred or reported one, and automatic observations never touch it;
//   - a removed link is never re-inferred (the row stays, state 'removed');
//   - every manual write carries messageId (a retry returns the original result) and expectedRevision.
// Refs, enums and one plain sentence of evidence only: nothing here calls a tracker or sends a message.
import { randomUUID } from 'node:crypto';
import { uuid } from './authority.mjs';
import { assertColumns } from './schema.mjs';
import { parseRef } from '../../orca-organization/shared/cc/refs.mjs';
import { pairProblem, evidenceProblem, automaticWrite, PROVENANCE, CONFIDENCE } from '../../orca-organization/shared/cc/link-rules.mjs';
const keys = (a, names) => a && typeof a === 'object' && !Array.isArray(a) && Object.keys(a).sort().join() === names;
export const LINK_LIMITS = Object.freeze({ links: 20000, history: 60000, requests: 5000, observeBatch: 500, readRefs: 128, readRows: 1000 });
export const STALE_REVISION = 'Changed since you looked; refresh';
const LINK_COLUMNS = 'id,fromRef,toRef,relation,provenance,confidence,evidence,state,revision,createdAt,at,actor';
const HISTORY_COLUMNS = 'id,entityId,action,before,after,previousRevision,revision,actor,note,at';
const ACTOR = /^(operator|human|seat:[a-z0-9][a-z0-9-]{0,63}|session:[0-9a-f-]{36}|system:[a-z0-9-]{1,64})$/;
export class CcLinks {
  constructor(control, { now = Date.now } = {}) {
    this.store = control.store; this.db = this.store.db; this.now = now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS cc_links(id TEXT PRIMARY KEY,fromRef TEXT NOT NULL,toRef TEXT NOT NULL,relation TEXT NOT NULL,provenance TEXT NOT NULL,confidence TEXT NOT NULL,evidence TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,createdAt TEXT NOT NULL,at TEXT NOT NULL,actor TEXT NOT NULL,UNIQUE(fromRef,toRef,relation));
      CREATE INDEX IF NOT EXISTS cc_links_to ON cc_links(toRef);
      CREATE TABLE IF NOT EXISTS cc_link_history(id TEXT PRIMARY KEY,entityId TEXT NOT NULL,action TEXT NOT NULL,before TEXT,after TEXT NOT NULL,previousRevision INTEGER NOT NULL,revision INTEGER NOT NULL,actor TEXT NOT NULL,note TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_link_requests(messageId TEXT PRIMARY KEY,result TEXT NOT NULL,at TEXT NOT NULL);`);
    assertColumns(this.db, 'cc_links', LINK_COLUMNS);
    assertColumns(this.db, 'cc_link_history', HISTORY_COLUMNS);
    assertColumns(this.db, 'cc_link_requests', 'messageId,result,at');
  }
  iso() { return new Date(this.now()).toISOString(); }
  count(table) { return Number(this.db.prepare(`SELECT count(*) n FROM ${table}`).get().n); }
  byId(id) { return this.db.prepare('SELECT * FROM cc_links WHERE id=?').get(id) ?? null; }
  byTriple(from, relation, to) { return this.db.prepare('SELECT * FROM cc_links WHERE fromRef=? AND toRef=? AND relation=?').get(from, to, relation) ?? null; }
  capacity(table, limit, what) { if (this.count(table) >= limit) throw Error(`The ${what} is full (${limit}); nothing was recorded. Ask the operator to archive old links`); }
  public(r) { return r ? { id: r.id, from: r.fromRef, to: r.toRef, relation: r.relation, provenance: r.provenance, confidence: r.confidence, evidence: r.evidence, state: r.state, revision: r.revision, createdAt: r.createdAt, by: r.actor } : null; }
  record(before, after, action, actor, note, at) {
    this.capacity('cc_link_history', LINK_LIMITS.history, 'link history');
    this.db.prepare('INSERT INTO cc_link_history VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), after.id, action, before ? JSON.stringify(this.public(before)) : null, JSON.stringify(this.public(after)), before?.revision ?? 0, after.revision, actor, note, at);
  }
  // A retried messageId returns the first result, and never writes twice. Old request records rotate.
  idempotent(messageId, run) {
    if (!uuid(messageId)) throw Error('Invalid link request');
    return this.store.atomic(() => {
      const done = this.db.prepare('SELECT result FROM cc_link_requests WHERE messageId=?').get(messageId);
      if (done) return JSON.parse(done.result);
      const result = run();
      this.db.prepare('INSERT INTO cc_link_requests VALUES (?,?,?)').run(messageId, JSON.stringify(result), this.iso());
      this.db.prepare('DELETE FROM cc_link_requests WHERE rowid NOT IN (SELECT rowid FROM cc_link_requests ORDER BY rowid DESC LIMIT ?)').run(LINK_LIMITS.requests);
      return result;
    });
  }
  // Manual: set by the operator in the Trackers or Sessions view. It overrides whatever was inferred.
  set(a, actor = 'operator') {
    if (!keys(a, 'evidence,expectedRevision,from,messageId,relation,to') || !Number.isSafeInteger(a.expectedRevision) || a.expectedRevision < 0 || !ACTOR.test(actor)) throw Error('Invalid link');
    const problem = pairProblem(a.from, a.relation, a.to) ?? evidenceProblem(a.evidence);
    if (problem) throw Error(problem);
    return this.idempotent(a.messageId, () => {
      const current = this.byTriple(a.from, a.relation, a.to), at = this.iso();
      if ((current?.revision ?? 0) !== a.expectedRevision) throw Error(STALE_REVISION);
      if (current) {
        this.db.prepare("UPDATE cc_links SET provenance='manual',confidence='high',evidence=?,state='active',revision=?,at=?,actor=? WHERE id=?").run(a.evidence.trim(), current.revision + 1, at, actor, current.id);
      } else {
        this.capacity('cc_links', LINK_LIMITS.links, 'link store');
        this.db.prepare("INSERT INTO cc_links VALUES (?,?,?,?,'manual','high',?,'active',1,?,?,?)").run(randomUUID(), a.from, a.to, a.relation, a.evidence.trim(), at, at, actor);
      }
      const after = this.byTriple(a.from, a.relation, a.to);
      this.record(current, after, current ? 'override' : 'set', actor, '', at);
      return { link: this.public(after) };
    });
  }
  // Removing keeps the row so the inference never brings it back.
  remove(a, actor = 'operator') {
    if (!keys(a, 'expectedRevision,id,messageId') || !uuid(a.id) || !Number.isSafeInteger(a.expectedRevision) || a.expectedRevision < 1 || !ACTOR.test(actor)) throw Error('Invalid link removal');
    return this.idempotent(a.messageId, () => {
      const current = this.byId(a.id);
      if (!current) throw Error('That link does not exist');
      if (current.revision !== a.expectedRevision) throw Error(STALE_REVISION);
      if (current.state === 'removed') throw Error('That link is already removed');
      const at = this.iso();
      this.db.prepare("UPDATE cc_links SET state='removed',revision=?,at=?,actor=? WHERE id=?").run(current.revision + 1, at, actor, current.id);
      const after = this.byId(a.id);
      this.record(current, after, 'remove', actor, '', at);
      return { link: this.public(after) };
    });
  }
  // Reported or inferred links from connectors and the commit scan. Each one is checked on its own; a
  // refused entry is counted, never stored, and never stops the rest.
  observe(a, actor = 'system:provenance') {
    if (!keys(a, 'links,messageId') || !Array.isArray(a.links) || a.links.length > LINK_LIMITS.observeBatch || !/^system:[a-z0-9-]{1,64}$/.test(actor)) throw Error('Invalid link observation');
    return this.idempotent(a.messageId, () => {
      const counts = { inserted: 0, upgraded: 0, kept: 0, refused: 0 }, at = this.iso();
      for (const l of a.links) {
        if (!keys(l, 'confidence,evidence,from,provenance,relation,to') || l.provenance === 'manual' || !PROVENANCE.includes(l.provenance) || !CONFIDENCE.includes(l.confidence)
          || pairProblem(l.from, l.relation, l.to) || evidenceProblem(l.evidence)) { counts.refused += 1; continue; }
        const current = this.byTriple(l.from, l.relation, l.to), write = automaticWrite(current, l);
        if (write === 'keep') { counts.kept += 1; continue; }
        if (write === 'insert') {
          if (this.count('cc_links') >= LINK_LIMITS.links) { counts.refused += 1; continue; }
          this.db.prepare("INSERT INTO cc_links VALUES (?,?,?,?,?,?,?,'active',1,?,?,?)").run(randomUUID(), l.from, l.to, l.relation, l.provenance, l.confidence, l.evidence.trim(), at, at, actor);
          counts.inserted += 1;
        } else {
          this.db.prepare('UPDATE cc_links SET provenance=?,confidence=?,evidence=?,revision=?,at=?,actor=? WHERE id=?').run(l.provenance, l.confidence, l.evidence.trim(), current.revision + 1, at, actor, current.id);
          counts.upgraded += 1;
        }
        this.record(current, this.byTriple(l.from, l.relation, l.to), write === 'insert' ? 'infer' : 'upgrade', actor, '', at);
      }
      return counts;
    });
  }
  // Active links touching any of the refs, either direction. Removed links are listed only on request.
  forRefs(a) {
    if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(k => !['refs', 'includeRemoved'].includes(k)) || !Array.isArray(a.refs)
      || a.refs.length > LINK_LIMITS.readRefs || !a.refs.every(r => parseRef(r)) || (a.includeRemoved !== undefined && typeof a.includeRemoved !== 'boolean')) throw Error('Invalid link read');
    if (!a.refs.length) return { links: [] };
    const marks = a.refs.map(() => '?').join(','), state = a.includeRemoved ? '' : "state='active' AND ";
    const rows = this.db.prepare(`SELECT * FROM cc_links WHERE ${state}(fromRef IN (${marks}) OR toRef IN (${marks})) ORDER BY createdAt,id LIMIT ?`).all(...a.refs, ...a.refs, LINK_LIMITS.readRows);
    return { links: rows.map(r => this.public(r)) };
  }
  history(id) {
    if (!uuid(id)) throw Error('Invalid link');
    return { history: this.db.prepare('SELECT * FROM cc_link_history WHERE entityId=? ORDER BY rowid').all(id).map(h => ({ ...h, before: h.before ? JSON.parse(h.before) : null, after: JSON.parse(h.after) })) };
  }
}
