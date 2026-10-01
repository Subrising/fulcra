// Component-render screenshots of the Environments tab (J8), with the privacy gate.
//   node verify-screens-environments.mjs <absolute tooling folder> [output folder]
// The tooling folder provides react, react-dom, react-native-web and playwright (with its browser installed). This
// script installs nothing and touches no running app or host. It renders the real EnvironmentsSurface with the
// fictional fixture (screens/environments-fixture.mjs) at 1280x800 and 390x844, dark and light, in two states
// (waiting for approval; after an automatic rollback), and scans every rendered label with personalMatch from
// shared/cc/refs.mjs (CONTRACTS §1a). Any hit, or any read the fixture does not answer, fails the run. It presses nothing.
// The shims and the entry are virtual modules here, so this file adds nothing under screens/ except its fixture.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url)), require = createRequire(import.meta.url);
const tooling = process.argv[2]; if (!tooling || !path.isAbsolute(tooling)) throw Error('Supply the absolute UI tooling folder');
const out = path.resolve(process.argv[3] ?? path.join(root, '../../local/screens/environments'));
const ui = createRequire(path.join(tooling, 'package.json'));
const { build } = require('esbuild');
const SIZES = [{ width: 1280, height: 800, compact: false }, { width: 390, height: 844, compact: true }];
const SCHEMES = ['dark', 'light'];
const STATES = ['waiting', 'rolled-back'];
// The Fulcra app's own theme tokens (packages/app/src/styles/theme.ts via plugins/theme.ts): the default dark tint and light.
const THEMES = {
  dark: { surface0: '#181B1A', surface1: '#1E2120', surface2: '#272A29', border: '#252B2A', foreground: '#fafafa', foregroundMuted: '#A1A5A4', accent: '#20744A', accentForeground: '#ffffff', statusSuccess: '#6cb17b', statusWarning: '#c09664', statusDanger: '#d8847b' },
  light: { surface0: '#ffffff', surface1: '#fafafa', surface2: '#f4f4f5', border: '#e4e4e7', foreground: '#1a1a1e', foregroundMuted: '#71717a', accent: '#20744A', accentForeground: '#ffffff', statusSuccess: '#3e704a', statusWarning: '#7b5d39', statusDanger: '#9d433b' },
};
const VIRTUAL = {
  'plugin': 'export const defineRpc = d => d;',
  'plugin-client': `import { answer } from "virtual:answer"; export function useRpc(definition) { return input => answer(definition.name, input); }`,
  'plugin-react-native': 'import { View, ScrollView } from "react-native"; export const PanSurface = View; export const PanScrollView = ScrollView; export async function copyText() {}',
  'answer': `import { view, projects, awaiting, environments, NEXT } from ${JSON.stringify(path.join(root, 'screens/environments-fixture.mjs'))};
    export const refused = new Set();
    const state = new URLSearchParams(location.search).get("state");
    const rolledBack = () => { const at = new Date().toISOString();
      const p = { ...awaiting, promotion: { ...awaiting.promotion, state: "rolled-back", revision: 9, log: [...awaiting.promotion.log,
        { at, step: "deploy", line: "Approved on the owner's paired device; starting" }, { at, step: "deploy", line: "deploying next" }, { at, step: "deploy", line: "deploy finished" },
        { at, step: "verify", line: "checking" }, { at, step: "verify", line: "verify failed" }, { at, step: "rollback", line: "putting the old version back" },
        { at, step: "rollback", line: "A step failed, so the previous version was put back" }] } };
      const envs = environments.map(e => e.id !== NEXT ? e : { ...e, health: "attention", latest: { ...e.current, id: "00000099-0000-4000-8000-000000000099", status: "rolled-back", at, note: "A step failed, so the previous version was put back", version: { commit: awaiting.promotion.commit, tag: null } } });
      return view({ environments: envs, promotions: [p] }); };
    export function answer(name) {
      if (name === "organization.projects") return Promise.resolve(projects());
      if (name === "organization.environments") return Promise.resolve(state === "rolled-back" ? rolledBack() : view());
      refused.add(name); return Promise.reject(new Error("No screenshot fixture for " + name));
    }`,
  'entry': `import React from "react"; import { createRoot } from "react-dom/client"; import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
    import { View } from "react-native"; import { EnvironmentsSurface } from ${JSON.stringify(path.join(root, 'client/environments.tsx'))}; import { refused } from "virtual:answer";
    const p = new URLSearchParams(location.search), colors = ${JSON.stringify(THEMES)}[p.get("scheme")], theme = { colors };
    document.documentElement.style.background = document.body.style.background = colors.surface0;
    createRoot(document.getElementById("root")).render(React.createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      React.createElement(View, { style: { height: "100vh", backgroundColor: colors.surface0 } }, React.createElement(EnvironmentsSurface, { theme, host: { id: "host-demo", label: "Demo" }, layout: { compact: p.get("compact") === "1", platform: "web" } }))));
    window.__refused = () => [...refused];`,
};
const aliases = { name: 'environments-screens', setup(b) {
  b.onResolve({ filter: /^virtual:/ }, a => ({ path: a.path.slice(8), namespace: 'virtual' }));
  b.onResolve({ filter: /^@getpaseo\/plugin$/ }, () => ({ path: 'plugin', namespace: 'virtual' }));
  b.onResolve({ filter: /^@getpaseo\/plugin\/client$/ }, () => ({ path: 'plugin-client', namespace: 'virtual' }));
  b.onResolve({ filter: /^@getpaseo\/plugin\/client\/react-native$/ }, () => ({ path: 'plugin-react-native', namespace: 'virtual' }));
  b.onResolve({ filter: /^react-native$/ }, () => ({ path: ui.resolve('react-native-web') }));
  b.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, a => ({ path: ui.resolve(a.path) }));
  b.onLoad({ filter: /.*/, namespace: 'virtual' }, a => ({ contents: VIRTUAL[a.path], loader: 'js', resolveDir: root }));
} };
const runtime = path.join(root, 'runtime', 'screens-environments'); fs.mkdirSync(runtime, { recursive: true });
const bundle = await build({ entryPoints: ['virtual:entry'], bundle: true, platform: 'browser', format: 'iife', write: false, plugins: [aliases], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' });
const page = path.join(runtime, 'index.html');
fs.writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#root{margin:0;height:100%}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`);
await build({ entryPoints: [path.join(root, 'shared/cc/refs.mjs')], bundle: true, platform: 'node', format: 'esm', outfile: path.join(runtime, 'refs.mjs'), logLevel: 'warning' });
const { personalMatch } = await import(pathToFileURL(path.join(runtime, 'refs.mjs')).href);

const { chromium } = ui('playwright');
const browser = await chromium.launch(), results = [];
fs.mkdirSync(out, { recursive: true });
try {
  for (const state of STATES) for (const size of SIZES) for (const scheme of SCHEMES) {
    const tab = await browser.newPage({ viewport: { width: size.width, height: size.height }, colorScheme: scheme, deviceScaleFactor: 1 });
    try {
      await tab.goto(`${pathToFileURL(page).href}?scheme=${scheme}&compact=${size.compact ? 1 : 0}&state=${state}`);
      await tab.waitForSelector('[data-testid="env-row-next"]', { timeout: 15000 });
      await tab.getByText(state === 'waiting' ? 'Waiting for your approval' : 'the previous version was put back', { exact: false }).first().waitFor({ timeout: 15000 });
      await tab.waitForTimeout(300);
      const name = `environments-${state}-${size.width}x${size.height}-${scheme}`;
      await tab.screenshot({ path: path.join(out, `${name}.png`) });
      const entries = await tab.evaluate(() => {
        const seen = new Map();
        const add = (t, inView) => { const c = (t ?? '').replace(/\s+/g, ' ').trim(); if (c) seen.set(c, (seen.get(c) ?? false) || inView); };
        for (const el of document.body.querySelectorAll('*')) {
          const box = el.getBoundingClientRect(), style = getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none') continue;
          const inView = box.bottom >= 0 && box.top <= innerHeight;
          if (![...el.childNodes].some(n => n.nodeType === 1)) add(el.textContent, inView);
          add(el.getAttribute('aria-label'), inView);
        }
        return [...seen].map(([text, inView]) => ({ text, inView }));
      });
      const findings = entries.flatMap((e, at) => { const kind = personalMatch(e.text); return kind ? [{ kind, at, inView: e.inView }] : []; });
      const refused = await tab.evaluate(() => window.__refused());
      fs.writeFileSync(path.join(out, `${name}.labels.json`), JSON.stringify({ capture: `${name}.png`, viewport: size, scheme, state, labels: entries, personal: findings, refused }, null, 2) + '\n');
      results.push({ name, labels: entries.length, findings, refused });
    } finally { await tab.close(); }
  }
} finally { await browser.close(); }
const failed = results.filter(r => r.findings.length || r.refused.length);
fs.writeFileSync(path.join(out, 'SCAN.md'), `# Environments screenshots: privacy scan

Component renders of the real Environments tab with fictional data (\`verify-screens-environments.mjs\`), not captures
of a running app. Every label the tab renders (in view or below the fold) is scanned with \`personalMatch\` from
\`shared/cc/refs.mjs\` (CONTRACTS §1a).

**Result: ${failed.length ? 'FAIL' : 'PASS'}** (${results.length} captures)

| Capture | Labels | Personal-data hits | Reads without a fixture |
|---|---|---|---|
${results.map(r => `| ${r.name}.png | ${r.labels} | ${r.findings.length ? r.findings.map(f => f.kind).join(', ') : 'none'} | ${r.refused.length ? r.refused.join(', ') : 'none'} |`).join('\n')}
`);
for (const r of results) console.log(`${r.findings.length || r.refused.length ? 'FAIL' : 'PASS'} ${r.name} (${r.labels} labels)`);
console.log(`${failed.length ? 'FAIL' : 'PASS'}: ${results.length} captures in ${path.relative(root, out) || out}`);
if (failed.length) process.exitCode = 1;
