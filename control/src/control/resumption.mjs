import { delegationFence } from './native-fence.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { hash } from './store.mjs';
import { uuid, authorityKey } from './authority.mjs';
const keys = (a, names) => a && typeof a === 'object' && !Array.isArray(a) && Object.keys(a).sort().join() === names;
function canonical(a) {
  if (!keys(a, 'expectedGeneration,messageId,reason,sessionId,workers') || !uuid(a.messageId) || !uuid(a.sessionId) || !Number.isSafeInteger(a.expectedGeneration) || typeof a.reason !== 'string' || a.reason.trim().length < 12 || a.reason.length > 2000 || !Array.isArray(a.workers) || a.workers.length > 6) throw Error('Invalid organization handback');
  if (a.workers.some(w => !keys(w, 'expectedGeneration,sessionId') || !uuid(w.sessionId) || !Number.isSafeInteger(w.expectedGeneration)) || new Set([a.sessionId, ...a.workers.map(w => w.sessionId)]).size !== a.workers.length + 1) throw Error('Invalid or duplicate selected worker');
  return { ...a, workers: a.workers.map(w => ({ sessionId: w.sessionId, expectedGeneration: w.expectedGeneration })).sort((x, y) => x.sessionId.localeCompare(y.sessionId)) };
}
function lock(control, a) {
  const acquired = [], release = () => acquired.forEach(k => control.busy.delete(k));
  try {
    for (const k of [...[a.sessionId, ...(a.destinationId ? [a.destinationId] : [])].sort().map(id => 'manager:' + id), ...[a.sessionId, ...(a.destinationId ? [a.destinationId] : []), ...a.workers.map(w => w.sessionId)].sort()]) {
      if (control.busy.has(k)) throw Error('Session operation already in flight');
      control.busy.add(k); acquired.push(k);
    }
    return release;
  } catch (error) { release(); throw error; }
}
function tokenFile(directory, name, sessionId, token, generation) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(directory) !== directory || !uuid(name)) throw Error('Invalid handback grant directory');
  const file = path.join(directory, name + '.json'), temp = file + '.' + randomUUID();
  try {
    fs.writeFileSync(temp, JSON.stringify({ sessionId, capability: token, ...(generation === undefined ? {} : { generation }) }), { mode: 0o600, flag: 'wx', flush: true });
    fs.renameSync(temp, file);
    const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function selected(manager, a) {
  const { store, db } = manager, parent = store.get(a.sessionId);
  const role = db.prepare('SELECT * FROM manager_grants WHERE supervisor=?').get(a.sessionId);
  if (!parent || !role || db.prepare('SELECT worker FROM event_links WHERE worker=?').get(a.sessionId) || !db.prepare("SELECT id FROM deliveries WHERE kind='create' AND state='delivered' AND json_extract(result,'$.id')=? AND json_extract(result,'$.cwd')=? AND json_extract(result,'$.managerToolsVersion')='1'").get(a.sessionId, parent.cwd)) throw Error('Recorded capable saved supervisor required');
  const rows = [a, ...a.workers].map(w => {
    const s = store.get(w.sessionId);
    if (!s || s.task !== parent.task || s.mode !== 'human' || s.generation !== w.expectedGeneration) throw Error('Handback requires unchanged human-owned sessions in the same task');
    if (db.prepare("SELECT id FROM deliveries WHERE session=? AND state IN ('intent','uncertain') AND id!=?").get(s.id, a.messageId)) throw Error('Uncertain delivery requires reconciliation before handback');
    const origin = s.id === parent.id ? null : db.prepare('SELECT * FROM manager_workers WHERE worker=? AND supervisor=?').get(s.id, parent.id);
    const link = s.id === parent.id ? null : db.prepare('SELECT supervisor FROM event_links WHERE worker=?').get(s.id);
    if (s.id !== parent.id && (!origin || origin.phase !== 'attached' || link?.supervisor !== parent.id)) throw Error('Selected worker is not a completed saved relationship of this supervisor');
    return { s, origin };
  });
  return { parent, role, rows };
}
export async function resumeOrganization(manager, input) {
  return transferOrganization(manager, canonical(input), selected, 'resume');
}
export async function transferOrganization(manager, a, select, kind, committed) {
  const c = manager.control, { store, db } = manager;
  if (store.delivery(a.messageId)) return store.admit(a.messageId, a.sessionId, kind, a).prior;
  const release = lock(c, a); let admitted = false;
  try {
    const initial = select(manager, a);
    c.native.assertLocal?.(...(kind === 'resume' ? [initial.parent.id] : initial.rows.map(({s})=>s.id)));
    for (const {s} of initial.rows) c.native.ready?.(s.id);
    store.admit(a.messageId, a.sessionId, kind, a); admitted = true;
    const observed = [];
    for (const { s } of initial.rows) {
      const native = await c.native.inspect(s.id), grantedAt = delegationFence(native), snapshot = await c.native.snapshot(s.id);
      if (!['idle','closed'].includes(native.status) || native.archivedAt || native.pending || native.humanAt >= grantedAt || !native.boot || snapshot.cwd !== s.cwd || snapshot.labels?.owner !== (c.native.route?.(s.id) ? 'orca-book-task' : 'orca-control') || snapshot.labels?.task !== s.task || !['idle','closed'].includes(snapshot.status) || snapshot.pendingPermissions?.length) throw Error('Native session changed or is not idle for handback');
      observed.push({ id: s.id, grantedAt, native, baseline: c.events.summary(snapshot) });
    }
    const authority = authorityKey(await c.authority(initial.parent.task));
    if (kind === 'resume' && observed.some(o => c.native.route?.(o.id))) {
      store.atomic(() => {
        if (JSON.stringify(select(manager,a)) !== JSON.stringify(initial)) throw Error('Saved organization changed before preparation');
        c.native.resumptions.reserve(a.messageId,observed);
        store.finish(a.messageId,'intent',{remotePreparation:true,nativeDispatched:false});
      });
      await c.native.resumptions.acknowledge(a.messageId);
      for (const o of observed) {
        const fresh = await c.native.inspect(o.id);
        if (fresh.boot !== o.native.boot || delegationFence(fresh) !== o.grantedAt || fresh.nativeId !== o.native.nativeId || fresh.lastPromptId !== o.native.lastPromptId || fresh.archivedAt || fresh.pending || !['idle','closed'].includes(fresh.status)) throw Error('Native team changed during remote preparation');
      }
      if (authorityKey(await c.authority(initial.parent.task)) !== authority) throw Error('Task authority changed during remote preparation');
    }
    return store.atomic(() => {
      const current = select(manager, a);
      if (JSON.stringify(current) !== JSON.stringify(initial)) throw Error('Saved organization changed during handback');
      const epoch = randomUUID(), managerToken = randomBytes(32).toString('base64url'), inboxToken = randomBytes(32).toString('base64url'), transfers = [];
      for (const o of observed) {
        const mode = o.id === current.outgoing ? 'human' : 'delegated';
        const granted = store.transferRows(o.id, mode, a.reason, o.native.lastPromptId);
        // Private, receipt-scoped handback grant; a rolled-back token cannot pass store.check.
        if (kind === 'resume' && o.id === current.parent.id) tokenFile(path.join(manager.directory, 'conversation'), a.messageId, o.id, granted.capability, granted.generation);
        db.prepare('UPDATE sessions SET authority=?,expectedAt=?,boot=?,grantedAt=? WHERE id=?').run(authority, o.native.lastUserAt ?? null, o.native.boot, o.grantedAt, o.id);
        transfers.push({ sessionId: o.id, generation: granted.generation, transferId: granted.transferId });
      }
      if (kind === 'resume') c.native.resumptions?.activate(a.messageId);
      const parentId = current.parent.id, parentGeneration = transfers.find(t => t.sessionId === parentId).generation;
      db.prepare('INSERT OR REPLACE INTO manager_grants VALUES (?,?,?,?,?,?)').run(parentId, parentGeneration, epoch, hash(managerToken), current.role.maxWorkers, a.reason);
      db.prepare('INSERT OR REPLACE INTO event_credentials VALUES (?,?,?)').run(parentId, parentGeneration, hash(inboxToken));
      for (const { s, origin } of current.rows.filter(row => row.origin)) {
        const generation = transfers.find(t => t.sessionId === s.id).generation, o = observed.find(v => v.id === s.id);
        db.prepare('INSERT OR IGNORE INTO manager_origins VALUES (?,?)').run(s.id, JSON.stringify(origin));
        db.prepare("UPDATE manager_workers SET supervisor=?,epoch=?,generation=? WHERE worker=?").run(parentId, epoch, generation, s.id);
        db.prepare("UPDATE event_pending SET state='unresolved-reattached' WHERE worker=? AND state='pending'").run(s.id);
        db.prepare('INSERT OR REPLACE INTO event_links VALUES (?,?,?,?,?,?,?)').run(s.id, parentId, randomUUID(), generation, parentGeneration, JSON.stringify(o.baseline), a.reason);
        db.prepare('DELETE FROM event_faults WHERE worker=?').run(s.id);
      }
      for (const id of new Set([a.sessionId, parentId])) db.prepare("UPDATE event_inbox SET state='suspended' WHERE supervisor=? AND state IN ('queued','uncertain')").run(id);
      tokenFile(manager.directory, path.basename(current.parent.cwd), parentId, managerToken);
      tokenFile(c.events.grantDirectory, path.basename(current.parent.cwd), parentId, inboxToken);
      const extra = committed?.(current, transfers, observed) ?? {};
      return store.finish(a.messageId, 'delivered', { sessionId: parentId, transfers, ...extra, note: kind === 'resume' ? 'Selected delegation restored atomically. No model instruction was sent; prior work was not accepted or replayed.' : 'Ownership transferred atomically; handoff delivery and consumption are separate.' });
    });
  } catch (error) {
    if (!admitted) throw error;
    if (kind === 'resume' && store.delivery(a.messageId)?.result?.remotePreparation) return await finishRemoteRecovery(manager,a.messageId,error.message);
    return store.finish(a.messageId, 'refused', { error: error.message, authorityChanged: false, nativeDispatched: false });
  } finally { release(); }
}
export async function recoverResumption(manager, record) {
  if (!record.result?.remotePreparation) return recoverOrganization(manager, record, canonical, 'resume');
  const a = canonical(JSON.parse(record.body)), release = lock(manager.control,a);
  try {
    const current = manager.store.delivery(record.id);
    if (current.kind !== 'resume' || current.body !== record.body || !['intent','uncertain'].includes(current.state)) throw Error('Resumption receipt changed');
    return await finishRemoteRecovery(manager,record.id,'Reconcile the exact uncommitted remote preparation');
  } finally { release(); }
}
async function finishRemoteRecovery(manager,id,error) {
  let recovery;
  try { recovery = await manager.control.native.resumptions.cancel(id); }
  catch (failure) { recovery = {complete:false,error:failure.message}; }
  return manager.store.finish(id,recovery.complete?'refused':'uncertain',{remotePreparation:true,authorityChanged:true,nativeDispatched:false,error,recovery,note:'Prepared remote grants require acknowledged revocation; no instruction or work acceptance occurred. Newer authority is preserved.'});
}
export function recoverOrganization(manager, record, validate, kind) {
  const a = validate(JSON.parse(record.body)), release = lock(manager.control, a);
  try {
    const current = manager.store.delivery(record.id);
    if (current.kind !== kind || current.body !== record.body || !['intent','uncertain'].includes(current.state)) throw Error('Resumption receipt changed');
    return manager.store.finish(record.id, 'refused', { authorityChanged: false, nativeDispatched: false, note: 'Never-committed handback reconciled. Current authority was not changed; use a new explicit request if desired.' });
  } finally { release(); }
}
