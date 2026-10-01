// J3 tracker service against the REAL controller Trackers module and a temporary journal (J3-DESIGN.md
// §3.7, §6, mutations §9). Tracker responses come from recorded synthetic fixtures only.
import fs from 'node:fs'; import path from 'node:path';
import test from 'node:test'; import assert from 'node:assert/strict';
import { createTrackerService } from './service.mjs';
import { createGithubConnector } from './github.mjs';
import { fakeFetch, githubRoutes, response, GH } from './test-support.mjs';
import { harness, mapScratch, P, T } from './harness.mjs';


test('S1: a project read lists open tracker issues with constructed URLs and plain text only', async t => {
  const h = harness(t);
  const mapped = await mapScratch(h.service);
  assert.equal(mapped.ok, true); assert.equal(mapped.mapping.remoteId, '123456');
  const r = await h.service.read({ projectId: P(1) });
  assert.deepEqual(r.projects.map(p => [p.status, p.remoteName, p.mappingRevision]), [['ok', 'Subrising/scratch', 1]]);
  assert.deepEqual(r.items.map(i => i.ref), ['#7', '#11']);
  const seven = r.items[0];
  assert.equal(seven.url, 'https://github.com/Subrising/scratch/issues/7');
  assert.equal(seven.title, 'Fix <img src=x onerror=alert(1)> [github.com](https://evil.example) evil');
  assert.deepEqual(seven.labels, ['bug', 'needstriage']); assert.equal(seven.state, 'open');
  assert.equal(JSON.stringify(r).includes('evil.example/phish'), false);
  assert.equal(JSON.stringify(r).includes('IGNORE PREVIOUS INSTRUCTIONS'), false);
});

test('S2: an unmapped project makes no tracker call and reports unmapped', async t => {
  const h = harness(t);
  const r = await h.service.read({ projectId: P(2) });
  assert.deepEqual(r.projects, [{ projectId: P(2), tracker: null, remoteName: null, mappingRevision: 0, status: 'unmapped', retryAt: null, observedAt: null }]);
  assert.equal((await h.service.read({ subjects: [T(2)] })).projects.length, 0);
  assert.equal(h.fetcher.calls.length, 0);
});

test('S3: a mapping records the id the tracker returned; a failed resolve records nothing', async t => {
  const h = harness(t, { routes: { ...githubRoutes(), [`${GH}/repos/Subrising/locked`]: response(401, {}) } });
  const failed = await h.service.map({ projectId: P(1), tracker: 'github', auth: 'keychain', site: 'evil.example', remoteName: 'Subrising/locked', confirmRemoteId: '1', expectedRevision: 0, note: '' });
  assert.deepEqual(failed, { ok: false, failure: 'auth-required', message: null, mapping: null });
  assert.equal(h.store.db.prepare('SELECT count(*) n FROM tracker_mappings').get().n, 0);
  const ok = await mapScratch(h.service);
  assert.equal(ok.mapping.site, 'github.com'); assert.equal(ok.mapping.remoteId, '123456');
  assert.deepEqual(await h.service.resolve({ tracker: 'github', auth: 'keychain', site: 'x', remoteName: 'Subrising/scratch' }), { ok: true, failure: null, message: null, remoteId: '123456', remoteName: 'Subrising/scratch' });
  const changed = await h.service.map({ projectId: P(2), tracker: 'github', auth: 'keychain', site: 'github.com', remoteName: 'Subrising/scratch', confirmRemoteId: '555', expectedRevision: 0, note: '' });
  assert.equal(changed.ok, false); assert.match(changed.message, /identity changed since it was confirmed/);
  const call = h.inputs.find(i => i.method === 'trackers-map');
  assert.equal(call.input.remoteId, '123456'); assert.equal(call.input.site, 'github.com');
});

test('S4: reads coalesce for 60 s, then revalidate with the ETag and keep items on 304', async t => {
  let lists = 0;
  const h = harness(t, { routes: githubRoutes({ [`${GH}/repositories/123456/issues?state=open&per_page=50&sort=updated`]: init => { lists++; return init.headers['If-None-Match'] === 'W/"list-1"' ? response(304) : response(200, JSON.parse(fs.readFileSync(new URL('./fixtures/github/issues-open.json', import.meta.url))), { etag: 'W/"list-1"' }); } }) });
  await mapScratch(h.service);
  await h.service.read({ projectId: P(1) }); const calls = h.fetcher.calls.length;
  h.now.advance(30000); await h.service.read({ projectId: P(1) });
  assert.equal(h.fetcher.calls.length, calls);
  h.now.advance(31000); const r = await h.service.read({ projectId: P(1) });
  assert.equal(lists, 2); assert.equal(h.fetcher.calls.at(-1).init.headers['If-None-Match'], 'W/"list-1"');
  assert.deepEqual(r.items.map(i => i.ref), ['#7', '#11']); assert.equal(r.projects[0].status, 'ok');
});

