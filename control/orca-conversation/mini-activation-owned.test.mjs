// Cutover A2 (f): verifyMiniActivation() off the legacy guard activation probe. Under the owned child it verifies the daemon
// itself: an admitted owner session, the verified plugin's management context, and the owned controller ready (health).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { verifyMiniActivation, verifyOwnedActivation } from './mini-activation.mjs';

const session = reply => { const log = { invokes: [], closes: 0 }; return { log, connect: async () => ({ invoke: async (...a) => { log.invokes.push(a); return typeof reply === 'function' ? reply() : reply; }, close: () => { log.closes++; } }) }; };

test('owned child: the owned-daemon check runs and the legacy guard probe does not; unset: the legacy probe, unchanged', async () => {
  const seen = [];
  const owned = async () => { seen.push('owned'); return { topology: 'owned-child' }; }, legacy = async () => { seen.push('legacy'); return {}; };
  await verifyMiniActivation({ ORCA_CONTROLLER_TOPOLOGY: 'owned-child' }, { owned, legacy });
  await verifyMiniActivation({}, { owned, legacy });
  assert.deepEqual(seen, ['owned', 'legacy']);
});

test('the owned check is the daemon\'s management health: ready passes, anything else refuses; the session is always closed', async () => {
  const ok = session({ status: 'observed', message: 'Controller connection confirmed', observedAt: '2026-09-28T00:00:00.000Z' });
  assert.deepEqual(await verifyOwnedActivation({ connect: ok.connect }), { topology: 'owned-child', observedAt: '2026-09-28T00:00:00.000Z' });
  assert.deepEqual(ok.log.invokes, [['organization.manage', { action: 'health' }]]); assert.equal(ok.log.closes, 1);
  for (const reply of [{ status: 'error', message: 'Controller starting' }, null, () => { throw Error('Management unavailable'); }]) {
    const s = session(reply);
    await assert.rejects(verifyOwnedActivation({ connect: s.connect }), /not verified|Management unavailable/);
    assert.equal(s.log.closes, 1);
  }
  await assert.rejects(verifyOwnedActivation({ connect: async () => { throw Error('ECONNREFUSED'); } }), /ECONNREFUSED/);
});

test('the Mini host probe also reads the owned child\'s task root', () => {
  const source = fs.readFileSync(new URL('./hosts.mjs', import.meta.url), 'utf8');
  assert.match(source, /base \+ '\/home\/command-centre\/tasks'/);
});
