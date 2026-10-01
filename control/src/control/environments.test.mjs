// Fulcra J8 Environments (CONTRACTS §6). Temporary git repositories with fake scripts only: nothing here touches a
// host. The decision store is J3's real one (decisions.fixture.mjs), with a paired test device for proven answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { P } from './decisions.fixture.mjs';
import { PacketRefused } from '../../orca-organization/shared/cc/decision-rules.mjs';
import { setup, definition, step, sh, REPO } from './environments.fixture.mjs';
import { Environments } from './environments.mjs';
import { resolveScript, runScript, scrubLine, captureGroupOwner } from './environment-runner.mjs';
import { validateDefinition, relpath, sameDefinition, definitionChanges, EnvironmentRefused } from '../../orca-organization/shared/cc/environment-rules.mjs';

test('a definition change waits for a proven approval; until then the old definition stays in force', async t => {
  const s = await setup(t);
  const created = await s.propose(definition('next', 1));
  assert.equal(created.inForce, null, 'a new environment is not in force before approval');
  const packet = s.control.decisions.packet(created.decisionId);
  assert.equal(packet.kind, 'approval'); assert.equal(packet.action.type, 'environment-change'); assert.equal(packet.action.environmentId, created.environmentId);
  await s.env.tick();
  assert.equal(s.env.environment(created.environmentId), null, 'no answer, nothing applied');
  // An operator (unproven) answer to a bound approval is refused by the decision store, so nothing can apply.
  await assert.rejects(s.choose(packet, 'approve'), /paired device/);
  const applied = await s.approveDefinition(created);
  const next = s.env.environment(created.environmentId);
  assert.equal(next.revision, applied.revision); assert.deepEqual(next.steps.verify.args, ['0']);
  // v1.15 (J8-1): a rename runs nothing new, but approval cards are worded from it, so it waits for approval too.
  const renamed = await s.propose({ ...definition('next', 1), label: 'Practice' }, next.id, next.revision);
  assert.ok(renamed.pending); assert.equal(s.env.environment(next.id).label, 'Next', 'the old name stays until approved');
  assert.match(s.control.decisions.packet(renamed.decisionId).situation, /renames Next to Practice/);
  await s.approveDefinition(renamed); assert.equal(s.env.environment(next.id).label, 'Practice');
  await assert.rejects(s.propose({ ...definition('next', 1), label: 'Practice' }, next.id, s.env.envRow(next.id).revision), /already in force/);
  // A step change waits, and the old steps stay in force until it is approved; a "Not now" keeps them.
  const current = s.env.environment(next.id);
  const change = await s.propose({ ...definition('next', 1), label: 'Practice', steps: { ...definition('next', 1).steps, verify: step('scripts/verify.sh', ['1']) } }, next.id, current.revision);
  assert.ok(change.pending); assert.deepEqual(s.env.environment(next.id).steps.verify.args, ['0'], 'old definition still in force');
  await assert.rejects(s.propose({ ...definition('next', 1), label: 'Again' }, next.id, s.env.envRow(next.id).revision), /already waiting for approval/);
  await s.chooseProven(s.dev, s.control.decisions.packet(change.decisionId), 'reject'); await s.env.tick();
  assert.deepEqual(s.env.environment(next.id).steps.verify.args, ['0'], 'rejected: the old steps stay');
  assert.equal(s.env.envRow(next.id).pending, null);
  await assert.rejects(s.propose(definition('next', 1), next.id, 0), /Changed since you looked/);
});

test('a destructive step marks the approval destructive, so choosing it needs the second confirmation', async t => {
  const s = await setup(t);
  const created = await s.propose(definition('prod', 2, { steps: { ...definition('prod', 2).steps, deploy: step('scripts/deploy.sh', [], { destructive: true }) } }));
  const packet = s.control.decisions.packet(created.decisionId), approve = packet.options.find(o => o.id === 'approve');
  assert.equal(approve.destructive, true); assert.equal(approve.impacts.reversibility, 'irreversible');
  assert.equal(packet.options.find(o => o.id === 'reject').destructive, false);
  await assert.rejects(s.chooseProven(s.dev, packet, 'approve'), /confirm it a second time/);
  // The same holds for a promotion into an environment with a destructive step.
  await s.chooseProven(s.dev, packet, 'approve', { confirmDestructive: true }); await s.env.tick();
  const from = await s.environment('next', 1), to = s.env.environment(created.environmentId);
  const p = await s.promote(from, to); await s.ask(p);
  const asked = s.control.decisions.packet(s.env.promotion(p.id).decisionId);
  assert.equal(asked.level, 1, 'a promotion to the live environment is a level-1 packet');
  assert.equal(asked.options.find(o => o.id === 'approve').destructive, true);
});

