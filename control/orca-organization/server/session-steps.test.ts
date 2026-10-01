import test from 'node:test';
import assert from 'node:assert/strict';
// Private test configuration first: some plugin modules read it when they load.
import './portable.fixture';
import { createSessionSteps, placePath, scrubDiff, commandSummary, testCounts, OUTSIDE_PROJECT, SESSION_STEPS_BUDGET_MS } from './session-steps';
import { NEWER_HOST_NEEDED, sessionFileHistoryRpc, sessionStepRpc, sessionTurnsRpc } from '../shared/session-steps';
import { parseRef, personalMatch } from '../shared/cc/refs';
// C1 integration: J0's v1.9 refs API (parseRef, personalMatch).
const isRef = (value: unknown, kind: string) => parseRef(value)?.kind === kind;
const personalMatches = (text: string) => { const found = personalMatch(text); return found ? [found] : []; };
import {
  CLAUDE_ENTRIES, CLAUDE_SESSION, CODEX_ENTRIES, CODEX_SESSION, FIXTURE_DIRECTORY, FIXTURE_ENROLLMENT, FIXTURE_PROJECT, fakeHost,
} from '../screens/session-fixtures';

function setup(options: { supported?: boolean; retained?: boolean; oldClient?: boolean; enrollment?: any[] } = {}) {
  const hosts: Record<string, ReturnType<typeof fakeHost>> = {
    [CLAUDE_SESSION]: fakeHost({ entries: CLAUDE_ENTRIES, supported: options.supported, retained: options.retained }),
    [CODEX_SESSION]: fakeHost({ entries: CODEX_ENTRIES, supported: options.supported, retained: options.retained }),
  };
  const paseo = { agents: { ref: (id: string) => {
    const host = hosts[id];
    // A client from before the turn index has only refetch on the timeline handle.
    return { timeline: options.oldClient ? { refetch: host.refetch } : host };
  } } };
  const steps = createSessionSteps({
    call: async () => { throw new Error('controller is not called directly'); },
    enrollment: async () => options.enrollment ?? FIXTURE_ENROLLMENT,
    projects: async () => FIXTURE_DIRECTORY,
    bounded: work => work,
  });
  return { steps, paseo, hosts };
}
const noAbsolutePaths = (value: unknown) => {
  const text = JSON.stringify(value);
  assert(!text.includes('/work/tally'), 'the project folder never leaves the server');
  assert(!text.includes('/tmp/') && !text.includes('/shared/notes'), 'outside paths are never sent');
  assert.deepEqual(personalMatches(text), []);
};

test('S1: Claude steps read in plain words, with the reason just before each step', async () => {
  const { steps, paseo } = setup();
  const result = sessionStepRpc.output.parse(await steps.step({ sessionId: CLAUDE_SESSION, turnId: 'claude-turn-1' }, paseo));
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.equal(result.provider, 'claude');
  assert.equal(result.asked, 'Add a total row to the monthly report');
  assert.deepEqual(result.steps.map(s => s.summary), ['Read 1 file', 'Edited 1 file', 'Ran tests: 12 passed']);
  assert.equal(result.summary, 'Changed 1 file, ran tests: 12 passed');
  assert.match(result.steps[0].why!, /read it before changing/);
  assert.equal(result.steps[1].why, 'I will add a total row after the monthly rows.');
  const edit = result.steps[1];
  assert.deepEqual(edit.files.map(f => [f.path, f.change]), [['src/report.ts', 'edited']]);
  assert.match(edit.files[0].diff!, /^--- src\/report\.ts\n\+\+\+ src\/report\.ts/);
  assert.equal(result.steps[2].command, 'npm test');
  assert.equal(result.steps[2].exitCode, 0);
  // Refs (CONTRACTS §2.1).
  assert.equal(result.ref, `turn:${CLAUDE_SESSION}/claude-turn-1`);
  assert.equal(edit.files[0].ref, `file:local:${FIXTURE_PROJECT}/tally:src/report.ts`);
  assert(isRef(edit.files[0].ref!, 'file') && isRef(edit.ref!, 'turn'));
  noAbsolutePaths(result);
});

