import nodeTest from 'node:test';
import {cleanupRegistry} from './test/cleanup.mjs';
const test=(name,fn)=>nodeTest(name,{timeout:10000},fn);
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import {patchWatcher} from './patch.mjs';
const upstream = '/Volumes/test-volume/openclaw/projects/orca-paseo-20260911/node_modules/@getpaseo/server/dist/server/server';
const runtime = fileURLToPath(new URL('./runtime.mjs',import.meta.url));
async function moduleAt(root, relative) {
 const source = await fs.readFile(path.join(upstream,relative),'utf8');
 const patched = patchWatcher(relative,source,runtime);
 assert.throws(()=>patchWatcher(relative,source+' ',runtime));
 assert.equal(spawnSync(process.execPath,['--input-type=module','--check'],{input:patched}).status,0);
 // Preserve real upstream dependencies when staging the changed file in isolation.
 const linked = patched.replace(/from "(\.[^"]+)"/g,(_all,spec)=>'from '+JSON.stringify(pathToFileURL(path.resolve(upstream,path.dirname(relative),spec)).href));
 const file = path.join(root,path.basename(relative));await fs.writeFile(file,linked);return import(pathToFileURL(file).href);
}
test('pinned native backend awaits readiness, propagates failure and never claims a healthy handle early',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orca-watch-integration-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const mod=await moduleAt(root,'file-observer/internal/native-recursive.js');
 for(const fail of [false,true]) {
  const watcher=new EventEmitter();let resolve,reject,closed=0,audits=0;watcher.ready=new Promise((a,b)=>{resolve=a;reject=b;});watcher.close=()=>closed++;
  const backend=mod.createNativeRecursiveBackend({root,isActive:()=>true,fail:()=>{}},{},()=>watcher);backend.enqueueAudit=async()=>{audits++;};const started=backend.start();await new Promise(r=>setImmediate(r));assert.equal(audits,0);assert.equal(backend.getDiagnostics().nativeHandleCount,0);
  if(fail){reject(Object.assign(Error('degraded'),{code:'WATCH_TIMEOUT'}));await assert.rejects(started,{code:'WATCH_TIMEOUT'});assert.equal(audits,0);assert.equal(backend.getDiagnostics().nativeHandleCount,0);}else{resolve();await started;assert.equal(audits,1);assert.equal(backend.getDiagnostics().nativeHandleCount,1);}await backend.close();assert(closed>=1);
 }
});
test('actual patched file explorer shares one isolated directory watcher and reports counters through diagnostics',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orca-explorer-integration-')),previous=process.env.PASEO_HOME;process.env.PASEO_HOME=path.join(root,'home');const workspace=path.join(root,'work');await fs.mkdir(workspace);await fs.writeFile(path.join(workspace,'a.txt'),'a');await fs.writeFile(path.join(workspace,'b.txt'),'b');
 const mod=await moduleAt(root,'file-explorer/observer.js'),runtimeMod=await import(pathToFileURL(runtime).href),observer=new mod.FileObserver();
 t.after(async()=>{try{observer.dispose();for(let i=0;i<100&&runtimeMod.isolatedWatchDiagnostics().trackedChildren;i++)await new Promise(r=>setTimeout(r,20));assert.equal(runtimeMod.isolatedWatchDiagnostics().trackedChildren,0);}finally{await cleanupRegistry(path.join(root,'home/orca-watch-registry'));if(previous===undefined)delete process.env.PASEO_HOME;else process.env.PASEO_HOME=previous;await fs.rm(root,{recursive:true,force:true});}});
 const changes=[];const a=await observer.subscribe({cwd:workspace,path:'a.txt'},v=>changes.push(v));const b=await observer.subscribe({cwd:workspace,path:'b.txt'},v=>changes.push(v));
 for(let i=0;i<100&&!runtimeMod.isolatedWatchDiagnostics().trackedChildren;i++)await new Promise(r=>setTimeout(r,20));assert.equal(runtimeMod.isolatedWatchDiagnostics().activeRoots,1);assert.equal(runtimeMod.isolatedWatchDiagnostics().subscriptions,2);
 await new Promise(r=>setTimeout(r,100));await fs.writeFile(path.join(workspace,'a.txt'),'changed');for(let i=0;i<100&&!changes.length;i++)await new Promise(r=>setTimeout(r,20));assert(changes.length>0);a.unsubscribe();assert.equal(runtimeMod.isolatedWatchDiagnostics().subscriptions,1);b.unsubscribe();
 const diagnostics=await fs.readFile(path.join(upstream,'session/daemon/diagnostics.js'),'utf8');const patched=patchWatcher('session/daemon/diagnostics.js',diagnostics,runtime);assert(patched.includes('safeSection("Isolated file watchers"'));assert.equal(spawnSync(process.execPath,['--input-type=module','--check'],{input:patched}).status,0);
 let intervals=0;const fallback=new mod.FileObserver({watchDirectory(){throw Object.assign(Error('capacity'),{code:'WATCH_CAPACITY'});},setInterval(){intervals++;return 1;},clearInterval(){},setTimeout,clearTimeout});const c=await fallback.subscribe({cwd:workspace,path:'a.txt'},()=>{});assert.equal(intervals,1);c.unsubscribe();fallback.dispose();
});
