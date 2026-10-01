import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { groupNotification } from './group.mjs';
import { emit, notificationText } from './watch.mjs';

export function watchKey(input) {
  const { sessionId, generation, messageId, sessionKey } = input;
  const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
  if (!uuid(sessionId) || !uuid(messageId) || !Number.isSafeInteger(generation) || generation < 1 || typeof sessionKey !== 'string' || !/^agent:main:[a-z0-9:_-]{1,150}$/.test(sessionKey)) throw Error('Invalid watch identity');
  if ('workerProvider' in input && (input.scope !== 'group' || !['claude','codex','mixed'].includes(input.workerProvider))) throw Error('Invalid group worker provider');
  if (input.scope !== undefined && (input.scope !== 'group' || !uuid(input.outcomeId))) throw Error('Invalid group watch identity');
  return createHash('sha256').update(JSON.stringify([sessionId, generation, messageId, sessionKey, ...(input.scope === 'group' ? ['group', input.outcomeId] : []), ...('workerProvider' in input ? ['workerProvider', input.workerProvider] : [])])).digest('hex');
}

export class WatchQueue {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const s = fs.statSync(directory);
    if (fs.realpathSync(directory) !== directory || s.uid !== process.getuid() || s.mode & 0o077) throw Error('Private queue directory required');
    this.file = path.join(directory, 'queue.sqlite');
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const file = this.file + suffix;
      if (!fs.existsSync(file) && !fs.lstatSync(file, { throwIfNoEntry: false })) continue;
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077) throw Error('Unsafe queue file');
    }
    const fd = fs.openSync(this.file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    fs.closeSync(fd);
    this.db = new DatabaseSync(this.file);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS watches (key TEXT PRIMARY KEY, input TEXT NOT NULL, state TEXT NOT NULL,
        owner TEXT, lease INTEGER, detail TEXT, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS health (id INTEGER PRIMARY KEY CHECK(id=1), seen INTEGER NOT NULL, pid INTEGER NOT NULL);`);
    const dir = fs.openSync(directory, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
  close() { this.db.close(); }
  enqueue(input, now = Date.now()) {
    const key = watchKey(input);
    const legacy = path.join(path.dirname(this.file), '..', 'conversation-watches', key + '.json');
    if (fs.lstatSync(legacy, { throwIfNoEntry: false })) return { state: 'existing-watch', watchFile: legacy, note: 'Legacy record retained; inspect it without replay.' };
    const clean = { sessionId: input.sessionId, generation: input.generation, messageId: input.messageId, sessionKey: input.sessionKey, ...(input.scope === 'group' ? { scope: 'group', outcomeId: input.outcomeId, ...('workerProvider' in input ? {workerProvider:input.workerProvider} : {}) } : {}) };
    this.db.prepare("INSERT OR IGNORE INTO watches(key,input,state,updated) VALUES(?,?,'queued',?)").run(key, JSON.stringify(clean), now);
    return { ...this.get(key), service: this.health(now), accepted: false, note: 'Durable tracking only; no worker instruction or model turn started. The owned service handles waiting.' };
  }
  acknowledgeGroup(a, now = Date.now()) {
    const row = this.get(a.watchKey);
    if (!row || row.scope !== 'group' || !['wake-submitted', 'handled'].includes(row.state) || ['sessionId', 'generation', 'messageId', 'outcomeId', 'workerProvider'].some(k => row[k] !== a[k]) || row.detail?.resultReceipt?.outputEvidenceHash !== a.outputEvidenceHash) throw Error('Group watch is not a matching delivered outcome');
    const detail = { ...row.detail, handledAt: row.detail.handledAt ?? now };
    this.db.prepare("UPDATE watches SET state='handled',detail=?,updated=? WHERE key=? AND state='wake-submitted'").run(JSON.stringify(detail), now, a.watchKey);
    return { watchKey: a.watchKey, handled: true, accepted: false, outputEvidenceHash: a.outputEvidenceHash, note: 'Group callback handled; no ingress receipt or independent acceptance was fabricated.' };
  }
  get(key) {
    const row = this.db.prepare('SELECT key,input,state,detail,updated,lease FROM watches WHERE key=?').get(key);
    return row ? { key: row.key, ...JSON.parse(String(row.input)), state: row.state, detail: row.detail ? JSON.parse(String(row.detail)) : null, updatedAt: row.updated, leaseUntil: row.lease } : null;
  }
  health(now = Date.now()) {
    const row = this.db.prepare('SELECT seen,pid FROM health WHERE id=1').get();
    return { lastSeenAt: row?.seen ?? null, pid: row?.pid ?? null, recentlySeen: !!row && now - Number(row.seen) < 60000 };
  }
  heartbeat(now = Date.now()) { this.db.prepare('INSERT OR REPLACE INTO health VALUES(1,?,?)').run(now, process.pid); }
  list() { return { service: this.health(), watches: this.db.prepare('SELECT key FROM watches ORDER BY updated DESC LIMIT 32').all().map(row => this.get(row.key)), note: 'Last 32 records. Dispatch-intent or needs-reconciliation must never be automatically retried; wake-submitted is not consumption.' }; }
  claim(owner, now = Date.now()) {
    const row = this.db.prepare(`UPDATE watches SET state='waiting',owner=?,lease=?,updated=? WHERE key=(
      SELECT key FROM watches WHERE state='queued' OR (state='waiting' AND lease<?) ORDER BY updated,key LIMIT 1)
      RETURNING key,input`).get(owner, now + 90000, now, now);
    return row ? { key: String(row.key), input: JSON.parse(String(row.input)) } : null;
  }
  transition(key, owner, from, to, detail = null, now = Date.now()) {
    return this.db.prepare('UPDATE watches SET state=?,detail=?,updated=?,lease=NULL WHERE key=? AND owner=? AND state=?')
      .run(to, JSON.stringify(detail), now, key, owner, from).changes === 1;
  }
}

// Every dispatch is preceded by a committed CAS. A stale lease holder cannot emit;
// a process dying after that commit leaves an ambiguous intent, never a retry.
export async function processOne(queue, run, notify = emit) {
  const owner = randomUUID(), job = queue.claim(owner);
  if (!job) return false;
  let result;
  try { result = await run({ action: job.input.scope === 'group' ? 'wait-group' : 'wait', sessionId: job.input.sessionId, generation: job.input.generation, messageId: job.input.messageId, ...(job.input.scope === 'group' ? { outcomeId: job.input.outcomeId, ...('workerProvider' in job.input ? {workerProvider:job.input.workerProvider} : {}) } : {}) }); }
  catch (error) { result = { needsAttention: true, state: 'wait-error', error: String(error.message).slice(0, 2000) }; }
  if (result.state === 'wait-deadline') {
    const last = result.lastObservation;
    queue.transition(job.key, owner, 'waiting', 'queued', job.input.scope === 'group' && last ? { observed: { state: last.state, reason: last.reason ?? null, evidence: last.evidence ?? null } } : null); return true;
  }
  const detail = { ...(job.input.scope === 'group' ? { resultReceipt: { messageId: result.messageId ?? null, outputEvidenceHash: result.outputEvidenceHash ?? null } } : {}), originalInstruction: result.originalInstruction ?? null, error: result.error ?? null, observed: { ended: result.ended ?? false, outputObserved: result.outputObserved ?? false, needsAttention: result.needsAttention ?? false, state: result.state ?? null, ...(job.input.scope === 'group' ? { reason: result.reason ?? null, evidence: result.evidence ?? null } : {}) } };
  if (!queue.transition(job.key, owner, 'waiting', 'dispatch-intent', detail)) return true;
  try {
    const response = await notify(job.input.sessionKey, (job.input.scope === 'group' ? groupNotification : notificationText)(job.input, detail.observed, `${queue.file} receipt key ${job.key}; use the watches action`));
    queue.transition(job.key, owner, 'dispatch-intent', 'wake-submitted', { ...detail, response });
  } catch (error) {
    queue.transition(job.key, owner, 'dispatch-intent', 'needs-reconciliation', { ...detail, error: String(error.message).slice(0, 2000) });
  }
  return true;
}
