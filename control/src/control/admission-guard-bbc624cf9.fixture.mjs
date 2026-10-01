import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const HOME = '/Volumes/test-volume/openclaw/projects/orca-control-runtime-20260912';
const FILE = HOME + '/journal.sqlite';
export const BOOT = randomUUID();
const humanInput = new Map();
const permissionResponses = new Set();
let saturated = false;
export function observation(id) { return { boot: BOOT, fenceProtocol: 'orca-input-sequence-v1', humanAt: humanInput.get(id) ?? 0, saturated }; }
// Import-time receipt exists only for the deployed module; an unwritable receipt disables automation, never the daemon.
if (import.meta.url.startsWith('file://' + HOME + '/admission/')) {
  try {
    const active = JSON.parse(fs.readFileSync(HOME + '/admission/active.json', 'utf8'));
    const receipt = { boot: BOOT, pid: process.pid, processStart: execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim(), loadedAt: new Date().toISOString(), guard: createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex'), modules: Object.fromEntries(Object.keys(active.after).map(name => [name, createHash('sha256').update(fs.readFileSync(active.base + name)).digest('hex')])) };
    fs.writeFileSync(HOME + '/admission/loaded-' + process.pid + '.tmp', JSON.stringify(receipt), { mode: 0o600 });
    fs.renameSync(HOME + '/admission/loaded-' + process.pid + '.tmp', HOME + '/admission/loaded-' + process.pid + '.json');
  } catch { /* Controller refuses without a matching live receipt. Human sessions remain available. */ }
}
// An operator-approved role channel carries bounded traffic between two seated roles. Approval is not
// admission: the controller recorded this channel before the native round trip, so every fact is re-derived
// here from the journal. This confers no exemption from any other fence in admit() -- it only adds one.
const hasChannelTables = get => Boolean(get("SELECT name FROM sqlite_master WHERE type='table' AND name='role_channel_messages'"));
function roleChannelAdmitted(get, session, delivery, body, c) {
  // A journal with no role tables has no channels, so a declared one cannot be re-derived and must refuse.
  if (!c || typeof c.channelId !== 'string' || !hasChannelTables(get)) return false;
  const m = get('SELECT * FROM role_channel_messages WHERE messageId=?', delivery.id);
  // 'reserved' is the first attempt, 'pending' a re-offer after a busy recipient, 'queued' a send parked
  // awaiting quota and later replayed. A 'delivered' or 'failed' row may never admit again.
  if (!m || !['reserved', 'pending', 'queued'].includes(m.state)) return false;
  const row = get('SELECT * FROM role_channels WHERE id=?', m.channel);
  if (!row || row.state !== 'open' || !(Date.parse(row.expiresAt) > Date.now()) || row.used > row.maxMessages) return false;
  // The message must run along this channel's own approved pair, in exactly one of its two orientations.
  const toProject = m.fromSeat === row.primeSeat && m.toSeat === row.projectSeat;
  const toPrime = m.fromSeat === row.projectSeat && m.toSeat === row.primeSeat;
  if (toProject === toPrime) return false;
  const side = which => which === 'prime'
    ? { role: 'prime', seat: row.primeSeat, revision: row.primeRevision, session: row.primeSession }
    : { role: 'project-orchestrator', seat: row.projectSeat, revision: row.projectRevision, session: row.projectSession };
  const from = side(toProject ? 'prime' : 'project'), to = side(toProject ? 'project' : 'prime');
  // Both seats must still hold the exact binding the operator approved. A re-seat bumps the revision.
  for (const seat of [from, to]) {
    const b = get('SELECT role,seat,session,revision,state FROM role_bindings WHERE role=? AND seat=?', seat.role, seat.seat);
    if (!b || b.state !== 'assigned' || b.revision !== seat.revision || b.session !== seat.session) return false;
  }
  // The same facts assertOriginator establishes controller-side: the sender is still seated, still delegated,
  // and still holds a capability at its current generation. A taken-over sender cannot deliver.
  const originator = get('SELECT id,mode,generation FROM sessions WHERE id=?', m.fromSession);
  const credential = get('SELECT generation FROM role_credentials WHERE session=?', m.fromSession);
  if (!originator || originator.mode !== 'delegated' || !credential || credential.generation !== originator.generation) return false;
  if (!get('SELECT role FROM role_bindings WHERE session=?', m.fromSession)) return false;
  return m.channel === c.channelId && m.fromSeat === c.fromSeat && m.toSeat === c.toSeat && m.fromSession === c.fromSession
    && (m.inReplyTo ?? null) === (c.inReplyTo ?? null) && m.fromSession === from.session && m.toSession === to.session
    && m.toSession === session.id && m.toGeneration === session.generation
    && m.text === body.text && body.messageId === delivery.id && body.sessionId === session.id;
}
// The journal is authoritative for source revocation even after the controller sent
// the RPC. Keep this synchronous with the native input fence, in one read snapshot.
function queuedSource(store, agent, session, delivery, intent, body) {
  if (!intent.wait) return;
  const b = intent.wait.binding, source = b?.source;
  const get = (sql, ...args) => store.prepare(sql).get(...args);
  const require = value => { if (!value) throw Error('Orca native admission refused changed queued source or configuration'); };
  const live = row => row && row.mode === 'delegated' && row.boot === BOOT && row.grantedAt === (humanInput.get(row.id) ?? 0) + 1;
  const tier = agent.features?.some(f => f.type === 'toggle' && f.id === 'fast_mode' && f.value === true) ? 'fast' : null;
  require(intent.wait.state === 'admitted' && b && source && live(session) && b.boot === BOOT && b.generation === session.generation && b.task === session.task && b.authority === session.authority && b.expected === session.expected && b.expectedAt === session.expectedAt);
  require(body.sessionId === session.id && body.messageId === delivery.id && b.quota?.provider === 'codex' && agent.provider === 'codex' && b.nativeId === b.quota.sessionId && b.nativeId === (agent.runtimeInfo?.sessionId ?? agent.persistence?.sessionId) && b.quota.model === (agent.runtimeInfo?.model ?? agent.config?.model ?? agent.model) && b.quota.serviceTier === tier);
  if (source.kind === 'direct') return;
  if (['ingress', 'notification'].includes(source.kind)) {
    require(/^[a-f0-9]{64}$/.test(source.originHash));
    for (const table of ['manager_workers', 'event_links']) require(!get(`SELECT worker FROM ${table} WHERE worker=?`, session.id));
    require(!get("SELECT id FROM management_requests WHERE json_extract(body,'$.sessionId')=? AND json_extract(body,'$.expectedGeneration')=? AND json_extract(body,'$.originHash') IS NOT NULL AND json_extract(body,'$.originHash')!=? LIMIT 1", session.id, session.generation, source.originHash));
    require(!get("SELECT id FROM deliveries WHERE session=? AND json_extract(result,'$.outputContext.generation')=? AND json_extract(result,'$.outputContext.originHash') IS NOT NULL AND json_extract(result,'$.outputContext.originHash')!=? LIMIT 1", session.id, session.generation, source.originHash));
  }
  if (source.kind === 'ingress') {
    const prepared = get('SELECT body FROM management_requests WHERE id=?', source.preparation), input = prepared && JSON.parse(prepared.body);
    require(source.preparation === delivery.id && input?.sessionId === session.id && input.expectedGeneration === b.generation && input.originHash === source.originHash && input.text === body.text);
  } else if (source.kind === 'notification') {
    const parent = get('SELECT * FROM deliveries WHERE id=?', source.parentMessageId), result = parent && JSON.parse(parent.result), n = result?.notification, proof = result?.outputContext;
    require(parent?.session === session.id && parent.state === 'delivered' && parent.id === b.expected && n?.id === source.notificationId && n.originHash === source.originHash && n.generation === b.generation && n.readAt && !n.consumedAt && n.followup?.messageId === delivery.id && n.followup.text === body.text && proof?.originHash === source.originHash && proof.generation === b.generation && proof.nativeId === b.nativeId && proof.boot === b.boot);
  } else if (source.kind === 'manager') {
    // admit() below validates the role, link, worker and live parent input fence.
    const p = intent.supervision, parent = get('SELECT * FROM sessions WHERE id=?', source.supervisor);
    require(parent?.authority === session.authority);
    require(p?.supervisor === source.supervisor && p.generation === source.generation && p.epoch === source.epoch && p.linkEpoch === source.linkEpoch);
  } else if (source.kind === 'event') {
    const event = get('SELECT * FROM event_inbox WHERE id=?', source.eventId), link = get('SELECT * FROM event_links WHERE worker=?', source.worker), worker = get('SELECT * FROM sessions WHERE id=?', source.worker);
    require(source.eventId === delivery.id && event?.supervisor === session.id && event.worker === source.worker && event.epoch === source.epoch && !event.consumed && event.state === 'queued' && link?.epoch === source.epoch && link.supervisor === session.id && link.workerGeneration === worker?.generation && link.supervisorGeneration === session.generation && live(worker) && worker.task === session.task && worker.authority === session.authority && !get('SELECT worker FROM event_faults WHERE worker=?', source.worker));
  } else if (source.kind === 'leadership') {
    const handoff = get('SELECT * FROM leadership_handoffs WHERE id=?', source.handoffId);
    require(handoff?.destination === session.id && handoff.wakeId === delivery.id && handoff.generation === b.generation && handoff.boot === b.boot && handoff.grantedAt === session.grantedAt && handoff.state === 'pending' && !handoff.consumed);
  } else if (source.kind === 'role-channel') {
    require(roleChannelAdmitted(get, session, delivery, body, source));
  } else require(false);
}
export function admit(store, agent, prompt, messageId, busy) {
  const session = store.prepare('SELECT * FROM sessions WHERE id=?').get(agent.id);
  const delivery = messageId ? store.prepare('SELECT * FROM deliveries WHERE id=?').get(messageId) : null;
  if (!session || delivery?.kind !== 'send') throw new Error('Orca native admission refused unenrolled intent');
  const intent = JSON.parse(delivery.result ?? '{}'), body = JSON.parse(delivery.body);
  queuedSource(store, agent, session, delivery, intent, body);
  // A declared channel must verify, and an undeclared one must not exist: without the second half, a channel
  // message could be sent through any other path and never meet the re-derivation above.
  const get = (sql, ...args) => store.prepare(sql).get(...args);
  const channelRow = hasChannelTables(get) ? get('SELECT messageId FROM role_channel_messages WHERE messageId=?', delivery.id) : null;
  if (Boolean(channelRow) !== Boolean(intent.channel)) throw Error('Orca native admission refused mismatched role channel declaration');
  if (intent.channel && !roleChannelAdmitted(get, session, delivery, body, intent.channel)) throw Error('Orca native admission refused changed role channel approval');
  if (intent.supervision) {
    const parent = intent.supervision, supervisor = store.prepare('SELECT * FROM sessions WHERE id=?').get(parent.supervisor);
    const grant = store.prepare('SELECT * FROM manager_grants WHERE supervisor=?').get(parent.supervisor);
    const link = store.prepare('SELECT * FROM event_links WHERE worker=?').get(agent.id);
    const owned = store.prepare('SELECT * FROM manager_workers WHERE worker=?').get(agent.id);
    if (!supervisor || supervisor.mode !== 'delegated' || supervisor.generation !== parent.generation || supervisor.task !== session.task || supervisor.boot !== BOOT || supervisor.grantedAt !== (humanInput.get(supervisor.id) ?? 0) + 1 || grant?.epoch !== parent.epoch || grant.generation !== parent.generation || link?.epoch !== parent.linkEpoch || link.supervisor !== supervisor.id || link.supervisorGeneration !== parent.generation || link.workerGeneration !== session.generation || owned?.supervisor !== supervisor.id || owned.epoch !== parent.epoch || owned.phase !== 'attached' || owned.generation !== session.generation) throw Error('Orca native admission refused changed supervisor authority');
  }
  const digest = createHash('sha256').update(typeof prompt === 'string' ? prompt : JSON.stringify(prompt)).digest('hex');
  if (saturated || session.boot !== BOOT || session.grantedAt !== (humanInput.get(agent.id) ?? 0) + 1 || delivery.session !== agent.id || delivery.state !== 'intent' || session.mode !== 'delegated' || session.generation !== intent.generation || digest !== createHash('sha256').update(body.text).digest('hex') || busy || (agent.pendingPermissions?.size ?? agent.pendingPermissions?.length ?? 0) > 0 || (agent.lastUserMessageAt?.toISOString() ?? null) !== intent.expectedLastUserAt) throw new Error('Orca native admission refused stale, busy or changed session');
  return true;
}
export function guard(agent, prompt, options, busy) {
  const controlled = options?.clientMessageId?.startsWith('orca-control:') ?? false;
  if (!controlled) {
    if (agent) {
      const next = (humanInput.get(agent.id) ?? 0) + 1;
      if ((humanInput.size >= 10000 && !humanInput.has(agent.id)) || next >= Number.MAX_SAFE_INTEGER) saturated = true;
      else humanInput.set(agent.id, next);
    }
    return; // Human input has no filesystem or journal dependency and cannot be refused by this guard.
  }
  if (!agent) throw new Error('Orca native admission refused missing session');
  let db;
  try {
    db = new DatabaseSync(FILE, { readOnly: true });
    db.exec('PRAGMA busy_timeout=50; BEGIN');
    admit(db, agent, prompt, options.clientMessageId.slice(13), busy);
  } catch (e) { throw new Error('Orca native admission refused: ' + e.message, { cause: e }); }
  finally { db?.close(); }
}
// Read-only lifecycle authority. The native manager binds this digest into its
// expected revision and reads it again synchronously at the actual close boundary.
// This does not create an intent, grant control, or count as human/model input.
export function mcpRefreshAdmissionInStore(db, agent) {
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const sessionFields = 'id,task,cwd,mode,generation,expected,authority,expectedAt,boot,grantedAt';
  const session = get(`SELECT ${sessionFields} FROM sessions WHERE id=?`, agent.id);
  const live = row => row && row.mode === 'delegated' && row.boot === BOOT && row.grantedAt === (humanInput.get(row.id) ?? 0) + 1;
  const link = get('SELECT worker,supervisor,epoch,workerGeneration,supervisorGeneration FROM event_links WHERE worker=?', agent.id);
  const owned = get('SELECT supervisor,epoch,worker,generation,phase FROM manager_workers WHERE worker=?', agent.id);
  const parent = link && get(`SELECT ${sessionFields} FROM sessions WHERE id=?`, link.supervisor);
  const grant = link && get('SELECT supervisor,generation,epoch,maxWorkers FROM manager_grants WHERE supervisor=?', link.supervisor);
  const ownGrant = get('SELECT supervisor,generation,epoch,maxWorkers FROM manager_grants WHERE supervisor=?', agent.id);
  const permissions = get('SELECT * FROM permission_grants WHERE session=?', agent.id);
  const permissionRoot = permissions && get('SELECT * FROM permission_grants WHERE session=?', permissions.rootSession);
  const pending = db.prepare("SELECT id,kind,state FROM deliveries WHERE session=? AND state IN ('intent','uncertain','reserved','queued') ORDER BY id").all(agent.id);
  const management = !link && !owned || Boolean(link && owned && live(parent) && parent.task === session?.task && parent.authority === session?.authority && grant?.generation === parent.generation && link.supervisorGeneration === parent.generation && link.workerGeneration === session?.generation && owned.supervisor === parent.id && owned.epoch === grant.epoch && owned.generation === session?.generation && owned.phase === 'attached');
  const allowed = Boolean(!saturated && live(session) && session.cwd === agent.cwd && management && !pending.length && (!ownGrant || ownGrant.generation === session.generation));
  const state = {session,link,owned,parent,grant,ownGrant,permissions,permissionRoot,pending,input:observation(agent.id),parentInput:parent && observation(parent.id),allowed};
  return {revision:createHash('sha256').update(JSON.stringify(state)).digest('hex'),allowed};
}
export function mcpRefreshAdmission(agent) {
  let db;
  try {
    db = new DatabaseSync(FILE, {readOnly:true}); db.exec('PRAGMA busy_timeout=0; BEGIN');
    return mcpRefreshAdmissionInStore(db,agent);
  } finally { db?.close(); }
}
const canonicalPermission = x => JSON.stringify(orderPermission(x));
function orderPermission(x) { return Array.isArray(x) ? x.map(orderPermission) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, orderPermission(x[k])])) : x; }
const permissionDigest = x => createHash('sha256').update(canonicalPermission(x)).digest('hex');
// Match the pinned Paseo agent-projections.js representation, including omitted empty metadata.
export function permissionProjection(request) {
  const json = value => {
    if (value == null) return value;
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(json).filter(v => v !== undefined);
    if (typeof value === 'object') { const result = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, json(v)]).filter(([, v]) => v !== undefined)); return Object.keys(result).length ? result : undefined; }
    return ['string', 'number', 'boolean'].includes(typeof value) ? value : undefined;
  };
  const metadata = value => { const v = json(value); return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined; };
  const suggestions = Array.isArray(request.suggestions) ? request.suggestions.map(metadata).filter(v => v !== undefined) : [];
  return { ...request, input: metadata(request.input), metadata: metadata(request.metadata), suggestions: suggestions.length ? suggestions : undefined, actions: request.actions?.map(a => ({ ...a })) };
}
export function admitPermission(db, agent, intentId, response, used = permissionResponses) {
  const row = db.prepare('SELECT * FROM permission_intents WHERE id=?').get(intentId);
  if (!row || row.state !== 'intent' || row.session !== agent.id) throw Error('Unknown or consumed permission intent');
  const body = JSON.parse(row.body), session = db.prepare('SELECT * FROM sessions WHERE id=?').get(agent.id);
  const live = s => s && s.mode === 'delegated' && s.boot === BOOT && s.grantedAt === (humanInput.get(s.id) ?? 0) + 1;
  const grant = db.prepare('SELECT * FROM permission_grants WHERE session=?').get(agent.id);
  const root = grant && db.prepare('SELECT * FROM permission_grants WHERE session=?').get(grant.rootSession);
  const rootSession = root && db.prepare('SELECT * FROM sessions WHERE id=?').get(root.session);
  const request = agent.pendingPermissions?.get(body.requestId), key = agent.id + ':' + body.requestId;
  if (saturated || !live(session) || !live(rootSession) || session.generation !== body.generation || body.boot !== BOOT || session.expected !== body.origin || session.authority !== body.authority || (agent.lastUserMessageAt?.toISOString() ?? null) !== body.expectedLastUserAt || !grant || grant.revoked || grant.generation !== session.generation || grant.epoch !== body.grantEpoch || !root || root.revoked || root.epoch !== grant.rootEpoch || root.epoch !== row.pool || root.generation !== rootSession.generation || root.rootSession !== root.session || root.rootEpoch !== root.epoch) throw Error('Changed permission authority');
  const delivery = db.prepare("SELECT * FROM deliveries WHERE id=? AND session=? AND kind='send' AND state='delivered'").get(body.origin, agent.id);
  if (!delivery || used.has(key) || used.size >= 10000 || agent.inFlightPermissionResponses?.has(body.requestId) || !request || request.provider !== 'claude' || request.kind !== 'tool' || !['Write', 'Edit'].includes(request.name) || permissionDigest(permissionProjection(request)) !== body.requestDigest || canonicalPermission(response) !== '{"behavior":"allow"}' || permissionDigest(request.input) !== body.proof.inputHash || request.input.file_path !== body.proof.file || body.proof.root !== session.cwd || !body.proof.file.startsWith(session.cwd + '/') || db.prepare("SELECT count(*) n FROM permission_intents WHERE pool=? AND state!='escalated'").get(row.pool).n > 100) throw Error('Changed, duplicate or out-of-policy native permission');
  const link = db.prepare('SELECT * FROM event_links WHERE worker=?').get(agent.id);
  if (link) {
    const parent = db.prepare('SELECT * FROM sessions WHERE id=?').get(link.supervisor), manager = db.prepare('SELECT * FROM manager_grants WHERE supervisor=?').get(link.supervisor), owned = db.prepare('SELECT * FROM manager_workers WHERE worker=?').get(agent.id), b = body.supervision;
    if (!b || !live(parent) || parent.task !== session.task || parent.generation !== link.supervisorGeneration || session.generation !== link.workerGeneration || link.epoch !== b.linkEpoch || link.supervisor !== b.supervisor || manager?.epoch !== b.managerEpoch || manager.generation !== parent.generation || owned?.supervisor !== parent.id || owned.epoch !== manager.epoch || owned.generation !== session.generation || owned.phase !== 'attached' || (grant.rootSession !== grant.session && grant.rootSession !== parent.id)) throw Error('Changed parent permission authority');
  } else if (body.supervision || grant.rootSession !== grant.session) throw Error('Permission ownership link missing');
  used.add(key); // Linearization: no await or journal write before the provider receives this response.
  return body.requestId;
}
export function permissionGuard(agent, requestId, response) {
  if (typeof requestId !== 'string' || !requestId.startsWith('orca-permission:')) { guard(agent, '', undefined, false); return requestId; }
  let db;
  try {
    db = new DatabaseSync(FILE, { readOnly: true }); db.exec('PRAGMA busy_timeout=0');
    return admitPermission(db, agent, requestId.slice(16), response);
  } catch (e) { throw Error('Orca native permission refused: ' + e.message, { cause: e }); }
  finally { db?.close(); }
}
