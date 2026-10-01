// H7 item 5: ./SESSION-ID is written into every controller-created session's job directory at creation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeSessionId } from './native.mjs';

const dir = t => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-session-id-'))); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const ID = '00000000-0000-471c-aaee-000000002017';

test('the session id is written, private, one line, and replaces a stale file the seat left', t => {
  const d = dir(t);
  assert.equal(writeSessionId(d, ID), true);
  assert.equal(fs.readFileSync(path.join(d, 'SESSION-ID'), 'utf8'), ID + '\n');
  assert.equal(fs.statSync(path.join(d, 'SESSION-ID')).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(d, 'SESSION-ID'), 'stale-and-much-longer-than-an-id-' + 'x'.repeat(80), { mode: 0o644 });
  assert.equal(writeSessionId(d, ID), true);
  assert.equal(fs.readFileSync(path.join(d, 'SESSION-ID'), 'utf8'), ID + '\n', 'truncated, not appended');
  assert.equal(fs.statSync(path.join(d, 'SESSION-ID')).mode & 0o777, 0o600);
});
test('a planted symlink, FIFO or HARD LINK is replaced, never written through; a directory in its place fails soft', t => {
  const d = dir(t), target = path.join(d, 'elsewhere.txt');
  fs.writeFileSync(target, 'do not touch', { mode: 0o644 });
  fs.symlinkSync(target, path.join(d, 'SESSION-ID'));
  assert.equal(writeSessionId(d, ID), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'do not touch', 'the symlink target is untouched');
  assert.equal(fs.lstatSync(path.join(d, 'SESSION-ID')).isFile(), true, 'the link itself was replaced');
  // Review H7 B3: a hard link to a controller-private file (operator.secret, a grant, the journal) is not truncated,
  // overwritten or chmodded.
  const h = dir(t), secret = path.join(h, 'operator.secret');
  fs.writeFileSync(secret, 'secret-bytes', { mode: 0o600 }); fs.linkSync(secret, path.join(h, 'SESSION-ID'));
  assert.equal(writeSessionId(h, ID), true);
  assert.equal(fs.readFileSync(secret, 'utf8'), 'secret-bytes'); assert.equal(fs.statSync(secret).nlink, 1, 'the link was replaced, not written');
  assert.equal(fs.readFileSync(path.join(h, 'SESSION-ID'), 'utf8'), ID + '\n');
  const f = dir(t); execFileSync('/usr/bin/mkfifo', [path.join(f, 'SESSION-ID')]);
  const t0 = Date.now(); assert.equal(writeSessionId(f, ID), true); assert.ok(Date.now() - t0 < 1000, 'a FIFO is never opened, so nothing blocks');
  assert.equal(writeSessionId(path.join(d, 'missing'), ID), false);
  const g = dir(t); fs.mkdirSync(path.join(g, 'SESSION-ID'));
  assert.equal(writeSessionId(g, ID), false, 'a directory in its place is refused');
  assert.deepEqual(fs.readdirSync(g), ['SESSION-ID'], 'no temporary file is left behind');
});
test('native.create writes it after the agent exists and reports it in the creation result (static)', () => {
  const src = fs.readFileSync(new URL('./native.mjs', import.meta.url), 'utf8');
  const create = src.slice(src.indexOf('    async create(a, { fresh = false } = {}) {'), src.indexOf('    async inspect(id) {'));
  assert.ok(create.indexOf('writeSessionId(cwd, agent.id)') > create.indexOf('await client.agents.create('), 'written with the created id');
  assert.match(create, /return \{ id: agent\.id, cwd, sessionIdFile,/);
});