test('the runner refuses without a matching proven approval, and after any digest change', async t => {
  const s = await setup(t);
  const from = await s.environment('dev', 0), to = await s.environment('next', 1);
  const p = await s.promote(from, to);
  assert.equal(p.state, 'proposed'); assert.deepEqual(p.readiness, [{ requirementId: 'ready', state: 'pass' }]);
  // No approval at all: the watcher has nothing to run, and a direct run with an invented approval is refused.
  await s.settle(); assert.equal(s.marker('deployed'), false);
  await s.ask(p);
  const asked = s.env.promotion(p.id), packet = s.control.decisions.packet(asked.decisionId);
  assert.equal(asked.state, 'awaiting-approval'); assert.deepEqual(packet.action, { type: 'promotion', promotionId: p.id, digest: asked.digest });
  await s.env.run(p.id, { decisionId: packet.id, revision: packet.revision, action: packet.action });
  assert.equal(s.marker('deployed'), false, 'an open packet authorizes nothing');
  await assert.rejects(s.choose(packet, 'approve'), /paired device/, 'an operator answer cannot approve a bound action');
  await s.settle(); assert.equal(s.marker('deployed'), false);
  // A proven approval, then the plan changes before the runner starts: the digest no longer matches, nothing runs.
  await s.chooseProven(s.dev, packet, 'approve');
  const row = s.env.envRow(to.id), changed = { ...JSON.parse(row.json), steps: { ...JSON.parse(row.json).steps, deploy: step('scripts/deploy.sh', ['--other']) } };
  s.control.store.db.prepare('UPDATE cc_environments SET json=? WHERE id=?').run(JSON.stringify(changed), to.id);
  await s.settle();
  const after = s.env.promotion(p.id);
  assert.equal(after.state, 'cancelled'); assert.match(after.log.at(-1).line, /plan changed after it was approved/);
  assert.equal(s.marker('deployed'), false, 'a changed plan never runs');
});

test('an approved promotion deploys and verifies, and records what is where', async t => {
  const s = await setup(t);
  const from = await s.environment('dev', 0), to = await s.environment('next', 1);
  const p = await s.promote(from, to); await s.ask(p);
  await s.chooseProven(s.dev, s.control.decisions.packet(s.env.promotion(p.id).decisionId), 'approve');
  await s.settle();
  const done = s.env.promotion(p.id);
  assert.equal(done.state, 'succeeded'); assert.equal(fs.readFileSync(path.join(s.out, 'deployed'), 'utf8').trim(), s.r.second);
  assert.ok(done.log.some(l => l.step === 'deploy' && l.line === 'deploying next'));
  assert.equal(s.marker('rolled-back'), false);
  const view = s.env.view(P(1)), row = view.environments.find(e => e.key === 'next');
  assert.equal(row.current.version.commit, `commit:${REPO}@${s.r.second}`); assert.equal(row.current.status, 'succeeded'); assert.equal(row.health, 'good');
  assert.deepEqual(view.environments.map(e => e.key), ['dev', 'next'], 'the path is in order');
  // The next promotion to the same place reports what changes since the version that is there now.
  const again = await s.promote(from, to, s.r.second);
  assert.deepEqual(s.env.promotionResult(again.id).changes, { from: `commit:${REPO}@${s.r.second}`, files: 0, sample: [] });
});

