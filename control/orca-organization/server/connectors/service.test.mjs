// Fulcra J4 tracker service against the REAL controller modules over a temporary journal, the GitHub
// connector over recorded synthetic fixtures behind a fake of the host's credential request, and the gh login as
// the other `http`. The plugin holds no credential and no test fakes one. No network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlStore } from '../../../src/control/store.mjs';
import { Controller } from '../../../src/control/controller.mjs';
import { Trackers } from '../../../src/control/trackers.mjs';
import { CcTrackers } from '../../../src/control/cc-trackers.mjs';
import { CcLinks } from '../../../src/control/cc-links.mjs';
import { rpc } from '../../../src/control/rpc.mjs';
import { createConnectorService } from './service.mjs';
import { createRegistry } from './registry.mjs';
import { createGithubConnector, createGhHttp } from './github.mjs';
import { createJiraConnector } from './jira.mjs';
import { createBitbucketConnector } from './bitbucket.mjs';
import { accountHttp } from './http.mjs';
import { WITHHELD_TITLE } from '../../shared/cc/connector-rules.mjs';
import { clock } from '../trackers/test-support.mjs';
import { fakeHost, reply as response, assertNoCredentialLeak, HOST_SECRET } from './host-test-support.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = name => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'github', name), 'utf8'));
const GH = 'https://api.github.com';
const P = n => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
const S1 = '44444444-4444-4444-8444-000000000001';
const A1 = '55555555-5555-4555-8555-000000000001';
const SHA = 'a'.repeat(40);
const source = { observedAt: '2026-09-24T00:00:00.000Z', available: true, partial: false, note: 'test',
  projects: [P(1), P(2)].map((id, n) => ({ id, name: `Project ${n}`, description: null, status: 'in_progress' })), membership: [] };
function routes(now, overrides = {}) {
  const since = new Date(now() - 30 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const repo = (id, name) => ({
    [`${GH}/repos/${name}`]: () => response(200, { id: Number(id), full_name: name }),
    [`${GH}/repositories/${id}/issues?state=open&per_page=100&sort=updated`]: () => response(200, id === '123456' ? fx('issues-open.json') : []),
    [`${GH}/repositories/${id}/issues?state=closed&per_page=100&sort=updated&since=${since}`]: () => response(200, id === '123456' ? fx('issues-closed.json') : []),
  });
  return { ...repo('123456', 'acme/app'), ...repo('777', 'acme/site'),
    [`${GH}/repositories/123456/issues/42/timeline?per_page=100`]: () => response(200, fx('timeline-42.json')),
    [`${GH}/repositories/123456/pulls/17/commits?per_page=100`]: () => response(200, fx('pr-17-commits.json')),
    ...overrides };
}
function harness(t, { file, hostApi = true, importLegacy = null, fetchRoutes, now = clock(Date.parse('2026-09-24T14:00:00Z')), modules = null, accounts = {}, devStatus = false } = {}) {
  const dir = file ? path.dirname(file) : fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-j4-svc-')));
  const journal = file ?? path.join(dir, 'journal.sqlite');
  const store = new ControlStore(journal);
  const native = new Proxy({}, { get: () => () => { throw Error('Trackers must not invoke the native runtime'); } });
  const control = new Controller({ store, native, authority: async () => ({ id: 'task', delegationAuthority: [] }) });
  control.trackers = new Trackers(control, async () => source);
  control.ccTrackers = new CcTrackers(control, { readProjects: async () => source });
  control.ccLinks = new CcLinks(control);
  const dispatch = rpc(control, 'op');
  const controller = (method, input) => dispatch({ method, input, operator: 'op' });
  const host = fakeHost({ accounts: { [A1]: { connector: 'github' }, ...accounts }, routes: fetchRoutes ? fetchRoutes(now) : routes(now), devStatus });
  const registry = createRegistry(modules ? modules(now) : [createGithubConnector({ now })]);
  const gh = createGhHttp(async args => JSON.stringify(args[5] === 'repos/acme/app' ? { id: 123456, full_name: 'acme/app' } : args[5].includes('state=open') ? fx('issues-open.json') : fx('issues-closed.json')));
  // As index.server.ts wires it: the gh login for accountId null, else the host's request bound to the account.
  const http = m => m.accountId === null ? gh : hostApi ? accountHttp({ request: host.request, accountId: m.accountId, connector: m.connector }) : null;
  const scan = async () => ({ repositories: 1, links: [{ from: `session:${S1}`, relation: 'produced', to: `commit:github:acme/app@${SHA}`, provenance: 'reported', confidence: 'high', evidence: 'The commit names this session.' }],
    producersByCommit: new Map([[`commit:github:acme/app@${SHA}`, [{ ref: `session:${S1}`, provenance: 'reported', confidence: 'high' }]]]) });
  const service = createConnectorService({ controller, registry, http, importLegacy, scan, now, names: async () => ({ sessions: new Map([[S1, 'J4 Tracking']]), tasks: new Map() }),
    // The host's account list (J5b credentials.list): id, connector, site and state, as the host reports them.
    hostAccounts: async () => hostApi ? { hostApi: true, accounts: Object.entries({ [A1]: { connector: 'github' }, ...accounts }).map(([id, x]) => ({ id, connector: x.connector, site: x.site ?? null, state: x.state ?? 'connected' })), providers: [{ connector: 'github', methods: [{ method: 'device', status: 'unavailable' }, { method: 'browser', status: 'needs-broker' }] }] } : { hostApi: false, accounts: [], providers: [] } });
  if (!file) t.after(() => { try { store.db.close(); } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); });
  return { service, controller, host, store, journal, now };
}
const mapApp = async (service, extra = {}) => {
  const checked = await service.resolve({ connector: 'github', accountId: A1, remoteName: 'acme/app', site: null, ...extra });
  assert.equal(checked.ok, true, checked.message);
  return service.map({ messageId: randomUUID(), projectId: P(1), connector: 'github', accountId: A1, remoteName: 'acme/app', site: null, confirmRemoteId: checked.remote.remoteId, expectedRevision: 0, note: '', ...extra });
};

