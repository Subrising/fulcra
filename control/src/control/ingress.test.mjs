import { FENCE_PROTOCOL } from './native-fence.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Controller } from './controller.mjs';
import { ControlStore } from './store.mjs';
import { Events } from './events.mjs';
import { Manager } from './manager.mjs';
import { rpc } from './rpc.mjs';
async function fixture(t) {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'orca-origin-'))),store=new ControlStore(path.join(dir,'journal.sqlite')),id=randomUUID(),task=randomUUID(),originHash='a'.repeat(64);
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  let sends=0;const states=new Map(),grants=new Map(),state=id=>states.get(id)??{status:'idle',pending:0,boot:'test',nativeId:id,lastPromptId:null,lastUserAt:null,timelineCursor:{epoch:'test',seq:0}};
  const native={inspect:async id=>({fenceProtocol:FENCE_PROTOCOL,saturated:false,humanAt:0,...state(id)}),snapshot:async()=>({status:'idle',pendingPermissions:[]}),send:async(id,text,messageId)=>{sends++;states.set(id,{...state(id),lastPromptId:messageId});},completion:async()=>({ended:true,outputObserved:true,outputPreview:'bounded output',outputEvidenceHash:'b'.repeat(64)}),receipt:async()=>({state:'completed'})};
  const control=new Controller({store,native,authority:async()=>({id:task,assigneeUserId:'local-board'})}),events=new Events(control,path.join(dir,'inbox'));new Manager(control,path.join(dir,'manager'));
  store.created(id,task,path.join(dir,randomUUID()));const grant=await control.handback(id,'Delegate isolated origin test');grants.set(id,grant);
  const call=(method,input,capability=grant.capability)=>rpc(control,'private-test')({method,input,capability});
  const args={sessionId:id,messageId:randomUUID(),originHash,text:'Produce a bounded result'};
  return {dir,store,id,task,originHash,grants,control,native,events,grant,args,call,sends:()=>sends,async attach(worker=id,supervisor=randomUUID()) {if(!store.get(supervisor)){store.created(supervisor,task,path.join(dir,randomUUID()));grants.set(supervisor,await control.handback(supervisor,'Delegate independent supervisor'));}return events.attach({workerId:worker,supervisorId:supervisor,capability:store.get(supervisor)?.id===id?grant.capability:undefined,reason:'Attach isolated supervision authority'},store.get(supervisor).generation);}};
}
test('actual RPC preparation binds origin, duplicate retries and result; legacy and foreign calls cannot adopt it',async t=>{
  const f=await fixture(t),a=f.args;const id=await f.call('ingress-prepare',a);assert.equal(await f.call('ingress-prepare',{...a,messageId:randomUUID()}),id);
  await assert.rejects(f.call('ingress-prepare',{...a,messageId:randomUUID(),originHash:'c'.repeat(64)}),/origin binding/);
  await assert.rejects(f.call('ingress-send',{...a,text:'Altered'}),/preparation/);
  const sent=await f.call('ingress-send',a);assert.equal(sent.result.outputContext.originHash,a.originHash);assert.equal((await f.call('ingress-send',a)).id,id);assert.equal(f.sends(),1);
  assert.equal((await f.call('ingress-result',{sessionId:f.id,messageId:id,originHash:f.originHash})).available,true);
  await assert.rejects(f.call('ingress-result',{sessionId:f.id,messageId:id,originHash:'c'.repeat(64)}),/origin binding/);
  const n=await f.control.notifications.prepare({sessionId:f.id,messageId:id,originHash:f.originHash},f.grant.capability);assert.equal(n.ready,true);
  f.store.db.prepare("UPDATE deliveries SET result=json_remove(result,'$.outputContext.originHash','$.notification') WHERE id=?").run(id);
  await assert.rejects(f.control.notifications.prepare({sessionId:f.id,messageId:id,originHash:f.originHash},f.grant.capability),/provenance binding/);assert.equal(f.sends(),1);
});
test('actual events attachment after preparation refuses admission; outgoing supervision remains valid',async t=>{
  const f=await fixture(t);await f.call('ingress-prepare',f.args);await f.attach();
  await assert.rejects(f.call('ingress-send',f.args),/incoming supervisor/);assert.equal(f.sends(),0);assert.equal(f.store.delivery(f.args.messageId),null);
  assert.ok(f.store.db.prepare('SELECT id FROM management_requests WHERE id=?').get(f.args.messageId));
  const link=f.events.links()[0];assert.doesNotThrow(()=>f.control.ingress.check(link.supervisor,f.grants.get(link.supervisor).capability,f.originHash));
});
test('a link appearing during preflight is rechecked, and completed work cannot gain an incoming link then a wake',async t=>{
  const f=await fixture(t);await f.call('ingress-prepare',f.args);const inspect=f.native.inspect;
  f.native.inspect=async id=>{f.store.db.prepare('INSERT INTO manager_workers VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),randomUUID(),randomUUID(),'{}',id,2,'attached',randomUUID());return inspect(id);};
  await assert.rejects(f.call('ingress-send',f.args),/incoming supervisor/);assert.equal(f.sends(),0);
  f.store.db.prepare('DELETE FROM manager_workers').run();f.native.inspect=inspect;await f.call('ingress-send',f.args);await f.attach();
  await assert.rejects(f.control.notifications.prepare({sessionId:f.id,messageId:f.args.messageId,originHash:f.originHash},f.grant.capability),/incoming supervisor/);assert.equal(f.sends(),1);
});
test('uncertain admission and receipt recovery retain origin and never replay native input',async t=>{
  const f=await fixture(t);await f.call('ingress-prepare',f.args);const send=f.native.send;f.native.send=async(...args)=>{await send(...args);throw Error('transport lost after acceptance');};
  const result=await f.call('ingress-send',f.args);assert.equal(result.state,'uncertain');assert.equal(result.result.outputContext.originHash,f.originHash);
  const recovered=await f.control.recover(f.args.messageId);assert.equal(recovered.result.outputContext.originHash,f.originHash);assert.equal(f.sends(),1);assert.equal(f.store.get(f.id).mode,'human');
  await assert.rejects(f.call('ingress-send',f.args),/revoked/);
});
test('malformed origins, missing preparation and invalid capabilities cannot create a durable instruction',async t=>{
  const f=await fixture(t);for(const originHash of [null,'','f'.repeat(63),'g'.repeat(64),{},'a'.repeat(65)])await assert.rejects(f.call('ingress-prepare',{...f.args,originHash}),/origin/);
  await assert.rejects(f.call('ingress-send',f.args),/preparation/);await assert.rejects(f.call('ingress-prepare',f.args,'wrong'),/revoked/);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM management_requests').get().n,0);assert.equal(f.sends(),0);
});
test('instruction envelope rejects extra fields and empty text; exact UTF-8 budget remains admissible',async t=>{
  const f=await fixture(t);
  for(const a of [{...f.args,extra:true},{...f.args,text:'   '},{...f.args,text:'x'.repeat(16385)},null,{}])await assert.rejects(f.call('ingress-prepare',a));
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM management_requests').get().n,0);
  const exact={...f.args,text:'é'.repeat(8192)};assert.equal(await f.call('ingress-prepare',exact),exact.messageId);assert.equal(f.sends(),0);
});
test('an existing preparation cannot target a second session or survive a new delegation generation',async t=>{
  const f=await fixture(t);await f.call('ingress-prepare',f.args);
  const other=randomUUID();f.store.created(other,f.task,path.join(f.dir,randomUUID()));const second=await f.control.handback(other,'Delegate another isolated session');
  await assert.rejects(f.call('ingress-send',{...f.args,sessionId:other},second.capability),/preparation/);
  f.control.takeover(f.id,'Human review of prepared work');const refreshed=await f.control.handback(f.id,'Explicit delegation after human review');
  await assert.rejects(f.call('ingress-send',f.args,refreshed.capability),/preparation/);assert.equal(f.sends(),0);assert.equal(f.store.delivery(f.args.messageId),null);
});

test('scoped preparation capacity retains exact retry identity and refuses the 129th distinct instruction',async t=>{
  const f=await fixture(t);
  for(let i=0;i<128;i++)await f.call('ingress-prepare',{...f.args,messageId:randomUUID(),text:'instruction '+i});
  const first=await f.call('ingress-prepare',{...f.args,text:'instruction 0'});
  assert.ok(f.store.db.prepare('SELECT id FROM management_requests WHERE id=?').get(first));
  await assert.rejects(f.call('ingress-prepare',{...f.args,text:'instruction 128'}),/capacity reached/);assert.equal(f.sends(),0);
});

test('proposed UUID collision is checked before identical-body dedup', async t => {
  const f = await fixture(t), a = f.args, b = { ...a, messageId: randomUUID(), text: 'Second instruction' };
  await f.call('ingress-prepare', a); await f.call('ingress-prepare', b);
  await assert.rejects(f.call('ingress-prepare', { ...b, messageId: a.messageId }), /identity conflict/);
  assert.equal(await f.call('ingress-prepare', a), a.messageId);
  assert.equal(await f.call('ingress-prepare', { ...b, messageId: randomUUID() }), b.messageId);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM management_requests').get().n, 2); assert.equal(f.sends(), 0);
});
test('ack releases preparation but retained delivery refuses changed text and native replay', async t => {
  const f = await fixture(t), a = f.args, receipt = { sessionId: a.sessionId, messageId: a.messageId, originHash: a.originHash };
  await f.call('ingress-prepare', a); await f.call('ingress-send', a);
  await f.call('ingress-ack', receipt); assert.equal(f.store.db.prepare('SELECT count(*) n FROM management_requests').get().n, 0);
  await assert.rejects(f.call('ingress-prepare', { ...a, text: 'Changed instruction' }), /identity conflict/);
  assert.equal(await f.call('ingress-prepare', a), a.messageId); await f.call('ingress-send', a); assert.equal(f.sends(), 1);
  await f.call('ingress-ack', receipt); const repeat = { ...a, messageId: randomUUID() };
  assert.equal(await f.call('ingress-prepare', repeat), repeat.messageId); await f.call('ingress-send', repeat); assert.equal(f.sends(), 2);
});
test('all existing foreign deliveries refuse before a command preparation is inserted', async t => {
  const f = await fixture(t), a = f.args;
  await f.control.send({ sessionId: a.sessionId, messageId: a.messageId, text: a.text }, f.grant.capability);
  await assert.rejects(f.call('ingress-prepare', a), /identity conflict/);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM management_requests').get().n, 0); assert.equal(f.sends(), 1);
});
test('ack is origin and generation scoped, refuses unconfirmed receipts, and restores scoped capacity', async t => {
  const f = await fixture(t), a = f.args, receipt = { sessionId: a.sessionId, messageId: a.messageId, originHash: a.originHash };
  for (let i = 0; i < 127; i++) await f.call('ingress-prepare', { ...a, messageId: randomUUID(), text: `Retained ${i}` });
  await f.call('ingress-prepare', a); await f.call('ingress-send', a);
  await assert.rejects(f.call('ingress-prepare', { ...a, messageId: randomUUID(), text: 'Over capacity' }), /capacity reached/);
  await assert.rejects(f.call('ingress-ack', { ...receipt, originHash: 'c'.repeat(64) }), /origin binding/);
  const delivery = f.store.delivery(a.messageId); f.store.finish(a.messageId, 'uncertain', delivery.result);
  await assert.rejects(f.call('ingress-ack', receipt), /confirmed/); f.store.finish(a.messageId, 'delivered', delivery.result);
  await f.call('ingress-ack', receipt);
  await f.call('ingress-prepare', { ...a, messageId: randomUUID(), text: 'Capacity restored' });
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM management_requests').get().n, 128);
  f.control.takeover(f.id, 'Human takes control'); await assert.rejects(f.call('ingress-ack', receipt), /revoked/); assert.equal(f.sends(), 1);
});

test('retained delivery conflicts cover kind, session, generation and origin; acknowledgment cannot delete a different preparation', async t => {
  const f = await fixture(t), a = f.args, receipt = { sessionId: a.sessionId, messageId: a.messageId, originHash: a.originHash };
  await f.call('ingress-prepare', a); await f.call('ingress-send', a); await f.call('ingress-ack', receipt);
  const original = f.store.delivery(a.messageId);
  for (const patch of [{ kind: 'create' }, { session: randomUUID() }, { result: { ...original.result, outputContext: { ...original.result.outputContext, generation: 999 } } }, { result: { ...original.result, outputContext: { ...original.result.outputContext, originHash: undefined } } }]) {
    const changed = { ...original, ...patch };
    f.store.db.prepare('UPDATE deliveries SET kind=?,session=?,result=? WHERE id=?').run(changed.kind, changed.session, JSON.stringify(changed.result), a.messageId);
    await assert.rejects(f.call('ingress-prepare', a), /identity conflict/);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM management_requests').get().n, 0);
  }
  f.store.db.prepare('UPDATE deliveries SET kind=?,session=?,result=? WHERE id=?').run(original.kind, original.session, JSON.stringify(original.result), a.messageId);
  f.control.prepareManagement('send', { sessionId: a.sessionId, expectedGeneration: f.grant.generation, text: 'Foreign preparation' }, a.messageId);
  await assert.rejects(f.call('ingress-ack', receipt), /identity conflict/);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM management_requests').get().n, 1); assert.equal(f.sends(), 1);
});

test('command with real private binding runs through actual RPC and SQLite; restart keeps receipts and takeover wins', async t => {
  const { createCommand } = await import('../../orca-command/src/command.mjs');
  const { bindingName } = await import('../../orca-ingress/src/relay.mjs');
  const f = await fixture(t), base = fs.realpathSync(f.dir), bindingsDir = path.join(base, 'commands'), grantsDir = path.join(base, 'grants');
  fs.mkdirSync(bindingsDir, { mode: 0o700 }); fs.mkdirSync(grantsDir, { mode: 0o700 });
  const config = { bindingsDir, accountId: 'default', conversationId: '1545704266671595611', senderId: '123456789012345678', sessionId: f.id };
  const methods = [], options = { config, grantsDir, request: request => { methods.push(request.method); return rpc(f.control, 'private-test')(request); } };
  const hostConfig = { channels: { discord: { slashCommand: { ephemeral: true } } } };
  let command = createCommand(options); command.service.start({ config: hostConfig });
  fs.writeFileSync(path.join(bindingsDir, bindingName(command.currentOrigin)), JSON.stringify({ version: 1, origin: command.currentOrigin, sessionId: f.id, taskId: f.task, generation: f.grant.generation }), { mode: 0o600 });
  fs.writeFileSync(path.join(grantsDir, `${f.id}-${f.grant.generation}.json`), JSON.stringify({ sessionId: f.id, generation: f.grant.generation, capability: f.grant.capability }), { mode: 0o600 });
  const run = args => command.definition.handler({ config: hostConfig, args, commandBody: '/orca ' + args, channel: 'discord', channelId: config.conversationId, senderIsOwner: true, isAuthorizedSender: true, senderId: config.senderId, accountId: config.accountId, from: `discord:channel:${config.conversationId}`, to: `slash:${config.senderId}` });
  const id = randomUUID(); assert.match((await run(`send ${id} A bounded instruction`)).text, /delivered/);
  assert.match((await run(`send ${randomUUID()} A bounded instruction`)).text, new RegExp(`Existing receipt ${id} reused`)); assert.equal(f.sends(), 1);
  assert.match((await run(`send ${id} Different instruction`)).text, /conflicts/); assert.equal(f.sends(), 1);
  command.service.stop(); command = createCommand(options); command.service.start({ config: hostConfig });
  assert.match((await run(`result ${id}`)).text, /Output observed: true/);
  assert.match((await run(`ack ${id}`)).text, /history retained/); assert.ok(f.store.delivery(id));
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM management_requests').get().n, 0);
  assert.ok(methods.every(m => !m.startsWith('notify-'))); f.control.takeover(f.id, 'Human ends command trial');
  assert.match((await run(`send ${randomUUID()} Must not execute`)).text, /refused/); assert.equal(f.sends(), 1);
});

test('operator may release obsolete unadmitted ingress preparation, while current delegation and scoped callers cannot', async t => {
  const f = await fixture(t), a = f.args, operate = input => rpc(f.control, 'private-test')({ method: 'management-ack', input, operator: 'private-test' });
  await f.call('ingress-prepare', a);
  await assert.rejects(operate(a.messageId), /confirmed/);
  f.control.takeover(f.id, 'Human cancels before native admission');
  await assert.rejects(f.call('management-ack', a.messageId), /Operator authorization/);
  f.control.busy.add(f.id); await assert.rejects(operate(a.messageId), /confirmed/); f.control.busy.delete(f.id);
  for (const patch of [{ originHash: 'not-hex' }, { originHash: 'a'.repeat(64), extra: true }]) { const id = randomUUID(); f.control.prepareManagement('send', { expectedGeneration: f.grant.generation, sessionId: f.id, text: 'Retain invalid body', ...patch }, id); await assert.rejects(operate(id), /confirmed/); assert.ok(f.store.db.prepare('SELECT id FROM management_requests WHERE id=?').get(id)); }
  assert.deepEqual(await operate(a.messageId), { acknowledged: true });
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM management_requests').get().n, 2);
  assert.equal(f.store.delivery(a.messageId), null); assert.equal(f.sends(), 0);
});
