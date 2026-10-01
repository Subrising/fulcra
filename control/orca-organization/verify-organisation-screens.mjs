// Fulcra J1: Organisation screenshots. External tooling is supplied explicitly (as verify-ui.mjs); nothing is
// installed and no live UI or controller is touched. The real client/organisation.tsx is bundled with react-native
// mapped to react-native-web, fed seeded data through the same useRpc seam the host provides, and rendered in
// headless Chromium with the host's default dark and light plugin theme values (as verify-inbox-screens.mjs).
// Usage: node verify-organisation-screens.mjs <absolute tooling dir with react-native-web + playwright>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { noPersonal } from './shared/cc/refs.mjs';
const root = path.dirname(fileURLToPath(import.meta.url)), require = createRequire(import.meta.url);
const tooling = process.argv[2]; if (!tooling || !path.isAbsolute(tooling)) throw Error('Supply absolute external UI tooling directory');
const ui = createRequire(path.join(tooling, 'package.json')), pkg = name => path.dirname(ui.resolve(`${name}/package.json`));
const out = path.join(root, '..', '..', 'local', 'screens', 'organisation'), work = path.join(root, 'runtime', 'organisation-screens');
fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(work, { recursive: true });
const THEMES = {
  dark: { surface0: '#181B1A', surface1: '#1E2120', surface2: '#272A29', border: '#252B2A', foreground: '#fafafa', foregroundMuted: '#A1A5A4', accent: '#20744A', accentForeground: '#ffffff', statusSuccess: '#6cb17b', statusWarning: '#c09664', statusDanger: '#d8847b' },
  light: { surface0: '#ffffff', surface1: '#fafafa', surface2: '#f4f4f5', border: '#e4e4e7', foreground: '#1a1a1e', foregroundMuted: '#71717a', accent: '#20744A', accentForeground: '#ffffff', statusSuccess: '#3e704a', statusWarning: '#7b5d39', statusDanger: '#9d433b' },
};
// Seeded, plain-language, personal-data free. Obviously fake ids.
const now = Date.now(), iso = ago => new Date(now - ago).toISOString(), M = 60000, H = 3600000;
const id = n => `0f0e0d0c-0b0a-4000-8000-${String(n).padStart(12, '0')}`;
const TALLY = id(1), CC = id(2), ORCA = id(3), MEMORY = id(4), SITE = id(5), W = id(10);
const LEADS = { [TALLY]: id(21), [CC]: id(22) }, DELIVERY = id(31), RESEARCH = id(32);
const seat = (role, s, session) => ({ role, seat: s, projectId: role === 'prime' ? null : s, state: session ? 'assigned' : 'vacant', revision: 1, task: W, sessionId: session, session: null, note: null, at: iso(0), membershipAt: null, sessionPresent: Boolean(session), sessionGenerationChanged: false, sessionTaskMatches: true, dispatch: null, hold: null });
const project = (projectId, name, lead, sessions, running) => ({ projectId, name, status: 'in_progress', seat: lead ? seat('project-orchestrator', projectId, lead) : null, channels: [], workstreams: 1, sessions, running });
const map = { observedAt: iso(15000), available: true, unavailable: null, primes: [seat('prime', 'delivery', DELIVERY), seat('prime', 'research', RESEARCH)],
  projects: [project(TALLY, 'Tally', LEADS[TALLY], 5, 2), project(CC, 'Command Centre', LEADS[CC], 8, 3), project(ORCA, 'Orca platform', null, 2, 0), project(MEMORY, 'Shared memory', null, 0, 0), project(SITE, 'Company website', null, 0, 0)],
  unplaced: [], attention: [], sources: { seats: true, channels: true, projects: { available: true, partial: false, note: '' }, fleet: { available: true, partial: false, observedAt: iso(15000) } }, note: 'Read-only.' };
