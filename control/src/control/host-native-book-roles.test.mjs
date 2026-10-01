// DESIGN-NEXT-BUILD A3 (C9): a Book released before role defaults refuses the forwarded fields before recording
// anything; the controller then creates exactly as before and says the role defaults did not apply there.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlStore } from './store.mjs';
import { HostNative, bookRoleSelection } from './host-native.mjs';
import { portable } from '../portable-config.mjs';

const configFile = path.join(portable.home, 'config.json'), original = fs.readFileSync(configFile, 'utf8');
function world(t, book) {
  t.after(() => fs.writeFileSync(configFile, original, { mode: 0o600 }));
  const c = JSON.parse(original); c.defaults = { ...c.defaults, roles: { implementation: { claude: { model: 'claude/claude-sonnet-5-5', thinkingOptionId: 'high' } } } };
  fs.writeFileSync(configFile, JSON.stringify(c, null, 2), { mode: 0o600 });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-host-roles-'))), store = new ControlStore(path.join(dir, 'journal.sqlite'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return new HostNative({ store, local: { create: async () => assert.fail('never local') }, book });
}
const a = extra => ({ messageId: randomUUID(), taskId: randomUUID(), provider: 'claude', title: 'Book role work', host: 'macbook', ...extra });

test('only role or explicit values are forwarded, as bare model ids', t => {
  world(t, async () => {});
  assert.deepEqual(bookRoleSelection(a({ role: 'implementation' })), { model: 'claude-sonnet-5-5', thinkingOptionId: 'high' });
  assert.deepEqual(bookRoleSelection(a({})), {});
  assert.deepEqual(bookRoleSelection(a({ defaults: { thinkingOptionId: 'max' } })), { thinkingOptionId: 'max' });
});

test('an older Book that refuses the selection gets the previous body, once; any other failure is not retried', async t => {
  const bodies = [];
  const older = async (_action, input) => { bodies.push(input); if (input.model !== undefined) throw Error('Invalid receiver creation'); return { id: input.sessionId, agentId: randomUUID(), cwd: '/book/tasks/' + input.messageId, host: 'macbook' }; };
  const out = await world(t, older).create(a({ role: 'implementation' }));
  assert.equal(bodies.length, 2); assert.deepEqual(Object.keys(bodies[1]).sort(), ['messageId', 'provider', 'sessionId', 'taskId', 'title']);
  assert.equal(out.selection.fallback[0].reason, 'book-predates-role-defaults');
  const down = [];
  const offline = async (_action, input) => { down.push(input); throw Error('Book offline'); };
  await assert.rejects(world(t, offline).create(a({ role: 'implementation' })), /Book offline/); assert.equal(down.length, 1);
});
