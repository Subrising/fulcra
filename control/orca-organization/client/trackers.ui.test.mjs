// J3 tracker UI behaviour with synthetic component adapters (not a Paseo/phone UI test).
import { TrackerProjectPanel, statusText } from './trackers';
import { WorkGraph } from './work-graph';
import { openTrackerUrl } from './tracker-link';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { JSDOM } from 'jsdom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { calls, setHandler, openedUrls } from './ui-test-adapters.mjs';
import { forgetAll } from './last-good';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://component.test' });
globalThis.window = dom.window; globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { render, screen, fireEvent, waitFor, cleanup } = await import('@testing-library/react');
const h = React.createElement;
const theme = { colors: { foreground: '#fff', foregroundMuted: '#ccc', border: '#888', accent: '#06f', accentForeground: '#fff', surface0: '#111', surface1: '#191f2a', surface2: '#263246' } };
const PROJECT = '22222222-2222-4222-8222-000000000001', TASK = '33333333-3333-4333-8333-000000000001', SESSION = '55555555-5555-4555-8555-000000000001', LINK = '66666666-6666-4666-8666-000000000001';
const HOSTILE = 'Fix <img src=x onerror=alert(1)> [github.com](https://evil.example)';
const clients = [];
function mount(component) { const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(client); return render(h(QueryClientProvider, { client }, component)); }
afterEach(() => { cleanup(); for (const c of clients.splice(0)) c.clear(); openedUrls.length = 0; forgetAll(); });
const mapping = { projectId: PROJECT, tracker: 'github', auth: 'keychain', site: 'github.com', remoteId: '123456', remoteName: 'Subrising/scratch', state: 'mapped', revision: 1, validatedAt: null, note: '', at: '2026-09-23T00:00:00.000Z' };
const project = (m = mapping) => ({ id: PROJECT, name: 'Orca platform', mapping: m, tasks: [TASK], sessions: [{ id: SESSION, task: TASK }] });
const item = { key: 'github:123456:7', projectId: PROJECT, ref: '#7', title: HOSTILE, state: 'open', labels: ['bug'], url: 'https://github.com/Subrising/scratch/issues/7', updatedAt: null, stale: false, fromPreviousMapping: false };
const view = (extra = {}) => ({ version: 1, observedAt: '2026-09-23T00:00:00.000Z', partial: false, projects: [{ projectId: PROJECT, tracker: 'github', remoteName: 'Subrising/scratch', mappingRevision: 1, status: 'ok', retryAt: null, observedAt: '2026-09-23T00:00:00.000Z' }], items: [item], links: [{ id: LINK, itemKey: item.key, subject: { kind: 'task', id: TASK }, revision: 1 }], ...extra });

test('U1: hostile tracker titles render as literal plain text: no element, link or markup is created from them', async () => {
  setHandler(name => name === 'organization.trackers' ? view() : { ok: true, failure: null, message: null });
  const r = mount(h(TrackerProjectPanel, { project: project(), theme, onChanged: () => {} }));
  await waitFor(() => assert(screen.getByText(`#7 · ${HOSTILE}`)));
  assert.equal(r.container.querySelector('img'), null); assert.equal(r.container.querySelector('a'), null);
  assert.equal(screen.getByText(`#7 · ${HOSTILE}`).tagName, 'SPAN');
  assert(screen.getByText(/Linked to workstream 33333333/));
});

test('U2: the only way out is the explicit button, with the server-constructed URL; nothing else opens', async () => {
  setHandler(name => name === 'organization.trackers' ? view() : { ok: true, failure: null, message: null });
  mount(h(TrackerProjectPanel, { project: project(), theme, onChanged: () => {} }));
  await waitFor(() => assert(screen.getByRole('button', { name: 'Open #7 in tracker' })));
  assert.deepEqual(openedUrls, []);
  fireEvent.click(screen.getByRole('button', { name: 'Open #7 in tracker' }));
  assert.deepEqual(openedUrls, ['https://github.com/Subrising/scratch/issues/7']);
  for (const bad of ['javascript:alert(1)', 'https://evil.example/x', 'http://github.com/a/b/issues/1', 'https://github.com.evil.example/a']) assert.equal(openTrackerUrl(bad), false, bad);
  assert.deepEqual(openedUrls, ['https://github.com/Subrising/scratch/issues/7']);
});

