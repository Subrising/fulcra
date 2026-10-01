// DESIGN-NEXT-BUILD B1: the optional memoryRoot setting. Absent, everything is exactly as before (<home>/memory);
// present, the canonical-memory server a session gets reads that folder directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstRun, loadConfig, validateConfig } from './config.mjs';

const temporary = run => { const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-memroot-'))); try { return run(base); } finally { fs.rmSync(base, { recursive: true, force: true }); } };
const plain = c => { const v = JSON.parse(JSON.stringify(c)); for (const k of ['home','controller','daemonHome','memoryRoot','tasks','url']) delete v[k]; if (v.outcomesRoot === path.join(c.home, 'memory')) delete v.outcomesRoot; return v; };
const write = (home, c) => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });

test('memoryRoot is optional; absent it is exactly <home>/memory, as before', () => temporary(base => {
  const home = path.join(base, 'cc'), env = { ORCA_HOME: home };
  const c = firstRun(env);
  assert.equal(c.memoryRoot, path.join(home, 'memory'));
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(home, 'config.json'))), 'memoryRoot'), false);
  assert.deepEqual(Object.keys(loadConfig(env)).sort(), Object.keys(c).sort());
}));

test('memoryRoot is validated like outcomesRoot: absolute, normalised, no trailing slash, bounded', () => temporary(base => {
  const c = plain(firstRun({ ORCA_HOME: path.join(base, 'cc') }));
  for (const good of ['/Users/someone/shared-vault/decisions', '/']) assert.equal(validateConfig({ ...c, memoryRoot: good }).memoryRoot, good);
  for (const bad of ['relative/decisions', '/a/../b', '/a/b/', '', 7, null, '/' + 'x'.repeat(1024)])
    assert.throws(() => validateConfig({ ...c, memoryRoot: bad }), /Invalid setting memoryRoot/);
}));

test('a configured memoryRoot is what loadConfig and the session memory server use', () => temporary(base => {
  const home = path.join(base, 'cc'), vault = path.join(base, 'vault', 'decisions');
  const c = plain(firstRun({ ORCA_HOME: home }));
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, 'decision.md'), '# SYNTHETIC fixture\nquartz launch is amber\n');
  write(home, { ...c, memoryRoot: vault });
  assert.equal(loadConfig({ ORCA_HOME: home }).memoryRoot, vault);
  assert.equal(loadConfig({ ORCA_HOME: home }).outcomesRoot, path.join(home, 'memory'), 'outcomesRoot default is unchanged');
  // The real entry a V4 session is given (canonical-memory-route.mjs), speaking MCP over stdio.
  const entry = fileURLToPath(new URL('./portable-memory/entry.mjs', import.meta.url));
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'shared_memory_search', arguments: { query: 'quartz launch' } } },
  ];
  const r = spawnSync(process.execPath, [entry], { input: frames.map(f => JSON.stringify(f)).join('\n') + '\n', env: { PATH: process.env.PATH, ORCA_HOME: home, ORCA_MEMORY_CLIENT: 'local' }, encoding: 'utf8', timeout: 20000 });
  const replies = r.stdout.trim().split('\n').map(l => JSON.parse(l));
  const result = JSON.parse(replies.find(x => x.id === 2).result.content[0].text);
  assert.equal(result.coverage.complete, true, JSON.stringify(result.coverage));
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].path, path.join(vault, 'decision.md'));
}));
