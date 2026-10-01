import test from 'node:test';
import assert from 'node:assert/strict';
import { needsTitle, nameNewWorkspace, nameExistingWorkspaces, MAX_WORKSPACE_TITLE } from './workspace-titles.mjs';

const U1 = '00000000-0000-48c7-b1d9-000000002001', U2 = '00000000-0000-4617-9247-000000002016', U3 = '00000000-0000-48b6-8636-000000002023';
// Fake host: agents keyed by id -> snapshot; workspaces keyed by id -> descriptor; records every title set.
function host({ agents = {}, workspaces = [], pageSize = 200, failFor = new Set() } = {}) {
  const sets = [];
  return {
    sets,
    agents: { ref: id => ({ refresh: async () => { if (failFor.has(id)) throw Error('gone'); }, current: () => agents[id] ?? null }) },
    daemon: {
      async setWorkspaceTitle(workspaceId, title) { sets.push([workspaceId, title]); return { title }; },
      async fetchWorkspaces({ page }) {
        const start = page?.cursor ? Number(page.cursor) : 0, entries = workspaces.slice(start, start + pageSize), next = start + pageSize;
        return { entries, pageInfo: { hasMore: next < workspaces.length, nextCursor: next < workspaces.length ? String(next) : null, prevCursor: null } };
      },
    },
  };
}

test('needsTitle: only an untitled workspace still named after a bare UUID folder', () => {
  assert.equal(needsTitle({ name: U1, title: null }), true);
  assert.equal(needsTitle({ name: U1 }), true);
  assert.equal(needsTitle({ name: U1, title: 'Launch plan' }), false, 'a title someone chose is never overwritten');
  assert.equal(needsTitle({ name: 'main', title: null }), false, 'a branch- or human-named workspace is left alone');
  assert.equal(needsTitle({ name: `${U1}-x`, title: null }), false);
  assert.equal(needsTitle(undefined), false);
});

test('a new session titles its new workspace with the session title', async () => {
  const h = host({ agents: { a1: { workspaceId: 'w1', title: 'CC V1b: verify' } } });
  assert.deepEqual(await nameNewWorkspace(h, 'a1', '  CC V1b: verify and fix V1 host hooks  '), { titled: true, workspaceId: 'w1' });
  assert.deepEqual(h.sets, [['w1', 'CC V1b: verify and fix V1 host hooks']]);
});

test('new-session naming is bounded and never throws for a missing title, workspace or old host', async () => {
  const h = host({ agents: { a1: { workspaceId: 'w1' }, a2: {} } });
  await nameNewWorkspace(h, 'a1', 'x'.repeat(500));
  assert.equal(h.sets[0][1].length, MAX_WORKSPACE_TITLE);
  assert.deepEqual(await nameNewWorkspace(h, 'a1', '   '), { titled: false, reason: 'unsupported' });
  assert.deepEqual(await nameNewWorkspace(h, 'a2', 'CC J'), { titled: false, reason: 'no workspace' });
  assert.deepEqual(await nameNewWorkspace({ agents: h.agents, daemon: {} }, 'a1', 'CC J'), { titled: false, reason: 'unsupported' });
});

test('backfill titles only UUID-named untitled workspaces, across pages, once each, and survives failures', async () => {
  const workspaces = [
    { id: 'w1', name: U1, title: null },            // controller folder, untitled -> titled
    { id: 'w2', name: U2, title: 'The owner named it' }, // user title -> kept
    { id: 'w3', name: 'main', title: null },         // normal repo workspace -> untouched
    ...Array.from({ length: 5 }, (_, i) => ({ id: `pad${i}`, name: 'x', title: null })),
    { id: 'w4', name: U3, title: null },            // on a later page -> still found
  ];
  const agents = {
    a1: { workspaceId: 'w1', title: 'CC V1b: verify' }, a2: { workspaceId: 'w2', title: 'CC V2' }, a3: { workspaceId: 'w3', title: 'CC X' },
    a4: { workspaceId: 'w4', title: 'CC WL: clean-up' }, a5: { workspaceId: 'w1', title: 'CC dup' }, a6: { workspaceId: 'w4', title: '' },
  };
  const h = host({ agents, workspaces, pageSize: 3, failFor: new Set(['bad']) });
  const r = await nameExistingWorkspaces(h, ['a1', 'a2', 'a3', 'a4', 'a5', 'bad', 'missing']);
  assert.deepEqual(h.sets, [['w1', 'CC V1b: verify'], ['w4', 'CC WL: clean-up']]);
  assert.deepEqual(r, { titled: 2, skipped: 4, failed: 1 });
});

test('backfill on a host without the workspace APIs does nothing', async () => {
  const r = await nameExistingWorkspaces({ agents: host().agents, daemon: {} }, ['a1', 'a2']);
  assert.deepEqual(r, { titled: 0, skipped: 2, failed: 0 });
});
