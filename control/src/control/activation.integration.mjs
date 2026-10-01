import { localMachine } from '../local-machine.mjs';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { verifyActivationAt } from './activation.mjs';
import { DaemonClient } from './client-sdk.mjs';
const stage = process.env.ORCA_ACTIVATION_STAGE;
assert(stage?.startsWith(localMachine('openclawTmp') + '/'));
const manifest = JSON.parse(fs.readFileSync(stage + '/native-turn-stage.json', 'utf8'));
const home = manifest.controllerHome, activeFile = home + '/admission/active.json';
assert(stage.startsWith(home + '/admission/'));
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const journalBefore = sha(manifest.journalFile), report = { boots: [], rejected: [], providerTurns: 0 };
const base = stage + '/packages/server/dist/server/server/';
const after = Object.fromEntries(Object.values(manifest.hooks).map(item => [path.relative(base, item.path), item.after]));
for (const [name, hash] of Object.entries(manifest.controller)) after[path.relative(base, stage + '/control/' + name)] = hash;
// Legacy staging keeps portable-config.mjs beside the guard directory so the staged
// authority.mjs resolves ../portable-config.mjs; activation must cover that byte too.
assert.equal(manifest.layout, 'legacy');
assert.equal(manifest.portableConfig.path, stage + '/portable-config.mjs');
const active = { base, after, files: { [manifest.portableConfig.path]: manifest.portableConfig.sha256 }, guard: { path: stage + '/control/admission-guard.mjs', sha256: manifest.controller['admission-guard.mjs'] } };
fs.writeFileSync(activeFile, JSON.stringify(active), { mode: 0o600, flag: 'wx' });
const closed = port => new Promise(resolve => {
  const s = net.connect({ host: '127.0.0.1', port });
  s.once('error', error => resolve(error.code === 'ECONNREFUSED'));
  s.once('connect', () => { s.destroy(); resolve(false); });
});
for (let attempt = 0; attempt < 2; attempt++) {
  const child = fork(fileURLToPath(new URL('./activation-daemon.fixture.mjs', import.meta.url)), [stage], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; }); child.stdout.resume();
  const exit = once(child, 'exit'); let connection, port;
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Private daemon readiness timed out')), 45000);
      child.once('message', value => { clearTimeout(timer); resolve(value); });
      child.once('exit', code => { clearTimeout(timer); reject(Error('Private daemon exited before readiness: ' + code)); });
      child.once('error', reject);
    });
    assert.equal(ready.ready, true); assert.equal(ready.enabledProviders, 0);
    assert.equal(ready.target.type, 'tcp'); port = ready.target.port;
    const boot = verifyActivationAt(home, port);
    connection = new DaemonClient({ clientId: 'private-native-activation-' + attempt, clientType: 'cli', url: `ws://127.0.0.1:${port}/ws`, password: ready.password, connectTimeoutMs: 10000 });
    await connection.connect(); assert(connection.isConnected);
    assert.equal(connection.getLastServerInfoMessage()?.features?.agentQuotaRead, true);
    const loadedFile = home + '/admission/loaded-' + child.pid + '.json';
    const loadedBytes = fs.readFileSync(loadedFile), loaded = JSON.parse(loadedBytes);
    assert.equal(loaded.boot, boot); assert.equal(loaded.pid, child.pid);
    const target = stage + '/control/quota-wait.mjs', original = fs.readFileSync(target);
    try { fs.appendFileSync(target, '\n// changed after load\n'); assert.throws(() => verifyActivationAt(home, port), /missing or changed/); report.rejected.push('runtime-dependency-drift'); }
    finally { fs.writeFileSync(target, original); }
    try { fs.writeFileSync(loadedFile, JSON.stringify({ ...loaded, processStart: 'stale process identity' })); assert.throws(() => verifyActivationAt(home, port), /not loaded/); report.rejected.push('stale-loaded-receipt'); }
    finally { fs.writeFileSync(loadedFile, loadedBytes); }
    try { fs.writeFileSync(activeFile, JSON.stringify({ ...active, guard: { ...active.guard, sha256: '0'.repeat(64) } })); assert.throws(() => verifyActivationAt(home, port), /does not match/); report.rejected.push('foreign-guard'); }
    finally { fs.writeFileSync(activeFile, JSON.stringify(active)); }
    assert.equal(verifyActivationAt(home, port), boot);
    report.boots.push({ boot, pid: child.pid, port, modules: Object.keys(after).length, authenticated: true });
  } finally {
    await connection?.close();
    // A killed daemon must not make its old load receipt valid on the next boot.
    if (attempt === 0) child.kill('SIGKILL');
    else if (child.connected) child.send('stop');
    const timer = setTimeout(() => child.kill('SIGTERM'), 7000); timer.unref();
    const [code, signal] = await exit; clearTimeout(timer);
    if (attempt === 0) assert.equal(signal, 'SIGKILL'); else assert.equal(code, 0, stderr);
    if (port) { assert(await closed(port)); assert.throws(() => verifyActivationAt(home, port)); report.rejected.push('stopped-host'); }
  }
}
assert.notEqual(report.boots[0].boot, report.boots[1].boot);
assert.notEqual(report.boots[0].pid, report.boots[1].pid);
assert.equal(sha(manifest.journalFile), journalBefore);
report.journalUnchanged = true; report.listenersClosed = true;
report.scope = 'Actual private native process startup/restart, authenticated SDK handshake and activation checks; providers disabled, no installed-service or worker acceptance.';
console.log(JSON.stringify(report));