test('a failed verify rolls back automatically and records it', async t => {
  const s = await setup(t);
  const from = await s.environment('dev', 0), to = await s.environment('next', 1, { steps: { ...definition('next', 1).steps, verify: step('scripts/verify.sh', ['3']) } });
  const p = await s.promote(from, to); await s.ask(p);
  await s.chooseProven(s.dev, s.control.decisions.packet(s.env.promotion(p.id).decisionId), 'approve');
  await s.settle();
  const done = s.env.promotion(p.id);
  assert.equal(done.state, 'rolled-back'); assert.ok(s.marker('deployed') && s.marker('verified') && s.marker('rolled-back'));
  const run = done.log.slice(done.log.findIndex(l => /starting$/.test(l.line)));
  assert.deepEqual([...new Set(run.map(l => l.step))], ['deploy', 'verify', 'rollback'], 'after approval: deploy, then verify, then rollback');
  const latest = s.env.view(P(1)).environments.find(e => e.key === 'next');
  assert.equal(latest.latest.status, 'rolled-back'); assert.equal(latest.current, null, 'a rolled-back version is not "what is there"'); assert.equal(latest.health, 'attention');
});

test('a failing setup check blocks asking for approval', async t => {
  const s = await setup(t);
  const from = await s.environment('dev', 0), to = await s.environment('next', 1, { requirements: [{ id: 'broken', label: 'The database is reachable', check: { kind: 'script', script: 'checks/broken.sh', args: [], timeoutS: 30 } }] });
  const p = await s.promote(from, to);
  assert.deepEqual(p.readiness, [{ requirementId: 'broken', state: 'fail' }]);
  await assert.rejects(s.ask(p), /setup check failed/);
  assert.equal(s.env.environment(to.id).requirements[0].last.state, 'fail', 'the checklist shows the result');
});

test('scripts outside the repository, absolute paths and non-executables are refused', async t => {
  for (const bad of ['/usr/bin/true', '../escape.sh', 'scripts/../../x', '~/deploy.sh', 'scripts\\deploy.sh', 'scripts/./deploy.sh', ''])
    assert.throws(() => relpath(bad), EnvironmentRefused, bad);
  assert.throws(() => validateDefinition(definition('next', 1, { steps: { ...definition('next', 1).steps, deploy: step('/bin/sh', ['-c', 'echo hi']) } })), /not an absolute path/);
  assert.throws(() => validateDefinition({ ...definition('next', 1), command: 'rm -rf /' }), /unknown fields: command/);
  assert.throws(() => validateDefinition(definition('next', 1, { steps: { ...definition('next', 1).steps, deploy: { script: 'scripts/deploy.sh', args: [], timeoutS: 30, destructive: false, shell: 'sh -c x' } } })), /unknown fields: shell/);
  const s = await setup(t);
  assert.throws(() => resolveScript(s.r.repo, 'scripts/outside.sh'), /points outside the repository/);
  assert.throws(() => resolveScript(s.r.repo, 'scripts/not-executable.sh'), /not executable/);
  assert.throws(() => resolveScript(s.r.repo, 'scripts/missing.sh'), /does not exist/);
});

test('a script sees only the allowlisted environment, and stored lines never carry personal paths', async t => {
  const s = await setup(t);
  process.env.FULCRA_TEST_SECRET = 'must-not-leak';
  t.after(() => { delete process.env.FULCRA_TEST_SECRET; });
  const run = await runScript({ checkout: s.r.repo, script: 'scripts/env.sh', args: [], timeoutS: 30, context: { environment: 'next', commit: s.r.second, promotion: null, step: 'check' } });
  const names = run.lines.map(l => l.split('=')[0]).filter(n => /^[A-Z_]+$/.test(n));
  assert.deepEqual(names.filter(n => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(n)).sort(), ['FULCRA_CANDIDATE_DIR', 'FULCRA_COMMIT', 'FULCRA_ENVIRONMENT', 'FULCRA_PROMOTION', 'FULCRA_STEP', 'HOME', 'LANG', 'PATH', 'TMPDIR']);
  assert.ok(!run.lines.join('\n').includes('must-not-leak'));
  assert.ok(run.lines.some(l => l === 'HOME=.'), 'the checkout path is written as "."');
  assert.equal(scrubLine('Wrote /Users/someone/secret.txt', '/tmp/x'), '(line withheld: it contained a personal path, host or secret)');
  const slow = await runScript({ checkout: s.r.repo, script: 'checks/ready.sh', args: [], timeoutS: 1, context: { environment: 'next', commit: s.r.second, promotion: null, step: 'check' } });
  assert.equal(slow.ok, true);
});

