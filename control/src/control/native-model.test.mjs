// What model a session the controller creates actually comes up on, asserted by RUNNING the decision
// rather than by reading the file it lives in.
//
// The gap this closes was demonstrated: session-config.test.mjs guards inline pins with a regex over file
// text, and a re-pin written as ['claude','claude-opus-5'].join('/') passed the whole suite while putting
// every created session back on the previous Opus release. A text guard cannot see through a join. These
// run the selector, run the creation path's own selection, and follow the answer through a fake provider
// inventory to the model id a session would be created with.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionDefaults } from './provider-mode.mjs';
import { resolveProviderModel } from './provider-model.mjs';
import { creationModel } from './native.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// A host that advertises what the live Mini host advertises: several claude models, exactly one of them
// marked isDefault, and it is not the one the old literal named.
const HOST_INVENTORY = {
  provider: 'claude',
  models: [
    { provider: 'claude', id: 'claude-opus-5', label: 'Opus 5' },
    { provider: 'claude', id: 'claude-opus-5-5', label: 'Opus 5.5', isDefault: true },
    { provider: 'claude', id: 'claude-fable-5-1', label: 'Fable 5.1' },
  ],
};
const hostClient = (inventory = HOST_INVENTORY) => ({
  providers: { listModels: async () => inventory },
});

test('a session the controller creates comes up on the model the host advertises as its default', async () => {
  // Start where creation starts -- no installation settings, no caller override, not portable.
  const chosen = sessionDefaults('claude', {}, null);
  const selection = creationModel('claude', chosen, null);
  assert.equal(selection, 'claude', 'creation must hand resolveProviderModel a bare family, not a pin');
  assert.equal(
    await resolveProviderModel(hostClient(), selection, '/owned'),
    'claude/claude-opus-5-5',
    'the created session must get the host’s isDefault model, not a release named in this repository',
  );
});

test('the host moving its default moves the session, with no change here', async () => {
  // The whole reason for a bare family: nothing in this repository names a release, so when the host
  // advertises a different default the next session follows it.
  const moved = {
    provider: 'claude',
    models: [
      { provider: 'claude', id: 'claude-opus-5-5', label: 'Opus 5.5' },
      { provider: 'claude', id: 'claude-opus-6', label: 'Opus 6', isDefault: true },
    ],
  };
  const selection = creationModel('claude', sessionDefaults('claude', {}, null), null);
  assert.equal(await resolveProviderModel(hostClient(moved), selection, '/owned'), 'claude/claude-opus-6');
});

test('an installation setting and a per-spawn override reach the created session verbatim', async () => {
  const installation = { defaults: { models: { claude: 'claude/claude-fable-5-1' } } };
  const pinned = creationModel('claude', sessionDefaults('claude', {}, installation), null);
  assert.equal(await resolveProviderModel(hostClient(), pinned, '/owned'), 'claude/claude-fable-5-1');

  const override = creationModel('claude', sessionDefaults('claude', { model: 'claude/claude-opus-5' }, installation), null);
  assert.equal(await resolveProviderModel(hostClient(), override, '/owned'), 'claude/claude-opus-5');

  // codex keeps its explicit pin, so its created sessions do not depend on the inventory at all.
  const codex = creationModel('codex', sessionDefaults('codex', {}, null), null);
  assert.equal(await resolveProviderModel({}, codex, '/owned'), 'codex/gpt-6-astra');
});

test('a portable installation still decides its own model over installation defaults; role and explicit choices win', async () => {
  // Portable `providers` is mandatory and predates session defaults, so it still wins over the installation's
  // `defaults.models` -- unchanged. DESIGN-NEXT-BUILD A2 (approved): a deliberate per-spawn model and a role default are
  // selections for THIS session and now win over the pin; before, both were silently ignored on a portable install.
  const portableConfig = { providers: { claude: 'claude/claude-opus-5', codex: 'codex/gpt-6-astra' } };
  const installation = { defaults: { models: { claude: 'claude/claude-fable-5-1' } } };
  assert.equal(creationModel('claude', sessionDefaults('claude', {}, installation), portableConfig), 'claude/claude-opus-5');
  const chosen = sessionDefaults('claude', { model: 'claude/claude-fable-5-1' }, null);
  assert.equal(creationModel('claude', chosen, portableConfig), 'claude/claude-fable-5-1');
  const role = sessionDefaults('claude', {}, { defaults: { roles: { implementation: { claude: { model: 'claude/claude-sonnet-5-5' } } } } }, 'implementation');
  assert.equal(creationModel('claude', role, portableConfig), 'claude/claude-sonnet-5-5');
  assert.equal(
    creationModel('claude', sessionDefaults('claude', {}, null), { providers: { claude: 'claude', codex: 'codex' } }),
    'claude',
    'a portable install that names the bare family does follow its host',
  );
});

test('creation asks this function for the model instead of choosing one inline', () => {
  // The other half of the same hole: the tests above bind creationModel, so a re-pin moved back INTO
  // create() would leave them green. create() must reach the model through this function and nowhere else.
  const source = fs.readFileSync(path.join(here, 'native.mjs'), 'utf8');
  const create = source.slice(source.indexOf('async create(a,'), source.indexOf('async inspect(id)'));
  assert.notEqual(create.length, 0, 'create() not found in native.mjs; this guard is reading the wrong text');
  assert.match(create, /resolveProviderModel\(client, creationModel\(a\.provider, chosen\), cwd\)/);
  // And nothing else in create() may name a provider inventory or a model of its own (the capability check reads the
  // inventory inside provider-model.mjs, not here).
  assert.doesNotMatch(create, /listModels|providers\[/);
});

test('a session the controller creates comes up Medium and Auto, not High and Always Ask', () => {
  // The other two axes of the same outcome, on the same path. Kept here beside the model because the
  // owner's requirement is one sentence about three values, and splitting it across three files is how
  // two of them stayed wrong while the third was fixed.
  const chosen = sessionDefaults('claude', {}, null);
  assert.equal(chosen.modeId, 'auto');
  assert.equal(chosen.thinkingOptionId, 'medium');
  assert.equal(chosen.ask, null, 'no ask pin, which is what re-imposes prompting on top of auto');
  assert.equal(chosen.options, undefined);
});