const node = (nid, title, status) => ({ id: nid, task: W, host: 'mini', agentId: null, title, provider: 'claude', model: null, mode: 'delegated', status, pending: 0, observedAt: null, updatedAt: iso(M), error: null });
const fleet = { observedAt: iso(15000), total: 4, partial: false, note: '', nodes: [node(LEADS[TALLY], 'Tally orchestrator', 'running'), node(LEADS[CC], 'Command Centre orchestrator', 'idle'), node(DELIVERY, 'Release lead', 'idle'), node(RESEARCH, 'Research lead', 'idle')], tasks: [], edges: [] };
const remit = (rid, primeSeat, scope, since, note) => ({ version: 1, id: rid, revision: 1, primeSeat, scope, state: 'active', since, endedAt: null, note });
const owner = (kind, primeSeat, remitId) => ({ kind, primeSeat, remitId });
const R = { tally: id(41), cc: id(42), platform: id(43), site: id(44) };
const tallyRemit = remit(R.tally, 'delivery', { kind: 'project', projectId: TALLY }, iso(26 * H), 'Tally is launch work, and delivery owns every launch this quarter');
const remits = { version: 1, observedAt: iso(15000), partial: false, stale: false, error: null,
  primes: [{ seat: 'delivery', state: 'assigned', sessionId: DELIVERY }, { seat: 'research', state: 'assigned', sessionId: RESEARCH }],
  remits: [tallyRemit,
    remit(R.site, 'delivery', { kind: 'project', projectId: SITE }, iso(M), 'Delivery owns newly recorded projects by default'),
    remit(R.cc, 'delivery', { kind: 'project', projectId: CC }, iso(3 * 24 * H), 'Command Centre is the operator tool the delivery prime uses daily'),
    remit(R.platform, 'research', { kind: 'domain', domain: 'platform', label: 'Platform work' }, iso(5 * 24 * H), 'Research looks after the shared building blocks')],
  domains: [{ projectId: ORCA, domain: 'platform', revision: 1 }, { projectId: MEMORY, domain: 'platform', revision: 1 }],
  projects: [
    { projectId: TALLY, name: 'Tally', domain: null, domainRevision: 0, owner: owner('project', 'delivery', R.tally) },
    { projectId: CC, name: 'Command Centre', domain: null, domainRevision: 0, owner: owner('project', 'delivery', R.cc) },
    { projectId: ORCA, name: 'Orca platform', domain: 'platform', domainRevision: 1, owner: owner('domain', 'research', R.platform) },
    { projectId: MEMORY, name: 'Shared memory', domain: 'platform', domainRevision: 1, owner: owner('domain', 'research', R.platform) },
    { projectId: SITE, name: 'Company website', domain: null, domainRevision: 0, owner: owner('project', 'delivery', R.site) }],
  history: [{ id: id(51), entityId: R.tally, action: 'moved', before: { ...remit(id(40), 'research', { kind: 'project', projectId: TALLY }, iso(9 * 24 * H), 'Research started Tally as an experiment'), state: 'ended', endedAt: iso(26 * H), revision: 2 },
    after: tallyRemit, previousRevision: 1, revision: 1, actor: 'operator', note: 'Tally is launch work, and delivery owns every launch this quarter', at: iso(26 * H) },
    { id: id(52), entityId: id(40), action: 'assigned', before: null, after: remit(id(40), 'research', { kind: 'project', projectId: TALLY }, iso(9 * 24 * H), 'Research started Tally as an experiment'), previousRevision: 0, revision: 1, actor: 'operator', note: 'Research started Tally as an experiment', at: iso(9 * 24 * H) }] };
const story = (projectId, stale) => ({ version: 1, observedAt: iso(15000), partial: false, error: null, projectId, authorName: projectId === TALLY ? 'the Tally orchestrator' : 'the Command Centre orchestrator', stale,
  observed: projectId === TALLY ? { sessionsRunning: 2, sessionsTotal: 5, openDecisions: 1, heldMessages: 0, lastActivityAt: iso(M), observedAt: iso(15000) } : { sessionsRunning: 3, sessionsTotal: 8, openDecisions: 0, heldMessages: 1, lastActivityAt: iso(M), observedAt: iso(15000) },
  brief: projectId === TALLY ? { version: 1, projectId, revision: 7, author: { seat: projectId, sessionId: LEADS[TALLY] }, writtenAt: iso(10 * M), health: 'at-risk', headline: 'Launch may slip by a week while two sign-up problems are fixed.',
    now: 'Testers found two problems with sign-up: some welcome emails arrive late, and the password rules confuse people. Both fixes are being built and checked today.',
    next: [{ text: 'Finish both sign-up fixes and re-test with the same testers', by: '2026-09-26' }, { text: 'Open sign-up to everyone on the waiting list', by: '2026-10-01' }],
    needsYou: [{ text: 'Choose whether to launch on 1 October as planned, or on 8 October with a quieter start', decision: id(61) }],
    risks: [{ text: 'Welcome emails may be slow on launch day', severity: 'high', mitigation: 'A second email service is set up and can take over in minutes' }, { text: 'Support may get more questions in week one', severity: 'medium', mitigation: 'Answers to the ten likeliest questions are written' }],
    shipped: [{ text: 'The new sign-up page, tested by twelve people', ref: null }], evidence: [{ ref: `task:${W}`, label: 'The sign-up work' }] }
    : { version: 1, projectId, revision: 12, author: { seat: projectId, sessionId: LEADS[CC] }, writtenAt: iso(30 * H), health: 'on-track', headline: 'The one inbox is finished; the organisation view is being built.',
      now: 'Decisions from every project now land in one inbox. The organisation view is being built next.', next: [{ text: 'Finish the organisation view', by: null }], needsYou: [], risks: [], shipped: [], evidence: [] } });
const data = { 'organization.work-map': map, 'organization.fleet': fleet, 'organization.remits': remits,
  [`organization.fleet:${TALLY}`]: { ...fleet, nodes: fleet.nodes.filter(n => n.id === LEADS[TALLY]) },
  [`organization.fleet:${CC}`]: { ...fleet, nodes: fleet.nodes.filter(n => n.id === LEADS[CC]) },
  [`organization.project-brief:${TALLY}`]: story(TALLY, false), [`organization.project-brief:${CC}`]: story(CC, true) };