test('a promotion interrupted by a restart is not resumed and is marked unknown', async t => {
  const s = await setup(t);
  const from = await s.environment('dev', 0), to = await s.environment('next', 1);
  const p = await s.promote(from, to);
  s.control.store.db.prepare("UPDATE cc_promotions SET state='running', json=json_set(json,'$.state','running') WHERE id=?").run(p.id);
  const again = new Environments(s.control, { resolveRepo: () => s.r.repo, checkoutRoot: path.join(s.dir, 'checkouts'), pumpEveryMs: 0 });
  assert.equal(again.promotion(p.id).state, 'failed');
  assert.equal(again.view(P(1)).environments.find(e => e.key === 'next').latest.status, 'unknown');
});

test('through the controller socket: role and operator lanes, and no method that runs a promotion', async t => {
  const s = await setup(t);
  const from = await s.environment('dev', 0), to = await s.environment('next', 1);
  const view = await s.role('project', 'roles-environments', { projectId: P(1) });
  assert.deepEqual(view.environments.map(e => e.key), ['dev', 'next']);
  await assert.rejects(s.request({ method: 'environments-view', input: { projectId: P(1) } }), /Operator authorization required/);
  for (const method of ['promotions-run', 'promotion-run', 'environments-run', 'roles-promotion-run']) await assert.rejects(s.op(method, { id: randomUUID() }), /./, method);
  // The app (operator) prepares a promotion exactly as §6 says, but it has no session to ask as yet
  // (CONTRACT-CHANGE-J8-1): it stays prepared, says so plainly, and never runs.
  const created = await s.op('promotions-create', { messageId: randomUUID(), projectId: P(1), from: from.id, to: to.id, commit: `commit:${REPO}@${s.r.second}`, expectedRevision: to.revision });
  await s.env.preparing.get(created.promotion.id);
  const prepared = s.env.promotionResult(created.promotion.id);
  // C1: with J3's decisions.askSystem (v1.15) merged, the app's promotion is asked by the controller itself and waits
  // for the owner's approval; without it, it stays prepared and says who can ask. It never runs either way.
  if (s.env.canAskSystem()) { assert.equal(prepared.promotion.state, 'awaiting-approval'); assert.notEqual(prepared.promotion.decisionId, null); assert.equal(prepared.waiting, null); }
  else { assert.equal(prepared.promotion.state, 'proposed'); assert.equal(prepared.promotion.decisionId, null); assert.match(prepared.waiting, /orchestrator/); }
  await s.settle(); assert.equal(s.marker('deployed'), false);
  const cancelled = await s.op('promotions-cancel', { messageId: randomUUID(), id: prepared.promotion.id, expectedRevision: prepared.promotion.revision, note: 'Not this week' });
  assert.equal(cancelled.promotion.state, 'cancelled');
  // The owner's write is refused for an unknown field such as a shell command (§1 Unknown keys).
  await assert.rejects(s.op('promotions-create', { messageId: randomUUID(), projectId: P(1), from: from.id, to: to.id, commit: `commit:${REPO}@${s.r.second}`, expectedRevision: to.revision, command: 'deploy.sh' }), /Invalid promotion request/);
});

test('J8-6: a promotion moves exactly one step, to the next environment after the one it starts from', async t => {
  const s = await setup(t);
  const dev = await s.environment('dev', 0), next = await s.environment('next', 1), prod = await s.environment('prod', 2);
  const create = (from, to) => s.env.promotionCreate({ sessionId: s.project, messageId: randomUUID(), projectId: P(1), from: from.id, to: to.id, commit: `commit:${REPO}@${s.r.second}`, expectedRevision: to.revision }, s.lane);
  await assert.rejects(create(dev, prod), /one step at a time: after Dev comes Next, not Live/);
  await assert.rejects(create(prod, next), /go forward along the path/);
  const ok = await s.promote(next, prod); assert.equal(ok.state, 'proposed');
  // Two environments in the same place make "the next step" ambiguous: refused rather than guessed.
  const twin = await s.environment('staging', 1);
  await assert.rejects(create(dev, twin), /share the next place after Dev/);
});