test('S2: a multi-file Codex patch lists every file, and the outside one only as outside', async () => {
  const { steps, paseo } = setup();
  const result = sessionStepRpc.output.parse(await steps.step({ sessionId: CODEX_SESSION, turnId: 'codex-turn-1' }, paseo));
  if (result.status !== 'ok') return assert.fail(result.message);
  const patch = result.steps.find(s => s.files.length === 3)!;
  assert.equal(patch.summary, 'Changed 2 files and 1 file outside the project');
  assert.deepEqual(patch.files.map(f => [f.path, f.change]), [['src/parse.ts', 'edited'], ['src/parse-amount.ts', 'created'], [null, 'deleted']]);
  assert.equal(patch.files[2].diff, null);
  assert.equal(patch.files[2].ref, null);
  const tests = result.steps.at(-1)!;
  assert.equal(tests.summary, 'Ran tests: 1 failed, 11 passed');
  assert.equal(tests.outcome, 'failed');
  assert.equal(result.steps[0].summary, 'Ran a command');
  noAbsolutePaths(result);
});

test('S3: Claude and Codex sessions step the same way', async () => {
  const { steps, paseo } = setup();
  const claude = await steps.step({ sessionId: CLAUDE_SESSION, turnId: 'claude-turn-1' }, paseo);
  const codex = await steps.step({ sessionId: CODEX_SESSION, turnId: 'codex-turn-2' }, paseo);
  if (claude.status !== 'ok' || codex.status !== 'ok') return assert.fail('both readable');
  assert.deepEqual(Object.keys(claude).sort(), Object.keys(codex).sort());
  for (const step of [...claude.steps, ...codex.steps]) assert.deepEqual(Object.keys(step).sort(), Object.keys(claude.steps[0]).sort());
  // The same kind of work gets the same words, whichever agent did it.
  assert.deepEqual(codex.steps.map(s => s.summary), ['Edited 1 file', 'Ran tests: 12 passed']);
  assert.equal(codex.summary, 'Changed 1 file, ran tests: 12 passed');
  assert.equal(claude.summary, codex.summary);
});

test('S4: the turn list says which turns changed files, with relative paths only', async () => {
  const { steps, paseo } = setup();
  const claude = sessionTurnsRpc.output.parse(await steps.turns({ sessionId: CLAUDE_SESSION }, paseo));
  if (claude.status !== 'ok') return assert.fail(claude.message);
  assert.deepEqual(claude.turns.map(t => [t.turnId, t.changesFiles, t.summary]), [
    ['claude-turn-1', true, 'Changed files · 3 steps'],
    ['claude-turn-2', true, 'Changed files · 2 steps'],
    ['claude-turn-3', false, 'Answered without using tools'],
  ]);
  assert.deepEqual(claude.turns[1].files, ['CHANGELOG.md']);
  assert.equal(claude.turns[1].outsideFiles, 1);
  assert.equal(claude.nextCursor, null);
  const codex = sessionTurnsRpc.output.parse(await steps.turns({ sessionId: CODEX_SESSION }, paseo));
  if (codex.status !== 'ok') return assert.fail(codex.message);
  assert.deepEqual(codex.turns[0].files, ['src/parse.ts', 'src/parse-amount.ts']);
  assert.equal(codex.turns[0].outsideFiles, 1);
  noAbsolutePaths([claude, codex]);
});

test('S5: every change to one file, and an outside file only as "a file outside the project"', async () => {
  const { steps, paseo } = setup();
  const report = sessionFileHistoryRpc.output.parse(await steps.fileHistory({ sessionId: CLAUDE_SESSION, path: 'src/report.ts' }, paseo));
  if (report.status !== 'ok') return assert.fail(report.message);
  assert.deepEqual(report.touches.map(t => [t.change, t.summary, t.turnId]), [['read', 'Read it', 'claude-turn-1'], ['edited', 'Edited it', 'claude-turn-1']]);
  assert.equal(report.label, 'src/report.ts');
  const parser = await steps.fileHistory({ sessionId: CODEX_SESSION, path: 'src/parse-amount.ts' }, paseo);
  if (parser.status !== 'ok') return assert.fail(parser.message);
  assert.deepEqual(parser.touches.map(t => t.summary), ['Changed it with other files', 'Edited it']);
  const outside = sessionFileHistoryRpc.output.parse(await steps.fileHistory({ sessionId: CLAUDE_SESSION, path: '/shared/notes/tally.md' }, paseo));
  if (outside.status !== 'ok') return assert.fail(outside.message);
  assert.equal(outside.path, null);
  assert.equal(outside.label, OUTSIDE_PROJECT);
  noAbsolutePaths([report, parser, outside]);
});

