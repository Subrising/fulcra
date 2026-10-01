#!/usr/bin/env node
// Compare two Architecture IR v1 maps: the "before" and "after" of one change (CHANGES, D5).
//
// Identity is the authored id (SKILL rule 6), never position or label, so a moved box is not a new box
// and a relabelled box is "changed", not "removed + added". A box whose id changed IS removed + added;
// `suspectedRenames` names the pairs that look like the same part so the gate can ask for stable ids.
//
// The comparison and the reach walk are pure and import nothing, so the plugin, the controller and the
// app's TypeScript twin (packages/app/src/architecture-map/map-diff.ts, same cases in its tests) agree.
// Reading a map at a commit goes through `git show <sha>:<path>` only -- never the working tree -- and
// loads node:child_process lazily so importing this file needs no Node built-ins.
//
// Usage: node diff.mjs <repo-root> <base-rev> <head-rev> [.fulcra/architecture/<name>.ir.json]

export const MAP_DIRECTORY = '.fulcra/architecture';
const MAP_PATH = /^\.fulcra\/architecture\/[A-Za-z0-9_][A-Za-z0-9._ -]{0,119}\.ir\.json$/;
// A revision git can resolve, never an option: no leading dash, no whitespace, no revision-range syntax.
const REVISION = /^(?!-)[A-Za-z0-9._/@^~-]{1,200}$/;

// Fields that change what a part IS. Position and size are layout: reported as `moved`, never coloured.
export const COMPONENT_FIELDS = Object.freeze(['type', 'label', 'sublabel', 'tag']);
export const COMPONENT_LAYOUT = Object.freeze(['pos', 'size']);
export const CONNECTION_FIELDS = Object.freeze(['from', 'to', 'label', 'variant']);
export const CONNECTION_LAYOUT = Object.freeze(['fromSide', 'toSide', 'labelDy']);

const isObject = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Items keyed by id in a Map (never an object, so "__proto__" is only ever a key). Duplicate or missing
// ids make "which one changed" unanswerable, so the comparison refuses instead of guessing.
function byId(items, what) {
  const out = new Map();
  for (const [i, item] of (Array.isArray(items) ? items : []).entries()) {
    if (!isObject(item) || typeof item.id !== 'string' || item.id.length === 0) throw new Error(`${what}.${i}: every ${what.slice(0, -1)} needs an id to be compared`);
    if (out.has(item.id)) throw new Error(`${what}.${i}: duplicate id "${item.id}"`);
    out.set(item.id, item);
  }
  return out;
}

function compareSets(before, after, fields, layout) {
  const added = [], removed = [], changed = [], moved = [], unchanged = [];
  for (const id of after.keys()) if (!before.has(id)) added.push(id);
  for (const [id, old] of before) {
    const now = after.get(id);
    if (!now) { removed.push(id); continue; }
    const diff = fields.filter(f => !same(old[f], now[f]));
    if (diff.length) changed.push({ id, fields: diff });
    else unchanged.push(id);
    if (layout.some(f => !same(old[f], now[f]))) moved.push(id);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort((a, b) => a.id.localeCompare(b.id)), moved: moved.sort(), unchanged: unchanged.sort() };
}

/**
 * Compare two parsed maps. Either side may be null: a map that is new in the change, or deleted by it.
 * Returns the component and connection differences, the parts the change touches, the parts it can be
 * felt by (reach), and id pairs that look like a rename (rule 6).
 */
export function compareMaps(base, head) {
  const b = base ?? { components: [], connections: [] }, h = head ?? { components: [], connections: [] };
  const bc = byId(b.components, 'components'), hc = byId(h.components, 'components');
  const be = byId(b.connections, 'connections'), he = byId(h.connections, 'connections');
  const components = compareSets(bc, hc, COMPONENT_FIELDS, COMPONENT_LAYOUT);
  const connections = compareSets(be, he, CONNECTION_FIELDS, CONNECTION_LAYOUT);
  // A part is touched when it was added, removed or changed, or when a connection it MAKES was. The
  // other end is not: a database that something new reads from has not itself changed. A connection
  // whose `from` moved touches both the old and the new maker.
  const touched = new Set([...components.added, ...components.removed, ...components.changed.map(c => c.id)]);
  const makers = id => [be.get(id), he.get(id)].filter(Boolean).map(e => e.from);
  for (const id of [...connections.added, ...connections.removed, ...connections.changed.map(c => c.id)]) {
    for (const from of makers(id)) if (bc.has(from) || hc.has(from)) touched.add(from);
  }
  const edges = [...be.values(), ...he.values()].map(e => ({ from: e.from, to: e.to }));
  const touchedParts = [...touched].sort();
  return {
    version: 1,
    base: base ? { title: typeof b.meta?.title === 'string' ? b.meta.title : null } : null,
    head: head ? { title: typeof h.meta?.title === 'string' ? h.meta.title : null } : null,
    components,
    connections,
    touched: touchedParts,
    reach: reach(edges, touchedParts),
    suspectedRenames: suspectedRenames(components, bc, hc),
    unchangedMap: touchedParts.length === 0 && components.moved.length === 0 && connections.moved.length === 0,
  };
}

/**
 * The blast radius on the map: every part that has a path of connections leading INTO a touched part,
 * i.e. that uses, calls or references it, transitively. The same direction as import dependents in
 * change-impact.mjs ("what can feel this change"). Touched parts themselves are not repeated.
 */
export function reach(edges, touched) {
  const into = new Map();
  for (const { from, to } of edges) {
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    if (!into.has(to)) into.set(to, new Set());
    into.get(to).add(from);
  }
  const seen = new Set(touched), queue = [...touched], found = [];
  while (queue.length) {
    for (const user of into.get(queue.shift()) ?? []) {
      if (seen.has(user)) continue;
      seen.add(user); found.push(user); queue.push(user);
    }
  }
  return found.sort();
}

