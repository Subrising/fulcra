import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const url = new URL('./package-command-centre.mjs', import.meta.url);
const source = fs.readFileSync(url, 'utf8').replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', JSON.stringify(url.href));
function calls(env) {
  const result = [];
  vm.runInNewContext(source, { path, URL, fileURLToPath, process: { argv: ['node', 'script', '/reviewed/control'], execPath: '/node', env }, execFileSync: (...args) => result.push(args) });
  return result;
}
test('default package location and build scratch stay unchanged', () => {
  const result = calls({ TMPDIR: '/external/scratch' });
  assert.equal(result.length, 5);
  assert.equal(result.at(-1)[1].some(x => x.startsWith('-c.directories.output=')), false);
  for (const call of result) assert.equal(call[2].env.TMPDIR, '/external/scratch');
});
test('run-only output and temp overrides apply only to electron-builder', () => {
  const result = calls({ TMPDIR: '/external/scratch', FULCRA_PACKAGE_OUTPUT: '/private/tmp/task/output', FULCRA_BUILDER_TMP: '/private/tmp/task/builder-tmp' });
  for (const call of result.slice(0, -1)) assert.equal(call[2].env.TMPDIR, '/external/scratch');
  const builder = result.at(-1);
  assert.ok(builder[1].includes('-c.directories.output=/private/tmp/task/output'));
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) assert.equal(builder[2].env[name], '/private/tmp/task/builder-tmp');
  assert.equal(builder[2].env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
});

test('scratch web output uses the desktop export mode and run-specific builder config', () => {
  const result = calls({ FULCRA_WEB_OUTPUT: '/private/tmp/task/web', FULCRA_PACKAGE_CONFIG: '/private/tmp/task/builder.json' });
  const expo = result.find(call => call[0].endsWith('/.bin/expo'));
  assert.ok(expo);
  assert.equal(expo[1].join(' '), 'export --platform web --output-dir /private/tmp/task/web');
  assert.equal(expo[2].env.PASEO_WEB_PLATFORM, 'electron');
  assert.ok(result.at(-1)[1].includes('/private/tmp/task/builder.json'));
  assert.ok(result.some(call => call[1].join(' ') === 'run build:app-deps'));
});