test('S5: auth-required, offline and rate-limited back off; a failed refresh keeps the last snapshot as stale', async t => {
  let mode = 'auth';
  const flaky = init => mode === 'auth' ? response(401, {}) : mode === 'down' ? { throw: 'ECONNRESET' } : mode === 'limited' ? response(429, {}, { 'retry-after': '120' }) : response(200, JSON.parse(fs.readFileSync(new URL('./fixtures/github/repo.json', import.meta.url))));
  const h = harness(t, { routes: githubRoutes({ [`${GH}/repositories/123456`]: flaky }) });
  await mapScratch(h.service);
  assert.equal((await h.service.read({ projectId: P(1) })).projects[0].status, 'auth-required');
  const after = h.fetcher.calls.length;
  h.now.advance(5 * 60000); assert.equal((await h.service.read({ projectId: P(1) })).projects[0].status, 'auth-required');
  assert.equal(h.fetcher.calls.length, after, 'no retry inside the auth backoff');
  mode = 'ok'; h.now.advance(6 * 60000);
  assert.equal((await h.service.read({ projectId: P(1) })).projects[0].status, 'ok');
  mode = 'down'; h.now.advance(61000);
  const stale = await h.service.read({ projectId: P(1) });
  assert.equal(stale.projects[0].status, 'stale'); assert.ok(stale.items.length === 2 && stale.items.every(i => i.stale));
  const downCalls = h.fetcher.calls.length;
  h.now.advance(10000); await h.service.read({ projectId: P(1) }); assert.equal(h.fetcher.calls.length, downCalls, 'no retry inside the offline backoff');
  mode = 'limited'; h.now.advance(31000);
  const limited = await h.service.read({ projectId: P(1) });
  assert.equal(limited.projects[0].status, 'rate-limited'); assert.equal(Date.parse(limited.projects[0].retryAt), h.now() + 120000);
  const limitedCalls = h.fetcher.calls.length;
  h.now.advance(90000); await h.service.read({ projectId: P(1) }); assert.equal(h.fetcher.calls.length, limitedCalls, 'retry-after honoured');
});

test('S6: a link is recorded only for an item observed in the mapped repository; linked closed items are fetched singly', async t => {
  const h = harness(t);
  const { mapping } = await mapScratch(h.service);
  const refused = await h.service.link({ projectId: P(1), subject: { kind: 'task', id: T(1) }, itemRef: '99', expectedMappingRevision: mapping.revision });
  assert.deepEqual(refused, { ok: false, failure: 'not-found', message: null, linkId: null, revision: null });
  assert.equal((await h.service.link({ projectId: P(1), subject: { kind: 'task', id: T(1) }, itemRef: '14', expectedMappingRevision: 1 })).failure, 'invalid-response');
  assert.equal(h.store.db.prepare('SELECT count(*) n FROM tracker_links').get().n, 0);
  assert.equal((await h.service.link({ projectId: P(1), subject: { kind: 'task', id: T(1) }, itemRef: '12', expectedMappingRevision: 1 })).ok, true);
  assert.equal((await h.service.link({ projectId: P(1), subject: { kind: 'task', id: T(2) }, itemRef: '7', expectedMappingRevision: 1 })).ok, false);
  const r = await h.service.read({ subjects: [T(1)] });
  assert.equal(r.links.length, 1); assert.equal(r.links[0].itemKey, 'github:123456:12');
  const twelve = r.items.find(i => i.key === 'github:123456:12');
  assert.deepEqual([twelve.state, twelve.title, twelve.url, twelve.stale], ['closed', 'Closed and linked', 'https://github.com/Subrising/scratch/issues/12', false]);
});

test('S7: a link from a previous mapping is shown from its own record and never fetched through the new mapping', async t => {
  const h = harness(t, { routes: githubRoutes({ [`${GH}/repos/Subrising/other`]: () => response(200, { id: 999, full_name: 'Subrising/other', has_issues: true }), [`${GH}/repositories/999`]: () => response(200, { id: 999, full_name: 'Subrising/other' }), [`${GH}/repositories/999/issues?state=open&per_page=50&sort=updated`]: () => response(200, []) }) });
  await mapScratch(h.service);
  await h.service.link({ projectId: P(1), subject: { kind: 'task', id: T(1) }, itemRef: '12', expectedMappingRevision: 1 });
  await h.service.map({ projectId: P(1), tracker: 'github', auth: 'keychain', site: 'github.com', remoteName: 'Subrising/other', confirmRemoteId: '999', expectedRevision: 1, note: 'moved' });
  const before = h.fetcher.calls.length;
  const r = await h.service.read({ projectId: P(1) });
  const old = r.items.find(i => i.key === 'github:123456:12');
  assert.deepEqual([old.fromPreviousMapping, old.title, old.state, old.url], [true, null, 'unknown', 'https://github.com/Subrising/scratch/issues/12']);
  assert.equal(h.fetcher.calls.slice(before).some(c => c.url.includes('/123456/')), false);
});

test('S8: nothing observed is persisted: a restarted service knows only links, and the journal holds no tracker text', async t => {
  const h = harness(t);
  await mapScratch(h.service);
  await h.service.link({ projectId: P(1), subject: { kind: 'task', id: T(1) }, itemRef: '12', expectedMappingRevision: 1 });
  await h.service.read({ projectId: P(1) });
  // "Restart": a new service over the same journal while the tracker is unreachable.
  const offline = harness(t, { routes: {}, file: h.journal });
  t.after(() => { try { offline.store.db.close(); } catch { /* closed */ } });
  offline.fetcher.calls.length = 0;
  const r = await createTrackerService({ controller: offline.controller, connectors: { github: createGithubConnector({ fetcher: fakeFetch({ '*': { throw: 'offline' } }), secrets: offline.secrets }) }, now: offline.now }).read({ subjects: [T(1)] });
  const twelve = r.items.find(i => i.key === 'github:123456:12');
  assert.deepEqual([twelve.title, twelve.state, twelve.stale], [null, 'unknown', true]);
  for (const f of [h.journal, h.journal + '-wal']) if (fs.existsSync(f)) {
    const bytes = fs.readFileSync(f);
    for (const text of ['Closed and linked', 'Second real issue', 'onerror']) assert.equal(bytes.includes(text), false, `${text} in ${path.basename(f)}`);
  }
});
