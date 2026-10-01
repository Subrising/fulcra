// DESIGN-NEXT-BUILD A2 (C7): the precedence explicit > role > installation > product, per field, with its source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionDefaults, roleProvider, CAPABILITIES } from './provider-mode.mjs';

const roles = { implementation: { provider: 'claude', claude: { model: 'claude/claude-sonnet-5-5', thinkingOptionId: 'high' } },
  planning: { claude: { model: 'claude/claude-opus-5-5', thinkingOptionId: 'high', modeId: 'plan' } } };
const installation = { defaults: { thinkingOptionId: 'low', models: { claude: 'claude/claude-opus-5' }, modes: { claude: 'acceptEdits' }, roles } };
const pick = d => [d.model, d.thinkingOptionId, d.modeId, d.source.model, d.source.thinkingOptionId, d.source.modeId];

test('role sits between the explicit override and the installation, field by field', () => {
  assert.deepEqual(pick(sessionDefaults('claude', {}, installation, 'implementation')), ['claude/claude-sonnet-5-5', 'high', 'acceptEdits', 'role', 'role', 'installation']);
  assert.deepEqual(pick(sessionDefaults('claude', {}, installation, 'planning')), ['claude/claude-opus-5-5', 'high', 'plan', 'role', 'role', 'role']);
  assert.deepEqual(pick(sessionDefaults('claude', { thinkingOptionId: 'max' }, installation, 'implementation')), ['claude/claude-sonnet-5-5', 'max', 'acceptEdits', 'role', 'override', 'installation']);
  assert.deepEqual(pick(sessionDefaults('claude', { model: 'claude/claude-opus-5-5' }, installation, 'implementation')), ['claude/claude-opus-5-5', 'high', 'acceptEdits', 'override', 'role', 'installation']);
  // A role with no entry for this provider, or no role, is the previous answer exactly.
  const none = sessionDefaults('claude', {}, installation);
  assert.deepEqual({ ...sessionDefaults('claude', {}, installation, 'orchestration'), role: null }, none);
  assert.deepEqual(pick(none), ['claude/claude-opus-5', 'low', 'acceptEdits', 'installation', 'installation', 'installation']);
  assert.deepEqual({ ...sessionDefaults('codex', {}, installation, 'implementation'), role: null }, sessionDefaults('codex', {}, installation));
  assert.equal(sessionDefaults('claude', {}, installation, 'planning').role, 'planning');
  assert.equal(none.role, null);
  assert.deepEqual(pick(sessionDefaults('claude', {}, null, 'implementation')), ['claude', CAPABILITIES.claude.defaultThinkingOptionId, 'auto', 'product-default', 'product-default', 'product-default']);
});

test('an unknown role is refused; roleProvider names the preferred provider or null', () => {
  assert.throws(() => sessionDefaults('claude', {}, installation, 'reviewer'), /Unknown session role reviewer/);
  assert.equal(roleProvider('implementation', installation), 'claude');
  assert.equal(roleProvider('planning', installation), null);
  assert.equal(roleProvider(null, installation), null);
  assert.equal(roleProvider('implementation', { defaults: {} }), null);
  assert.throws(() => roleProvider('reviewer', installation), /Unknown session role/);
});
