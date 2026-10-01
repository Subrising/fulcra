import test from 'node:test';
import assert from 'node:assert/strict';
import { heldSubject } from './held-subject.mjs';
import { noPersonal } from '../../orca-organization/shared/cc/refs.mjs';
test('held subjects use only the first line, scrub before clipping and stay bounded', () => {
  const fallback = 'Message waiting from a project lead';
  assert.equal(heldSubject('Release ready\nInternal detail', fallback), 'Release ready');
  assert.equal(heldSubject('\nSecond line', fallback), fallback);
  for (const secret of ['/Users/fixture/file', '/Volumes/fixture/file', 'test@example.com', 'fixture.local', 'ghp_abcdefghijk', '~/private']) {
    const result = heldSubject(`Review ${secret} today\nNext`, fallback);
    assert.equal(result, 'Review [removed] today'); assert.ok(noPersonal(result));
  }
  const long = heldSubject('a'.repeat(79) + ' ghp_abcdefghijk', fallback);
  assert.ok(long.length <= 80); assert.ok(noPersonal(long));
  assert.equal(heldSubject(null, fallback), fallback);
});
