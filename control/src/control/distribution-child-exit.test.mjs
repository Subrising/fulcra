import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// W1 postfix-1: a SIGTERM reached the controller's stop(), which closed the socket and journal and called
// process.exit(0), yet the process never exited while the host held its fd 3/4 pipes open. Here the real owned child
// runs with a stand-in for server.mjs's stop tail (SIGTERM -> "stop-ran", process.exit(0)); a malformed first frame makes
// it close its channel and signal itself, the path the controller takes when the host pipe fails.
async function ownedChild(preload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-exit-')), stopTail = path.join(dir, 'stop-tail.mjs');
  fs.writeFileSync(stopTail, `process.on('SIGTERM', () => { process.stderr.write('stop-ran\\n'); process.exit(0); });\n${preload}`);
  const child = spawn(process.execPath, [...process.execArgv.filter(a => !a.startsWith('--test')), '--import', stopTail, fileURLToPath(new URL('./distribution-child.mjs', import.meta.url))],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', d => { stderr += d; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const body = Buffer.from(JSON.stringify({ type: 'not-a-boot' })), header = Buffer.alloc(4); header.writeUInt32BE(body.length);
  child.stdio[3].write(Buffer.concat([header, body])); // The host keeps fd 3 and fd 4 open: nothing is ended.
  const result = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('still alive after 10 s'), 10000))]);
  if (result === 'still alive after 10 s') { child.kill('SIGKILL'); await exited; }
  fs.rmSync(dir, { recursive: true, force: true });
  return { result, stderr };
}
// The epoch close makes the DaemonClient reject its pending waiters; this stands in for one with no handler, created
// when the child closes its channel and before its own SIGTERM is delivered (as observed at daemon shutdown).
const rejectOnClose = code => `const kill = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (pid === process.pid && signal === 'SIGTERM') Promise.reject(Object.assign(new Error('Controller epoch closed'), { name: 'DaemonConnectionError', code: ${JSON.stringify(code)} }));
  return kill(pid, signal);
};`;

test('the owned child exits on SIGTERM while the host still holds both pipes open', async () => {
  const { result, stderr } = await ownedChild('');
  assert.match(stderr, /Controller owned channel failed/, 'the child read the frame and closed its channel');
  assert.deepEqual(result, { code: 0, signal: null });
});

test('a DaemonConnectionError left unhandled by the epoch close does not stop the graceful stop from running', async () => {
  const { result, stderr } = await ownedChild(rejectOnClose('DAEMON_CONNECTION_LOST'));
  assert.doesNotMatch(stderr, /Controller epoch closed/, 'no uncaught DaemonConnectionError');
  assert.match(stderr, /stop-ran/, 'stop() ran after the close');
  assert.deepEqual(result, { code: 0, signal: null });
});

test('any other unhandled rejection after the close still fails loudly', async () => {
  const { result, stderr } = await ownedChild(rejectOnClose('SOMETHING_ELSE'));
  assert.match(stderr, /Controller epoch closed/);
  assert.doesNotMatch(stderr, /stop-ran/);
  assert.notEqual(result.code, 0);
});
