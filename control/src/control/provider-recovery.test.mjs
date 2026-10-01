// H7 items 3-4 (provider-recovery.mjs): a delegated session whose provider runtime broke is restarted in place with its
// history by the controller, and its interrupted instruction continued once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FENCE_PROTOCOL } from './native-fence.mjs';
import { ControlStore } from './store.mjs';
import { Controller } from './controller.mjs';
import { rpc } from './rpc.mjs';
import { COMPANY, PROGRAMME } from './authority.mjs';
import { ProviderRecovery, classify, MAX_ATTEMPTS, MAX_RECOVERIES_PER_DAY, BACKOFF_MS, QUOTA_POLL_MS } from './provider-recovery.mjs';

const T = n => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
const issue = id => ({ id, companyId: COMPANY, parentId: id === PROGRAMME ? null : PROGRAMME, assigneeUserId: 'local-board', assigneeAgentId: null, status: 'in_progress' });
const at = s => Date.parse(s);
// The daemon log's own text, 26 Sep (key redacted there too).
const LIVE_401 = 'unexpected status 401 Unauthorized: Incorrect API key provided: sk-***fvMA. You can find your API key at https://platform.openai.com/account/api-keys., url: https://chatgpt.com/backend-api/codex/responses';
const EXPLICIT = 'MCP refresh failed; explicit close recovery required';

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-provider-recovery-')));
  const store = new ControlStore(path.join(dir, 'journal.sqlite'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const sent = [], states = new Map(), snaps = new Map(), recovers = [], completions = new Map(), quota = { reading: null };
  const clock = { now: at('2026-09-26T09:41:00Z') };
  const native = { route: () => undefined,
    inspect: async id => ({ boot: 'boot-1', fenceProtocol: FENCE_PROTOCOL, saturated: false, humanAt: 0, status: 'idle', pending: 0, lastPromptId: null, timelineCursor: { epoch: 'e', seq: 1 }, ...(states.get(id) ?? {}) }),
    send: async (id, text, messageId) => { sent.push({ id, text, messageId }); states.set(id, { ...(states.get(id) ?? {}), lastPromptId: messageId }); },
    snapshot: async id => ({ id, provider: 'codex', status: 'idle', lastError: null, pendingPermissions: [], ...(snaps.get(id) ?? {}) }),
    completion: async (id, messageId) => completions.get(messageId) ?? { ended: false, progress: {} },
    quota: async () => quota.reading,
    // The continuation after a restart goes through send's own quota fence, which reads real time; this fixture's reading
    // is stamped with the test clock, so the restart clears it and the continuation takes the unmeasured path.
    recover: async id => { recovers.push(id); quota.reading = null; const r = native.recoverResult ?? { outcome: 'refreshed', reason: null }; if (r.outcome === 'refreshed') snaps.set(id, { ...(snaps.get(id) ?? {}), status: 'idle' }); return r; } };
  const control = new Controller({ store, native, authority: async id => issue(id) });
  control.providerRecovery = new ProviderRecovery(control, { now: () => clock.now });
  const enrol = () => { const id = randomUUID(); store.created(id, T(1), path.join(dir, 'tasks', id)); return id; };
  // A delegated Codex worker running a controller instruction, then failed.
  const failing = async (error, provider = 'codex') => {
    const id = enrol(); await control.handback(id, 'Delegated for the provider-recovery verification');
    const m = randomUUID(); await control.send({ sessionId: id, messageId: m, text: 'Build C2 and report.' }, undefined, store.get(id).generation, { automated: 'test' });
    sent.length = 0; snaps.set(id, { provider, status: 'error', lastError: error }); return { id, instruction: m };
  };
  const rows = id => store.db.prepare('SELECT * FROM provider_recoveries WHERE session=? ORDER BY rowid').all(id);
  return { dir, store, control, native, sent, states, snaps, recovers, completions, quota, clock, enrol, failing, rows, pr: control.providerRecovery, request: rpc(control, 'test-operator') };
}
const later = (f, ms) => { f.clock.now += ms; return f.pr.tick(); };

test('classify: the live 401, a lost app-server or binary, explicit close recovery, a Codex usage limit -- and nothing else', () => {
  assert.equal(classify({ provider: 'codex', status: 'error', lastError: LIVE_401 }), 'auth');
  assert.equal(classify({ provider: 'codex', status: 'error', lastError: 'Codex app-server exited with code 1 and signal null\nError: failed to initialize sqlite state runtime under /Users/x/.codex' }), 'auth');
  assert.equal(classify({ provider: 'codex', status: 'error', lastError: 'Codex binary not found. Install the Codex CLI' }), 'auth');
  assert.equal(classify({ provider: 'claude', status: 'error', lastError: EXPLICIT }), 'refresh');
  assert.equal(classify({ provider: 'codex', status: 'error', lastError: EXPLICIT }), 'refresh');
  assert.equal(classify({ provider: 'codex', status: 'error', lastError: "You've hit your usage limit. Try again at 4:32 PM." }), 'quota');
  assert.equal(classify({ provider: 'codex', status: 'error', lastError: 'stream error: 429 Too Many Requests' }), 'quota');
  for (const a of [{ provider: 'claude', status: 'error', lastError: LIVE_401 }, { provider: 'codex', status: 'idle', lastError: LIVE_401 }, { provider: 'codex', status: 'error', lastError: 'TypeError: x is undefined' }, { provider: 'codex', status: 'error', lastError: null }])
    assert.equal(classify(a), null, JSON.stringify(a));
});
test('the live 401: restarted in place once (not human input), and the interrupted instruction continued once', async t => {
  const f = fixture(t), { id } = await f.failing(LIVE_401);
  await f.pr.onAgent({ id, provider: 'codex', status: 'error', lastError: LIVE_401 });
  assert.deepEqual(f.rows(id).map(r => [r.kind, r.state]), [['auth', 'waiting']]);
  await f.pr.tick(); assert.equal(f.recovers.length, 0, 'not before the first backoff');
  await later(f, BACKOFF_MS[0]);
  assert.deepEqual(f.recovers, [id]);
  assert.equal(f.store.get(id).mode, 'delegated', 'no takeover: the restart is not human input');
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /stopped at a provider failure, and the controller restarted it with its history/); assert.match(f.sent[0].text, /do NOT repeat an external action/);
  const r = f.rows(id)[0]; assert.equal(r.state, 'recovered'); assert.equal(r.continuation, f.sent[0].messageId); assert.match(r.outcome, /continuation delivered/);
  await later(f, 3600000); await f.pr.onAgent({ id, provider: 'codex', status: 'error', lastError: LIVE_401 });
  assert.equal(f.recovers.length, 1); assert.equal(f.sent.length, 1, 'once');
});
test('a failed tool refresh is restarted with no continuation; an auth stop is continued even if its turn reads as ended', async t => {
  const f = fixture(t), { id } = await f.failing(EXPLICIT, 'claude');
  await f.pr.observe(id); await later(f, BACKOFF_MS[0]);
  assert.deepEqual([f.recovers.length, f.sent.length, f.rows(id)[0].state], [1, 0, 'recovered']);
  const g = fixture(t), w = await g.failing(LIVE_401);
  g.completions.set(w.instruction, { ended: true, interrupted: false, progress: {} });   // the failure ended the turn
  await g.pr.observe(w.id); await later(g, BACKOFF_MS[0]);
  assert.deepEqual([g.recovers.length, g.sent.length], [1, 1]);
});
test('review H7 B2: the same failure again, after the session was seen out of it, is a new episode; a persisting one is not', async t => {
  const f = fixture(t), { id } = await f.failing(EXPLICIT, 'claude');
  await f.pr.observe(id); await later(f, BACKOFF_MS[0]);
  assert.equal(f.recovers.length, 1);
  // Still reported in the same error (no update out of it yet): the same episode, nothing more.
  f.snaps.set(id, { provider: 'claude', status: 'error', lastError: EXPLICIT }); await f.pr.observe(id); await later(f, BACKOFF_MS[0]);
  assert.equal(f.recovers.length, 1);
  // It recovered (an update shows it out of the error), then the next tool refresh failed the same way: recovered again.
  await f.pr.onAgent({ id, provider: 'claude', status: 'idle', lastError: null });
  f.snaps.set(id, { provider: 'claude', status: 'error', lastError: EXPLICIT }); await f.pr.onAgent({ id, provider: 'claude', status: 'error', lastError: EXPLICIT });
  await later(f, BACKOFF_MS[0]);
  assert.equal(f.recovers.length, 2); assert.deepEqual(f.rows(id).map(r => [r.episode, r.state]), [[0, 'recovered'], [1, 'recovered']]);
  // A failure seen while human-held is recovered after the handback (a new generation, a new episode).
  const g = fixture(t), h = await g.failing(LIVE_401);
  g.control.takeover(h.id, 'The human took the worker'); await g.pr.observe(h.id); assert.equal(g.rows(h.id)[0].state, 'held');
  await g.control.handback(h.id, 'The operator handed the worker back'); await g.pr.observe(h.id); await later(g, BACKOFF_MS[0]);
  assert.equal(g.recovers.length, 1); assert.deepEqual(g.rows(h.id).map(r => r.state), ['held', 'recovered']);
});
test('a Codex usage limit waits for a FRESH reading that permits usage, then restarts and continues', async t => {
  const f = fixture(t), { id } = await f.failing("You've hit your usage limit. Try again at 4:32 PM.");
  const reading = allowed => ({ provider: 'codex', sessionId: 'thread-1', model: 'gpt-6-astra', serviceTier: null, accountScope: 'codex:' + 'a'.repeat(64),
    observedAt: new Date(f.clock.now).toISOString(), ordinaryUsageAllowed: allowed, limits: [] });
  await f.pr.observe(id);
  f.quota.reading = reading(false); await later(f, BACKOFF_MS[0]);
  assert.equal(f.recovers.length, 0); assert.match(f.rows(id)[0].outcome, /waiting for usage: Provider denies ordinary usage/);
  f.quota.reading = null; await later(f, QUOTA_POLL_MS); assert.equal(f.recovers.length, 0, 'an unreadable quota is not permission');
  f.clock.now += QUOTA_POLL_MS; f.quota.reading = reading(true); await f.pr.tick();
  assert.equal(f.recovers.length, 1); assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /its usage limit, which has now lifted/);
  assert.equal(f.rows(id)[0].attempts, 0, 'the polls were waiting, not failed restarts');
});
test('never a human’s session; human input before the restart revokes; a moved-on or re-delegated session is left alone', async t => {
  const f = fixture(t), a = await f.failing(LIVE_401);
  f.control.takeover(a.id, 'The human took the worker over'); await f.pr.observe(a.id);
  assert.equal(f.rows(a.id)[0].state, 'held'); await later(f, BACKOFF_MS[0]); assert.equal(f.recovers.length, 0);
  const b = await f.failing(LIVE_401); await f.pr.observe(b.id);
  f.states.set(b.id, { ...f.states.get(b.id), humanAt: 1 }); await later(f, BACKOFF_MS[0]);
  assert.equal(f.recovers.length, 0); assert.equal(f.store.get(b.id).mode, 'human'); assert.equal(f.rows(b.id)[0].state, 'held');
  const c = await f.failing(LIVE_401); await f.pr.observe(c.id);
  f.snaps.set(c.id, { provider: 'codex', status: 'idle' }); await later(f, BACKOFF_MS[0]);
  assert.equal(f.rows(c.id)[0].state, 'superseded');
  const d = await f.failing(LIVE_401); await f.pr.observe(d.id);
  f.control.takeover(d.id, 'The operator took the worker over'); await f.control.handback(d.id, 'The operator handed the worker back');
  await later(f, BACKOFF_MS[0]); assert.equal(f.rows(d.id)[0].state, 'superseded'); assert.equal(f.recovers.length, 0);
});
test('bounded: a refusing host is retried with backoff then given up; at most MAX_RECOVERIES_PER_DAY a day', async t => {
  const f = fixture(t), { id } = await f.failing(LIVE_401);
  f.native.recoverResult = { outcome: 'refused', reason: 'busy' };
  await f.pr.observe(id);
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) await later(f, BACKOFF_MS.at(-1));
  assert.equal(f.recovers.length, MAX_ATTEMPTS); assert.equal(f.rows(id)[0].state, 'failed'); assert.match(f.rows(id)[0].outcome, /host refused the restart: refused \(busy\); gave up after 5 attempts/);
  const g = fixture(t), w = await g.failing(LIVE_401 + ' #0');
  for (let i = 0; i < MAX_RECOVERIES_PER_DAY + 1; i++) {
    g.snaps.set(w.id, { provider: 'codex', status: 'error', lastError: LIVE_401 + ' #' + i }); await g.pr.observe(w.id); await later(g, BACKOFF_MS[0]);
  }
  assert.equal(g.recovers.length, MAX_RECOVERIES_PER_DAY); assert.equal(g.rows(w.id).at(-1).state, 'held-back');
});
test('wired: agent updates, the watchdog, recovery-status; a failed tool refresh queues its restart (static)', async t => {
  const f = fixture(t), { id } = await f.failing(LIVE_401); await f.pr.observe(id);
  const status = await f.request({ method: 'recovery-status', operator: 'test-operator' });
  assert.equal(status.providerRecovery.recoveries[0].kind, 'auth');
  const server = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  for (const s of ['control.providerRecovery = new ProviderRecovery(control)', 'void control.providerRecovery.onAgent(a);', 'void control.providerRecovery.tick();', 'control.providerRecovery.ticking']) assert.ok(server.includes(s), s);
  const tr = fs.readFileSync(new URL('./tool-refresh.mjs', import.meta.url), 'utf8');
  assert.match(tr, /this\.record\(id, s\.generation, 'failed', `\$\{cause\}: \$\{e\.message\}`, null\);[\s\S]{0,400}void this\.control\.providerRecovery\?\.observe\(id\);\s*throw e;/);
  const native = fs.readFileSync(new URL('./native.mjs', import.meta.url), 'utf8');
  assert.match(native, /refreshAgentMcp\(\{ agentId: id, expected: \{ provider: s\.provider, sessionId: s\.sessionId, configRevision: s\.configRevision \}, changes: \{\}, reconnect: true \}\)/);
});
