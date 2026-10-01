import test from 'node:test';
import assert from 'node:assert/strict';
import { workGraph, edgeSegments, graphOffset, LIMITS, TRACKER_LIMITS, type GraphPage } from './work-graph-layout';
import type { TrackerView } from '../shared/trackers';
import type { Fleet } from '../shared/fleet';
const node = (id: string, task = 'task-' + id): Fleet['nodes'][number] => ({ id, task, host: 'mini', agentId: id, title: 'Session ' + id, provider: 'codex', model: null, mode: 'human', status: 'idle', pending: 0, observedAt: null, updatedAt: null, error: null });
const fleet = (nodes: Fleet['nodes']): Fleet => ({ nodes, tasks: nodes.map(n => ({ id: n.task, title: n.task, identifier: null })), edges: [], observedAt: 'now', total: nodes.length, partial: false, note: 'Fixture' });
const page = (sessionId: string, taskId: string, length = 2): GraphPage => ({ stale: false, historical: false, loading: false, data: { sessionId, taskId, cursor: null, observedAt: 'now', note: 'Coverage unverified', receipts: [], activity: Array.from({ length }, (_, i) => ({ id: String(i), kind: 'tool_call', label: 'Read', state: 'completed', files: ['same/file.ts'] })) } });
test('cycles, duplicate links and absent endpoints remain finite with typed supervision', () => {
  const d = fleet([node('a'), node('b')]); d.edges = [{ from: 'a', to: 'b', active: true, state: 'saved', event: null }, { from: 'b', to: 'a', active: false, state: 'saved', event: null }, { from: 'a', to: 'missing', active: true, state: 'saved', event: null }]; d.edges.push(d.edges[0]);
  const graph = workGraph(d, d.nodes, null); assert.equal(graph.nodes.length, 4); assert.equal(graph.edges.length, 4); assert.equal(graph.edges.filter(e => e.kind === 'supervision' && !e.active).length, 1);
  assert(graph.edges.every(e => graph.nodes.some(n => n.id === e.from) && graph.nodes.some(n => n.id === e.to)));
  const filtered = workGraph(d, [d.nodes[0]], null); assert.equal(filtered.edges.length, 1); assert.equal(filtered.nodes.length, 2);
});
test('reported paths retain per-event occurrence and foreign or hidden selections cannot attach pages', () => {
  const d = fleet([node('a'), node('b')]); const graph = workGraph(d, d.nodes, 'a', page('a', 'task-a'));
  assert.equal(graph.nodes.filter(n => n.kind === 'file').length, 2); assert.equal(new Set(graph.nodes.map(n => n.id)).size, graph.nodes.length);
  for (const p of [page('b', 'task-a'), page('a', 'task-b')]) assert.equal(workGraph(d, d.nodes, 'a', p).nodes.length, 4);
  assert.equal(workGraph(d, [d.nodes[1]], 'a', page('a', 'task-a')).nodes.length, 2);
  assert.deepEqual(workGraph(d, [...d.nodes].reverse(), 'a', page('a', 'task-a')), graph);
});
test('maximum schema fixture respects explicit node and edge ceilings without recursive layout', () => {
  const d = fleet(Array.from({ length: 64 }, (_, i) => node(String(i).padStart(2, '0'))));
  d.edges = d.nodes.flatMap(n => [true, false].map(active => ({ from: '00', to: n.id, active, state: 'saved', event: null })));
  const p = page('00', 'task-00', 50); for (const e of p.data!.activity) e.files = Array.from({ length: 8 }, (_, i) => 'reported-' + i);
  const g = workGraph(d, d.nodes, '00', p); assert.equal(g.nodes.length, LIMITS.nodes); assert.equal(g.edges.length, LIMITS.edges); assert(g.height < 41000 && g.width < 1300);
  assert(g.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y))); assert.equal(new Set(g.edges.map(e => e.id)).size, g.edges.length);
});
test('empty and disconnected work still lays out and pan offsets cannot escape finite bounds', () => {
  const d = fleet([]); assert.deepEqual(workGraph(d, [], null), { nodes: [], edges: [], width: 640, height: 320 });
  const viewport = { width: 320, height: 200 }; assert.deepEqual(graphOffset(-100, NaN, 640, 320, viewport, 1), { x: 0, y: 0 });
  assert.deepEqual(graphOffset(1e10, 1e10, 640, 320, viewport, 1), { x: 320, y: 120 });
  assert.deepEqual(graphOffset(100, 100, 640, 320, viewport, 0.5), { x: 0, y: 0 });
});