test('SV1: a project view lists issues and pull requests with a "worked by" trail', async t => {
  const { service, host } = harness(t);
  const mapped = await mapApp(service);
  assert.deepEqual([mapped.ok, mapped.mapping.remoteId, mapped.mapping.accountId], [true, '123456', A1]);
  await service.view({ projectId: P(1) });
  await service.scanProject(P(1));
  const v = await service.view({ projectId: P(1) });
  assert.deepEqual(v.trackers.map(x => [x.label, x.remoteName, x.status, x.commandLine]), [['GitHub', 'acme/app', 'ok', false]]);
  const byRef = Object.fromEntries(v.items.map(i => [i.item.ref, i]));
  assert.deepEqual(Object.keys(byRef).sort(), ['#16', '#17', '#18', '#40', '#42']);
  assert.deepEqual(byRef['#42'].trail.map(s => s.label), ['fixed in PR #17', "by session 'J4 Tracking'", 'merged']);
  assert.equal(byRef['#42'].trail[2].at, '2026-09-24T13:10:00.000Z');
  assert.deepEqual(byRef['#42'].trail.map(s => s.provenance), ['reported', 'inferred', null]);
  assert.deepEqual(byRef['#17'].trail.map(s => s.label), ["by session 'J4 Tracking'", 'merged']);
  assert.deepEqual(byRef['#40'].trail, []);
  assertNoCredentialLeak(assert, host, v);
  assert.equal(JSON.stringify(v).includes(HOST_SECRET), false);
});

