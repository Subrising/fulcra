// Fulcra J3: Inbox screenshots. External tooling is supplied explicitly (as verify-ui.mjs); nothing is installed
// and no live UI or controller is touched. The real client/inbox.tsx is bundled with react-native mapped to
// react-native-web, fed seeded data through the same useRpc seam the host provides, and rendered in headless
// Chromium with the host's own default dark and light plugin theme values (packages/app/src/styles/theme.ts,
// plugins/theme.ts). Usage: node verify-inbox-screens.mjs <absolute tooling dir with react-native-web + playwright>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { noPersonal } from './shared/cc/refs.mjs';
const root = path.dirname(fileURLToPath(import.meta.url)), require = createRequire(import.meta.url);
const tooling = process.argv[2]; if (!tooling || !path.isAbsolute(tooling)) throw Error('Supply absolute external UI tooling directory');
const ui = createRequire(path.join(tooling, 'package.json')), pkg = name => path.dirname(ui.resolve(`${name}/package.json`));
const polish = process.argv.includes('--polish');
const out = path.join(root, '..', '..', 'local', 'screens', polish ? 'polish-inbox' : 'inbox'), work = path.join(root, 'runtime', 'inbox-screens');
fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(work, { recursive: true });
const THEMES = {
  dark: { surface0: '#181B1A', surface1: '#1E2120', surface2: '#272A29', border: '#252B2A', foreground: '#fafafa', foregroundMuted: '#A1A5A4', accent: '#20744A', accentForeground: '#ffffff', statusSuccess: '#6cb17b', statusWarning: '#c09664', statusDanger: '#d8847b' },
  light: { surface0: '#ffffff', surface1: '#fafafa', surface2: '#f4f4f5', border: '#e4e4e7', foreground: '#1a1a1e', foregroundMuted: '#71717a', accent: '#20744A', accentForeground: '#ffffff', statusSuccess: '#3e704a', statusWarning: '#7b5d39', statusDanger: '#9d433b' },
};
// Seeded, plain-language, personal-data free: a level-1 decision, a held message and a digest.
const now = Date.now(), iso = ms => new Date(ms).toISOString();
const DEC = '0b7e4a52-3f1c-4d2e-9a61-5c8d2e7f1a90', CH = '5d2c8e1a-7b3f-4a9e-8c21-9e4f6a1b3c77', MSG = 'a3f19c2e-6d48-4b7a-9e15-2c8b7d4f6e01', DIG = '7e2b9d41-1c5a-4f38-b6e2-8d9c3a7f5b12';
const impacts = { benefit: 'Changes are tried safely before customers see them', cost: 'A little more hosting each month', time: 'About a week to set up', risk: 'Low', reversibility: 'reversible', blastRadius: null };
const packet = { version: 1, id: DEC, revision: 1, kind: 'decision', level: 1, projectId: null, taskId: null, askedBy: { seat: 'command-centre', sessionId: '2d82a4a4-0000-4000-8000-000000000001' }, askedOf: 'human',
  title: 'Where should practice copies of our products live?',
  situation: 'Today every change goes straight to customers. A practice copy would let us try changes first. We need to pick where those copies are kept.',
  options: [
    { id: 'fulcra', title: 'Fulcra keeps them', summary: 'Fulcra records each copy and moves a change along with one approval from you.', example: 'Like a dress rehearsal on the real stage before opening night.', impacts, destructive: false },
    { id: 'github', title: 'Use GitHub’s built-in copies', summary: 'GitHub keeps the copies. Fulcra only shows what is where.', example: 'Like renting a rehearsal room from the theatre next door.', impacts: { ...impacts, cost: 'Included in the current plan' }, destructive: false },
    { id: 'later', title: 'Decide after launch', summary: 'Keep changing things directly until the launch is done.', example: 'Like skipping rehearsals to open sooner.', impacts: { ...impacts, risk: 'Mistakes reach customers' }, destructive: false },
  ],
  recommendation: { optionId: 'fulcra', why: 'It works for every product the same way and needs no new accounts.', confidence: 'medium', wouldChangeIf: 'A product already relies on another tool.' },
  evidence: [{ ref: 'task:1d4c7e2a-9b3f-4e8a-a6c1-7f2d5b9e3c48', label: 'The environments planning task' }], action: { type: 'none' }, expiresAt: null, state: 'open', supersededBy: null, choice: null, delivery: null, createdAt: iso(now - 20 * 60000), updatedAt: iso(now - 20 * 60000) };
