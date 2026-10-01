import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { controlHome } from './home.mjs';
import { hash } from './store.mjs';
import { uuid, PROGRAMME } from './authority.mjs';
import { assertColumns } from './schema.mjs';
import { localHostName } from './portable-host.mjs';
const bookProvider = creation => creation.provider;
import { readProjectDirectory } from './projects.mjs';
const keys = (a, names) => a && typeof a === 'object' && !Array.isArray(a) && Object.keys(a).sort().join() === names;
const SEAT = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const UNRESOLVED = ['intent', 'uncertain', 'queued', 'reserved'];
export const ROLES = ['prime', 'project-orchestrator'];
export const MEMBER_TASK_LIMIT = 64;
// A role binding names an accountable session. It never transfers control, starts a session or sends a prompt.
export const NO_AUTHORITY = 'A role binding records accountability only. It grants no task authority, transfers no control, starts no session and sends no prompt.';
// Two distinct identities. A prime seat is a board-level slug over the programme; a project orchestrator
// seat is a registered project UUID from the company project directory, which is NOT a task ID.
export function seatIdentity(role, seat) {
  if (role === 'prime') { if (typeof seat !== 'string' || !SEAT.test(seat)) throw Error('A prime seat is a short lowercase slug'); return { role, seat, projectId: null }; }
  if (role !== 'project-orchestrator') throw Error('Unknown role');
  if (!uuid(seat)) throw Error('A project orchestrator seat is a registered project ID');
  return { role, seat, projectId: seat };
}
export class Bindings {
  constructor(control, readProjects = readProjectDirectory, directory = path.join(controlHome(), 'grants/role')) {
    this.control = control; this.store = control.store; this.db = this.store.db; this.readProjects = readProjects; this.grantDirectory = directory;
    this.db.exec(`CREATE TABLE IF NOT EXISTS role_bindings(role TEXT NOT NULL,seat TEXT NOT NULL,projectId TEXT,task TEXT,session TEXT,sessionGeneration INTEGER,revision INTEGER NOT NULL,state TEXT NOT NULL,note TEXT NOT NULL,membershipAt TEXT,at TEXT NOT NULL,PRIMARY KEY(role,seat));
      CREATE TABLE IF NOT EXISTS role_binding_history(id TEXT PRIMARY KEY,role TEXT NOT NULL,seat TEXT NOT NULL,projectId TEXT,task TEXT,action TEXT NOT NULL,previousSession TEXT,session TEXT,previousRevision INTEGER NOT NULL,revision INTEGER NOT NULL,note TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS role_credentials(session TEXT PRIMARY KEY,generation INTEGER NOT NULL,token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seat_human_holds(role TEXT NOT NULL,seat TEXT NOT NULL,revision INTEGER NOT NULL,session TEXT NOT NULL,note TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(role,seat,revision));
      CREATE TABLE IF NOT EXISTS role_grant_pending(session TEXT PRIMARY KEY,role TEXT NOT NULL,seat TEXT NOT NULL,revision INTEGER NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seat_manager_grants(session TEXT PRIMARY KEY,role TEXT NOT NULL,seat TEXT NOT NULL,revision INTEGER NOT NULL,epoch TEXT NOT NULL,at TEXT NOT NULL);`);
    assertColumns(this.db, 'role_bindings', 'role,seat,projectId,task,session,sessionGeneration,revision,state,note,membershipAt,at');
    assertColumns(this.db, 'role_binding_history', 'id,role,seat,projectId,task,action,previousSession,session,previousRevision,revision,note,at');
    assertColumns(this.db, 'role_credentials', 'session,generation,token');
    // A separate marker table, as role_default_channels is, so role_bindings keeps its exact asserted shape.
    assertColumns(this.db, 'seat_human_holds', 'role,seat,revision,session,note,at');
    assertColumns(this.db, 'role_grant_pending', 'session,role,seat,revision,at');
    assertColumns(this.db, 'seat_manager_grants', 'session,role,seat,revision,epoch,at');
  }
  // DESIGN-E option H, approved. A prime seat whose holder is the human-facing lead can never stay delegated,
  // so it can never hold a role capability, receive a native channel message or send one. A HOLD is an
  // operator's explicit, journaled statement that this seat is held by a human at this binding revision. It
  // grants nothing: it touches no session row, no generation, no credential and no revision. All it changes
  // is where a channel message to the seat comes to rest -- 'held' for the operator inbox, never dispatched.
  //
  // Prime seats only, and only while the holder really is under human control. It is never inferred from
  // mode='human' alone: a taken-over seat must stay a refusal its sender can see, not silently become an
  // inbox nobody reads. The revision is NOT bumped, because every channel is pinned to it.
  hold(a) {
    if (!keys(a, 'expectedRevision,expectedSessionGeneration,note,role,seat') || !Number.isSafeInteger(a.expectedRevision) || a.expectedRevision < 1
      || !Number.isSafeInteger(a.expectedSessionGeneration) || a.expectedSessionGeneration < 1
      || typeof a.note !== 'string' || a.note.trim().length < 12 || a.note.length > 2000) throw Error('Invalid seat hold');
    if (a.role !== 'prime') throw Error('Only a prime seat can be declared human-held');
    seatIdentity(a.role, a.seat);
    const note = a.note.trim();
    return this.store.atomic(() => {
      const current = this.row(a.role, a.seat);
      if (!current || current.state !== 'assigned' || !current.session) throw Error('That seat holds no current role binding');
      if (current.revision !== a.expectedRevision) throw Error('Role binding revision changed; refresh before declaring a hold');
      const s = this.store.get(current.session);
      if (!s || s.generation !== a.expectedSessionGeneration) throw Error('Session control changed; refresh before declaring a hold');
      if (s.mode !== 'human') throw Error('A seat is declared human-held only while its holder is under human control; a delegated holder receives and sends as itself');
      if (this.db.prepare('SELECT seat FROM seat_human_holds WHERE role=? AND seat=? AND revision=?').get(a.role, a.seat, current.revision)) throw Error('This seat is already declared human-held at this revision');
      if (this.db.prepare('SELECT count(*) n FROM role_binding_history').get().n >= 5000) throw Error('Role binding history capacity reached');
      const at = new Date().toISOString();
      this.db.prepare('INSERT INTO seat_human_holds VALUES (?,?,?,?,?,?)').run(a.role, a.seat, current.revision, current.session, note, at);
      this.db.prepare('INSERT INTO role_binding_history VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), a.role, a.seat, null, current.task, 'hold', current.session, current.session, current.revision, current.revision, note, at);
      return { role: a.role, seat: a.seat, revision: current.revision, sessionId: current.session, held: true, at, grantsAuthority: false,
        note: 'Declared human-held. Channel messages to this seat are recorded held for the operator inbox and are never dispatched into the session. Nothing about the session, its control or its credentials changed.' };
    });
  }
  unhold(a) {
    if (!keys(a, 'expectedRevision,note,role,seat') || !Number.isSafeInteger(a.expectedRevision) || a.expectedRevision < 1
      || typeof a.note !== 'string' || a.note.trim().length < 12 || a.note.length > 2000) throw Error('Invalid seat hold release');
    if (a.role !== 'prime') throw Error('Only a prime seat can be declared human-held');
    const note = a.note.trim();
    return this.store.atomic(() => {
      const held = this.db.prepare('SELECT * FROM seat_human_holds WHERE role=? AND seat=? AND revision=?').get(a.role, a.seat, a.expectedRevision);
      if (!held) throw Error('That seat is not declared human-held at that revision');
      if (this.db.prepare('SELECT count(*) n FROM role_binding_history').get().n >= 5000) throw Error('Role binding history capacity reached');
      const at = new Date().toISOString(), current = this.row(a.role, a.seat);
      this.db.prepare('DELETE FROM seat_human_holds WHERE role=? AND seat=? AND revision=?').run(a.role, a.seat, a.expectedRevision);
      this.db.prepare('INSERT INTO role_binding_history VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), a.role, a.seat, null, current?.task ?? null, 'unhold', held.session, current?.session ?? null, a.expectedRevision, current?.revision ?? a.expectedRevision, note, at);
      return { role: a.role, seat: a.seat, revision: a.expectedRevision, held: false, at, grantsAuthority: false, note: 'Hold released. Messages already held stay held and readable; none is dispatched.' };
    });
  }
  // The EFFECTIVE hold, derived on every call and never cached: a row for the binding's CURRENT revision,
  // naming the session that still holds it, while that session is under human control. Reassigning the seat
  // bumps the revision, so a hold dies with no cleanup; handing the holder back suspends it.
  heldBy(role, seat) {
    if (role !== 'prime') return null;
    const b = this.row(role, seat);
    if (!b || b.state !== 'assigned' || !b.session) return null;
    const h = this.db.prepare('SELECT * FROM seat_human_holds WHERE role=? AND seat=? AND revision=?').get(role, seat, b.revision);
    if (!h || h.session !== b.session) return null;
    const s = this.store.get(b.session);
    if (!s || s.mode !== 'human') return null;
    return { role, seat, revision: b.revision, session: s.id, generation: s.generation, note: h.note, at: h.at };
  }
  // Events, permissions and leadership own their own tables; a read states what it could not see instead of assuming empty.
  has(table) { return Boolean(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)); }
  row(role, seat) { return this.db.prepare('SELECT * FROM role_bindings WHERE role=? AND seat=?').get(role, seat) ?? null; }
  // Does this session currently hold any seat? The same question checkRole, releaseCredential and
  // reissueRole each ask; named once so the boot re-establishment gate does not re-spell it.
  seatedRow(id) { return this.db.prepare('SELECT role,seat FROM role_bindings WHERE session=?').get(id) ?? null; }
  // Actual dispatch semantics per host, split because the two capabilities genuinely differ. A Book seat
  // can receive a role message through the signed receiver, but reaches no controller socket, so a role
  // capability cannot be provisioned there. Absent routing is unknown routing, not local routing.
  dispatch(id) {
    const routes = this.control.native?.route;
    if (typeof routes !== 'function') {
      const reason = 'Host routing state is unavailable, so dispatch cannot be established for this seat. Attach the native runtime before issuing a role capability or approving a channel.';
      return { host: null, phase: null, supported: false, reason, capability: { supported: false, reason } };
    }
    const route = routes.call(this.control.native, id);
    if (!route) return { host: localHostName(), phase: null, supported: true, reason: null, capability: { supported: true, reason: null } };
    const s = this.store.get(id);
    // Receiver-acknowledged delegation only: host_routes reaches 'active' after the receiver confirms the
    // delegate action, and beginRevoke moves it away before a takeover is acknowledged.
    const active = route.phase === 'active' && s?.mode === 'delegated' && s.generation === route.generation;
    return { host: route.host ?? 'unknown', phase: route.phase ?? null, supported: active,
      reason: active ? null : `The Book seat route is ${route.phase ?? 'unknown'} at receiver generation ${route.generation ?? 'unknown'}; a role message is admitted only while the receiver has acknowledged the current delegation.`,
      capability: { supported: false, reason: 'A Book session reaches no controller socket and is created without the supervisor MCP server, so a role capability cannot be provisioned there. It can hold a seat and receive role messages; it cannot originate them.' } };
  }
  // A narrow per-session capability, like manager_grants and event_credentials. The delegation capability
  // itself is never handed to a model: this one authorizes role reads and channel messages and nothing else.
  grantRole(a) {
    if (!keys(a, 'expectedGeneration,sessionId') || !uuid(a.sessionId) || !Number.isSafeInteger(a.expectedGeneration)) throw Error('Invalid role capability grant');
    const s = this.store.get(a.sessionId);
    if (!s || s.mode !== 'delegated' || s.generation !== a.expectedGeneration) throw Error('A role capability is issued only to an unchanged delegated session');
    if (!this.db.prepare('SELECT role FROM role_bindings WHERE session=?').get(a.sessionId)) throw Error('That session holds no current role binding');
    const reach = this.dispatch(a.sessionId);
    if (!reach.capability.supported) throw Error(reach.capability.reason);
    return { sessionId: s.id, generation: s.generation, grantFile: this.issueRole(s), grantsAuthority: false, note: NO_AUTHORITY };
  }
  // The journal row is authoritative; the grant file is only how the token reaches the session. Rewriting
  // the file at the same deterministic path replaces the token a session would read on its next tool call.
  issueRole(s) {
    fs.mkdirSync(this.grantDirectory, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(this.grantDirectory) !== this.grantDirectory || !uuid(path.basename(s.cwd))) throw Error('Invalid role grant directory');
    const token = randomBytes(32).toString('base64url'), file = path.join(this.grantDirectory, path.basename(s.cwd) + '.json'), temporary = file + '.' + randomUUID();
    fs.writeFileSync(temporary, JSON.stringify({ sessionId: s.id, capability: token }), { mode: 0o600, flag: 'wx', flush: true });
    fs.renameSync(temporary, file);
    this.db.prepare('INSERT OR REPLACE INTO role_credentials VALUES (?,?,?)').run(s.id, s.generation, hash(token));
    return file;
  }
  // N1: revocation invalidates rather than suspends. The credential row is deleted the moment a session
  // stops holding any seat, so the exact token cannot revive by re-seating at an unchanged generation.
  // The journal row is authoritative -- the token is dead whether or not the file can be removed -- so the
  // delete runs inside the caller's transaction and the path is returned to unlink after it commits.
  releaseCredential(id) {
    if (!id) return null;
    this.db.prepare('DELETE FROM role_grant_pending WHERE session=? AND NOT EXISTS (SELECT 1 FROM role_bindings b WHERE b.session=role_grant_pending.session AND b.role=role_grant_pending.role AND b.seat=role_grant_pending.seat AND b.revision=role_grant_pending.revision)').run(id);
    if (this.db.prepare('SELECT role FROM role_bindings WHERE session=?').get(id)) return null; // still seated elsewhere
    if (!this.db.prepare('SELECT session FROM role_credentials WHERE session=?').get(id)) return null;
    this.db.prepare('DELETE FROM role_credentials WHERE session=?').run(id);
    const s = this.store.get(id), base = s && path.basename(s.cwd);
    return base && uuid(base) ? path.join(this.grantDirectory, base + '.json') : null;
  }
  // H6 item 2. A reaffirmation (the SAME session re-seated) moves the seat to a new revision, and everything pinned to
  // the old revision silently stopped working: live, a reaffirm moved the Command Centre seat to revision 2 and its
  // session allowance and prime channel both read "the seat changed". The holder did not change, so what the seat
  // already had is carried to the new revision, in the same transaction, and nothing new is conferred: the used
  // count, the conferral count and every bound stay as they were. A replacement (a new holder) is unchanged: the
  // new holder gets the fresh seating defaults and nothing of the old holder's.
  //
  // Carried (each only where it names this session at the old revision): the session allowance and its default
  // marker, OPEN channels on either side (prime or project) with their default-channel marker, a pending role
  // credential, reserved/pending briefs, open session requests, a human hold on the seat, and the seat record of a
  // seat-conferred manager grant. Not carried: history (creation ownership, adoptions, binding history) and operator
  // replies in flight (seat_operator_acts), which are pinned facts about a moment, not standing authority.
  carryForward(role, seat, session, from, to) {
    const has = t => Boolean(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t));
    const run = (t, sql, ...args) => has(t) ? Number(this.db.prepare(sql).run(...args).changes) : 0;
    const carried = {
      sessionAllowance: run('role_session_allowances', 'UPDATE role_session_allowances SET seatRevision=? WHERE role=? AND seat=? AND seatRevision=?', to, role, seat, from),
      channels: run('role_channels', "UPDATE role_channels SET primeRevision=? WHERE state='open' AND primeSeat=? AND primeSession=? AND primeRevision=?", to, role === 'prime' ? seat : '\u0000', session, from)
        + run('role_channels', "UPDATE role_channels SET projectRevision=? WHERE state='open' AND projectSeat=? AND projectSession=? AND projectRevision=?", to, role === 'project-orchestrator' ? seat : '\u0000', session, from),
      pendingRoleGrant: run('role_grant_pending', 'UPDATE role_grant_pending SET revision=? WHERE session=? AND role=? AND seat=? AND revision=?', to, session, role, seat, from),
      briefs: role === 'project-orchestrator' ? run('role_session_briefs', "UPDATE role_session_briefs SET seatRevision=? WHERE seat=? AND seatRevision=? AND leaderSession=? AND state IN ('reserved','pending')", to, seat, from, session) : 0,
      sessionRequests: role === 'project-orchestrator' ? run('role_session_requests', "UPDATE role_session_requests SET seatRevision=? WHERE seat=? AND seatRevision=? AND state IN ('pending','notified')", to, seat, from) : 0,
      humanHold: run('seat_human_holds', 'UPDATE seat_human_holds SET revision=? WHERE role=? AND seat=? AND revision=? AND session=?', to, role, seat, from, session),
      seatManagerGrant: run('seat_manager_grants', 'UPDATE seat_manager_grants SET revision=? WHERE session=? AND role=? AND seat=? AND revision=?', to, session, role, seat, from),
    };
    // The "conferred by seating" markers follow their rows, so an operator surface keeps naming a default a default.
    if (role === 'project-orchestrator') {
      run('role_default_allowances', 'UPDATE role_default_allowances SET seatRevision=? WHERE seat=? AND seatRevision=?', to, seat, from);
      run('role_default_channels', 'UPDATE role_default_channels SET projectRevision=? WHERE projectSeat=? AND projectRevision=?', to, seat, from);
    }
    return { from, to, ...carried };
  }
  // REVIEW-G G-1. A manager grant SEATING issued belongs to that seat: when the session stops holding the seat that
  // conferred it (vacated or replaced), exactly that grant -- matched by epoch, so a later operator manager-grant is
  // untouched -- is revoked in the same transaction, and its file is unlinked after commit. An operator's own
  // manager-grant stays session-bound, as it always was (a takeover ends it). Its workers become orphaned, as on takeover.
  releaseSeatManager(id, role, seat) {
    const row = id && this.db.prepare('SELECT * FROM seat_manager_grants WHERE session=? AND role=? AND seat=?').get(id, role, seat);
    if (!row) return null;
    if (this.row(role, seat)?.session === id) return null;   // still holds it (a reaffirmation)
    this.db.prepare('DELETE FROM seat_manager_grants WHERE session=?').run(id);
    const revoked = this.db.prepare('DELETE FROM manager_grants WHERE supervisor=? AND epoch=?').run(id, row.epoch);
    const s = this.store.get(id), base = s && path.basename(s.cwd), dir = this.control.manager?.directory;
    return Number(revoked.changes) === 1 && base && uuid(base) && dir ? path.join(dir, base + '.json') : null;
  }
  unlinkGrant(file) {
    if (!file) return;
    try { fs.rmSync(file, { force: true }); }
    catch (e) { this.lastError = { message: 'Role grant file could not be removed; its credential is already revoked: ' + e.message, at: new Date().toISOString() }; }
  }
  // Called by the controller after a re-delegation. Not an operator act and not a new grant: the seat and
  // its accountability are unchanged, only the delegation epoch moved. It reissues ONLY for a session that
  // already held a capability and still holds a seat, so a vacated or replaced seat stays inert and a
  // session that never had one does not acquire one by being handed back.
  //
  // G1: the one exception is a grant the operator's own seating left pending because the session was not yet
  // delegated (issue at seating needs a delegated session). It is honoured at the first delegation only while the
  // session still holds exactly the seat and revision it was seated at; a vacated, replaced or re-seated seat
  // leaves nothing to issue from, so a revoked credential still never comes back through a handback.
  reissueRole(id) {
    if (!this.db.prepare('SELECT session FROM role_credentials WHERE session=?').get(id)) return this.issuePending(id);
    const s = this.store.get(id);
    if (!s || s.mode !== 'delegated') return null;
    if (!this.db.prepare('SELECT role FROM role_bindings WHERE session=?').get(id)) return null;
    if (!this.dispatch(id).capability.supported) return null;
    return { sessionId: s.id, generation: s.generation, grantFile: this.issueRole(s), reissued: true };
  }
  issuePending(id) {
    const pending = this.db.prepare('SELECT * FROM role_grant_pending WHERE session=?').get(id);
    if (!pending) return null;
    const s = this.store.get(id), bound = this.row(pending.role, pending.seat);
    if (!bound || bound.state !== 'assigned' || bound.session !== id || bound.revision !== pending.revision) { this.db.prepare('DELETE FROM role_grant_pending WHERE session=?').run(id); return null; }
    if (!s || s.mode !== 'delegated' || !this.dispatch(id).capability.supported) return null;
    const grantFile = this.issueRole(s);
    this.db.prepare('DELETE FROM role_grant_pending WHERE session=?').run(id);
    return { sessionId: s.id, generation: s.generation, grantFile, issued: 'pending seating grant' };
  }
  // Generation-pinned AND binding-pinned. A human takeover bumps the generation and the capability dies
  // with it; releasing or replacing the last seat this session holds ends it just as immediately. The
  // check lives here rather than in the mutation paths so a future third path cannot miss it, and so it
  // closes reads and writes together. A session holding several seats keeps its capability while any one
  // of them remains, and loses it when the last one goes.
  checkRole(id, capability) {
    const row = this.db.prepare('SELECT * FROM role_credentials WHERE session=?').get(id), s = this.store.get(id);
    if (!row || !s || s.mode !== 'delegated' || s.generation !== row.generation
      || !this.db.prepare('SELECT role FROM role_bindings WHERE session=?').get(id)
      || !timingSafeEqual(Buffer.from(row.token), Buffer.from(hash(typeof capability === 'string' ? capability : '')))) throw Error('Role capability revoked or invalid');
    return s;
  }
  describe(role, seat) {
    const identity = seatIdentity(role, seat), row = this.row(role, seat);
    if (!row) return { ...identity, state: 'vacant', revision: 0, task: null, sessionId: null, session: null, note: null, at: null, membershipAt: null, dispatch: null, sessionPresent: false, sessionGenerationChanged: false, sessionTaskMatches: false };
    const s = row.session ? this.store.get(row.session) : null;
    return { role, seat, projectId: row.projectId, state: row.state, revision: row.revision, task: row.task, sessionId: row.session,
      // Explicit field selection: the saved row carries a delegation capability that must never leave the journal.
      session: s ? { id: s.id, task: s.task, cwd: s.cwd, mode: s.mode, generation: s.generation } : null,
      note: row.note, at: row.at, membershipAt: row.membershipAt, sessionPresent: Boolean(s),
      dispatch: s ? this.dispatch(s.id) : null,
      sessionGenerationChanged: Boolean(s) && s.generation !== row.sessionGeneration,
      // Whether the holder is still enrolled on the task whose project membership was verified.
      sessionTaskMatches: Boolean(s) && s.task === row.task };
  }
  // Verified project membership for one task, or an explicit refusal. Journal state can never establish this.
  async verifyMembership(projectId, task, directory) {
    const d = directory ?? await this.readProjects();
    if (!d.available) throw Error('Project directory unavailable; project membership cannot be established');
    if (!d.projects.some(p => p.id === projectId)) {
      throw Error(d.projects.length ? 'Unknown project in the current company project directory'
        : 'This installation records no project directory, so a project role cannot be verified here');
    }
    // Explicit recorded membership only. Task ancestry never implies that a task belongs to a project.
    if (!d.membership.some(m => m.taskId === task && m.projectId === projectId)) throw Error('Session task is not an explicitly recorded member of that project');
    return d;
  }
  async assign(a) {
    if (!(keys(a, 'expectedRevision,expectedSessionGeneration,note,role,seat,sessionId') || (keys(a, 'expectedRevision,expectedSessionGeneration,manager,note,role,seat,sessionId') && a.role === 'project-orchestrator' && keys(a.manager, 'maxWorkers,reason'))) || !ROLES.includes(a.role) || !uuid(a.sessionId)
      || !Number.isSafeInteger(a.expectedRevision) || a.expectedRevision < 0
      || !Number.isSafeInteger(a.expectedSessionGeneration) || a.expectedSessionGeneration < 1
      || typeof a.note !== 'string' || a.note.trim().length < 12 || a.note.length > 2000) throw Error('Invalid role assignment');
    const identity = seatIdentity(a.role, a.seat), note = a.note.trim(), session = this.store.get(a.sessionId);
    if (!session) throw Error('Role assignment requires a saved session identity');
    if (session.generation !== a.expectedSessionGeneration) throw Error('Session control changed; refresh before assigning');
    // A prime seat is board level over the programme root and holds no project identity.
    if (a.role === 'prime' && session.task !== PROGRAMME) throw Error('A prime seat is held by a session enrolled on the programme root');
    // A Book seat is only an explicitly receiver-enrolled Claude session. An observation-only Book session
    // is not in this journal at all and is refused above; it is never adopted by seating it. Unreadable
    // routing is unknown routing here too: without it the provider cannot be established, so the gate
    // refuses rather than being skipped, exactly as dispatch() refuses rather than assuming local.
    const routes = this.control.native?.route;
    if (typeof routes !== 'function') throw Error(this.dispatch(a.sessionId).reason);
    const route = routes.call(this.control.native, a.sessionId);
    if (route && bookProvider(JSON.parse(route.creation)) !== 'claude') throw Error('Only an explicitly enrolled Book Claude session may hold a role seat');
    const membership = identity.projectId ? await this.verifyMembership(identity.projectId, session.task, undefined) : null;
    // Distinct from project membership: the holder's own task must still be inside the delegated ancestry.
    await this.control.authority(session.task);
    const outcome = this.store.atomic(() => {
      const current = this.row(a.role, a.seat), revision = current?.revision ?? 0;
      if (revision !== a.expectedRevision) throw Error('Role binding revision changed; refresh before assigning');
      const fresh = this.store.get(a.sessionId);
      if (!fresh || fresh.task !== session.task || fresh.generation !== a.expectedSessionGeneration) throw Error('Session control or enrollment changed during assignment; refresh before assigning');
      if (!current && this.db.prepare('SELECT count(*) n FROM role_bindings').get().n >= 512) throw Error('Role binding capacity reached');
      if (this.db.prepare('SELECT count(*) n FROM role_binding_history').get().n >= 5000) throw Error('Role binding history capacity reached');
      const next = revision + 1, at = new Date().toISOString();
      const action = current?.state === 'assigned' ? (current.session === a.sessionId ? 'reaffirm' : 'replace') : 'assign';
      this.db.prepare('INSERT OR REPLACE INTO role_bindings VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(a.role, a.seat, identity.projectId, fresh.task, a.sessionId, fresh.generation, next, 'assigned', note, membership?.observedAt ?? null, at);
      this.db.prepare('INSERT INTO role_binding_history VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), a.role, a.seat, identity.projectId, fresh.task, action, current?.session ?? null, a.sessionId, revision, next, note, at);
      const carried = action === 'reaffirm' ? this.carryForward(a.role, a.seat, a.sessionId, revision, next) : null;
      const released = current?.session && current.session !== a.sessionId ? this.releaseCredential(current.session) : null;
      const managerReleased = current?.session && current.session !== a.sessionId ? this.releaseSeatManager(current.session, a.role, a.seat) : null;
      // PROPOSAL.md §1 and §2, approved. Seating a project orchestrator confers its routine defaults in the
      // SAME transaction as the seating itself, so there is never a window where a seat exists without them
      // and a seating that rolls back confers nothing.
      //
      // Every conferral is individually fenced: a default that cannot be conferred records WHY and the
      // seating still succeeds. A default must never be able to block a seat assignment -- an unavailable
      // project source, a missing prime or a spent conferral budget are all ordinary states, and an operator
      // must still be able to seat an orchestrator in every one of them.
      const defaults = { sessionAllowance: null, channel: null };
      if (a.role === 'project-orchestrator' && action !== 'reaffirm') {
        const seat = this.describe(a.role, a.seat);
        try { defaults.sessionAllowance = this.control.roleSessions.conferSeatingAllowance(a.seat, next); }
        catch (e) { defaults.sessionAllowance = { conferred: false, blocked: e.message }; }
        try { defaults.channel = this.control.channels.conferSeatingChannel(a.seat, seat); }
        catch (e) { defaults.channel = { conferred: false, blocked: e.message }; }
      }
      return { released, managerReleased, result: { role: a.role, seat: a.seat, projectId: identity.projectId, task: fresh.task, sessionId: a.sessionId, previousSessionId: current?.session ?? null,
        revision: next, action, at, membershipAt: membership?.observedAt ?? null, membershipPartial: membership?.partial ?? null, defaults, ...(carried ? { carried } : {}), sessionGeneration: fresh.generation, grantsAuthority: false, note: NO_AUTHORITY } };
    });
    this.unlinkGrant(outcome.released); this.unlinkGrant(outcome.managerReleased);
    await this.seatingGrants(a, outcome.result);
    // H6 item 5: reaffirming a delegated holder also brings its tool surface to this release's (best-effort; reported).
    if (outcome.result.action === 'reaffirm' && this.control.tools)
      outcome.result.toolSurface = await this.control.tools.automatic(a.sessionId, 'reaffirm') ?? { outcome: 'not-needed', ...this.control.tools.describe(a.sessionId) };
    return outcome.result;
  }
  // G1 (G-FIXES-REPORT.md). Seating confers the routine defaults above, but until now not the capability a seat
  // needs to use them: the Tally orchestrator's role_status and role_project_sessions failed with ENOENT on
  // grants/role/<id>.json until the prime issued it by hand. Seating is an explicit operator act, so it now issues
  // a FRESH role credential (never a revived one) to a delegated seated session, or leaves it pending for the
  // session's first delegation (issuePending). A manager grant is issued only when the operator asks for one in
  // the same call (`manager: {maxWorkers, reason}`), with every fence of Manager.grant. Like the other defaults,
  // each is fenced: a grant that cannot be issued records why, and the seating stands.
  async seatingGrants(a, result) {
    // Project orchestrator seats only, and only a new seating: a prime seat's defaults are a separate question
    // (seating-defaults.test.mjs), and a reaffirmation confers nothing new, so it rotates no token either.
    if (a.role !== 'project-orchestrator') return;
    if (result.action === 'reaffirm') {
      // H6 item 2: a reaffirmation confers no defaults and rotates no role token -- but a manager request is the
      // operator explicitly asking, so it is issued exactly as at a fresh seating (with its inbox), unless the
      // session already holds a live manager grant: re-issuing would start a new epoch and silently orphan that
      // grant's workers, so that is refused with the reason and left to a deliberate manager-grant.
      if (a.manager) {
        result.defaults = result.defaults ?? {};
        const live = this.db.prepare("SELECT g.epoch FROM manager_grants g JOIN sessions s ON s.id=g.supervisor WHERE g.supervisor=? AND s.mode='delegated' AND s.generation=g.generation").get(a.sessionId);
        if (live) result.defaults.managerGrant = { issued: false, blocked: 'This session already holds manager authority; re-issuing it would orphan its workers. Replace it deliberately with manager-grant' };
        else await this.seatManager(a, result);
      }
      return;
    }
    const s = this.store.get(a.sessionId);
    result.defaults = result.defaults ?? {};
    try {
      const reach = this.dispatch(a.sessionId);
      if (!reach.capability.supported) result.defaults.roleGrant = { issued: false, blocked: reach.capability.reason };
      else if (s.mode === 'delegated' && s.generation === result.sessionGeneration) result.defaults.roleGrant = { issued: true, grantFile: this.issueRole(s) };
      else {
        this.db.prepare('INSERT OR REPLACE INTO role_grant_pending VALUES (?,?,?,?,?)').run(a.sessionId, a.role, a.seat, result.revision, new Date().toISOString());
        result.defaults.roleGrant = { issued: false, pending: 'Issued at this session\u2019s next delegation while it still holds this seat at this revision' };
      }
    } catch (e) { result.defaults.roleGrant = { issued: false, blocked: e.message }; }
    if (a.manager) await this.seatManager(a, result);
  }
  async seatManager(a, result) {
    {
      try {
        const seated = () => { const b = this.row(a.role, a.seat); return b?.state === 'assigned' && b.session === a.sessionId && b.revision === result.revision; };
        const g = await this.control.manager.grantSeated({ sessionId: a.sessionId, expectedGeneration: result.sessionGeneration, maxWorkers: a.manager.maxWorkers, reason: a.manager.reason }, seated,
          epoch => this.db.prepare('INSERT OR REPLACE INTO seat_manager_grants VALUES (?,?,?,?,?,?)').run(a.sessionId, a.role, a.seat, result.revision, epoch, new Date().toISOString()));
        // Recorded with the grant, so a seat lost after it was revoked by that unassign or replacement; say so.
        if (!seated()) throw Error('The seat changed during the manager grant; the grant it issued was revoked with the seat');
        result.defaults.managerGrant = { issued: true, maxWorkers: g.maxWorkers, grantFile: g.grantFile, inboxFile: g.inboxFile };
      }
      catch (e) { result.defaults.managerGrant = { issued: false, blocked: e.message }; }
    }
  }
  // Vacating a seat must stay possible while the project source is unavailable, so it reads neither.
  unassign(a) {
    if (!keys(a, 'expectedRevision,note,role,seat') || !ROLES.includes(a.role) || !Number.isSafeInteger(a.expectedRevision) || a.expectedRevision < 1
      || typeof a.note !== 'string' || a.note.trim().length < 12 || a.note.length > 2000) throw Error('Invalid role release');
    const identity = seatIdentity(a.role, a.seat), note = a.note.trim();
    const outcome = this.store.atomic(() => {
      const current = this.row(a.role, a.seat);
      if (!current || current.state !== 'assigned') throw Error('That seat holds no current role binding');
      if (current.revision !== a.expectedRevision) throw Error('Role binding revision changed; refresh before releasing');
      if (this.db.prepare('SELECT count(*) n FROM role_binding_history').get().n >= 5000) throw Error('Role binding history capacity reached');
      const next = current.revision + 1, at = new Date().toISOString();
      // The row is retained vacant so the revision counter never restarts and a stale writer stays refused.
      this.db.prepare("UPDATE role_bindings SET session=NULL,sessionGeneration=NULL,task=NULL,membershipAt=NULL,revision=?,state='vacant',note=?,at=? WHERE role=? AND seat=?").run(next, note, at, a.role, a.seat);
      this.db.prepare('INSERT INTO role_binding_history VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), a.role, a.seat, identity.projectId, current.task, 'unassign', current.session, null, current.revision, next, note, at);
      const released = this.releaseCredential(current.session), managerReleased = this.releaseSeatManager(current.session, a.role, a.seat);
      return { released, managerReleased, result: { role: a.role, seat: a.seat, projectId: identity.projectId, task: null, sessionId: null, previousSessionId: current.session, revision: next, action: 'unassign', at, grantsAuthority: false, note: NO_AUTHORITY } };
    });
    this.unlinkGrant(outcome.released); this.unlinkGrant(outcome.managerReleased);
    return outcome.result;
  }
  // PROPOSAL.md §5 originally proposed a `bindings-restore` operator route here: one call that re-delegated
  // and reissued a seat's capability at an unchanged revision, so an accidental permission answer was cheap
  // to undo. Independent review (B-REVIEW.md, F1) showed it was a SECOND restart route that bypassed the
  // boot gate entirely -- across a daemon restart it minted a working capability with no inspect at all, and
  // it laundered away a human takeover that happened before the restart. REMOVED by prime decision.
  //
  // The same-boot case it was meant to serve is already covered by the ordinary operator sequence: handback,
  // then bindings-grant (which calls issueRole). Re-establishing a seat ACROSS a restart is deliberately not
  // here: that is the boot re-establishment gate's single responsibility, and a second route to it is exactly
  // the thing that must not exist.
  // Read-only adoption plan. It refreshes nothing, writes nothing and contacts no native runtime.
  // The installed pinned native exposes no operation that changes a running agent's mcpServers or
  // toolPolicy, so there is no in-place adoption today: a retained session reaches the role tools only
  // through a native build that exposes refreshAgentMcp, which this repo already treats as conditional
  // (native-release-hooks.mjs, book/stage.mjs). Do not assume that operation can carry an environment or
  // policy change until its own source says so.
  activation() {
    const held = new Map();
    for (const r of this.db.prepare('SELECT role,seat,session FROM role_bindings WHERE session IS NOT NULL ORDER BY role,seat').all()) {
      const s = this.store.get(r.session); if (!s) continue;
      const entry = held.get(s.id) ?? { sessionId: s.id, task: s.task, cwd: s.cwd, mode: s.mode, generation: s.generation, seats: [] };
      entry.seats.push({ role: r.role, seat: r.seat }); held.set(s.id, entry);
    }
    const sessions = [...held.values()].map(entry => {
      const base = path.basename(entry.cwd), expected = uuid(base) ? path.join(this.grantDirectory, base + '.json') : null;
      const created = this.db.prepare("SELECT result FROM deliveries WHERE kind='create' AND state='delivered' AND json_extract(result,'$.id')=?").get(entry.sessionId);
      // Recorded at creation, so a session born before the role environment existed is identifiable rather than guessed.
      // REVIEW-H6 F3: a surface refreshed to this release's (item 5) carries ORCA_ROLE_FILE and every role tool, so it is
      // evidence of the environment too. The creation receipt stays as history (bornWith).
      const surface = this.control.tools?.describe(entry.sessionId) ?? null;
      const bornWith = created ? JSON.parse(created.result).roleToolsVersion === '1' : null;
      const born = bornWith === true || surface?.state === 'current' ? true : bornWith;
      const credential = this.db.prepare('SELECT generation FROM role_credentials WHERE session=?').get(entry.sessionId) ?? null;
      const reach = this.dispatch(entry.sessionId), needs = [];
      if (!expected) needs.push('session-directory-identity');
      if (!reach.supported) needs.push('local-dispatch');
      if (born !== true) needs.push(born === null ? 'tool-environment-unrecorded' : 'tool-environment-adoption');
      if (entry.mode !== 'delegated') needs.push('delegation');
      if (surface && surface.state !== 'current') needs.push('tool-surface-refresh');
      if (!credential || credential.generation !== entry.generation) needs.push('role-capability');
      return { ...entry, expectedRoleFile: expected, grantFilePresent: Boolean(expected) && fs.existsSync(expected),
        toolEnvironment: born === null ? 'unrecorded' : born ? 'present' : 'absent', toolEnvironmentAtCreation: bornWith === null ? 'unrecorded' : bornWith ? 'present' : 'absent', toolSurface: surface,
        credential: credential ? { generation: credential.generation, current: credential.generation === entry.generation } : null,
        dispatch: reach, needs, usable: needs.length === 0 };
    });
    return { grantDirectory: this.grantDirectory, sessions,
      steps: [
        'toolEnvironment "present": run bindings-grant {sessionId, expectedGeneration} and confirm the returned grantFile equals expectedRoleFile. The tools work on the session next turn. Nothing is refreshed and no session is touched.',
        'toolEnvironment "absent" or "unrecorded" (need tool-surface-refresh): the running MCP configuration predates ORCA_ROLE_FILE or this release\u2019s tools. Bring it up to date in place with sessions-refresh-tools {sessionId, expectedGeneration} while the session is delegated and idle (a reaffirmation or handback of a seat does it too). The daemon refreshes only the orca-supervisor server and the tool policy and keeps the session\u2019s history; it needs the controller\u2019s client SDK to carry agent.mcp.refresh (H6 re-pin).',
        'If the refresh is refused (busy, unsupported, not resident), read sessions-tool-surface for the reason and retry when idle. A newly created session is the fallback: it is born with the current surface but is a new identity without the retained timeline, so that remains an operator decision.',
        'Revocation needs no refresh either way. A human takeover bumps the generation and the role capability dies with it; issue a new one with bindings-grant after the next handback.',
      ],
      note: 'A read-only plan. Naming a grant path grants no role, and no role tool works until an operator runs bindings-grant. This call refreshes nothing and deploys nothing.' };
  }
  primes() { return this.db.prepare("SELECT seat FROM role_bindings WHERE role='prime' ORDER BY seat").all().map(r => this.describe('prime', r.seat)); }
  directory() {
    const rows = this.db.prepare('SELECT role,seat FROM role_bindings ORDER BY role,seat').all();
    return { bindings: rows.map(r => this.describe(r.role, r.seat)),
      history: this.db.prepare('SELECT id,role,seat,projectId,task,action,previousSession,session,previousRevision,revision,note,at FROM role_binding_history ORDER BY rowid DESC LIMIT 50').all(),
      // Every declared hold, effective or not, so a hold an operator made is never invisible.
      holds: this.db.prepare('SELECT role,seat,revision,session,note,at FROM seat_human_holds ORDER BY role,seat,revision').all().map(h => ({ ...h, effective: this.heldBy(h.role, h.seat)?.revision === h.revision })),
      capacity: { bindings: rows.length, bindingLimit: 512, history: this.db.prepare('SELECT count(*) n FROM role_binding_history').get().n, historyLimit: 5000 },
      programme: PROGRAMME, note: NO_AUTHORITY };
  }
  // Per-task journal facts. The caller decides which tasks are members; this never infers membership.
  taskFacts(task) {
    const sessions = this.db.prepare('SELECT id,task,cwd,mode,generation FROM sessions WHERE task=? ORDER BY rowid LIMIT 256').all(task);
    const work = this.control.history(task), byState = {};
    for (const w of work) byState[w.state] = (byState[w.state] ?? 0) + 1;
    return { taskId: task, sessions, work, byState, unresolved: work.filter(w => UNRESOLVED.includes(w.state)), truncated: work.length >= 1000 || sessions.length >= 256 };
  }
  // Clicking a project. Membership comes from the project source; the journal supplies only recorded work.
  async projection(projectId, directory) {
    if (!uuid(projectId)) throw Error('Invalid project');
    const d = directory ?? await this.readProjects();
    const leader = this.describe('project-orchestrator', projectId), primes = this.primes();
    const summary = d.available ? d.projects.find(p => p.id === projectId) ?? null : null;
    const known = d.available && summary !== null;
    const allMembers = known ? [...new Set(d.membership.filter(m => m.projectId === projectId).map(m => m.taskId))] : [];
    const members = allMembers.slice(0, MEMBER_TASK_LIMIT);
    const facts = members.map(task => this.taskFacts(task));
    const needed = [], blockers = [];
    const membership = { known, available: d.available, partial: d.partial || allMembers.length > MEMBER_TASK_LIMIT, observedAt: d.observedAt,
      memberTasks: members, memberTaskCount: allMembers.length, truncated: allMembers.length > MEMBER_TASK_LIMIT, note: d.note };
    if (!d.available) blockers.push({ kind: 'project-source-unavailable', detail: 'The project directory could not be read, so membership and aggregate progress are unknown. Recorded role bindings are still shown.' });
    else if (!summary) blockers.push({ kind: 'unknown-project', detail: d.projects.length ? 'This project is not in the current company project directory' : 'This installation records no project directory, so project membership is unsupported here' });
    if (leader.state !== 'assigned') needed.push({ kind: 'no-project-orchestrator', detail: 'This project has no assigned leader. Assign one with bindings-assign; it does not start or delegate a session.' });
    if (leader.state === 'assigned' && !leader.sessionPresent) blockers.push({ kind: 'leader-session-missing', sessionId: leader.sessionId, detail: 'The bound leader session is no longer saved in the journal' });
    if (leader.state === 'assigned' && leader.sessionPresent && !leader.sessionTaskMatches) blockers.push({ kind: 'leader-task-changed', sessionId: leader.sessionId, detail: 'The bound leader session is now enrolled on a different task than the one whose membership was verified' });
    if (leader.state === 'assigned' && known && !members.includes(leader.task)) blockers.push({ kind: 'leader-membership-changed', sessionId: leader.sessionId, task: leader.task, detail: 'The leader task is no longer a recorded member of this project' });
    if (leader.state === 'assigned' && !known) needed.push({ kind: 'leader-membership-unverified', sessionId: leader.sessionId, task: leader.task, detail: 'The recorded leader is shown from the journal; its project membership could not be re-verified' });
    if (!primes.some(p => p.state === 'assigned')) needed.push({ kind: 'no-prime', detail: 'No prime seat is filled, so this project has no recorded escalation address' });
    for (const f of facts) for (const s of f.sessions) {
      if (!this.control.roleSessions) continue;
      const owner = this.control.roleSessions.describeOwnership(s.id);
      if (owner.ownership === 'unknown') needed.push({ kind: 'unowned-session', taskId: f.taskId, sessionId: s.id, detail: 'This session is on a member task but records no owning project. It is shown as unknown rather than attached to this project.' });
      else if (owner.ownership === 'declared') needed.push({ kind: 'declared-session-unled', taskId: f.taskId, sessionId: s.id, detail: 'This session is owned by the project but records no leader. An operator can adopt it into the project orchestrator seat with roles-adopt.' });
    }
    const coverage = { supervision: this.has('event_links'), permissions: Boolean(this.control.permissions) && this.has('permission_grants'), leadership: this.has('leadership_handoffs') };
    const decisions = this.db.prepare('SELECT id,role,seat,projectId,task,action,previousSession,session,previousRevision,revision,note,at FROM role_binding_history WHERE seat=? OR projectId=? ORDER BY rowid DESC LIMIT 20').all(projectId, projectId).map(h => ({ kind: 'role-binding', ...h }));
    for (const f of facts) {
      for (const w of f.unresolved) blockers.push({ kind: 'unresolved-delivery', taskId: f.taskId, deliveryId: w.id, sessionId: w.session, state: w.state, detail: 'Recorded work has no confirmed outcome; it needs recover or an explicit evidence-backed disposition' });
      const ids = f.sessions.map(s => s.id), placeholders = ids.map(() => '?').join(',');
      if (!ids.length) continue;
      if (coverage.supervision) {
        for (const x of this.db.prepare(`SELECT worker,reason,at FROM event_faults WHERE worker IN (${placeholders})`).all(...ids)) blockers.push({ kind: 'worker-fault', taskId: f.taskId, sessionId: x.worker, detail: x.reason.slice(0, 500), at: x.at });
        for (const e of this.db.prepare(`SELECT id,worker,supervisor,kind,at FROM event_inbox WHERE supervisor IN (${placeholders}) AND consumed IS NULL ORDER BY rowid DESC LIMIT 20`).all(...ids)) needed.push({ kind: 'unread-supervisor-event', taskId: f.taskId, eventId: e.id, sessionId: e.supervisor, workerId: e.worker, detail: `Unconsumed ${e.kind} event`, at: e.at });
      }
      if (coverage.permissions) for (const s of f.sessions) for (const p of this.control.permissions.status(s.id).pending) needed.push({ kind: 'pending-permission', taskId: f.taskId, sessionId: p.sessionId, permissionId: p.id, state: p.state, detail: 'A permission request is awaiting a decision' });
      if (coverage.leadership) for (const h of this.db.prepare(`SELECT id,source,destination,state,consumed,at FROM leadership_handoffs WHERE destination IN (${placeholders}) ORDER BY rowid DESC LIMIT 10`).all(...ids)) {
        if (h.state === 'pending') needed.push({ kind: 'unconsumed-leadership-handoff', taskId: f.taskId, handoffId: h.id, sessionId: h.destination, detail: 'A leadership handoff has been delivered but not acknowledged', at: h.at });
        decisions.push({ kind: 'leadership-handoff', id: h.id, task: f.taskId, action: h.state, previousSession: h.source, session: h.destination, note: (h.consumed ?? '').slice(0, 500), at: h.at });
      }
      for (const t of this.db.prepare(`SELECT id,session,generation,mode,reason,at FROM transfers WHERE session IN (${placeholders}) ORDER BY rowid DESC LIMIT 20`).all(...ids)) decisions.push({ kind: 'control-transfer', id: t.id, task: f.taskId, action: t.mode, session: t.session, revision: t.generation, note: t.reason.slice(0, 500), at: t.at });
    }
    decisions.sort((x, y) => String(y.at).localeCompare(String(x.at)));
    const byState = {};
    for (const f of facts) for (const [state, n] of Object.entries(f.byState)) byState[state] = (byState[state] ?? 0) + n;
    return {
      project: { id: projectId, summary, membership },
      leader, primes,
      tasks: facts.map(f => ({ taskId: f.taskId,
        // Every session under a member task carries its recorded owner, or an explicit unknown. Nothing
        // here reads a title or attaches a session to a project it was not created under.
        sessions: f.sessions.map(s => ({ ...s, owner: this.control.roleSessions?.describeOwnership(s.id) ?? null })),
        recorded: f.work.length, unresolved: f.unresolved.length, byState: f.byState, truncated: f.truncated })),
      // Aggregate only over tasks the project source confirmed. Unknown membership yields null, never zero.
      progress: known ? { memberTasks: members.length, recorded: facts.reduce((n, f) => n + f.work.length, 0), byState,
        unresolved: facts.reduce((n, f) => n + f.unresolved.length, 0), sessions: facts.reduce((n, f) => n + f.sessions.length, 0),
        truncated: membership.truncated || facts.some(f => f.truncated),
        basis: 'Counts of recorded controller deliveries across the tasks this project source confirmed as members. Journal activity, not a measure of work completed or independently accepted.' } : null,
      needed, blockers, decisions: decisions.slice(0, 40), coverage,
      note: NO_AUTHORITY };
  }
  route(a) {
    if (!keys(a, 'role,seat') || !ROLES.includes(a.role)) throw Error('Invalid role route');
    const b = this.describe(a.role, a.seat);
    // N3: deliverable must agree with what channels-open and channels-send will actually accept, so host
    // reachability belongs in it rather than being reported alongside and ignored.
    const deliverable = b.state === 'assigned' && b.sessionPresent && b.sessionTaskMatches && b.session.mode === 'delegated' && Boolean(b.dispatch?.supported);
    const held = Boolean(this.heldBy(a.role, a.seat));
    const blocked = deliverable ? null
      : b.state !== 'assigned' ? 'That seat holds no current role binding'
      : !b.sessionPresent ? 'The bound session is no longer saved in the journal'
      : !b.sessionTaskMatches ? 'The bound session is now enrolled on a different task than the one recorded for this seat'
      : held ? 'The bound session is under human control and the seat is declared human-held: a channel message to it is recorded held for the operator inbox, never dispatched into the session'
      : b.session.mode !== 'delegated' ? 'The bound session is under human control; a delegated send would be refused'
      : b.dispatch?.reason ?? 'The bound session is not currently reachable for dispatch';
    return { ...b, routing: { deliverable, blocked, held,
      inbox: held ? 'seat-inbox then seat-receipt or seat-reply (operator); a reply answers one specific held message and is labelled operator-for-human-held-seat' : null,
      operator: deliverable ? 'management-prepare then operator-send' : null,
      // A seat holder reaches the other seat only through a channel the operator approved for that pair.
      seatToSeat: deliverable ? 'channels-open (operator), then channels-send by either seat holder' : null,
      requires: ['for the operator route: operator capability and a prepared management fingerprint', 'for the seat-to-seat route: an open channel pinned to both current seat revisions', 'either way the recipient is delegated and its own task authority is unchanged when the send is admitted'],
      // event_links require worker.task === supervisor.task, so supervision itself never spans tasks.
      crossTask: 'Supervision links are same-task only. A prime seat sits on the programme root and a project orchestrator on a member task. A channel lets those two seats exchange text through the ordinary send path without granting either any authority over the other task; it is not a supervision link and confers no control, creation, permission or artifact access.' } };
  }
  // Scoped read for a delegated session: its own seats plus the recorded escalation address.
  self(sessionId, capability) {
    const row = this.checkRole(sessionId, capability);
    const mine = this.db.prepare('SELECT role,seat FROM role_bindings WHERE session=? ORDER BY role,seat').all(row.id).map(r => this.describe(r.role, r.seat));
    return { sessionId: row.id, task: row.task,
      roles: mine.map(b => ({ role: b.role, seat: b.seat, projectId: b.projectId, task: b.task, revision: b.revision, at: b.at, note: b.note })),
      // Identities only. A seat address confers no capability; the recipient's own delegation still gates every send.
      primes: this.primes().filter(p => p.state === 'assigned').map(p => ({ seat: p.seat, sessionId: p.sessionId, task: p.task, at: p.at })),
      // A seat alone never carries a message. Messaging needs a separately approved channel.
      send: { available: false, reason: 'A role binding is an address, not a route. Read channels-list for any operator-approved channel this session may send on, and channels-send to use one.', method: 'channels-list' },
      note: NO_AUTHORITY };
  }
}
