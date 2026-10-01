import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOrchestration, ORCHESTRATION_NOTE } from './orchestration';

const req = (role: string | null, provider = 'claude', extra: Record<string, unknown> = {}) => ({ config: { provider, systemPrompt: 'You are an independent Orca session.', ...extra }, labels: (role ? { 'fulcra.role': role } : {}) as Record<string, string> });
test('update-7: a lead role gets the orchestration instruction appended once; workers and unlabelled sessions are untouched', () => {
  for (const role of ['orchestration', 'planning', 'review']) {
    const out = applyOrchestration(req(role), false);
    assert.equal(out.config.systemPrompt, `You are an independent Orca session.\n\n${ORCHESTRATION_NOTE}`);
    assert.equal(applyOrchestration(out as any, false).config.systemPrompt, out.config.systemPrompt, 'appended once');
    assert.equal((out.config as any).providerOptions, undefined, 'no guard: tools unchanged');
  }
  for (const role of ['implementation', 'research', null]) assert.deepEqual(applyOrchestration(req(role), true), req(role));
  assert.match(ORCHESTRATION_NOTE, /paseo run/); assert.match(ORCHESTRATION_NOTE, /never as an Agent-tool subagent/);
});
test('update-7: the guard removes the subagent tools from a Claude lead (keeping its own disallowed tools); Codex gets the instruction only', () => {
  const out = applyOrchestration(req('orchestration', 'claude', { providerOptions: { disallowedTools: ['WebFetch'], allowedTools: ['Read'] } }), true);
  assert.deepEqual((out.config as any).providerOptions, { disallowedTools: ['WebFetch', 'Task', 'Agent'], allowedTools: ['Read'] });
  const codex = applyOrchestration(req('review', 'codex'), true);
  assert.equal((codex.config as any).providerOptions, undefined); assert.match(codex.config.systemPrompt!, /Fulcra orchestration:/);
  const bare = applyOrchestration({ config: { provider: 'claude' }, labels: { 'fulcra.role': 'planning' } }, false);
  assert.equal((bare.config as { systemPrompt?: string }).systemPrompt, ORCHESTRATION_NOTE);
});
