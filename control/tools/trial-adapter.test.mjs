import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { sealBundle, verifyBundle, createPrivateRun, sameProcess } from './trial/contract.mjs';
test('trial pins all bundle bytes and confined aliases before any launch',()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'trial-contract-')));
 try{
  const app=path.join(root,'Fulcra.app');fs.mkdirSync(path.join(app,'Contents/MacOS'),{recursive:true});fs.mkdirSync(path.join(app,'Contents/Resources'),{recursive:true});
  fs.writeFileSync(path.join(app,'Contents/MacOS/Fulcra'),'fake executable');fs.writeFileSync(path.join(app,'Contents/Resources/app.asar'),'fake archive');
  const pin=sealBundle(app);verifyBundle(app,pin);
  fs.writeFileSync(path.join(app,'Contents/Resources/other'),'extra');assert.throws(()=>verifyBundle(app,pin),/digest/);fs.rmSync(path.join(app,'Contents/Resources/other'));
  fs.symlinkSync('app.asar',path.join(app,'Contents/Resources/alias'));assert.throws(()=>verifyBundle(app,pin),/digest/);
  fs.rmSync(path.join(app,'Contents/Resources/alias'));fs.symlinkSync(root,path.join(app,'escape'));assert.throws(()=>sealBundle(app),/escape/i);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('prelaunch owns a new private home and refuses protected ports and stale PID lifetime',()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'trial-run-')));
 try{
  assert.throws(()=>createPrivateRun(path.join(root,'bad'),6767),/port/);
  const run=createPrivateRun(path.join(root,'good'),16767);assert.equal(fs.statSync(run.root).mode&0o777,0o700);
  assert.equal(JSON.parse(fs.readFileSync(path.join(run.root,'paseo/config.json'))).daemon.listen,'127.0.0.1:16767');
  assert.throws(()=>createPrivateRun(run.root,16767),/exist/);
  assert(sameProcess({pid:41,start:'a',uid:501,entry:'/private/fixture/app'},{pid:41,start:'a',uid:501,entry:'/private/fixture/app'}));
  assert(!sameProcess({pid:41,start:'a',uid:501,entry:'fixture'},{pid:41,start:'b',uid:501,entry:'fixture'}));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('retitled daemon identity needs the exact bundle executable, UID and PID, never its title alone',async()=>{
 const { identifyProcess }=await import('./trial/contract.mjs');
 const row='70472 70120 501 Sun Sep 27 21:20:40 2026 Fulcra Supervisor';
 const entry='/private/test/Fulcra Helper';
 assert.throws(()=>identifyProcess(row,{pid:70472,uid:501,entry,executables:[]}),/identity/);
 assert.equal(identifyProcess(row,{pid:70472,uid:501,entry,executables:[entry]}).ppid,70120);
 assert.throws(()=>identifyProcess(row,{pid:70472,uid:502,entry,executables:[entry]}),/identity/);
 assert.throws(()=>identifyProcess(row,{pid:99,uid:501,entry,executables:[entry]}),/identity/);
 assert.throws(()=>identifyProcess(row,{pid:70472,uid:501,entry,executables:[entry+'.old']}),/identity/);
});