test('U3: mapping shows what the tracker says the name is, then records exactly the confirmed id', async () => {
  setHandler((name, input) => name === 'organization.trackers' ? view({ projects: [{ projectId: PROJECT, tracker: null, remoteName: null, mappingRevision: 0, status: 'unmapped', retryAt: null, observedAt: null }], items: [], links: [] })
    : name === 'organization.trackers.resolve' ? { ok: true, failure: null, message: null, remoteId: '123456', remoteName: 'Subrising/scratch' }
    : { ok: true, failure: null, message: null, mapping });
  mount(h(TrackerProjectPanel, { project: project(null), theme, onChanged: () => {} }));
  assert(screen.getByRole('button', { name: 'GitHub CLI login — broad access (repo, workflow); Fulcra only reads' }));
  fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'subrising/scratch' } });
  fireEvent.click(screen.getByRole('button', { name: 'Check tracker' }));
  await waitFor(() => assert(screen.getByText('Map Orca platform to GitHub Subrising/scratch (id 123456)?')));
  assert.equal(calls.some(c => c.name === 'organization.trackers.map'), false, 'nothing recorded before confirmation');
  fireEvent.click(screen.getByRole('button', { name: 'Confirm mapping to Subrising/scratch' }));
  await waitFor(() => assert(calls.some(c => c.name === 'organization.trackers.map')));
  const resolveCall = calls.find(c => c.name === 'organization.trackers.resolve'), mapCall = calls.find(c => c.name === 'organization.trackers.map');
  assert.deepEqual(resolveCall.input, { tracker: 'github', auth: 'keychain', site: '', remoteName: 'subrising/scratch' });
  assert.deepEqual(mapCall.input, { projectId: PROJECT, tracker: 'github', auth: 'keychain', site: '', remoteName: 'Subrising/scratch', confirmRemoteId: '123456', expectedRevision: 0, note: '' });
});

test('U4: failure states say what happened and what to do, and stale is never shown as current', () => {
  assert.match(statusText('auth-required', 'github', null, null), /trackers-credential\.mjs set github$/);
  assert.match(statusText('auth-required', 'jira', null, null, 'acme.atlassian.net'), /set jira acme\.atlassian\.net$/, 'Jira needs its site or the command is refused');
  assert.match(statusText('stale', 'github', null, '2026-09-23T00:00:00.000Z'), /^STALE · last observed 2026-09-23/);
  assert.match(statusText('rate-limited', 'github', '2026-09-23T01:00:00.000Z', null), /after 2026-09-23T01:00/);
  assert.match(statusText('invalid-response', 'github', null, null), /nothing from it is shown/);
});

test('U5: a linked tracker item appears in the work graph; tapping inspects, and only the explicit button opens it', () => {
  const node = { id: SESSION, task: TASK, host: 'mini', agentId: SESSION, title: 'Session', provider: 'claude', model: null, mode: 'human', status: 'idle', pending: 0, observedAt: null, updatedAt: null, error: null };
  const fleet = { nodes: [node], tasks: [{ id: TASK, title: 'Task', identifier: 'ORC-1' }], edges: [], observedAt: 'now', total: 1, partial: false, note: '' };
  mount(h(WorkGraph, { fleet, shown: [node], selected: null, stale: false, frozen: false, theme, onSelect: () => {}, onTask: () => {}, trackers: view() }));
  // Tracker items sit in their own column right of reported paths; pan there as a user would.
  fireEvent.click(screen.getByRole('button', { name: 'Map controls' }));
  for (let i = 0; i < 6; i++) fireEvent.click(screen.getByRole('button', { name: 'Pan right' }));
  const card = screen.getByRole('button', { name: `tracker-issue #7 · ${HOSTILE}` });
  fireEvent.click(card);
  assert.deepEqual(openedUrls, []);
  fireEvent.click(screen.getByRole('button', { name: 'Open tracker item in browser' }));
  assert.deepEqual(openedUrls, ['https://github.com/Subrising/scratch/issues/7']);
});
