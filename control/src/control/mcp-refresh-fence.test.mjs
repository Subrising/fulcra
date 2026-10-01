// Focused private evidence: real compiled lifecycle + real guard, instrumented provider only.
// 13 tests. Twelve run against any compiled server dist; the thirteenth patches one and therefore needs a
// PRISTINE, never-patched tree. On a box where every compiled server has already been patched -- which is
// what a deployed admission tree is -- that one cannot run. It is a red line with a known cause, not an
// opaque environment gate, and the other twelve are real coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {ControlStore} from './store.mjs';
import {BOOT,guard,mcpRefreshAdmissionInStore} from './admission-guard.mjs';
import {journal} from '../book/journal.mjs';
import {createReceiverGuard} from '../book/receiver-guard.mjs';
import {initializeBookPermissions} from '../book/permissions.mjs';
import {canonical} from '../book/protocol.mjs';
import {patchBookMcpRefreshAdmission} from '../book/stage.mjs';
import {CLAUDE_QUERY_MODULE,patchNativeHooks} from './native-release-hooks.mjs';

const source = process.env.ORCA_MCP_TEST_NATIVE;
assert(source && path.isAbsolute(source), [
  'Set ORCA_MCP_TEST_NATIVE to a PRISTINE compiled server dist -- unpatched, not merely isolated.',
  'Anything under admission/ has already been patched and will fail the hook test with',
  '"Native release hook input missing or already patched".',
  'Point it at the whole dist: the server reaches above dist/server/server.',
  'Its dependencies are hoisted to the workspace root, not packages/server/node_modules.',
].join(' '));
const { requireUnpinnedAdmissionGuard } = await import('./admission-guard-precondition.mjs');
requireUnpinnedAdmissionGuard(); // Fails loudly when the working guard is pinned; see that module.
const {AgentManager} = await import(pathToFileURL(path.join(source,'agent/agent-manager.js')).href);
function temporary(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'orca-mcp-fence-')));
  fs.chmodSync(root,0o700); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;
}
function nativeFixture(admission, mutate = ()=>{}) {
  const id=randomUUID(),cwd='/private/owned-test',nativeId=randomUUID();let closes=0,resumes=0;
  const session={capabilities:{supportsMcpServers:true,supportsSessionPersistence:true},close:async()=>{closes++;throw Error('Instrumented provider stops at close');}};
  const agent={id,cwd,provider:'codex',config:{provider:'codex',cwd,mcpServers:{memory:{type:'stdio',command:'memory-v1'}}},persistence:{provider:'codex',sessionId:nativeId,metadata:{cwd}},session,lifecycle:'idle',activeTurnId:null,pendingPermissions:new Map(),inFlightPermissionResponses:new Map(),labels:{},lastUserMessageAt:null};
  const manager=Object.assign(Object.create(AgentManager.prototype),{
    agents:new Map([[id,agent]]),mcpRefreshAdmission:admission,mcpRuntimeRevisions:new WeakMap(),mcpRevisionKey:'private-test',failedMcpRefreshCloses:new WeakSet(),mcpRefreshes:new Set(),foregroundMutationTails:new Map(),paseoToolPolicies:new Map(),reloadedSessionCloses:new WeakMap(),rescueTimeouts:{reloadSessionCloseMs:1000},
    providerSubagents:{list:()=>[]},hasInFlightRun:()=>false,assertAcceptingAgentRegistrations(){},emitState(){},logger:{warn(){}},
    trackAgentRegistrationOperation:p=>p,runLifecycleMutation:(_id,fn)=>fn(),
    requireClient:()=>({resumeSession:async()=>{resumes++;throw Error('No provider resume is allowed in this test');}}),
    applyDaemonAppendSystemPrompt:x=>x,resolveProviderLaunchConfig:x=>x,drainSessionEvents:async()=>{},
    buildLaunchContext:async()=>{mutate();await Promise.resolve();return{};},
  });
  return {agent,manager,count:()=>({closes,resumes}),async request(){const s=await manager.getAgentMcpRefreshState(id);return{agentId:id,expected:{provider:s.provider,sessionId:s.sessionId,configRevision:s.configRevision},changes:{},reconnect:true};}};
}
function mini(t, mutation) {
  const root=temporary(t),store=new ControlStore(root+'/journal.sqlite'),db=store.db;t.after(()=>store.close());
  db.exec(`CREATE TABLE event_links(worker TEXT PRIMARY KEY,supervisor TEXT,epoch TEXT,workerGeneration INTEGER,supervisorGeneration INTEGER);
    CREATE TABLE manager_workers(worker TEXT PRIMARY KEY,supervisor TEXT,epoch TEXT,generation INTEGER,phase TEXT);
    CREATE TABLE manager_grants(supervisor TEXT PRIMARY KEY,generation INTEGER,epoch TEXT,maxWorkers INTEGER);
    CREATE TABLE permission_grants(session TEXT PRIMARY KEY,generation INTEGER,epoch TEXT,rootSession TEXT,rootEpoch TEXT,revoked INTEGER,reason TEXT);`);
  let f;f=nativeFixture(a=>mcpRefreshAdmissionInStore(db,a),()=>mutation({db,agent:f.agent,parent}));
  const parent=randomUUID();
  for(const [id,cwd] of [[f.agent.id,f.agent.cwd],[parent,'/private/parent']])db.prepare('INSERT INTO sessions (id,task,cwd,mode,generation,authority,boot,grantedAt) VALUES (?,?,?,\'delegated\',2,?,?,1)').run(id,'task',cwd,'authority',BOOT);
  db.prepare("INSERT INTO manager_grants VALUES (?,2,'manager-epoch',3)").run(parent);
  db.prepare("INSERT INTO manager_workers VALUES (?,?,'manager-epoch',2,'attached')").run(f.agent.id,parent);
  db.prepare("INSERT INTO event_links VALUES (?,?,'link-epoch',2,2)").run(f.agent.id,parent);
  return {...f,db};
}
const miniChanges={
  'stale generation':({db,agent})=>db.prepare('UPDATE sessions SET generation=3 WHERE id=?').run(agent.id),
  'revoked manager grant':({db,parent})=>db.prepare('DELETE FROM manager_grants WHERE supervisor=?').run(parent),
  'changed manager grant epoch':({db,parent})=>db.prepare("UPDATE manager_grants SET epoch='replacement' WHERE supervisor=?").run(parent),
  'changed worker link epoch':({db,agent})=>db.prepare("UPDATE event_links SET epoch='replacement' WHERE worker=?").run(agent.id),
  'human target input':({agent})=>guard(agent,'',undefined,false),
  'human supervisor takeover':({parent})=>guard({id:parent},'',undefined,false),
  'human control mode':({db,agent})=>db.prepare("UPDATE sessions SET mode='human' WHERE id=?").run(agent.id),
};
for(const [name,mutation] of Object.entries(miniChanges))test('Mini refresh refuses '+name+' before provider close',async t=>{
  const f=mini(t,mutation),request=await f.request(),before=JSON.stringify(f.agent.config);
  assert.equal(mcpRefreshAdmissionInStore(f.db,f.agent).allowed,true);
  const result=await f.manager.refreshAgentMcp(request);
  assert.equal(result.outcome,'refused');assert.equal(result.reason,'stale');
  assert.deepEqual(f.count(),{closes:0,resumes:0});assert.equal(JSON.stringify(f.agent.config),before);
  assert.equal(f.manager.agents.get(f.agent.id),f.agent);
});
test('stable Mini authority reaches close, with no async gap after final validation',async t=>{
  const f=mini(t,()=>{}),request=await f.request();let reads=0,checked=false;
  const original=f.manager.mcpRefreshAdmission;
  f.manager.mcpRefreshAdmission=agent=>{const value=original(agent);if(++reads===2)queueMicrotask(()=>{assert.equal(f.count().closes,1);checked=true;});return value;};
  assert.equal((await f.manager.refreshAgentMcp(request)).reason,'close_failed');
  assert.equal(checked,true);assert.deepEqual(f.count(),{closes:1,resumes:0});
});
for(const change of ['generation','human mode','human input'])test('Book refresh refuses '+change+' before provider close',async t=>{
  const root=temporary(t),file=root+'/receiver.sqlite',db=journal(file);initializeBookPermissions(db);t.after(()=>db.close());
  const input=createReceiverGuard(file,'private-release'),route=randomUUID();
  let f;f=nativeFixture(input.mcpRefreshAdmission,()=>{
    if(change==='human input')input.guard(f.agent,'',undefined,false);
    else db.prepare(change==='generation'?'UPDATE receiver_sessions SET generation=3 WHERE id=?':"UPDATE receiver_sessions SET mode='human',binding=NULL WHERE id=?").run(route);
  });
  f.agent.labels={owner:'orca-book-task',task:'task','orca.route':route};
  const binding={boot:input.boot,boundary:1,lastPromptId:null,nativeId:f.agent.persistence.sessionId};
  db.prepare("INSERT INTO receiver_sessions VALUES (?,?,?,'{}',?,?,'created',2,'delegated',?,?)").run(route,randomUUID(),'task',f.agent.id,f.agent.cwd,canonical(binding),f.agent.persistence.sessionId);
  const request=await f.request();assert.equal(input.mcpRefreshAdmission(f.agent).allowed,true);
  const result=await f.manager.refreshAgentMcp(request);
  assert.equal(result.outcome,'refused');assert.equal(result.reason,'stale');assert.deepEqual(f.count(),{closes:0,resumes:0});
  const fresh=await f.request();
  if(change!=='generation'){assert.equal((await f.manager.refreshAgentMcp(fresh)).outcome,'refused');assert.deepEqual(f.count(),{closes:0,resumes:0});}
});
test('guard read failure refuses before close rather than admitting unmanaged fallback',async()=>{
  const f=nativeFixture(()=>{throw Error('Private authority unavailable');});
  assert.equal((await f.manager.refreshAgentMcp(await f.request())).outcome,'refused');
  assert.deepEqual(f.count(),{closes:0,resumes:0});
});
test('Mini and Book staging require the ownership hook when refresh RPC exists',()=>{
  const names=['agent/agent-manager.js','agent/agent-prompt.js','session.js','agent/lifecycle-command.js',CLAUDE_QUERY_MODULE];
  const sources=Object.fromEntries(names.map(n=>[n,fs.readFileSync(path.join(source,n),'utf8')]));
  // patchNativeHooks refuses any source already containing orcaAdmissionGuard or orcaPermissionGuard. If
  // this throws 'input missing or already patched', ORCA_MCP_TEST_NATIVE names a tree that has already been
  // patched rather than a pristine one -- a fact about the deployment, not a defect here.
  //
  // Deliberately NOT softened into a skip. That single error covers TWO conditions, a missing input and an
  // already-patched one, so it cannot prove which occurred; and a skip keyed on the guard markers instead
  // would also swallow a tree patched by something other than this code. On a file whose whole subject is
  // fences that must not silently stop applying, an honest red beats a green nobody re-examines.
  const patched=patchNativeHooks(sources,'/private/test-guard.mjs');
  assert.match(patched['agent/agent-manager.js'],/this.mcpRefreshAdmission = orcaMcpRefreshAdmission;/);
  assert.match(patchBookMcpRefreshAdmission(sources['agent/agent-manager.js']),/this.mcpRefreshAdmission = orcaBookMcpRefreshAdmission;/);
  const drift=sources['agent/agent-manager.js'].replace('this.mcpRefreshAdmission = options.mcpRefreshAdmission;','this.mcpRefreshAdmission = undefined;');
  assert.throws(()=>patchNativeHooks({...sources,'agent/agent-manager.js':drift},'/private/test-guard.mjs'),/anchor/);
  // A build that still ASSIGNS mcpRefreshAdmission but exposes no refreshAgentMcp is a renamed symbol, not
  // an absent feature: patching used to report success with the refresh fence silently not applied. The
  // two states are distinguishable, so this one is refused. Unreachable from either dist on this machine,
  // which is why it is constructed here.
  const renamed=sources['agent/agent-manager.js'].replaceAll('refreshAgentMcp(','refreshAgentMcpRenamed_(');
  assert.match(renamed,/this\.mcpRefreshAdmission = options\.mcpRefreshAdmission;/);
  assert.throws(()=>patchNativeHooks({...sources,'agent/agent-manager.js':renamed},'/private/test-guard.mjs'),/exposes no refreshAgentMcp/);
  assert.throws(()=>patchBookMcpRefreshAdmission(drift),/anchor/);
});
