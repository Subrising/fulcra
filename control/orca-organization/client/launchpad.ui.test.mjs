// G1 LaunchPad inside Fulcra › Today, with synthetic component adapters: pull requests and issues across repos waiting
// on you or on others, the filters, the quick actions (open on GitHub, open the conversation, snooze and bring back),
// that it reads only (no tracker refresh, nothing sent to GitHub), and that no operator word reaches the page.
import { TodaySurface } from './today';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { JSDOM } from 'jsdom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { calls, setHandler, openedUrls } from './ui-test-adapters.mjs';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://component.test' });
globalThis.window = dom.window; globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { render, screen, fireEvent, waitFor, cleanup, within } = await import('@testing-library/react');
const h = React.createElement;
const theme = { colors: { foreground: '#fff', foregroundMuted: '#ccc', border: '#888', accent: '#06f', accentForeground: '#fff', surface0: '#111', surface1: '#191f2a', surface2: '#263246', statusSuccess: '#0a0', statusWarning: '#fa0', statusDanger: '#f33' } };
const P = '00000000-0000-46cd-9b65-000000002006', Q = '00000000-0000-46cd-9b65-000000002009', T = '00000000-0000-43b8-b458-000000002008';
const sid = n => `4c111479-b424-43e5-bd1e-${String(n).padStart(12, '0')}`;
const iso = ms => new Date(Date.now() - ms).toISOString();
const project = (projectId, name) => ({ projectId, name, status: 'in_progress', seat: null, channels: [], workstreams: 1, sessions: 1, running: 1 });
const map = { observedAt: iso(0), available: true, unavailable: null, primes: [], unplaced: [], attention: [], note: '', sources: { seats: true, channels: true, projects: { available: true, partial: false, note: '' }, fleet: { available: true, partial: false, observedAt: iso(0) } },
  projects: [project(P, 'Checkout app'), project(Q, 'Marketing site')] };
const fleet = { observedAt: iso(0), total: 1, partial: false, note: '', tasks: [], edges: [], nodes: [{ id: sid(7), task: T, host: 'local', agentId: sid(70), title: 'Tidy the basket', provider: 'claude', model: null, mode: 'delegated', status: 'running', pending: null, observedAt: null, updatedAt: iso(60000), error: null }] };
const it = (n, kind, state, assignee, ago, repo, links = []) => ({ item: { key: `${kind}:github:${repo}#${n}`, connector: 'github', kind, ref: `#${n}`, title: `${kind === 'pr' ? 'Make' : 'Fix'} thing ${n}`, state, url: `https://github.com/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${n}`, updatedAt: iso(ago), assignee, labels: [] }, stale: false, observedAt: iso(0), links, trail: [] });
const view = items => ({ version: 1, observedAt: iso(0), partial: false, trackers: [], items });
const views = {
  [P]: view([it(12, 'pr', 'open', 'sam-lee', 2 * 3600000, 'acme/checkout', [{ id: sid(900), from: `session:${sid(7)}`, to: 'pr:github:acme/checkout#12', relation: 'worked-by', provenance: 'reported', confidence: 'high', evidence: 'Opened by the session.', state: 'active', revision: 1, createdAt: iso(0), by: 'system:tracker' }]),
    it(15, 'issue', 'open', 'alex-dev', 3 * 86400000, 'acme/checkout'), it(16, 'pr', 'merged', 'alex-dev', 3600000, 'acme/checkout')]),
  [Q]: view([it(4, 'issue', 'in-progress', 'sam-lee', 9 * 86400000, 'acme/site'), it(5, 'pr', 'open', null, 30 * 60000, 'acme/site')]),
};
const integrations = name => ({ version: 1, observedAt: iso(0), partial: false, hostApi: true, connectors: [], accounts: [{ version: 1, id: P, connector: 'github', site: null, displayName: name, method: 'cli', scopes: [], state: 'connected', expiresAt: null, lastCheckedAt: iso(0), createdAt: iso(0) }] });
const empty = { version: 1, observedAt: iso(0), partial: false, stale: false, error: null, counts: { now: 0, today: 0, fyi: 0, decisions: 0, approvals: 0, held: 0, digests: 0, total: 0 }, items: [] };
const reads = (who = 'sam-lee') => (name, input) => name === 'organization.work-map' ? map : name === 'organization.fleet' ? fleet
  : name === 'organization.project-brief' ? { version: 1, observedAt: iso(0), partial: false, error: null, projectId: input.projectId, brief: null, authorName: null, stale: false, observed: null }
  : name === 'organization.inbox' ? empty : name === 'organization.recovery' ? { status: 'observed', observedAt: iso(0), recovery: { items: [] } }
  : name === 'organization.tracker-view' ? views[input.projectId] : name === 'organization.integrations' ? integrations(who)
  : Promise.reject(Error(`unexpected ${name}`));
