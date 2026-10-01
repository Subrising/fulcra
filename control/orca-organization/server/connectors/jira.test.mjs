// Fulcra J4b: the Jira Cloud and Data Center connectors against recorded synthetic fixtures behind a fake of the
// host's credential request (host-test-support.mjs). The plugin holds no credential; no test reaches the network.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from './registry.mjs';
import { createJiraConnector, jql } from './jira.mjs';
import { accountHttp } from './http.mjs';
import { itemProblem } from '../../shared/cc/connector-rules.mjs';
import { noPersonal } from '../../shared/cc/refs.mjs';
import { fakeHost, reply, assertNoCredentialLeak } from './host-test-support.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = name => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'jira', name), 'utf8'));
const CLOUD = 'acme.atlassian.net', DC = 'jira.example.com';
const ACCOUNT = '66666666-6666-4666-8666-000000000001';
const JQL = 'project = 10001 AND (statusCategory != Done OR updated >= -30d) ORDER BY updated DESC';
const FIELDS = 'summary,status,labels,updated,project,assignee';
const remote = site => ({ remoteId: '10001', remoteName: 'ACME', site });
const cloudRoutes = (extra = {}) => ({
  [`https://${CLOUD}/rest/api/3/project/ACME`]: reply(200, fx('project.json')),
  [`https://${CLOUD}/rest/api/3/search/jql?jql=${JQL}&maxResults=100&fields=${FIELDS}`]: reply(200, fx('search-cloud.json')),
  [`https://${CLOUD}/rest/api/3/issue/ACME-12?fields=${FIELDS}`]: reply(200, fx('issue-12.json')),
  [`https://${CLOUD}/rest/api/3/issue/ACME-12?fields=project`]: reply(200, fx('issue-12.json')),
  [`https://${CLOUD}/rest/dev-status/latest/issue/summary?issueId=20012`]: reply(200, fx('dev-summary.json')),
  [`https://${CLOUD}/rest/dev-status/latest/issue/detail?issueId=20012&applicationType=GitHub&dataType=pullrequest`]: reply(200, fx('dev-pr-github.json')),
  [`https://${CLOUD}/rest/dev-status/latest/issue/detail?issueId=20012&applicationType=bitbucket&dataType=pullrequest`]: reply(200, fx('dev-pr-bitbucket.json')),
  [`https://${CLOUD}/rest/dev-status/latest/issue/detail?issueId=20012&applicationType=GitHub&dataType=repository`]: reply(200, fx('dev-repo-github.json')),
  [`https://${CLOUD}/rest/api/3/myself`]: reply(200, { accountId: 'x' }),
  ...extra,
});
function hosted({ id = 'jira', site = CLOUD, routes = cloudRoutes(), ...options } = {}) {
  const host = fakeHost({ accounts: { [ACCOUNT]: { connector: id, site, state: options.state } }, routes, devStatus: options.devStatus });
  return { host, http: accountHttp({ request: host.request, accountId: ACCOUNT, connector: id }) };
}

test('JR1: both Jira connectors register, with token sign-in, ticket keys and plain token help', () => {
  const registry = createRegistry([createJiraConnector({ id: 'jira' }), createJiraConnector({ id: 'jira-dc' })]);
  const [cloud, dc] = registry.describe();
  assert.deepEqual([cloud.id, cloud.label, cloud.selfHosted, cloud.auth, cloud.kinds], ['jira', 'Jira', false, ['token'], ['ticket']]);
  assert.deepEqual([dc.id, dc.label, dc.selfHosted, dc.auth], ['jira-dc', 'Jira Data Center', true, ['token']]);
  assert.deepEqual(cloud.keyPatterns, ['[A-Z][A-Z0-9]+-\\d+']);
  assert.ok(new RegExp(`^${cloud.keyPatterns[0]}$`).test('ACME-12'));
  assert.deepEqual(cloud.tokenHelp.scopes, ['read:jira-work', 'read:jira-user']);
  for (const c of [cloud, dc]) assert.ok(noPersonal(c.tokenHelp.note) && c.tokenHelp.createUrl.startsWith('https://'), c.id);
  // Browser sign-in shows only when the host says it works without a server-held secret.
  assert.deepEqual(registry.describe(new Map([['jira', [{ method: 'browser', status: 'available' }]]]))[0].auth, ['browser', 'token']);
  assert.throws(() => createJiraConnector({ id: 'jira-server' }), /Unknown Jira connector/);
});

