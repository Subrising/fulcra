import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { controllerEntry } from './distribution-files.mjs';
test('controller executable must be a regular owned distribution file, not a link or shared-writable file', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-entry-'))), entry = path.join(root, 'controller.mjs');
  try {
    fs.writeFileSync(entry, '// fixture', { mode: 0o600 });
    assert.equal(controllerEntry(root), entry);
    fs.chmodSync(entry, 0o666); assert.throws(() => controllerEntry(root), /Unsafe/);
    fs.rmSync(entry); fs.writeFileSync(path.join(root, 'other'), '// fixture'); fs.symlinkSync('other', entry);
    assert.throws(() => controllerEntry(root), /Unsafe/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
