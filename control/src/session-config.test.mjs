import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// sessionConfig reaches memoryConfig, which refuses under a portable installation by design. Stripping
// ORCA_HOME keeps this suite's result from depending on whether its runner has a portable install.
function ask(script) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 20000, cwd: here, env: { ...process.env, ORCA_HOME: undefined } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const configs = ask(`
  const { sessionConfig } = await import('./session-config.mjs');
  const { settingsStatus } = await import('./control/installation-settings.mjs');
  console.log(JSON.stringify({
    settings: settingsStatus(),
    claude: sessionConfig('claude/claude-opus-5'),
    codex: sessionConfig('codex/gpt-6-astra'),
    overridden: sessionConfig('claude/claude-opus-5', { modeId: 'plan', thinkingOptionId: 'low' }),
    refused: await (async () => { try { sessionConfig('claude/claude-opus-5', { modeId: 'bypassPermissions' }); return null; } catch (e) { return e.message; } })(),
  }));`);

test('the trial-worker path now takes its mode from the one selector', () => {
  // These are the PRODUCT defaults. An installation settings file would legitimately change them, so say
  // that plainly here rather than letting this suite quietly assert one machine's configuration.
  assert.equal(configs.settings.present, false,
    `A settings file exists at ${configs.settings.path}; the values below are product defaults and this suite does not describe a configured installation.`);
  assert.equal(configs.claude.modeId, 'auto');
  // Medium, deliberately: see DEFAULT_THINKING_BY_PROVIDER. This path pinned 'medium' inline once, then
  // moved to a universal 'high' when it was centralised; the owner's default puts claude back on medium
  // while leaving High available per task. codex below is unchanged.
  assert.equal(configs.claude.thinkingOptionId, 'medium');
  assert.equal(configs.codex.modeId, 'auto-review');
  assert.equal(configs.codex.thinkingOptionId, 'high');
});

test('the inline approval pins are gone for claude and derived for codex', () => {
  // The old claude pin asked for confirmation on Write and Edit -- the opposite of automatic approval.
  assert.equal('options' in configs.claude, false);
  assert.equal(JSON.stringify(configs.claude).includes('"ask"'), false);
  assert.equal(JSON.stringify(configs.claude).includes('permissions'), false);
  // Codex keeps the same two values it had, but now derived from the chosen mode rather than transcribed.
  assert.deepEqual(configs.codex.options, { approval_policy: 'on-request', sandbox_mode: 'workspace-write' });
});

test('a deliberate override still wins, and a refused mode is still refused', () => {
  assert.equal(configs.overridden.modeId, 'plan');
  assert.equal(configs.overridden.thinkingOptionId, 'low');
  assert.match(configs.refused, /broadens access rather than automating approval/);
});

test('everything this change was not supposed to touch is unchanged', () => {
  for (const key of ['claude', 'codex']) {
    assert.deepEqual(configs[key].toolPolicy, { preapproved: [
      { kind: 'mcp', server: 'shared-memory', tool: 'shared_memory_read' },
      { kind: 'mcp', server: 'shared-memory', tool: 'shared_memory_search' }] });
    assert.match(configs[key].systemPrompt, /^You are a persistent independent Orca trial worker working on an operator-assigned task\./);
    assert.equal(typeof configs[key].mcpServers, 'object');
  }
  assert.equal(configs.claude.provider, 'claude/claude-opus-5');
  assert.equal(configs.codex.provider, 'codex/gpt-6-astra');
});

