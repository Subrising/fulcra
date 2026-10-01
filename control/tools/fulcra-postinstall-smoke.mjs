#!/usr/bin/env node
// Supported disposable trial driver. Native acceptance is produced only by `smoke`.
import wire from './trial/wire.cjs';
import {processTable,descendants,waitForExit} from './trial/exit-proof.mjs';
import fs from 'node:fs';import path from 'node:path';import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import {randomUUID} from 'node:crypto';
import {sealBundle,verifyBundle,createPrivateRun,sameProcess,identifyProcess,sha} from './trial/contract.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),preload=path.join(here,'trial/preload.cjs');
const ownFiles=['fulcra-postinstall-smoke','fulcra-postinstall-smoke.mjs','trial/contract.mjs','trial/preload.cjs','trial/wire.cjs','trial/fake-keychain.cjs','trial/exit-proof.mjs'];
const adapterPins=()=>Object.fromEntries(ownFiles.map(file=>[file,sha(fs.readFileSync(path.join(here,file)))]));
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=20000){let error;const end=Date.now()+ms;while(Date.now()<end){try{const value=await fn();if(value)return value;}catch(e){error=e;}await delay(200);}throw Error('Trial deadline: '+(error?.message??'condition absent'));}
function processIdentity(pid,entry){
 const line=execFileSync('/bin/ps',['-p',String(pid),'-o','pid=,ppid=,uid=,lstart=,command='],{encoding:'utf8'}).trim();
 let executables=[];
 if(!line.includes(entry))executables=execFileSync('/usr/sbin/lsof',['-nP','-a','-p',String(pid),'-d','txt','-Fn'],{encoding:'utf8'}).split('\n').filter(row=>row.startsWith('n')).map(row=>row.slice(1));
 return identifyProcess(line,{pid,uid:process.getuid(),entry,executables});
}
function load(root){
 root=fs.realpathSync(root);const stat=fs.statSync(root);
 if(stat.uid!==process.getuid()||(stat.mode&0o077)!==0)throw Error('Private owned trial root required');
 const run=JSON.parse(fs.readFileSync(path.join(root,'run.json')));
 if(run.root!==root||JSON.stringify(run.adapter)!==JSON.stringify(adapterPins()))throw Error('Trial adapter digest mismatch');
 verifyBundle(run.app,run.bundle);return run;
}
async function rawCommand(run,name,args={}){
 const owner=JSON.parse(fs.readFileSync(path.join(run.root,'app-owner.json')));
 if(!sameProcess(owner,processIdentity(owner.pid,owner.entry)))throw Error('Trial process lifetime changed');
 const id=randomUUID(),file=path.join(run.root,'command.json');write(file,{id,name,args});
 const reply=await until(()=>{const value=JSON.parse(fs.readFileSync(path.join(run.root,'reply.json')));return value.id===id&&value;},190000);
 if(!reply.ok)throw Error(reply.error);
 if(name==='desktop_daemon_status'&&reply.result?.pid){
  const status=reply.result;
  if(status.home!==path.join(run.root,'paseo')||status.listen!==`127.0.0.1:${run.port}`||!status.ownedByDesktop||!status.desktopManaged)throw Error('Daemon is not owned by this private trial');
  const identity=processIdentity(status.pid,path.join(run.app,'Contents/Frameworks/Fulcra Helper.app/Contents/MacOS/Fulcra Helper'));
  let saved;try{saved=JSON.parse(fs.readFileSync(path.join(run.root,'daemon-owner.json')));}catch{}
  if(identity.ppid!==owner.pid&&!sameProcess(saved,identity))throw Error('Unverified supervisor parent/lifetime');
  fs.writeFileSync(path.join(run.root,'daemon-owner.json'),JSON.stringify(identity),{mode:0o600});
 }
 return reply.result;
}
function captureOwned(run){
 const table=processTable(),roots=[];
 for(const file of ['app-owner.json','daemon-owner.json']){
  const filename=path.join(run.root,file);if(!fs.existsSync(filename))continue;
  const owner=JSON.parse(fs.readFileSync(filename));
  const alive=table.find(p=>p.pid===owner.pid&&p.start===owner.start&&p.uid===owner.uid);
  if(alive&&!sameProcess(owner,processIdentity(owner.pid,owner.entry)))throw Error('Owned lifetime identity changed');roots.push(owner);
 }
 const all=descendants(table,roots);for(const owner of roots)if(!all.some(p=>p.pid===owner.pid&&p.start===owner.start))all.push(owner);
 return {table,roots,all};
}
async function command(run,name,args={}){
 if(name!=='quit')return rawCommand(run,name,args);
 await rawCommand(run,'desktop_daemon_status');
 const captured=captureOwned(run),app=JSON.parse(fs.readFileSync(path.join(run.root,'app-owner.json')));
 const background=descendants(captured.table,captured.roots.filter(r=>r.pid!==app.pid));
 const quitting=descendants(captured.table,[app]).filter(p=>!background.some(b=>b.pid===p.pid&&b.start===p.start));
 await rawCommand(run,name,args);const proof=await waitForExit(quitting);
 return {...proof,scope:'app lifetime and its non-background descendants',retainedBackground:background.map(({pid,start,uid})=>({pid,start,uid}))};
}
async function stop(run){
 // Capture before disabling so reparenting cannot hide a surviving owned child.
 await command(run,'desktop_daemon_status');
 const captured=captureOwned(run);
 await command(run,'patch_desktop_settings',{daemon:{commandCentreEnabled:false}});
 const later=captureOwned(run);for(const owner of later.all)if(!captured.all.some(p=>p.pid===owner.pid&&p.start===owner.start))captured.all.push(owner);
 await command(run,'stop_desktop_daemon');const quit=await command(run,'quit');
 return {...await waitForExit(captured.all),scope:'all recorded owned app, supervisor, worker and descendant lifetimes',quit};
}
async function freePort(port=0){const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});const selected=server.address().port;await new Promise(r=>server.close(r));return selected;}
async function start(run){
 try{await freePort(run.port);}catch(error){
  const saved=JSON.parse(fs.readFileSync(path.join(run.root,'daemon-owner.json')));
  if(!sameProcess(saved,processIdentity(saved.pid,saved.entry)))throw error;
 }
 const prior=path.join(run.root,'app-owner.json');
 if(fs.existsSync(prior)){
  const saved=JSON.parse(fs.readFileSync(prior));let alive=false;
  try{alive=sameProcess(saved,processIdentity(saved.pid,saved.entry));}catch{}
  if(alive)throw Error('Trial app already running');
 }
 fs.rmSync(path.join(run.root,'app-ready.json'),{force:true});
 const debugPort=await freePort();
 const binary=path.join(run.app,'Contents/MacOS/Fulcra');
 const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:path.join(run.root,'home'),USER:'fulcra-trial',TMPDIR:path.join(run.root,'tmp'),PASEO_HOME:path.join(run.root,'paseo'),PASEO_ELECTRON_USER_DATA_DIR:path.join(run.root,'user-data'),V4_PROOF_ROOT:run.root};
 const out=fs.openSync(path.join(run.root,'app.log'),'a',0o600);
 const child=spawn(binary,[`--inspect-brk=${debugPort}`,'--use-mock-keychain','--disable-gpu'],{cwd:run.root,env,detached:true,stdio:['ignore',out,out]});
 fs.closeSync(out);
 const identity=processIdentity(child.pid,binary);
 try{
  const endpoint=await until(async()=>{const rows=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();return rows[0]?.webSocketDebuggerUrl;});
  const socket=new WebSocket(endpoint),pending=new Map(),scripts=new Map();let seq=0,paused;
  const pause=new Promise(resolve=>paused=resolve);
  socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error('Inspector command failed')):p.resolve(m.result);}}else if(m.method==='Debugger.scriptParsed')scripts.set(m.params.scriptId,m.params.url);else if(m.method==='Debugger.paused')paused(m.params);});
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  try{
   await rpc('Debugger.enable');await rpc('Runtime.runIfWaitingForDebugger');
   const stop=await Promise.race([pause,delay(15000).then(()=>{throw Error('Initial pause absent');})]);
   const frame=stop.callFrames[0],location=frame.url||scripts.get(frame.location.scriptId)||'';
   if(!location.endsWith('/app.asar/dist/main.js'))throw Error('Refuse injection outside packaged main');
   const result=await rpc('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:`(()=>{process.argv=[process.argv[0]];require(${JSON.stringify(preload)});return 'isolated';})()`,returnByValue:true});
   if(result.exceptionDetails||result.result?.value!=='isolated')throw Error('Isolation injection failed');
   await rpc('Debugger.resume');
  }finally{socket.close();}
  const ready=await until(()=>JSON.parse(fs.readFileSync(path.join(run.root,'app-ready.json'))),30000);
  if(ready.pid!==child.pid||ready.packaged!==true||ready.resources!==path.join(run.app,'Contents/Resources'))throw Error('Wrong staged app ready receipt');
  fs.writeFileSync(path.join(run.root,'app-owner.json'),JSON.stringify(identity),{mode:0o600});child.unref();return ready;
 }catch(error){if(sameProcess(identity,processIdentity(child.pid,binary)))child.kill('SIGTERM');throw error;}
}
const [operation,...args]=process.argv.slice(2);
if(operation==='seal'){
 const [app,file]=args;if(!app||!file)throw Error('seal <app> <new-handoff.json>');
 write(file,{schema:1,kind:'fulcra-trial-adapter',bundle:sealBundle(app),adapter:adapterPins(),label:'Private HOME and fake Keychain; not isolated-account acceptance'});
}else if(operation==='prepare'){
 const [handoff,app,root,port]=args;const pin=JSON.parse(fs.readFileSync(handoff));
 if(pin.kind!=='fulcra-trial-adapter'||JSON.stringify(pin.adapter)!==JSON.stringify(adapterPins()))throw Error('Handoff adapter mismatch');
 verifyBundle(app,pin.bundle);await freePort(Number(port));
 const run={...createPrivateRun(root,Number(port)),app:fs.realpathSync(app),bundle:pin.bundle,adapter:pin.adapter};write(path.join(run.root,'run.json'),run);console.log(JSON.stringify({root:run.root,port:run.port}));
}else if(['start','command','inspect','stop','smoke'].includes(operation)){
 const run=load(args[0]);
 if(operation==='start')console.log(JSON.stringify(await start(run)));
 else if(operation==='command')console.log(wire.jsonReceipt(await command(run,args[1],JSON.parse(args[2]??'{}'))));
 else if(operation==='inspect'){
  const status=await command(run,'desktop_daemon_status');
  const lock=JSON.parse(fs.readFileSync(path.join(run.root,'paseo/command-centre/process.lock')));
  const controller=processIdentity(lock.pid,path.join(run.app,'Contents/Resources/bundled-plugins/orca-organization-next/controller.mjs'));
  const daemon=processIdentity(controller.ppid,path.join(run.app,'Contents/Frameworks/Fulcra Helper.app/Contents/MacOS/Fulcra Helper'));
  if(daemon.ppid!==status.pid)throw Error('Controller is not the owned daemon worker direct child');
  console.log(JSON.stringify({supervisor:status,daemon,controller,epoch:lock.epoch,readiness:await command(run,'probe',{auth:true})}));
 }
 else if(operation==='stop'){
  console.log(JSON.stringify(await stop(run)));
 }else{
  const receipt={schema:1,kind:run.kind,bundleSha256:run.bundle.sha256,passed:false,checks:[]};
  try{
   await start(run);await command(run,'patch_desktop_settings',{daemon:{commandCentreEnabled:true}});
   const health=await until(async()=>{const value=await command(run,'probe',{auth:true});return value.status==='observed'&&value;},190000);receipt.checks.push({name:'diagnostic-health',...health});
   const status=await command(run,'desktop_daemon_status');await command(run,'ui-navigate',{route:`/h/${status.serverId}/plugin/orca-organization-next/sidebar/organization`});
   await until(async()=>{const value=await command(run,'ui-state');return value.visible&&value.frames.some(f=>f.text.includes('Manage task'));},30000);
   const config=JSON.parse(fs.readFileSync(path.join(run.root,'paseo/command-centre/config.json')));
   const tasks=JSON.parse(fs.readFileSync(path.join(run.root,'paseo/command-centre/tasks.json')));
   if(!tasks.issues.some(t=>t.id===config.authority.programmeId))throw Error('Prepared synthetic programme task is required for the management UI smoke');
   await command(run,'ui-action',{text:'Manage task'});
   await command(run,'ui-action',{text:'Task UUID',value:config.authority.programmeId});
   await command(run,'ui-action',{text:'Open task by ID'});
   const state=await until(async()=>{const value=await command(run,'ui-state');return value.rendererRpc.some(r=>r.pluginId==='orca-organization-next'&&r.status==='observed'&&r.action==='health')&&value;},30000);
   const image=path.join(run.root,'evidence/command-centre.png');await command(run,'ui-capture',{file:image});
   receipt.window=state;receipt.screenshot={file:image,sha256:sha(fs.readFileSync(image)),humanInspected:false};
   const refusal=await command(run,'probe',{auth:false});receipt.checks.push(refusal);if(!refusal.passed)throw Error('Unauthenticated refusal not proven');
   if(!state.rendererRpc.some(r=>r.pluginId==='orca-organization-next'&&r.status==='observed'&&r.action==='health'))throw Error('Real renderer management not observed; diagnostic probe is insufficient');
   receipt.checks.push({name:'quit',...await command(run,'quit')});
   // Reopen the same owned background daemon to obtain the normal stop handlers.
   await start(run);receipt.cleanup=await stop(run);receipt.passed=true;
  }catch(error){
   receipt.error=error.message;process.exitCode=1;
   try{receipt.window=await command(run,'ui-state');const image=path.join(run.root,'evidence/failed-window.png');await command(run,'ui-capture',{file:image});receipt.screenshot={file:image,sha256:sha(fs.readFileSync(image)),humanInspected:false};}catch(captureError){receipt.captureError=captureError.message;}
  }
  finally{
   if(!receipt.passed){
    try{receipt.cleanup=await stop(run);}
    catch(error){receipt.cleanup='BLOCKED: '+error.message;}
   }
   write(path.join(run.root,'evidence/smoke.json'),receipt);
  }
  console.log(JSON.stringify({passed:receipt.passed,receipt:path.join(run.root,'evidence/smoke.json')}));
 }
}else throw Error('Commands: seal, prepare, start, command, inspect, stop, smoke. Read docs/install-upgrade-trial.md.');