test('supervision edges route outside session cards and retain direction including self links',()=>{const d=fleet([node('a'),node('b')]),g=workGraph(d,d.nodes,null),a=g.nodes.find(n=>n.target==='a')!,b=g.nodes.find(n=>n.target==='b')!;const segments=edgeSegments(a,b,'supervision');assert.equal(segments.length,3);assert(segments[1][0]>a.x+240);assert.equal(segments.at(-1)![2],b.x+240);assert.equal(edgeSegments(a,a,'supervision')[1][3],a.y+42+24);assert.equal(edgeSegments(a,b,'event').length,1);});

test('same-task ordering, captions and ownership links remain faithful with repeated and missing task data',()=>{
 const a=node('z','shared'),b=node('a','shared'),c=node('c','other');a.title='A'.repeat(64)+'TRUNCATE';b.title='First';c.title='Second';const d=fleet([a,b,c]);d.tasks=[{id:'shared',title:'Correct task',identifier:'ID'},{id:'other',title:'Other task',identifier:null}];d.edges=[{from:a.id,to:b.id,active:true,state:'saved',event:null},{from:c.id,to:b.id,active:false,state:'saved',event:null},{from:b.id,to:b.id,active:true,state:'saved',event:null}];
 const g=workGraph(d,[a,b,c],null);assert.deepEqual(g.nodes.filter(n=>n.kind==='session').map(n=>n.target),['c','a','z']);assert(g.nodes.some(n=>n.title==='ID · Correct task'));assert(g.edges.filter(e=>e.kind==='membership').every(e=>e.active));const detail=g.nodes.find(n=>n.target===b.id&&n.kind==='session')!.detail;assert(detail.includes('Active supervision from '+'A'.repeat(64)));assert(detail.includes('Saved link from Second'));assert(!detail.includes('TRUNCATE'));assert(!detail.includes('from First'));assert.equal(g.nodes.find(n=>n.target===c.id&&n.kind==='session')!.detail.includes('supervision'),false);
 const absent=workGraph({...d,tasks:[]},[a],null);assert.equal(absent.nodes[0].title,'Task name unavailable');
});
test('defensive caps hold for oversized helper inputs and events without paths remain separately laid out',()=>{
 const d=fleet(Array.from({length:65},(_,i)=>node(String(i).padStart(2,'0'))));d.edges=Array.from({length:128},()=>({from:'00',to:'01',active:true,state:'saved',event:null}));d.edges.push({from:'01',to:'00',active:false,state:'saved',event:null});const p=page('00','task-00',51);for(const e of p.data!.activity)e.files=Array.from({length:9},(_,j)=>'file'+j);
 const g=workGraph(d,d.nodes,'00',p);assert.equal(g.nodes.filter(n=>n.kind==='session').length,64);assert.equal(g.nodes.filter(n=>n.kind==='event').length,50);assert.equal(g.nodes.filter(n=>n.kind==='file').length,400);assert.equal(g.edges.filter(e=>e.kind==='supervision').length,1);assert(!g.nodes.find(n=>n.target==='00'&&n.kind==='session')!.detail.includes('Saved link'));
 p.data!.activity=p.data!.activity.slice(0,2).map(e=>({...e,files:[]}));const events=workGraph(d,d.nodes,'00',p).nodes.filter(n=>n.kind==='event');assert.equal(events[1].y-events[0].y,100);
});