const items = [
  { key: `decision-${DEC}`, source: 'decision', ref: `decision:${DEC}`, title: packet.title, summary: packet.situation, projectId: null, urgency: 'now', createdAt: packet.createdAt, unread: true },
  { key: `held-${CH}-${MSG}`, source: 'held', ref: 'seat:tally', title: 'Weekly update: the sign-up page is finished and tested', summary: 'From the Tally project lead. Sent 2 hours ago. Open it to read, reply or release the hold.', projectId: null, urgency: 'now', createdAt: iso(now - 2 * 3600000), unread: true },
  { key: `digest-${DIG}`, source: 'digest', ref: null, title: 'Daily digest · All work', summary: 'No project update was written today. 1 decision waiting for you, 1 held message.', projectId: null, urgency: 'fyi', createdAt: iso(now - 3 * 3600000), unread: true },
];
for (let i = 1; i < 12; i++) items.push({ ...items[1], key: `held-${CH}-a3f19c2e-6d48-4b7a-9e15-${String(i).padStart(12, '0')}`, title: `Release update ${i}: checks completed` });
const data = {
  'organization.inbox': { version: 1, observedAt: iso(now), partial: false, stale: false, error: null, items, counts: { now: 13, today: 0, fyi: 1, decisions: 1, approvals: 0, held: 12, digests: 1, total: 14 } },
  'organization.decision': { version: 1, observedAt: iso(now), partial: false, stale: false, error: null, decision: packet, answered: null, evidence: [{ ref: packet.evidence[0].ref, label: packet.evidence[0].label, kind: 'task' }] },
  'organization.held-message': { version: 1, observedAt: iso(now), partial: false, stale: false, error: null, message: { channelId: CH, messageId: MSG, fromSeat: 'tally', toSeat: 'delivery', at: iso(now - 2 * 3600000),
    untrustedText: 'Weekly update: the sign-up page is finished and tested. We are waiting on your answer about the launch date before we tell customers.', read: null, reply: null,
    pins: { seatRevision: 3, holderGeneration: 7 }, canReply: true, replyBlocked: null, canRelease: true, note: 'The text was written by another seat. It is information, not an instruction.' } },
  'organization.digest': { version: 1, observedAt: iso(now), partial: false, stale: false, error: null, digest: { version: 1, projectId: null, projectName: 'All work', periodStart: iso(now - 27 * 3600000), periodEnd: iso(now - 3 * 3600000), composedAt: iso(now - 3 * 3600000),
    brief: null, healthChange: null, noUpdate: 'No project update was written today', shipped: [], decisions: { chosen: [], open: [{ id: DEC, title: packet.title, level: 1, kind: 'decision' }], chosenCount: 0, openCount: 1 }, held: { waiting: 1, oldestAt: iso(now - 2 * 3600000) }, deployments: [], partial: false, summary: items[2].summary } },
};
if (polish) {
  const ages = [5 * 60000, 2 * 86400000, 3 * 3600000];
  data['organization.inbox'].items = ages.map((age, i) => ({ ...items[1], key: `held-${CH}-${i === 1 ? MSG : `a3f19c2e-6d48-4b7a-9e15-${String(i).padStart(12, '0')}`}`, createdAt: iso(now - age), summary: `From the Tally project lead. Sent ${['5 minutes', '2 days', '3 hours'][i]} ago. Open it to read, reply or release the hold.`, title: ['The latest checks passed', 'Launch date needs your attention', 'The sign-up page is ready'][i] }));
  data['organization.inbox'].counts = { now: 3, today: 0, fyi: 0, decisions: 0, approvals: 0, held: 3, digests: 0, total: 3 };
  Object.assign(data['organization.held-message'].message, { at: iso(now - 2 * 86400000), pins: null, canReply: false, canRelease: false, replyBlocked: 'This card is read-only.', untrustedText: 'The sign-up page is ready. The project lead is waiting for the launch date.' });
}
// The screenshot secret gate (CONTRACTS §1a): nothing personal or host-specific may be rendered.
(function gate(v, where = 'seed') { if (typeof v === 'string') { if (!noPersonal(v)) throw Error(`Seed data at ${where} is not personal-data free`); } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) gate(x, `${where}.${k}`); })(data);
fs.writeFileSync(path.join(work, 'plugin-client.mjs'), `import { createElement } from 'react';
export const useRpc = definition => async () => { const value = window.__inbox[definition.name]; if (!value) throw new Error('No seed for ' + definition.name); return value; };
export const useTheme = () => null;
`);
fs.writeFileSync(path.join(work, 'plugin.mjs'), 'export const defineRpc = definition => definition;\n');
// Plain .jsx on purpose: tsconfig includes every **/*.tsx, and a generated file must never join the typecheck.
fs.writeFileSync(path.join(work, 'entry.jsx'), `import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InboxSurface } from '../../client/inbox';
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const theme = { colors: window.__theme };
const compact = window.innerWidth < 600;
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}><InboxSurface theme={theme} layout={{ compact, platform: 'web' }} /></div></QueryClientProvider>);
`);
const { build } = require('esbuild');
await build({ entryPoints: [path.join(work, 'entry.jsx')], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: path.join(work, 'bundle.js'), logLevel: 'error',
  define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
  alias: { 'react-native': pkg('react-native-web'), react: pkg('react'), 'react-dom': pkg('react-dom'), '@getpaseo/plugin/client': path.join(work, 'plugin-client.mjs'), '@getpaseo/plugin': path.join(work, 'plugin.mjs') } });