test('JR2: Jira Cloud tickets, open, in progress and recently done, become §7.1 items pinned to the project', async () => {
  const { host, http } = hosted(), jira = createJiraConnector({ id: 'jira' });
  const r = await jira.listItems(http, { remote: remote(CLOUD) });
  assert.deepEqual(r.items.map(i => [i.key, i.kind, i.ref, i.state]), [
    ['issue:jira@acme.atlassian.net:10001:ACME-12', 'ticket', 'ACME-12', 'in-progress'],
    ['issue:jira@acme.atlassian.net:10001:ACME-11', 'ticket', 'ACME-11', 'open'],
    ['issue:jira@acme.atlassian.net:10001:ACME-9', 'ticket', 'ACME-9', 'closed']]);
  assert.equal(r.partial, true, 'a ticket from another project is dropped and the read is partial');
  for (const it of r.items) assert.equal(itemProblem(it), null, it.key);
  const [first] = r.items;
  assert.deepEqual([first.url, first.title, first.assignee, first.labels, first.updatedAt],
    ['https://acme.atlassian.net/browse/ACME-12', 'Sign-in fails after an update', 'Test User A', ['bug', 'web'], '2026-09-24T12:30:00.000Z']);
  // The JQL is built from the pinned numeric id only, and sent as a query value, never in the path.
  assert.deepEqual(host.calls.map(c => [c.input.method, c.input.path, c.input.query]), [['GET', '/rest/api/3/search/jql', { jql: JQL, maxResults: '100', fields: FIELDS }]]);
  assert.deepEqual(host.calls[0].input.headers, { Accept: 'application/json' });
  assertNoCredentialLeak(assert, host, r);
  assert.throws(() => jql('10001 OR 1=1'), e => e.failure === 'error');
  assert.equal(jql('10001', ['open']), 'project = 10001 AND (statusCategory != Done) ORDER BY updated DESC');
});

test('JR3: Jira Data Center reads API version 2 on its own site, page by page', async () => {
  const pages = [];
  const routes = { [`https://${DC}/rest/api/2/search?jql=${JQL}&maxResults=100&fields=${FIELDS}&startAt=0`]: input => { pages.push(input.query.startAt); return reply(200, fx('search-dc.json')); } };
  const { host, http } = hosted({ id: 'jira-dc', site: DC, routes }), jira = createJiraConnector({ id: 'jira-dc' });
  const r = await jira.listItems(http, { remote: remote(DC) });
  assert.deepEqual(r.items.map(i => i.key), ['issue:jira-dc@jira.example.com:10001:ACME-12', 'issue:jira-dc@jira.example.com:10001:ACME-11', 'issue:jira-dc@jira.example.com:10001:ACME-9']);
  assert.equal(r.items[0].url, 'https://jira.example.com/browse/ACME-12');
  assert.deepEqual(pages, ['0'], 'total 4 in one short page: no second request');
  assert.equal(host.calls[0].connectorId, 'jira-dc');
  // Two full pages: the second starts at 100, and the read stops at 200 items.
  const full = n => ({ startAt: n, total: 250, issues: Array.from({ length: 100 }, (_, i) => ({ ...fx('issue-12.json'), key: `ACME-${n + i + 1}` })) });
  const paged = hosted({ id: 'jira-dc', site: DC, routes: {
    [`https://${DC}/rest/api/2/search?jql=${JQL}&maxResults=100&fields=${FIELDS}&startAt=0`]: reply(200, full(0)),
    [`https://${DC}/rest/api/2/search?jql=${JQL}&maxResults=100&fields=${FIELDS}&startAt=100`]: reply(200, full(100)) } });
  const many = await jira.listItems(paged.http, { remote: remote(DC) });
  assert.deepEqual([many.items.length, many.partial, paged.host.calls.length], [200, true, 2]);
});

test('JR4: the development panel gives reported pull requests and commits, as the owning connectors name them', async () => {
  const { host, http } = hosted({ devStatus: true }), jira = createJiraConnector({ id: 'jira' });
  const found = await jira.listLinksForItem(http, { remote: remote(CLOUD), ref: 'ACME-12', kind: 'ticket' });
  assert.deepEqual(found, { prs: ['pr:github:acme/app#17', 'pr:bitbucket:acme/web#5'], commits: [`commit:github:acme/app@${'a'.repeat(40)}`], reported: true });
  assert.equal(JSON.stringify(found).includes('evil.example.com'), false, 'a URL on an unknown host is never turned into a ref');
  assert.equal(host.calls.some(c => c.input.query?.applicationType === 'gitlab'), false, 'sources Fulcra cannot name are not asked for');
  assert.ok(host.calls.every(c => c.input.path.startsWith('/rest/api/3/issue/') || c.input.path.startsWith('/rest/dev-status/latest/issue/')));
  assertNoCredentialLeak(assert, host, found);
  assert.equal(jira.reportedEvidence, "Jira's development panel lists this pull request for the ticket.");
});

