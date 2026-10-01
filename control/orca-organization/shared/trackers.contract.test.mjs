// J3 RPC contract (J3-DESIGN.md §6, mutation M7). Runs the TypeScript contract directly under Node's type
// stripping. Inputs are strict — no repository, URL or credential can be named by a caller — and the real
// service outputs (controller-backed harness) must satisfy the output schemas J2 and the panel consume.
import test from 'node:test'; import assert from 'node:assert/strict';
import { trackersRpc, trackerMapRpc, trackerLinkRpc, trackerUnlinkRpc, trackerResolveRpc, trackerDirectoryRpc } from './trackers.ts';
import { harness, mapScratch, P, T } from '../server/trackers/harness.mjs';

test('T1: no RPC input can name a repository, host, URL or credential', () => {
  const read = { projectId: P(1) };
  assert.equal(trackersRpc.input.safeParse(read).success, true);
  for (const extra of [{ repo: 'Evil/other' }, { remoteId: '999' }, { url: 'https://evil.example' }, { token: 'x' }, { site: 'evil.example' }]) {
    assert.equal(trackersRpc.input.safeParse({ ...read, ...extra }).success, false, JSON.stringify(extra));
  }
  const link = { projectId: P(1), subject: { kind: 'task', id: T(1) }, itemRef: '7', expectedMappingRevision: 1 };
  assert.equal(trackerLinkRpc.input.safeParse(link).success, true);
  for (const extra of [{ repo: 'a/b' }, { url: 'https://github.com/a/b/issues/7' }, { remoteId: '1' }]) assert.equal(trackerLinkRpc.input.safeParse({ ...link, ...extra }).success, false);
  assert.equal(trackerLinkRpc.input.safeParse({ ...link, subject: { kind: 'channel', id: T(1) } }).success, false);
  const map = { projectId: P(1), tracker: 'github', auth: 'keychain', site: '', remoteName: 'a/b', confirmRemoteId: '1', expectedRevision: 0, note: '' };
  assert.equal(trackerMapRpc.input.safeParse(map).success, true);
  for (const extra of [{ token: 'x' }, { remoteId: '1' }, { credential: 'x' }]) assert.equal(trackerMapRpc.input.safeParse({ ...map, ...extra }).success, false);
  assert.equal(trackerMapRpc.input.safeParse({ ...map, auth: 'token' }).success, false);
  assert.equal(trackerResolveRpc.input.safeParse({ tracker: 'github', auth: 'keychain', site: '', remoteName: 'a/b', projectId: P(1) }).success, false);
  assert.equal(trackerDirectoryRpc.input.safeParse({ any: 1 }).success, false);
});

test('T2: outputs carry only https tracker URLs and no extra fields', () => {
  const item = { key: 'github:1:7', projectId: P(1), ref: '#7', title: 't', state: 'open', labels: [], url: 'https://github.com/a/b/issues/7', updatedAt: null, stale: false, fromPreviousMapping: false };
  const out = items => ({ version: 1, observedAt: '2026-09-23T00:00:00.000Z', partial: false, projects: [], items, links: [] });
  assert.equal(trackersRpc.output.safeParse(out([item])).success, true);
  for (const bad of [{ url: 'javascript:alert(1)' }, { url: 'http://github.com/a/b/issues/7' }, { url: 'https://evil.example/a' }, { authorization: 'Bearer x' }, { body: 'text' }]) {
    assert.equal(trackersRpc.output.safeParse(out([{ ...item, ...bad }])).success, false, JSON.stringify(bad));
  }
});

test('T3: the real service outputs satisfy every output schema', async t => {
  const h = harness(t);
  const mapped = await mapScratch(h.service); assert.equal(trackerMapRpc.output.safeParse(mapped).success, true);
  assert.equal(trackerResolveRpc.output.safeParse(await h.service.resolve({ tracker: 'github', auth: 'keychain', site: '', remoteName: 'Subrising/scratch' })).success, true);
  const linked = await h.service.link({ projectId: P(1), subject: { kind: 'task', id: T(1) }, itemRef: '12', expectedMappingRevision: 1 });
  assert.equal(trackerLinkRpc.output.safeParse(linked).success, true);
  for (const view of [await h.service.read({ projectId: P(1) }), await h.service.read({ subjects: [T(1)] }), await h.service.read({ projectId: P(2) })]) {
    const parsed = trackersRpc.output.safeParse(view); assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  }
  assert.equal(trackerDirectoryRpc.output.safeParse(await h.service.directory()).success, true);
  const refused = await h.service.link({ projectId: P(1), subject: { kind: 'task', id: T(2) }, itemRef: '7', expectedMappingRevision: 1 });
  assert.equal(trackerLinkRpc.output.safeParse(refused).success, true); assert.equal(refused.ok, false);
  const view = await h.service.read({ subjects: [T(1)] });
  assert.equal(trackerUnlinkRpc.output.safeParse(await h.service.unlink({ linkId: view.links[0].id, expectedRevision: view.links[0].revision })).success, true);
});
