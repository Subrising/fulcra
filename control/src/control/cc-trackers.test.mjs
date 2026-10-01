// Fulcra J4: many tracker mappings per project, the one-time copy from J3's tracker_mappings, and persisted
// observations (CONTRACTS §7.1, §7.3), on the real controller over a temporary journal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlStore } from './store.mjs';
import { Controller } from './controller.mjs';
import { Trackers } from './trackers.mjs';
import { CcTrackers, CC_TRACKER_LIMITS } from './cc-trackers.mjs';
import { rpc } from './rpc.mjs';

const P = n => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
const T = n => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
const ACCOUNT = '55555555-5555-4555-8555-000000000001';
const source = { observedAt: '2026-09-24T00:00:00.000Z', available: true, partial: false, note: 'test',
  projects: [P(1), P(2)].map((id, n) => ({ id, name: `Project ${n}`, description: null, status: 'in_progress' })),
  membership: [{ taskId: T(1), projectId: P(1) }, { taskId: T(2), projectId: P(2) }] };
function open(file) {
  const store = new ControlStore(file);
  const native = new Proxy({}, { get: () => () => { throw Error('Trackers must not invoke the native runtime'); } });
  const control = new Controller({ store, native, authority: async () => ({ id: 'task', delegationAuthority: [] }) });
  control.trackers = new Trackers(control, async () => source);
  control.ccTrackers = new CcTrackers(control, { readProjects: async () => source });
  const request = rpc(control, 'test-operator');
  return { store, op: (method, input) => request({ method, input, operator: 'test-operator' }), request };
}
function setup(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-cc-trackers-'))), file = path.join(dir, 'journal.sqlite');
  const opened = open(file);
  t.after(() => { try { opened.store.db.close(); } catch { /* reopened */ } fs.rmSync(dir, { recursive: true, force: true }); });
  return { ...opened, file };
}
const github = (extra = {}) => ({ messageId: randomUUID(), projectId: P(1), connector: 'github', accountId: ACCOUNT, remoteId: '123456', remoteName: 'acme/app', site: null, note: '', expectedRevision: 0, ...extra });
const issue = (n, extra = {}) => ({ key: `issue:github:123456:${n}`, connector: 'github', kind: 'issue', ref: `#${n}`, title: `Issue ${n}`, state: 'open', url: `https://github.com/acme/app/issues/${n}`, updatedAt: new Date(Date.UTC(2026, 8, 1, 0, n)).toISOString(), assignee: null, labels: [], ...extra });

test('M1: mapping methods are operator-only', async t => {
  const { request } = setup(t);
  for (const method of ['cc-tracker-mappings', 'cc-tracker-map', 'cc-tracker-unmap', 'cc-tracker-legacy-pending', 'cc-tracker-import-legacy', 'cc-tracker-items-put', 'cc-tracker-items']) {
    await assert.rejects(request({ method, input: {}, capability: 'x'.repeat(43) }), /Operator authorization required/, method);
  }
});

test('M2: one project maps several trackers, but each remote only once while active', async t => {
  const { op } = setup(t);
  const a = await op('cc-tracker-map', github());
  const b = await op('cc-tracker-map', github({ remoteId: '777', remoteName: 'acme/site' }));
  const c = await op('cc-tracker-map', github({ connector: 'jira', remoteId: '10001', remoteName: 'ACME', site: 'acme.atlassian.net' }));
  assert.equal((await op('cc-tracker-mappings', { projectId: P(1) })).mappings.length, 3);
  await assert.rejects(op('cc-tracker-map', github()), /already mapped/);
  const off = await op('cc-tracker-unmap', { messageId: randomUUID(), id: a.mapping.id, expectedRevision: 1, note: '' });
  assert.equal(off.mapping.state, 'unmapped');
  await assert.rejects(op('cc-tracker-map', github({ expectedRevision: 0 })), /Changed since you looked; refresh/);
  const again = await op('cc-tracker-map', github({ expectedRevision: 2 }));
  assert.deepEqual([again.mapping.id, again.mapping.revision, again.mapping.state], [a.mapping.id, 3, 'mapped']);
  assert.deepEqual((await op('cc-tracker-mapping-history', a.mapping.id)).history.map(h => h.action), ['map', 'unmap', 'remap']);
  assert.ok(b.mapping.id && c.mapping.id);
});

test('M3: only GitHub may use the command-line login; everything else needs a connected account', async t => {
  const { op } = setup(t);
  const cli = await op('cc-tracker-map', github({ accountId: null }));
  assert.equal(cli.mapping.accountId, null);
  await assert.rejects(op('cc-tracker-map', github({ connector: 'jira', accountId: null, remoteId: '1', remoteName: 'ACME', site: 'acme.atlassian.net' })), /connected account/);
  await assert.rejects(op('cc-tracker-map', github({ projectId: P(9), remoteId: '9' })), /Unknown project/);
  await assert.rejects(op('cc-tracker-map', { ...github(), token: 'x' }), /Invalid tracker mapping/);
  await assert.rejects(op('cc-tracker-map', github({ remoteId: '8', note: `see /${'Users'}/someone` })), /personal data/);
});

