import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fixture, P } from './decisions.fixture.mjs';
import { Remits } from './remits.mjs';
test('internal refresh records Delivery once and never reclaims moved or ended ownership', async t => {
  const f = await fixture(t);
  const options = { readProjects: async () => f.directory };
  f.control.remits = new Remits(f.control, options);
  await f.control.remits.refresh();
  const first = await f.op('remits-list', null), assigned = first.remits[0];
  assert.equal(first.remits.length, 1);
  assert.equal(assigned.primeSeat, 'delivery');
  assert.equal(first.history[0].actor, 'operator');
  assert.equal(first.history[0].note, 'default: every unowned project goes to Delivery; the operator can move it');
  await f.control.remits.refresh();
  assert.equal((await f.op('remits-list', null)).history.length, 1);
  const moved = await f.op('remits-move', { messageId: randomUUID(), remitId: assigned.id, expectedRevision: 1, toPrimeSeat: 'research', note: 'Research now owns this project' });
  assert.equal((await f.op('remits-list', null)).projects[0].owner.primeSeat, 'research');
  await f.op('remits-end', { messageId: randomUUID(), remitId: moved.remit.id, expectedRevision: 1, note: 'Leave this project without a prime' });
  f.control.remits = new Remits(f.control, options);
  await f.control.remits.refresh();
  assert.equal((await f.op('remits-list', null)).projects[0].owner.kind, 'unassigned');
  f.directory.projects.push({ ...f.directory.projects[0], id: P(2) });
  await f.control.remits.refresh();
  assert.equal((await f.op('remits-list', null)).projects.find(p => p.projectId === P(2)).owner.primeSeat, 'delivery');
});
test('domain ownership and explicit domain edits are not overwritten', async t => {
  const f = await fixture(t); f.control.remits = new Remits(f.control, { readProjects: async () => f.directory });
  await f.control.remits.setDomain({ messageId: randomUUID(), projectId: P(1), domain: 'research', expectedRevision: 0, note: 'Use the research area for ownership' }, { actor: 'operator' });
  await f.control.remits.refresh();
  assert.equal((await f.op('remits-list', null)).remits.length, 0);
  f.directory.projects.push({ ...f.directory.projects[0], id: P(2) });
  await f.control.remits.setDomain({ messageId: randomUUID(), projectId: P(2), domain: 'research', expectedRevision: 0, note: 'Initially put this project in research' }, { actor: 'operator' });
  await f.control.remits.setDomain({ messageId: randomUUID(), projectId: P(2), domain: null, expectedRevision: 1, note: 'Leave this project without a default owner' }, { actor: 'operator' });
  f.control.remits = new Remits(f.control, { readProjects: async () => f.directory });
  await f.control.remits.refresh();
  assert.equal((await f.op('remits-list', null)).remits.length, 0);
  f.directory.available = false;
  await f.control.remits.refresh();
  assert.equal((await f.op('remits-list', null)).remits.length, 0);
});

test('remits-list never writes defaults, including a newly discovered project', async t => {
 const f=await fixture(t);f.control.remits=new Remits(f.control,{readProjects:async()=>f.directory});
 const counts=()=>['cc_remits','cc_remit_history','cc_project_domains'].map(table=>f.control.remits.count(table));
 const before=counts(),changes=f.store.db.prepare('SELECT total_changes() n').get().n;
 const empty=await f.op('remits-list',null);
 assert.deepEqual(counts(),before);
 assert.equal(empty.projects[0].owner.kind,'unassigned');assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,changes);
 await f.control.remits.refresh();
 f.directory.projects.push({...f.directory.projects[0],id:P(2)});
 const assigned=counts(),after=f.store.db.prepare('SELECT total_changes() n').get().n;
 const later=await f.op('remits-list',null);
 assert.deepEqual(counts(),assigned);
 assert.equal(later.projects.find(p=>p.projectId===P(2)).owner.kind,'unassigned');assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,after);
});
test('internal refresh coalesces and does not write after shutdown',async t=>{
 const f=await fixture(t);let finish,reads=0;
 f.control.remits=new Remits(f.control,{readProjects:()=>{reads++;return new Promise(resolve=>{finish=resolve;});}});
 const a=f.control.remits.refresh(),b=f.control.remits.refresh();assert.equal(a,b);assert.equal(reads,1);
 f.control.closing=true;finish(f.directory);await a;
 assert.equal(f.control.remits.count('cc_remits'),0);await f.control.remits.refresh();assert.equal(reads,1);
});
test('internal refresh retries failed directory reads and requires a Delivery binding',async t=>{
 const f=await fixture(t);let unavailable=true;
 f.control.remits=new Remits(f.control,{readProjects:async()=>{if(unavailable)throw Error('offline');return f.directory;}});
 await assert.rejects(f.control.remits.refresh(),/offline/);assert.equal(f.control.remits.count('cc_remits'),0);
 unavailable=false;await f.control.remits.refresh();assert.equal(f.control.remits.count('cc_remits'),1);
 f.store.db.prepare("DELETE FROM role_bindings WHERE role='prime' AND seat='delivery'").run();
 f.directory.projects.push({...f.directory.projects[0],id:P(2)});await f.control.remits.refresh();assert.equal(f.control.remits.count('cc_remits'),1);
});
test('controller startup and watchdog share the internal refresh and shutdown drains it',()=>{
 const source=fs.readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
 assert.match(source,/const refreshEvents = [^\n]*control\.remits\.refresh\(\)/);
 assert.match(source,/await refreshEvents\(\);/);assert.match(source,/eventWatchdog = setInterval[^\n]*refreshEvents/);
 assert.match(source,/async function stop\(\)[^\n]*control\.remits\.refreshing/);
});
