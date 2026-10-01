import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalMemoryConfig } from './canonical-memory-route.mjs';
import { portable } from './portable-config.mjs';

// The portable route replaced the pinned external native memory core (and its digest verifier): sessions now
// launch only this package's own memory entry, against this installation's store. What that route must keep:
// no external executable or path, and nothing in the child environment beyond the state root and the client.
test('the memory route launches only the packaged entry, scoped to this installation', () => {
  const entry = fileURLToPath(new URL('./portable-memory/entry.mjs', import.meta.url));
  assert.ok(fs.statSync(entry).isFile());
  for (const provider of ['claude', 'codex']) {
    assert.deepEqual(canonicalMemoryConfig(provider), {
      type: 'stdio', command: process.execPath, args: [entry],
      env: { ORCA_HOME: portable.home, ORCA_MEMORY_CLIENT: provider },
    });
  }
});

test('unknown memory providers are refused before any route is built', () => {
  for (const provider of [undefined, null, '', 'Claude', 'codex/other', 'local', '__proto__']) {
    assert.throws(() => canonicalMemoryConfig(provider), /Known memory provider required/);
  }
});