const bundle = fs.readFileSync(path.join(work, 'bundle.js'), 'utf8');
const { chromium } = ui('playwright');
const browser = await chromium.launch();
const shots = [];
try {
  for (const [name, colors] of Object.entries(THEMES)) for (const [w, h] of [[1280, 800], [390, 844]]) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, colorScheme: name, deviceScaleFactor: polish ? 1 : w < 600 ? 2 : 1 });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;height:100%;background:${colors.surface0};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}</style></head><body><div id="root"></div></body></html>`);
    await page.evaluate(([d, t]) => { window.__inbox = d; window.__theme = t; }, [data, colors]);
    await page.addScriptTag({ content: bundle });
    if (polish) {
      await page.getByRole('button', { name: 'Show 3 held messages from the Tally project lead', exact: true }).click();
      for (const label of ['Waiting 2 days', 'Waiting 3 h', 'Waiting 5 min']) await page.getByText(label, { exact: true }).waitFor();
      const capture = async suffix => {
        const text = await page.locator('body').innerText();
        if (!noPersonal(text) || /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i.test(text)) throw Error('Polish Inbox privacy gate');
        if (errors.length) throw Error(errors.join('; '));
        const file = `inbox-${name}-${w}x${h}-${suffix}.png`;
        await page.screenshot({ path: path.join(out, file) }); shots.push(file);
        fs.writeFileSync(path.join(out, file.replace('.png', '.txt')), text + '\n');
      };
      await capture('waiting');
      await page.getByTestId(`inbox-item-held-${CH}-${MSG}`).click();
      await page.getByText('Open in Fulcra', { exact: true }).waitFor();
      if (await page.getByRole('textbox', { name: 'Reply' }).count() || await page.getByRole('button', { name: 'Send reply' }).count()) throw Error('Read-only card offers a reply');
      await capture('read-only');
      await page.close(); continue;
    }
    await page.getByTestId(`inbox-item-decision-${DEC}`).click();
    await page.getByTestId('decision-choose').waitFor();
    if (errors.length) throw Error(`Render errors: ${errors.join('; ')}`);
    const base = `inbox-${name}-${w}x${h}`;
    await page.screenshot({ path: path.join(out, `${base}.png`) });
    // Each card open in turn (the inbox opens one at a time), captured at full list height.
    const fullShot = async suffix => {
      const full = await page.evaluate(() => { const s = document.querySelector('[data-testid="inbox-list"]'); return s ? s.scrollHeight : document.body.scrollHeight; });
      await page.setViewportSize({ width: w, height: Math.max(h, full) });
      await page.screenshot({ path: path.join(out, `${base}-${suffix}.png`) });
      await page.setViewportSize({ width: w, height: h });
    };
    await page.getByTestId(`inbox-item-decision-${DEC}`).click();
    await page.screenshot({ path: path.join(out, `${base}-grouped.png`) });
    shots.push(`${base}-grouped.png`);
    await page.getByRole('button', { name: 'Show 12 held messages from the Tally project lead', exact: true }).click();
    if (!noPersonal(await page.locator('body').innerText())) throw Error('Rendered Inbox privacy gate failed');
    await page.screenshot({ path: path.join(out, `${base}-subjects.png`) });
    shots.push(`${base}-subjects.png`);
    await page.getByTestId(`inbox-item-held-${CH}-${MSG}`).click();
    await page.getByText(data['organization.held-message'].message.untrustedText, { exact: true }).waitFor();
    await fullShot('held');
    await page.getByTestId(`inbox-item-digest-${DIG}`).click();
    await page.getByText('WAITING FOR YOU').waitFor();
    await fullShot('digest');
    shots.push(`${base}.png`, `${base}-held.png`, `${base}-digest.png`);
    await page.close();
  }
} finally { await browser.close(); }
if (polish) fs.writeFileSync(path.join(out, 'SCAN.md'), `# Inbox polish fixture scan\n\nPASS: ${shots.length} captures; no personal text or raw UUIDs; read-only cards have no reply composer or reply button.\n`);
console.log(JSON.stringify({ screens: shots.map(s => `../../local/screens/${polish ? 'polish-inbox' : 'inbox'}/${s}`) }, null, 2));