const clients = [], opened = [];
const go = { inbox: () => {}, project: () => {}, recovery: () => {} };
function mount(compact = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(client);
  return render(h(QueryClientProvider, { client }, h(TodaySurface, { theme, layout: { compact, platform: 'web' }, host: { id: `launchpad-${clients.length}` }, go, navigation: { openAgent: ({ agentId }) => opened.push(agentId) } })));
}
afterEach(() => { cleanup(); for (const c of clients.splice(0)) c.clear(); opened.length = 0; openedUrls.length = 0; globalThis.window.localStorage.clear(); });
const rows = id => within(screen.getByTestId(id)).queryAllByTestId(/^launchpad-row-/).map(r => r.textContent.match(/#\d+/)[0]);

test('Needs you lists pull requests and issues across repos: waiting on you, then on others; it only reads', async () => {
  setHandler(reads());
  const r = mount();
  await waitFor(() => assert.deepEqual(rows('launchpad-you'), ['#12', '#4']));
  assert.deepEqual(rows('launchpad-others'), ['#5', '#15'], 'unassigned and assigned-to-others, newest first; merged ones are gone');
  assert(within(screen.getByTestId('today-needs').parentNode).getByTestId('launchpad'), 'inside the Needs you column');
  assert.match(screen.getByTestId('launchpad-row-' + P + ':pr:github:acme/checkout#12').textContent, /PULL REQUEST · acme\/checkout #12.*Assigned to you.*Checkout app/);
  assert(screen.getByText(/Review requests, requested changes and failing checks aren't shown yet/));
  assert.equal(screen.queryByText(/Approve/), null, 'no approve: the tracker connection cannot approve');
  assert(calls.some(c => c.name === 'organization.tracker-view' && c.input.projectId === Q));
  assert(!calls.some(c => /tracker-refresh|links\.set|tracker-mappings\.(map|unmap)/.test(c.name)), 'reads only');
  for (const word of [/\bseat\b/i, /\bgeneration\b/i, /\borchestrator\b/i, /\bprime\b/i, /\bOrca\b/, /\bPaseo\b/]) assert.doesNotMatch(r.container.textContent, word);
});

test('filters by repo, project, type and age narrow both lists, and clear again', async () => {
  setHandler(reads());
  mount();
  await waitFor(() => assert.equal(rows('launchpad-you').length, 2));
  fireEvent.click(screen.getByTestId('launchpad-filter-repo-acme/site'));
  await waitFor(() => assert.deepEqual([...rows('launchpad-you'), ...rows('launchpad-others')], ['#4', '#5']));
  assert.match(screen.getByTestId('launchpad-filter-summary').textContent, /Showing 2 of 4/);
  fireEvent.click(screen.getByText('Clear filters'));
  fireEvent.click(screen.getByTestId('launchpad-filter-kind-issue'));
  await waitFor(() => assert.deepEqual([...rows('launchpad-you'), ...rows('launchpad-others')], ['#4', '#15']));
  fireEvent.click(screen.getByTestId('launchpad-filter-kind-all')); fireEvent.click(screen.getByTestId(`launchpad-filter-project-${Q}`));
  await waitFor(() => assert.deepEqual(rows('launchpad-others'), ['#5']));
  fireEvent.click(screen.getByTestId('launchpad-filter-project-all')); fireEvent.click(screen.getByTestId('launchpad-filter-age-older'));
  await waitFor(() => assert.deepEqual([...rows('launchpad-you'), ...rows('launchpad-others')], ['#4']));
});

test('quick actions: open on GitHub, open the linked conversation, snooze and bring it back', async () => {
  setHandler(reads());
  mount();
  const key = `${P}:pr:github:acme/checkout#12`;
  await screen.findByTestId(`launchpad-open-${key}`);
  fireEvent.click(screen.getByTestId(`launchpad-open-${key}`));
  assert.deepEqual(openedUrls, ['https://github.com/acme/checkout/pull/12']);
  fireEvent.click(screen.getByTestId(`launchpad-session-${key}`));
  assert.deepEqual(opened, [sid(70)], 'the linked session opens as its conversation');
  fireEvent.click(screen.getByTestId(`launchpad-snooze-${key}`));
  fireEvent.click(screen.getByLabelText('Snooze until tomorrow'));
  await waitFor(() => assert.deepEqual(rows('launchpad-you'), ['#4']));
  fireEvent.click(screen.getByTestId('launchpad-snoozed-toggle'));
  assert.match(screen.getByTestId(`launchpad-snoozed-${key}`).textContent, /acme\/checkout #12 · until/);
  fireEvent.click(screen.getByTestId(`launchpad-wake-${key}`));
  await waitFor(() => assert.deepEqual(rows('launchpad-you'), ['#12', '#4']));
});

test('when the connected account is not an assignee, it says so and lists everything under waiting on others', async () => {
  setHandler(reads('Someone Else'));
  mount(true);
  await waitFor(() => assert.equal(rows('launchpad-others').length, 4));
  assert.equal(rows('launchpad-you').length, 0);
  assert(screen.getByText(/None of these are assigned to your connected account/));
});

// ---- GR review fixes M4-M6 (fail before, pass after) ----
const tracker = (observedAt, connector = 'github') => ({ mappingId: sid(501), connector, label: connector === 'github' ? 'GitHub' : 'Jira', remoteName: 'acme/checkout', commandLine: false, status: 'ok', retryAt: null, observedAt });
// Like the host: a refresh fetches and stores a project's items, and later reads of its view return what was stored.
function withViews(over, who = 'sam-lee', accounts) {
  const stored = new Set();
  const current = id => (stored.has(id) ? { ...over(id), items: views[id].items } : over(id));
  return (name, input) => {
    if (name === 'organization.tracker-refresh') { stored.add(input.projectId); return current(input.projectId); }
    if (name === 'organization.tracker-view') return current(input.projectId);
    if (name === 'organization.integrations') return accounts ? { ...integrations(who), accounts } : integrations(who);
    return reads(who)(name, input);
  };
}
const needsHeader = () => screen.getByTestId('today-needs').querySelector('[role="header"]').textContent;
const needChip = () => [...screen.getByTestId('today-counts').querySelectorAll('span')].map(s => s.textContent).find(t => /need you/.test(t));

test('M4: the Needs you header and chip count Waiting on you, and "Nothing needs you" never sits above it', async () => {
  setHandler(reads());
  mount();
  await waitFor(() => assert.deepEqual(rows('launchpad-you'), ['#12', '#4']));
  // The fixture already has 2 other things needing you (from its fleet); Waiting on you adds 2 more.
  assert.match(needsHeader(), /Needs you\s+4$/);
  assert.equal(needChip(), '4 need you');
  assert.equal(screen.queryByText('Nothing needs you right now.'), null);
  const key = `${P}:pr:github:acme/checkout#12`;
  fireEvent.click(screen.getByTestId(`launchpad-snooze-${key}`)); fireEvent.click(screen.getByLabelText('Snooze until tomorrow'));
  await waitFor(() => assert.equal(needChip(), '3 need you'), 'a snoozed item leaves the count');
  // Bring it back (the snooze store keeps a per-host memory that outlives the mount).
  fireEvent.click(screen.getByTestId('launchpad-snoozed-toggle')); fireEvent.click(screen.getByTestId(`launchpad-wake-${key}`));
  await waitFor(() => assert.equal(needChip(), '4 need you'));
});

test('M5: Today\'s Refresh also refreshes the stored tracker items of every project', async () => {
  setHandler(reads());
  mount();
  await waitFor(() => assert.equal(rows('launchpad-you').length, 2));
  assert(!calls.some(c => c.name === 'organization.tracker-refresh'), 'nothing fetched from a tracker before Refresh');
  fireEvent.click(screen.getByTestId('today-refresh'));
  await waitFor(() => assert.deepEqual(calls.filter(c => c.name === 'organization.tracker-refresh').map(c => c.input.projectId).sort(), [P, Q].sort()));
});

test('M5: never refreshed, then Refresh loads the items; refreshed and empty; nothing linked', async () => {
  setHandler(withViews(_id => ({ ...view([]), trackers: [tracker(null)] })));
  mount();
  const state = await screen.findByTestId('launchpad-never-refreshed');
  assert.match(state.textContent, /haven't been loaded yet/);
  fireEvent.click(within(state).getByTestId('launchpad-refresh'));
  await waitFor(() => assert.deepEqual(rows('launchpad-you'), ['#12', '#4']), 'the refresh result shows at once');
  cleanup();
  setHandler(withViews(_id => ({ ...view([]), trackers: [tracker(iso(0))] })));
  mount();
  assert.match((await screen.findByTestId('launchpad-empty')).textContent, /No open pull requests or issues/);
  cleanup();
  setHandler(withViews(_id => view([])));
  mount();
  assert.match((await screen.findByTestId('launchpad-no-trackers')).textContent, /No repos are linked/);
  assert.equal(screen.queryByTestId('launchpad-refresh'), null);
});

test('M6: "you" is the GitHub login of a connected account; no pooling across connectors; an unknown login shows the gap', async () => {
  // A Jira item assigned to someone whose Jira display name equals the GitHub login is not yours.
  const jira = { item: { key: 'issue:jira@acme.atlassian.net:SHOP-7', connector: 'jira', kind: 'issue', ref: 'SHOP-7', title: 'Fix the basket', state: 'open', url: 'https://acme.atlassian.net/browse/SHOP-7', updatedAt: iso(60000), assignee: 'sam-lee', labels: [] }, stale: false, observedAt: iso(0), links: [], trail: [] };
  setHandler(withViews(id => id === P ? view([...views[P].items, jira]) : views[id]));
  mount();
  await waitFor(() => assert.deepEqual(rows('launchpad-you'), ['#12', '#4']), 'the GitHub login matches GitHub items only');
  assert(within(screen.getByTestId('launchpad-others')).getByText(/Fix the basket/), 'the Jira item waits on others');
  assert(screen.getByText(/Can't tell which Jira items are yours/));
  cleanup();
  // The GitHub command-line login has no account record: nothing is yours, and the page says why.
  setHandler(withViews(id => views[id], 'sam-lee', []));
  mount();
  await waitFor(() => assert.equal(rows('launchpad-others').length, 4));
  assert.equal(rows('launchpad-you').length, 0);
  assert(screen.getByText(/Can't tell which GitHub items are yours/));
  assert.match(needsHeader(), /Needs you\s+2$/, 'only the fixture\'s own 2: no pull request or issue counted as yours');
});