test('S6: the capability gate answers in plain words on an older host or client', async () => {
  for (const options of [{ supported: false }, { oldClient: true }]) {
    const { steps, paseo } = setup(options);
    for (const result of [
      await steps.turns({ sessionId: CLAUDE_SESSION }, paseo),
      await steps.step({ sessionId: CLAUDE_SESSION, turnId: 'claude-turn-1' }, paseo),
      await steps.fileHistory({ sessionId: CLAUDE_SESSION, path: 'src/report.ts' }, paseo),
    ]) assert.deepEqual(result, { status: 'unsupported', message: NEWER_HOST_NEEDED });
  }
  const { steps, paseo, hosts } = setup({ supported: true });
  assert.equal((await steps.turns({ sessionId: CLAUDE_SESSION }, paseo)).status, 'ok');
  assert(hosts[CLAUDE_SESSION].calls.includes('turns:0'));
});

test('S7: sessions it cannot step through say why, and deleted-but-kept history still reads', async () => {
  const other = { ...FIXTURE_ENROLLMENT[0], host: 'macbook' };
  const remote = setup({ enrollment: [other] });
  assert.deepEqual(await remote.steps.turns({ sessionId: CLAUDE_SESSION }, remote.paseo), { status: 'unavailable', message: 'Step-through works for sessions on this Mac for now.' });
  const unknown = setup({ enrollment: [] });
  assert.equal((await unknown.steps.turns({ sessionId: CLAUDE_SESSION }, unknown.paseo)).status, 'unavailable');
  const kept = setup({ retained: true });
  const turns = await kept.steps.turns({ sessionId: CODEX_SESSION }, kept.paseo);
  const step = await kept.steps.step({ sessionId: CODEX_SESSION, turnId: 'codex-turn-1' }, kept.paseo);
  assert(turns.status === 'ok' && turns.retained && step.status === 'ok' && step.retained);
  // A deleted agent has no snapshot cwd; the enrollment row still places its paths.
  if (step.status === 'ok') assert.deepEqual(step.steps.find(s => s.files.length)!.files.map(f => f.path), ['src/parse.ts', 'src/parse-amount.ts', null]);
});

test('S8: placement and diff headers keep paths relative, on POSIX and Windows project folders', () => {
  assert.equal(placePath('/work/tally/src/a.ts', '/work/tally'), 'src/a.ts');
  assert.equal(placePath('src/./b.ts', '/work/tally'), 'src/b.ts');
  for (const outside of ['/work/tally-other/a.ts', '../escape.ts', '~/notes.md', '\\\\server\\share\\x.ts', 'C:\\x.ts', 'C:rel.ts', '/work/tally', ''])
    assert.equal(placePath(outside, '/work/tally'), null, outside);
  assert.equal(placePath('C:\\Work\\Tally\\src\\a.ts', 'c:\\work\\tally'), 'src/a.ts');
  assert.equal(placePath('/work/tally/a.ts', 'C:\\work\\tally'), null);
  assert.equal(scrubDiff('--- /elsewhere/secret.txt\n+++ /work/tally/src/a.ts\n+x', '/work/tally'), `--- ${OUTSIDE_PROJECT}\n+++ src/a.ts\n+x`);
});

test('S9: test runs are counted from the common runners, and other commands stay plain', () => {
  assert.deepEqual(testCounts('Tests:       1 failed, 11 passed, 12 total'), { passed: 11, failed: 1 });
  assert.deepEqual(testCounts('# pass 7\n# fail 0'), { passed: 7, failed: 0 });
  assert.deepEqual(testCounts('==== 3 passed in 0.12s ===='), { passed: 3, failed: 0 });
  assert.equal(testCounts('Build finished'), null);
  assert.equal(commandSummary('pytest -q', '==== 3 passed in 0.12s ====', 0, false), 'Ran tests: 3 passed');
  assert.equal(commandSummary('go test ./...', 'FAIL', 1, false), 'Ran tests: they failed');
  assert.equal(commandSummary('git status', 'clean', 0, false), 'Ran a command');
  assert.equal(commandSummary('make build', 'error', 2, false), 'Ran a command: it failed');
});

