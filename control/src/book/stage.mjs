import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const sha=x=>createHash('sha256').update(x).digest('hex');
function once(text,before,after){if(text.split(before).length!==2)throw Error('Book native patch anchor drift: '+before.slice(0,70));return text.replace(before,after);}
export function patchBookMcpRefreshAdmission(text) {
  if(!text.includes('refreshAgentMcp('))return text; // Older native builds cannot expose this operation.
  const bound='        this.mcpRefreshAdmission = orcaBookMcpRefreshAdmission;';
  if(text.includes(bound))return once(text,bound,bound);
  return once(text,'        this.mcpRefreshAdmission = options.mcpRefreshAdmission;',bound);
}
export function patchBookPermissionAcknowledgement(text) {
  const accepted='            await respondToAgentPermission({\n                agentManager: this.agentManager,\n                agentId,\n                requestId,\n                response,\n                logger: this.sessionLogger,\n            });';
  const ack='\n            if (requestId.startsWith("orca-permission:")) this.emit({ type: "agent_permission_resolved", payload: { agentId, requestId, resolution: response } });';
  once(text,accepted,accepted);
  const count=text.split(ack).length-1;
  if(count>1)throw Error('Book permission acknowledgement duplicated');
  return count===1?once(text,accepted+ack,accepted+ack):once(text,accepted,accepted+ack);
}
export function patchBookModules(files,entry) {
  const out={...files,'session.js':patchBookPermissionAcknowledgement(files['session.js'])},add=(name,before,after)=>{out[name]=once(out[name],before,after);};
  add('session.js','    async interruptAgentIfRunning(agentId) {','    async interruptAgentIfRunning(agentId) {\n        orcaBookGuard({id:agentId},"",undefined,false);');
  const fetch='        const agent = await this.getAgentPayloadById(resolved.agentId);\n        if (!agent) {';
  add('session.js',fetch,'        const agent = await this.getAgentPayloadById(resolved.agentId);\n        if (agent) agent.labels = {...agent.labels, "orca.native-barrier": JSON.stringify(orcaBookObservation(resolved.agentId))};\n        if (!agent) {');
  add('agent/lifecycle-command.js','export async function cancelAgentRunCommand(dependencies, agentId) {','export async function cancelAgentRunCommand(dependencies, agentId) {\n    orcaBookGuard({id:agentId},"",undefined,false);');
  const manager='agent/agent-manager.js';
  for(const [anchor,id] of [['    async archiveSnapshot(agentId, archivedAt) {','agentId'],['    closeAgent(agentId) {','agentId'],['    async archiveAgent(agentId) {','agentId'],['    async cancelAgentRun(agentId) {','agentId']])add(manager,anchor,anchor+`\n        orcaBookGuard({id:${id}},"",undefined,false);`);
  const final='        const { agent, agentId, pendingRun, prompt, options } = params;\n        try {\n            const result = await agent.session.startTurn(prompt, options);';
  add(manager,final,'        const { agent, agentId, pendingRun, prompt, options } = params;\n        try {\n            orcaBookGuard(agent,prompt,options,pendingRun.settled || Boolean(agent.activeForegroundTurnId),true);\n        } catch(error) {\n            pendingRun.start={status:"failed",error:error.message};\n            this.emitState(agent);\n            this.runs.settleForegroundRun(agentId,pendingRun.token);\n            throw error;\n        }\n        try {\n            const result = await agent.session.startTurn(prompt, options);');
  for(const [anchor,agent] of [['    streamAgent(agentId, prompt, options) {\n        const existingAgent = this.requireSessionAgent(agentId);','existingAgent'],['    async replaceAgentRun(agentId, prompt, options) {\n        const snapshot = this.requireAgent(agentId);','snapshot'],['    async steerOrReplaceActiveTurn(agentId, prompt, options) {\n        const agent = this.requireSessionAgent(agentId);','agent']])add(manager,anchor,anchor+`\n        orcaBookGuard(${agent},prompt,options,this.hasInFlightRun(agentId));`);
  const permission='    async respondToPermission(agentId, requestId, response) {\n        const agent = this.requireAgent(agentId);';
  add(manager,permission,permission+'\n        requestId = orcaBookPermissionGuard(agent,requestId,response);');
  out[manager]=patchBookMcpRefreshAdmission(out[manager]);
  const prompt='agent/agent-prompt.js',start='export async function startAgentRun(agentManager, agentId, prompt, logger, options) {\n    const snapshot = agentManager.getAgent(agentId);';
  add(prompt,start,start+'\n    orcaBookGuard(snapshot,prompt,options?.runOptions,agentManager.hasInFlightRun(agentId));');
  const send='export async function sendPromptToAgent(params) {';
  add(prompt,send,send+'\n    if (!params.messageId?.startsWith("orca-control:")) orcaBookGuard({id:params.agentId},"",undefined,false);');
  const archived='    const record = await params.agentStorage.get(params.agentId);\n    if (record?.archivedAt) {';
  add(prompt,archived,'    const record = await params.agentStorage.get(params.agentId);\n    if (record?.archivedAt && params.messageId?.startsWith("orca-control:")) throw Error("Orca native admission refused archived Book session");\n    if (record?.archivedAt) {');
  for(const name of Object.keys(out))out[name]=`import {guard as orcaBookGuard,observation as orcaBookObservation,permissionGuard as orcaBookPermissionGuard,mcpRefreshAdmission as orcaBookMcpRefreshAdmission} from ${JSON.stringify(entry)};\n`+out[name];
  return out;
}
function tree(base,overrides={}) {
  const rows=[];function walk(relative){for(const n of fs.readdirSync(path.join(base,relative)).sort()){const r=path.join(relative,n),p=path.join(base,r),s=fs.lstatSync(p);if(s.isDirectory())walk(r);else if(s.isSymbolicLink())rows.push([r,'link',fs.readlinkSync(p)]);else if(s.isFile())rows.push([r,'file',sha(overrides[r]??fs.readFileSync(p))]);else throw Error('Unsupported dependency file');}}walk('');return sha(JSON.stringify(rows));
}
function upgradeBookModules(files,entry,previousStage,profileFile,runtimeFile,runtime) {
  if(typeof previousStage!=='string'||!path.isAbsolute(previousStage)||fs.realpathSync(previousStage)!==previousStage)throw Error('Previous Book stage must be canonical');
  const m=JSON.parse(fs.readFileSync(path.join(previousStage,'manifest.json'),'utf8'));
  if(m.runtimeFile!==runtimeFile||m.installation!==runtime.installation||m.runtimeHome!==runtime.home||m.prefix!=='@getpaseo/server/dist/server/server/'||m.tree?.after!==runtime.installedTree||sha(fs.readFileSync(runtimeFile))!==m.runtimeHashes?.after||sha(fs.readFileSync(profileFile))!==m.profileHash)throw Error('Previous Book release/profile/runtime changed');
  const verify=(relative,expected)=>{
    const file=path.join(previousStage,relative);
    if(!/^[a-zA-Z0-9_./-]+$/.test(relative)||relative.split('/').some(p=>!p||p==='.'||p==='..')||fs.realpathSync(file)!==file||!fs.statSync(file).isFile()||sha(fs.readFileSync(file))!==expected)throw Error('Previous Book bundle changed');
  };
  if(!m.hashes||!Object.keys(m.hashes).length)throw Error('Previous Book bundle manifest missing');
  for(const [file,h]of Object.entries(m.hashes))verify('bundle/'+file,h);
  verify('bundle/src/book/guard-entry.mjs',m.guardHash);
  const oldEntry=path.join(previousStage,'bundle/src/book/guard-entry.mjs'),header=`import {guard as orcaBookGuard,observation as orcaBookObservation} from ${JSON.stringify(oldEntry)};`;
  return Object.fromEntries(Object.entries(files).map(([name,before])=>{
    const permissionHeader=header.replace('} from',',permissionGuard as orcaBookPermissionGuard} from');
    const refreshHeader=permissionHeader.replace('} from',',mcpRefreshAdmission as orcaBookMcpRefreshAdmission} from');
    if(sha(before)!==m.records?.[name]?.after||![header,permissionHeader,refreshHeader].includes(before.split('\n')[0])||before.split(JSON.stringify(oldEntry)).length!==2)throw Error('Previous Book native guard changed: '+name);
    let after=before.replace(JSON.stringify(oldEntry),JSON.stringify(entry));
    if(before.split('\n')[0]===header){
      after=once(after,'observation as orcaBookObservation}', 'observation as orcaBookObservation,permissionGuard as orcaBookPermissionGuard}');
      if(name==='agent/agent-manager.js')after=once(after,'        if (requestId.startsWith("orca-permission:")) throw Error("Book automated permissions unsupported");\n        orcaBookGuard(agent,"",undefined,false);','        requestId = orcaBookPermissionGuard(agent,requestId,response);');
    }
    if(name==='session.js')after=patchBookPermissionAcknowledgement(after);
    if(!after.split('\n')[0].includes('mcpRefreshAdmission as orcaBookMcpRefreshAdmission'))after=once(after,'permissionGuard as orcaBookPermissionGuard}', 'permissionGuard as orcaBookPermissionGuard,mcpRefreshAdmission as orcaBookMcpRefreshAdmission}');
    if(name==='agent/agent-manager.js')after=patchBookMcpRefreshAdmission(after);
    return [name,after];
  }));
}
export function stage(profileFile,directory,previousStage) {
  const p=JSON.parse(fs.readFileSync(profileFile,'utf8')),runtimeFile=p.runtimeSource+'/config/runtime.macbook.json',runtime=JSON.parse(fs.readFileSync(runtimeFile,'utf8'));
  if(!path.isAbsolute(directory)||fs.existsSync(directory)||directory.startsWith(runtime.installation+'/')||fs.realpathSync(path.dirname(directory))!==path.dirname(directory))throw Error('Use a new absolute immutable staging directory');
  if(tree(runtime.installation+'/node_modules')!==runtime.installedTree)throw Error('Book dependency tree changed before staging');
  const source=fileURLToPath(new URL('../../',import.meta.url)),modules=['protocol','journal','receiver-guard','receiver','native','transport','receiver-cli','activity','activity-page','artifacts','permissions','permission-rpc'].map(n=>'src/book/'+n+'.mjs').concat(['native-fence','native-identity','authority','receipt','completion','artifacts','worker-artifacts','permission-projection','automatic-permission','permission-policy','permission-result','permission-channel'].map(n=>'src/control/'+n+'.mjs'),['orca-organization/shared/history.mjs','orca-organization/shared/work-messages.mjs','src/control/worker-artifacts.py','src/portable-config.mjs','src/config.mjs','orca-organization/server/config.mjs']);
  const hashes=Object.fromEntries(modules.map(f=>[f,sha(fs.readFileSync(path.join(source,f)))])),release=sha(JSON.stringify({hashes,journal:p.journal,controller:p.controller}));
  const entry=path.join(directory,'bundle/src/book/guard-entry.mjs'),prefix='@getpaseo/server/dist/server/server/',names=['session.js','agent/lifecycle-command.js','agent/agent-manager.js','agent/agent-prompt.js'];
  const before=Object.fromEntries(names.map(n=>[n,fs.readFileSync(path.join(runtime.installation,'node_modules',prefix,n),'utf8')]));
  const after=previousStage===undefined?patchBookModules(before,entry):upgradeBookModules(before,entry,previousStage,profileFile,runtimeFile,runtime),records={};
  fs.mkdirSync(directory,{mode:0o700});
  for(const f of modules){const dest=path.join(directory,'bundle',f);fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});fs.copyFileSync(path.join(source,f),dest);fs.chmodSync(dest,0o400);}
  fs.writeFileSync(entry,`import {createReceiverGuard} from './receiver-guard.mjs';\nimport {createBookPermissionGuard} from './permissions.mjs';\nconst input=createReceiverGuard(${JSON.stringify(p.journal)},${JSON.stringify(release)});\nexport const {guard,observation,mcpRefreshAdmission}=input;\nexport const permissionGuard=createBookPermissionGuard(${JSON.stringify(p.journal)},${JSON.stringify(p.tasks)},input);\n`,{mode:0o400});
  for(const name of names){records[name]={before:sha(before[name]),after:sha(after[name])};for(const side of ['before','after']){const file=path.join(directory,side,name);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,side==='before'?before[name]:after[name],{mode:0o400});if(side==='after')execFileSync(process.execPath,['--check',file]);}}
  const next={...runtime,installedTree:tree(runtime.installation+'/node_modules',Object.fromEntries(names.map(n=>[prefix+n,after[n]])))};
  fs.writeFileSync(path.join(directory,'runtime.before.json'),fs.readFileSync(runtimeFile),{mode:0o400});fs.writeFileSync(path.join(directory,'runtime.after.json'),JSON.stringify(next,null,2)+'\n',{mode:0o400});
  fs.writeFileSync(path.join(directory,'receiver-profile.json'),JSON.stringify({...p,release},null,2)+'\n',{mode:0o600});
  const manifest={runtimeFile,runtimeHome:runtime.home,installation:runtime.installation,prefix,records,release,hashes,tree:{before:runtime.installedTree,after:next.installedTree},guardHash:sha(fs.readFileSync(entry)),profileHash:sha(fs.readFileSync(path.join(directory,'receiver-profile.json'))),runtimeHashes:{before:sha(fs.readFileSync(runtimeFile)),after:sha(fs.readFileSync(path.join(directory,'runtime.after.json')))}};
  fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o400});return manifest;
}
export function apply(directory,side) {
  if(!['before','after'].includes(side))throw Error('Expected before/after');
  const m=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  try{const listeners=execFileSync('/usr/sbin/lsof',['-nP','-iTCP:6791','-sTCP:LISTEN','-t'],{encoding:'utf8'}).trim();if(listeners)throw Error('Stop only the owned Book provider before applying');}catch(e){if(e.status!==1)throw e;}
  const pidFile=path.join(m.runtimeHome,'paseo.pid');
  if(fs.existsSync(pidFile)){const {pid}=JSON.parse(fs.readFileSync(pidFile,'utf8'));if(!Number.isSafeInteger(pid)||pid<1)throw Error('Invalid owned provider PID');try{process.kill(pid,0);throw Error('Owned Book provider supervisor still running');}catch(e){if(e.code!=='ESRCH')throw e;}}
  for(const [f,h] of Object.entries(m.hashes))if(sha(fs.readFileSync(path.join(directory,'bundle',f)))!==h)throw Error('Reviewed receiver bundle changed');
  if(sha(fs.readFileSync(path.join(directory,'bundle/src/book/guard-entry.mjs')))!==m.guardHash||sha(fs.readFileSync(path.join(directory,'receiver-profile.json')))!==m.profileHash)throw Error('Reviewed receiver entry/profile changed');
  const expected=tree(m.installation+'/node_modules');if(!Object.values(m.tree).includes(expected))throw Error('Dependency tree drift; manual reconciliation required');
  const writes=Object.keys(m.records).map(n=>({target:path.join(m.installation,'node_modules',m.prefix,n),source:path.join(directory,side,n),hash:m.records[n][side],allowed:Object.values(m.records[n])}));
  writes.push({target:m.runtimeFile,source:path.join(directory,'runtime.'+side+'.json'),hash:m.runtimeHashes[side],allowed:Object.values(m.runtimeHashes)});
  for(const w of writes)if(sha(fs.readFileSync(w.source))!==w.hash||!w.allowed.includes(sha(fs.readFileSync(w.target))))throw Error('Staged/current bytes changed');
  // Root-owned stopped maintenance. A mid-write crash is explicit partial state, never auto-replayed.
  for(const w of writes){const tmp=w.target+'.orca-book-stage';fs.writeFileSync(tmp,fs.readFileSync(w.source),{flag:'wx',mode:fs.statSync(w.target).mode&0o777,flush:true});fs.renameSync(tmp,w.target);}
  if(tree(m.installation+'/node_modules')!==m.tree[side])throw Error('Installed tree verification failed');return {side,release:m.release,tree:m.tree[side]};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{console.log(JSON.stringify(process.argv[2]==='apply'?apply(process.argv[3],process.argv[4]):stage(process.argv[2],process.argv[3]),null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