// The screenshot secret gate (CONTRACTS §1a): nothing personal or host-specific may be rendered.
(function gate(v, where = 'seed') { if (typeof v === 'string') { if (!noPersonal(v)) throw Error(`Seed data at ${where} is not personal-data free`); } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) gate(x, `${where}.${k}`); })(data);
fs.writeFileSync(path.join(work, 'plugin-client.mjs'), `export const useRpc = definition => async input => { const key = input && input.projectId ? definition.name + ':' + input.projectId : definition.name; const value = window.__org[key] ?? window.__org[definition.name]; if (!value) throw new Error('No seed for ' + key); return value; };
export const useTheme = () => null;
`);
fs.writeFileSync(path.join(work, 'plugin-react-native.mjs'), 'export const copyText = async () => {};\nexport const PanSurface = undefined;\nexport const PanScrollView = undefined;\n');
fs.writeFileSync(path.join(work, 'plugin.mjs'), 'export const defineRpc = definition => definition;\n');
// Plain .jsx on purpose: tsconfig includes every **/*.tsx, and a generated file must never join the typecheck.
fs.writeFileSync(path.join(work, 'entry.jsx'), `import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrganisationSurface } from '../../client/organisation';
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const theme = { colors: window.__theme };
const compact = window.innerWidth < 600;
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}><OrganisationSurface theme={theme} layout={{ compact, platform: compact ? 'ios' : 'web' }} host={{ id: 'screens' }} /></div></QueryClientProvider>);
`);
const { build } = require('esbuild');
const exact = { '@getpaseo/plugin/client': 'plugin-client.mjs', '@getpaseo/plugin/client/react-native': 'plugin-react-native.mjs', '@getpaseo/plugin': 'plugin.mjs' };
await build({ entryPoints: [path.join(work, 'entry.jsx')], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: path.join(work, 'bundle.js'), logLevel: 'error',
  define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
  alias: { 'react-native': pkg('react-native-web'), react: pkg('react'), 'react-dom': pkg('react-dom') },
  plugins: [{ name: 'host-sdk-seams', setup(b) { b.onResolve({ filter: /^@getpaseo\/plugin(\/client(\/react-native)?)?$/ }, a => ({ path: path.join(work, exact[a.path]) })); } }] });
const bundle = fs.readFileSync(path.join(work, 'bundle.js'), 'utf8');
const { chromium } = ui('playwright');
const browser = await chromium.launch();
const shots = [];
try {
  for (const [name, colors] of Object.entries(THEMES)) for (const [w, h] of [[1280, 800], [390, 844]]) {
    const compact = w < 600, base = `organisation-${name}-${w}x${h}`;
    const page = await browser.newPage({ viewport: { width: w, height: h }, colorScheme: name, deviceScaleFactor: compact ? 2 : 1 });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;height:100%;background:${colors.surface0};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}</style></head><body><div id="root"></div></body></html>`);
    await page.evaluate(([d, t]) => { window.__org = d; window.__theme = t; }, [data, colors]);
    await page.addScriptTag({ content: bundle });
    await page.getByTestId(`org-project-${TALLY}`).waitFor();
    // Captured at the full height of the scrolling content, so nothing is cut off.
    const full = async suffix => {
      const height = await page.evaluate(() => Math.max(...[...document.querySelectorAll('div')].map(d => d.scrollHeight)));
      await page.setViewportSize({ width: w, height: Math.max(h, height) });
      await page.screenshot({ path: path.join(out, `${base}${suffix}.png`) });
      await page.setViewportSize({ width: w, height: h });
      shots.push(`${base}${suffix}.png`);
    };
    if (compact) { await page.screenshot({ path: path.join(out, `${base}.png`) }); shots.push(`${base}.png`); }
    await page.getByTestId(`org-project-${TALLY}`).click();
    await page.getByText('Launch may slip by a week', { exact: false }).waitFor();
    if (!noPersonal(await page.locator('body').innerText())) throw Error('Rendered Organisation privacy gate failed');
    if (compact) await full('-story'); else { await page.screenshot({ path: path.join(out, `${base}.png`) }); shots.push(`${base}.png`); }
    await page.getByTestId('org-remit-edit-open').click();
    await page.getByTestId('org-remit-edit').waitFor();
    await page.getByTestId('org-remit-prime-research').click();
    await page.getByTestId('org-remit-reason').fill('Research is taking over all platform and launch work next month');
    await full('-remit');
    if (compact) { await page.getByTestId('org-back').click(); await page.getByTestId('org-tree').waitFor(); }
    await page.getByTestId(`org-project-${CC}`).click();
    await page.getByText('May be out of date').first().waitFor();
    const storyTop = await page.getByTestId('org-story').boundingBox();
    if (!storyTop || storyTop.y < 0 || storyTop.y > h / 2) throw Error('Project story did not open at the top');
    await page.screenshot({ path: path.join(out, `${base}-story-top.png`) });
    shots.push(`${base}-story-top.png`);
    await full('-stale');
    if (errors.length) throw Error(`Render errors: ${errors.join('; ')}`);
    await page.close();
  }
} finally { await browser.close(); }
console.log(JSON.stringify({ screens: shots.map(s => `../../local/screens/organisation/${s}`) }, null, 2));