// ---------------------------------------------------------------------------------------------------------------
// Round 2 (R-C-J6-1..3). Every path and address below is invented for the test.
const OUTSIDE_WORDS = ['/shared/private', '/Users/', '/Volumes/', 'someone@example.org', 'sk-test', 'D:\\Private', '\\\\fileserver'];
function customHost(entries: any[], cwd: string | null = '/work/tally') {
  return createSessionSteps({
    call: async () => [],
    enrollment: async () => [{ id: CLAUDE_SESSION, task: FIXTURE_ENROLLMENT[0].task, host: 'mini', cwd }],
    projects: async () => FIXTURE_DIRECTORY,
    bounded: work => work,
  });
}
const paseoFor = (host: ReturnType<typeof fakeHost>) => ({ agents: { ref: () => ({ timeline: host }) } });
const entry = (seq: number, item: any, turnId = 't-1') => ({ provider: 'claude', turnId, seqStart: seq, seqEnd: seq, timestamp: `2026-09-25T09:00:0${seq % 10}.000Z`, item });

test('S10: prompts, reasoning, commands, output and diff bodies never carry an outside path or personal data', async () => {
  const entries = [
    entry(1, { type: 'user_message', text: 'Compare /work/tally/src/report.ts with /shared/private/budget.xlsx and mail someone@example.org', clientMessageId: 'c' }),
    entry(2, { type: 'reasoning', text: 'The old copy lives in /Users/someone/Desktop/report.ts; the new one is /work/tally/src/report.ts.' }),
    entry(3, { type: 'tool_call', callId: 'sh', name: 'Bash', status: 'completed', error: null, detail: { type: 'shell', command: 'cat /Volumes/Backup/tally/secrets.env && ls /work/tally', output: 'KEY=sk-test-123\nnot found: /shared/private/notes.txt\nok /work/tally/src/report.ts', exitCode: 0 } }),
    entry(4, { type: 'tool_call', callId: 'ed', name: 'Edit', status: 'completed', error: null, detail: { type: 'edit', filePath: '/work/tally/src/report.ts', unifiedDiff: '--- /work/tally/src/report.ts\n+++ /work/tally/src/report.ts\n@@ -1 +1 @@\n-// copied from /shared/private/old.ts\n+// see src/report.ts' } }),
  ];
  const result = await customHost(entries).step({ sessionId: CLAUDE_SESSION, turnId: 't-1' }, paseoFor(fakeHost({ entries })));
  if (result.status !== 'ok') return assert.fail(result.message);
  const text = JSON.stringify(result);
  for (const word of OUTSIDE_WORDS) assert(!text.includes(word), word);
  assert.deepEqual(personalMatches(text), []);
  assert.equal(result.asked, 'Compare src/report.ts with a file outside the project and mail [removed]');
  assert.equal(result.steps[0].why, 'The old copy lives in a file outside the project; the new one is src/report.ts.');
  assert.equal(result.steps[0].command, 'cat a file outside the project && ls the project folder');
  // A token takes its whole word with it: `KEY=sk-…` is removed entirely, the conservative choice.
  assert.equal(result.steps[0].output, '[removed]\nnot found: a file outside the project\nok src/report.ts');
  assert.equal(result.steps[1].files[0].diff, '--- src/report.ts\n+++ src/report.ts\n@@ -1 +1 @@\n-// copied from a file outside the project\n+// see src/report.ts');

  // A Windows project in another letter case, and a session whose project folder is unknown.
  const windows = [entry(1, { type: 'reasoning', text: 'Read c:\\work\\TALLY\\src\\a.ts, not D:\\Private\\a.ts or \\\\fileserver\\share\\a.ts.' })];
  const onWindows = await customHost(windows, 'C:\\Work\\Tally').step({ sessionId: CLAUDE_SESSION, turnId: 't-1' }, paseoFor(fakeHost({ entries: windows, cwd: 'C:\\Work\\Tally' })));
  const unknown = [entry(1, { type: 'reasoning', text: 'Look at /work/tally/src/a.ts and C:\\Work\\a.ts' }), entry(2, { type: 'tool_call', callId: 'r', name: 'Read', status: 'completed', error: null, detail: { type: 'read', filePath: '/work/tally/src/a.ts' } })];
  const noCwd = await customHost(unknown, null).step({ sessionId: CLAUDE_SESSION, turnId: 't-1' }, paseoFor(fakeHost({ entries: unknown, retained: true })));
  if (onWindows.status !== 'ok' || noCwd.status !== 'ok') return assert.fail('both readable');
  assert.equal(onWindows.steps.length, 0);
  const windowsWhy = await customHost([...windows, entry(2, { type: 'tool_call', callId: 'x', name: 'Read', status: 'completed', error: null, detail: { type: 'read', filePath: 'C:\\Work\\Tally\\src\\a.ts' } })], 'C:\\Work\\Tally')
    .step({ sessionId: CLAUDE_SESSION, turnId: 't-1' }, paseoFor(fakeHost({ entries: [...windows, entry(2, { type: 'tool_call', callId: 'x', name: 'Read', status: 'completed', error: null, detail: { type: 'read', filePath: 'C:\\Work\\Tally\\src\\a.ts' } })], cwd: 'C:\\Work\\Tally' })));
  if (windowsWhy.status !== 'ok') return assert.fail(windowsWhy.message);
  assert.equal(windowsWhy.steps[0].why, 'Read src/a.ts, not a file outside the project or a file outside the project.');
  assert.deepEqual(windowsWhy.steps[0].files.map(f => f.path), ['src/a.ts']);
  // Unknown cwd: every absolute path is outside, in text and in file objects alike.
  assert.equal(noCwd.steps[0].why, 'Look at a file outside the project and a file outside the project');
  assert.deepEqual(noCwd.steps[0].files.map(f => f.path), [null]);
});

