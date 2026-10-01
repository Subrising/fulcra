import { RoleSessions } from './role-sessions.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { ControlStore } from './store.mjs';
import { Controller } from './controller.mjs';
import { Events } from './events.mjs';
import { Manager } from './manager.mjs';
import { BOOT, observation, admit, guard } from '../../tools/legacy-host-admission.fixture.mjs';
import { PROGRAMME, COMPANY } from './authority.mjs';
import { requireUnpinnedAdmissionGuard } from './admission-guard-precondition.mjs';
import { AUTOMATION_LIMIT } from './journal-capacity.mjs';
requireUnpinnedAdmissionGuard(); // Fails loudly when the working guard is pinned; see that module.
async function fixture(t, limit = 3) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-manager-'))), store = new ControlStore(path.join(dir,'journal.sqlite'));
  const snapshots = new Map(), calls = [], sends = [], s = randomUUID();
  const add = id => { const cwd=path.join(dir,id); fs.mkdirSync(cwd); snapshots.set(id,{id,cwd,status:'idle',pending:0,lastPromptId:null,lastUserAt:null,pendingPermissions:[],runtimeInfo:{sessionId:randomUUID()}}); return {id,cwd,runtimeInstanceId:'instance-'+id}; };
  const native = {
    verifyNew: async () => {},
    create: async (a, options) => { calls.push({a,options}); const agent=add(randomUUID()); await native.afterCreate?.(agent); return agent; },
    inspect: async id => { await native.beforeInspect?.(id); return {...snapshots.get(id),...observation(id),nativeId:snapshots.get(id).runtimeInfo.sessionId}; },
    snapshot: async id => snapshots.get(id),
    send: async (id,text,messageId) => { await native.beforeSend?.(id); admit(store.db,{id,pendingPermissions:[],lastUserMessageAt:null},text,messageId,false); sends.push({id,text,messageId}); Object.assign(snapshots.get(id),{status:'running',lastPromptId:messageId,lastUserAt:messageId}); }
  };
  const issue = {id:PROGRAMME,companyId:COMPANY,assigneeUserId:'local-board',status:'in_progress'};
  const c = new Controller({store,native,authority:async()=>issue});
  c.events=new Events(c,path.join(dir,'inbox')); c.manager=new Manager(c,path.join(dir,'manager'));
  const agent=add(s); store.created(s,PROGRAMME,agent.cwd); const sg=await c.handback(s,'Explicitly delegate test supervisor');
  const grant=await c.manager.grant({sessionId:s,expectedGeneration:sg.generation,capability:sg.capability,maxWorkers:limit,reason:'Manage bounded owned test workers'}), token=JSON.parse(fs.readFileSync(grant.grantFile)).capability;
  const create = (messageId=randomUUID(), title='Owned test worker') => c.manager.create({sessionId:s,messageId,provider:'claude',title},token);
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {c,store,native,s,sg,grant,token,create,snapshots,calls,sends,issue,dir};
}
test('manager creates a native worker once, attaches before assignment and uses server-generated identity',async t=>{
  const f=await fixture(t), request=randomUUID(), w=await f.create(request), again=await f.create(request);
  assert.equal(w.sessionId,again.sessionId); assert.equal(f.calls.length,1); assert.notEqual(f.calls[0].a.messageId,request); assert.equal(f.calls[0].options.fresh,true);
  assert.equal(f.store.delivery(f.calls[0].a.messageId).result.runtimeInstanceId,'instance-'+w.sessionId);
  const messageId=randomUUID(), result=await f.c.manager.assign({sessionId:f.s,workerId:w.sessionId,messageId,text:'Produce the owned document'},f.token);
  assert.equal(result.state,'delivered'); assert.equal(f.sends.length,1); assert.equal(f.store.db.prepare('SELECT count(*) n FROM event_pending').get().n,1);
  assert.equal((await f.c.manager.assign({sessionId:f.s,workerId:w.sessionId,messageId,text:'Produce the owned document'},f.token)).state,'delivered'); assert.equal(f.sends.length,1);
  assert.equal((await f.c.manager.inspect({sessionId:f.s,workerId:w.sessionId},f.token)).observed.nativeId,f.snapshots.get(w.sessionId).runtimeInfo.sessionId);
});
test('changed IDs, foreign workers and interchangeable tokens are refused',async t=>{
  const f=await fixture(t), request=randomUUID(), w=await f.create(request);
  await assert.rejects(f.create(request,'Changed creation specification'),/identity conflict/);
  await assert.rejects(f.c.manager.workers({sessionId:f.s},f.sg.capability),/authority/);
  assert.throws(()=>f.store.check(f.s,f.token),/capability/);
  await assert.rejects(f.c.manager.inspect({sessionId:f.s,workerId:randomUUID()},f.token),/not currently delegated/);
  const id=randomUUID();await f.c.manager.assign({sessionId:f.s,workerId:w.sessionId,messageId:id,text:'First instruction'},f.token);
  await assert.rejects(f.c.manager.assign({sessionId:f.s,workerId:w.sessionId,messageId:id,text:'Different instruction'},f.token),/identity conflict/);
});
test('same-task manager reads only declared idle-worker output through existing inspection', async t => {
  const f = await fixture(t), w = await f.create(), cwd = f.store.get(w.sessionId).cwd, text = 'Reviewed worker output\n';
  const input = { sessionId: f.s, workerId: w.sessionId };
  assert.equal((await f.c.manager.inspect(input, f.token)).artifacts.state, 'not-declared');
  fs.writeFileSync(cwd + '/guide.md', text);
  fs.writeFileSync(cwd + '/.orca-artifacts.json', JSON.stringify({ version: 1, files: [{ path: 'guide.md', sha256: createHash('sha256').update(text).digest('hex') }] }));
  const result = await f.c.manager.inspect(input, f.token); assert.equal(result.artifacts.state, 'available'); assert.equal(result.artifacts.files[0].text, text); assert.equal(f.sends.length, 0);
  f.snapshots.get(w.sessionId).status = 'running'; assert.equal((await f.c.manager.inspect(input, f.token)).artifacts.state, 'unavailable');
  f.snapshots.get(w.sessionId).status = 'idle'; f.snapshots.get(w.sessionId).pending = 1; assert.equal((await f.c.manager.inspect(input, f.token)).artifacts.state, 'unavailable');
});
test('worker takeover or manager authority change during artifact inspection refuses output', async t => {
  for (const actor of ['worker', 'supervisor']) {
    const f = await fixture(t), w = await f.create(); let inspections = 0;
    f.native.beforeInspect = async id => {
      if (id === (actor === 'worker' ? w.sessionId : f.s) && ++inspections === 2) guard({ id }, '', undefined, false);
    };
    await assert.rejects(f.c.manager.inspect({ sessionId: f.s, workerId: w.sessionId }, f.token), /changed|authority|delegated/);
  }
});
test('quota and link capacity refuse before creating another native session',async t=>{
  const f=await fixture(t,1); await f.create(); await assert.rejects(f.create(),/allowance/); assert.equal(f.calls.length,1);
  const g=await fixture(t);const links=g.c.events.links;g.c.events.links=()=>Array(32).fill({});await assert.rejects(g.create(),/capacity/);assert.equal(g.calls.length,0);g.c.events.links=links;
});
// G2 (G-FIXES-REPORT.md): the Tally orchestrator's supervisor_inbox failed with ENOENT on grants/inbox/<id>.json because
// only attaching a worker issued that file, and every creation was refused (G3).
test('a manager grant issues the manager inbox before any worker exists',async t=>{
  const f=await fixture(t); assert.equal(f.grant.inboxFile, path.join(f.dir,'inbox',path.basename(f.store.get(f.s).cwd)+'.json'));
  const inbox=JSON.parse(fs.readFileSync(f.grant.inboxFile,'utf8')); assert.equal(inbox.sessionId,f.s); assert.notEqual(inbox.capability,f.token);
  assert.deepEqual(f.c.events.inbox(f.s,inbox.capability).events,[]); assert.throws(()=>f.c.events.inbox(f.s,f.token),/revoked or invalid/);
  f.c.takeover(f.s,'Human takes the manager back'); assert.throws(()=>f.c.events.inbox(f.s,inbox.capability),/revoked or invalid/);
});
// G3 (G-FIXES-REPORT.md): the live journal held 582 deliveries and 13 links; every creation was refused with a message
// blaming "link or wake capacity". A granted manager must reach its maxWorkers on such a journal, and each limit must
// say which one it is.
test('a granted manager creates up to maxWorkers on a journal past the old half-way mark, and each limit names itself',async t=>{
  const fill=(store,n)=>{store.db.exec('BEGIN');while(store.db.prepare('SELECT count(*) n FROM deliveries').get().n<n)store.db.prepare("INSERT INTO deliveries VALUES (?,NULL,'fixture','{}','delivered',NULL)").run(randomUUID());store.db.exec('COMMIT');};
  const f=await fixture(t,3); fill(f.store,582);
  for(let n=0;n<3;n++)assert.equal((await f.create()).state,'ready');
  await assert.rejects(f.create(),/worker allowance reached: 3 live workers of 3/); assert.equal(f.calls.length,3);
  const g=await fixture(t); fill(g.store,AUTOMATION_LIMIT-2);
  await assert.rejects(g.create(),/Journal automation budget reached before creation: \d+ deliveries recorded/); assert.equal(g.calls.length,0);
  const h=await fixture(t); h.c.events.links=()=>Array(32).fill({});
  await assert.rejects(h.create(),/Supervision link capacity reached before creation: 32 live links/); assert.equal(h.calls.length,0);
});
test('uncertain creation persists one reservation and never calls native create again',async t=>{
  const f=await fixture(t,1), id=randomUUID();f.native.create=async()=>{f.calls.push('attempt');throw Error('lost acknowledgment');};
  assert.equal((await f.create(id)).state,'uncertain'); f.c.manager=new Manager(f.c,path.join(f.dir,'manager'));
  assert.equal((await f.create(id)).operatorRecoveryRequired,true);assert.equal(f.calls.length,1);await assert.rejects(f.create(),/allowance/);
});
test('human stop on the newly created worker prevents automatic delegation',async t=>{
  const f=await fixture(t);f.native.afterCreate=async a=>guard({id:a.id},'',undefined,false);
  await assert.rejects(f.create(),/touched/);const w=f.store.list().find(a=>a.id!==f.s);assert.equal(w.mode,'human');assert.equal(w.generation,1);assert.equal(f.sends.length,0);
});
test('human stop arriving inside handback also prevents automatic delegation',async t=>{
  const f=await fixture(t), original=f.c.handback.bind(f.c);f.c.handback=async(id,...args)=>{guard({id},'',undefined,false);return original(id,...args);};
  await assert.rejects(f.create(),/touched/);assert.equal(f.store.list().find(a=>a.id!==f.s).mode,'human');
});
test('supervisor takeover during creation retains human-owned empty worker',async t=>{
  const f=await fixture(t);f.native.afterCreate=async()=>f.c.takeover(f.s,'Human interrupted manager creation');
  await assert.rejects(f.create(),/authority/);const w=f.store.list().find(a=>a.id!==f.s);assert.equal(w.mode,'human');assert.equal(f.sends.length,0);
});
test('native parent barrier wins after controller authorization but before worker dispatch',async t=>{
  const f=await fixture(t), w=await f.create();f.native.beforeSend=async()=>guard({id:f.s},'',undefined,false);
  const result=await f.c.manager.assign({sessionId:f.s,workerId:w.sessionId,messageId:randomUUID(),text:'This must not reach native work'},f.token);
  assert.equal(result.state,'refused');assert.equal(f.sends.length,0);assert.equal(f.store.get(w.sessionId).mode,'human');
});
test('grant rotation at native dispatch refuses the old manager intent',async t=>{
  const f=await fixture(t),w=await f.create();f.native.beforeSend=async()=>f.store.db.prepare('UPDATE manager_grants SET epoch=? WHERE supervisor=?').run(randomUUID(),f.s);
  assert.equal((await f.c.manager.assign({sessionId:f.s,workerId:w.sessionId,messageId:randomUUID(),text:'Old grant input'},f.token)).state,'refused');assert.equal(f.sends.length,0);
});
test('takeover and re-grant do not reacquire previous workers; list shows orphaned',async t=>{
  const f=await fixture(t),w=await f.create();f.c.takeover(f.s,'Human takes supervisor control');const sg=await f.c.handback(f.s,'New explicit supervisor delegation');
  const g=await f.c.manager.grant({sessionId:f.s,expectedGeneration:sg.generation,capability:sg.capability,maxWorkers:3,reason:'New grant without adopting old workers'}), token=JSON.parse(fs.readFileSync(g.grantFile)).capability;
  await assert.rejects(f.c.manager.assign({sessionId:f.s,workerId:w.sessionId,messageId:randomUUID(),text:'No silent resumption'},token),/not currently delegated/);
  assert.equal((await f.c.manager.workers({sessionId:f.s},token))[0].state,'orphaned');
  const create=()=>f.c.manager.create({sessionId:f.s,messageId:randomUUID(),provider:'codex',title:'New epoch worker'},token);
  // G27: the previous epoch's worker is orphaned (the supervisor's takeover invalidated its link), so it no longer
  // consumes the allowance: the new grant creates its full 3 live workers. The orphaned row is still reserved and listed.
  await create();await create();await create();await assert.rejects(create(),/worker allowance reached: 3 live workers of 3/);
  assert.equal(f.c.manager.summary()[0].reserved,4); assert.equal(f.c.manager.summary()[0].workers[0].ownership,'orphaned');
});
// G27: the allowance caps CONCURRENT live workers: a live worker of this grant blocks; once it is orphaned (here: a
// human takes it back) its slot is free, and the new live worker blocks again.
test('G27: a live worker still blocks the allowance; an orphaned worker frees its slot',async t=>{
  const f=await fixture(t,1), w=await f.create();
  assert.equal(f.c.manager.summary()[0].workers[0].ownership,'linked');
  await assert.rejects(f.create(),/worker allowance reached: 1 live workers of 1/); assert.equal(f.calls.length,1);
  f.c.takeover(w.sessionId,'A human takes the worker back');
  assert.equal(f.c.manager.summary()[0].workers[0].ownership,'orphaned');
  const next=await f.create(); assert.equal(next.state,'ready'); assert.equal(f.calls.length,2);
  await assert.rejects(f.create(),/worker allowance reached: 1 live workers of 1/); assert.equal(f.calls.length,2);
  assert.equal(f.c.manager.summary()[0].reserved,2); // the orphaned row stays recorded and listed; it just no longer counts
});
test('task authority changes and native supervisor stop refuse manager operations',async t=>{
  const f=await fixture(t);f.issue.status='done';await assert.rejects(f.create(),/task authority/);assert.equal(f.calls.length,0);
  const g=await fixture(t);guard({id:g.s},'',undefined,false);await assert.rejects(g.create(),/authority|control changed/);assert.equal(g.calls.length,0);
});
test('unrelated journal creation identity is not adopted and no token is written to task artifacts',async t=>{
  const f=await fixture(t), id=randomUUID();f.store.admit(id,null,'create',{messageId:id});
  await assert.rejects(f.create(id),/another operation/);assert.equal(f.calls.length,0);
  assert.equal(fs.readdirSync(f.store.get(f.s).cwd).length,0);assert.equal(fs.statSync(f.grant.grantFile).mode&0o777,0o600);
});
test('recovered creation revalidates the native identity before automatic delegation',async t=>{
  const f=await fixture(t), id=randomUUID(), original=f.native.create;let retained;
  f.native.create=async(a,options)=>{if(!retained)retained=await original(a,options);if(options?.fresh)throw Error('Fresh labels could not be verified');return retained;};
  assert.equal((await f.create(id)).state,'uncertain');const reservation=f.store.db.prepare('SELECT nativeRequest FROM manager_workers WHERE request=?').get(id);await f.c.recover(reservation.nativeRequest);
  f.native.verifyNew=async()=>{throw Error('Fresh labels still wrong');};await assert.rejects(f.create(id),/labels still wrong/);assert.equal(f.store.get(retained.id).mode,'human');
  f.native.verifyNew=async()=>{};assert.equal((await f.create(id)).state,'ready');assert.equal(f.calls.length,1);
});
test('old-epoch incomplete reservations do not exhaust other managers link capacity',async t=>{
  const f=await fixture(t);for(let i=0;i<32;i++)f.store.db.prepare("INSERT INTO manager_workers VALUES (?,?,?,'{}',NULL,NULL,'created',?)").run(randomUUID(),randomUUID(),randomUUID(),randomUUID());
  assert.equal((await f.create()).state,'ready');assert.equal(f.calls.length,1);
});
async function candidate(f, capable = true) {
  const create = f.native.create; f.native.create = async (...a) => ({ ...await create(...a), ...(capable ? { managerToolsVersion: '1' } : {}) });
  const result = await f.c.create({ messageId: randomUUID(), taskId: PROGRAMME, provider: 'codex', title: 'Phone role candidate' }); f.native.create = create; return result.result.id;
}
test('promotion uses recorded creation capability and cannot rotate an existing delegated role',async t=>{
  const f=await fixture(t), id=await candidate(f);const input={sessionId:id,expectedGeneration:1,maxWorkers:1,reason:'Delegate selected phone supervisor'};
  await f.c.manager.promote(input);const epoch=f.store.db.prepare('SELECT epoch FROM manager_grants WHERE supervisor=?').get(id).epoch;
  await assert.rejects(f.c.manager.promote({...input,expectedGeneration:2}),/human-owned/);assert.equal(f.store.db.prepare('SELECT epoch FROM manager_grants WHERE supervisor=?').get(id).epoch,epoch);
  const old=await candidate(f,false);f.snapshots.get(old).labels={'orca.manager-tools':'1'};await assert.rejects(f.c.manager.promote({...input,sessionId:old}),/label alone/);assert.equal(f.store.get(old).mode,'human');
});
test('failed promotion restores human control without overwriting a newer transfer',async t=>{
  const f=await fixture(t), id=await candidate(f);f.c.manager.grant=async()=>{throw Error('fixture grant failure');};const input={sessionId:id,expectedGeneration:1,maxWorkers:1,reason:'Delegate selected phone supervisor'};
  await assert.rejects(f.c.manager.promote(input),/automation was revoked/);assert.equal(f.store.get(id).mode,'human');assert.equal(f.store.get(id).token,null);
  const other=await candidate(f);f.c.manager.grant=async()=>{f.c.takeover(other,'New human transfer wins');throw Error('after takeover');};await assert.rejects(f.c.manager.promote({...input,sessionId:other}),/role failed/);assert.equal(f.store.get(other).generation,3);
});
test('public role summary excludes tokens and distinguishes consumption from ownership',async t=>{
  const f=await fixture(t),w=await f.create(),link=f.c.events.links()[0];f.c.events.add(link,'turn-ended','summary-test',{});
  let summary=f.c.manager.summary();assert.equal(summary[0].workers[0].ownership,'linked');assert.equal(summary[0].workers[0].lastEvent.consumed,false);assert(!JSON.stringify(summary).includes(f.token));assert(!JSON.stringify(summary).includes('token'));
  f.c.takeover(f.s,'Human suspends supervisor');summary=f.c.manager.summary();assert.equal(summary[0].active,false);assert.equal(summary[0].workers[0].ownership,'orphaned');assert.equal(summary[0].workers[0].workerId,w.sessionId);
});
test('creation diagnostics exist only during the exact active call and fail safe on restart',async t=>{
 const f=await fixture(t),id=randomUUID(),seen=[];
 const capture=()=>{const w=f.c.manager.summary().find(x=>x.id===f.s).workers.find(x=>x.requestId===id);seen.push(structuredClone(w));return w;};
 f.native.afterCreate=async()=>{const w=capture();assert.equal(w.phase,'reserved');assert.equal(w.creation.nativeState,'intent');assert(Number.isSafeInteger(w.creation.startedAt));
 const restarted=new Manager(f.c,path.join(f.dir,'manager'));assert.equal(restarted.summary().find(x=>x.id===f.s).workers.find(x=>x.requestId===id).creation.startedAt,null);};
 f.native.verifyNew=async()=>{assert.equal(capture().phase,'created');};
 const attach=f.c.events.attach.bind(f.c.events);f.c.events.attach=async(...args)=>{assert.equal(capture().phase,'delegated');return attach(...args);};
 await f.create(id);assert.equal(capture().creation,null);assert.equal(f.c.manager.creating.size,0);
 assert.deepEqual(seen.slice(0,3).map(x=>x.phase),['reserved','created','delegated']);
 const failed=randomUUID();f.native.create=async()=>{throw Error('uncertain native response');};
 assert.equal((await f.create(failed)).state,'uncertain');
 let row=f.c.manager.summary().find(x=>x.id===f.s).workers.find(x=>x.requestId===failed);
 assert.equal(row.creation.startedAt,null);assert.equal(row.creation.nativeState,'uncertain');
 f.c.manager=new Manager(f.c,path.join(f.dir,'manager'));
 row=f.c.manager.summary().find(x=>x.id===f.s).workers.find(x=>x.requestId===failed);
 assert.equal(row.creation.startedAt,null);
});

