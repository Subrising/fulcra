// Cutover: published outcomes can stay in the live folder (ORCA_OUTCOMES_DIR, the shared vault's decisions) via config
// outcomesRoot. Shared memory stays at <ORCA_HOME>/memory; an unset outcomesRoot is exactly V4's behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { firstRun, loadConfig } from '../../orca-organization/server/config.mjs';
import { installationPath } from '../../orca-organization/server/installation.ts';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'outcomes-root-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
function home(name, change) {
  const env = { ORCA_HOME: path.join(tmp, name) };
  firstRun(env);
  if (change) { const file = path.join(env.ORCA_HOME, 'config.json'), c = JSON.parse(fs.readFileSync(file, 'utf8')); change(c); fs.writeFileSync(file, JSON.stringify(c)); fs.chmodSync(file, 0o600); }
  return env;
}
test('unset: outcomes are read from <ORCA_HOME>/memory, as in V4', () => {
  const env = home('default');
  assert.equal(installationPath('outcomes', env), path.join(env.ORCA_HOME, 'memory'));
  assert.equal(loadConfig(env).memoryRoot, path.join(env.ORCA_HOME, 'memory'));
});
test('set: outcomes come from the configured folder; shared memory does not move', () => {
  const decisions = path.join(tmp, 'vault', 'decisions'); fs.mkdirSync(decisions, { recursive: true });
  const env = home('configured', c => { c.outcomesRoot = decisions; });
  assert.equal(installationPath('outcomes', env), decisions);
  assert.equal(loadConfig(env).memoryRoot, path.join(env.ORCA_HOME, 'memory'));
});
test('an outcomesRoot that is not an absolute normalized path is refused with the config', () => {
  for (const [i, value] of ['decisions', '/a/../b', '/a/b/', 42, ''].entries()) {
    const env = home('bad' + i, c => { c.outcomesRoot = value; });
    assert.throws(() => loadConfig(env), /Invalid setting outcomesRoot/, String(value));
  }
});
