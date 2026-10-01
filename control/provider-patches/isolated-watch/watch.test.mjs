import nodeTest from 'node:test';
const test=(name,fn)=>nodeTest(name,{timeout:10000},fn);
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createWatchService} from './service.mjs';
import {WatchRegistry,processIdentity} from './registry.mjs';
const sleep = ms => new Promise(r => setTimeout(r,ms));
async function fixture(t, options = {}) { const children=[],root = await fs.mkdtemp(path.join(os.tmpdir(),'orca-isolated-watch-')), directory = path.join(root,'registry'), service = createWatchService({directory,launch:(exe,args,opts)=>{const child=spawn(exe,args,{...opts,env:{...opts.env,...(process.env.NODE_V8_COVERAGE?{NODE_V8_COVERAGE:process.env.NODE_V8_COVERAGE}:{})}});children.push(child);return child;},...options}); t.after(async()=>{try{service.close();for(let i=0;i<50&&service.diagnostics().trackedChildren;i++)await sleep(20);assert.equal(service.diagnostics().trackedChildren,0);}finally{for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await fs.rm(root,{recursive:true,force:true});}}); return {root,directory,service}; }
function subscribe(service,root,recursive=true) { const events=[],errors=[],watch=service.watch(root,{recursive},(eventType,filename)=>events.push({eventType,filename})); watch.on('error',e=>errors.push(e)); return {watch,events,errors}; }
async function until(fn,ms=3000) { const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(20);}throw Error('Condition not observed'); }
test('real recursive events, unicode filename and shared subscriptions retain one child until final close',async t=>{
 const f=await fixture(t),dir=path.join(f.root,'work');await fs.mkdir(dir);const a=subscribe(f.service,dir),b=subscribe(f.service,dir);await Promise.all([a.watch.ready,b.watch.ready]);assert.equal(f.service.diagnostics().trackedChildren,1);
 const name='cafe\u0301-日本.txt';await fs.writeFile(path.join(dir,name),'one');await until(()=>a.events.some(e=>e.filename===name)&&b.events.some(e=>e.filename===name));a.watch.close();assert.equal(f.service.diagnostics().subscriptions,1);await fs.writeFile(path.join(dir,name),'two');await until(()=>b.events.length>1);assert.equal(a.errors.length,0);b.watch.close();await until(()=>f.service.diagnostics().trackedChildren===0);
});
test('FIFO blocks native watch in child while parent timers run and readiness fails within bound',async t=>{
 const f=await fixture(t,{timeoutMs:500}),fifo=path.join(f.root,'stalled');execFileSync('/usr/bin/mkfifo',[fifo]);let ticks=0;const timer=setInterval(()=>ticks++,20);try{const a=subscribe(f.service,fifo,false);await assert.rejects(a.watch.ready,{code:'WATCH_TIMEOUT'});assert(ticks>=10);assert.equal(a.errors.length,1);await until(()=>f.service.diagnostics().trackedChildren===0);}finally{clearInterval(timer);}
});
test('capacity errors are explicit and close while starting does not leak a child',async t=>{
 const f=await fixture(t,{limit:1}),a=subscribe(f.service,f.root);await a.watch.ready;const dir=path.join(f.root,'second');await fs.mkdir(dir);const b=subscribe(f.service,dir);await assert.rejects(b.watch.ready,{code:'WATCH_CAPACITY'});assert.equal(f.service.diagnostics().trackedChildren,1);assert.equal(f.service.diagnostics().capacityFailures,1);a.watch.close();await until(()=>f.service.diagnostics().trackedChildren===0);const c=subscribe(f.service,dir);c.watch.close();await assert.rejects(c.watch.ready,{code:'WATCH_CLOSED'});await sleep(50);assert.equal(f.service.diagnostics().trackedChildren,0);
});
test('malformed and oversized child frames fail once and terminate only their own child',async t=>{
 for(const payload of ['not-json\n',JSON.stringify({type:'ready'})+'\n'+JSON.stringify({type:'event',eventType:'change',filename:'../escape'})+'\n','x'.repeat(1024*1024)]){
  const f=await fixture(t),dir=path.join(f.root,'fake');await fs.mkdir(dir);const helper=path.join(dir,'watch-child.mjs');await fs.writeFile(helper,"process.stdin.once('data',()=>process.stdout.write("+JSON.stringify(payload)+"));process.stdin.on('end',()=>process.exit());");
  const service=createWatchService({directory:path.join(f.root,'frames'),helper,timeoutMs:500});t.after(()=>service.close());const a=subscribe(service,dir);await a.watch.ready.catch(()=>{});await until(()=>a.errors.length===1);await until(()=>service.diagnostics().trackedChildren===0);assert.equal(a.errors[0].code,'WATCH_PROTOCOL');assert.equal(service.diagnostics().protocolFailures,1);a.watch.close();
 }
});
test('registry retains killed-but-unexited child across new service and refuses recovery spawn',async t=>{
 const {EventEmitter}=await import('node:events'),{PassThrough}=await import('node:stream');const root=await fs.mkdtemp(path.join(os.tmpdir(),'orca-watch-quarantine-'));let alive=true,launches=0,child,record;const parent={pid:process.pid,parent:1,started:'parent-start',command:'parent'},inspect=async pid=>pid===process.pid?parent:alive&&pid===900001?record:null;
 const directory=path.join(root,'registry'),registry=new WatchRegistry(directory,{inspect,kill:()=>{},limit:1});
 const launch=(_exe,args)=>{launches++;child=new EventEmitter();Object.assign(child,{pid:900001,exitCode:null,signalCode:null,stdout:new PassThrough(),stdin:new PassThrough(),kill:()=>true});record={pid:900001,parent:process.pid,started:'child-start',command:process.execPath+' '+args.join(' ')};return child;};
 const service=createWatchService({directory,registry,launch,limit:1,timeoutMs:500}),a=subscribe(service,root);await assert.rejects(a.watch.ready,{code:'WATCH_TIMEOUT'});assert.equal(registry.rows.size,1);
 const nextRegistry=new WatchRegistry(directory,{inspect,kill:()=>{},limit:1}),next=createWatchService({directory,registry:nextRegistry,launch,limit:1,timeoutMs:200});
 for(let i=0;i<5;i++){const b=subscribe(next,root);await assert.rejects(b.watch.ready,{code:'WATCH_QUARANTINED'});}assert.equal(launches,1);assert.equal(next.diagnostics().trackedChildren,1);
 alive=false;child.exitCode=0;child.emit('exit',0);await until(async()=>{await nextRegistry.refresh();return nextRegistry.rows.size===0;});service.close();next.close();await fs.rm(root,{recursive:true,force:true});
});
test('restart reaper kills a FIFO-blocked watcher after its actual parent is killed',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orca-watch-reaper-')),directory=path.join(root,'registry'),fifo=path.join(root,'fifo');execFileSync('/usr/bin/mkfifo',[fifo]);const module= new URL('./service.mjs',import.meta.url).href;
 const parent=spawn(process.execPath,['--input-type=module','-e',"const {createWatchService}=await import(process.argv[1]);const s=createWatchService({directory:process.argv[2],timeoutMs:10000});const w=s.watch(process.argv[3],{recursive:false},()=>{});w.on('error',()=>{});await w.ready;",module,directory,fifo],{stdio:'ignore'});let pid;
 t.after(async()=>{parent.kill('SIGKILL');if(pid)try{process.kill(pid,'SIGKILL');}catch{}await fs.rm(root,{recursive:true,force:true});});
 await until(async()=>{try{const names=(await fs.readdir(directory)).filter(x=>x.endsWith('.json'));if(!names.length)return false;pid=JSON.parse(await fs.readFile(path.join(directory,names[0]),'utf8')).pid;return true;}catch{return false;}});
 await sleep(80);assert(await processIdentity(pid));parent.kill('SIGKILL');await new Promise(r=>parent.once('exit',r));const registry=new WatchRegistry(directory);await until(async()=>{await registry.refresh();return registry.rows.size===0;});assert.equal(await processIdentity(pid),null);
});

