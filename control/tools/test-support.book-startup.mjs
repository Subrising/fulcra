// Test support only (cutover A1). Runs the REAL startController over a fake owned channel: connectNative is replaced by
// a local fake, and the Book transport by one that applies the real private-profile checks and records calls instead of
// running ssh. Everything else (HostNative wiring, the journal, the operator socket, events-status) is the shipped code.
// One startController per process: the owned process lock is held until exit.
import { mock } from 'node:test';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const control = new URL('../src/control/', import.meta.url);
export async function startWithBookFixture() {
  const realNative = await import(new URL('native.mjs?real', control).href);
  const realTransport = await import(new URL('../book/transport.mjs?real', control).href);
  const calls = [], profiles = [], agents = new Map(); // the receiver is idempotent per session, as the real one is
  const local = {
    currentBoot: () => 'fixture-boot', subscribe: () => () => {}, watch: async () => {}, close: async () => {}, reconcile: async () => {},
    create: async a => { calls.push({ local: 'create', host: a.host ?? null }); return { id: randomUUID(), cwd: '/tmp/local' }; },
  };
  mock.module(new URL('native.mjs', control).href, { namedExports: { ...realNative, connectNative: async () => local } });
  mock.module(new URL('../book/transport.mjs', control).href, { namedExports: { ...realTransport, configuredBook: file => {
    realTransport.privateProfile(file); profiles.push(file);
    return async (action, input) => {
      calls.push({ book: action, input });
      if (action !== 'create') throw Error('fixture: unexpected ' + action);
      if (!agents.has(input.sessionId)) agents.set(input.sessionId, randomUUID());
      return { id: input.sessionId, host: 'macbook', agentId: agents.get(input.sessionId), cwd: '/Users/fixture/tasks/' + input.messageId };
    };
  } } });
  const { startController } = await import(new URL('server.mjs', control).href);
  const { socketLocation } = await import(new URL('socket-location.mjs', control).href);
  const HOME = realNative.HOME;
  const exit = mock.method(process, 'exit', () => {}), before = new Set(process.listeners('exit'));
  let management; // the owned-channel management dispatcher the controller registers with its host
  const started = await startController({ daemon: {}, issueProvenance: async () => 'token', registerManagement: handler => { management = handler; return () => {}; },
    epoch: randomUUID(), getHandshakeBoot: () => 'fixture-boot' });
  // The controller releases its process lock on exit; run that at stop, before the harness removes the fixture home.
  const release = () => { for (const l of process.listeners('exit').filter(l => !before.has(l))) { process.removeListener('exit', l); l(); } };
  // A read over the owned child's operator socket, exactly as a same-user operator client sends it.
  const operatorRead = method => new Promise((resolve, reject) => {
    const credential = fs.readFileSync(path.join(HOME, ['operator', 'secret'].join('.')), 'utf8').trim();
    const c = net.createConnection(socketLocation(HOME).socket); let out = '';
    c.setEncoding('utf8'); c.on('data', d => { out += d; }); c.on('error', reject);
    c.on('end', () => { try { const r = JSON.parse(out); if (r.error) reject(Error(r.error)); else resolve(r.result); } catch (e) { reject(e); } });
    c.end(JSON.stringify({ method, operator: credential }) + '\n');
  });
  return { ...started, HOME, calls, profiles, operatorRead, management: (command, principal) => management(command, principal), stop: async () => { await started.stop(); release(); exit.mock.restore(); } };
}