// A removed id and an added id of the same type and label are almost certainly one part whose id was
// changed, which breaks every later comparison of it. Reported, never merged: the ids are the record.
function suspectedRenames(components, before, after) {
  const pairs = [];
  const key = c => `${c.type ?? ''}\u0000${String(c.label ?? '').trim().toLowerCase()}`;
  const added = new Map();
  for (const id of components.added) {
    const k = key(after.get(id));
    if (!added.has(k)) added.set(k, []);
    added.get(k).push(id);
  }
  for (const id of components.removed) {
    const match = added.get(key(before.get(id)));
    if (match?.length) pairs.push({ from: id, to: match.shift() });
  }
  return pairs;
}

/** Counts and one plain sentence, for people rather than tools. */
export function describeComparison(result) {
  const c = result.components, e = result.connections;
  const parts = result.touched.length;
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  let sentence;
  if (!result.base && result.head) sentence = `This change adds the system map, with ${plural(c.added.length, 'part')}.`;
  else if (result.base && !result.head) sentence = 'This change deletes the system map.';
  else if (parts === 0) sentence = c.moved.length || e.moved.length ? 'The map was only rearranged; no part of the system changed.' : 'No part of the system map changed.';
  else {
    const bits = [c.added.length && `${c.added.length} added`, c.removed.length && `${c.removed.length} removed`, c.changed.length && `${c.changed.length} changed`].filter(Boolean);
    sentence = `Touches ${plural(parts, 'part')} of the system${bits.length ? ` (${bits.join(', ')})` : ''}${result.reach.length ? `; ${plural(result.reach.length, 'other part')} ${result.reach.length === 1 ? 'depends' : 'depend'} on ${parts === 1 ? 'it' : 'them'}` : ''}.`;
  }
  return {
    parts,
    reach: result.reach.length,
    components: { added: c.added.length, removed: c.removed.length, changed: c.changed.length, unchanged: c.unchanged.length },
    connections: { added: e.added.length, removed: e.removed.length, changed: e.changed.length, unchanged: e.unchanged.length },
    sentence,
  };
}

// ---- Reading maps at a commit (git only) -------------------------------------------------------------

export const isMapPath = p => typeof p === 'string' && MAP_PATH.test(p) && !p.includes('..');
export const isRevision = r => typeof r === 'string' && REVISION.test(r) && !r.includes('..');

async function git(root, args) {
  const { execFileSync } = await import('node:child_process');
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The full commit sha `rev` names. An unknown revision is an error, never "no map". */
export async function resolveCommit(root, rev, run = git) {
  if (!isRevision(rev)) throw new Error(`Not a commit this tool will read: ${JSON.stringify(rev)}`);
  let sha = '';
  try { sha = String(await run(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])).trim(); } catch { /* reported below */ }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`No such commit: ${rev}`);
  return sha;
}

/** The map as committed at `rev`, parsed, or null when the map does not exist at that commit. */
export async function readMapAt(root, rev, mapPath, run = git) {
  if (!isMapPath(mapPath)) throw new Error(`Maps live at ${MAP_DIRECTORY}/<name>.ir.json`);
  const sha = await resolveCommit(root, rev, run);
  let text;
  try { text = await run(root, ['show', `${sha}:${mapPath}`]); }
  catch (error) {
    // The commit exists (resolved above), so "does not exist in <sha>" can only mean the map is absent.
    if (/does not exist in|exists on disk, but not in/.test(String(error?.stderr ?? error?.message))) return null;
    throw error;
  }
  if (new TextEncoder().encode(text).byteLength > 1_048_576) throw new Error(`${mapPath} at ${rev} is larger than 1 MiB`);
  try { return JSON.parse(text); } catch { throw new Error(`${mapPath} at ${rev} is not valid JSON`); }
}

/** Every map path present at `rev`. */
export async function listMapsAt(root, rev, run = git) {
  const sha = await resolveCommit(root, rev, run);
  const out = await run(root, ['ls-tree', '--name-only', sha, '--', `${MAP_DIRECTORY}/`]);
  return out.split('\n').filter(isMapPath).sort();
}

/** Compare one map, or every map found at either commit, between two revisions. */
export async function compareAt(root, baseRev, headRev, mapPath = null, run = git) {
  const [baseSha, headSha] = [await resolveCommit(root, baseRev, run), await resolveCommit(root, headRev, run)];
  const paths = mapPath ? [mapPath] : [...new Set([...await listMapsAt(root, baseSha, run), ...await listMapsAt(root, headSha, run)])].sort();
  const maps = [];
  for (const p of paths) {
    const [base, head] = [await readMapAt(root, baseSha, p, run), await readMapAt(root, headSha, p, run)];
    if (!base && !head) continue;
    const result = compareMaps(base, head);
    maps.push({ path: p, ...result, summary: describeComparison(result) });
  }
  return { version: 1, base: baseSha, head: headSha, maps };
}

if (globalThis.process?.argv?.[1]) {
  const [{ fileURLToPath }, fs] = [await import('node:url'), await import('node:fs')];
  let entry = null;
  try { entry = fs.realpathSync(process.argv[1]); } catch { /* not a file: not run directly */ }
  if (entry === fileURLToPath(import.meta.url)) {
    const [root, base, head, map] = process.argv.slice(2);
    if (!root || !base || !head) {
      console.error('usage: node diff.mjs <repo-root> <base-rev> <head-rev> [.fulcra/architecture/<name>.ir.json]');
      process.exit(2);
    }
    try { console.log(JSON.stringify(await compareAt(root, base, head, map ?? null), null, 2)); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
  }
}
