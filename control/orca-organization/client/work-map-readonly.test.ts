import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * T3 — the work map is read-only by construction, checked on the source itself.
 *
 * Runs from the plugin root (verify.mjs sets the cwd). Any new import, contract, navigation or
 * controller call in the work-map modules has to be admitted here deliberately.
 */

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
const imports = (source: string) => [...source.matchAll(/^\s*import\s[^'"]*?from\s+["']([^"']+)["']/gm)].map(m => m[1]);
const CLIENT = ['client/work-map.tsx', 'client/work-map-model.ts', 'client/details.tsx'];
const ALLOWED_IMPORTS = new Set(['react', 'react-native', '@getpaseo/plugin/client', '@getpaseo/plugin/client/react-native', '@tanstack/react-query',
  './use-contract', './work-button', './work-map-model', '../shared/work-map', '../shared/linked-issues',
  // J0: the Details disclosure (presentation only) and the in-memory last good result (no I/O).
  './details', './last-good']);
const WRITE_CONTRACTS = ['roleAssignRpc', 'roleAdoptRpc', 'roleAllowanceSetRpc', 'projectRequestSessionRpc', 'managementRpc', 'taskManagementRpc', 'sessionRequestsRpc', 'roleAllowancesRpc', 'outcomeArtifactRpc'];
const MUTATING_METHODS = ['bindings-assign', 'bindings-unassign', 'bindings-grant', 'roles-adopt', 'roles-allowance-set', 'roles-request-session', 'seat-hold', 'seat-unhold',
  'operator-send', 'channels-send', 'channels-request', 'channels-close', 'handback', 'takeover', 'create', 'send', 'reestablish', 'permissions-grant'];

test('T3 work-map client modules import only the read contracts and presentation modules', () => {
  for (const file of CLIENT) {
    const found = imports(read(file));
    assert.ok(found.length > 0, `${file} has no imports to check`);
    for (const spec of found) assert.ok(ALLOWED_IMPORTS.has(spec), `${file} imports ${spec}, which is not admitted to the read-only work map`);
  }
});

test('J0 the last-good memory the work map uses imports nothing, so it can do no I/O', () => {
  assert.deepEqual(imports(read('client/last-good.ts')), []);
  assert.ok(!/\b(fetch|localStorage|AsyncStorage|indexedDB|writeFile)\b/.test(read('client/last-good.ts')), 'memory only, nothing persisted');
});

test('T3 work-map client modules name no write contract and call no contract but the two reads', () => {
  for (const file of CLIENT) {
    const source = read(file);
    for (const name of WRITE_CONTRACTS) assert.ok(!source.includes(name), `${file} references ${name}`);
    const contracts = new Set([...source.matchAll(/\b(\w+Rpc)\b/g)].map(m => m[1]));
    for (const name of contracts) assert.ok(name === 'workMapRpc' || name === 'workMapProjectRpc', `${file} uses contract ${name}`);
  }
});

test('T3 the work map navigates nowhere and opens nothing', () => {
  for (const file of CLIENT) {
    const source = read(file);
    for (const token of ['navigation', 'openAgent', 'openAgentOnHost', 'Linking', 'openURL', 'window.open']) assert.ok(!source.includes(token), `${file} uses ${token}`);
    assert.ok(!/(?<![\w.])fetch\(/.test(source), `${file} calls fetch`);
  }
});

test('T3 the server reader has exactly one path to the controller, through the allowlist', () => {
  const source = read('server/work-map.ts');
  assert.equal([...source.matchAll(/\bcall\(/g)].length, 1, 'only allowlisted() may invoke the raw call');
  assert.match(source, /if \(!allowed\.has\(method\)\) return Promise\.reject/);
  for (const method of MUTATING_METHODS) assert.ok(!source.includes(`"${method}"`) && !source.includes(`'${method}'`), `server/work-map.ts names ${method}`);
  for (const name of WRITE_CONTRACTS) assert.ok(!source.includes(name), `server/work-map.ts references ${name}`);
});

test('T3 the shared work-map module defines only the two read contracts', () => {
  const source = read('shared/work-map.ts');
  const names = [...source.matchAll(/defineContract\(\{\s*name:\s*"([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(names, ['organization.work-map', 'organization.work-map-project']);
});

test('T3 the server wiring for the work map uses only the work-map readers and is gated', () => {
  const source = read('index.server.ts');
  // J6: reads register through handleRead (a deadline wrapper, server/deadline.ts); either spelling is the same route.
  const at = (name: string) => source.search(new RegExp(`handle(?:Read)?\\(${name}`));
  const start = at('workMapRpc'), end = at('sessionOwnershipRpc');
  assert.ok(start > 0 && end > start, 'work-map handlers not found where expected');
  const block = source.slice(start, end);
  for (const token of ['manage(', 'taskManage(', 'roleAssign(', 'adopt(', 'allowanceSet(', 'requestSession(', 'localCall']) assert.ok(!block.includes(token), `work-map wiring uses ${token}`);
  assert.equal([...block.matchAll(/if \(authError\) throw new Error\(authError\)/g)].length, 2, 'both work-map reads require the verified daemon');
});

// J6 branding (J5 walkthrough): what a user reads says Fulcra, and no build-internal label reaches the UI.
// Comments are stripped first; identifiers (plugin id, `orca-…` package names) never match the capitalised word.
// A user's own names ("Orca platform") come from data at runtime, never from these sources.
test('J6 no user-visible "Orca" text or staging label in the plugin client sources', () => {
  const dir = (d: string) => fs.readdirSync(path.join(process.cwd(), d)).filter(f => /\.(tsx?|mjs)$/.test(f) && !/\.test\./.test(f)).map(f => `${d}/${f}`);
  const files = [...dir('client'), 'index.client.tsx', 'shared/recovery-view.mjs'];
  assert.ok(files.length > 20, 'the scan must actually read the client');
  const hits: string[] = [];
  for (const file of files) {
    const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`])\/\/.*$/gm, '$1');
    code.split('\n').forEach((line, i) => { if (/\bOrca\b|staged next|STAGED BUILD|orca-organization-next/.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`); });
  }
  assert.deepEqual(hits, []);
});

// J6 (J5 walkthrough): with Map selected, the attention panel (up to eight rows) pushed the graph below the fold.
// Map view: a one-line count, then the map, then the full panel. List view: the panel still comes first.
// A structural check because the component suite needs external UI tooling (verify-ui.mjs); see J6 report.
test('J6 map view puts the graph above the attention panel; list view keeps the panel first', () => {
  const source = read('client/work-map.tsx'), at = (s: string) => source.indexOf(s);
  const map = at('<MapView rows='), summary = at('{showAttention && view === "map" && <Text'), panelAfterMap = at('{showAttention && view === "map" && attentionPanel}');
  const listPanel = at('{showAttention && view === "list" && attentionPanel}'), outline = at('accessibilityLabel="Fulcra work outline"');
  assert.ok(map > 0 && summary > 0 && panelAfterMap > 0 && listPanel > 0 && outline > 0, 'work-map render blocks not found');
  assert.ok(summary < map && map < panelAfterMap, 'map view: count, then map, then the full panel');
  assert.ok(listPanel < outline, 'list view: the panel stays above the outline');
  assert.equal(source.split('attentionPanel}').length - 1, 2, 'the full panel renders exactly once per view');
});

// J6: the installed-app smoke test (product repo, native-acceptance-walkthrough.js) locates these by test id,
// never by visible text. Renaming one breaks that harness, so the ids are pinned here.
test('J6 stable test ids for the surface tabs and the recovery toggle', () => {
  // J0 regroup: the ids now come from the tab registry. Every id the J6 strip had must still be rendered:
  // Organisation (id workmap), Leadership and Workstreams as Organisation's views, Live work inside Sessions, Manage task
  // as the sheet's button, and Trackers as it was.
  const org = read('client/organization.tsx'), tabs = read('client/tabs.ts');
  assert.ok(org.includes('testID={tabTestId(key)}') && org.includes('testID={legacyKey ? tabTestId(legacyKey) : undefined}'), 'tab test ids');
  assert.ok(tabs.includes('export const tabTestId = (key: string) => `organization-tab-${key}`;'));
  for (const key of ['workmap', 'leadership', 'portfolio', 'trackers']) assert.ok(tabs.includes(`key: "${key}"`), `tab ${key}`);
  assert.ok(tabs.includes('legacyKey: "fleet"') && tabs.includes('MANAGE_TASK_KEY = "task"'), 'Live work and Manage task keep their ids');
  assert.ok(read('client/recovery.tsx').includes('testID="recovery-details-toggle"'));
});
