import { automaticMode, permissionMode, permissionToolId } from './automatic-permission.mjs';
import { isNativeAdmissionRefusal } from './trusted-native-input.mjs';
import { randomUUID } from 'node:crypto';
import { authorityKey, uuid } from './authority.mjs';
import { canonical, digest, evaluatePermission, ownedRoot, OutputSuperseded, TASK_ROOTS, verifyPermissionOutput } from './permission-policy.mjs';
import { permissionProjection } from './permission-projection.mjs';
// How many sessions may hold routine authority AT ONCE. Unchanged in value from the bound this replaces;
// what changed is that it now counts live grants instead of every row ever written.
export const LIVE_GRANT_LIMIT = 32;
// Retained history is not free. Revoked rows no longer occupy the live bound, so this is what stops the
// table growing without limit. It is deliberately far above the live bound: reaching it means an operator
// needs to prune, not that the installation is busy.
export const GRANT_HISTORY_LIMIT = 512;
export class Permissions {
  constructor(control, base = TASK_ROOTS, now = Date.now) {
    this.control = control; this.store = control.store; this.db = this.store.db; this.base = base; this.now = now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS permission_grants(session TEXT PRIMARY KEY,generation INTEGER NOT NULL,epoch TEXT NOT NULL,rootSession TEXT NOT NULL,rootEpoch TEXT NOT NULL,revoked INTEGER NOT NULL,reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS permission_intents(id TEXT PRIMARY KEY,identity TEXT UNIQUE NOT NULL,session TEXT NOT NULL,pool TEXT NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL,result TEXT,created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS permission_pool ON permission_intents(pool);`);
    // A controller crash can occur before or after provider invocation. Never resend either case.
    this.db.prepare("UPDATE permission_intents SET state='uncertain',result=? WHERE state='intent' AND pool NOT LIKE 'question:%'").run(canonical({ note: 'Controller restarted with unresolved native response; no retry', verification: 'unconfirmed' }));
    // H7 item 5: a question answer (questions.mjs) has its own states, so no routine-permission path ever reads one.
    this.db.prepare("UPDATE permission_intents SET state='answer-uncertain',result=? WHERE state='intent' AND pool LIKE 'question:%'").run(canonical({ note: 'Controller restarted with an unresolved question answer; no retry' }));
  }
  rows() { return this.db.prepare('SELECT * FROM permission_grants').all(); }
  // A grant row holds authority only while it is unrevoked AND its session is still the delegated session it
  // was issued to, at the same generation. binding() already refuses on exactly these facts, so a row that
  // fails here can never authorize anything again -- it is history.
  live(r) { const s = !r.revoked && this.store.get(r.session); return Boolean(s && s.mode === 'delegated' && s.generation === r.generation); }
  // THE FIX for the live failure. Capacity used to count every row ever written, including revoked ones, and
  // revoke only sets revoked=1 -- so capacity was consumed permanently and never reclaimed. On the live
  // journal that reached 21 unrevoked + 11 revoked = 32 and no new session could be granted again, ever.
  // Counting live rows makes the bound mean what it says: how many sessions may hold routine authority AT
  // ONCE. History is retained untouched; it simply stops occupying the bound.
  liveRows() { return this.rows().filter(r => this.live(r)); }
  capacity() {
    const total = this.db.prepare('SELECT count(*) n FROM permission_grants').get().n;
    return { live: this.liveRows().length, liveLimit: LIVE_GRANT_LIMIT, total, historyLimit: GRANT_HISTORY_LIMIT };
  }
  // R2. A superseded intent is the one outcome that is neither confirmed nor an incident, so repetition on
  // one pool must be readable without trawling the journal: an agent whose every write is superseded is
  // never content-verified, and that is a fact an operator should be able to see at a glance.
  supersededCount(pool) { return this.db.prepare("SELECT count(*) n FROM permission_intents WHERE pool=? AND state='superseded'").get(pool).n; }
  grantRow(id) { return this.db.prepare('SELECT * FROM permission_grants WHERE session=?').get(id); }
  binding(id) {
    const s = this.store.get(id), g = this.grantRow(id), root = g && this.grantRow(g.rootSession), rs = root && this.store.get(root.session);
    if (!s || s.mode !== 'delegated' || !g || g.revoked || g.generation !== s.generation || !root || root.revoked || root.epoch !== g.rootEpoch || root.rootSession !== root.session || !rs || rs.mode !== 'delegated' || rs.generation !== root.generation) throw Error('Routine grant revoked or ownership changed');
    const link = this.db.prepare('SELECT * FROM event_links WHERE worker=?').get(id); let supervision = null;
    if (link) {
      const manager = this.db.prepare('SELECT * FROM manager_grants WHERE supervisor=?').get(link.supervisor), worker = this.db.prepare('SELECT * FROM manager_workers WHERE worker=?').get(id);
      if (!this.control.events.valid(link) || !manager || manager.generation !== link.supervisorGeneration || worker?.supervisor !== link.supervisor || worker.epoch !== manager.epoch || worker.generation !== s.generation || worker.phase !== 'attached' || (g.rootSession !== id && g.rootSession !== link.supervisor)) throw Error('Routine parent authority changed');
      supervision = { supervisor: link.supervisor, managerEpoch: manager.epoch, linkEpoch: link.epoch };
    } else if (g.rootSession !== id) {
      // G9 (G-FIXES-REPORT.md): the second ownership link. A session a project orchestrator started through
      // role_start_session has no event link (it is not a manager worker), so every such worker came up with
      // "Inherited routine grant has no ownership link". Its ownership IS recorded at creation (session_ownership,
      // joined to the delivered create), with the orchestrator as parentSession. The link holds only while that
      // record names this pool's root as the parent AND the root still holds the seat the session was started
      // under: vacating or replacing the seat ends the workers' inherited authority, as a broken link does.
      const owner = this.control.roleSessions?.owner(id), seat = owner?.seat && this.db.prepare("SELECT session,state FROM role_bindings WHERE role='project-orchestrator' AND seat=?").get(owner.seat);
      if (!owner || owner.declaredBy !== 'project-orchestrator' || owner.parentSession !== g.rootSession || !seat || seat.state !== 'assigned' || seat.session !== owner.parentSession) throw Error('Inherited routine grant has no ownership link');
    }
    return { s, g, root, supervision };
  }
  async grant(a, parent) {
    this.control.native.assertLocal?.(parent);
    if (!a || Object.keys(a).sort().join() !== 'expectedGeneration,reason,sessionId' || !uuid(a.sessionId) || !Number.isSafeInteger(a.expectedGeneration) || typeof a.reason !== 'string' || a.reason.trim().length < 12 || a.reason.length > 2000) throw Error('Explicit routine grant required');
    const s = this.store.get(a.sessionId);
    if (!s || s.mode !== 'delegated' || s.generation !== a.expectedGeneration) throw Error('Grant requires unchanged delegated session');
    if(this.control.native.route?.(s.id))await this.control.native.remotePermissions.root(s.id);else ownedRoot(s.cwd,this.base);
    await this.control.inspect(s.id);
    if (authorityKey(await this.control.authority(s.task)) !== s.authority) throw Error('Task authority changed');
    if (parent) { await this.control.inspect(parent); this.binding(parent); }
    return this.store.atomic(() => {
      const fresh = this.store.get(s.id);
      if (fresh.mode !== 'delegated' || fresh.generation !== s.generation) throw Error('Control changed during routine grant');
      const old = this.grantRow(s.id);
      if (old && !old.revoked && old.generation === s.generation) { this.binding(s.id); return this.status(s.id); }
      const p = parent && this.binding(parent), epoch = randomUUID();
      if (p && p.root.session !== parent) throw Error('Nested inherited grants are not supported');
      // Two distinct bounds, because they answer two distinct questions. The live bound is the real one:
      // how many sessions may hold routine authority at once. The history bound stops the table growing
      // without limit now that revoked rows no longer fall out of the count -- it names retention rather
      // than pretending the installation is busy.
      // B1: the live bound must be consulted whenever this grant ADDS a live row, not merely when it adds a
      // row. Reaching here with `old` truthy means the existing row is non-live -- the live case returned
      // above -- so replacing it is a new live grant and must be counted. Guarding on `!old` alone let a
      // session holding a revoked row be re-granted straight past the bound, reaching live=33 against a
      // limit of 32 and, repeated, the 512 history bound. At d956718f the bound held only incidentally,
      // because total rows could never exceed 32 either; counting live rows removed that accident.
      if ((!old || !this.live(old)) && this.liveRows().length >= LIVE_GRANT_LIMIT) throw Error('Routine grant capacity reached');
      if (!old && this.db.prepare('SELECT count(*) n FROM permission_grants').get().n >= GRANT_HISTORY_LIMIT) throw Error('Routine grant history capacity reached; retention is required before another session can be granted');
      this.db.prepare('INSERT OR REPLACE INTO permission_grants VALUES (?,?,?,?,?,0,?)').run(s.id, s.generation, epoch, p ? p.root.session : s.id, p ? p.root.epoch : epoch, a.reason);
      this.binding(s.id); return this.status(s.id);
    });
  }
  async inherit(worker, parent) {
    try { this.binding(parent); } catch { return; }
    try { return await this.grant({ sessionId: worker, expectedGeneration: this.store.get(worker).generation, reason: 'Inherit the explicitly granted shared routine-file allowance' }, parent); }
    catch (e) { this.lastError = { sessionId: worker, message: 'Worker ready without routine authority: ' + e.message, at: new Date(this.now()).toISOString() }; return { active: false, reason: this.lastError.message }; }
  }
  revoke(a) {
    if (!a || Object.keys(a).sort().join() !== 'expectedGeneration,reason,sessionId' || typeof a.reason !== 'string' || a.reason.trim().length < 12 || a.reason.length > 2000 || this.store.get(a.sessionId)?.generation !== a.expectedGeneration) throw Error('Unchanged session and revocation reason required');
    // B2: revoking a ROOT must revoke the pool it roots. A child row carries its own epoch and points at the
    // root through rootSession/rootEpoch, so `WHERE session=?` left every child revoked=0 -- unable to
    // authorise (binding() checks root.revoked) yet still counted live by live(), which looks only at its own
    // row. That leaked one slot per still-delegated worker, per revoked pool: the exact permanent ratchet
    // this change exists to remove, on precisely the supervisor/worker configuration pools exist for.
    // Revoking a CHILD still revokes only that child -- rootSession names the parent, not itself.
    const g=this.grantRow(a.sessionId);
    this.db.prepare('UPDATE permission_grants SET revoked=1,reason=? WHERE session=? OR (rootSession=? AND rootEpoch=?)')
      .run(a.reason, a.sessionId, a.sessionId, g?.epoch ?? null);
    if(g)for(const row of this.db.prepare("SELECT * FROM permission_intents WHERE pool=? AND state IN ('intent','acknowledged','uncertain')").all(g.rootEpoch)) {
      if(this.control.native.route?.(row.session) && (g.rootSession===a.sessionId || row.session===a.sessionId)) this.result(row.id,'cancelling',{previous:JSON.parse(row.result??'{}'),note:'Local grant revoked; Book cancellation acknowledgement pending'});
    }
    return this.cancelPending().then(()=>this.status(a.sessionId));
  }
  async cancelPending() {
    for(const row of this.db.prepare("SELECT * FROM permission_intents WHERE state='cancelling'").all()) {
      try { const reply=await this.control.native.remotePermissions.cancel(row.session,row.id);this.db.prepare("UPDATE permission_intents SET state=?,result=? WHERE id=? AND state='cancelling'").run(reply.state==='cancelled'?'refused':'uncertain',canonical({remoteCancellation:reply,note:reply.state==='cancelled'?'Book cancellation acknowledged':'Already admitted on Book; actual output still requires verification'}),row.id); }
      catch(e) { this.db.prepare("UPDATE permission_intents SET result=? WHERE id=? AND state='cancelling'").run(canonical({note:'Book cancellation still pending: '+e.message}),row.id); }
    }
  }
  status(id) { return this.statusWith(id, {}); }
  // Track 1b: permissions-status called status() once per grant row, and each call recomputed capacity() (every grant
  // row plus a session read each: O(N^2)), the global intent count, and its pool's rows -- 8,955 SQLite calls per request
  // live. statusMany computes those request-invariant parts once and shares them; everything per row (binding() above)
  // is unchanged. status() is synchronous, so within one request both see the same journal state. taskId limits the
  // rows to the grants of sessions in that task (the Fulcra app's filter, applied before the work instead of after).
  statusMany(taskId) {
    const memo = {}, rows = this.rows();
    return (taskId === undefined ? rows : rows.filter(g => this.store.get(g.session)?.task === taskId)).map(g => this.statusWith(g.session, memo));
  }
  statusWith(id, memo) {
    const capacity = () => memo.capacity ??= this.capacity();
    // capacity is reported even for a session that holds no grant: the failure this fixes was invisible
    // precisely because nothing surfaced how much of the bound was occupied, or by what.
    const g = this.grantRow(id); if (!g) return { sessionId: id, active: false, remaining: 0, pool: null, reason: 'No routine-file grant', pending: [], recent: [], capacity: capacity() };
    let active = true, reason = g.reason; try { this.binding(id); } catch (e) { active = false; reason = e.message; }
    if ((memo.intents ??= this.db.prepare('SELECT count(*) n FROM permission_intents WHERE pool NOT LIKE \'question:%\'').get().n) >= 1000) { active = false; reason = 'Permission journal capacity reached; routine handling is suspended pending retention'; }
    const pools = memo.pools ??= new Map();
    if (!pools.has(g.rootEpoch)) pools.set(g.rootEpoch, { rows: this.db.prepare('SELECT id,session,state,result,created FROM permission_intents WHERE pool=? ORDER BY rowid DESC LIMIT 1000').all(g.rootEpoch), superseded: this.supersededCount(g.rootEpoch) });
    const { rows, superseded } = pools.get(g.rootEpoch);
    const pending = rows.filter(r => ['intent', 'uncertain','cancelling'].includes(r.state) || r.state === 'acknowledged').map(r => ({ id: r.id, sessionId: r.session, state: r.state }));
    return { sessionId: id, active, remaining: Math.max(0, 100 - rows.filter(r => r.state !== 'escalated').length), pool: g.rootSession, reason, pending, capacity: capacity(), superseded, recent: rows.filter(r => r.session === id).slice(0, 10).map(r => ({ id: r.id, state: r.state, result: r.result ? JSON.parse(r.result) : null })) };
  }
  result(id, state, result) { this.db.prepare('UPDATE permission_intents SET state=?,result=? WHERE id=?').run(state, canonical(result), id); }
  routineWaiting(id, request, snapshot) {
    try { const b = this.binding(id), status = this.status(id); const auto = automaticMode(snapshot?.provider, permissionMode(snapshot ?? {})); if (!status.active || !status.remaining || !auto && !status.pending.length) return false; if(this.control.native.route?.(id) && !auto)return this.control.native.remotePermissions.waiting(id,request);evaluatePermission(request, b.s.cwd, this.base, permissionMode(snapshot ?? {})); return true; }
    catch { return false; }
  }
  notify(id, kind, payload, wake) { const link = this.db.prepare('SELECT * FROM event_links WHERE worker=?').get(id); if (link && this.control.events.valid(link)) this.control.events.add(link, kind, [kind, payload.intentId], payload, wake); }
  incident(row, reason) {
    this.result(row.id, 'incident', { response: JSON.parse(row.result ?? '{}'), note: reason, verification: 'failed' });
    // B2, the same defect on the incident path. `row.pool` is the ROOT epoch, and only the root row has
    // epoch === rootEpoch, so `WHERE epoch=?` marked the root and left every child live-but-powerless.
    this.db.prepare('UPDATE permission_grants SET revoked=1,reason=? WHERE epoch=? OR rootEpoch=?').run('Routine verification incident: ' + reason, row.pool, row.pool);
    this.notify(row.session, 'permission-incident', { intentId: row.id, reason }, true);
  }
  // A `chained()` helper lived here: it confirmed an unverified call when a LATER approved intent in the
  // same pool recorded beforeHash === expectedHash for the same file. Independent review (GRANTS-REVIEW.md
  // H-3) showed it was unreachable in production -- reconcile refuses to create a second intent while the
  // pool has a pending one, and verification only ever runs on a pending row, so the witness it needs can
  // never exist -- and that two of its invariants (same pool, and later-ness) were untested, the second
  // unsound as mutated: bytes seen BEFORE the approved call say nothing about what that call produced.
  // REMOVED. A trust-granting path with no production trigger and untested ordering is worse than absent;
  // if the pool gate is ever relaxed, reintroduce it with those two tests, not without them.
  // The file changed after the approved call completed, but it is still the same owned regular file at the
  // same path identity with one link. That is a later write to a file this grant already permits writing --
  // ordinary work -- not an escape from the fence, so it does not revoke the pool.
  //
  // It is NOT recorded as verified: the approved output was never observed, and saying otherwise would be a
  // lie about evidence. It is recorded as superseded, with the digest that is actually on disk, and the
  // worker is notified so a real tamper can still be investigated from the journal.
  superseded(row, error) {
    this.result(row.id, 'superseded', { response: JSON.parse(row.result ?? '{}'), verification: 'superseded', observed: error.observed ?? null,
      note: 'The file changed after the approved tool call completed, so the approved bytes could not be observed. Path identity, link count and file type were unchanged, so this is a later write to the same owned file rather than a fence failure. The approved call itself remains unconfirmed.' });
    // R2. Not revoking is the approved fix; being SILENT was a separate choice that was not required.
    // Since every content mismatch now lands here, waking the supervisor is what keeps an agent that always
    // writes twice -- and is therefore never content-verified -- from being invisible.
    this.notify(row.session, 'permission-superseded', { intentId: row.id, observed: error.observed ?? null }, true);
  }
  async verifyPending() {
    await this.cancelPending();
    for (const row of this.db.prepare("SELECT * FROM permission_intents WHERE state IN ('acknowledged','uncertain') AND pool NOT LIKE 'question:%'").all()) {
      const body = JSON.parse(row.body);
      try {
        const current = await this.control.native.inspect(row.session);
        if (current.nativeIdentity?.conflict || !current.nativeId || !body.nativeId || current.boot !== body.boot || current.nativeId !== body.nativeId) throw Error('Native identity changed before tool verification');
        const result = await this.control.native.permissionResult(row.session, body.toolUseId, body.cursor,row.id);
        if (body.proof.kind === 'automatic-tool' && ['failed','error'].includes(result.state)) {
          this.result(row.id, 'tool-failed', { response: JSON.parse(row.result ?? '{}'), verification: 'tool-failed', tool: result, note: 'The permitted tool finished with an error; automatic authority is unchanged' });
        }
        else if (result.state === 'completed') {
          let output;
          try { output = this.control.native.route?.(row.session) ? result.output : (body.proof.kind === 'automatic-tool' ? { toolCompleted: true } : verifyPermissionOutput(body.proof)); }
          catch (e) {
            if (!(e instanceof OutputSuperseded)) throw e;
            this.superseded(row, e); continue;
          }
          this.result(row.id, 'verified', { response: JSON.parse(row.result ?? '{}'), verification: 'verified', output, tool: result }); this.notify(row.session, 'permission-verified', { intentId: row.id, output }, false);
        }
        else if (result.state !== 'pending' || (result.caughtUp && ['idle', 'closed', 'error'].includes(current.status)) || this.now() - row.created > 120000) throw Error('Tool verification ' + (result.state === 'pending' ? 'missing or past the 120-second deadline' : result.state));
        else this.db.prepare('UPDATE permission_intents SET body=? WHERE id=?').run(canonical({ ...body, cursor: result.cursor ?? body.cursor }), row.id);
      } catch (e) { if(this.control.native.route?.(row.session) && e.message.startsWith('Book receiver transport unavailable') && this.now()-row.created<=120000)continue;this.incident(row, e.message); }
    }
  }
  async reconcile(id) {
    let initial; try { initial = this.binding(id); } catch { return; }
    if (this.control.busy.has(id) || this.control.busy.has('permission-pool:' + initial.root.epoch)) return;
    return this.control.exclusive('permission-pool:' + initial.root.epoch, async () => {
      try {
        const observed = await this.control.inspect(id);
        if (initial.supervision) await this.control.inspect(initial.supervision.supervisor);
        if (authorityKey(await this.control.authority(observed.task)) !== observed.authority) throw Error('Task authority changed');
        if (observed.observed.nativeIdentity?.conflict || !observed.observed.nativeId) throw Error('Routine permission requires a resolved consistent native identity');
        const snapshot = await this.control.native.snapshot(id), b = this.binding(id);
        if (b.g.epoch !== initial.g.epoch || b.s.boot !== observed.observed.boot || b.s.expected !== observed.observed.lastPromptId) return;
        const origin = this.store.delivery(b.s.expected);
        if (origin?.kind !== 'send' || origin.session !== id || origin.state !== 'delivered') return;
        for (const request of snapshot.pendingPermissions ?? []) {
          const identity = digest(canonical([id, b.g.epoch, origin.id, request.id, request]));
          if (this.db.prepare('SELECT id FROM permission_intents WHERE identity=?').get(identity)) continue;
          if (this.db.prepare('SELECT count(*) n FROM permission_intents WHERE pool NOT LIKE \'question:%\'').get().n >= 1000) throw Error('Permission journal capacity reached');
          const intentId = randomUUID(), body = { generation: b.s.generation, boot: b.s.boot, nativeId: observed.observed.nativeId, nativeIdentity: observed.observed.nativeIdentity ?? null, origin: origin.id, authority: b.s.authority, grantEpoch: b.g.epoch, requestId: request.id, requestDigest: digest(canonical(permissionProjection(request))), expectedLastUserAt: observed.observed.lastUserAt, supervision: b.supervision, toolUseId: permissionToolId(request), cursor: observed.observed.timelineCursor };
          let proof;
          try { proof = this.control.native.route?.(id)?await this.control.native.remotePermissions.proof(id,request,body,intentId):evaluatePermission(request,b.s.cwd,this.base,permissionMode(snapshot)); }
          catch (e) { if(this.control.native.route?.(id) && !e.permissionPolicy)throw e; this.db.prepare("INSERT INTO permission_intents VALUES (?,?,?,?,'escalated','{}',?,?)").run(randomUUID(), identity, id, b.root.epoch, canonical({ requestId: request.id, note: e.message }), this.now()); continue; }
          const status = this.status(id); if (!status.active || !status.remaining || status.pending.length) return;
          const fresh = this.binding(id); if (fresh.g.epoch !== b.g.epoch || fresh.s.generation!==body.generation || fresh.s.expected!==body.origin) return;
          body.proof=proof;
          this.db.prepare("INSERT INTO permission_intents VALUES (?,?,?,?,'intent',?,NULL,?)").run(intentId, identity, id, b.root.epoch, canonical(body), this.now());
          try {
            const receipt = await this.control.native.permission(id, intentId);
            if (receipt?.agentId !== id || receipt.requestId !== 'orca-permission:' + intentId || receipt.resolution?.behavior !== 'allow') throw Error('Native permission acknowledgment uncorrelated');
            if(this.db.prepare('SELECT state FROM permission_intents WHERE id=?').get(intentId).state!=='intent')return;
            this.result(intentId, 'acknowledged', { verification: 'pending', receipt, note: 'Native response handler acknowledged; tool result still unverified' });
          }
          catch (e) { if(this.db.prepare('SELECT state FROM permission_intents WHERE id=?').get(intentId).state!=='intent')return;const refused = isNativeAdmissionRefusal(e); this.result(intentId, refused ? 'refused' : 'uncertain', { verification: 'unconfirmed', note: e.message }); this.notify(id, 'permission-unconfirmed', { intentId, reason: e.message }, true); }
          return; // At most one unverified response per shared pool; a runtime event triggers verification.
        }
      } catch (e) { this.lastError = { sessionId: id, message: e.message, at: new Date(this.now()).toISOString() }; }
    });
  }
}
