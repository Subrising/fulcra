// The user guide is the one document a stranger reads before anything else, so a command that does not
// run or an RPC that does not exist costs more there than anywhere else: they cannot tell our mistake
// from their own, and they have no way to check. These assertions are the part of a document a machine
// can hold. Prose it cannot check is still prose, and still the author's problem.
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');
const guide = fs.readFileSync(path.join(repo, 'docs', 'orca-user-guide.md'), 'utf8');
const rpcCases = new Set([...fs.readFileSync(path.join(here, 'rpc.mjs'), 'utf8')
  .matchAll(/case '([a-z-]+)':/g)].map(m => m[1]));

test('every RPC the user guide names is one the server actually serves', () => {
  assert.ok(rpcCases.size > 20, `only ${rpcCases.size} RPC cases parsed -- the parse is wrong, not the guide`);
  // A candidate is a hyphenated token whose first segment is a namespace rpc.mjs uses, so ordinary
  // hyphenated English ("read-only", "fan-out") is not mistaken for a method name. Derived from the
  // server, so a new namespace is covered without editing this test.
  const namespaces = new Set([...rpcCases].map(c => c.split('-')[0]));
  const named = [...new Set([...guide.matchAll(/\b([a-z]+-[a-z-]+[a-z])\b/g)].map(m => m[1])
    .filter(t => namespaces.has(t.split('-')[0])))];
  assert.ok(named.length >= 3, `no RPC names found in the guide at all: ${named}`);
  assert.deepEqual(named.filter(n => !rpcCases.has(n)), [],
    'the guide names an RPC the server does not serve -- a reader cannot tell our error from their own');
  // Proof this can fail rather than passing vacuously.
  assert.equal(rpcCases.has('channels-renew'), false,
    'if a renew RPC ever exists, the guide is wrong to say an approval cannot be renewed');
});

test('every command the user guide tells a newcomer to run names a file that exists', () => {
  const paths = [...new Set([...guide.matchAll(/\b(src\/[a-z/.-]+\.mjs)\b/g)].map(m => m[1]))];
  assert.ok(paths.length >= 3, `no runnable commands found in the guide: ${paths}`);
  for (const p of paths) assert.ok(fs.existsSync(path.join(repo, p)),
    `the guide tells a newcomer to run ${p}, which does not exist`);
});

test('the guide states the provider and host limits the code actually enforces', () => {
  // These are the two fences a newcomer hits first and cannot discover from the UI. If either opens up,
  // this fails and the guide gets corrected instead of quietly becoming a lie.
  assert.match(fs.readFileSync(path.join(here, 'role-sessions.mjs'), 'utf8'), /\['claude', ?'codex'\]/,
    'the provider fence moved; the guide says claude and codex only');
  assert.match(guide, /`claude` and `codex` only/);
  assert.match(fs.readFileSync(path.join(here, 'manager.mjs'), 'utf8'), /configuredHost\(a.host\)/,
    'the host fence must use configured names');
  assert.match(guide, /named hosts/);
});
