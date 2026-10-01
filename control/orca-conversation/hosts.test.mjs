import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeSnapshot, hostOverview, probeHost } from './hosts.mjs';
const agent = (id, extra = {}) => ({ agent: { id, cwd: '/owned/tasks/' + id, status: 'idle', pendingPermissions: [], activeTurn: null, ...extra } });
const page = (entries, cursor = null) => ({ entries, pageInfo: { hasMore: cursor !== null, nextCursor: cursor } });
test('bounded pagination projects only owned metadata, including closed history', async () => {
  const calls = [], pages = [page([agent('one', { prompt: 'private', password: 'secret' }), agent('foreign', { cwd: '/unrelated' })], 'next'), page([agent('two', { status: 'closed' })])];
  const rows = await nativeSnapshot({ agents: { list: async options => { calls.push(options); return pages.shift(); } } }, ['/owned/tasks']);
  assert.equal(rows.length, 2); assert.equal(rows[1].status, 'closed'); assert.equal(rows[1].activeTurn, false);
  assert.equal(JSON.stringify(rows).includes('secret'), false); assert.equal(JSON.stringify(rows).includes('private'), false);
  assert.deepEqual(calls[1], { filter: { includeArchived: true }, page: { limit: 100, cursor: 'next' } });
});
test('malformed pages, missing cursor, duplicate identities and cursor loops fail closed', async () => {
  for (const pages of [[{}], [{ entries: [], pageInfo: { hasMore: true } }], [page([agent('one'), agent('one')])], [page([], 'loop'), page([], 'loop')]]) {
    await assert.rejects(nativeSnapshot({ agents: { list: async () => pages.shift() } }, ['/owned/tasks']));
  }
  let calls = 0;
  await assert.rejects(nativeSnapshot({ agents: { list: async () => page([], String(++calls)) } }, ['/owned/tasks']), /1000/);
  assert.equal(calls, 10);
});
test('unavailable Book is unknown; read-only Mini ownership and closed counts are explicit', async () => {
  const sessions = await nativeSnapshot({ agents: { list: async () => page([agent('a'), agent('b', { status: 'closed' }), agent('c', { activeTurn: { id: 'turn' }, pendingPermissions: [{}] })]) } }, ['/owned/tasks']);
  const state = await hostOverview({ probe: async host => { if (host === 'macbook') throw Error('secret stderr'); return { sessions }; }, ownership: async () => [{ id: 'a', cwd: '/owned/tasks/a', mode: 'human' }] });
  assert.deepEqual(state.hosts[0].counts, { saved: 3, closed: 1, activeTurns: 1, pendingPermissions: 1 });
  assert.equal(state.hosts[0].sessions[0].control, 'human'); assert.equal(state.hosts[0].sessions[1].control, 'not-enrolled');
  assert.equal(state.hosts[1].counts, null); assert.equal(JSON.stringify(state).includes('secret stderr'), false);
});
test('missing controller ownership stays unknown; Book discovery never acquires control', async () => {
  const sessions = [{ nativeId: 'a', cwd: '/owned/tasks/a', activeTurn: false, status: 'idle', pendingPermissions: 0 }];
  const state = await hostOverview({ probe: async () => ({ sessions }), ownership: async () => { throw Error('offline'); } });
  assert.equal(state.hosts[0].sessions[0].control, 'unknown'); assert.equal(state.hosts[1].sessions[0].control, 'observation-only');
  await assert.rejects(probeHost('arbitrary.example; command'), /Unknown fixed host/);
});

test('native optional activeTurn remains compatible and running status is never counted idle', async () => {
  const idle = agent('idle'), running = agent('running', { status: 'running' });
  delete idle.agent.activeTurn; delete running.agent.activeTurn;
  const rows = await nativeSnapshot({ agents: { list: async () => page([idle, running]) } }, ['/owned/tasks']);
  assert.equal(rows[0].activeTurn, false); assert.equal(rows[1].activeTurn, true);
});

test('reported usage preserves zero, validates numeric fields, and derives consistent context only', async () => {
  const cases = [undefined, {}, 'secret', [], { inputTokens: -1, outputTokens: 1.5, cachedInputTokens: '99', totalCostUsd: Infinity },
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalCostUsd: 0, contextWindowMaxTokens: 100, contextWindowUsedTokens: 0, secret: 'never disclose' },
    { inputTokens: 70, totalCostUsd: 0.0123, contextWindowMaxTokens: 100, contextWindowUsedTokens: 75 },
    { contextWindowMaxTokens: 100, contextWindowUsedTokens: 101 }, { contextWindowMaxTokens: 0, contextWindowUsedTokens: 0 },
    { contextWindowUsedTokens: 5 }, { inputTokens: Number.MAX_SAFE_INTEGER + 1, totalCostUsd: -1 }];
  const rows = await nativeSnapshot({ agents: { list: async () => page(cases.map((lastUsage, i) => agent(String(i), { lastUsage }))) } }, ['/owned/tasks']);
  for (const i of [0, 1, 2, 3, 4, 10]) assert.equal(rows[i].lastUsage, null);
  assert.deepEqual(rows[5].lastUsage, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalCostUsd: 0, contextWindowMaxTokens: 100, contextWindowUsedTokens: 0, contextWindowUsedPercent: 0, contextWindowRemainingTokens: 100 });
  assert.equal(rows[6].lastUsage.contextWindowUsedPercent, 75); assert.equal(rows[6].lastUsage.contextWindowRemainingTokens, 25);
  assert.equal(rows[6].lastUsage.totalCostUsd, 0.0123); assert.equal(rows[6].lastUsage.outputTokens, null);
  for (const i of [7, 8, 9]) { assert.equal(rows[i].lastUsage.contextWindowUsedPercent, null); assert.equal(rows[i].lastUsage.contextWindowRemainingTokens, null); }
  assert.equal(JSON.stringify(rows).includes('never disclose'), false);
});

test('snapshot serialized for the remote probe retains its usage validation without closure dependencies', async () => {
  const remote = (await import('node:vm')).runInNewContext('(' + nativeSnapshot.toString() + ')');
  const rows = await remote({ agents: { list: async () => page([agent('a', { lastUsage: { contextWindowMaxTokens: 200, contextWindowUsedTokens: 50 } })]) } }, ['/owned/tasks']);
  assert.equal(rows[0].lastUsage.contextWindowUsedPercent, 25); assert.equal(rows[0].lastUsage.inputTokens, null);
});

test('Book discovery projects only exact enrolled host, agent and directory bindings',async()=>{
  const cwd='/Users/test-user/.openclaw/owned-work/new/tasks/one';let roots;
  const rows=[{id:'central',host:'macbook',cwd,mode:'revoking',remote:{agentId:'book-agent',state:'revoking'}}];
  const result=await hostOverview({ownership:async()=>rows,probe:async(host,extra)=>{if(host==='macbook')roots=extra;return {sessions:[{nativeId:'book-agent',cwd},{nativeId:'parked',cwd},{nativeId:'book-agent',cwd:cwd+'-foreign'}]};}});
  assert.equal(result.hosts[1].sessions[0].control,'revoking');assert.equal(result.hosts[1].sessions[0].sessionId,'central');
  assert.equal(result.hosts[1].sessions[1].control,'observation-only');assert.equal(result.hosts[1].sessions[2].control,'observation-only');
  assert.deepEqual(roots,[cwd.slice(0,cwd.lastIndexOf('/'))]);assert.equal(rows.length,1);
});
