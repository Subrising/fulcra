// Component-render screenshots of the Command Centre tabs, with the privacy gate (J0).
//   node verify-screens.mjs <absolute tooling folder> [output folder]
// The tooling folder provides react, react-dom, react-native-web and playwright (with its browser installed); this
// script installs nothing and touches no running app. It renders the real surface (client/organization.tsx) with
// fictional fixtures (screens/fixtures.mjs) at 1280x800 and 390x844, dark and light, for every ready tab, and
// scans each capture's transcript (every text node, input value and accessible name, in view or not) with personalMatch
// from shared/cc/refs.ts (the §1a patterns, anchored token rule). Any hit, or any read the fixtures do not answer, fails the run. It clicks only the tab being
// captured, by its test id.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url)), require = createRequire(import.meta.url);
const tooling = process.argv[2]; if (!tooling || !path.isAbsolute(tooling)) throw Error('Supply the absolute UI tooling folder');
const out = path.resolve(process.argv[3] ?? path.join(root, '../../local/screens/foundation'));
const ui = createRequire(path.join(tooling, 'package.json'));
const { build } = require('esbuild');

const SIZES = [{ width: 1280, height: 800, compact: false }, { width: 390, height: 844, compact: true }];
const SCHEMES = ['dark', 'light'];
// What each ready tab shows once its reads have answered (fixture text), so a capture is never of a loading state.
// C1: Organisation opens on J1's organisation view; "Checked …" shows once its reads have answered.
// C1: the Trackers tab is J4's TrackingSurface, captured with its own fixtures by verify-tracker-screens.mjs.
const READY_TEXT = { organisation: 'Checked ', sessions: 'Your work, at a glance', changes: 'Make checkout easier to follow' };

