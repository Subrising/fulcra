import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID as id} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {journal} from './journal.mjs';
import {canonical} from './protocol.mjs';
import {createReceiverGuard} from './receiver-guard.mjs';
import {initializeBookPermissions,prepareBookPermission,admitBookPermission,cancelBookPermission,bookPermissionReceipt,createBookPermissionGuard} from './permissions.mjs';

function fixture(t) {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'orca-book-permission-')));fs.chmodSync(dir,0o700);
  const base=dir+'/tasks',cwd=base+'/'+id();fs.mkdirSync(cwd,{recursive:true,mode:0o700});
  const file=dir+'/receiver.sqlite',db=journal(file),guard=createReceiverGuard(file,'fixture');initializeBookPermissions(db);
  const sessionId=id(),agentId=id(),nativeId=id(),task=id(),origin=id(),now=Date.now(),stamp=new Date(now).toISOString();
  const observation=guard.observation(agentId),binding={boot:observation.boot,boundary:1,lastPromptId:null,nativeId};
  const creation={sessionId,messageId:id(),taskId:task,provider:'claude',title:'Scoped Book task'};
  db.prepare("INSERT INTO receiver_sessions VALUES (?,?,?,?,?,?,'created',2,'delegated',?,?)").run(sessionId,creation.messageId,task,canonical(creation),agentId,cwd,canonical(binding),nativeId);
  db.prepare("INSERT INTO receiver_intents VALUES (?,?,?,'acknowledged',1,NULL)").run(origin,sessionId,canonical({generation:2,binding}));
  const request={id:id(),provider:'claude',kind:'tool',name:'Write',input:{file_path:cwd+'/result.md',content:'First result'},metadata:{toolUseId:id()}};
  const p={sessionId,intentId:id(),nativeId,origin,grantEpoch:id(),generation:2,binding,expectedLastUserAt:stamp,request};
  const o={...observation,id:agentId,cwd,provider:'claude',owner:'orca-book-task',task,route:sessionId,nativeId,lastUserAt:stamp,lastPromptId:origin,pendingPermissions:[request]};
  const agent={id:agentId,cwd,provider:'claude',labels:{owner:'orca-book-task',task,'orca.route':sessionId},runtimeInfo:{provider:'claude',sessionId:nativeId},lastUserMessageAt:new Date(stamp),pendingPermissions:new Map([[request.id,request]])};
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,base,cwd,file,db,guard,p,o,agent,now,prepare:()=>prepareBookPermission(db,p,o,base,now),admit:(response={behavior:'allow'})=>admitBookPermission(db,agent,p.intentId,response,guard.observation(agentId),base,now)};
}
test('exact Write and distinct Edit admit once; same prompt cannot consume new ticket IDs',t=>{
  const f=fixture(t),row=f.prepare();assert.equal(row.state,'prepared');assert.equal(row.dispatch,true);assert.equal(f.prepare().dispatch,false);assert.equal(f.admit(),f.p.request.id);
  assert.throws(()=>f.admit(),/consumed/);assert.equal(f.prepare().state,'consumed');
  assert.throws(()=>prepareBookPermission(f.db,{...f.p,intentId:id(),grantEpoch:id()},f.o,f.base,f.now),/already ticketed/);
  fs.writeFileSync(f.p.request.input.file_path,'First result');
  f.p={...f.p,intentId:id(),request:{...f.p.request,id:id(),name:'Edit',input:{file_path:f.cwd+'/result.md',old_string:'First',new_string:'Reviewed'}}};
  f.o.pendingPermissions=[f.p.request];f.agent.pendingPermissions=new Map([[f.p.request.id,f.p.request]]);
  assert.equal(prepareBookPermission(f.db,f.p,f.o,f.base,f.now).state,'prepared');
  assert.equal(admitBookPermission(f.db,f.agent,f.p.intentId,{behavior:'allow'},f.guard.observation(f.agent.id),f.base,f.now),f.p.request.id);
  assert.equal(f.db.prepare('SELECT count(*) n FROM receiver_permissions').get().n,2);
});
test('cancel before admission wins; cancel after admission reports already consumed',t=>{
  const f=fixture(t);f.prepare();assert.equal(cancelBookPermission(f.db,f.p.sessionId,f.p.intentId).state,'cancelled');assert.throws(()=>f.admit(),/consumed/);
  assert.throws(()=>cancelBookPermission(f.db,id(),f.p.intentId),/Unknown/);assert.throws(()=>bookPermissionReceipt(f.db,f.p.sessionId,id()),/Unknown/);
  const g=fixture(t);g.prepare();g.admit();assert.equal(cancelBookPermission(g.db,g.p.sessionId,g.p.intentId).state,'consumed');
});
test('human prompt, permission response and daemon restart invalidate prepared tickets',t=>{
  for(const kind of ['prompt','permission','restart']){
    const f=fixture(t);f.prepare();const permission=createBookPermissionGuard(f.file,f.base,f.guard);
    if(kind==='prompt')f.guard.guard(f.agent,'Human takes over',{},false);
    if(kind==='permission')assert.equal(permission(f.agent,'native-human',{behavior:'deny'}),'native-human');
    const check=kind==='restart'?createBookPermissionGuard(f.file,f.base,createReceiverGuard(f.file,'fixture')):permission;
    assert.throws(()=>check(f.agent,'orca-permission:'+f.p.intentId,{behavior:'allow'}),/Orca native permission refused/);
    assert.equal(bookPermissionReceipt(f.db,f.p.sessionId,f.p.intentId).state,'prepared');
  }
});
test('human permission remains usable without a journal; automated path refuses',t=>{
  const f=fixture(t),check=createBookPermissionGuard(f.dir+'/missing/receiver.sqlite',f.base,f.guard);
  assert.equal(check(f.agent,'ordinary',{behavior:'deny'}),'ordinary');assert.equal(f.guard.observation(f.agent.id).humanAt,1);
  assert.throws(()=>check(f.agent,'orca-permission:'+id(),{behavior:'allow'}),/Orca native permission refused/);
});
test('observed permission, source, ownership and generation mismatches cannot prepare',t=>{
  for(const alter of [f=>f.o.pendingPermissions=[],f=>f.o.pendingPermissions.push(f.p.request),f=>f.o.lastPromptId=id(),f=>f.o.owner='foreign',f=>f.o.nativeId=id(),f=>f.o.saturated=true,f=>f.o.humanAt=1,f=>f.p.generation++,f=>f.p.binding.boot=id(),f=>f.p.origin=id(),f=>f.p.request={...f.p.request,input:{...f.p.request.input,content:'tampered'}},f=>f.p.extra=true]){
    const f=fixture(t);alter(f);assert.throws(()=>f.prepare());assert.equal(f.db.prepare('SELECT count(*) n FROM receiver_permissions').get().n,0);
  }
});
test('native changes at final admission refuse without consuming the ticket',t=>{
  for(const alter of [f=>f.agent.provider='codex',f=>f.agent.cwd=f.dir,f=>f.agent.labels.task=id(),f=>f.agent.runtimeInfo.sessionId=id(),f=>f.agent.archivedAt=new Date(),f=>f.agent.lastUserMessageAt=new Date(0),f=>f.agent.pendingPermissions.clear(),f=>f.agent.pendingPermissions.set('different-key',f.p.request),f=>f.agent.inFlightPermissionResponses=new Set([f.p.request.id]),f=>f.db.prepare("UPDATE receiver_sessions SET mode='human'").run(),f=>f.db.prepare('UPDATE receiver_sessions SET generation=3').run(),f=>f.db.prepare("UPDATE receiver_intents SET consumed=0").run(),f=>f.db.prepare("INSERT INTO receiver_intents VALUES (?,?,?,'acknowledged',1,NULL)").run(id(),f.p.sessionId,canonical({generation:2,binding:f.p.binding}))]){
    const f=fixture(t);f.prepare();alter(f);assert.throws(()=>f.admit());assert.equal(bookPermissionReceipt(f.db,f.p.sessionId,f.p.intentId).state,'prepared');
  }
});
test('exact file proof is rechecked for changed content, symlink, hardlink and edit inputs',t=>{
  for(const kind of ['content','symlink','hardlink','edit']){
    const f=fixture(t);fs.writeFileSync(f.cwd+'/result.md','First result');
    if(kind==='edit'){f.p.request.name='Edit';f.p.request.input={file_path:f.cwd+'/result.md',old_string:'First',new_string:'Reviewed'};}
    f.prepare();
    if(kind==='symlink'){fs.unlinkSync(f.cwd+'/result.md');fs.symlinkSync(f.dir+'/outside',f.cwd+'/result.md');}
    else if(kind==='hardlink')fs.linkSync(f.cwd+'/result.md',f.dir+'/outside');else fs.writeFileSync(f.cwd+'/result.md','Different result');
    assert.throws(()=>f.admit());assert.equal(bookPermissionReceipt(f.db,f.p.sessionId,f.p.intentId).state,'prepared');
  }
});
test('only exact allow, bounded lifetime and unchanged duplicate ticket are accepted',t=>{
  const f=fixture(t);f.prepare();
  for(const response of [{behavior:'deny'},{behavior:'allow',updatedInput:{}},{behavior:'allow',updatedPermissions:[]}])assert.throws(()=>f.admit(response),/altered/);
  for(const time of [f.now-1,f.now+15001,NaN])assert.throws(()=>admitBookPermission(f.db,f.agent,f.p.intentId,{behavior:'allow'},f.guard.observation(f.agent.id),f.base,time),/expired/);
  assert.throws(()=>prepareBookPermission(f.db,{...f.p,grantEpoch:id()},f.o,f.base,f.now),/identity conflict/);
});
test('receiver reopen and lost post-consumption process preserve the no-replay receipt',t=>{
  const f=fixture(t);f.prepare();
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {journal} from ${JSON.stringify(new URL('./journal.mjs',import.meta.url).href)};import {admitBookPermission} from ${JSON.stringify(new URL('./permissions.mjs',import.meta.url).href)};const a=JSON.parse(process.argv[2]);a.lastUserMessageAt=new Date(a.lastUserMessageAt);a.pendingPermissions=new Map(a.pendingPermissions);admitBookPermission(journal(process.argv[1]),a,process.argv[3],{behavior:'allow'},JSON.parse(process.argv[4]),process.argv[5],Number(process.argv[6]));process.kill(process.pid,'SIGKILL');`,f.file,JSON.stringify({...f.agent,pendingPermissions:[...f.agent.pendingPermissions]}),f.p.intentId,JSON.stringify(f.guard.observation(f.agent.id)),f.base,String(f.now)],{encoding:'utf8'});
  assert.equal(child.signal,'SIGKILL',child.stderr);const reopened=journal(f.file);
  try{initializeBookPermissions(reopened);assert.equal(bookPermissionReceipt(reopened,f.p.sessionId,f.p.intentId).state,'consumed');assert.equal(prepareBookPermission(reopened,f.p,f.o,f.base,f.now).state,'consumed');}finally{reopened.close();}
  assert.throws(()=>f.admit(),/consumed/);
});
test('native guard passes only the exact request ID and refuses an incorrect Map key',t=>{
  const f=fixture(t);f.prepare();const guard=createBookPermissionGuard(f.file,f.base,f.guard);
  assert.equal(guard(f.agent,'orca-permission:'+f.p.intentId,{behavior:'allow'}),f.p.request.id);
  assert.throws(()=>guard(f.agent,'orca-permission:'+f.p.intentId,{behavior:'allow'}),/consumed/);
  const g=fixture(t);g.prepare();g.agent.pendingPermissions=new Map([['wrong-key',g.p.request]]);assert.throws(()=>g.admit(),/identity changed/);
});
test('capacity is persistent, while old schema readers ignore the additive ticket table',t=>{
  const f=fixture(t),before=canonical(f.db.prepare('SELECT * FROM receiver_sessions').all());
  const insert=f.db.prepare("INSERT INTO receiver_permissions VALUES (?,?,?,'{}','{}','consumed',0)");
  f.db.exec('BEGIN IMMEDIATE');for(let n=0;n<1000;n++)insert.run(id(),id(),f.p.sessionId);f.db.exec('COMMIT');
  assert.throws(()=>f.prepare(),/capacity/);initializeBookPermissions(f.db);
  const old=journal(f.file,true);try{assert.equal(canonical(old.prepare('SELECT * FROM receiver_sessions').all()),before);assert.equal(old.prepare('SELECT count(*) n FROM receiver_permissions').get().n,1000);}finally{old.close();}
});
test('unsupported tools, malformed tickets and request changes never create admission authority',t=>{
  for(const alter of [f=>f.p.request.name='Bash',f=>f.p.request.input.file_path=f.dir+'/outside',f=>f.p.request.input.file_path=f.cwd+'/.secret',f=>f.p.request.provider='codex',f=>f.p.intentId='bad',f=>f.p.expectedLastUserAt='bad',f=>f.p.request.id='',f=>f.p.binding={boot:'wrong'}]){
    const f=fixture(t);alter(f);assert.throws(()=>f.prepare());assert.equal(f.db.prepare('SELECT count(*) n FROM receiver_permissions').get().n,0);
  }
});
test('seeded changes to pending tool content, native identity or permission ID never admit',t=>{
  let seed=0x51a70;for(let n=0;n<40;n++){
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;const f=fixture(t);f.prepare();
    if(seed%3===0)f.agent.runtimeInfo.sessionId=id();
    else if(seed%3===1)f.p.request.input.content+=' changed '+seed;
    else f.p.request.id=id();
    assert.throws(()=>f.admit());assert.equal(bookPermissionReceipt(f.db,f.p.sessionId,f.p.intentId).state,'prepared');
  }
});
test('a cancellation holding the SQLite lock wins against concurrent native admission',async t=>{
  const f=fixture(t);f.prepare();const marker=f.dir+'/locked';
  const child=spawn(process.execPath,['--input-type=module','-e',`import fs from 'node:fs';import {journal} from ${JSON.stringify(new URL('./journal.mjs',import.meta.url).href)};const db=journal(process.argv[1]);db.exec('BEGIN IMMEDIATE');db.prepare("UPDATE receiver_permissions SET state='cancelled' WHERE id=? AND state='prepared'").run(process.argv[2]);fs.writeFileSync(process.argv[3],'locked');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,400);db.exec('COMMIT');db.close();`,f.file,f.p.intentId,marker],{stdio:'ignore'});
  const exited=new Promise(resolve=>child.on('exit',code=>resolve(code)));t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  for(let n=0;n<300&&!fs.existsSync(marker);n++)await new Promise(resolve=>setTimeout(resolve,5));
  assert(fs.existsSync(marker),'Cancellation acquired journal transaction');assert.throws(()=>f.admit(),/consumed/);assert.equal(await exited,0);
  assert.equal(bookPermissionReceipt(f.db,f.p.sessionId,f.p.intentId).state,'cancelled');
});
test('unknown cancellations are permanent, deduplicate and cannot exhaust real-ticket capacity',t=>{
  const f=fixture(t);assert.equal(cancelBookPermission(f.db,f.p.sessionId,f.p.intentId).state,'cancelled');
  assert.equal(cancelBookPermission(f.db,f.p.sessionId,f.p.intentId).state,'cancelled');assert.equal(f.db.prepare('SELECT count(*) n FROM receiver_permissions').get().n,1);
  assert.throws(()=>f.prepare(),/identity conflict/);assert.throws(()=>cancelBookPermission(f.db,f.p.sessionId,'invalid'),/Unknown/);
  for(let n=1;n<32;n++)cancelBookPermission(f.db,f.p.sessionId,id());
  assert.throws(()=>cancelBookPermission(f.db,f.p.sessionId,id()),/capacity/);
  f.p.intentId=id();assert.equal(f.prepare().state,'prepared');
  assert.equal(cancelBookPermission(f.db,f.p.sessionId,f.p.intentId).state,'cancelled');
  assert.equal(f.db.prepare("SELECT count(*) n FROM receiver_permissions WHERE identity LIKE 'cancel:%'").get().n,32);
});
test('shared projection equals the installed Mini inline projection for canonical native shapes',async()=>{
  const {permissionProjection:mini}=await import('../control/admission-guard.mjs');const {permissionProjection:book}=await import('../control/permission-projection.mjs');
  for(const request of [{},{id:id(),provider:'claude',kind:'tool',name:'Write',input:{},metadata:{toolUseId:id(),Z:'z',a:'a'},createdAt:new Date()}, {id:id(),actions:[],metadata:{},input:null}])assert.deepEqual(book(request),mini(request));
});
test('U7 receiver automatically admits MCP in auto mode and rechecks changed mode', t => {
  const f=fixture(t); f.o.currentModeId='auto'; f.agent.currentModeId='auto';
  f.p.request.name='mcp__workspace__list_files'; f.p.request.input={path:f.cwd};
  assert.equal(f.prepare().state,'prepared');
  f.agent.currentModeId='default'; assert.throws(()=>f.admit());
  f.agent.currentModeId='auto'; assert.equal(f.admit(),f.p.request.id);
});
test('U7 receiver escalates Keychain MCP under auto', t => {
  const f=fixture(t); f.o.currentModeId='auto'; f.agent.currentModeId='auto';
  f.p.request.name='mcp__keychain__get_item'; f.p.request.input={name:'fixture'};
  assert.throws(()=>f.prepare(),/Credential|Keychain/);
});
test('U7 Codex receiver full-access grants and admits an ordinary MCP request', async t => {
  const f=fixture(t);
  const row=f.db.prepare('SELECT * FROM receiver_sessions WHERE id=?').get(f.p.sessionId);
  f.db.prepare('UPDATE receiver_sessions SET creation=? WHERE id=?').run(canonical({...JSON.parse(row.creation),provider:'codex'}),f.p.sessionId);
  f.o.provider='codex';f.o.currentModeId='full-access';f.agent.provider='codex';f.agent.currentModeId='full-access';f.agent.runtimeInfo.provider='codex';
  f.p.request.provider='codex';f.p.request.name='mcp__workspace__list_files';f.p.request.input={path:f.cwd};
  const {bookPermissionRPC}=await import('./permission-rpc.mjs');
  const receiver={native:{tasks:f.base},db:f.db,observed:async()=>f.o,row:()=>f.db.prepare('SELECT * FROM receiver_sessions WHERE id=?').get(f.p.sessionId)};
  const root=await bookPermissionRPC(receiver,'permission-root',receiver.row(),{sessionId:f.p.sessionId,generation:2});
  assert.equal(root.cwd,f.cwd); assert.equal(f.prepare().state,'prepared'); assert.equal(f.admit(),f.p.request.id);
});
