// Focused mapping coverage for the supported adapters. The expected values are the pinned runtime's own
// AGENT_PROVIDER_DEFINITIONS, asserted against it directly so this fails if the runtime's modes change.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { guardFreeImport } from './guard-free-import.mjs';
import { portable } from '../portable-config.mjs';
import { runtime as installation } from '../runtime.mjs';
import { sessionDefaults, configuredDefaults, CAPABILITIES, REFUSED, OWNER_APPROVED_UNATTENDED, DEFAULT_THINKING, CODEX_MODE_OPTIONS, SUPPORTED_MODES, selectableModes } from './provider-mode.mjs';

// The adapter these checks read lives OUTSIDE this repository, and reading its real module-private
// MODE_PRESETS is what stops them being vacuous -- so the dependency is the point and is not dropped.
// What was wrong is that four absolute literals, two of them top-level awaits, made the module fail to
// LOAD anywhere else: a raw resolution error that cannot say what was missing or why it mattered.
//
// Resolved from configuration instead, the same shape installation-settings.mjs uses for CONTROLLER_HOME.
const ADAPTER = process.env.ORCA_ADAPTER_ROOT
  ?? new URL('../../node_modules/@getpaseo/server', import.meta.url).pathname;
const DIST = path.join(ADAPTER, 'dist/server/server');
const CODEX_AGENT = path.join(DIST, 'agent/providers/codex-app-server-agent.js');
const present = fs.existsSync(path.join(DIST, 'exports.js')) && fs.existsSync(CODEX_AGENT);
// A skip, not a failure: without the adapter the claim is UNVERIFIABLE, not false, and failing would make
// this repository's suite unrunnable for exactly the portable audience GOAL.md names. But it is named, so
// coverage cannot quietly evaporate the way a pinned guard's false negatives did.
const SKIP = present ? false
  : `provider adapter not found at ${ADAPTER}. The mapping between this selector and the adapter's own `
    + 'AGENT_PROVIDER_DEFINITIONS and MODE_PRESETS is NOT verified in this run. Set ORCA_ADAPTER_ROOT to a '
    + '@getpaseo/server package to verify it.';
if (SKIP) console.error(`\n[provider-mode] ${SKIP}\n`);

// H6 item 4: never import exports.js. In an installed build it reaches the patched session.js, whose admission guard
// writes a receipt into the LIVE controller home when it loads (H5-CANDIDATE-REPORT s0). The definitions exports.js
// re-exports come from @getpaseo/protocol, resolved from the adapter itself, and every installed module is imported
// only through guardFreeImport, which refuses anything whose import graph reaches an admission guard.
const adapterModule = present ? await guardFreeImport(path.join(DIST, 'agent/providers/omp/map-omp-model.js')) : null;
const definitions = present ? (await guardFreeImport(createRequire(path.join(ADAPTER, 'package.json')).resolve('@getpaseo/protocol/provider-manifest'))).AGENT_PROVIDER_DEFINITIONS : [];
const definition = id => definitions.find(d => d.id === id);
const codexSource = () => fs.readFileSync(CODEX_AGENT, 'utf8');

// The check that stops the skip becoming the silent degradation it is meant to prevent: if this
// installation HAS its runtime tree, the adapter must have been found in it. A broken path derivation
// would otherwise skip everything and report green.
test('an installation that has a runtime tree must find the adapter in it', () => {
  if (portable || process.env.ORCA_ADAPTER_ROOT || !fs.existsSync(installation.installation)) return;
  assert.ok(present, `${installation.installation} exists but no adapter was found at ${ADAPTER}; the mapping checks would skip and this suite would report green without verifying anything.`);
});

