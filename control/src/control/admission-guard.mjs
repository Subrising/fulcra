import { automaticPermissionProof, permissionMode } from './automatic-permission.mjs';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const HOME = process.env.ORCA_ADMISSION_HOME ?? '/path/to/unconfigured/controller';
const FILE = HOME + '/journal.sqlite';
export const BOOT = randomUUID();
const humanInput = new Map();
const permissionResponses = new Set();
let saturated = false;
export function observation(id) { return { boot: BOOT, fenceProtocol: 'orca-input-sequence-v1', humanAt: humanInput.get(id) ?? 0, saturated }; }
// Every boot that loads ANY Orca guard, old or new, leaves admission/loaded-<pid>.json naming its BOOT. The
// boot ids present BEFORE this boot writes its own receipt go into its human-log header (review F1): a
// receipt-bearing boot that does not appear in the predecessor's own snapshot ran between the two, so the
// chain is incomplete and the sweep declines. null means the set could not be read in full.
function receiptBoots() {
  try {
    const boots = [];
    for (const name of fs.readdirSync(HOME + '/admission')) {
      if (!/^loaded-[0-9]+\.json$/.test(name)) continue;
      const stat = fs.lstatSync(HOME + '/admission/' + name);
      if (!stat.isFile() || stat.size > 65536) return null;
      const boot = JSON.parse(fs.readFileSync(HOME + '/admission/' + name, 'utf8'))?.boot;
      if (typeof boot !== 'string' || !/^[0-9a-f-]{36}$/.test(boot)) return null;
      boots.push(boot);
    }
    return [...new Set(boots)].sort();
  } catch { return null; }
}
const DEPLOYED = import.meta.url.startsWith('file://' + HOME + '/admission/');
const PRIOR_RECEIPTS = DEPLOYED ? receiptBoots() : null;
// Import-time receipt exists only for the deployed module; an unwritable receipt disables automation, never the daemon.
if (DEPLOYED) {
  try {
    const active = JSON.parse(fs.readFileSync(HOME + '/admission/active.json', 'utf8'));
    const receipt = { boot: BOOT, pid: process.pid, processStart: execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim(), loadedAt: new Date().toISOString(), guard: createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex'), modules: Object.fromEntries(Object.keys(active.after).map(name => [name, createHash('sha256').update(fs.readFileSync(active.base + name)).digest('hex')])) };
    fs.writeFileSync(HOME + '/admission/loaded-' + process.pid + '.tmp', JSON.stringify(receipt), { mode: 0o600 });
    fs.renameSync(HOME + '/admission/loaded-' + process.pid + '.tmp', HOME + '/admission/loaded-' + process.pid + '.json');
  } catch { /* Controller refuses without a matching live receipt. Human sessions remain available. */ }
}
// Durable human-input log (STAGE2-DESIGN.md s2). humanInput above resets at every boot, so on its own it
// carries no revocation evidence across a restart; an interrupt leaves no user_message either. Each boot
// therefore appends one line per human input to human/<BOOT>.log, fsync'd BEFORE guard() returns, i.e.
// before the input takes effect. The log counts as evidence only while armed-<BOOT> exists; anything that
// could leave it incomplete deletes that marker (deletion needs no free space), and every boot deletes its
// predecessor's marker before it can accept input. The controller's sweep refuses anything unarmed,
// unanchored or unsealed. Never throws, never refuses a human, never saturates: a lost record only makes the
// NEXT boot decline, while this boot's in-memory fence is unaffected.
const HUMAN_DIR = HOME + '/admission/human', HUMAN_ARMED = HUMAN_DIR + '/armed-' + BOOT;
let humanLog = null, humanLines = 0;
function syncHumanDir() { const fd = fs.openSync(HUMAN_DIR, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
// The descriptor is deliberately not closed on disarm: after an EBADF its number may already belong to another
// file in this daemon, and closing that would be worse than leaking one descriptor once.
function disarmHuman() { humanLog = null; try { fs.unlinkSync(HUMAN_ARMED); } catch {} try { syncHumanDir(); } catch {} }
function writeLine(fd, record) { const line = Buffer.from(JSON.stringify(record) + '\n'); if (fs.writeSync(fd, line) !== line.length) throw Error('short write'); fs.fsyncSync(fd); }
function recordHuman(record) {
  if (humanLog === null) return;
  try { writeLine(humanLog, record); if (++humanLines >= 100000) disarmHuman(); }
  catch { disarmHuman(); }
}
if (DEPLOYED) {
  let predecessors = [], fd = null;
  try {
    fs.mkdirSync(HUMAN_DIR, { recursive: true, mode: 0o700 });
    predecessors = fs.readdirSync(HUMAN_DIR).filter(name => /^armed-[0-9a-f-]{36}$/.test(name));
    // Exactly one armed predecessor is a trustworthy "previous boot"; none or several is not. The anchor
    // binds its exact bytes now, so any later edit, truncation or replay of it is detectable.
    let prev = null, prevBytes = null, prevSha256 = null;
    if (predecessors.length === 1) try {
      // lstat first: a FIFO or device planted here must not hang this import, which would block all human input.
      const file = HUMAN_DIR + '/' + predecessors[0].slice(6) + '.log', stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 67108864) throw Error('not a bounded regular file');
      const bytes = fs.readFileSync(file);
      prev = predecessors[0].slice(6); prevBytes = bytes.length; prevSha256 = createHash('sha256').update(bytes).digest('hex');
    } catch { prev = null; }
    fd = fs.openSync(HUMAN_DIR + '/' + BOOT + '.log', fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_APPEND, 0o600);
    writeLine(fd, { v: 1, boot: BOOT, pid: process.pid, prev, prevBytes, prevSha256, receipts: PRIOR_RECEIPTS });
  } catch { if (fd !== null) try { fs.closeSync(fd); } catch {} fd = null; }
  finally {
    // Unconditional: this boot disarms its predecessor even when it cannot arm itself, so a boot that left
    // no record breaks the chain rather than vanishing from it.
    for (const name of predecessors) try { fs.unlinkSync(HUMAN_DIR + '/' + name); } catch {}
    try { syncHumanDir(); } catch {}
  }
  if (fd !== null) try { fs.closeSync(fs.openSync(HUMAN_ARMED, 'wx', 0o600)); syncHumanDir(); humanLog = fd; } catch { disarmHuman(); }
  // The seal: this boot ended through the exit path, so every line above reached the kernel. A crash,
  // SIGKILL, panic or power loss leaves no seal, and the sweep declines that boot.
  process.once('exit', code => { recordHuman({ end: 'exit', code }); humanLog = null; });
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
      const counted = !((humanInput.size >= 10000 && !humanInput.has(agent.id)) || next >= Number.MAX_SAFE_INTEGER);
      // Durable before the input takes effect. n is the counter value this input produces, or null when the
      // counter cannot count it -- which the controller reads as a post-grant input, never as clean.
      recordHuman({ a: agent.id, n: counted ? next : null });
      if (counted) humanInput.set(agent.id, next); else saturated = true;
    }
    return; // Human input cannot be refused by this guard; its only filesystem effect is the best-effort log above.
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
  const pending = db.prepare("SELECT id,kind,state,body FROM deliveries WHERE session=? AND state IN ('intent','uncertain','reserved','queued') ORDER BY id").all(agent.id);
  const management = !link && !owned || Boolean(link && owned && live(parent) && parent.task === session?.task && parent.authority === session?.authority && grant?.generation === parent.generation && link.supervisorGeneration === parent.generation && link.workerGeneration === session?.generation && owned.supervisor === parent.id && owned.epoch === grant.epoch && owned.generation === session?.generation && owned.phase === 'attached');
  // Only this explicit host-owned switch intent may reconnect with a pending delivery.
  // Its full body joins the revision, so target changes during preparation refuse.
  let switchBody;
  try { if (pending.length === 1 && pending[0].kind === 'account-switch' && pending[0].state === 'intent') switchBody = JSON.parse(pending[0].body); } catch {}
  const switching = switchBody && switchBody.generation === session?.generation && switchBody.boot === BOOT && switchBody.humanAt === (humanInput.get(agent.id) ?? 0) && typeof switchBody.accountId === 'string';
  const authorized = live(session) && management && (!ownGrant || ownGrant.generation === session.generation) || session?.mode === 'human' && switching;
  const allowed = Boolean(!saturated && authorized && session.cwd === agent.cwd && (!pending.length || switching));
  const state = {session,link,owned,parent,grant,ownGrant,permissions,permissionRoot,pending,input:observation(agent.id),parentInput:parent && observation(parent.id),allowed};
  return {revision:createHash('sha256').update(JSON.stringify(state)).digest('hex'),allowed,contextRotationAllowed:Boolean(allowed && live(session) && !pending.length)};
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
function permissionScope(request, proof, cwd, agent) {
  if (proof?.kind === 'automatic-tool') {
    if (request.provider !== agent.provider) return false;
    try { return canonicalPermission(automaticPermissionProof(request, cwd, permissionMode(agent), permissionDigest(request.input ?? {}))) === canonicalPermission(proof); } catch { return false; }
  }
  return request.provider === 'claude' && request.kind === 'tool' && ['Write', 'Edit'].includes(request.name) &&
    permissionDigest(request.input) === proof?.inputHash && request.input.file_path === proof.file &&
    proof.root === cwd && proof.file.startsWith(cwd + '/');
}
export function admitPermission(db, agent, intentId, response, used = permissionResponses) {
  const row = db.prepare('SELECT * FROM permission_intents WHERE id=?').get(intentId);
  if (!row || row.state !== 'intent' || row.session !== agent.id) throw Error('Unknown or consumed permission intent');
  const body = JSON.parse(row.body), session = db.prepare('SELECT * FROM sessions WHERE id=?').get(agent.id);
  const live = s => s && s.mode === 'delegated' && s.boot === BOOT && s.grantedAt === (humanInput.get(s.id) ?? 0) + 1;
  if (body.kind === 'question-answer') return admitQuestionAnswer(db, agent, row, body, session, live, response, used);
  const grant = db.prepare('SELECT * FROM permission_grants WHERE session=?').get(agent.id);
  const root = grant && db.prepare('SELECT * FROM permission_grants WHERE session=?').get(grant.rootSession);
  const rootSession = root && db.prepare('SELECT * FROM sessions WHERE id=?').get(root.session);
  const request = agent.pendingPermissions?.get(body.requestId), key = agent.id + ':' + body.requestId;
  if (saturated || !live(session) || !live(rootSession) || session.generation !== body.generation || body.boot !== BOOT || session.expected !== body.origin || session.authority !== body.authority || (agent.lastUserMessageAt?.toISOString() ?? null) !== body.expectedLastUserAt || !grant || grant.revoked || grant.generation !== session.generation || grant.epoch !== body.grantEpoch || !root || root.revoked || root.epoch !== grant.rootEpoch || root.epoch !== row.pool || root.generation !== rootSession.generation || root.rootSession !== root.session || root.rootEpoch !== root.epoch) throw Error('Changed permission authority');
  const delivery = db.prepare("SELECT * FROM deliveries WHERE id=? AND session=? AND kind='send' AND state='delivered'").get(body.origin, agent.id);
  if (!delivery || used.has(key) || used.size >= 10000 || agent.inFlightPermissionResponses?.has(body.requestId) || !request || !permissionScope(request, body.proof, session.cwd, agent) || permissionDigest(permissionProjection(request)) !== body.requestDigest || canonicalPermission(response) !== '{"behavior":"allow"}' || db.prepare("SELECT count(*) n FROM permission_intents WHERE pool=? AND state!='escalated'").get(row.pool).n > 100) throw Error('Changed, duplicate or out-of-policy native permission');
  const link = db.prepare('SELECT * FROM event_links WHERE worker=?').get(agent.id);
  if (link) {
    const parent = db.prepare('SELECT * FROM sessions WHERE id=?').get(link.supervisor), manager = db.prepare('SELECT * FROM manager_grants WHERE supervisor=?').get(link.supervisor), owned = db.prepare('SELECT * FROM manager_workers WHERE worker=?').get(agent.id), b = body.supervision;
    if (!b || !live(parent) || parent.task !== session.task || parent.generation !== link.supervisorGeneration || session.generation !== link.workerGeneration || link.epoch !== b.linkEpoch || link.supervisor !== b.supervisor || manager?.epoch !== b.managerEpoch || manager.generation !== parent.generation || owned?.supervisor !== parent.id || owned.epoch !== manager.epoch || owned.generation !== session.generation || owned.phase !== 'attached' || (grant.rootSession !== grant.session && grant.rootSession !== parent.id)) throw Error('Changed parent permission authority');
  } else if (body.supervision || grant.rootSession !== grant.session) throw Error('Permission ownership link missing');
  used.add(key); // Linearization: no await or journal write before the provider receives this response.
  return body.requestId;
}
// H7 item 5. A pending QUESTION (Codex request_user_input, Claude AskUserQuestion) on a delegated session, answered by
// the seat or manager that owns it (questions.mjs). Admitted only as the exact response the controller journaled for
// exactly this request (request digest and canonical response both pinned in the intent), on a live delegated session
// at the journaled generation and boot, whose current turn is the controller's own delivered send, and only an allow:
// it can answer a question and nothing else -- never a tool, file or command permission (request.kind must be
// 'question'), never twice, and without any routine grant (a question authorizes no action).
function admitQuestionAnswer(db, agent, row, body, session, live, response, used) {
  const request = agent.pendingPermissions?.get(body.requestId), key = agent.id + ':' + body.requestId;
  if (saturated || !live(session) || row.pool !== 'question:' + agent.id || session.generation !== body.generation || body.boot !== BOOT || session.expected !== body.origin || session.authority !== body.authority || (agent.lastUserMessageAt?.toISOString() ?? null) !== body.expectedLastUserAt) throw Error('Changed question authority');
  const delivery = db.prepare("SELECT * FROM deliveries WHERE id=? AND session=? AND kind='send' AND state='delivered'").get(body.origin, agent.id);
  if (!delivery || used.has(key) || used.size >= 10000 || agent.inFlightPermissionResponses?.has(body.requestId) || !request || request.kind !== 'question' || permissionDigest(permissionProjection(request)) !== body.requestDigest || response?.behavior !== 'allow' || typeof body.response !== 'string' || canonicalPermission(response) !== body.response || db.prepare('SELECT count(*) n FROM permission_intents WHERE pool=?').get(row.pool).n > 100) throw Error('Changed, duplicate or out-of-policy question answer');
  used.add(key); // Linearization, as for a routine permission: no await or journal write before the provider receives it.
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
// P1 (prime S-2, CONTRACTS §3.6 rule 3): defence in depth. Every Claude session launches with permission deny
// rules for the controller home's secret, journal and grants (and any pairing state), as Claude Code flag
// settings, which apply in every permission mode including full access. This does not stop Codex full-access
// sessions or another program running as the same user; see docs/permission-overlay-deny.md.
export const CONTROLLER_PRIVATE_PATHS = Object.freeze([
  HOME + '/operator.secret',
  HOME + '/journal.sqlite*',
  HOME + '/grants/**',
  // Pairing state, wherever the P1 pairing code keeps it in the controller home: top-level files only (a `*` never
  // crosses a folder), so task worktrees below the home, whose source may mention pairing, stay editable.
  HOME + '/*pairing*',
  HOME + '/pairing/**',
  HOME + '/devices/**',
]);
export function controllerDenyRules(paths = CONTROLLER_PRIVATE_PATHS) {
  const rules = [];
  // `//` marks an absolute path in Claude Code permission rules. Read covers Grep and Glob; Edit covers every
  // built-in writing tool.
  for (const p of paths) rules.push('Read(/' + p + ')', 'Edit(/' + p + ')', 'Write(/' + p + ')');
  // Best effort for shell commands: those naming the files directly. A command can still build the path
  // indirectly; the file-tool rules above are the dependable part.
  rules.push('Bash(*operator.secret*)', 'Bash(*journal.sqlite*)', 'Bash(*' + HOME + '/grants*)', 'Bash(*' + HOME + '/pairing*)', 'Bash(*' + HOME + '/device-pairing*)', 'Bash(*' + HOME + '/devices*)');
  return rules;
}
// R-F-A1: the one choke point. Every Claude Agent SDK process the daemon starts -- a fresh launch, a resume or
// import, a reload, the quiet MCP refresh, a mode or model change that rebuilds the query, a derived Claude
// profile, the model probe -- is started by claudeQuery (providers/claude/query.js) with these options, so both
// patch routes wrap that one call instead of each manager call site. Only the options handed to the SDK change;
// no stored config ever carries the rules, so rolling the overlay back removes them entirely.
export function denyClaudeQueryOptions(options, paths = CONTROLLER_PRIVATE_PATHS) {
  const rules = controllerDenyRules(paths), base = options ?? {};
  const merged = { ...base, disallowedTools: [...new Set([...(base.disallowedTools ?? []), ...rules])] };
  // A settings file path is left to Claude Code; disallowedTools above already carries every rule.
  if (typeof base.settings === 'string') return merged;
  const settings = base.settings && typeof base.settings === 'object' ? base.settings : {};
  const permissions = settings.permissions ?? {};
  return { ...merged, settings: { ...settings, permissions: { ...permissions, deny: [...new Set([...(permissions.deny ?? []), ...rules])] } } };
}