test('SV-L36: a read never fetches; the refresh fetches and stores, and later reads show its real status and items', async t => {
  const { service, host } = harness(t);
  await mapApp(service);
  const lists = () => host.calls.filter(c => c.url?.includes('/issues?state=')).length;
  // The read the views make (trackerViewRpc, persist:false): nothing fetched, nothing stored, reported stale.
  let v = await service.view({ projectId: P(1) }, { persist: false });
  assert.equal(lists(), 0); assert.equal(v.items.length, 0); assert.deepEqual(v.trackers.map(x => x.status), ['stale']);
  // The refresh (trackerRefreshRpc, persist:true) fetches and records the items.
  v = await service.view({ projectId: P(1) }, { persist: true });
  assert.equal(lists(), 2); assert.equal(v.items.length, 5); assert.deepEqual(v.trackers.map(x => x.status), ['ok']);
  // A later read shows the stored items and the refresh's own status ("checked at ..."), still without fetching.
  v = await service.view({ projectId: P(1) }, { persist: false });
  assert.equal(lists(), 2); assert.equal(v.items.length, 5); assert.deepEqual(v.trackers.map(x => x.status), ['ok']);
  assert.ok(v.trackers[0].observedAt);
});

test('SV2: refreshes coalesce for the poll interval and every tracker call is a GET', async t => {
  const { service, host, now } = harness(t);
  await mapApp(service);
  const lists = () => host.calls.filter(c => c.url?.includes('/issues?state=')).length;
  await service.view({ projectId: P(1) }); await service.view({ projectId: P(1) });
  assert.equal(lists(), 2, 'one open and one closed page');
  now.advance(59000); await service.view({ projectId: P(1) });
  assert.equal(lists(), 2);
  now.advance(2000); await service.view({ projectId: P(1) });
  assert.equal(lists(), 4);
  assert.ok(host.calls.every(c => c.input.method === 'GET' && c.accountId === A1 && c.connectorId === 'github'));
  assertNoCredentialLeak(assert, host);
});

test('SV3: a signed-out account pauses its own mappings only; the command-line login keeps reading', async t => {
  let unauthorised = false;
  const { service, host, now } = harness(t, { fetchRoutes: now => { const r = routes(now); for (const k of Object.keys(r)) if (k.includes('/repositories/777/')) { const f = r[k]; r[k] = (...a) => unauthorised ? response(401, {}) : f(...a); } return r; } });
  await mapApp(service);
  const site = await service.resolve({ connector: 'github', accountId: A1, remoteName: 'acme/site', site: null });
  await service.map({ messageId: randomUUID(), projectId: P(1), connector: 'github', accountId: A1, remoteName: 'acme/site', site: null, confirmRemoteId: site.remote.remoteId, expectedRevision: 0, note: '' });
  await service.map({ messageId: randomUUID(), projectId: P(2), connector: 'github', accountId: null, remoteName: 'acme/app', site: null, confirmRemoteId: '123456', expectedRevision: 0, note: '' })
    .then(r => assert.equal(r.ok, true, r.message));
  await service.view({ projectId: P(1) });
  unauthorised = true; now.advance(61000);
  const v = await service.view({ projectId: P(1) });
  const status = Object.fromEntries(v.trackers.map(x => [x.remoteName, x.status]));
  assert.equal(status['acme/site'], 'auth-required');
  // acme/app shares the account: it now waits for the account's retry time instead of calling again.
  now.advance(61000);
  const before = host.calls.length;
  const again = await service.view({ projectId: P(1) });
  assert.deepEqual(again.trackers.map(x => x.status), ['auth-required', 'auth-required']);
  assert.equal(host.calls.length, before, 'no call while the account waits');
  assert.equal((await service.view({ projectId: P(2) })).trackers[0].status, 'ok');
});

test('SV4: after a restart the last observation is shown, marked stale, while the tracker is unreachable', async t => {
  const first = harness(t);
  await mapApp(first.service);
  await first.service.view({ projectId: P(1) });
  first.store.db.close();
  const offline = harness(t, { file: first.journal, fetchRoutes: () => new Proxy({}, { get: () => () => ({ throw: 'socket hang up' }) }) });
  t.after(() => { try { offline.store.db.close(); } catch { /* closed */ } fs.rmSync(path.dirname(first.journal), { recursive: true, force: true }); });
  const v = await offline.service.view({ projectId: P(1) });
  assert.equal(v.trackers[0].status, 'stale');
  assert.equal(v.items.length, 5);
  assert.ok(v.items.every(i => i.stale));
  assert.equal(v.partial, true);
});