test('the selector maps each adapter onto a mode that adapter actually supports', { skip: SKIP }, () => {
  for (const [provider, capability] of Object.entries(CAPABILITIES)) {
    const modes = definition(provider).modes.map(m => m.id);
    assert(modes.includes(capability.automaticModeId), `${provider} does not support ${capability.automaticModeId}`);
    const chosen = sessionDefaults(provider, {}, null);
    assert.equal(chosen.modeId, capability.automaticModeId);
    assert.equal(chosen.automatic, true);
    // Per provider now, not one universal value: a single 'high' made every claude session pay for and
    // think like a hard task. The adapter check below is what keeps each value real rather than a literal.
    assert.equal(chosen.thinkingOptionId, capability.defaultThinkingOptionId);
    assert.equal(chosen.source.modeId, 'product-default');
    // Whatever is chosen must never be a mode the runtime itself marks unattended -- unless the owner approved it
    // by name (update-7 W3: Codex full-access).
    if (!OWNER_APPROVED_UNATTENDED[provider].includes(chosen.modeId)) assert.notEqual(definition(provider).modes.find(m => m.id === chosen.modeId).isUnattended, true);
  }
  // Claude's automatic mode is the classifier one, by its own description, not a bypass.
  assert.equal(CAPABILITIES.claude.automaticModeId, 'auto');
  assert.match(definition('claude').modes.find(m => m.id === 'auto').description, /classifier/i);
  // Codex has no classifier mode at all. The owner's instruction (update-7 W3, 01:29Z) is full-access by default.
  assert.equal(definition('codex').modes.some(m => /classifier/i.test(m.description)), false);
  assert.equal(CAPABILITIES.codex.automaticModeId, 'full-access');
  // The owner's stated default: a session comes up Medium and asks for High when a task needs it. Pinned
  // here because it is a deliberate cost and behaviour decision, not an incidental constant -- if someone
  // changes it back, this test is where they have to say so.
  assert.equal(CAPABILITIES.claude.defaultThinkingOptionId, 'medium');
  // codex is deliberately NOT aligned: its effort scale is its own and nothing here measured it.
  assert.equal(CAPABILITIES.codex.defaultThinkingOptionId, 'high');
  assert.equal(DEFAULT_THINKING, 'high', 'the fallback for a provider that names no default of its own');
  // Every default, and the fallback, must be an effort the runtime actually offers.
  const efforts = adapterModule.OMP_THINKING_OPTIONS.map(o => o.id ?? o);
  for (const [provider, capability] of Object.entries(CAPABILITIES))
    assert(efforts.includes(capability.defaultThinkingOptionId), `${provider} default effort ${capability.defaultThinkingOptionId} is not one the runtime offers`);
  assert(efforts.includes(DEFAULT_THINKING));
});

test('every mode the runtime flags unattended is refused, not only the ones we listed', { skip: SKIP }, () => {
  // N1-def: the denylist must be maintained by this test rather than by memory. Asserting only that each
  // refused mode IS unattended leaves a new unattended mode selectable through config or an override.
  for (const provider of Object.keys(CAPABILITIES)) {
    const unattended = definition(provider).modes.filter(m => m.isUnattended === true).map(m => m.id);
    // Update-7 W3: minus the modes the owner approved by name, each of which must really be unattended.
    assert.deepEqual([...unattended].sort(), [...REFUSED[provider], ...OWNER_APPROVED_UNATTENDED[provider]].sort(), `${provider}: REFUSED + owner-approved must equal the runtime's unattended set`);
    // And the mode we actually choose is not among them, unless owner-approved.
    if (!OWNER_APPROVED_UNATTENDED[provider].includes(CAPABILITIES[provider].automaticModeId)) assert.equal(unattended.includes(CAPABILITIES[provider].automaticModeId), false);
    assert.equal(REFUSED[provider].some(m => OWNER_APPROVED_UNATTENDED[provider].includes(m)), false);
    // Moved here from the refusal test, which is otherwise adapter-free: implied by the equality above.
    for (const modeId of REFUSED[provider]) assert.equal(definition(provider).modes.find(m => m.id === modeId).isUnattended, true, `${provider}/${modeId}`);
  }
});

