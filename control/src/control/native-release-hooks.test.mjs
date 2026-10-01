import test from 'node:test';
import assert from 'node:assert/strict';
import { bindGuardHome, patchNativeHooks, replaceOnce } from './native-release-hooks.mjs';
test('guard rebinding uses exactly one source anchor and preserves literal path text', () => {
  const source = "const HOME = process.env.ORCA_ADMISSION_HOME ?? '/path/to/unconfigured/controller';\nconst FILE = HOME + '/journal.sqlite';";
  assert.equal(bindGuardHome(source, '/path/to/controller'), 'const HOME = "/path/to/controller";\nconst FILE = HOME + \'/journal.sqlite\';');
  assert.equal(bindGuardHome(source, '/private/$&/"home'), 'const HOME = "/private/$&/\\"home";\nconst FILE = HOME + \'/journal.sqlite\';');
  assert.throws(() => bindGuardHome(source + source, '/private'), /anchor changed/);
  assert.throws(() => bindGuardHome('unknown', '/private'), /anchor changed/);
});
test('unknown and already patched native modules cannot acquire a second hook', () => {
  for (const value of [undefined, 'orcaAdmissionGuard', 'orcaPermissionGuard', 'upstream changed']) {
    assert.throws(() => patchNativeHooks({ 'agent/agent-manager.js': value }, '/private/guard.mjs'), /hook/);
  }
  assert.throws(() => replaceOnce('same same', 'same', 'new'), /anchor changed/);
  assert.equal(replaceOnce('one anchor', 'anchor', '$& literal'), 'one $& literal');
});