// The claim in provider-mode.mjs is that every creation path uses the one selector. The previous version of
// this test scanned for inline pin VALUES, which was evadable by quoting style and -- worse -- never looked
// at modeId at all, so a new path could hardcode a mode the selector refuses and still pass. The invariant
// is structural, so it is now asserted structurally.
//
// src/book/native.mjs is the one allowed exception: its approval options come from the enrolled host's own
// profile via workerOptions(), a deliberate 278-regression-verified binding. That host refuses Claude
// enrolment and automated permission grants are unsupported there, so centralising it would introduce
// automated approval where it is explicitly unsupported. If Book is ever centralised, delete this entry
// rather than widening anything.
const BOOK = 'src/book/native.mjs';
const root = path.join(here, '..');
const sources = (() => {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return ['node_modules', '.git'].includes(e.name) ? [] : walk(full);
    return e.isFile() && /\.(mjs|js|ts)$/.test(e.name) && !/\.test\./.test(e.name) ? [full] : [];
  });
  return walk(root);
})();
// Follows static and literal-dynamic relative imports. A file "uses the selector" if it can reach
// provider-mode.mjs at all, so going through session-config.mjs counts, as session.mjs does.
function reaches(file, target, seen = new Set()) {
  const abs = path.resolve(file);
  if (seen.has(abs)) return false;
  seen.add(abs);
  if (abs.endsWith(target)) return true;
  let src;
  try { src = fs.readFileSync(abs, 'utf8'); } catch { return false; }
  for (const [, spec] of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
    if (reaches(path.resolve(path.dirname(abs), spec), target, seen)) return true;
  }
  return false;
}

