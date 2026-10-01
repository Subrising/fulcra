import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalMemoryConfig } from './canonical-memory-route.mjs';
import { portable } from './portable-config.mjs';

// The portable route serves the installation's own store (ORCA_HOME/memory; tools/host-test-config.mjs makes a
// throwaway ORCA_HOME per test process). Seed one current note and one archived note so every assertion below
// has a source. The legacy Mini native routes (consumer markers, saved-entry receipts, SHM_ALLOW_PRIVATE) and the
// saved trial-worker route (sessionConfig, which refuses under a portable installation) were removed with the
// portable configuration; V4 deletes them, so they are not exercised here.
const store = portable.memoryRoot;
fs.mkdirSync(join(store, 'history'), { recursive: true, mode: 0o700 });
fs.writeFileSync(join(store, 'operating-state.md'), '# Orca operating state\n\nThe current operating state of the example programme.\n', { mode: 0o600 });
fs.writeFileSync(join(store, 'history', 'operating-state-earlier.md'), '# Orca operating state (earlier)\n\nAn earlier record of the example programme.\n', { mode: 0o600 });

for (const route of ['claude', 'codex']) {
  test(`${route}: real scoped protocol, exact reads, privacy and bounded framing`, { timeout: 30000 }, async () => {
    const c = canonicalMemoryConfig(route);
    const env = { ...process.env, ...c.env };
    const child = spawn(c.command, c.args, { env });
    const closed = once(child, 'close');
    let sequence = 0, stderr = ''; const pending = new Map(), unsolicited = [];
    child.stderr.on('data', d => { stderr += d; });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => {
      const reply = JSON.parse(line); const waiter = pending.get(reply.id);
      if (waiter) { clearTimeout(waiter.timer); pending.delete(reply.id); waiter.resolve(reply); } else unsolicited.push(reply);
    });
    const request = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`No reply for ${method}: ${stderr}`)); }, 10000);
      pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const call = async (name, args, error = null) => {
      const reply = await request('tools/call', { name, arguments: args });
      assert.equal(reply.result.isError, error !== null);
      const value = JSON.parse(reply.result.content[0].text);
      if (error) assert.equal(value.error, error);
      return value;
    };
    // Discovered from the server, never named: a literal path would embed a personal vault location in an
    // open repository and would fail for anyone whose store differs.
    let sourcePath = null, before = null;
    const hash = () => createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
    try {
      assert.deepEqual((await request('initialize')).result.serverInfo, { name: 'orca-canonical-memory', version: '1.1.0' });
      const tools = (await request('tools/list')).result.tools;
      assert.deepEqual(tools.map(t => t.name).sort(), ['shared_memory_read', 'shared_memory_search']);
      assert.deepEqual(tools.find(t => t.name === 'shared_memory_search').inputSchema.properties.scope.enum, ['current', 'history', 'all']);
      const query = { query: 'Orca operating state', maxResults: 8 };
      const current = await call('shared_memory_search', query);
      assert.equal(current.scope, 'current'); assert.ok(current.matches.length);
      assert.ok(current.matches.every(m => m.corpus === 'current'));
      const history = await call('shared_memory_search', { ...query, scope: 'history' });
      assert.ok(history.matches.length); assert.ok(history.matches.every(m => m.corpus === 'history'));
      const all = await call('shared_memory_search', { ...query, scope: 'all' });
      assert.deepEqual([...new Set(all.matches.map(m => m.corpus))].sort(), ['current', 'history']);
      const hit = history.matches[0];
      const historical = await call('shared_memory_read', { path: hit.path, lines: 5, expectedSha256: hit.file.sha256 });
      assert.equal(historical.file.sha256, hit.file.sha256); assert.equal(historical.corpus, 'history');
      const found = (await call('shared_memory_search', { query: 'the' })).matches?.[0];
      // An empty store is a legitimate state; the read assertions need a source and are skipped without one.
      sourcePath = found ? (found.path ?? found.locator.slice(0, found.locator.lastIndexOf('#'))) : null;
      if (sourcePath) {
        before = hash();
        const currentRead = await call('shared_memory_read', { path: sourcePath, lines: 1, expectedSha256: before });
        assert.equal(currentRead.file.sha256, before); assert.equal(currentRead.disclosure, 'shared');
        await call('shared_memory_read', { path: sourcePath, expectedSha256: '0'.repeat(64) }, 'CHANGED');
      }
      // Outside-root denial, expressed structurally rather than by naming one person's files: a real
      // sensitive location, a system file, and an escape from the configured root.
      for (const path of [join(homedir(), '.ssh', 'config'), '/etc/hosts', join(homedir(), 'nonexistent-outside-root.md')])
        await call('shared_memory_read', { path }, 'DENIED');
      child.stdin.write('x'.repeat(17000) + '\n');
      assert.deepEqual((await request('ping')).result, {});
      assert.ok(unsolicited.some(r => r.id === null && r.error?.message === 'Request byte limit exceeded'));
      // The read must not have altered the source. Only meaningful when a source was discovered.
      if (sourcePath) assert.equal(hash(), before);
      child.stdin.end(); assert.deepEqual(await closed, [0, null]);
    } finally {
      for (const waiter of pending.values()) clearTimeout(waiter.timer);
      lines.close(); if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
}
