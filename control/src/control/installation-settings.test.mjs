import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { firstRun } from '../config.mjs';
import { describeSessionDefaults, installationConfig, settingsPath, settingsStatus } from './installation-settings.mjs';
import { sessionDefaults } from './provider-mode.mjs';
function home(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-settings-')));
  firstRun({ ORCA_HOME: dir }); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function write(dir, defaults) {
  const file = settingsPath(dir), config = JSON.parse(fs.readFileSync(file));
  config.defaults = defaults; fs.writeFileSync(file, JSON.stringify(config));
}
const chosen = (dir, provider, override = {}) => sessionDefaults(provider, override, installationConfig(dir, null));
test('first-run config supplies product defaults from the single config source', t => {
  const dir = home(t), c = chosen(dir, 'claude');
  assert.equal(c.modeId, 'auto'); assert.equal(c.thinkingOptionId, 'medium'); assert.equal(c.ask, null);
  assert.equal(settingsStatus(dir, null).path, path.join(dir, 'config.json'));
  assert.equal(settingsStatus(dir, null).present, true);
});
test('configured defaults and per-spawn overrides retain their precedence', t => {
  const dir = home(t);
  write(dir, { thinkingOptionId: 'low', modes: { claude: 'plan', codex: 'auto' }, ask: { claude: ['Write'] } });
  const c = chosen(dir, 'claude'); assert.equal(c.modeId, 'plan'); assert.equal(c.thinkingOptionId, 'low'); assert.deepEqual(c.ask, ['Write']);
  const override = chosen(dir, 'claude', { modeId: 'acceptEdits', thinkingOptionId: 'max', ask: [] });
  assert.equal(override.modeId, 'acceptEdits'); assert.equal(override.thinkingOptionId, 'max'); assert.equal(override.ask, null);
  assert.equal(chosen(dir, 'codex').modeId, 'auto');
});
test('refused provider settings stay refused and malformed config does not fall back', t => {
  const dir = home(t);
  // Update-7 W3: Codex full-access is owner-approved (the default for new Codex sessions); Claude bypass stays refused.
  write(dir, { modes: { codex: 'full-access' } }); assert.equal(chosen(dir, 'codex').modeId, 'full-access');
  for (const [provider, mode] of [['claude','bypassPermissions']]) {
    write(dir, { modes: { [provider]: mode } });
    assert.throws(() => chosen(dir, provider), /broadens access/);
    write(dir, {}); assert.throws(() => chosen(dir, provider, { modeId: mode }), /broadens access/);
  }
  write(dir, { ask: { codex: ['Write'] } }); assert.throws(() => chosen(dir, 'codex'), /codex has no ask list/);
  fs.writeFileSync(settingsPath(dir), 'not json'); assert.throws(() => installationConfig(dir, null));
});
test('private config validation and missing config fail closed', t => {
  const dir = home(t), file = settingsPath(dir);
  fs.chmodSync(file, 0o644); assert.throws(() => installationConfig(dir, null), /Private/);
  fs.unlinkSync(file); fs.writeFileSync(path.join(dir, 'session-defaults.json'), JSON.stringify({ version: 1, defaults: {} }));
  assert.throws(() => installationConfig(dir, null), /ENOENT/);
});
test('status view identifies a controller that does not serve settings', () => {
  const lines = describeSessionDefaults({ providers: {} }, { path: '/owned/config.json', present: true });
  assert.ok(lines.some(l => l.includes('DOES NOT SERVE')));
});
