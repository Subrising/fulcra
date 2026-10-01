import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const url = new URL('./repackage-command-centre.mjs', import.meta.url);
const source = fs.readFileSync(url, 'utf8').replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', JSON.stringify(url.href));
test('builder retry resolves binary from product root regardless of caller cwd', () => {
  let call;
  vm.runInNewContext(source, { URL, path, fileURLToPath, process: { env: { FULCRA_PACKAGE_CONFIG: '/scratch/config.json', FULCRA_PACKAGE_OUTPUT: '/scratch/output' } }, execFileSync: (...args) => { call = args; } });
  const root = fileURLToPath(new URL('../', url));
  assert.equal(call[0], path.join(root, 'node_modules/.bin/electron-builder'));
  assert.equal(call[2].cwd, path.join(root, 'packages/desktop'));
  assert.ok(call[1].includes('-c.directories.output=/scratch/output'));
  assert.equal(call[2].env.PASEO_DESKTOP_SMOKE, '0');
});
test('builder retry requires an explicit config and output', () => {
  assert.throws(() => vm.runInNewContext(source, { URL, path, fileURLToPath, process: { env: {} } }), /explicit verified/);
});
