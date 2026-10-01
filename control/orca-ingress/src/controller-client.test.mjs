import { localMachine } from '../../src/local-machine.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { controllerSocket, DEFAULT_CONTROLLER_SOCKET } from './controller-client.mjs';

test('unset or empty ORCA_INGRESS_CONTROLLER_SOCKET keeps the legacy default', () => {
  assert.equal(controllerSocket({}), DEFAULT_CONTROLLER_SOCKET);
  assert.equal(controllerSocket({ ORCA_INGRESS_CONTROLLER_SOCKET: '' }), DEFAULT_CONTROLLER_SOCKET);
  assert.equal(DEFAULT_CONTROLLER_SOCKET, localMachine('legacyControllerSocket'));
});
test('an absolute canonical override is used as is', () => {
  const p = '/Volumes/test-volume/openclaw/projects/orca-paseo-20260911/home/command-centre/control.sock';
  assert.equal(controllerSocket({ ORCA_INGRESS_CONTROLLER_SOCKET: p }), p);
});
test('a relative or non-canonical override is refused', () => {
  for (const bad of ['control.sock', './x/control.sock', '/tmp/../tmp/control.sock', '/tmp/x/'])
    assert.throws(() => controllerSocket({ ORCA_INGRESS_CONTROLLER_SOCKET: bad }), /absolute canonical/);
});
test('request() connects to the overridden socket (resolved at import, as the constant was)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingress-sock-')), sock = path.join(dir, 's.sock');
  const server = net.createServer(c => c.on('data', d => { c.end(JSON.stringify({ result: { echoed: JSON.parse(String(d)).method } }) + '\n'); }));
  await new Promise(r => server.listen(sock, r));
  try {
    // async spawn: this process's server must keep answering while the child runs
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import { request } from ${JSON.stringify(new URL('./controller-client.mjs', import.meta.url).href)}; console.log(JSON.stringify(await request({ method: 'list' })));`],
      { env: { ...process.env, ORCA_INGRESS_CONTROLLER_SOCKET: sock } });
    let stdout = '', stderr = ''; child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    const status = await new Promise(r => child.on('close', r));
    assert.equal(status, 0, stderr); assert.deepEqual(JSON.parse(stdout), { echoed: 'list' });
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