test('the codex sandbox and approval pins are the adapter\u2019s own, not our prose', { skip: SKIP }, () => {
  // N2-def: shown, not argued. The adapter's MODE_PRESETS is module-private, so read it from the adapter
  // source. Extracting it here means a change in the adapter fails this test instead of drifting silently.
  const source = codexSource();
  const table = source.slice(source.indexOf('const MODE_PRESETS = {'));
  const preset = id => {
    // The adapter quotes only keys that need it, so accept both forms.
    const at = [`"${id}": {`, `${id}: {`].map(k => table.indexOf(k)).filter(i => i !== -1).sort((a, b) => a - b)[0] ?? -1;
    assert.notEqual(at, -1, `adapter has no preset for ${id}`);
    const body = table.slice(at, table.indexOf('}', at));
    return { approval_policy: /approvalPolicy: "([^"]+)"/.exec(body)[1], sandbox_mode: /sandbox: "([^"]+)"/.exec(body)[1] };
  };
  for (const [modeId, options] of Object.entries(CODEX_MODE_OPTIONS)) assert.deepEqual(options, preset(modeId), modeId);
  // The chosen mode pins exactly what the dropped explicit options used to pin.
  const chosen = sessionDefaults('codex', {}, null);
  assert.deepEqual(chosen.options, preset('full-access'));
  // A deliberate override still emits pins consistent with the mode it selected, never a stale hardcode.
  // Uses a SELECTABLE mode: read-only is a preset key the provider does not offer as a mode, and the loop
  // above already asserts its pins are copied faithfully, which is a separate question from selectability.
  assert.deepEqual(sessionDefaults('codex', { modeId: 'auto' }, null).options, preset('auto'));
  // Claude emits none: the old ask Write/Edit pin was the opposite of automatic approval.
  assert.equal(sessionDefaults('claude', {}, null).options, undefined);
});