test('SV5: without host update P1, account mappings say so and keep their last observation; the screen data degrades', async t => {
  const { service, controller } = harness(t, { hostApi: false });
  const refused = await service.resolve({ connector: 'github', accountId: A1, remoteName: 'acme/app', site: null });
  assert.deepEqual(refused, { ok: false, message: 'This needs Fulcra host update P1 (the shared sign-in store).', remote: null });
  await controller('cc-tracker-map', { messageId: randomUUID(), projectId: P(1), connector: 'github', accountId: A1, remoteId: '123456', remoteName: 'acme/app', site: null, note: '', expectedRevision: 0 });
  const v = await service.view({ projectId: P(1) });
  assert.equal(v.trackers[0].status, 'needs-host-update');
  const integrations = await service.integrations();
  assert.deepEqual([integrations.hostApi, integrations.connectors.map(c => [c.id, c.auth])], [false, [['github', ['token', 'cli']]]]);
});

test('SV6: the J3 mapping is copied on first read: the command-line one at once, a keychain one through the host import', async t => {
  const imports = [];
  const { service, controller } = harness(t, { importLegacy: async input => { imports.push(input); return { accountId: A1, imported: true }; } });
  await controller('trackers-map', { project: P(1), tracker: 'github', auth: 'keychain', site: 'github.com', remoteId: '123456', remoteName: 'acme/app', expectedRevision: 0, note: '', validatedAt: new Date().toISOString() });
  await controller('trackers-map', { project: P(2), tracker: 'github', auth: 'gh-cli', site: 'github.com', remoteId: '777', remoteName: 'acme/site', expectedRevision: 0, note: '', validatedAt: new Date().toISOString() });
  const one = await service.mappings({ projectId: P(1) }), two = await service.mappings({ projectId: P(2) });
  assert.deepEqual(imports, [{ secretName: 'github.com:read', connector: 'github', site: null }]);
  assert.deepEqual([one.mappings[0].accountId, one.legacy.copied, one.legacy.commandLine], [A1, true, false]);
  assert.deepEqual([two.mappings[0].accountId, two.legacy.copied, two.legacy.commandLine], [null, true, true]);
  assert.equal((await controller('trackers-status')).mappings.length, 2, 'the J3 records still read');
});

test('SV7: without the host import, a keychain mapping waits and the J3 path keeps working', async t => {
  const { service, controller } = harness(t);
  await controller('trackers-map', { project: P(1), tracker: 'github', auth: 'keychain', site: 'github.com', remoteId: '123456', remoteName: 'acme/app', expectedRevision: 0, note: '', validatedAt: new Date().toISOString() });
  const r = await service.mappings({ projectId: P(1) });
  assert.deepEqual([r.mappings.length, r.legacy.copied], [0, false]);
  assert.equal((await controller('trackers-project', P(1))).mapping.state, 'mapped');
});

