import { FENCE_PROTOCOL } from './native-fence.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Controller} from './controller.mjs';
import {ControlStore} from './store.mjs';
import {Notifications} from './notifications.mjs';
import {admit, BOOT} from '../../tools/legacy-host-admission.fixture.mjs';
import { requireUnpinnedAdmissionGuard } from './admission-guard-precondition.mjs';
requireUnpinnedAdmissionGuard(); // Fails loudly when the working guard is pinned; see that module.
async function fixture(t, noOutput = false) {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'orca-notification-'))),store=new ControlStore(path.join(dir,'journal.sqlite'));
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const id=randomUUID(),task=randomUUID(),originHash='a'.repeat(64),evidence='b'.repeat(64),listeners=new Set();let sends=0;
  const current={status:'idle',pending:0,boot:BOOT,nativeId:randomUUID(),lastPromptId:null,lastUserAt:null,timelineCursor:{epoch:'test',seq:0},observedAt:'test'},authority={id:task,assigneeUserId:'local-board'};
  const native={inspect:async()=>({ fenceProtocol: FENCE_PROTOCOL, saturated: false, humanAt: 0, ...current }),subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},send:async(_,text,messageId)=>{
    admit(store.db,{id,lastUserMessageAt:current.lastUserAt?new Date(current.lastUserAt):null,pendingPermissions:[]},text,messageId,false);
    sends++;current.lastPromptId=messageId;current.lastUserAt=new Date(Date.now()+sends).toISOString();
  },completion:async()=>({ended:true,outputObserved:!noOutput,outputPreview:noOutput?'':'Verified source output',outputTruncated:false,outputEvidenceHash:noOutput?null:evidence})};
  const control=new Controller({store,native,authority:async()=>authority});store.created(id,task,dir);const grant=await control.handback(id,'Own notification test');
  const initial={sessionId:id,messageId:randomUUID(),text:'Produce the bounded original task',originHash};
  const messageId=control.ingress.prepare(initial,grant.capability);await control.ingress.send({...initial,messageId},grant.capability);
  const prepare={sessionId:id,messageId,originHash},n=await control.notifications.prepare(prepare,grant.capability),query={sessionId:id,originHash,notificationId:n.notificationId};
  return {control,store,native,current,grant,prepare,query,n,evidence,listeners,authority,sends:()=>sends};
}
test('retained result survives follow-up admission, notification replay and runtime restart without another native input',async t=>{
  const f=await fixture(t),c=f.control.notifications,token=f.grant.capability;
  assert.equal(f.n.state,'queued');assert.equal(f.n.accepted,false);await c.read(f.query,token);
  const first=await c.assign({...f.query,text:'Apply one correction'},token);assert.equal(first.state,'delivered');assert.equal(f.sends(),2);
  // The original result API genuinely cannot read D once F is current.
  await assert.rejects(f.control.result({sessionId:f.query.sessionId,messageId:f.prepare.messageId},token),/identity/);
  const resumed=new Notifications(f.control),read=await resumed.read(f.query,token);assert.equal(read.outputPreview,'Verified source output');assert.equal(read.outputEvidenceHash,f.evidence);
  const replay=await resumed.assign({...f.query,text:'Same correction expressed differently'},token);assert.equal(replay.messageId,first.messageId);assert.equal(f.sends(),2);
  const consumed=await resumed.acknowledge({...f.query,outputEvidenceHash:f.evidence},token);assert.equal(consumed.consumed,true);assert.equal(consumed.accepted,false);
  assert.equal((await new Notifications(f.control).prepare(f.prepare,token)).state,'consumed');assert.equal((await resumed.claim(f.query,token)).claimed,false);
});
test('crash after durable choice but before admission resumes the exact chosen instruction once',async t=>{
  const f=await fixture(t),token=f.grant.capability,c=f.control.notifications;await c.read(f.query,token);
  const send=f.control.send.bind(f.control);f.control.send=async()=>{throw Error('injected crash before admission');};
  await assert.rejects(c.assign({...f.query,text:'First authoritative choice'},token),/injected crash/);assert.equal(f.sends(),1);
  f.control.send=send;const result=await new Notifications(f.control).assign({...f.query,text:'Reworded retry must not replace choice'},token);
  assert.equal(result.followup.chosenInstruction,'First authoritative choice');assert.equal(f.sends(),2);
});
test('cached output and acknowledgments still refuse revoked, different origin, native and task authority',async t=>{
  for(const variant of ['revoke','origin','native','task']){const f=await fixture(t),c=f.control.notifications;await c.read(f.query,f.grant.capability);
    if(variant==='revoke')f.control.takeover(f.query.sessionId,'Human control wins');if(variant==='origin')f.query.originHash='c'.repeat(64);if(variant==='native')f.current.nativeId=randomUUID();if(variant==='task')f.authority.assigneeUserId='different';
    await assert.rejects(c.read(f.query,f.grant.capability),/revoked|binding|identity|authority/);assert.equal(f.sends(),1);
  }
});
test('consumption requires an actual read, correct evidence and a confirmed follow-up disposition',async t=>{
  const f=await fixture(t),c=f.control.notifications,token=f.grant.capability;await assert.rejects(c.acknowledge({...f.query,outputEvidenceHash:f.evidence},token),/read/);
  await c.read(f.query,token);await assert.rejects(c.acknowledge({...f.query,outputEvidenceHash:'c'.repeat(64)},token),/matching evidence/);
  const send=f.control.send.bind(f.control);f.control.send=async()=>{throw Error('unadmitted');};await assert.rejects(c.assign({...f.query,text:'Pending instruction'},token),/unadmitted/);
  await assert.rejects(c.acknowledge({...f.query,outputEvidenceHash:f.evidence},token),/Unresolved/);f.control.send=send;
});
test('an ended turn with no output can be consumed truthfully, but null cannot acknowledge observed output',async t=>{
  const empty=await fixture(t,true),c=empty.control.notifications,token=empty.grant.capability;
  await assert.rejects(c.acknowledge({...empty.query,outputEvidenceHash:null},token),/read/);
  const result=await c.read(empty.query,token);assert.equal(result.outputObserved,false);assert.equal(result.outputEvidenceHash,null);
  const ack=await c.acknowledge({...empty.query,outputEvidenceHash:null},token);assert.equal(ack.consumed,true);assert.equal(ack.accepted,false);
  const full=await fixture(t);await full.control.notifications.read(full.query,full.grant.capability);
  await assert.rejects(full.control.notifications.acknowledge({...full.query,outputEvidenceHash:null},full.grant.capability),/matching evidence/);
});
test('wake claims survive service reconstruction and enforce a finite retry allowance',async t=>{
  const f=await fixture(t),token=f.grant.capability;assert.equal((await f.control.notifications.claim(f.query,token)).claimed,true);
  assert.equal((await new Notifications(f.control).claim(f.query,token)).claimed,false);
  for(let i=1;i<5;i++){f.store.db.prepare("UPDATE deliveries SET result=json_set(result,'$.notification.nextAttemptAt',0) WHERE id=?").run(f.prepare.messageId);assert.equal((await new Notifications(f.control).claim(f.query,token)).claimed,true);}
  const last=await f.control.notifications.claim(f.query,token);assert.equal(last.claimed,false);assert.equal(last.wakeExhausted,true);assert.equal(f.sends(),1);
});
test('new owner input projects a superseded completion without altering its consumption or blocking the new result',async t=>{
  const f=await fixture(t),token=f.grant.capability,before=JSON.stringify(f.store.delivery(f.prepare.messageId).result.notification),next=randomUUID();
  const instruction={sessionId:f.query.sessionId,messageId:next,text:'Owner moves to a different bounded instruction',originHash:f.query.originHash};
  f.control.ingress.prepare(instruction,token);await f.control.ingress.send(instruction,token);
  const view=await f.control.inspect(f.query.sessionId),old=JSON.parse(view.deliveries.find(d=>d.id===f.prepare.messageId).result).notification;
  assert.equal(old.state,'superseded');assert.equal(old.supersededBy,next);assert.equal(old.consumedAt,undefined);
  assert.equal(JSON.stringify(f.store.delivery(f.prepare.messageId).result.notification),before);
  await assert.rejects(f.control.notifications.read(f.query,token),/identity/);
  const current=await f.control.notifications.prepare({...f.prepare,messageId:next},token);assert.equal(current.ready,true);assert.notEqual(current.notificationId,f.n.notificationId);
});
test('handback skips older-generation completions with or without a notification, while cached access stays refused',async t=>{
  for(const cached of [true,false]){const f=await fixture(t);if(!cached)f.store.db.prepare("UPDATE deliveries SET result=json_remove(result,'$.notification') WHERE id=?").run(f.prepare.messageId);
    const before=JSON.stringify(f.store.delivery(f.prepare.messageId));f.control.takeover(f.query.sessionId,'Owner inspection');const next=await f.control.handback(f.query.sessionId,'Resume after inspection');
    assert.deepEqual(await f.control.notifications.prepare(f.prepare,next.capability),{ready:false,state:'previous-generation',sourceMessageId:f.prepare.messageId,accepted:false});
    assert.equal(JSON.stringify(f.store.delivery(f.prepare.messageId)),before);assert.equal(f.sends(),1);
    if(cached){const view=await f.control.inspect(f.query.sessionId);assert.equal(JSON.parse(view.deliveries[0].result).notification.state,'previous-generation');for(const action of ['read','assign','acknowledge'])await assert.rejects(f.control.notifications[action]({...f.query,...(action==='assign'?{text:'Must refuse'}:action==='acknowledge'?{outputEvidenceHash:f.evidence}:{})},next.capability),/binding/);}
  }
});
test('completion wait subscribes to real native state events and releases listeners',async t=>{
  const f=await fixture(t),c=f.control.notifications,token=f.grant.capability;const first=await c.wait({sessionId:f.query.sessionId,cursor:null},token);assert.equal(f.listeners.size,0);
  const pending=c.wait({sessionId:f.query.sessionId,cursor:first.cursor},token);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.listeners.size,1);
  f.current.status='running';for(const fn of f.listeners)fn({id:f.query.sessionId});const event=await pending;assert.notEqual(event.cursor,first.cursor);assert.equal(f.listeners.size,0);assert.equal(c.waiters,0);
});
test('the inspect that detects human takeover labels old notifications with its returned generation',async t=>{
  const f=await fixture(t);f.current.humanAt=f.store.get(f.query.sessionId).grantedAt+1;
  const view=await f.control.inspect(f.query.sessionId);assert.equal(view.mode,'human');assert.ok(view.generation>f.grant.generation);
  assert.equal(JSON.parse(view.deliveries[0].result).notification.state,'previous-generation');
});
test('twenty large retained notifications cannot overflow the inspect transport or lose stored evidence',async t=>{
  const f=await fixture(t),original=f.store.delivery(f.prepare.messageId),large={...original.result.notification,instruction:'x'.repeat(16000),originalInstruction:'y'.repeat(16000),output:{...original.result.notification.output,outputPreview:'語'.repeat(8192)}};
  for(let i=0;i<20;i++){const id=randomUUID();f.store.admit(id,f.query.sessionId,'send',{sessionId:f.query.sessionId,messageId:id,text:'Representative history fixture'});f.store.finish(id,'delivered',{...original.result,notification:{...large,id:randomUUID()}});}
  const raw=f.store.db.prepare('select result from deliveries where session=?').all(f.query.sessionId);assert.ok(Buffer.byteLength(JSON.stringify(raw))>524288);
  const observed=await f.control.inspect(f.query.sessionId);assert.equal(observed.deliveries.length,20);assert.ok(Buffer.byteLength(JSON.stringify(observed))<32768);
  assert.equal(f.store.delivery(f.prepare.messageId).result.notification.output.outputPreview,'Verified source output');assert.equal(f.sends(),1);
});
test('completion instructions and terminal acknowledgment remain part of the retained contract',async t=>{
  const f=await fixture(t),c=f.control.notifications,token=f.grant.capability;
  assert.equal(f.n.instruction,'Produce the bounded original task');assert.equal(f.n.originalInstruction,f.n.instruction);
  await assert.rejects(c.assign({...f.query,text:'Must read first'},token),/Read/);assert.equal(f.sends(),1);
  await c.read(f.query,token);await c.acknowledge({...f.query,outputEvidenceHash:f.evidence},token);
  await assert.rejects(c.assign({...f.query,text:'Must not extend a consumed completion'},token),/active completion/);assert.equal(f.sends(),1);
});
test('malformed completion envelopes and wait cursors never mutate the journal or start native work',async t=>{
  const f=await fixture(t),c=f.control.notifications,token=f.grant.capability,before=JSON.stringify(f.store.delivery(f.prepare.messageId));
  const invalid=['', 'a', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 12, {}, []];
  for(const cursor of invalid)await assert.rejects(c.wait({sessionId:f.query.sessionId,cursor},token),/Invalid/);
  for(const query of [{...f.query,extra:true},{...f.query,sessionId:'invalid'},{...f.query,originHash:'bad'},{...f.query,notificationId:'bad'}])await assert.rejects(c.read(query,token),/Invalid/);
  f.control.closing=true;await assert.rejects(c.wait({sessionId:f.query.sessionId,cursor:null},token),/Invalid/);f.control.closing=false;
  assert.equal(JSON.stringify(f.store.delivery(f.prepare.messageId)),before);assert.equal(f.sends(),1);assert.equal(f.listeners.size,0);
});
test('output proof generation is checked independently of notification generation',async t=>{
  const f=await fixture(t);f.store.db.prepare("UPDATE deliveries SET result=json_set(result,'$.outputContext.generation',999) WHERE id=?").run(f.prepare.messageId);
  await assert.rejects(f.control.notifications.read(f.query,f.grant.capability),/binding/);assert.equal(f.sends(),1);
});
test('a follow-up accepts exactly the UTF-8 byte budget and rejects the next byte',async t=>{
  for(const text of ['x'.repeat(16384),'語'.repeat(5461)+'x']){
    const f=await fixture(t),c=f.control.notifications,token=f.grant.capability;await c.read(f.query,token);
    await assert.rejects(c.assign({...f.query,text:text+'x'},token),/Invalid/);assert.equal(f.sends(),1);
    assert.equal((await c.assign({...f.query,text},token)).state,'delivered');assert.equal(f.sends(),2);
  }
});
