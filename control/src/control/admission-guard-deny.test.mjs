import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
// Importing the guard from a worktree writes nothing: its load receipt is only for the deployed copy.
import { CONTROLLER_PRIVATE_PATHS, controllerDenyRules, denyClaudeQueryOptions } from './admission-guard.mjs';

const HOME = '/path/to/unconfigured/controller';
// A rule's path, as Claude Code reads it: `//abs/path` is the absolute path `/abs/path`.
const rulePaths = tool => controllerDenyRules().filter(r => r.startsWith(tool + '(//')).map(r => r.slice(tool.length + 2, -1));
const denied = (file, tool = 'Read') => rulePaths(tool).some(pattern => path.matchesGlob(file, pattern));

test('P1-1: the controller secret, the journal with its -wal and -shm, grants and pairing state are denied to every file tool', () => {
  for (const tool of ['Read', 'Edit', 'Write']) {
    for (const file of ['operator.secret', 'journal.sqlite', 'journal.sqlite-wal', 'journal.sqlite-shm', 'grants/role/abc.json', 'grants/inbox/x/y.json', 'grants/manager-1.json', 'device-pairing.mode', 'pairing-window.json', 'pairing/window.json', 'devices/phone.json'])
      assert(denied(`${HOME}/${file}`, tool), `${tool} ${file}`);
  }
});

test('P1-2: work outside the controller\'s private files stays allowed, including task worktrees that mention pairing', () => {
  for (const file of [`${HOME}/tasks/job/product/src/device-pairing.ts`, `${HOME}/tasks/job/grants/notes.md`, `${HOME}/tasks/job/notes-about-the-journal.md`, `${HOME}/admission/active.json`, '/tmp/operator.txt'])
    assert(!denied(file), file);
  // The shell rules name the files directly; they are best effort, not a boundary.
  assert(controllerDenyRules().includes('Bash(*operator.secret*)'));
  assert(controllerDenyRules().includes('Bash(*journal.sqlite*)'));
});

test('P1-3: the SDK options keep existing rules and settings, the input is not mutated, and applying twice adds nothing', () => {
  const options = { cwd: '/x', permissionMode: 'bypassPermissions', disallowedTools: ['WebFetch'], settings: { permissions: { deny: ['Bash(rm:*)'], allow: ['Read'] }, sandbox: { enabled: true } } };
  const once = denyClaudeQueryOptions(options), twice = denyClaudeQueryOptions(once);
  assert.deepEqual(twice, once);
  assert.equal(options.settings.permissions.deny.length, 1, 'the input is not mutated');
  assert.equal(options.disallowedTools.length, 1, 'the input is not mutated');
  const { settings, disallowedTools } = once;
  assert.equal(once.permissionMode, 'bypassPermissions'); assert.equal(once.cwd, '/x');
  assert.equal(settings.permissions.deny[0], 'Bash(rm:*)'); assert.deepEqual(settings.permissions.allow, ['Read']); assert.deepEqual(settings.sandbox, { enabled: true });
  assert.equal(disallowedTools[0], 'WebFetch');
  for (const rule of controllerDenyRules()) { assert(settings.permissions.deny.includes(rule)); assert(disallowedTools.includes(rule)); }
  assert.deepEqual(denyClaudeQueryOptions(undefined).settings.permissions.deny, controllerDenyRules());
  // A settings file path stays as given; the flag-level disallowedTools still carries every rule.
  const file = denyClaudeQueryOptions({ settings: '/private/settings.json' });
  assert.equal(file.settings, '/private/settings.json'); assert.deepEqual(file.disallowedTools, controllerDenyRules());
  assert.equal(CONTROLLER_PRIVATE_PATHS.length, 6);
});
