import {RemotePermissions} from './remote-permissions.mjs';
import { RemoteResumptions } from './remote-resumption.mjs';
import {artifactInput,validateArtifacts} from './artifacts.mjs';
import {validPageInput,validateActivityPage} from '../book/activity-page.mjs';
import { uuid } from './authority.mjs';
import { nativeNoDispatch } from './trusted-native-input.mjs';
import { randomUUID } from 'node:crypto';
import { canonical, bookProvider } from '../book/protocol.mjs';
import { validateBookActivity } from '../book/activity.mjs';
import { loadConfig } from '../config.mjs';
import { sessionDefaults } from './provider-mode.mjs';
// FD-1b: sessions carry the host names the Sessions fleet resolves from the portable config. The local host
// is localHost.name; a Book route takes the configured host entry it maps to (the one named 'macbook', or
// the only configured remote host). Legacy two-Mac installs name their hosts mini/macbook, so their labels
// are unchanged; without a readable config the legacy labels stay. The route table and the Book receiver
// protocol keep 'macbook' internally.
export function hostLabels(load = loadConfig) {
  let config;
  try { config = load(); } catch { return { local: 'mini', book: 'macbook' }; }
  const names = (config.hosts ?? []).map(h => h.name);
  return { local: config.localHost?.name || 'mini', book: names.includes('macbook') ? 'macbook' : names.length === 1 ? names[0] : 'macbook' };
}
// Cutover (A1): the live controller recorded a Book send refused before dispatch as 'refused' (message test); V4 records only a
// typed no-dispatch refusal as refused and everything else as 'uncertain'. The Book route keeps the live classification: its own
// fences and the Book receiver's verified reply say 'Orca native admission refused' (sends) or 'Orca native permission refused'
// (permission responses). Transport failures stay uncertain.
const bookRefusal = e => typeof e?.message === 'string' && /Orca native (admission|permission) refused/.test(e.message) ? nativeNoDispatch(e) : e;
// A native adapter for the ONE controller. This table is routing/transport state, not a budget.
// DESIGN-NEXT-BUILD A3: only values a role or an explicit override chose are forwarded to the Book (bare model ids).
export function bookRoleSelection(a) {
  const chosen = sessionDefaults(a.provider, a.defaults, undefined, a.role ?? null), out = {};
  if (['role', 'override'].includes(chosen.source.model) && chosen.model.includes('/')) out.model = chosen.model.slice(chosen.model.indexOf('/') + 1);
  if (['role', 'override'].includes(chosen.source.thinkingOptionId)) out.thinkingOptionId = chosen.thinkingOptionId;
  return out;
}
export class HostNative {
  control;
  constructor({ store, local, book, bookStatus = book ? { configured: true, status: 'Book configured' } : { configured: false, status: 'Book not configured' } }) {
    this.bookState=Object.freeze({ ...bookStatus });
    this.activityReads=new Map();
    this.store=store; this.db=store.db; this.local=local; this.book=book;
    this.db.exec(`CREATE TABLE IF NOT EXISTS host_routes(id TEXT PRIMARY KEY,request TEXT UNIQUE NOT NULL,host TEXT NOT NULL,creation TEXT NOT NULL,agent TEXT,cwd TEXT,phase TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 1,binding TEXT,error TEXT);`);
    this.resumptions = new RemoteResumptions(this);
    this.remotePermissions=new RemotePermissions(this);
    this.permission=(id,intent)=>this.route(id)?Promise.resolve().then(()=>this.remotePermissions.respond(id,intent)).catch(e=>{throw bookRefusal(e);}):local.permission(id,intent);
    // H7 item 5: a seat's answer to a pending question (questions.mjs). Local only: a Book session is answered on its host.
    this.answer=(id,intent,response)=>{ if(this.route(id))throw Error('A question on a remote (Book) session is answered on its own host'); if(typeof local.answer!=='function')throw Error('This native adapter cannot answer questions'); return local.answer(id,intent,response); };
    this.permissionResult=(id,callId,cursor,intent)=>this.route(id)?this.remotePermissions.result(id,intent):local.permissionResult(id,callId,cursor);
    this.subscribe=fn=>local.subscribe(fn); this.watch=()=>local.watch(); this.close=()=>local.close();
  }
  attach(control) { this.control=control;this.resumptions.restart();for(const r of this.db.prepare("SELECT * FROM host_routes WHERE phase IN ('delegating','human')").all()){const s=this.store.get(r.id);if(s?.mode==='delegated')control.takeover(r.id,'Controller restarted during remote delegation');else if(r.phase==='delegating' && s)this.beginRevoke(r.id,s.generation);} }
  bookStatus() { return this.bookState; }
  route(id) { return this.db.prepare('SELECT * FROM host_routes WHERE id=?').get(id); }
  quota(id) { return this.route(id) ? Promise.resolve(null) : this.local.quota?.(id) ?? Promise.resolve(null); }
  // C2 #5: only locally hosted sessions have workspaces on this host.
  nameWorkspaces(ids) { return typeof this.local.nameWorkspaces === 'function' ? this.local.nameWorkspaces(ids.filter(id => !this.route(id))) : Promise.resolve({ titled: 0, skipped: ids.length, failed: 0 }); }
  hostFeature(name) { return this.local.hostFeature?.(name) === true; }
  // Only a locally hosted session's timeline can prove human input (v1.13 R3-2); a remote one is refused.
  humanMessagesSince(id, since) { if (this.route(id) || typeof this.local.humanMessagesSince !== 'function') return Promise.reject(Error('Human input cannot be checked for this session')); return this.local.humanMessagesSince(id, since); }
  assertLocal(...ids) { if (ids.some(id=>typeof id==='string' && this.route(id))) throw Error('Book parent/supervisor grants are not supported'); }
  status(id) { const r=this.route(id); return r && { host:r.host,agentId:r.agent,state:r.phase,generation:r.generation,error:r.error,revocationAcknowledged:r.phase==='human' }; }
  project(row) { const labels=hostLabels(),remote=this.status(row.id),children=this.children(row.id).filter(r=>r.phase==='revoking'); return remote ? {...row,host:labels.book,provider:bookProvider(JSON.parse(this.route(row.id).creation)),remote,mode:['revoking','delegating','resuming'].includes(remote.state)?remote.state:row.mode} : {...row,host:labels.local,...(children.length?{mode:row.mode==='human'?'revoking':row.mode,remoteWorkers:children,revocationAcknowledged:false}:{})}; }
  // One snapshot for list: preserve project()'s routing and child-revocation semantics without N+1 reads.
  projectAll(rows) {
    const labels = hostLabels();
    const routes = new Map(this.db.prepare('SELECT * FROM host_routes ORDER BY id').all().map(r => [r.id, r]));
    const children = new Map();
    if (this.db.prepare("SELECT name FROM sqlite_master WHERE name='manager_workers'").get()) {
      const links = this.db.prepare(`SELECT DISTINCT supervisor,worker FROM (
        SELECT supervisor,worker FROM event_links UNION SELECT supervisor,worker FROM manager_workers WHERE phase!='attached'
      ) ORDER BY supervisor,worker`).all();
      for (const link of links) {
        const r = routes.get(link.worker);
        if (r?.phase !== 'revoking') continue;
        const group = children.get(link.supervisor) ?? [];
        group.push(Object.assign(Object.create(null), { id: r.id, phase: r.phase, generation: r.generation }));
        children.set(link.supervisor, group);
      }
    }
    return rows.map(row => {
      const r = routes.get(row.id), pending = children.get(row.id) ?? [];
      if (!r) return { ...row, host: labels.local, ...(pending.length ? { mode: row.mode === 'human' ? 'revoking' : row.mode, remoteWorkers: pending, revocationAcknowledged: false } : {}) };
      const remote = { host: r.host, agentId: r.agent, state: r.phase, generation: r.generation, error: r.error, revocationAcknowledged: r.phase === 'human' };
      return { ...row, host: labels.book, provider: bookProvider(JSON.parse(r.creation)), remote, mode: ['revoking', 'delegating', 'resuming'].includes(remote.state) ? remote.state : row.mode };
    });
  }
  async call(action,input) { if(!this.book)throw Error('Book receiver transport is not configured');return this.book(action,input); }
  // Update-7 W3: checked where the session will run. The Book checks its own provider when it creates.
  async checkOverride(a) {
    const labels = hostLabels();
    if (!a.host || a.host==='mini' || a.host===labels.local) return this.local.checkOverride?.(a);
  }
  async checkProvider(provider, host) {
    const labels = hostLabels();
    if (!host || host==='mini' || host===labels.local) return this.local.checkProvider?.(provider);
  }
  async create(a, options) {
    // Configured names are accepted alongside the legacy mini/macbook values; a Book creation is recorded as 'macbook'.
    const labels = hostLabels();
    if (a.host && a.host !== 'macbook' && a.host === labels.book) a = { ...a, host: 'macbook' };
    if (!a.host || a.host==='mini' || a.host===labels.local) return this.local.create(a,options);
    if(a.host!=='macbook'||!['codex','claude'].includes(a.provider))throw Error('Only new Book Claude or Codex sessions are supported');
    if(!this.book)throw Error('Book receiver transport is not configured');
    let r=this.db.prepare('SELECT * FROM host_routes WHERE request=?').get(a.messageId);
    const creation=canonical(a);
    if(r && r.creation!==creation)throw Error('Host creation identity conflict');
    if(!r){if(this.db.prepare('SELECT count(*) n FROM host_routes').get().n>=1000)throw Error('Host routing capacity');const id=randomUUID();this.db.prepare("INSERT INTO host_routes(id,request,host,creation,phase) VALUES (?,?,'macbook',?,'creating')").run(id,a.messageId,creation);r=this.route(id);}
    // DESIGN-NEXT-BUILD A3: the role's (or an explicit) model / effort, resolved with the same selector as a local create,
    // is forwarded; the Book checks it against its own provider. Nothing is forwarded otherwise, so the Book body is
    // exactly as before. A Book released before this refuses the extra fields before recording anything; the creation is
    // then made as before and the result says the role defaults did not apply there.
    const base={sessionId:r.id,messageId:a.messageId,taskId:a.taskId,title:a.title,...(a.provider==='claude'?{provider:'claude'}:{})}, selection=bookRoleSelection(a);
    let result, olderBook=false;
    if(Object.keys(selection).length){try{result=await this.call('create',{...base,...selection});}catch(e){if(e?.message!=='Invalid receiver creation')throw e;olderBook=true;result=await this.call('create',base);}}
    else result=await this.call('create',base);
    if(!uuid(result.agentId)||typeof result.cwd!=='string'||!result.cwd.startsWith('/' )||result.id!==r.id || result.host!==r.host || (r.agent && (r.agent!==result.agentId || r.cwd!==result.cwd)))throw Error('Book creation route changed');
    this.db.prepare("UPDATE host_routes SET agent=?,cwd=?,phase=CASE WHEN phase='creating' THEN 'human' ELSE phase END WHERE id=?").run(result.agentId,result.cwd,r.id);
    return {id:r.id,cwd:result.cwd,...(result.selection?{selection:result.selection}:{}),...(olderBook?{selection:{fallback:[{field:'selection',requested:selection,used:null,reason:'book-predates-role-defaults'}]}}:{})}; // No manager capability or implicit delegation.
  }
  async verifyNew(id, request, task) {
    const r=this.route(id);if(!r)return this.local.verifyNew(id,request,task);
    const a=JSON.parse(r.creation),o=await this.inspect(id),s=this.store.get(id);
    if(r.request!==request || a.taskId!==task || r.phase!=='human' || r.generation!==1 || s?.task!==task || s.mode!=='human' || s.generation!==1 || o.lastPromptId!==null || o.humanAt!==0 || o.pending || o.archivedAt || !['idle','closed'].includes(o.status))throw Error('New Book worker was touched or creation identity changed');
  }
  children(id) {
    if(!this.db.prepare("SELECT name FROM sqlite_master WHERE name='manager_workers'").get())return [];
    return this.db.prepare(`SELECT DISTINCT r.id,r.phase,r.generation FROM host_routes r WHERE r.id IN
      (SELECT worker FROM event_links WHERE supervisor=? UNION SELECT worker FROM manager_workers WHERE supervisor=? AND phase!='attached')`).all(id,id);
  }
  revokeChildren(id, generation) {
    for(const r of this.children(id)) {
      const child=this.store.get(r.id),link=this.db.prepare('SELECT * FROM event_links WHERE worker=?').get(r.id);
      const owned=this.db.prepare('SELECT w.*,g.generation AS parentGeneration,g.epoch AS activeEpoch FROM manager_workers w JOIN manager_grants g ON g.supervisor=w.supervisor WHERE w.worker=? AND w.supervisor=?').get(r.id,id);
      const linked=link?.supervisor===id && link.supervisorGeneration===generation && link.workerGeneration===child?.generation;
      const creating=owned?.parentGeneration===generation && owned.epoch===owned.activeEpoch && owned.phase!=='attached' && (owned.generation===child?.generation || owned.phase==='created' && child?.generation===2);
      if(child?.mode==='delegated' && (linked || creating)) {
        const grant=this.store.transferRows(child.id,'human','Parent control revoked; acknowledge remote worker revocation');
        this.beginRevoke(child.id,grant.generation);
      }
    }
  }
  ready(id) { if(this.children(id).some(r=>r.phase==='revoking'))throw Error('Remote worker revocation unresolved');const r=this.route(id);if(r && !['human','active'].includes(r.phase))throw Error('Remote control transition unresolved: '+r.phase); }
  async delegate(id,row,current) {
    if(!this.route(id))return;
    const binding={boot:current.boot,boundary:row.grantedAt,nativeId:current.nativeId??null,lastPromptId:current.lastPromptId};
    this.db.prepare("UPDATE host_routes SET phase='delegating',generation=?,binding=?,error=NULL WHERE id=?").run(row.generation,canonical(binding),id);
    try {
      const reply=await this.call('delegate',{sessionId:id,generation:row.generation,binding}), route=this.route(id), fresh=this.store.get(id);
      if(reply.state!=='delegated'||reply.sessionId!==id||reply.generation!==row.generation||canonical(reply.binding)!==canonical(binding)||route.phase!=='delegating'||route.generation!==row.generation||fresh.mode!=='delegated'||fresh.generation!==row.generation)throw Error('Remote delegation superseded');
      this.db.prepare("UPDATE host_routes SET phase='active' WHERE id=?").run(id);
    } catch(e){this.db.prepare("UPDATE host_routes SET error=? WHERE id=? AND generation=? AND phase='delegating'").run(e.message,id,row.generation);throw e;}
  }
  beginRevoke(id,generation) { if(this.route(id))this.db.prepare("UPDATE host_routes SET phase='revoking',generation=?,binding=NULL,error=NULL WHERE id=?").run(generation,id); }
  async revoke(id) {
    const r=this.route(id);if(!r || r.phase!=='revoking')return this.status(id);
    try {
      const reply=await this.call('revoke',{sessionId:id,generation:r.generation});
      if(reply.state!=='revoked'||reply.sessionId!==id||reply.generation!==r.generation)throw Error('Remote revocation acknowledgement mismatch');
      this.db.prepare("UPDATE host_routes SET phase='human',error=NULL WHERE id=? AND generation=? AND phase='revoking'").run(id,r.generation);
      return {...this.status(id),admitted:reply.admitted,interruptionConfirmed:false};
    }catch(e){this.db.prepare("UPDATE host_routes SET error=? WHERE id=? AND generation=? AND phase='revoking'").run(e.message.slice(0,2000),id,r.generation);return this.status(id);}
  }
  reconcile() { return this.reconciling ??= Promise.allSettled(this.db.prepare("SELECT id FROM host_routes WHERE phase='revoking' LIMIT 32").all().map(r=>this.revoke(r.id))).finally(()=>{this.reconciling=null;}); }
  // DESIGN-NEXT-BUILD A4 (C10): capability is checked on this host's provider.
  async roleCapability(provider, role) { return typeof this.local.roleCapability === 'function' ? this.local.roleCapability(provider, role) : null; }
  async inspect(id) {
    const r=this.route(id);if(!r)return this.local.inspect(id);
    const o=await this.call('inspect',{sessionId:id});
    if(o.id!==id||o.agentId!==r.agent||o.cwd!==r.cwd||o.provider!==bookProvider(JSON.parse(r.creation)))throw Error('Remote observation route changed');
    return o;
  }
  async artifacts(a) {
    artifactInput(a);
    const s=this.store.get(a.sessionId),r=this.route(a.sessionId);
    if(!s || s.task!==a.taskId || s.generation!==a.expectedGeneration || !['human','delegated'].includes(s.mode) || !r || !['human','active'].includes(r.phase) || r.generation!==s.generation)throw Error('Book artifact ownership changed');
    const result=await this.call('artifacts',a),fresh=this.store.get(s.id);
    if(!result || Object.keys(result).sort().join()!=='accepted,agentId,artifacts,generation,host,observedAt,sessionId,taskId' || result.accepted!==false || result.host!=='macbook' || result.sessionId!==s.id || result.taskId!==s.task || result.generation!==s.generation || result.agentId!==r.agent || !fresh || fresh.generation!==s.generation || fresh.mode!==s.mode || fresh.task!==s.task || canonical(this.route(s.id))!==canonical(r))throw Error('Book artifact route changed during read');
    const age=Date.now()-Date.parse(result.observedAt);if(!Number.isFinite(age) || age < -5000 || age > 45000)throw Error('Book artifact observation stale');
    return {...result,artifacts:validateArtifacts(result.artifacts,r.cwd)};
  }
  activityPage(a) { return this.activity(a,true); }
  activity(a,paging=false) {
    if (paging ? !validPageInput(a) : !a || Object.keys(a).sort().join() !== 'sessionId,taskId' || !uuid(a.sessionId) || !uuid(a.taskId)) return Promise.reject(Error('Invalid activity request'));
    const s=this.store.get(a.sessionId),r=this.route(a.sessionId),key=JSON.stringify([paging,a,s?.generation,s?.mode,r?.agent,r?.generation,r?.phase]);
    if(this.activityReads.has(key))return this.activityReads.get(key);const pending=this.readActivity(a,paging);this.activityReads.set(key,pending);const clear=()=>this.activityReads.delete(key);pending.then(clear,clear);return pending;
  }
  async readActivity(a,paging=false) {
    if (paging ? !validPageInput(a) : !a || Object.keys(a).sort().join() !== 'sessionId,taskId' || !uuid(a.sessionId) || !uuid(a.taskId)) throw Error('Invalid activity request');
    const s=this.store.get(a.sessionId), r=this.route(a.sessionId);
    if (!s || s.task !== a.taskId || !r || !['human','active'].includes(r.phase)) throw Error('Owned Book activity unavailable');
    const result=(paging?validateActivityPage:validateBookActivity)(await this.call(paging?'activity-page':'activity',a),r.cwd,a.includeMessages===true), fresh=this.store.get(s.id);
    if (result.sessionId !== s.id || result.taskId !== s.task || result.agentId !== r.agent || !fresh || fresh.task !== s.task || fresh.generation !== s.generation || fresh.mode !== s.mode || canonical(this.route(s.id)) !== canonical(r)) throw Error('Book activity route changed during read');
    const age=Date.now()-Date.parse(result.observedAt); if(age < -5000 || age > 45000) throw Error('Book activity observation is stale');
    return result;
  }
  async snapshot(id) {if(!this.route(id))return this.local.snapshot(id);const o=await this.inspect(id);if(!Array.isArray(o.pendingPermissions) || o.pendingPermissions.length!==o.pending)throw Error('Book supervision snapshot requires current receiver');return {id,provider:o.provider,currentModeId:o.currentModeId??null,cwd:o.cwd,status:o.status,pendingPermissions:o.pendingPermissions,lastUserMessageAt:o.lastUserAt,activeTurn:o.activeTurn,attentionTimestamp:o.attentionTimestamp,attentionReason:o.attentionReason,lastError:o.lastError,labels:{owner:'orca-book-task',task:o.task},runtimeInfo:{provider:o.provider,sessionId:o.nativeId}};}
  async send(id,text,messageId,nativeAttemptId) {
    if(!this.route(id))return this.local.send(id,text,messageId,nativeAttemptId);
    try { return await this.remoteSend(id,text,messageId); } catch (e) { throw bookRefusal(e); }
  }
  async remoteSend(id,text,messageId) {
    const record=this.store.delivery(messageId)?.result;
    // 935772bf moved the role-channel binding out of `supervision` -- the field the native guard reads as
    // MANAGER supervisor authority -- into its own `channel`. This module was not updated with it, so both
    // branches below became unreachable for a channel and a remote send kept only the generic session
    // checks, losing the entire coordinator-boundary re-derivation. Latent rather than live: every current
    // host_route is phase 'human', so r.phase!=='active' refuses first.
    const supervision=record?.supervision, channel=record?.channel;
    // A role channel names its originator fromSession; a manager binding names it supervisor. Either way the
    // originator's own native input must not have changed since it asked for this dispatch.
    const parent=supervision?.supervisor ?? channel?.fromSession;
    if(parent){if(!this.control)throw Error('Orca native admission refused: coordinator not attached');const seen=await this.control.inspect(parent),owner=this.store.get(parent);if(!seen.observed || seen.observed.boot!==owner?.boot || seen.observed.humanAt>=owner.grantedAt)throw Error('Orca native admission refused: native parent input changed');}
    const r=this.route(id),s=this.store.get(id),d=this.store.delivery(messageId),body=d&&JSON.parse(d.body),proof=d?.result?.outputContext;
    if(r.phase!=='active'||r.generation!==s.generation||s.mode!=='delegated'||d?.state!=='intent'||d.session!==id||body.text!==text||!proof)throw Error('Orca native admission refused: changed remote authority');
    if(channel?.channelId) {
      // Role channel admission, re-derived here at the coordinator boundary exactly as the manager binding is.
      const b=channel;
      const c=this.db.prepare("SELECT * FROM role_channels WHERE id=? AND state='open'").get(b.channelId);
      const m=this.db.prepare('SELECT * FROM role_channel_messages WHERE messageId=?').get(messageId);
      const from=this.store.get(b.fromSession),credential=this.db.prepare('SELECT * FROM role_credentials WHERE session=?').get(b.fromSession);
      const seat=(role,name)=>this.db.prepare('SELECT * FROM role_bindings WHERE role=? AND seat=?').get(role,name);
      const prime=c&&seat('prime',c.primeSeat),project=c&&seat('project-orchestrator',c.projectSeat);
      const toPrime=c&&c.primeSession===id;
      if(!c||!m||m.channel!==b.channelId||m.toSession!==id||m.fromSession!==b.fromSession||!['reserved','pending','queued'].includes(m.state)||m.toGeneration!==s.generation
        ||Date.parse(c.expiresAt)<=Date.now()||c.used>c.maxMessages
        ||(toPrime?c.projectSession!==b.fromSession:(c.projectSession!==id||c.primeSession!==b.fromSession))
        ||prime?.session!==c.primeSession||prime.revision!==c.primeRevision
        ||project?.session!==c.projectSession||project.revision!==c.projectRevision
        // The originator must still hold a seat and a current capability, and must itself be locally hosted:
        // a routed originator cannot have reached this controller to ask for the send.
        ||this.route(b.fromSession)||from?.mode!=='delegated'||credential?.generation!==from.generation
        ||!this.db.prepare('SELECT role FROM role_bindings WHERE session=?').get(b.fromSession))throw Error('Orca native admission refused: changed remote role channel authority');
    } else if(d.result.supervision) {
      const b=d.result.supervision,parent=this.store.get(b.supervisor),g=this.db.prepare('SELECT * FROM manager_grants WHERE supervisor=?').get(b.supervisor);
      const l=this.db.prepare('SELECT * FROM event_links WHERE worker=?').get(id),w=this.db.prepare('SELECT * FROM manager_workers WHERE worker=?').get(id);
      if(this.route(b.supervisor) || parent?.mode!=='delegated' || parent.generation!==b.generation || parent.task!==s.task || parent.authority!==s.authority || g?.generation!==parent.generation || g.epoch!==b.epoch || l?.supervisor!==parent.id || l.epoch!==b.linkEpoch || l.supervisorGeneration!==parent.generation || l.workerGeneration!==s.generation || w?.supervisor!==parent.id || w.epoch!==g.epoch || w.phase!=='attached' || w.generation!==s.generation || this.db.prepare('SELECT worker FROM event_faults WHERE worker=?').get(id))throw Error('Orca native admission refused: changed remote parent authority');
    }
    // Dispatch is the coordinator admission boundary. Remote takeover is complete
    // only after receiver acknowledgement; an already admitted turn may continue.
    const payload={sessionId:id,messageId,text,generation:s.generation,binding:JSON.parse(r.binding),expectedLastUserAt:d.result.expectedLastUserAt,expectedNativeId:proof.nativeId,cursor:proof.cursor};
    const result=await this.call('send',payload);
    if(result.id!==messageId||result.session!==id||result.body!==canonical(payload))throw Error('Remote send receipt identity mismatch');
    if(result.state==='refused')throw Error('Orca native admission refused: '+result.error);
    if(result.state!=='acknowledged')throw Error('Remote delivery uncertain; no replay');
  }
  // H6 item 5: local sessions only. A Book (remote) session's MCP servers belong to its own host; nothing here reaches them.
  async refreshTools(id,messageId) { if(this.route(id))throw Error('Tool surfaces of a remote (Book) session are refreshed on its own host'); if(typeof this.local.refreshTools!=='function')throw Error('This native adapter cannot refresh tool surfaces'); return this.local.refreshTools(id,messageId); }
  // H6 item 6: local sessions only; a Book session's usage limits belong to its own host.
  async recover(id) { if(this.route(id))throw Error('A remote (Book) session is restarted on its own host'); if(typeof this.local.recover!=='function')throw Error('This native adapter cannot restart a session'); return this.local.recover(id); }
  async limitTail(id) { if(this.route(id)||typeof this.local.limitTail!=='function')return null; return this.local.limitTail(id); }
  async receipt(id,messageId,text) { return this.route(id)?this.call('receipt',{sessionId:id,messageId,text}):this.local.receipt(id,messageId,text); }
  async completion(id,messageId,progress) {return this.route(id)?this.call('completion',{sessionId:id,messageId,progress}):this.local.completion(id,messageId,progress);}
}