test('SV8: Jira and Bitbucket in one project: the development panel and ticket keys in pull requests link tickets', async t => {
  const J1 = '66666666-6666-4666-8666-000000000001', B1 = '77777777-7777-4777-8777-000000000001', UUID = '00000000-0000-4908-8706-000000002005';
  const jfx = name => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'jira', name), 'utf8'));
  const bfx = name => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'bitbucket', name), 'utf8'));
  const SITE = 'https://acme.atlassian.net', REPO = `https://api.bitbucket.org/2.0/repositories/acme/{${UUID}}`, SINCE = '2026-08-25T14:00:00Z';
  const JQL = 'project = 10001 AND (statusCategory != Done OR updated >= -30d) ORDER BY updated DESC', FIELDS = 'summary,status,labels,updated,project,assignee';
  const fetchRoutes = () => ({
    [`${SITE}/rest/api/3/project/ACME`]: response(200, jfx('project.json')),
    [`${SITE}/rest/api/3/search/jql?jql=${JQL}&maxResults=100&fields=${FIELDS}`]: response(200, jfx('search-cloud.json')),
    ...Object.fromEntries(['ACME-12', 'ACME-11', 'ACME-9'].map(k => [`${SITE}/rest/api/3/issue/${k}?fields=project`, response(200, { ...jfx('issue-12.json'), key: k, id: k === 'ACME-12' ? '20012' : '20099' })])),
    [`${SITE}/rest/dev-status/latest/issue/summary?issueId=20012`]: response(200, jfx('dev-summary.json')),
    [`${SITE}/rest/dev-status/latest/issue/summary?issueId=20099`]: response(200, { summary: {} }),
    [`${SITE}/rest/dev-status/latest/issue/detail?issueId=20012&applicationType=GitHub&dataType=pullrequest`]: response(200, jfx('dev-pr-github.json')),
    [`${SITE}/rest/dev-status/latest/issue/detail?issueId=20012&applicationType=bitbucket&dataType=pullrequest`]: response(200, { detail: [] }),
    [`${SITE}/rest/dev-status/latest/issue/detail?issueId=20012&applicationType=GitHub&dataType=repository`]: response(200, jfx('dev-repo-github.json')),
    ['https://api.bitbucket.org/2.0/repositories/acme/web']: response(200, bfx('repo.json')),
    [`${REPO}/pullrequests?state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&sort=-updated_on&pagelen=50&q=state = "OPEN" OR updated_on > ${SINCE}&page=1`]: response(200, bfx('pullrequests.json')),
    [`${REPO}/issues?sort=-updated_on&pagelen=50&q=(state = "new" OR state = "open" OR state = "on hold") OR updated_on > ${SINCE}&page=1`]: response(404, {}),
    [`${REPO}/pullrequests/5/commits?pagelen=100&page=1`]: response(200, bfx('pr-5-commits.json')),
    [`${REPO}/pullrequests/4/commits?pagelen=100&page=1`]: response(200, { values: [] }),
  });
  const { service, host } = harness(t, { fetchRoutes, devStatus: true, accounts: { [J1]: { connector: 'jira', site: 'acme.atlassian.net' }, [B1]: { connector: 'bitbucket' } },
    modules: now => [createGithubConnector({ now }), createJiraConnector({ id: 'jira' }), createBitbucketConnector({ id: 'bitbucket', now })] });
  for (const [connector, accountId, remoteName, site] of [['jira', J1, 'ACME', 'acme.atlassian.net'], ['bitbucket', B1, 'acme/web', null]]) {
    const checked = await service.resolve({ connector, accountId, remoteName, site });
    assert.equal(checked.ok, true, checked.message);
    const m = await service.map({ messageId: randomUUID(), projectId: P(1), connector, accountId, remoteName, site, confirmRemoteId: checked.remote.remoteId, expectedRevision: 0, note: '' });
    assert.equal(m.ok, true, m.message);
  }
  // C1: robust to slow I/O. view() starts the commit-provenance scan without awaiting it; wait for that scan to
  // finish (scanProject returns the one in flight), then read a second view, so nothing writes while we assert.
  await service.view({ projectId: P(1) });
  await service.scanProject(P(1));
  const v = await service.view({ projectId: P(1) });
  assert.deepEqual(v.trackers.map(x => [x.connector, x.status]), [['jira', 'ok'], ['bitbucket', 'ok']]);
  const byRef = Object.fromEntries(v.items.map(i => [i.item.ref, i]));
  const ticket = byRef['ACME-12'];
  const fixes = Object.fromEntries(ticket.links.filter(l => l.relation === 'fixes').map(l => [l.from, `${l.provenance}/${l.confidence}`]));
  assert.deepEqual(fixes, { 'pr:github:acme/app#17': 'reported/high', 'pr:bitbucket:acme/web#5': 'inferred/medium' });
  assert.deepEqual(ticket.trail.filter(s => s.kind === 'pr').map(s => s.label).sort(), ['fixed in PR #17', 'fixed in PR #5']);
  // ACME-11 is named by PR #4's title: a medium link from the Bitbucket pull request.
  assert.deepEqual(byRef['ACME-11'].links.filter(l => l.relation === 'fixes').map(l => l.from), ['pr:bitbucket:acme/web#4']);
  // Every request went through the host, bound to the right account, and none carried a credential.
  assert.ok(host.calls.every(c => (c.connectorId === 'jira' && c.accountId === J1) || (c.connectorId === 'bitbucket' && c.accountId === B1)));
  assertNoCredentialLeak(assert, host, v);
});

