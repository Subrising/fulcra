import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { journalPolicy } from './hook-journal-policy.mjs';
import { BOOT, mcpRefreshAdmissionInStore } from './admission-guard.mjs';
for (const implementation of ['hook', 'legacy']) for (const mode of ['human', 'delegated']) test(`${implementation}: only an exact ${mode} account-switch intent permits reconnect`, t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE sessions(id,task,cwd,mode,generation,expected,authority,expectedAt,boot,grantedAt);
    CREATE TABLE event_links(worker,supervisor,epoch,workerGeneration,supervisorGeneration);
    CREATE TABLE manager_workers(worker,supervisor,epoch,generation,phase);
    CREATE TABLE manager_grants(supervisor,generation,epoch,maxWorkers);
    CREATE TABLE permission_grants(session,rootSession);
    CREATE TABLE deliveries(id,session,kind,state,body);`);
  const id = randomUUID(), intent = randomUUID(), agent = { id, cwd: '/scratch/project' };
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, 2, NULL, ?, NULL, ?, 1)').run(id, 'task', agent.cwd, mode, 'authority', BOOT);
  const check = implementation === 'hook' ? journalPolicy({ boot: BOOT, require: () => ({ boot: BOOT, humanAt: 0 }) }).mcpRefreshAdmissionInStore : mcpRefreshAdmissionInStore;
  const body = { generation: 2, boot: BOOT, humanAt: 0, accountId: randomUUID() };
  db.prepare('INSERT INTO deliveries VALUES (?, ?, ?, ?, ?)').run(intent, id, 'account-switch', 'intent', JSON.stringify(body));
  assert.equal(check(db, agent).allowed, true);
  const before = check(db, agent).revision;
  db.prepare('UPDATE deliveries SET body=?').run(JSON.stringify({ ...body, accountId: randomUUID() }));
  assert.notEqual(check(db, agent).revision, before, 'target identity participates in the final fence');
  for (const changed of [{ generation: 3 }, { boot: 'old' }, { humanAt: 1 }]) {
    db.prepare('UPDATE deliveries SET body=?').run(JSON.stringify({ ...body, ...changed }));
    assert.equal(check(db, agent).allowed, false);
  }
  db.prepare('UPDATE deliveries SET body=?,state=?').run(JSON.stringify(body), 'uncertain');
  assert.equal(check(db, agent).allowed, false);
  db.prepare('UPDATE deliveries SET state=?').run('intent');
  db.prepare('INSERT INTO deliveries VALUES (?, ?, ?, ?, ?)').run(randomUUID(), id, 'send', 'intent', '{}');
  assert.equal(check(db, agent).allowed, false);
});
