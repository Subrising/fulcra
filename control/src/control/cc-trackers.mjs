// Fulcra Command Centre J4 (CONTRACTS.md §7.1, §7.3): tracker mappings, many per project, and the persisted
// tracker observations that replace the plugin's memory-only cache. Ids, enums, public URLs and plain text
// only: there is no credential column (an account is named by its host id), and the controller calls no
// tracker. J3's one-per-project `tracker_mappings` stays exactly as it is; each of its rows is copied here
// once, when the plugin asks, and the legacy row is never changed.
import { randomUUID } from 'node:crypto';
import { uuid } from './authority.mjs';
import { assertColumns } from './schema.mjs';
import { readProjectDirectory } from './projects.mjs';
import { mappingProblem, itemProblem, CONNECTOR_ID } from '../../orca-organization/shared/cc/connector-rules.mjs';
import { parseRef, personalMatch } from '../../orca-organization/shared/cc/refs.mjs';
const keys = (a, names) => a && typeof a === 'object' && !Array.isArray(a) && Object.keys(a).sort().join() === names;
// Mappings and their history are authored and bounded; observations are derived and rotate (§1 Capacity).
export const CC_TRACKER_LIMITS = Object.freeze({ mappings: 256, history: 5000, requests: 2000, itemsPerMapping: 500, itemsPerWrite: 200, itemsPerRead: 500 });
export const STALE_REVISION = 'Changed since you looked; refresh';
const MAPPING_COLUMNS = 'id,projectId,connector,accountId,remoteId,remoteName,site,state,note,revision,at';
const HISTORY_COLUMNS = 'id,entityId,action,before,after,previousRevision,revision,actor,note,at';
const ITEM_COLUMNS = 'key,mappingId,projectId,connector,json,updatedAt,observedAt';
// R-E-3: observations are keyed by (mapping, item), so two projects mapped to one repository each keep their own.
// R-E-5: each row names the observation (refresh) that last saw it; `cc_tracker_observation_runs` holds each
// mapping's latest observation and whether it was complete. cc_tracker_items (keyed by item alone) is kept as it was
// and read once, into the new table.
const OBSERVATION_COLUMNS = 'mappingId,key,projectId,connector,json,updatedAt,observedAt,observationId';
const RUN_COLUMNS = 'mappingId,observationId,observedAt,partial';
// Legacy site values are the provider's own host for cloud trackers; §7.3 keeps a site for self-hosted only.
const CLOUD = { 'github.com': null, 'bitbucket.org': null };
export class CcTrackers {
  constructor(control, { now = Date.now, readProjects = readProjectDirectory } = {}) {
    this.store = control.store; this.db = this.store.db; this.now = now; this.readProjects = readProjects;
    this.db.exec(`CREATE TABLE IF NOT EXISTS cc_tracker_mappings(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,connector TEXT NOT NULL,accountId TEXT,remoteId TEXT NOT NULL,remoteName TEXT NOT NULL,site TEXT,state TEXT NOT NULL,note TEXT NOT NULL,revision INTEGER NOT NULL,at TEXT NOT NULL,UNIQUE(projectId,connector,remoteId));
      CREATE TABLE IF NOT EXISTS cc_tracker_mapping_history(id TEXT PRIMARY KEY,entityId TEXT NOT NULL,action TEXT NOT NULL,before TEXT,after TEXT NOT NULL,previousRevision INTEGER NOT NULL,revision INTEGER NOT NULL,actor TEXT NOT NULL,note TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_tracker_mapping_imports(projectId TEXT PRIMARY KEY,legacyRevision INTEGER NOT NULL,mappingId TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_tracker_requests(messageId TEXT PRIMARY KEY,result TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_tracker_items(key TEXT PRIMARY KEY,mappingId TEXT NOT NULL,projectId TEXT NOT NULL,connector TEXT NOT NULL,json TEXT NOT NULL,updatedAt TEXT NOT NULL,observedAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS cc_tracker_items_mapping ON cc_tracker_items(mappingId,updatedAt);
      CREATE TABLE IF NOT EXISTS cc_tracker_observations(mappingId TEXT NOT NULL,key TEXT NOT NULL,projectId TEXT NOT NULL,connector TEXT NOT NULL,json TEXT NOT NULL,updatedAt TEXT NOT NULL,observedAt TEXT NOT NULL,observationId TEXT NOT NULL,PRIMARY KEY(mappingId,key));
      CREATE INDEX IF NOT EXISTS cc_tracker_observations_updated ON cc_tracker_observations(mappingId,updatedAt);
      CREATE TABLE IF NOT EXISTS cc_tracker_observation_runs(mappingId TEXT PRIMARY KEY,observationId TEXT NOT NULL,observedAt TEXT NOT NULL,partial INTEGER NOT NULL);`);
    assertColumns(this.db, 'cc_tracker_mappings', MAPPING_COLUMNS);
    assertColumns(this.db, 'cc_tracker_mapping_history', HISTORY_COLUMNS);
    assertColumns(this.db, 'cc_tracker_mapping_imports', 'projectId,legacyRevision,mappingId,at');
    assertColumns(this.db, 'cc_tracker_requests', 'messageId,result,at');
    assertColumns(this.db, 'cc_tracker_items', ITEM_COLUMNS);
    assertColumns(this.db, 'cc_tracker_observations', OBSERVATION_COLUMNS);
    assertColumns(this.db, 'cc_tracker_observation_runs', RUN_COLUMNS);
    // One-time: earlier observations move over, marked as seen by no refresh, so they read as the last copy (stale)
    // until their mapping is refreshed.
    this.db.exec("INSERT OR IGNORE INTO cc_tracker_observations SELECT mappingId,key,projectId,connector,json,updatedAt,observedAt,'' FROM cc_tracker_items");
  }
  iso() { return new Date(this.now()).toISOString(); }
  count(sql, ...args) { return Number(this.db.prepare(sql).get(...args).n); }
  row(id) { return this.db.prepare('SELECT * FROM cc_tracker_mappings WHERE id=?').get(id) ?? null; }
  public(r) { return r ? { id: r.id, revision: r.revision, projectId: r.projectId, connector: r.connector, accountId: r.accountId, remoteId: r.remoteId, remoteName: r.remoteName, site: r.site, state: r.state, note: r.note, at: r.at } : null; }
  async directory(projectId) {
    const d = await this.readProjects();
    if (!d.available) throw Error('Project directory unavailable; the project cannot be verified');
    if (!d.projects.some(p => p.id === projectId)) throw Error('Unknown project in the current company project directory');
  }
  idempotent(messageId, run) {
    if (!uuid(messageId)) throw Error('Invalid tracker mapping request');
    return this.store.atomic(() => {
      const done = this.db.prepare('SELECT result FROM cc_tracker_requests WHERE messageId=?').get(messageId);
      if (done) return JSON.parse(done.result);
      const result = run();
      this.db.prepare('INSERT INTO cc_tracker_requests VALUES (?,?,?)').run(messageId, JSON.stringify(result), this.iso());
      this.db.prepare('DELETE FROM cc_tracker_requests WHERE rowid NOT IN (SELECT rowid FROM cc_tracker_requests ORDER BY rowid DESC LIMIT ?)').run(CC_TRACKER_LIMITS.requests);
      return result;
    });
  }
  record(before, after, action, actor, note, at) {
    if (this.count('SELECT count(*) n FROM cc_tracker_mapping_history') >= CC_TRACKER_LIMITS.history) throw Error(`Tracker mapping history is full (${CC_TRACKER_LIMITS.history}); nothing was recorded`);
    this.db.prepare('INSERT INTO cc_tracker_mapping_history VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), after.id, action, before ? JSON.stringify(this.public(before)) : null, JSON.stringify(this.public(after)), before?.revision ?? 0, after.revision, actor, note, at);
  }
  // At most one active mapping per (project, connector, remote). Re-mapping an unmapped remote reuses its row,
  // so its revision and history continue.
  write(m, expectedRevision, action, actor) {
    const at = this.iso(), note = m.note.trim();
    const current = this.db.prepare('SELECT * FROM cc_tracker_mappings WHERE projectId=? AND connector=? AND remoteId=?').get(m.projectId, m.connector, m.remoteId) ?? null;
    if ((current?.revision ?? 0) !== expectedRevision) throw Error(current?.state === 'mapped' && expectedRevision === 0 ? 'That tracker is already mapped to this project' : STALE_REVISION);
    if (current?.state === 'mapped') throw Error('That tracker is already mapped to this project');
    if (this.count("SELECT count(*) n FROM cc_tracker_mappings WHERE state='mapped'") >= CC_TRACKER_LIMITS.mappings) throw Error(`Tracker mappings are full (${CC_TRACKER_LIMITS.mappings}); nothing was recorded`);
    if (current) this.db.prepare("UPDATE cc_tracker_mappings SET accountId=?,remoteName=?,site=?,state='mapped',note=?,revision=?,at=? WHERE id=?").run(m.accountId, m.remoteName, m.site, note, current.revision + 1, at, current.id);
    else this.db.prepare("INSERT INTO cc_tracker_mappings VALUES (?,?,?,?,?,?,?,'mapped',?,1,?)").run(randomUUID(), m.projectId, m.connector, m.accountId, m.remoteId, m.remoteName, m.site, note, at);
    const after = this.db.prepare('SELECT * FROM cc_tracker_mappings WHERE projectId=? AND connector=? AND remoteId=?').get(m.projectId, m.connector, m.remoteId);
    this.record(current, after, current ? 'remap' : action, actor, note, at);
    return after;
  }
  // The plugin has already resolved the remote with the chosen account; this records the operator's choice.
  async map(a, actor = 'operator') {
    if (!keys(a, 'accountId,connector,expectedRevision,messageId,note,projectId,remoteId,remoteName,site') || !uuid(a.projectId)
      || !Number.isSafeInteger(a.expectedRevision) || a.expectedRevision < 0) throw Error('Invalid tracker mapping');
    const problem = mappingProblem(a);
    if (problem) throw Error(problem);
    await this.directory(a.projectId);
    return this.idempotent(a.messageId, () => ({ mapping: this.public(this.write(a, a.expectedRevision, 'map', actor)) }));
  }
  unmap(a, actor = 'operator') {
    if (!keys(a, 'expectedRevision,id,messageId,note') || !uuid(a.id) || !Number.isSafeInteger(a.expectedRevision) || a.expectedRevision < 1
      || typeof a.note !== 'string' || a.note.length > 500) throw Error('Invalid tracker unmapping');
    // R-E-2: the history note is checked here too, not only by the plugin's input schema.
    const personal = personalMatch(a.note); if (personal) throw Error(`The note contains ${personal}; keep it to plain words`);
    return this.idempotent(a.messageId, () => {
      const current = this.row(a.id);
      if (!current || current.state !== 'mapped') throw Error('That tracker is not mapped');
      if (current.revision !== a.expectedRevision) throw Error(STALE_REVISION);
      const at = this.iso();
      this.db.prepare("UPDATE cc_tracker_mappings SET state='unmapped',revision=?,at=? WHERE id=?").run(current.revision + 1, at, current.id);
      const after = this.row(a.id);
      this.record(current, after, 'unmap', actor, a.note.trim(), at);
      return { mapping: this.public(after) };
    });
  }
  list(a) {
    if (a != null && (!keys(a, 'projectId') || !uuid(a.projectId))) throw Error('Invalid tracker mapping read');
    // Ties on `at` (two trackers mapped in the same millisecond) break by insertion order, never by the random id, so
    // the Trackers tab lists them in the order they were added.
    const rows = a ? this.db.prepare('SELECT * FROM cc_tracker_mappings WHERE projectId=? ORDER BY at,rowid').all(a.projectId)
      : this.db.prepare("SELECT * FROM cc_tracker_mappings WHERE state='mapped' ORDER BY projectId,at,rowid").all();
    return { mappings: rows.map(r => this.public(r)) };
  }
  // J3 rows still waiting for their one-time copy. The plugin decides the account (J5b importLegacy) and
  // calls importLegacy below; nothing is copied without an account decision.
  legacyPending() {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tracker_mappings'").get()) return { pending: [] };
    const rows = this.db.prepare("SELECT l.* FROM tracker_mappings l LEFT JOIN cc_tracker_mapping_imports i ON i.projectId=l.project WHERE l.state='mapped' AND i.projectId IS NULL ORDER BY l.project").all();
    return { pending: rows.map(r => ({ projectId: r.project, tracker: r.tracker, auth: r.auth, site: r.site, remoteId: r.remoteId, remoteName: r.remoteName, revision: r.revision })) };
  }
  // One-time copy of the project's legacy mapping. A `gh-cli` legacy mapping keeps the command-line login
  // (accountId null); a keychain one needs the account the host imported the old token into.
  importLegacy(a, actor = 'system:tracker-migration') {
    if (!keys(a, 'accountId,messageId,projectId') || !uuid(a.projectId) || (a.accountId !== null && !uuid(a.accountId))) throw Error('Invalid legacy tracker import');
    return this.idempotent(a.messageId, () => {
      const done = this.db.prepare('SELECT * FROM cc_tracker_mapping_imports WHERE projectId=?').get(a.projectId);
      if (done) return { imported: false, mapping: this.public(this.row(done.mappingId)) };
      const legacy = this.db.prepare("SELECT * FROM tracker_mappings WHERE project=? AND state='mapped'").get(a.projectId);
      if (!legacy) throw Error('That project has no earlier tracker mapping to copy');
      if ((legacy.auth === 'gh-cli') !== (a.accountId === null)) throw Error(legacy.auth === 'gh-cli' ? 'The earlier mapping used the GitHub command-line login' : 'The earlier mapping needs its imported account');
      // R-E-10: J3 stored Bitbucket repository UUIDs with braces; the new connector (and every issue ref) uses the bare,
      // lower-case form that resolveRemote returns.
      const remoteId = legacy.tracker === 'bitbucket' ? String(legacy.remoteId).replace(/^\{|\}$/g, '').toLowerCase() : legacy.remoteId;
      const m = { projectId: a.projectId, connector: legacy.tracker, accountId: a.accountId, remoteId, remoteName: legacy.remoteName,
        site: Object.hasOwn(CLOUD, legacy.site) ? CLOUD[legacy.site] : legacy.site, note: 'Copied from the earlier one-tracker-per-project set-up' };
      const problem = mappingProblem(m);
      if (problem) throw Error(problem);
      const existing = this.db.prepare('SELECT * FROM cc_tracker_mappings WHERE projectId=? AND connector=? AND remoteId=?').get(m.projectId, m.connector, m.remoteId);
      const row = existing?.state === 'mapped' ? existing : this.write(m, existing?.revision ?? 0, 'import', actor);
      this.db.prepare('INSERT INTO cc_tracker_mapping_imports VALUES (?,?,?,?)').run(a.projectId, legacy.revision, row.id, this.iso());
      return { imported: row !== existing, mapping: this.public(row) };
    });
  }
  // The latest observation per (mapping, item). Derived data: it rotates to the newest N per mapping and never refuses.
  // A refresh writes its items in chunks under one `observation` {id, partial, final}. Rows it did not see stay, as
  // not current (stale); only the final chunk of a COMPLETE observation removes rows the tracker no longer lists.
  putItems(a) {
    if (!(keys(a, 'items,mappingId,observedAt') || keys(a, 'items,mappingId,observation,observedAt')) || !uuid(a.mappingId) || !Array.isArray(a.items) || a.items.length > CC_TRACKER_LIMITS.itemsPerWrite
      || typeof a.observedAt !== 'string' || Number.isNaN(Date.parse(a.observedAt))
      || (a.observation !== undefined && (!keys(a.observation, 'final,id,partial') || !uuid(a.observation.id) || typeof a.observation.partial !== 'boolean' || typeof a.observation.final !== 'boolean'))) throw Error('Invalid tracker observation');
    // A caller without an observation writes a partial one of its own: nothing is ever reconciled away on its word.
    const o = a.observation ?? { id: randomUUID(), partial: true, final: true };
    return this.store.atomic(() => {
      const m = this.row(a.mappingId);
      if (!m || m.state !== 'mapped') throw Error('That tracker is not mapped');
      let stored = 0, refused = 0;
      const observedAt = new Date(a.observedAt).toISOString();
      for (const it of a.items) {
        const parsed = parseRef(it?.key);
        if (itemProblem(it) || it.connector !== m.connector || !CONNECTOR_ID.test(it.connector) || !belongs(parsed, m)) { refused += 1; continue; }
        this.db.prepare('INSERT INTO cc_tracker_observations VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(mappingId,key) DO UPDATE SET projectId=excluded.projectId,json=excluded.json,updatedAt=excluded.updatedAt,observedAt=excluded.observedAt,observationId=excluded.observationId')
          .run(m.id, it.key, m.projectId, m.connector, JSON.stringify(it), new Date(it.updatedAt).toISOString(), observedAt, o.id);
        stored += 1;
      }
      const partial = o.partial || refused > 0;
      const prior = this.db.prepare('SELECT * FROM cc_tracker_observation_runs WHERE mappingId=?').get(m.id);
      this.db.prepare('INSERT INTO cc_tracker_observation_runs VALUES (?,?,?,?) ON CONFLICT(mappingId) DO UPDATE SET observationId=excluded.observationId,observedAt=excluded.observedAt,partial=excluded.partial')
        .run(m.id, o.id, observedAt, partial || (prior?.observationId === o.id && prior.partial) ? 1 : 0);
      const run = this.db.prepare('SELECT partial FROM cc_tracker_observation_runs WHERE mappingId=?').get(m.id);
      // Reconcile only after a complete snapshot: what this observation never saw is gone from the tracker.
      if (o.final && !run.partial) this.db.prepare('DELETE FROM cc_tracker_observations WHERE mappingId=? AND observationId<>?').run(m.id, o.id);
      this.db.prepare('DELETE FROM cc_tracker_observations WHERE mappingId=? AND key NOT IN (SELECT key FROM cc_tracker_observations WHERE mappingId=? ORDER BY updatedAt DESC LIMIT ?)').run(m.id, m.id, CC_TRACKER_LIMITS.itemsPerMapping);
      return { stored, refused, partial: Boolean(run.partial) };
    });
  }
  // Every active mapping's own last observation. `current` is false for a row the latest refresh did not see; a row
  // that fails today's rules (stored before them) is not returned at all.
  items(a) {
    if (!keys(a, 'projectId') || !uuid(a.projectId)) throw Error('Invalid tracker observation read');
    const rows = this.db.prepare("SELECT i.*,r.observationId AS latest FROM cc_tracker_observations i JOIN cc_tracker_mappings m ON m.id=i.mappingId LEFT JOIN cc_tracker_observation_runs r ON r.mappingId=i.mappingId WHERE m.projectId=? AND m.state='mapped' ORDER BY i.updatedAt DESC LIMIT ?").all(a.projectId, CC_TRACKER_LIMITS.itemsPerRead);
    return { items: rows.map(r => ({ mappingId: r.mappingId, observedAt: r.observedAt, item: JSON.parse(r.json), current: r.latest != null && r.observationId === r.latest })).filter(x => itemProblem(x.item) === null) };
  }
  history(id) {
    if (!uuid(id)) throw Error('Invalid tracker mapping');
    return { history: this.db.prepare('SELECT * FROM cc_tracker_mapping_history WHERE entityId=? ORDER BY rowid').all(id).map(h => ({ ...h, before: h.before ? JSON.parse(h.before) : null, after: JSON.parse(h.after) })) };
  }
}
// An observed item must name the mapped remote: its issue ref carries the remote id, a pull request its
// repository name. Anything else is refused, so one mapping can never store another repository's items.
function belongs(ref, m) {
  if (!ref) return false;
  const site = m.site ?? null;
  if (ref.kind === 'issue') return ref.connector === m.connector && (ref.site ?? null) === site && ref.remoteId === m.remoteId;
  if (ref.kind === 'pr') return ref.repoKey.toLowerCase() === `${m.connector}${site ? '@' + site : ''}:${m.remoteName}`.toLowerCase();
  return false;
}
