// Test-only fixture for Fulcra J8 Environments: a temporary git repository with fake scripts, J3's real decision
// store (decisions.fixture.mjs) with a paired test device, and helpers for the approval flow. Shared by
// environments.test.mjs and the plugin's environments contract test. Never touches a host; not imported by any
// production module.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fixture, P } from './decisions.fixture.mjs';
import { Environments } from './environments.mjs';
import { EnvironmentRefused } from '../../orca-organization/shared/cc/environment-rules.mjs';

export const REPO = 'github:acme/tally';
export const sh = body => `#!/bin/sh\n${body}\n`;
// A repository whose scripts write markers into `out` (outside the checkout, which is deleted), so a test can see
// what ran. verify.sh exits with its first argument, so a definition decides whether verify passes.
function repository(dir, out, { extra = {} } = {}) {
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(repo, 'checks'), { recursive: true });
  const files = {
    'scripts/deploy.sh': sh(`echo "deploying $FULCRA_ENVIRONMENT"; echo "$FULCRA_COMMIT" > "${out}/deployed"`),
    'scripts/verify.sh': sh(`echo "checking"; echo verify >> "${out}/verified"; exit "$1"`),
    'scripts/rollback.sh': sh(`echo "putting the old version back"; echo rollback > "${out}/rolled-back"`),
    'scripts/env.sh': sh(`env | sort`),
    'checks/ready.sh': sh('echo ready; exit 0'), 'checks/broken.sh': sh('echo "not ready"; exit 1'),
    'scripts/not-executable.sh': sh('echo never'),
    // J8-2: a script that leaves a child holding its output open, one that exits and leaves a child, a slow check.
    'scripts/linger.sh': sh('sleep 30 &\necho "child $!"\nsleep 60'), 'scripts/leave.sh': sh('sleep 30 &\necho "child $!"\nexit 0'),
    'checks/slow.sh': sh('sleep 30 &\necho "child $!"\nsleep 60'),
    // J8-4: the candidate is data, at $FULCRA_CANDIDATE_DIR.
    'checks/candidate.sh': sh('echo "candidate says $(cat "$FULCRA_CANDIDATE_DIR/CHANGELOG")"; echo "from $FULCRA_CANDIDATE_DIR"'), ...extra,
  };
  for (const [name, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true }); fs.writeFileSync(path.join(repo, name), body, { mode: name.includes('not-executable') ? 0o644 : 0o755 }); }
  fs.symlinkSync('/etc/hosts', path.join(repo, 'scripts', 'outside.sh'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: { PATH: '/usr/bin:/bin', HOME: repo, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8' }).trim();
  git('init', '-q'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', '-A');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'first');
  const first = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'CHANGELOG'), 'second\n');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', '-A'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'second');
  // A later commit, as an agent would make one: files are written (scripts executable) and committed; returns its id.
  const commit = changes => {
    for (const [name, body] of Object.entries(changes)) fs.writeFileSync(path.join(repo, name), body, { mode: 0o755 });
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', '-A'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'later');
    return git('rev-parse', 'HEAD');
  };
  return { repo, first, second: git('rev-parse', 'HEAD'), commit };
}
export const step = (script, args = [], extra = {}) => ({ script, args, timeoutS: 30, destructive: false, ...extra });
export const definition = (key, order, extra = {}) => ({ key, label: key === 'next' ? 'Next' : key === 'prod' ? 'Live' : 'Dev', order, target: { kind: 'fulcra-host', hostId: 'test-host' }, repo: REPO,
  requirements: [{ id: 'ready', label: 'The service answers', check: { kind: 'script', script: 'checks/ready.sh', args: [], timeoutS: 30 } }],
  steps: { deploy: step('scripts/deploy.sh'), verify: step('scripts/verify.sh', ['0']), rollback: step('scripts/rollback.sh') }, state: 'active', ...extra });

export async function setup(t) {
  const f = await fixture(t);
  const out = path.join(f.dir, 'out'); fs.mkdirSync(out);
  const r = repository(f.dir, out);
  const env = new Environments(f.control, { resolveRepo: key => { if (key !== REPO) throw new EnvironmentRefused('No local copy'); return r.repo; }, checkoutRoot: path.join(f.dir, 'checkouts'), pumpEveryMs: 0 });
  f.control.environments = env;
  const lane = { kind: 'role', capability: f.caps.project };
  const propose = (def, environmentId = null, expectedRevision = 0) => env.propose({ sessionId: f.project, messageId: randomUUID(), projectId: P(1), environmentId, expectedRevision, definition: def, note: '' }, lane);
  const dev = await f.pairFirst();
  // Approve a pending definition with a proven owner answer, then let the watcher apply it.
  const approveDefinition = async result => { await f.chooseProven(dev, f.control.decisions.packet(result.decisionId), 'approve'); await env.tick(); return env.envRow(result.environmentId); };
  const environment = async (key, order, extra) => { const r0 = await propose(definition(key, order, extra)); await approveDefinition(r0); return env.environment(r0.environmentId); };
  const promote = async (from, to, sha = r.second) => {
    const created = await env.promotionCreate({ sessionId: f.project, messageId: randomUUID(), projectId: P(1), from: from.id, to: to.id, commit: `commit:${REPO}@${sha}`, expectedRevision: to.revision }, lane);
    await env.preparing.get(created.promotion.id);
    return env.promotion(created.promotion.id);
  };
  const ask = p => env.promotionAsk({ sessionId: f.project, messageId: randomUUID(), promotionId: p.id }, lane);
  const settle = async () => { await env.tick(); await Promise.all(env.running.values()); };
  return { ...f, env, out, r, lane, propose, dev, approveDefinition, environment, promote, ask, settle, marker: name => fs.existsSync(path.join(out, name)) };
}