test('the codex auto-reviewer survives our explicit pins, and that is not an accident', { skip: SKIP }, () => {
  // The adapter PREFERS explicit providerOptions over the preset, and auto-review carries a THIRD key the
  // pins do not emit. Had approvalsReviewer flowed through the same merged options, emitting two of three
  // would have silently demoted auto-review to plain auto -- the two it does emit are identical between
  // those modes, so nothing would have looked wrong. It is safe only because the reviewer is applied from
  // the preset on its own code path, so lock that rather than trusting it.
  const source = codexSource();
  const table = source.slice(source.indexOf('const MODE_PRESETS = {'));
  const body = table.slice(table.indexOf('"auto-review": {'), table.indexOf('}', table.indexOf('"auto-review": {')));
  assert.match(body, /approvalsReviewer: "auto_review"/, 'auto-review must still carry its reviewer in the preset');
  // We deliberately do not emit it: it is not a provider option and must come from the preset.
  assert.equal(Object.hasOwn(CODEX_MODE_OPTIONS['auto-review'], 'approvalsReviewer'), false);
  // And the adapter must still apply it from the preset rather than from providerOptions.
  assert.match(source, /function applyApprovalsReviewerParam\(params, preset\) \{\s*if \(preset\.approvalsReviewer\)/,
    'the reviewer must still be applied from the preset, independently of providerOptions');
  // The two keys we do emit are the two the adapter lets providerOptions override.
  assert.match(source, /providerOptions\.sandbox_mode \?\?/);
  assert.match(source, /this\.providerOptions\.approval_policy === undefined/);
});

test('modes that broaden access are refused rather than relabelled as automatic', () => {
  // Both refused modes are exactly the ones the runtime marks dangerous and unattended.
  for (const [provider, refused] of Object.entries(REFUSED)) {
    for (const modeId of refused) {
      assert.throws(() => sessionDefaults(provider, { modeId }, null), /broadens access rather than automating approval/);
      assert.throws(() => configuredDefaults({ defaults: { modes: { [provider]: modeId } } }), /broadens access/);
    }
  }
  assert.throws(() => sessionDefaults('gemini', {}, null), /No automatic mode is known/);
});

test('a deliberate choice wins, an installation default sits under it, and both are reported', () => {
  const override = sessionDefaults('claude', { modeId: 'plan', thinkingOptionId: 'low' }, null);
  assert.equal(override.modeId, 'plan'); assert.equal(override.thinkingOptionId, 'low');
  assert.equal(override.automatic, false);
  assert.deepEqual(override.source, { modeId: 'override', thinkingOptionId: 'override', ask: 'product-default', model: 'product-default' });

  const installation = { defaults: { thinkingOptionId: 'max', modes: { codex: 'auto' } } };
  const codex = sessionDefaults('codex', {}, installation);
  assert.equal(codex.modeId, 'auto'); assert.equal(codex.thinkingOptionId, 'max');
  assert.deepEqual(codex.source, { modeId: 'installation', thinkingOptionId: 'installation', ask: 'product-default', model: 'product-default' });
  // An override still beats the installation default.
  assert.equal(sessionDefaults('codex', { modeId: 'auto-review' }, installation).source.modeId, 'override');
  // An installation that sets nothing keeps the product defaults.
  assert.deepEqual(configuredDefaults({}), {});
  assert.equal(sessionDefaults('claude', {}, {}).modeId, 'auto');
  for (const bad of [{ defaults: { thinkingOptionId: 'turbo' } }, { defaults: { modes: { gemini: 'auto' } } }, { defaults: [] }])
    assert.throws(() => configuredDefaults(bad));
  // L44: a default from a newer build is ignored (kept in the file), not refused.
  assert.deepEqual(configuredDefaults({ defaults: { unknown: 1, thinkingOptionId: 'max' } }).thinkingOptionId, 'max');
});

// Not hypothetical: before this, configuredDefaults validated `modes` with Object.entries (own properties)
// while sessionDefaults read configured.modes?.[provider] through the prototype chain, so a polluted
// Object.prototype supplied a mode validation never saw and REFUSED was bypassed -- sessionDefaults
// returned modeId 'bypassPermissions' with source 'installation'.
test('a polluted prototype cannot supply a value that validation never saw', t => {
  t.after(() => { for (const k of ['claude', 'codex', 'thinkingOptionId']) delete Object.prototype[k]; });
  Object.prototype.claude = 'bypassPermissions';
  Object.prototype.codex = 'auto';
  Object.prototype.thinkingOptionId = 'off';
  for (const [provider, mode] of [['claude', 'auto'], ['codex', 'full-access']]) {
    const chosen = sessionDefaults(provider, {}, { defaults: { modes: {}, ask: {} } });
    assert.equal(chosen.modeId, mode);
    assert.equal(chosen.source.modeId, 'product-default');
    assert.equal(chosen.thinkingOptionId, CAPABILITIES[provider].defaultThinkingOptionId);
    assert.equal(chosen.source.thinkingOptionId, 'product-default');
    assert.equal(chosen.ask, null);
    assert.equal(chosen.source.ask, 'product-default');
  }
});

// Exercises the post-resolution refusal for its own reason. A getter is not reachable from a JSON file --
// JSON.parse only makes data properties -- so this demonstrates the class the guard exists for: any source
// that is validated once and read again can disagree with itself between the two.
test('a mode that changes between validation and use is still refused', () => {
  let reads = 0;
  const modes = { get claude() { return reads++ === 0 ? 'auto' : 'bypassPermissions'; } };
  assert.throws(() => sessionDefaults('claude', {}, { defaults: { modes } }),
    /Refused mode for claude: bypassPermissions broadens access/);
});

// Raw indexes into the mode and capability tables: CODEX_MODE_OPTIONS['__proto__'] is Object.prototype and
// ['constructor'] is the Object constructor FUNCTION, both truthy, so the "no pins are known" refusal never
// fired and a codex session spawned with no sandbox_mode or approval_policy -- silently, because
// JSON.stringify drops a function. 'prototype' was unaffected, which is exactly why the fix validates
// against the known modes instead of rejecting inherited names.
test('a prototype-named mode or provider is refused like any other unknown one', () => {
  for (const modeId of ['__proto__', 'constructor', 'prototype', 'nonsense']) {
    // Both surfaces: an operator override and an installation settings file.
    // Now refused a step earlier, by the allowlist, with a message naming what IS selectable.
    assert.throws(() => sessionDefaults('codex', { modeId }, null), /Unsupported mode for codex/, modeId);
    assert.throws(() => sessionDefaults('codex', {}, { defaults: { modes: { codex: modeId } } }), /Unsupported mode for codex/, modeId);
  }
  for (const provider of ['__proto__', 'constructor', 'prototype', 'gemini']) {
    assert.throws(() => sessionDefaults(provider, {}, null), /No automatic mode is known for provider/, provider);
  }
  // The guarantee that was being discarded: a codex config always carries its own pins, as a real object.
  const codex = sessionDefaults('codex', {}, null);
  assert.equal(typeof codex.options, 'object');
  assert.equal(Object.getPrototypeOf(codex.options), Object.prototype);
  assert.equal(codex.options.sandbox_mode, 'danger-full-access');
  assert.equal(codex.options.approval_policy, 'never');
});

// GOAL.md forbids inventing unsupported modes. REFUSED is a denylist and could not enforce that: codex was
// saved only incidentally, by an unknown mode having no pins to look up, while claude emits no options and
// so accepted anything -- `autoo` in a settings file was handed to session creation as a mode.
test('an invented mode is refused wherever it comes from, and the message says what is selectable', () => {
  for (const provider of Object.keys(CAPABILITIES)) {
    for (const bad of ['totally-made-up', 'autoo', 'AUTO', 'Auto']) {
      const expected = new RegExp(`Unsupported mode for ${provider}`);
      assert.throws(() => sessionDefaults(provider, { modeId: bad }, null), expected, `override ${provider}/${bad}`);
      assert.throws(() => sessionDefaults(provider, {}, { defaults: { modes: { [provider]: bad } } }), expected, `config ${provider}/${bad}`);
    }
    // An empty mode is malformed rather than invented, and the config surface says so first.
    assert.throws(() => sessionDefaults(provider, { modeId: '' }, null), /Unsupported mode for/);
    assert.throws(() => sessionDefaults(provider, {}, { defaults: { modes: { [provider]: '' } } }), /Invalid mode in/);
    // A refused-but-real mode keeps its own explanation rather than being called unsupported.
    for (const refused of REFUSED[provider]) {
      assert.throws(() => sessionDefaults(provider, { modeId: refused }, null), /broadens access rather than automating approval/);
    }
    // Every selectable mode is still selectable -- the allowlist must not have narrowed the product.
    for (const good of selectableModes(provider)) {
      assert.equal(sessionDefaults(provider, { modeId: good }, null).modeId, good);
    }
  }
});

test('the supported mode table is the adapter\'s own list, not our memory', { skip: SKIP }, () => {
  // Claude's table is a copy and must equal the adapter's definitions exactly.
  assert.deepEqual([...SUPPORTED_MODES.claude].sort(), definition('claude').modes.map(m => m.id).sort(),
    "claude: SUPPORTED_MODES must equal the adapter's own mode ids");
  // Codex is the intersection: a mode the provider accepts AND one we hold sendable pins for. The previous
  // version asserted the discrepancy itself, which froze it -- adding a read-only definition entry, i.e.
  // FIXING the product, would have turned this red as though something had broken. Asserting the
  // intersection instead fails whenever either adapter source moves, which is a prompt to review the
  // literal rather than a claim that today's disagreement is correct.
  const codexDefined = definition('codex').modes.map(m => m.id);
  assert.deepEqual(SUPPORTED_MODES.codex, codexDefined.filter(m => Object.hasOwn(CODEX_MODE_OPTIONS, m)),
    'codex: SUPPORTED_MODES must equal the adapter definitions intersected with the pins we hold');
  // Recorded, not asserted: read-only is a preset key with no definition entry. If that ever changes the
  // intersection above grows and this list must grow with it.
  assert.equal(codexDefined.includes('read-only'), false, 'read-only gained a definition entry; widen SUPPORTED_MODES.codex');
  for (const provider of Object.keys(CAPABILITIES)) {
    assert.deepEqual(selectableModes(provider), SUPPORTED_MODES[provider].filter(m => !REFUSED[provider].includes(m)));
    assert.ok(selectableModes(provider).includes(CAPABILITIES[provider].automaticModeId));
  }
});

// The defect these cover, stated as it was measured: every session the controller created came up on
// claude-opus-5 while the host advertised claude-opus-5-5 as its default, because the creation path chose
// the model from a hardcoded 'claude/claude-opus-5' literal instead of asking for one here. The literal is
// an explicit pin, and resolveProviderModel (provider-model.mjs:4) returns an explicit pin verbatim --
// so the host's isDefault was not overridden, it was never read.
test('the claude product default follows the host rather than naming a release', () => {
  const chosen = sessionDefaults('claude', {}, null);
  assert.equal(chosen.model, 'claude', 'a bare family is what makes resolveProviderModel read the host inventory');
  assert.equal(chosen.modelFollowsProviderDefault, true);
  assert.equal(chosen.source.model, 'product-default');
  // Not a bare family, and deliberately so: this controller has not verified that codex advertises a
  // unique default, and resolveProviderModel throws when it does not.
  const codex = sessionDefaults('codex', {}, null);
  assert.equal(codex.model, 'codex/gpt-6-astra');
  assert.equal(codex.modelFollowsProviderDefault, false);
});

test('an installation or a caller may pin a model, and the pin is reported as theirs', () => {
  const installation = { defaults: { models: { claude: 'claude/claude-opus-5-5' } } };
  const pinned = sessionDefaults('claude', {}, installation);
  assert.equal(pinned.model, 'claude/claude-opus-5-5');
  assert.equal(pinned.modelFollowsProviderDefault, false);
  assert.equal(pinned.source.model, 'installation');
  // An override beats the installation, the same way it does for mode and thinking.
  const override = sessionDefaults('claude', { model: 'claude/claude-fable-5-1' }, installation);
  assert.equal(override.model, 'claude/claude-fable-5-1');
  assert.equal(override.source.model, 'override');
  // An installation may also ask codex to follow its host, which is the asymmetry being opt-in.
  assert.equal(sessionDefaults('codex', {}, { defaults: { models: { codex: 'codex' } } }).modelFollowsProviderDefault, true);
});

test('a model selection that is not one is refused wherever it comes from', () => {
  for (const bad of [
    { defaults: { models: { claude: 'codex/gpt-6-astra' } } },   // another provider's family
    { defaults: { models: { gemini: 'gemini/pro' } } },          // a provider this controller has no capability for
    { defaults: { models: { claude: 'claude/../../etc/passwd' } } }, // path structure in a value that reaches an exec line
    { defaults: { models: { claude: '' } } },
    { defaults: { models: { claude: 5 } } },
    { defaults: { models: [] } },
  ]) assert.throws(() => configuredDefaults(bad), undefined, `accepted ${JSON.stringify(bad)}`);
  assert.throws(() => sessionDefaults('claude', { model: 'claude/a b' }, null), /Invalid model selection in the per-spawn override/);
  assert.throws(() => sessionDefaults('claude', { model: 'codex/gpt-6-astra' }, null), /must name the claude family/);
});

// Same fault the mode and ask reads were fixed for: a raw index reads through the prototype chain, so a
// polluted Object.prototype would supply a model no validator ever saw to a path that execs it.
test('a prototype-supplied model cannot reach the creation path', t => {
  t.after(() => { delete Object.prototype.claude; });
  Object.prototype.claude = 'claude/../../evil';
  const chosen = sessionDefaults('claude', {}, { defaults: { models: {} } });
  assert.equal(chosen.model, 'claude');
  assert.equal(chosen.source.model, 'product-default');
});
