import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { worktreeLifecycleSettings } from '../config.mjs';
import { WorktreeLifecycle } from './worktree-lifecycle.mjs';
import { READ_METHODS } from './command-parser.mjs';

test('P9 R8 state with retention 17 and no job directory completes the management preview without changing stored state', async t => {
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cc-r8-upgrade-')));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 // R8 first-run creates config/tasks.json but no filesystem jobs (tasks/) until work exists.
 fs.copyFileSync(new URL('./fixtures/r8-retention17.json',import.meta.url),path.join(home,'config.json'));fs.chmodSync(path.join(home,'config.json'),0o600);fs.writeFileSync(path.join(home,'tasks.json'),JSON.stringify({version:1,issues:[],projects:[]}),{mode:0o600});
 process.env.ORCA_HOME=home; const {managementDispatcher}=await import('./rpc.mjs'); const settings=worktreeLifecycleSettings({ORCA_HOME:home});
 const before=fs.readFileSync(path.join(home,'config.json'));assert.equal(fs.existsSync(path.join(home,'tasks')),false);
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const service=new WorktreeLifecycle({home,db,settings,session:async()=>null});const invoke=managementDispatcher({worktreeLifecycle:service});
 const pending=await invoke({method:'worktree-lifecycle-preview',input:{}});assert.equal(pending.pending,true);await service.stop();
 const reply=await invoke({method:'worktree-lifecycle-preview',input:{operationId:pending.operationId}});
 assert.equal(reply.pending,false);assert.equal(reply.value.retentionDays,17);assert.deepEqual(reply.value.jobs,[]);
 assert.deepEqual(fs.readFileSync(path.join(home,'config.json')),before);assert.equal(await settings.get(),17);
});
test('P9 preview is a read, while apply and retention writes retain uncertain-write semantics',()=>{
 assert.ok(READ_METHODS.includes('worktree-lifecycle-preview'));
 assert.ok(!READ_METHODS.includes('worktree-lifecycle-apply'));assert.ok(!READ_METHODS.includes('worktree-lifecycle-retention'));
});

test('P9 an alias or dangling job root remains refused rather than reported empty', async t=>{
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cc-root-fence-')));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const service=new WorktreeLifecycle({home,db,session:async()=>null});
 fs.symlinkSync(path.join(home,'absent'),path.join(home,'tasks'));await assert.rejects(service.dryRun());
 fs.unlinkSync(path.join(home,'tasks'));fs.mkdirSync(path.join(home,'other'));fs.symlinkSync(path.join(home,'other'),path.join(home,'tasks'));await assert.rejects(service.dryRun(),/Canonical/);
});

test('R13-V1 legacy preview still requires operator auth and never grants apply or retention authority',async t=>{
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cc-preview-lane-')));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 fs.copyFileSync(new URL('./fixtures/r8-retention17.json',import.meta.url),path.join(home,'config.json'));fs.chmodSync(path.join(home,'config.json'),0o600);process.env.ORCA_HOME=home;
 const {rpc}=await import('./rpc.mjs');let previews=0,writes=0;
 const call=rpc({worktreeLifecycle:{previewRequest:()=>{previews++;return {pending:true,operationId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'};},applyRequest:()=>writes++,settings:{set:()=>writes++}}},'fixture-operator',{allowOperatorWrites:false});
 for(const extra of [{},{operator:'wrong'},{capability:'forged'},{read:true,operator:'fixture-operator'}])await assert.rejects(call({method:'worktree-lifecycle-preview',input:{},...extra}));
 assert.equal(previews,0);assert.equal((await call({method:'worktree-lifecycle-preview',input:{},operator:'fixture-operator'})).pending,true);assert.equal(previews,1);
 for(const method of ['worktree-lifecycle-apply','worktree-lifecycle-retention'])await assert.rejects(call({method,input:{},operator:'fixture-operator'}),/Host management channel required/);
 assert.equal(writes,0);
});