test('J8-1: renaming, reordering or retargeting waits for approval, and voids an approved promotion', async t => {
  const s = await setup(t);
  const dev = await s.environment('dev', 0), live = await s.environment('prod', 2);
  const p = await s.promote(dev, live); await s.ask(p);
  const card = s.control.decisions.packet(s.env.promotion(p.id).decisionId);
  assert.equal(card.level, 1); assert.match(card.title, /to Live\?$/);
  await s.chooseProven(s.dev, card, 'approve');
  // Probe N: re-propose the live environment as a harmless-sounding "Next" with the same steps.
  const relabel = await s.propose({ ...definition('prod', 2), key: 'next', label: 'Next' }, live.id, s.env.environment(live.id).revision);
  assert.ok(relabel.pending, 'not applied at once'); assert.equal(s.env.environment(live.id).key, 'prod');
  const packet = s.control.decisions.packet(relabel.decisionId);
  assert.equal(packet.level, 1, 'a change to the live environment is a level-1 question'); assert.match(packet.situation, /renames Live to Next/);
  // Order, target and retiring count as changes too.
  const words = change => definitionChanges(live, { ...definition('prod', 2), definitionCommit: live.definitionCommit, ...change });
  assert.deepEqual(words({ order: 3 }), ['moves it from place 2 to place 3 in the path']);
  assert.deepEqual(words({ target: { kind: 'external', label: 'Hosting', site: 'example.com' } }), ['changes where it runs']);
  assert.deepEqual(words({ state: 'retired' }), ['retires it']);
  assert.equal(sameDefinition(live, { ...definition('prod', 2), definitionCommit: live.definitionCommit }), true);
  assert.equal(sameDefinition(live, definition('prod', 2)), false, 'the version of the scripts is part of the definition');
  // The owner approves the rename: the promotion approved before it no longer matches, so nothing runs.
  await s.chooseProven(s.dev, packet, 'approve'); await s.settle();
  assert.equal(s.env.environment(live.id).label, 'Next');
  const after = s.env.promotion(p.id);
  assert.equal(after.state, 'cancelled'); assert.match(after.log.at(-1).line, /plan changed after it was approved/);
  assert.equal(s.marker('deployed'), false);
});

test('J8-3: the role lane acts only on the caller\'s own project', async t => {
  const s = await setup(t);
  const dev = await s.environment('dev', 0), next = await s.environment('next', 1);
  const p = await s.promote(dev, next);
  const refused = /Only this project's orchestrator, or the prime that owns it/;
  // Probe O: the prime seat "research" does not own P(1) and is not its orchestrator.
  await assert.rejects(s.role('other', 'roles-environments', { projectId: P(1) }), refused);
  await assert.rejects(s.role('other', 'roles-environment-propose', { messageId: randomUUID(), projectId: P(1), environmentId: null, expectedRevision: 0, definition: definition('prod', 2), note: '' }), refused);
  await assert.rejects(s.role('other', 'roles-promotion-create', { messageId: randomUUID(), projectId: P(1), from: dev.id, to: next.id, commit: `commit:${REPO}@${s.r.second}`, expectedRevision: next.revision }), refused);
  await assert.rejects(s.role('other', 'roles-promotion-ask', { messageId: randomUUID(), promotionId: p.id }), refused);
  await assert.rejects(s.role('other', 'roles-promotion-ask', { messageId: randomUUID(), promotionId: randomUUID() }), refused, 'an unknown id says no more than a foreign one');
  // The project's own orchestrator can, and so can the prime that owns the project (J1's remits, when installed).
  assert.equal((await s.role('project', 'roles-environments', { projectId: P(1) })).environments.length, 2);
  await assert.rejects(s.role('prime', 'roles-environments', { projectId: P(1) }), refused, 'no remit: the delivery prime does not own it');
  s.control.remits = { ownerOf: id => ({ kind: 'project', primeSeat: id === P(1) ? 'delivery' : null, remitId: randomUUID() }) };
  assert.equal((await s.role('prime', 'roles-environments', { projectId: P(1) })).environments.length, 2);
  await assert.rejects(s.role('other', 'roles-environments', { projectId: P(1) }), refused);
});