test('M4: the J3 mapping is copied once, keeps its account decision, and the J3 row and RPCs are untouched', async t => {
  const { op, store } = setup(t);
  await op('trackers-map', { project: P(1), tracker: 'github', auth: 'keychain', site: 'github.com', remoteId: '123456', remoteName: 'acme/app', expectedRevision: 0, note: 'old', validatedAt: new Date().toISOString() });
  await op('trackers-map', { project: P(2), tracker: 'github', auth: 'gh-cli', site: 'github.com', remoteId: '777', remoteName: 'acme/site', expectedRevision: 0, note: 'old', validatedAt: new Date().toISOString() });
  const legacyBefore = JSON.stringify(store.db.prepare('SELECT * FROM tracker_mappings ORDER BY project').all());
  assert.deepEqual((await op('cc-tracker-legacy-pending')).pending.map(p => [p.projectId, p.auth]), [[P(1), 'keychain'], [P(2), 'gh-cli']]);
  await assert.rejects(op('cc-tracker-import-legacy', { messageId: randomUUID(), projectId: P(1), accountId: null }), /needs its imported account/);
  await assert.rejects(op('cc-tracker-import-legacy', { messageId: randomUUID(), projectId: P(2), accountId: ACCOUNT }), /command-line login/);
  const one = await op('cc-tracker-import-legacy', { messageId: randomUUID(), projectId: P(1), accountId: ACCOUNT });
  const two = await op('cc-tracker-import-legacy', { messageId: randomUUID(), projectId: P(2), accountId: null });
  assert.deepEqual([one.imported, one.mapping.connector, one.mapping.accountId, one.mapping.site, one.mapping.remoteName], [true, 'github', ACCOUNT, null, 'acme/app']);
  assert.deepEqual([two.imported, two.mapping.accountId], [true, null]);
  // Once only: a second import, even with another message, changes nothing.
  const repeat = await op('cc-tracker-import-legacy', { messageId: randomUUID(), projectId: P(1), accountId: ACCOUNT });
  assert.deepEqual([repeat.imported, repeat.mapping.id], [false, one.mapping.id]);
  assert.deepEqual((await op('cc-tracker-legacy-pending')).pending, []);
  assert.equal((await op('cc-tracker-mappings')).mappings.length, 2);
  assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM tracker_mappings ORDER BY project').all()), legacyBefore);
  assert.equal((await op('trackers-project', P(1))).mapping.state, 'mapped');
  assert.equal((await op('trackers-status')).mappings.length, 2);
});

test('M5: observations persist across a restart, rotate per mapping, and never store another repository', async t => {
  const { op, store, file } = setup(t);
  const { mapping } = await op('cc-tracker-map', github());
  const pr = { ...issue(17), key: 'pr:github:acme/app#17', kind: 'pr', ref: '#17', state: 'merged', url: 'https://github.com/acme/app/pull/17' };
  const foreign = [issue(5, { key: 'issue:github:999:5' }), { ...pr, key: 'pr:github:other/app#3' }, { ...issue(6), token: 'x' }, { ...issue(7), connector: 'jira' }];
  const put = await op('cc-tracker-items-put', { mappingId: mapping.id, observedAt: new Date().toISOString(), items: [issue(1), pr, ...foreign] });
  assert.deepEqual(put, { stored: 2, refused: 4, partial: true }, 'a refused item makes the observation partial');
  store.db.close();
  const reopened = open(file);
  t.after(() => { try { reopened.store.db.close(); } catch { /* closed */ } });
  const read = await reopened.op('cc-tracker-items', { projectId: P(1) });
  assert.deepEqual(read.items.map(i => i.item.key).sort(), ['issue:github:123456:1', 'pr:github:acme/app#17']);
  // Rotation keeps the newest N by update time and never refuses.
  const many = Array.from({ length: CC_TRACKER_LIMITS.itemsPerWrite }, (_, n) => issue(n + 100));
  for (let round = 0; round < 3; round++) await reopened.op('cc-tracker-items-put', { mappingId: mapping.id, observedAt: new Date().toISOString(), items: many.map(i => ({ ...i, key: i.key.replace(/:(\d+)$/, (_, n) => `:${Number(n) + round * 1000}`), updatedAt: new Date(Date.UTC(2026, 8, 2 + round)).toISOString() })) });
  assert.equal(reopened.store.db.prepare('SELECT count(*) n FROM cc_tracker_observations').get().n, CC_TRACKER_LIMITS.itemsPerMapping);
  // An unmapped tracker's observations are no longer shown, and new ones are refused.
  await reopened.op('cc-tracker-unmap', { messageId: randomUUID(), id: mapping.id, expectedRevision: 1, note: '' });
  assert.deepEqual((await reopened.op('cc-tracker-items', { projectId: P(1) })).items, []);
  await assert.rejects(reopened.op('cc-tracker-items-put', { mappingId: mapping.id, observedAt: new Date().toISOString(), items: [issue(1)] }), /not mapped/);
});

