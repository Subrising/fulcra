// Cutover (A2, home only): the conversation client's controller home is configurable for the owned controller child;
// unset keeps the legacy home. Writes are NOT rerouted here (see the prime's A2 decision): on the owned child's socket they
// are still refused, which management-dispatch.test.mjs (IR-5) proves for the socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { controllerHome, LEGACY_HOME } from './client.mjs';

test('unset or empty keeps the legacy controller home', () => {
  assert.equal(controllerHome({}), LEGACY_HOME);
  assert.equal(controllerHome({ ORCA_CONVERSATION_CONTROLLER_HOME: '' }), LEGACY_HOME);
});
test('an absolute canonical override is used; anything else refuses', () => {
  assert.equal(controllerHome({ ORCA_CONVERSATION_CONTROLLER_HOME: '/srv/paseo/home/command-centre' }), '/srv/paseo/home/command-centre');
  for (const value of ['relative/home', '/a/../b', '/a/b/', '/a//b'])
    assert.throws(() => controllerHome({ ORCA_CONVERSATION_CONTROLLER_HOME: value }), /absolute canonical path/, value);
});
test('the module home follows the environment of the process that loads it', () => {
  const load = env => spawnSync(process.execPath, ['--input-type=module', '-e', "const m = await import('./client.mjs'); console.log(m.home);"],
    { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8', env: { ...process.env, ...env } });
  const set = load({ ORCA_CONVERSATION_CONTROLLER_HOME: '/srv/paseo/home/command-centre' });
  assert.equal(set.status, 0, set.stderr); assert.equal(set.stdout.trim(), '/srv/paseo/home/command-centre');
  const unset = load({ ORCA_CONVERSATION_CONTROLLER_HOME: '' });
  assert.equal(unset.status, 0, unset.stderr); assert.equal(unset.stdout.trim(), LEGACY_HOME);
});