test('J8-5: the app lane asks through askSystem({component, messageId, packet}, {seat?}), and a failed ask is surfaced', async t => {
  const s = await setup(t);
  const dev = await s.environment('dev', 0), next = await s.environment('next', 1);
  const calls = [];
  const create = async () => {
    const created = await s.op('promotions-create', { messageId: randomUUID(), projectId: P(1), from: dev.id, to: next.id, commit: `commit:${REPO}@${s.r.second}`, expectedRevision: next.revision });
    await s.env.preparing.get(created.promotion.id);
    return created.promotion.id;
  };
  // The v1.15 §3.3 signature, exactly: one request object and one options object, no session.
  s.control.decisions.askSystem = async (a, options) => { calls.push([a, options]); return { decision: { id: randomUUID() } }; };
  const asked = await create();
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0][0]).sort(), ['component', 'messageId', 'packet']); assert.deepEqual(calls[0][1], {});
  assert.equal(calls[0][0].component, 'environments'); assert.deepEqual(calls[0][0].packet.action, { type: 'promotion', promotionId: asked, digest: s.env.promotion(asked).digest });
  assert.equal(s.env.promotion(asked).state, 'awaiting-approval'); assert.equal(s.env.promotionResult(asked).waiting, null);
  await s.op('promotions-cancel', { messageId: randomUUID(), id: asked, expectedRevision: s.env.promotion(asked).revision, note: '' });
  // A refusal is not swallowed: it is in the log, in the history and in what the promotion says when read.
  s.control.decisions.askSystem = async () => { throw new PacketRefused('The bound action no longer exists'); };
  const failed = await create(), p = s.env.promotion(failed);
  assert.equal(p.state, 'proposed'); assert.equal(p.decisionId, null);
  assert.match(p.log.at(-1).line, /could not be asked \(The bound action no longer exists\)\. Nothing will run/);
  assert.match(s.env.promotionResult(failed).waiting, /could not be asked/);
  assert.ok(s.control.store.db.prepare("SELECT 1 FROM cc_promotion_history WHERE entityId=? AND action='ask-failed'").get(failed));
  // Anything else is reported without its internal wording, and a store that returns no question is a failure too.
  await s.op('promotions-cancel', { messageId: randomUUID(), id: failed, expectedRevision: p.revision, note: '' });
  s.control.decisions.askSystem = async () => ({});
  const empty = await create();
  assert.match(s.env.promotion(empty).log.at(-1).line, /did not return the question it asked/);
  await s.settle(); assert.equal(s.marker('deployed'), false);
});

// J8-2 / J8-7 helpers: a pid is gone once signalling it fails (killed children are reaped by the system shortly).
const gone = async pid => { for (let i = 0; i < 40; i++) { try { process.kill(pid, 0); } catch { return true; } await new Promise(r => setTimeout(r, 50)); } return false; };
const childOf = run => Number(run.lines.find(l => l.startsWith('child '))?.slice(6));
const ctx = sha => ({ environment: 'next', commit: sha, promotion: null, step: 'check' });

