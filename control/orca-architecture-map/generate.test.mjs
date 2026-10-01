import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pairFromSnapshots, planParts } from './generate.mjs';
import { checkContract, checkEvidence } from './validate.mjs';

// The same cases as the product's packages/server/src/utils/architecture-map/generate.test.ts (the TypeScript
// twin), so the two keep one set of rules.
function snapshot(commit, files) {
  const entries = Object.entries(files);
  return {
    commit: commit.repeat(40).slice(0, 40),
    files: entries.map(([path, text]) => ({ path, blob: `${path}:${text.length}:${text}` })),
    texts: new Map(entries),
  };
}

const base = {
  'package.json': '{"name":"shop","workspaces":["packages/*"]}',
  'README.md': 'docs',
  'packages/protocol/package.json': '{"name":"@shop/protocol"}',
  'packages/protocol/src/index.ts': 'export const v = 1;',
  'packages/protocol/src/messages.ts': 'export type M = 1;',
  'packages/protocol/src/schema.ts': 'export const s = 1;',
  'packages/client/package.json': '{"name":"@shop/client"}',
  'packages/client/src/index.ts': 'import { v } from "@shop/protocol";\nexport const c = v;',
  'packages/client/src/socket.ts': 'import { c } from "./index.js";\nexport const s = c;',
  'packages/client/src/retry.ts': 'export const r = 1;',
  'packages/client/src/socket.test.ts': 'import { s } from "./socket.js";\ns;',
  'packages/app/package.json': '{"name":"@shop/app"}',
  'packages/app/src/main.ts': 'import { c } from "@shop/client";\nexport const m = c;',
  'packages/app/src/screen.ts': 'import { m } from "./main";\nexport const x = m;',
  'packages/app/src/list.ts': 'export const l = 1;',
};

test('draws packages as parts, other files last, and says how it was made', () => {
  const pair = pairFromSnapshots(snapshot('a', base), snapshot('a', base));
  const ir = pair.after.ir;
  assert.deepEqual(ir.components.map(c => c.id), ['packages.app', 'packages.client', 'packages.protocol', 'other-files']);
  assert.deepEqual(ir.connections, []);
  assert.deepEqual(checkContract(ir), []);
  assert.deepEqual(checkEvidence(ir, () => null), { errors: [], warnings: [] });
});

test('draws a connection the change adds and keeps positions stable across both ends', () => {
  const head = { ...base, 'packages/app/src/list.ts': 'import { r } from "@shop/client/retry";\nexport const l = r;' };
  const pair = pairFromSnapshots(snapshot('a', base), snapshot('b', head));
  assert.deepEqual(pair.changed, ['packages/app/src/list.ts']);
  assert.deepEqual(pair.before.ir.connections.map(c => c.id), []);
  assert.deepEqual(pair.after.ir.connections.map(c => c.id), ['packages.app--packages.client']);
  const at = side => Object.fromEntries(side.ir.components.map(c => [c.id, c.pos]));
  assert.deepEqual(at(pair.before), at(pair.after));
});

test('splits the folders a change edits first', () => {
  const code = Array.from({ length: 12 }, (_, i) => [`src/a/f${i}.ts`, `src/b/g${i}.ts`]).flat();
  assert.deepEqual(planParts(code, [''], 3, ['src/b/g1.ts']), ['src/a', 'src/b']);
  assert.deepEqual(planParts(code, [''], 2, ['src/b/g1.ts']), ['', 'src/b']);
});

test('a generated map must say so and cite its own commit', () => {
  const ir = pairFromSnapshots(snapshot('a', base), snapshot('a', base)).after.ir;
  const wrongCommit = { ...ir, cards: [{ title: 'Source', items: [`commit ${'b'.repeat(40)}`] }] };
  assert.match(checkEvidence(wrongCommit, () => null).errors.join('\n'), /cites its commit/);
  const unqualified = { ...ir, meta: { ...ir.meta, subtitle: 'Parts are folders' } };
  const errors = checkEvidence(unqualified, () => null).errors.join('\n');
  assert.match(errors, /automatically generated/);
  assert.match(errors, /not deployed/);
});