test('S11: outside-only writes and deletes count as file changes; an outside-only read does not', async () => {
  const outsideWrite = { type: 'tool_call', callId: 'w', name: 'Write', status: 'completed', error: null, detail: { type: 'write', filePath: '/shared/private/out.txt', content: 'x' } };
  const outsideDelete = { type: 'tool_call', callId: 'd', name: 'apply_patch', status: 'completed', error: null, detail: { type: 'unknown', input: null, output: null, files: [{ path: '/shared/private/old.txt', kind: 'delete' }] } };
  const outsideRead = { type: 'tool_call', callId: 'r', name: 'Read', status: 'completed', error: null, detail: { type: 'read', filePath: '/shared/private/in.txt' } };
  const entries = [entry(1, outsideWrite, 'write'), entry(2, outsideDelete, 'delete'), entry(3, outsideRead, 'read')];
  const result = await customHost(entries).turns({ sessionId: CLAUDE_SESSION }, paseoFor(fakeHost({ entries })));
  if (result.status !== 'ok') return assert.fail(result.message);
  assert.deepEqual(result.turns.map(t => [t.turnId, t.files, t.outsideFiles, t.changesFiles, t.summary]), [
    ['write', [], 1, true, 'Changed files · 1 step'],
    ['delete', [], 1, true, 'Changed files · 1 step'],
    ['read', [], 1, false, 'Looked at files · 1 step'],
  ]);
  // When the outside bucket cannot be read, those turns are unresolved (null), which the filter keeps.
  const host = fakeHost({ entries }), failing = { ...host, fileHistory: async () => { throw new Error('slow disk'); } };
  const unresolved = await customHost(entries).turns({ sessionId: CLAUDE_SESSION }, paseoFor(failing as any));
  if (unresolved.status !== 'ok') return assert.fail(unresolved.message);
  assert.deepEqual(unresolved.turns.map(t => [t.changesFiles, t.summary]), [[null, 'Worked with files · 1 step'], [null, 'Worked with files · 1 step'], [null, 'Worked with files · 1 step']]);
});

