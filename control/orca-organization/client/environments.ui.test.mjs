// Fulcra J8 Environments behaviour with synthetic component adapters (not a Paseo/phone UI test). The test ids
// (env-row-<key>, env-promote, env-checklist) are the ones the brief fixes. Nothing here can run a promotion.
import { EnvironmentsSurface } from './environments';
import { environmentsRpc } from '../shared/cc/environment';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { JSDOM } from 'jsdom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { calls, setHandler } from './ui-test-adapters.mjs';
import { view, projects, DEV, NEXT, V2, PROMOTION } from '../screens/environments-fixture.mjs';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://component.test' });
globalThis.window = dom.window; globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { render, screen, fireEvent, waitFor, cleanup } = await import('@testing-library/react');
const h = React.createElement;
const theme = { colors: { foreground: '#fff', foregroundMuted: '#ccc', border: '#888', accent: '#06f', accentForeground: '#fff', surface0: '#111', surface1: '#191f2a', surface2: '#263246', statusSuccess: '#0a0', statusWarning: '#aa0', statusDanger: '#a00' } };
const clients = [];
function mount(compact = true) { const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(client); return render(h(QueryClientProvider, { client }, h(EnvironmentsSurface, { theme, layout: { compact, platform: 'web' }, host: { id: 'host-demo', label: 'Demo' } }))); }
afterEach(() => { cleanup(); for (const c of clients.splice(0)) c.clear(); });
const serve = (v = view(), created = { ok: true, message: null, observedAt: new Date().toISOString(), promotion: view().promotions[0].promotion, waiting: null }) => setHandler(name =>
  name === 'organization.projects' ? Promise.resolve(projects()) : name === 'organization.environments' ? Promise.resolve(v) : name === 'organization.promotion-create' ? Promise.resolve(created) : Promise.reject(new Error(`unexpected ${name}`)));
const READS = ['organization.projects', 'organization.environments'];

test('the fixture is exactly what organization.environments returns', () => { environmentsRpc.output.parse(view()); });

test('dev → next → prod: what is where, when, by whom and how it is doing, in plain words', async () => {
  serve(); mount(false);
  const next = await screen.findByTestId('env-row-next');
  assert.ok(screen.getByTestId('env-row-dev') && screen.getByTestId('env-row-prod'));
  assert.match(next.textContent, /Next/); assert.match(next.textContent, /The practice copy customers don't see yet/); assert.match(next.textContent, /put there by you/); assert.match(next.textContent, /Runs on a Fulcra host/);
  assert.match(screen.getByTestId('env-row-prod').textContent, /Needs attention/);
  assert.equal(screen.queryByText(/7c7c7c7/), null, 'no version id outside Details');
  assert.ok(calls.every(c => READS.includes(c.name)));
});

test('the setup checklist shows pass, fail and not-checked, for the chosen environment', async () => {
  serve(); mount();
  const checklist = await screen.findByTestId('env-checklist');
  assert.match(checklist.textContent, /Setup checklist for Next/); assert.match(checklist.textContent, /The practice site answers/); assert.match(checklist.textContent, /Not checked yet/);
  fireEvent.click(screen.getByTestId('env-row-prod'));
  await waitFor(() => assert.match(screen.getByTestId('env-checklist').textContent, /Setup checklist for Live/));
  assert.ok(screen.getByLabelText('There is room for the new version: failed'));
});

test('Promote to next prepares the version on dev with the revision you saw, and says where to approve', async () => {
  // No promotion under way yet, so both promote buttons show; nothing is on Next's successor path blocked.
  serve(view({ promotions: [] }), { ok: true, message: null, observedAt: new Date().toISOString(), promotion: { ...view().promotions[0].promotion, state: 'proposed', decisionId: null }, waiting: 'Prepared. The approval can be asked by this project\'s orchestrator; asking it from the app needs the next decision-store update' });
  mount();
  const promote = await screen.findByTestId('env-promote');
  assert.ok(promote);
  fireEvent.click(screen.getByRole('button', { name: 'Promote to Next' }));
  await waitFor(() => assert.ok(calls.some(c => c.name === 'organization.promotion-create')));
  const call = calls.find(c => c.name === 'organization.promotion-create');
  assert.deepEqual({ ...call.input, messageId: undefined }, { messageId: undefined, projectId: view().projectId, from: DEV, to: NEXT, commit: V2, expectedRevision: 3 });
  await screen.findByText(/asking it from the app needs the next decision-store update/);
  assert.ok(calls.every(c => [...READS, 'organization.promotion-create'].includes(c.name)), 'no call runs a promotion');
});

test('a promotion waiting for approval shows what changes, readiness and how to undo, and sends you to the Inbox', async () => {
  serve(); mount();
  await screen.findByText(/To Next: Waiting for your approval/);
  assert.ok(screen.getByText('What changes: 4 files.')); assert.ok(screen.getByText(/Setup checks: 2 of 3 passed/));
  assert.ok(screen.getByText(/How to undo: If deploying or checking Next fails/));
  assert.ok(screen.getByText('Approve or decline it in your Inbox, on your paired device.'));
  assert.equal(screen.getByRole('button', { name: 'Promote to Next' }).disabled, true, 'one promotion to a place at a time');
  assert.equal(screen.queryByText('src/chart.ts'), null);
  fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
  assert.ok(screen.getByText('src/chart.ts'), 'file names are one tap away');
  assert.equal(screen.queryByRole('button', { name: /^Approve/ }), null, 'approving happens in the Inbox, on a paired device, never here');
  assert.ok(PROMOTION);
});

test('a stalled read keeps the last view and says so', async () => {
  serve(view({ stale: true, error: 'organization.environments did not finish within 20 s' })); mount();
  await screen.findByText('This view may be out of date. Fulcra is slow to answer; retrying.');
  assert.ok(screen.getByTestId('env-row-next'));
});