test('J8-2: a timeout, a cancel or the end of a script stops its whole process group, even with output held open', async t => {
  const s = await setup(t);
  // Probe P: `sleep 30 &` keeps the output pipe open; the time limit still holds.
  let started = Date.now(), groups = [];
  const late = await runScript({ checkout: s.r.repo, script: 'scripts/linger.sh', args: [], timeoutS: 1, context: ctx(s.r.second), onGroup: g => groups.push(g) });
  assert.ok(Date.now() - started < 5000, `returned after ${Date.now() - started} ms`);
  assert.equal(late.timedOut, true); assert.equal(late.ok, false); assert.match(late.lines.at(-1), /Stopped after 1 s/);
  assert.ok(await gone(childOf(late)), 'the background child was stopped with its group');
  assert.equal(groups.length, 2); assert.ok(groups[0] > 1); assert.equal(groups[1], null, 'the group is reported, then cleared');
  // A script that exits leaves nothing behind, and is not held up by what it left.
  started = Date.now();
  const left = await runScript({ checkout: s.r.repo, script: 'scripts/leave.sh', args: [], timeoutS: 30, context: ctx(s.r.second) });
  assert.equal(left.ok, true); assert.ok(Date.now() - started < 3000); assert.ok(await gone(childOf(left)));
  // Cancelling stops the group too.
  const abort = new AbortController(); started = Date.now();
  const running = runScript({ checkout: s.r.repo, script: 'scripts/linger.sh', args: [], timeoutS: 60, context: ctx(s.r.second), signal: abort.signal });
  setTimeout(() => abort.abort(), 300);
  const cancelled = await running;
  assert.equal(cancelled.cancelled, true); assert.equal(cancelled.ok, false); assert.ok(Date.now() - started < 3000); assert.ok(await gone(childOf(cancelled)));
});

test('J8-2: cancelling a promotion stops its running setup check; shutting down stops the rest', async t => {
  const s = await setup(t);
  const slow = { requirements: [{ id: 'slow', label: 'The slow check', check: { kind: 'script', script: 'checks/slow.sh', args: [], timeoutS: 600 } }] };
  const dev = await s.environment('dev', 0), next = await s.environment('next', 1, slow);
  const create = () => s.env.promotionCreate({ sessionId: s.project, messageId: randomUUID(), projectId: P(1), from: dev.id, to: next.id, commit: `commit:${REPO}@${s.r.second}`, expectedRevision: next.revision }, s.lane);
  const group = async id => { for (let i = 0; i < 100; i++) { const g = s.env.promotionRow(id).processGroup; if (g) return JSON.parse(g); await new Promise(r => setTimeout(r, 50)); } return null; };
  const first = (await create()).promotion.id, recorded = await group(first);
  assert.equal(recorded.step, 'check'); assert.ok(recorded.pgid > 1, 'the running group is recorded on the promotion');
  const started = Date.now();
  await s.op('promotions-cancel', { messageId: randomUUID(), id: first, expectedRevision: s.env.promotion(first).revision, note: '' });
  await s.env.preparing.get(first);
  assert.ok(Date.now() - started < 3000); assert.equal(s.env.promotion(first).state, 'cancelled');
  assert.equal(s.env.promotionRow(first).processGroup, null); assert.ok(await gone(recorded.pgid));
  // Controller shutdown: a bounded wait, then every group is stopped.
  const second = (await create()).promotion.id, g2 = await group(second);
  await s.env.stop(200);
  assert.ok(await gone(g2.pgid)); assert.deepEqual(s.env.promotion(second).readiness, [{ requirementId: 'slow', state: 'unknown' }]);
  assert.match(s.env.promotion(second).log.at(-1).line, /Stopped before the setup checks finished/);
});