test('S13 (L38): a turn that only ran commands stays under "Only file changes", with a note saying their changes are not listed', async () => {
  const shell = (id: string, command: string) => ({ type: 'tool_call', callId: id, name: 'shell', status: 'completed', error: null, detail: { type: 'shell', command, output: '', exitCode: 0 } });
  const read = { type: 'tool_call', callId: 'r', name: 'Read', status: 'completed', error: null, detail: { type: 'read', filePath: '/work/tally/src/a.ts' } };
  const entries = [entry(1, shell('c1', "printf 'a' > notes/a.md"), 'build'), entry(2, shell('c2', "sed -i '' s/x/y/ notes/b.md"), 'build'), entry(3, shell('c3', 'cat > notes/c.md'), 'build'), entry(4, read, 'look')];
  const result = await customHost(entries).turns({ sessionId: CLAUDE_SESSION }, paseoFor(fakeHost({ entries })));
  if (result.status !== 'ok') return assert.fail(result.message);
  assert.deepEqual(result.turns.map(t => [t.turnId, t.commands, t.changesFiles, t.summary, t.note]), [
    ['build', 3, null, 'Ran commands · 3 steps', 'Ran 3 commands; changes made through commands are not listed.'],
    ['look', 0, false, 'Looked at files · 1 step', null],
  ]);
  // A host from before command counts: exactly the previous answer.
  const old = await customHost(entries).turns({ sessionId: CLAUDE_SESSION }, paseoFor(fakeHost({ entries, countsCommands: false })));
  if (old.status !== 'ok') return assert.fail(old.message);
  assert.deepEqual(old.turns.map(t => [t.commands, t.changesFiles, t.summary, t.note]), [[0, false, 'Used tools · 3 steps', null], [0, false, 'Looked at files · 1 step', null]]);
});

test('S12: one budget under the host limit; classification stops early on a slow host and leaves turns unresolved', async () => {
  // 30 turns, each touching its own file, on a host where every file history takes one (fake) second.
  const entries = Array.from({ length: 30 }, (_, i) => entry(i + 1, { type: 'tool_call', callId: `e${i}`, name: 'Edit', status: 'completed', error: null, detail: { type: 'edit', filePath: `/work/tally/src/f${i}.ts`, unifiedDiff: '@@\n-a\n+b' } }, `turn-${i}`));
  let clock = 0;
  const host = fakeHost({ entries }), histories: string[] = [];
  const slow = { ...host,
    turns: async (o: any) => { clock += 2000; return host.turns(o); },
    fileHistory: async (path: string) => { histories.push(path); clock += 1000; return host.fileHistory(path); } };
  const limits: number[] = [];
  const steps = createSessionSteps({
    call: async () => [], projects: async () => FIXTURE_DIRECTORY, now: () => clock,
    enrollment: async (_call: any, ms?: number) => { limits.push(ms!); clock += 1000; return [{ id: CLAUDE_SESSION, task: FIXTURE_ENROLLMENT[0].task, host: 'mini', cwd: '/work/tally' }]; },
    bounded: (work, ms) => { limits.push(ms); return work; },
  });
  const result = await steps.turns({ sessionId: CLAUDE_SESSION }, paseoFor(slow as any));
  if (result.status !== 'ok') return assert.fail(result.message);
  assert.equal(result.turns.length, 30);
  assert(clock <= SESSION_STEPS_BUDGET_MS, `finished within the budget (${clock} ms)`);
  assert(histories.length < 30, `classification stopped early (${histories.length} reads)`);
  assert(limits.every(ms => ms > 0 && ms <= 12000), 'every stage is bounded by what is left, never more than 12 s');
  assert(limits.every((ms, i) => i === 0 || ms <= limits[i - 1] + 4000), 'limits shrink as the budget is spent');
  const unresolved = result.turns.filter(t => t.changesFiles === null).length, resolved = result.turns.filter(t => t.changesFiles === true).length;
  assert.equal(resolved, histories.length);
  assert.equal(unresolved, 30 - histories.length);
});

test('U5-D08: comment openers and code punctuation in a diff are kept verbatim; real paths are still placed', async () => {
  const { scrubFreeText } = await import('../shared/privacy-scrub');
  const diff = '+/**\n+ * Index the turn.\n+ */\n+/* legacy */ x /= 2;\n+// see /Users/someone/secret.ts and /repo/src/a.ts';
  const out = scrubFreeText(diff, '/repo');
  assert.equal(out, '+/**\n+ * Index the turn.\n+ */\n+/* legacy */ x /= 2;\n+// see a file outside the project and src/a.ts');
});
