import { withManagementInvocation } from './server/management-context.mjs';
// Execute the actual plugin entry point with import-boundary fixtures. No plugin install,
// live daemon, connectors or UI mock; only unrelated dependencies are stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { WorktreeLifecycle } from '../src/control/worktree-lifecycle.mjs';

test('index.server.ts forwards preview operationId and polling terminates', async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wl-plugin-')));
  t.after(() => fs.rm(home, { recursive: true, force: true })); await fs.mkdir(path.join(home, 'tasks'));
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const service = new WorktreeLifecycle({ home, db, session: async () => null });
  let scans = 0; const dryRun = service.dryRun.bind(service); service.dryRun = () => { scans++; return dryRun(); };
  const key = '__wlPluginFixture';
  globalThis[key] = { withManagementInvocation, call: (method, input) => { assert.equal(method, 'worktree-lifecycle-preview'); return service.previewRequest(input); } };
  t.after(() => { delete globalThis[key]; });
  const entry = new URL('./index.server.ts', import.meta.url).href;
  const source = stripTypeScriptTypes(await fs.readFile(new URL(entry), 'utf8'));
  const modules = new Map();
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
    const exports = match[1].split(',').map(x => x.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    modules.set(match[2], (modules.get(match[2]) ?? `const noop = new Proxy(function(){return noop}, {get:()=>noop});\n`) + exports.map(name => {
      const value = name === 'withManagementInvocation' ? `globalThis.${key}.withManagementInvocation` : name === 'localCall' ? `globalThis.${key}.call` : name.endsWith('Rpc') ? `{name:${JSON.stringify(name)}}` : name === 'NotConfigured' ? 'class extends Error {}' : name === 'READ_DEADLINE_MS' ? '1000' : 'noop';
      return `export const ${name} = ${value};`;
    }).join('\n'));
  }
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === entry && modules.has(specifier)) return { url: `data:text/javascript,${encodeURIComponent(modules.get(specifier))}`, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) { if (url === entry) return { format: 'module', source, shortCircuit: true }; return next(url, context); },
  });
  t.after(() => hooks.deregister());
  const { default: contribute } = await import(entry);
  const handlers = new Map(); const dispose = contribute({ handle: (contract, handler) => handlers.set(contract.name, handler) }); t.after(dispose);
  const preview = handlers.get('cleanupPreviewRpc'); assert.equal(typeof preview, 'function');
  let result = await preview({}, {management:{invoke:async()=>{}}}); assert.equal(result.pending, true); const operationId = result.operationId;
  await service.stop();
  result = await preview({ operationId }, {management:{invoke:async()=>{}}});
  assert.equal(result.pending, false); assert.equal(result.operationId, operationId); assert.equal(scans, 1);
  assert.equal(result.value.retentionDays, 'never'); assert.deepEqual(result.value.jobs, []);
  // Drain even a regressed handler's unwanted second scan before removing the fixture.
  await service.stop();
});
