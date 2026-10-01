import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { compareAt, compareMaps, describeComparison, isRevision, listMapsAt, reach, readMapAt } from './diff.mjs';

const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/changes/${name}.ir.json`, import.meta.url), 'utf8'));
const base = fixture('base'), head = fixture('head');
const edit = (ir, fn) => { const copy = structuredClone(ir); fn(copy); return copy; };
const component = (ir, id) => ir.components.find(c => c.id === id);
const connection = (ir, id) => ir.connections.find(c => c.id === id);

test('the fixture pair: added, removed, changed and unchanged parts and connections', () => {
  const r = compareMaps(base, head);
  assert.deepEqual(r.components.added, ['search']);
  assert.deepEqual(r.components.removed, ['reports']);
  assert.deepEqual(r.components.changed, [{ id: 'orders', fields: ['sublabel'] }]);
  assert.deepEqual(r.components.unchanged, ['mail', 'orders-db', 'payments', 'web']);
  assert.deepEqual(r.connections.added, ['orders-to-search', 'search-to-db']);
  assert.deepEqual(r.connections.removed, ['reports-to-db']);
  assert.deepEqual(r.connections.changed, []);
  // orders changed and makes a new connection; the database only gains a reader, so it is not touched.
  assert.deepEqual(r.touched, ['orders', 'reports', 'search']);
  assert.deepEqual(r.reach, ['web'], 'the website calls the orders service, so it can feel the change');
  assert.deepEqual(r.suspectedRenames, []);
  assert.equal(describeComparison(r).sentence, 'Touches 3 parts of the system (1 added, 1 removed, 1 changed); 1 other part depends on them.');
});

test('moving or resizing a box is layout, not a change to the system', () => {
  const moved = edit(base, ir => { component(ir, 'mail').pos = [900, 400]; connection(ir, 'orders-to-mail').labelDy = 20; });
  const r = compareMaps(base, moved);
  assert.deepEqual(r.components.changed, []);
  assert.deepEqual(r.components.moved, ['mail']);
  assert.deepEqual(r.connections.moved, ['orders-to-mail']);
  assert.deepEqual(r.touched, []);
  assert.equal(r.unchangedMap, false);
  assert.match(describeComparison(r).sentence, /only rearranged/);
  assert.equal(compareMaps(base, structuredClone(base)).unchangedMap, true);
});

test('a part whose id changed is removed + added, and flagged as a suspected rename (rule 6)', () => {
  const renamed = edit(base, ir => {
    component(ir, 'mail').id = 'email-queue';
    connection(ir, 'orders-to-mail').to = 'email-queue';
  });
  const r = compareMaps(base, renamed);
  assert.deepEqual(r.components.removed, ['mail']);
  assert.deepEqual(r.components.added, ['email-queue']);
  assert.deepEqual(r.suspectedRenames, [{ from: 'mail', to: 'email-queue' }]);
  assert.deepEqual(r.connections.changed, [{ id: 'orders-to-mail', fields: ['to'] }]);
  // A different part that happens to be new is not paired with anything.
  const unrelated = edit(base, ir => { ir.components.push({ ...component(ir, 'mail'), id: 'audit', label: 'Audit log' }); });
  assert.deepEqual(compareMaps(base, unrelated).suspectedRenames, []);
});

test('connection changes: relabelled, re-pointed, and moved to a different maker', () => {
  const relabelled = compareMaps(base, edit(base, ir => { connection(ir, 'orders-to-db').label = 'stores and archives orders'; }));
  assert.deepEqual(relabelled.connections.changed, [{ id: 'orders-to-db', fields: ['label'] }]);
  assert.deepEqual(relabelled.touched, ['orders'], 'the maker of a changed connection is touched');
  assert.deepEqual(relabelled.reach, ['web']);

  const repointed = compareMaps(base, edit(base, ir => { connection(ir, 'orders-to-mail').to = 'payments'; }));
  assert.deepEqual(repointed.connections.changed, [{ id: 'orders-to-mail', fields: ['to'] }]);
  assert.deepEqual(repointed.touched, ['orders']);

  const newMaker = compareMaps(base, edit(base, ir => { connection(ir, 'reports-to-db').from = 'orders'; }));
  assert.deepEqual(newMaker.touched, ['orders', 'reports'], 'both the old and the new maker changed behaviour');

  const style = compareMaps(base, edit(base, ir => { connection(ir, 'orders-to-payments').variant = 'emphasis'; }));
  assert.deepEqual(style.connections.changed, [{ id: 'orders-to-payments', fields: ['variant'] }]);
});

test('a map new in the change, or deleted by it', () => {
  const added = compareMaps(null, head);
  assert.equal(added.components.added.length, head.components.length);
  assert.equal(describeComparison(added).sentence, 'This change adds the system map, with 6 parts.');
  const deleted = compareMaps(base, null);
  assert.equal(deleted.components.removed.length, base.components.length);
  assert.equal(describeComparison(deleted).sentence, 'This change deletes the system map.');
});

test('a map that cannot be compared is refused, not guessed at', () => {
  assert.throws(() => compareMaps(base, edit(head, ir => ir.components.push({ ...ir.components[0] }))), /duplicate id "web"/);
  assert.throws(() => compareMaps(base, edit(head, ir => { delete ir.components[0].id; })), /needs an id/);
});

test('reach is transitive, survives cycles, and never repeats a touched part', () => {
  const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }, { from: 'x', to: 'a' }, { from: 'c', to: 'y' }];
  assert.deepEqual(reach(edges, ['c']), ['a', 'b', 'x'], 'b uses c, a uses b, x uses a; y is used BY c, so it cannot feel c');
  assert.deepEqual(reach(edges, ['y']), ['a', 'b', 'c', 'x']);
  assert.deepEqual(reach(edges, []), []);
  assert.deepEqual(reach([{ from: 'constructor', to: '__proto__' }], ['__proto__']), ['constructor']);
});

// ---- git: always the committed map, never the working tree ------------------------------------------

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'j7-archmap-diff-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: '', GIT_CONFIG_NOSYSTEM: '1', HOME: root } }).trim();
  git('init', '-q', '-b', 'main');
  const write = (rel, value) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), typeof value === 'string' ? value : JSON.stringify(value)); };
  const commit = message => { git('add', '-A'); git('commit', '-q', '--allow-empty', '-m', message); return git('rev-parse', 'HEAD'); };
  return { root, git, write, commit, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('reads each side with git show at its commit, and ignores the working tree', async () => {
  const repo = repository();
  try {
    repo.write('README.md', 'example');
    const empty = repo.commit('no map yet');
    repo.write('.fulcra/architecture/shop.ir.json', base);
    const first = repo.commit('map the shop');
    repo.write('.fulcra/architecture/shop.ir.json', head);
    const second = repo.commit('add search');
    // An uncommitted edit must not leak into either side.
    repo.write('.fulcra/architecture/shop.ir.json', edit(head, ir => { ir.components[0].label = 'NOT COMMITTED'; }));

    assert.equal(await readMapAt(repo.root, empty, '.fulcra/architecture/shop.ir.json'), null, 'absent at that commit');
    assert.deepEqual(await readMapAt(repo.root, first, '.fulcra/architecture/shop.ir.json'), base);
    assert.deepEqual(await readMapAt(repo.root, second, '.fulcra/architecture/shop.ir.json'), head);
    assert.deepEqual(await listMapsAt(repo.root, second), ['.fulcra/architecture/shop.ir.json']);

    const all = await compareAt(repo.root, first, second);
    assert.equal(all.maps.length, 1);
    assert.deepEqual(all.maps[0].touched, ['orders', 'reports', 'search']);
    assert.equal(all.maps[0].summary.parts, 3);
    const fresh = await compareAt(repo.root, empty, second);
    assert.match(fresh.maps[0].summary.sentence, /adds the system map/);
    // A revision that does not exist is an error, not "no map".
    await assert.rejects(readMapAt(repo.root, 'f'.repeat(40), '.fulcra/architecture/shop.ir.json'));
  } finally { repo.done(); }
});

test('refuses option-like revisions and paths outside the map directory', async () => {
  for (const bad of ['--output=/tmp/x', '-p', 'a..b', 'HEAD rm', '']) assert.equal(isRevision(bad), false, bad);
  for (const good of ['HEAD', 'HEAD~1', 'main', 'origin/main', 'a'.repeat(40)]) assert.equal(isRevision(good), true, good);
  const never = () => { throw new Error('git must not run'); };
  await assert.rejects(readMapAt('.', '--output=x', '.fulcra/architecture/a.ir.json', never), /Not a commit/);
  await assert.rejects(readMapAt('.', 'HEAD', 'package.json', never), /Maps live at/);
  await assert.rejects(readMapAt('.', 'HEAD', '.fulcra/architecture/../../x.ir.json', never), /Maps live at/);
});