test('graph presents unknown names without hashes and resolves recorded leader relationships', () => {
 const a=node('a','shared'),b=node('b','shared');a.title='Release coordinator';b.title='Book conversation';b.host='Studio';
 const d=fleet([a,b]);d.tasks=[{id:'shared',title:'Retained task · abcdef12',identifier:null}];d.supervisionAvailable=true;d.supervisors=[{id:'a',task:'shared',active:false,maxWorkers:2,reserved:0,workers:[{requestId:'request',workerId:'b',phase:'attached',ownership:'linked',fault:null,lastEvent:null}]}];
 const g=workGraph(d,d.nodes,'b');assert(!g.nodes.some(n=>n.title.includes('abcdef12')));// Portable hosts (1bea30f2): the label is the configured host name.
 assert(g.nodes.some(n=>n.title==='Untitled Studio conversation'));assert(g.nodes.find(n=>n.target==='b')!.detail.includes('Worker for Release coordinator'));assert(g.nodes.find(n=>n.target==='a')!.detail.includes('Lead orchestrator'));assert(g.nodes.find(n=>n.target==='a')!.detail.includes('Idle'));
});
// J3 tracker items in the work graph (J3-DESIGN.md §6).
const U = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;
function trackerView(links: { subject: { kind: 'task' | 'session'; id: string }; key: string }[], extra: Partial<TrackerView['items'][number]> = {}): TrackerView {
  const keys = [...new Set(links.map(l => l.key))];
  return { version: 1, observedAt: '2026-09-23T00:00:00.000Z', partial: false, projects: [],
    items: keys.map(key => ({ key, projectId: U(0), ref: '#' + key.split(':')[2], title: '<b>x</b> ' + key, state: 'open', labels: [], url: `https://github.com/a/b/issues/${key.split(':')[2]}`, updatedAt: null, stale: false, fromPreviousMapping: false, ...extra })),
    links: links.map((l, i) => ({ id: U(i + 1), itemKey: l.key, subject: l.subject, revision: 1 })) };
}
test('J3-L1: only linked tracker items whose subject is on the graph appear, as tracks edges', () => {
  const d = fleet([node(U(100), U(200)), node(U(101), U(201))]);
  const view = trackerView([{ subject: { kind: 'task', id: U(200) }, key: 'github:1:7' }, { subject: { kind: 'session', id: U(101) }, key: 'github:1:7' }, { subject: { kind: 'task', id: U(999) }, key: 'github:1:8' }]);
  const g = workGraph(d, d.nodes, null, undefined, view);
  const trackers = g.nodes.filter(n => n.kind === 'tracker-issue');
  assert.deepEqual(trackers.map(n => [n.id, n.title, n.url]), [['tracker:github:1:7', '#7 · <b>x</b> github:1:7', 'https://github.com/a/b/issues/7']]);
  assert.deepEqual(g.edges.filter(e => e.kind === 'tracks').map(e => [e.from, e.to, e.active]).sort(), [['session:' + U(101), 'tracker:github:1:7', true], ['task:' + U(200), 'tracker:github:1:7', true]]);
  assert.deepEqual(workGraph(d, d.nodes, null), workGraph(d, d.nodes, null, undefined, undefined));
});
test('J3-L2: previous-mapping links are dashed, stale is labelled, and tracker ceilings hold', () => {
  const d = fleet([node(U(100), U(200))]);
  const old = workGraph(d, d.nodes, null, undefined, trackerView([{ subject: { kind: 'task', id: U(200) }, key: 'github:1:7' }], { fromPreviousMapping: true, stale: true, title: null }));
  assert.equal(old.edges.find(e => e.kind === 'tracks')!.active, false);
  assert.match(old.nodes.find(n => n.kind === 'tracker-issue')!.detail, /STALE · previous mapping/);
  assert.equal(old.nodes.find(n => n.kind === 'tracker-issue')!.title, '#7 · not yet observed');
  const many = trackerView(Array.from({ length: 200 }, (_, i) => ({ subject: { kind: 'task' as const, id: U(200) }, key: `github:1:${i + 1}` })));
  const g = workGraph(d, d.nodes, null, undefined, many);
  assert.equal(g.nodes.filter(n => n.kind === 'tracker-issue').length, TRACKER_LIMITS.nodes);
  assert.ok(g.edges.filter(e => e.kind === 'tracks').length <= TRACKER_LIMITS.edges);
  assert.ok(g.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)));
});