test('J8-7: after a restart, a recorded process group is stopped if it is still there, and never signalled from an earlier boot', async t => {
  const s = await setup(t);
  const dev = await s.environment('dev', 0), next = await s.environment('next', 1);
  const leftover = () => { const c = spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' }); c.unref(); t.after(() => { try { c.kill('SIGKILL'); } catch {} }); return c.pid; };
  const boot = Math.round(Date.now() / 1000 - os.uptime());
  const a = await s.promote(dev, next), pgA = leftover();
  s.control.store.db.prepare("UPDATE cc_promotions SET state='running', json=json_set(json,'$.state','running'), processGroup=? WHERE id=?").run(JSON.stringify({ pgid: pgA, owner: captureGroupOwner(pgA), step: 'deploy', bootAt: boot }), a.id);
  const again = () => new Environments(s.control, { resolveRepo: () => s.r.repo, checkoutRoot: path.join(s.dir, 'checkouts'), pumpEveryMs: 0 });
  const e1 = again();
  assert.ok(await gone(pgA), 'the leftover deploy group was stopped');
  const lines = e1.promotion(a.id).log.map(l => l.line);
  assert.ok(lines.includes('Stopped what the interrupted deploy step had left running.'), lines.join(' | '));
  assert.equal(e1.promotion(a.id).state, 'failed'); assert.equal(e1.promotionRow(a.id).processGroup, null);
  // The same group id recorded under an earlier boot is reported, not signalled.
  const pgB = leftover();
  s.control.store.db.prepare('UPDATE cc_promotions SET processGroup=? WHERE id=?').run(JSON.stringify({ pgid: pgB, step: 'check', bootAt: boot - 100000 }), a.id);
  const e2 = again();
  assert.equal(await gone(pgB), false, 'a group from another boot is left alone');
  assert.match(e2.promotion(a.id).log.at(-1).line, /machine has restarted since the setup check ran/); assert.equal(e2.promotionRow(a.id).processGroup, null);
  const pgC = leftover(), owner = captureGroupOwner(pgC);
  s.control.store.db.prepare('UPDATE cc_promotions SET processGroup=? WHERE id=?').run(JSON.stringify({ pgid: pgC, owner: { ...owner, startedAt: 'different lifetime' }, step: 'deploy', bootAt: boot }), a.id);
  const e3 = again();
  assert.equal(await gone(pgC), false, 'an unrelated live group with a reused id is never signalled');
  assert.match(e3.promotion(a.id).log.at(-1).line, /unverified process owner/);
});

test('J8-4: every script comes from the definition\'s approved version; the candidate is only data, and its own scripts never run', async t => {
  const s = await setup(t);
  const withCandidate = { requirements: [{ id: 'ready', label: 'The service answers', check: { kind: 'script', script: 'checks/ready.sh', args: [], timeoutS: 30 } },
    { id: 'candidate', label: 'The new version is readable', check: { kind: 'script', script: 'checks/candidate.sh', args: [], timeoutS: 30 } }] };
  const dev = await s.environment('dev', 0), next = await s.environment('next', 1, withCandidate);
  assert.equal(next.definitionCommit, `commit:${REPO}@${s.r.second}`, 'pinned when proposed, recorded when approved');
  // Probe Q: an agent commits changed check and deploy scripts, then asks for that commit to be promoted.
  const evil = s.r.commit({ CHANGELOG: 'third\n', 'checks/ready.sh': sh(`echo "agent code"; touch "${s.out}/check-from-candidate"; exit 0`),
    'scripts/deploy.sh': sh(`touch "${s.out}/deploy-from-candidate"`), 'scripts/verify.sh': sh(`touch "${s.out}/verify-from-candidate"`) });
  const p = await s.promote(dev, next, evil);
  assert.equal(s.marker('check-from-candidate'), false, 'the candidate\'s check script did not run');
  assert.deepEqual(p.readiness, [{ requirementId: 'ready', state: 'pass' }, { requirementId: 'candidate', state: 'pass' }]);
  const detail = id => s.env.environment(next.id).requirements.find(r => r.id === id).last.detail;
  assert.equal(detail('ready'), 'ready', 'the approved check ran');
  assert.equal(detail('candidate'), 'from $FULCRA_CANDIDATE_DIR', 'the candidate is given by path, and the path is not stored');
  assert.ok(p.log.every(l => !l.line.includes('agent code')));
  await s.ask(p); await s.chooseProven(s.dev, s.control.decisions.packet(s.env.promotion(p.id).decisionId), 'approve'); await s.settle();
  assert.equal(s.env.promotion(p.id).state, 'succeeded');
  assert.equal(fs.readFileSync(path.join(s.out, 'deployed'), 'utf8').trim(), evil, 'the approved deploy script deployed the candidate');
  assert.equal(s.marker('deploy-from-candidate'), false); assert.equal(s.marker('verify-from-candidate'), false);
  // Taking the scripts from a newer version is a change like any other: it is asked, and says so.
  const newer = await s.propose({ ...definition('next', 1), ...withCandidate }, next.id, s.env.environment(next.id).revision);
  const card = s.control.decisions.packet(newer.decisionId);
  assert.match(card.situation, /takes its scripts from a newer version of the repository/);
  assert.ok(card.evidence.some(e => e.ref === `commit:${REPO}@${evil}`));
  assert.equal(s.env.environment(next.id).definitionCommit, `commit:${REPO}@${s.r.second}`, 'the old version stays until approved');
});