// The previous version of this test found creation paths by scanning for the literal `agents.create(`.
// That is string-true, not structurally true: a file that destructures `create` off the client, or takes
// the client as a parameter, writes no such literal and was invisible -- and the realistic regression is
// not someone hardcoding a refused mode, it is a new path that goes round the selector entirely and lets
// the host fall back to its own default.
//
// So the gate is where the creation capability ENTERS the program, not where it is called. A file can only
// obtain a client by constructing one, by importing connect() (which returns a raw client), or by
// importing connectNative() (which returns a bounded adapter exposing create but no .agents). Every such
// file is declared below with what it does, and the set is asserted exactly -- so a new one fails until
// someone adds it deliberately and answers the question the table asks.
//
// WHAT THIS STILL CANNOT SEE, stated plainly because the old comment read as a guarantee and was a string
// match. It is static, and two shapes leave no textual trace:
//
//   1. A file that receives a client as a PARAMETER and destructures it without writing `.agents`.
//   2. A file that imports a RENAMED re-export -- it only ever names the alias.
//   3. A file that never spells the name at all -- `m["connect" + "Native"]`.
//
// (3) is the boundary of token matching and is not closed here, deliberately. This is a DRIFT detector:
// it catches a creation path added without being declared. Someone splitting an identifier is not
// drifting -- they know exactly what they are avoiding -- and that is a threat model a static check in
// this repository cannot win. Written down so the next person to find it recognises a known limit rather
// than a hole. A destructure-rename at the call site, `{ connectNative: q }`, IS caught: the text still
// names the capability.
//
// A bare `export * from` of a holder is invisible too, and inert for the same reason as (2): any consumer
// that names the capability is caught, and one that never names it has not obtained it.
//
// Neither is detected. Both are bounded the same way: such a file cannot bring the capability into the
// tree, it has to be handed one by a declared holder. For (2) that holder is the re-exporting module, and
// the check below refuses the rename outright -- so (2) is closed by PROHIBITING the supply, not by
// detecting the consumer. The surface is closed where the capability enters, not at every point of use.
const CREATION_SURFACE = {
  'src/session.mjs': { creates: true },
  'src/control/native.mjs': { creates: true },
  // The one deliberate exception, unchanged: Book's options come from the enrolled host's own profile via
  // workerOptions(), a 278-regression-verified binding. That host refuses Claude enrolment and automated
  // permission grants are unsupported there, so centralising it would introduce automated approval where
  // it is explicitly unsupported. If Book is ever centralised, delete `exempt` -- do not widen anything.
  'src/book/native.mjs': { creates: true, exempt: 'options come from the enrolled host profile' },
  'src/runtime.mjs': { creates: false, note: 'connect() hands out a raw client; creates nothing itself' },
  'src/revise.mjs': { creates: false, note: 'holds a raw client for ref/list/send only' },
  'src/control/client-sdk.mjs': { creates: false, note: 'the SDK shim that re-exports createPaseoApi' },
  'src/control/server.mjs': { creates: false, note: 'holds the bounded adapter, which exposes no .agents' },
  'src/control/agent-watch.mjs': { creates: false, note: 'receives a client to hold one subscription open' },
  // Reads status and pending for the deployment quiescence gate. It builds a client because that is the
  // only way to ask the daemon rather than the controller, whose observe RPC takes delegated sessions
  // over. Read-only: refresh and current(), never agents.create.
  'src/control/deploy-readiness.mjs': { creates: false, note: 'reads one agent status per delegated session' },
  // Outside src/, and invisible to the old scan because none of them writes `agents.create(`. All four are
  // read-only consumers -- list, ref, refresh, timeline -- so they hold the capability without using it.
  'orca-conversation/hosts.mjs': { creates: false, note: 'builds a client to list agents while probing a host' },
  'orca-organization/server/fleet.ts': { creates: false, note: 'reads the fleet: agents.list and timelines' },
  'orca-organization/server/history.ts': { creates: false, note: 'reads one agent timeline' },
  'orca-organization/server/organization.ts': { creates: false, note: 'reads agents to project the organization' },
  // C1 (J6 Sessions step-through): read-only, like fleet/history -- one agent's timeline turn index, never agents.create.
  'orca-organization/server/session-steps.ts': { creates: false, note: 'reads one agent timeline for the step-through' },
  'orca-organization/server/wiring-test-adapters.mjs': { creates: false, note: 'test adapter: lists agents from fixture state' },
  'research/stage2-mutations.mjs': { creates: false, note: 'C2 mutation harness: names connectNative only inside a server.mjs source-anchor string; never imports or calls it' },
};
// Bare identifiers, NOT `import ... connectNative`. Requiring `import` to come first meant a dynamic
// import inverted the order and slipped through -- `const { connectNative } = await import(M)` names the
// capability but does not match. The two signals also shared a blind spot neither had alone: `.agents`
// could not cover the gap, because connectNative deliberately returns an adapter with no `.agents` on it.
// A raw client leaves a `.agents` trace by necessity; the adapter path leaves none, which is why this is
// where the hole was.
const CAPABILITY_NAMES = ['connectNative', 'createPaseoApi', 'createPaseoClient'];
const ENTRY_SIGNALS = [
  new RegExp(`\\b(?:${CAPABILITY_NAMES.join('|')})\\b`),
  /import\s*\{[^}]*\bconnect\b[^}]*\}\s*from\s*['"][^'"]*runtime\.mjs['"]/,
  /\.agents\b/,
  /agents\.create\(/,
];
// Renaming on re-export is what makes a consumer undetectable: `export { connectNative as mkNative }`
// launders the capability, and from then on neither that file's importers nor anything downstream contains
// a token to find. Tracking those consumers would need the import graph, which is the over-broad trap that
// made pure reachability wrong. So the RENAME is refused instead -- re-exporting under the SAME name stays
// fine, because importers still name the capability and the signals above see them.
const launders = body => [...body.matchAll(/export\s*\{([^}]+)\}/g)]
  .flatMap(m => m[1].split(','))
  .map(part => part.trim().split(/\s+as\s+/))
  .filter(([from, to]) => CAPABILITY_NAMES.includes(from) && to && to !== from)
  .map(([from, to]) => `${from} as ${to}`)
  .concat([...body.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/g)]
    .filter(m => CAPABILITY_NAMES.includes(m[2]) && m[1] !== m[2]).map(m => `${m[2]} as ${m[1]}`));
const surface = () => sources.map(f => path.relative(root, f))
  .filter(f => ENTRY_SIGNALS.some(r => r.test(fs.readFileSync(path.join(root, f), 'utf8'))))
  .sort();

test('no file launders the creation capability under another name', () => {
  const offenders = sources.map(f => path.relative(root, f))
    .flatMap(f => launders(fs.readFileSync(path.join(root, f), 'utf8')).map(a => `${f} (${a})`));
  assert.deepEqual(offenders, [],
    'Re-exporting the creation capability under a different name hides every consumer from this check. '
    + 'Import it directly where it is used, or re-export it under its own name.');
});