test('service close is final and a reused PID is never signalled by restart reconciliation',async t=>{
 const f=await fixture(t),a=subscribe(f.service,f.root);await a.watch.ready;f.service.close();assert.throws(()=>subscribe(f.service,f.root),{code:'WATCH_CLOSED'});await until(()=>f.service.diagnostics().trackedChildren===0);
 const dir=path.join(f.root,'reuse');await fs.mkdir(dir,{mode:0o700});const nonce='a'.repeat(32),helper=new URL('./watch-child.mjs',import.meta.url).pathname;
 const row={pid:901234,parent:901235,started:'old birth',parentStarted:'old parent',command:process.execPath+' '+helper+' '+nonce,helper,helperSha:'a'.repeat(64),key:'scope',nonce};await fs.writeFile(path.join(dir,nonce+'.json'),JSON.stringify(row),{mode:0o600});let signals=0;const registry=new WatchRegistry(dir,{inspect:async()=>({started:'new birth',command:'unrelated'}),kill:()=>signals++});await registry.refresh();assert.equal(signals,0);assert.equal(registry.rows.size,0);
});
test('production child coalesces 50000 events under pipe backpressure and stays usable',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'orca-watch-burst-')),helper=path.join(root,'watch-child.mjs'),production=new URL('./watch-child.mjs',import.meta.url).href,finished=path.join(root,'burst-finished');
 // Substitute only native event production; execute the actual child framing and queue.
 const mock="import {EventEmitter} from 'node:events';export function watch(root,options,listener){const e=new EventEmitter();e.close=()=>{};setImmediate(()=>{for(let i=0;i<50000;i++)listener('rename','file-'+i);globalThis.burstFinished();setTimeout(()=>listener('change','after-overflow'),300);});return e;}";
 await fs.writeFile(helper,"import {writeFileSync} from 'node:fs';globalThis.burstFinished=()=>writeFileSync("+JSON.stringify(finished)+",'done');import {registerHooks} from 'node:module';registerHooks({resolve(spec,ctx,next){if(spec==='node:fs')return {url:'data:text/javascript,'+encodeURIComponent("+JSON.stringify(mock)+"),shortCircuit:true};return next(spec,ctx);}});await import("+JSON.stringify(production)+");");
 const child=spawn(process.execPath,[helper],{stdio:['pipe','pipe','ignore']});t.after(async()=>{child.kill('SIGKILL');await fs.rm(root,{recursive:true,force:true});});child.stdout.pause();child.stdin.write(JSON.stringify({root,recursive:true})+'\n');await until(async()=>{try{await fs.stat(finished);return true;}catch{return false;}},5000);let output='';child.stdout.on('data',b=>output+=b);child.stdout.resume();await until(()=>output.includes('after-overflow'));const frames=output.trim().split('\n').map(JSON.parse);assert(frames.some(f=>f.type==='event'&&f.filename===null));assert(Buffer.byteLength(output)<262144);assert.equal(frames.filter(f=>f.type==='error').length,0);assert.equal(child.exitCode,null);
 child.stdin.end();await new Promise(r=>child.once('exit',r));
});
test('seeded invalid watch scopes cannot launch or retain any child',async t=>{
 const f=await fixture(t);let seed=0x1112026,launches=0;const service=createWatchService({directory:path.join(f.root,'invalid'),launch:()=>{launches++;throw Error('Unexpected launch');}});t.after(()=>service.close());
 for(let i=0;i<512;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const token=seed.toString(36),kind=seed%4,root=kind===0?token:kind===1?'/'+token+'\0tail':kind===2?null:'/valid/'+token,options={recursive:kind===3?token:true};assert.throws(()=>service.watch(root,options,()=>{}),{code:'WATCH_INPUT'});}
 await sleep(30);assert.equal(launches,0);assert.equal(service.diagnostics().activeRoots,0);assert.equal(service.diagnostics().trackedChildren,0);console.log('Input property/fuzz seed0x1112026:512 malformed scopes, zero child launches.');
});
