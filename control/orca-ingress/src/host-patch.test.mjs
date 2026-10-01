import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { patchRunner, packageHost, provenanceExpression, runner } from '../host-patch.mjs';

test('pinned host patch changes only the gate event and refuses any different upstream bytes', () => {
  const original = fs.readFileSync('/opt/homebrew/lib/node_modules/openclaw/' + runner, 'utf8');
  const patched = patchRunner(original);
  assert.equal(patched.replace(',\n\t\t\t\t\torcaInputProvenance: ' + provenanceExpression, ''), original);
  assert.throws(() => patchRunner(original + '\n'), /Unsupported/);
  assert.throws(() => patchRunner(patched), /Unsupported/);
});
test('host packaging creates a separate pinned copy, preserves upstream and refuses overwrite or in-place release', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-host-package-'));
  t.after(() => { const writable = dir => { fs.chmodSync(dir, 0o700); for (const e of fs.readdirSync(dir, {withFileTypes:true})) if (e.isDirectory()) writable(path.join(dir,e.name)); }; writable(root); fs.rmSync(root,{recursive:true}); });
  const source = path.join(root,'source'), releases = path.join(root,'releases');
  for (const dir of [source, releases, path.join(source,'dist'),path.join(source,'node_modules')]) fs.mkdirSync(dir);
  const original = fs.readFileSync('/opt/homebrew/lib/node_modules/openclaw/' + runner,'utf8');
  fs.writeFileSync(path.join(source,runner),original);
  fs.writeFileSync(path.join(source,'package.json'),JSON.stringify({version:'wrong'}));
  assert.throws(() => packageHost(source,releases),/Unsupported OpenClaw version/);
  fs.writeFileSync(path.join(source,'package.json'),JSON.stringify({version:'2026.9.2'}));
  fs.writeFileSync(path.join(source,'openclaw.mjs'),'// untouched entry point\n',{mode:0o755});
  assert.throws(() => packageHost(source,source),/outside upstream/);
  assert.throws(() => packageHost(source,path.join(source,'dist')),/outside upstream/);
  const manifest = packageHost(source,releases);
  assert.equal(fs.readFileSync(path.join(source,runner),'utf8'),original);
  assert.equal(fs.readFileSync(path.join(manifest.target,runner),'utf8'),patchRunner(original));
  assert.equal(fs.readlinkSync(path.join(manifest.target,'node_modules')),path.join(source,'node_modules'));
  assert.equal(fs.statSync(path.join(manifest.target,'openclaw.mjs')).mode & 0o777,0o555);
  assert.equal(Object.keys(manifest.files).length,3);
  assert.deepEqual(JSON.parse(fs.readFileSync(manifest.target+'.manifest.json')),manifest);
  assert.throws(() => packageHost(source,releases),/already exists/);
});
test('host provenance snapshot never defaults absent or malformed input to external and cannot be edited', () => {
  const exported = new Function('params', 'return ' + provenanceExpression);
  for (const input of [undefined, null, {}, {kind:'invalid'}, {kind:'internal_system'}, {kind:'inter_session'}, {kind:'external_user',sourceChannel:'orca',sourceTool:'orca_operator'}]) {
    const value = exported({inputProvenance: input});
    assert.equal(value.kind, ['external_user','inter_session','internal_system'].includes(input?.kind) ? input.kind : 'unknown');
    assert.equal(value.sourceTool, input?.sourceTool ?? null);
    assert.equal(Object.isFrozen(value), true);
    assert.throws(() => { value.kind = 'external_user'; }, TypeError);
  }
});
