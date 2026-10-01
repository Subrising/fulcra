import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireProcessLock } from './process-lock.mjs';
test('only one child acquires a state root and cannot unlink a replacement lock', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lock-'));
  try {
    const release = acquireProcessLock(home);
    assert.equal(fs.statSync(path.join(home, 'process.lock')).mode & 0o777, 0o600);
    assert.throws(() => acquireProcessLock(home), /prior child/);
    fs.renameSync(path.join(home, 'process.lock'), path.join(home, 'old-lock'));
    const releaseReplacement = acquireProcessLock(home);
    release(); assert.ok(fs.existsSync(path.join(home, 'process.lock')));
    releaseReplacement(); assert.ok(!fs.existsSync(path.join(home, 'process.lock')));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('an owned child records the host epoch and rejects malformed ownership', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lock-'));
  try {
    const epoch = '10000000-0000-4000-8000-000000000001';
    const release = acquireProcessLock(home, { epoch });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'process.lock'), 'utf8')), { pid: process.pid, epoch });
    release();
    assert.throws(() => acquireProcessLock(home, { epoch: 'invalid' }));
    assert.equal(fs.existsSync(path.join(home, 'process.lock')), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