// THE RULE, next to the assertions that enforce it, because this is where fixtures get written:
//
//   A fixture may construct a record that merely needs to exist. It must not construct a record whose
//   shape a FENCE READS, unless something else asserts that production still writes that shape.
//
// Restating a norm in two places is not the duplication this repository has been removing -- that is about
// facts that can drift apart. This is the cost of 935772bf: the channel binding moved out of `supervision`
// into `channel`, host-native.mjs was not updated, and the only test covering it HAND-BUILT the record, so
// it went on asserting a shape production had stopped producing. It passed, and it was counted as coverage.
// A fixture asserting a REFUSAL is not safe either -- that one did, and still passed, because the branch
// ran in the test while production could no longer reach it.
//
// The two assertions below are the "something else" for the shapes the surviving fixtures reconstruct:
// resumption.test.mjs:89 for the supervision binding, role-tools.test.mjs:128 and book-control.test.mjs:544
// for the creation result. If either key moves, these fail on the real path regardless of what any fixture
// synthesises.
const RULE = 'a fixture must not construct a record whose shape a fence reads unless something else asserts production still writes it';

test('a real manager assignment writes the supervision binding the fixtures reconstruct', async t => {
  const f = await fixture(t), w = await f.create(), messageId = randomUUID();
  let intentAt = null;
  // Captured at DISPATCH: store.finish overwrites result on 'delivered', so reading it after the send
  // inspects the delivered row and would pass whatever the intent actually carried.
  f.native.beforeSend = () => { intentAt = JSON.parse(JSON.stringify(f.store.delivery(messageId).result)); };
  await f.c.manager.assign({ sessionId: f.s, workerId: w.sessionId, messageId, text: 'Produce the owned document' }, f.token);
  assert.ok(intentAt, 'no dispatch was observed, so this assertion would be vacuous');
  assert.deepEqual(Object.keys(intentAt.supervision).sort(), ['epoch', 'generation', 'linkEpoch', 'supervisor'],
    `manager supervision binding shape changed; resumption.test.mjs:89 reconstructs it -- ${RULE}`);
  assert.equal(intentAt.supervision.supervisor, f.s);
  assert.equal(intentAt.supervision.generation, f.grant.generation);
  // The core intent fields control.test.mjs:91 reconstructs, in the same captured record.
  assert.equal(typeof intentAt.generation, 'number');
  assert.ok('expectedLastUserAt' in intentAt, `intent lost expectedLastUserAt; control.test.mjs:91 reconstructs it -- ${RULE}`);
  // And the channel key is absent here: supervision is the MANAGER binding and nothing else.
  assert.equal(intentAt.channel, undefined);
});

