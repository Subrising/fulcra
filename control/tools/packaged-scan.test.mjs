import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanPackagedBundle } from './no-machine-ties.mjs';
test('whole packaged output resolves framework links inside the bundle and scans their targets', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'package-scan-')));
  try {
    fs.mkdirSync(path.join(root, 'Versions/A'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Versions/A/runtime'), 'portable');
    fs.symlinkSync('A', path.join(root, 'Versions/Current'));
    fs.symlinkSync('Versions/Current/runtime', path.join(root, 'Runtime'));
    assert.deepEqual(scanPackagedBundle(root), { files: ['Versions/A/runtime'], hits: [] });
    fs.writeFileSync(path.join(root, 'Versions/A/runtime'), ['', 'Users', 'fixture', 'machine'].join('/'));
    assert.equal(scanPackagedBundle(root).hits.length, 1); // mutation (w): skipped packaged scan
    fs.symlinkSync(os.tmpdir(), path.join(root, 'escaped'));
    assert.throws(() => scanPackagedBundle(root), /escaped/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('streaming scan finds machine ties across chunk boundaries without skipping binary bytes', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scan-boundary-')));
  try {
    const prefix = Buffer.alloc(65534, 0);
    fs.writeFileSync(path.join(root, 'binary'), Buffer.concat([prefix, Buffer.from(['', 'Users', 'fixture'].join('/'))]));
    assert.equal(scanPackagedBundle(root).hits.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('stream boundaries do not invent word boundaries', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scan-word-')));
  try {
    fs.writeFileSync(path.join(root, 'binary'), 'a'.repeat(65536 - 256) + ['32', '00'].join('') + 'a');
    assert.deepEqual(scanPackagedBundle(root).hits, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