test('JR5: a host that does not allow the development panel yet (or a Jira without it) gives no reported links, not a failure', async () => {
  const jira = createJiraConnector({ id: 'jira' });
  const { host, http } = hosted();
  assert.deepEqual(await jira.listLinksForItem(http, { remote: remote(CLOUD), ref: 'ACME-12', kind: 'ticket' }), { commits: [], prs: [], reported: false });
  assert.equal(host.calls.length, 2, 'the ticket, then the refused panel; nothing more');
  const none = hosted({ devStatus: true, routes: cloudRoutes({ [`https://${CLOUD}/rest/dev-status/latest/issue/summary?issueId=20012`]: reply(404, {}) }) });
  assert.deepEqual(await jira.listLinksForItem(none.http, { remote: remote(CLOUD), ref: 'ACME-12' }), { commits: [], prs: [], reported: false });
  // An outage is still a failure: the service keeps the item and retries its links on the next change.
  const down = hosted({ devStatus: true, routes: cloudRoutes({ [`https://${CLOUD}/rest/dev-status/latest/issue/summary?issueId=20012`]: reply(503, {}) }) });
  await assert.rejects(jira.listLinksForItem(down.http, { remote: remote(CLOUD), ref: 'ACME-12' }), e => e.failure === 'offline');
  // A ticket moved to another project is not this mapping's.
  const moved = hosted({ routes: cloudRoutes({ [`https://${CLOUD}/rest/api/3/issue/ACME-12?fields=project`]: reply(200, { id: '20012', key: 'ACME-12', fields: { project: { id: '10002' } } }) }) });
  await assert.rejects(jira.listLinksForItem(moved.http, { remote: remote(CLOUD), ref: 'ACME-12' }), e => e.failure === 'invalid-response');
});

test('JR6: resolve pins the project id; getItem, ticket keys and refusals', async () => {
  const jira = createJiraConnector({ id: 'jira' }), { http } = hosted();
  assert.deepEqual(await jira.resolveRemote(http, { remoteName: 'acme', site: 'ACME.atlassian.net' }), { remoteId: '10001', remoteName: 'ACME', site: CLOUD });
  await assert.rejects(jira.resolveRemote(http, { remoteName: 'ACME/../x', site: CLOUD }), e => e.failure === 'not-found');
  await assert.rejects(jira.resolveRemote(http, { remoteName: 'ACME', site: 'not a host' }), e => e.failure === 'error');
  const renamed = hosted({ routes: cloudRoutes({ [`https://${CLOUD}/rest/api/3/project/ACME`]: reply(200, { id: '10001', key: 'OTHER' }) }) });
  await assert.rejects(jira.resolveRemote(renamed.http, { remoteName: 'ACME', site: CLOUD }), e => e.failure === 'invalid-response');
  const it = await jira.getItem(http, { remote: remote(CLOUD), ref: 'ACME-12' });
  assert.equal(it.key, 'issue:jira@acme.atlassian.net:10001:ACME-12');
  await assert.rejects(jira.getItem(http, { remote: remote(CLOUD), ref: 'ACME-12/../../x' }), e => e.failure === 'error');
  assert.deepEqual(jira.issueRefsIn(remote(CLOUD), 'feature/ACME-12-sign-in fixes ACME-3, not OTHER-4, XACME-5 or ACME-0'),
    ['issue:jira@acme.atlassian.net:10001:ACME-12', 'issue:jira@acme.atlassian.net:10001:ACME-3']);
  assert.equal(typeof jira.matchesOrigin, 'undefined', 'a Jira project has no repository: its keys count in every repository');
  assert.deepEqual(await jira.health(http), { state: 'ok', retryAt: null });
});

test('JR7: sign-in problems: a revoked or reconnect-needing account, a 401, and a host without the grant', async () => {
  const jira = createJiraConnector({ id: 'jira' });
  for (const state of ['revoked', 'needs-reconnect', 'expired']) {
    await assert.rejects(jira.listItems(hosted({ state }).http, { remote: remote(CLOUD) }), e => e.failure === 'auth-required', state);
  }
  const bad = hosted({ routes: cloudRoutes({ [`https://${CLOUD}/rest/api/3/myself`]: reply(401, {}) }) });
  assert.deepEqual(await jira.health(bad.http), { state: 'auth-required', retryAt: null });
  const host = fakeHost({ accounts: { [ACCOUNT]: { connector: 'jira', site: CLOUD } }, routes: cloudRoutes(), grants: ['github'] });
  await assert.rejects(jira.listItems(accountHttp({ request: host.request, accountId: ACCOUNT, connector: 'jira' }), { remote: remote(CLOUD) }), e => e.detail === 'needs-host-update');
});