test('the files that can obtain a session-creating client are exactly the declared ones', () => {
  const declared = Object.keys(CREATION_SURFACE).sort();
  const found = surface();
  // Non-vacuous: if the signals ever stop matching, this fails rather than passing on an empty set.
  assert.ok(found.length >= declared.length, `found ${found.length} capability holders, expected at least ${declared.length}`);
  assert.deepEqual(found, declared,
    'A file gained or lost the ability to create sessions. Add it to CREATION_SURFACE saying whether it '
    + 'creates; if it does, it must reach sessionDefaults or every session it makes takes the host default.');
});

// The gate enforces "no UNDECLARED file creates". It does not enforce "every annotation is accurate" --
// `owing` filters on v.creates, so a file already in the set that starts creating keeps its flag, stays
// declared, and is never checked against the selector. That moved the trust rather than removing it.
// Every declared non-creator currently contains no `.create(` of any kind, so the check can be exact.
test('every file annotated as a non-creator contains no creation call', () => {
  const declared = Object.entries(CREATION_SURFACE).filter(([, v]) => !v.creates).map(([f]) => f);
  assert.ok(declared.length >= 5, 'the non-creator list collapsed; this would pass vacuously');
  const lying = declared.filter(f => /\.create\(/.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepEqual(lying, [],
    'These are annotated `creates: false` but call .create(. Either the annotation is wrong -- in which '
    + 'case set creates: true and the file must reach sessionDefaults -- or the call is not a session '
    + 'creation and the signal needs narrowing deliberately.');
});

test('every declared creator reaches the one selector', () => {
  const owing = Object.entries(CREATION_SURFACE).filter(([, v]) => v.creates && !v.exempt).map(([f]) => f);
  assert.ok(owing.length >= 2, 'the creators list collapsed; this would pass vacuously');
  const detached = owing.filter(f => !reaches(path.join(root, f), 'control/provider-mode.mjs'));
  assert.deepEqual(detached, [], `These create sessions without reaching sessionDefaults: ${detached.join(', ')}`);
});

test('no file outside the selector pins a mode or approval value inline', () => {
  // Kept as defence in depth behind the structural test, now including modeId and both quoting styles.
  //
  // A provider/model literal is in the pattern because leaving it out is precisely how the defect
  // survived: native.mjs carried its own 'claude/claude-opus-5' fallback, this guard was green, and every
  // session that path created ignored the model the host advertised as its default. A model literal is a
  // session default like any other, and it is now caught like one. Book is excluded for the reason the
  // next test states: it REQUIRES an explicit enrolled model, which is a different guarantee.
  //
  // The model half is deliberately narrow: a whole quoted string of the form family/model-id, and not one
  // that ends in a file extension. `claude/leadership-brief.md` is an artifact path and matching it would
  // make this guard report a file that pins nothing, which is the failure mode that gets a guard deleted.
  const pattern = /approval_policy|sandbox_mode|(["']?)(modeId|thinkingOptionId)\1\s*:\s*["']|permissions\s*:\s*\{\s*["']?ask|(["'])(?:claude|codex)\/[A-Za-z0-9][\w\-[\]]*\3/;
  const allowed = ['src/control/provider-mode.mjs', BOOK];
  const offenders = sources.map(f => path.relative(root, f))
    .filter(f => !allowed.includes(f) && pattern.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepEqual(offenders, [], `These inline their own session defaults instead of calling sessionDefaults: ${offenders.join(', ')}`);
});

test('the Book path is deliberately excluded and still binds to its host profile', () => {
  const book = fs.readFileSync(path.join(here, 'book', 'native.mjs'), 'utf8');
  // Not a style preference: these two facts are why Book is not centralised.
  assert.match(book, /optionsFor:\s*family\s*=>\s*workerOptions\(runtime,\s*family\)/);
  assert.match(book, /Explicit enrolled Book Claude model required/);
});