test('a real creation writes the delivered record the fixtures reconstruct', async t => {
  const f = await fixture(t);
  // The two version keys are pass-throughs, present only when the adapter reports them -- so a double that
  // omits them would have this assert the DOUBLE's shape rather than production's. Supplied here on
  // purpose, which is what makes the key list below a statement about controller.create.
  const create = f.native.create;
  f.native.create = async (...a) => ({ ...await create(...a), managerToolsVersion: '1', roleToolsVersion: '1' });
  const w = await f.create();
  // Unlike a send, a creation is finished once, so the production record survives to be read directly.
  const creation = f.store.delivery(f.calls[0].a.messageId);
  assert.equal(creation.state, 'delivered');
  assert.deepEqual(Object.keys(creation.result).sort(), ['cwd', 'id', 'managerToolsVersion', 'mode', 'roleToolsVersion', 'runtimeInstanceId'],
    `creation result shape changed; role-tools.test.mjs:128 and book-control.test.mjs:544 reconstruct it -- ${RULE}`);
  assert.equal(creation.result.id, w.sessionId);
  assert.equal(creation.result.mode, 'human');
  // And omitted when the adapter does not report them, which is the other half of the contract.
  const g = await fixture(t);
  await g.create();
  assert.deepEqual(Object.keys(g.store.delivery(g.calls[0].a.messageId).result).sort(), ['cwd', 'id', 'mode', 'runtimeInstanceId']);
});
// H6 item 1 (RECHECK-H5 R-2): a manager's assignment is automated traffic and stops at the automation limit, through
// its real call site, with nothing dispatched and no row written into the manual reserve.
test('R-2: a manager assignment is refused at the automation limit and writes nothing into the reserve',async t=>{
  const f=await fixture(t), w=await f.create();
  f.store.db.exec('BEGIN'); while(f.store.db.prepare('SELECT count(*) n FROM deliveries').get().n<AUTOMATION_LIMIT) f.store.db.prepare("INSERT INTO deliveries VALUES (?,NULL,'fixture','{}','delivered',NULL)").run(randomUUID()); f.store.db.exec('COMMIT');
  const before=f.sends.length;
  await assert.rejects(f.c.manager.assign({sessionId:f.s,workerId:w.sessionId,messageId:randomUUID(),text:'Past the limit'},f.token),/Journal automation budget reached/);
  assert.equal(f.sends.length,before); assert.equal(f.store.db.prepare('SELECT count(*) n FROM deliveries').get().n,AUTOMATION_LIMIT);
});

test('ownership display names only a validated manager association without creating role ownership',async t=>{
 const f=await fixture(t),roles=new RoleSessions(f.c),w=await f.create();
 const managed=roles.describeOwnership(w.sessionId);
 assert.equal(managed.ownership,'managed');assert.equal(managed.parentSession,f.s);
 assert.equal(managed.projectId,null);assert.match(managed.detail,/role-session: n\/a/);
 assert.ok(!managed.detail.includes(f.s),'validated manager identity is metadata, never a raw display label');
 assert.equal(roles.owner(w.sessionId),null);
 assert.throws(()=>roles.ownedByCaller(f.s,w.sessionId),/role_start_session/);
 f.store.db.prepare('UPDATE manager_grants SET generation=generation+1 WHERE supervisor=?').run(f.s);
 assert.equal(roles.describeOwnership(w.sessionId).ownership,'unknown');
 assert.equal(roles.describeOwnership(randomUUID()).ownership,'unknown');
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM session_ownership').get().n,0);
});