// ---- REVIEW-J4 -------------------------------------------------------------------------------------------------
test('R-E-1: the site is the selected account\'s, for every connector; a conflicting site is refused', async t => {
  const J1 = '66666666-6666-4666-8666-000000000001', D1 = '66666666-6666-4666-8666-000000000002';
  const project = site => ({ [`https://${site}/rest/api/${site.startsWith('jira.') ? 2 : 3}/project/ACME`]: response(200, { id: '10001', key: 'ACME' }) });
  const { service, controller } = harness(t, { fetchRoutes: () => ({ ...project('acme.atlassian.net'), ...project('jira.example.com') }),
    accounts: { [J1]: { connector: 'jira', site: 'acme.atlassian.net' }, [D1]: { connector: 'jira-dc', site: 'jira.example.com' } },
    modules: now => [createGithubConnector({ now }), createJiraConnector({ id: 'jira' }), createJiraConnector({ id: 'jira-dc' })] });
  // Jira Cloud with no site given: the account's site is used (this used to fail before any request).
  const cloud = await service.resolve({ connector: 'jira', accountId: J1, remoteName: 'ACME', site: null });
  assert.deepEqual([cloud.ok, cloud.remote?.site], [true, 'acme.atlassian.net'], cloud.message);
  const dc = await service.resolve({ connector: 'jira-dc', accountId: D1, remoteName: 'ACME', site: 'JIRA.example.com' });
  assert.deepEqual([dc.ok, dc.remote?.site], [true, 'jira.example.com'], 'the same site, typed in capitals');
  for (const [label, input, pattern] of [
    ['a conflicting site', { connector: 'jira-dc', accountId: D1, remoteName: 'ACME', site: 'other.example.com' }, /reads jira\.example\.com, not the site given/],
    ['another connector\'s account', { connector: 'jira-dc', accountId: J1, remoteName: 'ACME', site: null }, /Choose a connected Jira Data Center account/],
    ['an unknown account', { connector: 'jira', accountId: randomUUID(), remoteName: 'ACME', site: null }, /Choose a connected Jira account/],
    ['a site on the command-line login', { connector: 'github', accountId: null, remoteName: 'acme/app', site: 'github.example.com' }, /no site/]]) {
    const r = await service.resolve(input);
    assert.equal(r.ok, false, label); assert.match(r.message, pattern, label);
  }
  // The stored mapping carries the account's site, whatever the caller sent.
  const m = await service.map({ messageId: randomUUID(), projectId: P(1), connector: 'jira', accountId: J1, remoteName: 'ACME', site: null, confirmRemoteId: '10001', expectedRevision: 0, note: '' });
  assert.equal(m.mapping.site, 'acme.atlassian.net', m.message);
  assert.equal((await controller('cc-tracker-mappings', { projectId: P(1) })).mappings[0].site, 'acme.atlassian.net');
});

