// DESIGN-NEXT-BUILD A4 / prime Q3 (C10): role defaults are visible where an operator looks. session-defaults reports,
// per configured role, what a creation would launch and whether the installed provider offers it; the delivered
// creation records the model it got; a seated orchestrator whose model or effort differs from the orchestration default
// is an Inbox attention item (information only: nothing is switched).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, P } from './decisions.fixture.mjs';
import { rpc } from './rpc.mjs';
import { portable } from '../portable-config.mjs';
import { requireUnpinnedAdmissionGuard } from './admission-guard-precondition.mjs';
requireUnpinnedAdmissionGuard();

const configFile = path.join(portable.home, 'config.json'), original = fs.readFileSync(configFile, 'utf8');
const roles = (t, value) => { t.after(() => fs.writeFileSync(configFile, original, { mode: 0o600 })); const c = JSON.parse(original); c.defaults = { ...c.defaults, ...(value ? { roles: value } : {}) }; fs.writeFileSync(configFile, JSON.stringify(c, null, 2), { mode: 0o600 }); };
const DAVID = { planning: { claude: { model: 'claude/claude-opus-5-5', thinkingOptionId: 'high' } }, orchestration: { claude: { model: 'claude/claude-opus-5-5', thinkingOptionId: 'medium' } },
  implementation: { provider: 'claude', claude: { model: 'claude/claude-sonnet-5-5', thinkingOptionId: 'high' } } };

test('session-defaults reports each configured role: configured, effective and whether it is offered', async t => {
  roles(t, DAVID);
  const f = await fixture(t);
  f.control.native.roleCapability = async (provider, role) => ({
    configured: { model: DAVID[role][provider].model, thinkingOptionId: DAVID[role][provider].thinkingOptionId },
    effective: role === 'implementation' ? { model: 'claude', thinkingOptionId: 'high' } : { model: DAVID[role][provider].model, thinkingOptionId: DAVID[role][provider].thinkingOptionId },
    fallback: role === 'implementation' ? [{ field: 'model', requested: 'claude/claude-sonnet-5-5', used: 'claude', reason: 'model-not-offered' }] : [] });
  const d = await f.op('session-defaults', null);
  assert.deepEqual(Object.keys(d.roles), ['planning', 'orchestration', 'implementation']);
  assert.equal(d.roles.planning.providers.claude.status, 'offered');
  assert.equal(d.roles.implementation.providers.claude.status, 'falls-back'); assert.equal(d.roles.implementation.provider, 'claude');
  assert.equal(d.roles.implementation.providers.claude.fallback[0].reason, 'model-not-offered');
  delete f.control.native.roleCapability;
  assert.equal((await f.op('session-defaults', null)).roles.planning.providers.claude.status, 'unknown');
});

test('without roles, session-defaults reports none, and the Inbox has no orchestration item', async t => {
  roles(t, null);
  const f = await fixture(t);
  assert.deepEqual((await f.op('session-defaults', null)).roles, {});
  assert.equal((await f.op('decisions-inbox', null)).items.some(i => i.key.startsWith('attention-orchestration')), false);
});

test('a seated orchestrator whose recorded model or effort differs from the orchestration default is shown once; a matching one is not', async t => {
  roles(t, DAVID);
  const f = await fixture(t);
  const seats = f.store.db.prepare("SELECT role,seat,session FROM role_bindings WHERE state='assigned' AND role IN ('prime','project-orchestrator') ORDER BY role,seat").all();
  const recorded = (session, model, effort) => f.store.db.prepare("INSERT INTO deliveries VALUES (?,NULL,'create','{}','delivered',?)").run(randomUUID(), JSON.stringify({ id: session, cwd: '/x', mode: { thinkingOptionId: effort }, model }));
  const project = seats.find(s => s.role === 'project-orchestrator'), primes = seats.filter(s => s.role === 'prime');
  recorded(project.session, 'claude/claude-sonnet-5-5', 'high');          // differs: shown
  recorded(primes[0].session, 'claude/claude-opus-5-5', 'medium');        // matches: not shown
  const items = (await f.op('decisions-inbox', null)).items.filter(i => i.key.startsWith('attention-orchestration'));
  assert.equal(items.length, 1);
  assert.equal(items[0].ref, `project:${P(1)}`); assert.equal(items[0].urgency, 'fyi');
  assert.match(items[0].summary, /runs claude-sonnet-5-5 at high effort; the orchestration default is claude-opus-5-5 at medium effort\. Nothing is changed automatically\./);
});