// ---- REVIEW-J4 -------------------------------------------------------------------------------------------------
const put = (op, mappingId, items, observation) => op('cc-tracker-items-put', { mappingId, observedAt: new Date().toISOString(), items, ...(observation ? { observation } : {}) });

test('R-E-2: provider text with personal data is refused at the storage boundary, and so is an unmap note', async t => {
  const { op } = setup(t);
  const { mapping } = await op('cc-tracker-map', github());
  const unsafe = [issue(1, { title: 'Mail someone@example.com about it' }), issue(2, { labels: ['bug', 'see /Users/someone/notes'] }), issue(3, { assignee: 'someone@example.com' }), issue(4, { url: 'https://github.com/acme/app/issues/4?who=someone@example.com' })];
  const r = await put(op, mapping.id, [...unsafe, issue(5)]);
  assert.deepEqual(r, { stored: 1, refused: 4, partial: true });
  assert.deepEqual((await op('cc-tracker-items', { projectId: P(1) })).items.map(i => i.item.key), ['issue:github:123456:5']);
  await assert.rejects(op('cc-tracker-unmap', { messageId: randomUUID(), id: mapping.id, expectedRevision: 1, note: 'Ask someone@example.com' }), /contains an email address/);
  assert.equal((await op('cc-tracker-mappings', { projectId: P(1) })).mappings[0].state, 'mapped');
});

test('R-E-3: two projects mapped to one repository each keep their own last observation', async t => {
  const { op } = setup(t);
  const a = (await op('cc-tracker-map', github())).mapping, b = (await op('cc-tracker-map', github({ projectId: P(2) }))).mapping;
  await put(op, a.id, [issue(1), issue(2)]);
  await put(op, b.id, [issue(1, { title: 'Seen by B' })]);
  const read = async p => (await op('cc-tracker-items', { projectId: p })).items.map(i => [i.item.key, i.item.title]).sort();
  assert.deepEqual(await read(P(1)), [['issue:github:123456:1', 'Issue 1'], ['issue:github:123456:2', 'Issue 2']], "B's refresh left A's observation alone");
  assert.deepEqual(await read(P(2)), [['issue:github:123456:1', 'Seen by B']]);
  await op('cc-tracker-unmap', { messageId: randomUUID(), id: b.id, expectedRevision: 1, note: '' });
  assert.equal((await read(P(1))).length, 2, 'unmapping B hides nothing of A');
});

test('R-E-5: a partial refresh keeps unseen items as the last copy; only a complete one removes what is gone', async t => {
  const { op } = setup(t);
  const { mapping } = await op('cc-tracker-map', github());
  const o = () => randomUUID();
  await put(op, mapping.id, [issue(1), issue(2)], { id: o(), partial: false, final: true });
  const current = async () => Object.fromEntries((await op('cc-tracker-items', { projectId: P(1) })).items.map(i => [i.item.ref, i.current]));
  assert.deepEqual(await current(), { '#1': true, '#2': true });
  await put(op, mapping.id, [issue(1)], { id: o(), partial: true, final: true });
  assert.deepEqual(await current(), { '#1': true, '#2': false }, 'unseen in a partial read: kept, not current');
  // Two chunks of one complete observation: nothing is removed until the final chunk.
  const whole = o();
  await put(op, mapping.id, [issue(3)], { id: whole, partial: false, final: false });
  assert.deepEqual(await current(), { '#1': false, '#2': false, '#3': true });
  await put(op, mapping.id, [issue(1)], { id: whole, partial: false, final: true });
  assert.deepEqual(await current(), { '#1': true, '#3': true }, 'a complete snapshot removes #2');
  // An empty complete snapshot empties the list; a caller without an observation never removes anything.
  await put(op, mapping.id, [issue(4)]);
  assert.equal((await current())['#1'], false);
  await put(op, mapping.id, [], { id: o(), partial: false, final: true });
  assert.deepEqual(await current(), {});
});

test('R-E-10: a Bitbucket legacy import gets the bare lower-case UUID the new connector uses', async t => {
  const { op } = setup(t);
  const UUID = '00000000-0000-4908-8706-000000002005';   // J3 stores Bitbucket's form: lower case, in braces
  await op('trackers-map', { project: P(1), tracker: 'bitbucket', auth: 'keychain', site: 'bitbucket.org', remoteId: `{${UUID}}`, remoteName: 'acme/web', expectedRevision: 0, note: 'old', validatedAt: new Date().toISOString() });
  const r = await op('cc-tracker-import-legacy', { messageId: randomUUID(), projectId: P(1), accountId: ACCOUNT });
  assert.deepEqual([r.mapping.connector, r.mapping.remoteId, r.mapping.site], ['bitbucket', UUID.toLowerCase(), null]);
  const stored = await put(op, r.mapping.id, [{ key: `issue:bitbucket:${UUID.toLowerCase()}:7`, connector: 'bitbucket', kind: 'issue', ref: '#7', title: 'A broken link', state: 'open', url: 'https://bitbucket.org/acme/web/issues/7', updatedAt: new Date().toISOString(), assignee: null, labels: [] }]);
  assert.equal(stored.stored, 1, "the new connector's issue refs belong to the imported mapping");
});