test('R-E-2, R-E-8, R-E-9: unsafe titles are withheld and the read is partial; a PR title naming #n links that issue; removed links are carried', async t => {
  const open = fx('issues-open.json').map(x => x.number === 42 ? { ...x, title: 'Crash reported by someone@example.com' } : x.number === 18 ? { ...x, title: 'Investigate #42 again' } : x);
  const { service, controller, now } = harness(t, { fetchRoutes: n => routes(n, { [`${GH}/repositories/123456/issues?state=open&per_page=100&sort=updated`]: () => response(200, open) }) });
  await mapApp(service);
  const v = await service.view({ projectId: P(1) });
  const byRef = Object.fromEntries(v.items.map(i => [i.item.ref, i]));
  assert.equal(byRef['#42'].item.title, WITHHELD_TITLE);
  assert.equal(v.partial, true, 'something was withheld, so the observation says it is partial');
  assert(!JSON.stringify(v).includes('someone@example.com'));
  const fixes = Object.fromEntries(byRef['#42'].links.filter(l => l.relation === 'fixes').map(l => [l.from, `${l.provenance}/${l.confidence}`]));
  assert.equal(fixes['pr:github:acme/app#18'], 'inferred/medium', 'the title names #42 (R-E-8)');
  assert.equal(fixes['pr:github:acme/app#17'], 'reported/high', 'a closing reference stays reported');
  // R-E-9: a removed link is carried with its revision, so re-adding it by hand can name that revision.
  const link = byRef['#42'].links.find(l => l.from === 'pr:github:acme/app#18');
  await service.linkRemove({ messageId: randomUUID(), id: link.id, expectedRevision: link.revision });
  now.advance(61000);
  const again = (await service.view({ projectId: P(1) })).items.find(i => i.item.ref === '#42');
  const removed = again.links.find(l => l.id === link.id);
  assert.deepEqual([removed.state, removed.revision], ['removed', link.revision + 1]);
  assert(!again.trail.some(s => s.ref === link.from), 'a removed link is not in the trail');
  const restored = await service.linkSet({ messageId: randomUUID(), from: link.from, relation: 'fixes', to: link.to, evidence: 'Set by hand again.', expectedRevision: removed.revision });
  assert.equal(restored.ok, true, restored.message);
});

test('R-E-4: links made by hand in the earlier set-up show in the new view, and are corrected through the earlier unlink', async t => {
  const TASK = '33333333-3333-4333-8333-000000000001';
  source.membership = [{ taskId: TASK, projectId: P(1) }];
  t.after(() => { source.membership = []; });
  const { service, controller } = harness(t);
  const old = await controller('trackers-map', { project: P(1), tracker: 'github', auth: 'gh-cli', site: 'github.com', remoteId: '123456', remoteName: 'acme/app', expectedRevision: 0, note: '', validatedAt: new Date().toISOString() });
  const made = await controller('trackers-link', { project: P(1), subject: { kind: 'task', id: TASK }, itemRef: '40', expectedMappingRevision: old.mapping.revision });
  await service.mappings({ projectId: P(1) });   // the one-time copy runs (command-line login)
  const v = await service.view({ projectId: P(1) });
  const forty = v.items.find(i => i.item.ref === '#40');
  const legacy = forty.links.find(l => l.id === made.link.id);
  assert.deepEqual([legacy.from, legacy.to, legacy.provenance, legacy.relation], ['issue:github:123456:40', `task:${TASK}`, 'manual', 'worked-by']);
  assert.match(forty.trail.map(s => s.label).join(' | '), /worked on by a task/);
  const r = await service.linkRemove({ messageId: randomUUID(), id: legacy.id, expectedRevision: legacy.revision });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual((await controller('trackers-project', P(1))).links, [], 'unlinked in the earlier set-up; its row and history are kept');
  assert(!(await service.view({ projectId: P(1) })).items.find(i => i.item.ref === '#40').links.some(l => l.id === legacy.id));
});

test('R-E-5: after a partial refresh, an item the tracker did not list again shows as the last copy, not current', async t => {
  let second = false;
  const open = fx('issues-open.json');
  // The closed-issue URL names `since`, which moves with the clock: the second read's URL is registered too.
  const later = new Date(Date.parse('2026-09-24T14:00:00Z') + 61000 - 30 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const { service, now } = harness(t, { fetchRoutes: n => routes(n, { [`${GH}/repositories/123456/issues?state=open&per_page=100&sort=updated`]: () => response(200, second ? open.filter(x => x.number !== 42) : open),
    [`${GH}/repositories/123456/issues?state=closed&per_page=100&sort=updated&since=${later}`]: () => response(200, fx('issues-closed.json')) }) });
  await mapApp(service);
  assert.equal((await service.view({ projectId: P(1) })).items.find(i => i.item.ref === '#42').stale, false);
  second = true; now.advance(61000);
  const v = await service.view({ projectId: P(1) });
  assert.equal(v.trackers[0].status, 'ok');
  assert.equal(v.partial, true, "the fixture holds another repository's row, so every read here is partial");
  assert.deepEqual([v.items.find(i => i.item.ref === '#42').stale, v.items.find(i => i.item.ref === '#18').stale], [true, false]);
});