const shim = name => path.join(root, 'screens/shims', name);
const aliases = { name: 'screens-aliases', setup(b) {
  // Server helpers used by fictional fixtures must never load machine configuration in the browser.
  b.onResolve({ filter: /^\.\/portable$/ }, args => args.importer.endsWith('/server/session-steps.ts') ? ({ path: shim('portable.mjs') }) : undefined);
  b.onResolve({ filter: /^react-native$/ }, () => ({ path: ui.resolve('react-native-web') }));
  b.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, args => ({ path: ui.resolve(args.path) }));
  b.onResolve({ filter: /^@getpaseo\/plugin$/ }, () => ({ path: shim('plugin.mjs') }));
  b.onResolve({ filter: /^@getpaseo\/plugin\/client$/ }, () => ({ path: shim('plugin-client.mjs') }));
  b.onResolve({ filter: /^@getpaseo\/plugin\/client\/react-native$/ }, () => ({ path: shim('plugin-react-native.mjs') }));
} };
const runtime = path.join(root, 'runtime', 'screens'); fs.mkdirSync(runtime, { recursive: true });
const bundle = await build({ entryPoints: [path.join(root, 'screens/entry.mjs')], bundle: true, platform: 'browser', format: 'iife', write: false, plugins: [aliases],
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.js': 'jsx' }, logLevel: 'warning' });
const page = path.join(runtime, 'index.html');
fs.writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#root{margin:0;height:100%}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`);
// The one §1a check, bundled from the shared contract file itself rather than copied.
await build({ entryPoints: [path.join(root, 'shared/cc/refs.ts')], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: path.join(runtime, 'refs.mjs'), logLevel: 'warning' });
const { personalMatch } = await import(pathToFileURL(path.join(runtime, 'refs.mjs')).href);

// J0-6: what the gate reads. Every text node (so text beside a nested <Text> is not missed), the joined text of
// mixed-content elements (so a path split across nodes is still seen), input and textarea values, and the
// accessible name, placeholder and title. In view or below the fold; `inView` records what the image shows.
const COLLECT = () => {
  const seen = new Map();
  const add = (t, inView) => { const clean = (t ?? '').replace(/\s+/g, ' ').trim(); if (clean) seen.set(clean, (seen.get(clean) ?? false) || inView); };
  const inViewOf = el => { const b = el.getBoundingClientRect(); return b.bottom >= 0 && b.top <= innerHeight; };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.parentElement && n.parentElement.tagName !== 'SCRIPT') add(n.nodeValue, inViewOf(n.parentElement));
  for (const el of document.body.querySelectorAll('*')) {
    if (el.tagName === 'SCRIPT') continue;
    const kids = [...el.childNodes];
    if (kids.some(k => k.nodeType === 3 && k.nodeValue.trim()) && kids.some(k => k.nodeType === 1)) add(el.textContent, inViewOf(el));
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') add(el.value, inViewOf(el));
    for (const attr of ['aria-label', 'placeholder', 'title']) add(el.getAttribute(attr), inViewOf(el));
  }
  return [...seen].map(([text, inView]) => ({ text, inView }));
};
// The gate proves itself first: a nested-text page (as React Native renders <Text>a <Text>b</Text> c</Text>) and an
// input value, each hiding a personal path, must both be caught, or no capture is trusted.
async function gateSelfCheck(browser) {
  const tab = await browser.newPage();
  try {
    await tab.setContent('<div><span>Owner: <span style="font-weight:600">notes</span> kept in /Users/someone/vault</span><input value="/Volumes/disk/secret"></div>');
    const texts = (await tab.evaluate(COLLECT)).map(e => e.text);
    const caught = [texts.some(t => /kept in \/Users\//.test(t) && personalMatch(t)), texts.some(t => t.startsWith('/Volumes/') && personalMatch(t))];
    if (!caught.every(Boolean)) throw Error(`The privacy gate missed its own nested-text fixture (${caught}); no capture is trusted`);
  } finally { await tab.close(); }
}
const { chromium } = ui('playwright');
const browser = await chromium.launch();
await gateSelfCheck(browser);
const pillars = process.argv[4] ? [process.argv[4]] : Object.keys(READY_TEXT), results = [];
if (pillars.some(p => !Object.hasOwn(READY_TEXT, p))) throw Error("Unknown fixture pillar");
fs.mkdirSync(out, { recursive: true });
try {
  for (const size of SIZES) for (const scheme of SCHEMES) for (const pillar of pillars) {
    const tab = await browser.newPage({ viewport: { width: size.width, height: size.height }, colorScheme: scheme, deviceScaleFactor: 1 });
    try {
      await tab.goto(`${pathToFileURL(page).href}?scheme=${scheme}&compact=${size.compact ? 1 : 0}`);
      await tab.waitForSelector('[data-testid="organization-tab-organisation"]', { timeout: 15000 });
      // Read-only by construction: the only control pressed is this pillar's own tab.
      const target = `[data-testid="organization-tab-${pillar}"]`;
      if (!/^\[data-testid="organization-tab-(organisation|sessions|trackers|changes)"\]$/.test(target)) throw Error(`refused to press ${target}`);
      await tab.click(target);
      await tab.getByText(READY_TEXT[pillar], { exact: false }).first().waitFor({ timeout: 15000 });
      await tab.waitForTimeout(400);
      const name = `${pillar}-${size.width}x${size.height}-${scheme}`;
      await tab.screenshot({ path: path.join(out, `${name}.png`) });
      const entries = await tab.evaluate(COLLECT);
      const labels = entries.map(e => e.text);
      const findings = entries.flatMap((e, at) => { const kind = personalMatch(e.text); return kind ? [{ kind, at, inView: e.inView }] : []; });
      const reads = await tab.evaluate(() => window.__fixtureReads());
      fs.writeFileSync(path.join(out, `${name}.labels.json`), JSON.stringify({ capture: `${name}.png`, viewport: size, scheme, pillar, labels: entries, personal: findings, reads }, null, 2) + '\n');
      results.push({ name, labels: labels.length, findings, refused: reads.refused });
    } finally { await tab.close(); }
  }
} finally { await browser.close(); }

const failed = results.filter(r => r.findings.length || r.refused.length);
const rows = results.map(r => `| ${r.name}.png | ${r.labels} | ${r.findings.length ? r.findings.map(f => f.kind).join(', ') : 'none'} | ${r.refused.length ? r.refused.join(', ') : 'none'} |`);
fs.writeFileSync(path.join(out, 'SCAN.md'), `# Command Centre screenshots: privacy scan

Component renders of the real surface with fictional data (\`verify-screens.mjs\`), not captures of a running app.
Each capture's label transcript (everything the tab renders, in view or below the fold) is scanned with
\`personalMatch\` from \`shared/cc/refs.ts\` (CONTRACTS §1a).

**Result: ${failed.length ? 'FAIL' : 'PASS'}** (${results.length} captures)

| Capture | Labels | Personal-data hits | Reads without a fixture |
|---|---|---|---|
${rows.join('\n')}
`);
for (const r of results) console.log(`${r.findings.length || r.refused.length ? 'FAIL' : 'PASS'} ${r.name} (${r.labels} labels)${r.findings.length ? ' personal: ' + r.findings.map(f => f.kind).join(', ') : ''}${r.refused.length ? ' unanswered reads: ' + r.refused.join(', ') : ''}`);
console.log(`${failed.length ? 'FAIL' : 'PASS'}: ${results.length} captures in ${path.relative(root, out) || out}`);
if (failed.length) process.exitCode = 1;
