import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { personalMatch } from './shared/cc/refs.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.join(root, 'runtime/lifecycle-screens'); await fs.mkdir(runtime, { recursive: true });
const alias = { name: 'fixture-host', setup(b) {
  b.onResolve({ filter: /^(react|react-native|react\/jsx-runtime)$/ }, () => ({ path: path.join(root, 'screens/lifecycle/dom.mjs') }));
  b.onResolve({ filter: /^\.\/use-contract$/ }, () => ({ path: path.join(root, 'screens/lifecycle/rpc.mjs') }));
  b.onResolve({ filter: /shared\/worktree-lifecycle$/ }, () => ({ path: 'contracts', namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const cleanupPreviewRpc={name:'organization.cleanup-preview'},cleanupApplyRpc={name:'organization.cleanup-apply'},cleanupRetentionRpc={name:'organization.cleanup-retention'};`, loader: 'js' }));
} };
const bundle = await build({ entryPoints: [path.join(root, 'screens/lifecycle/entry.tsx')], bundle: true, write: false, platform: 'browser', jsx: 'automatic', plugins: [alias] });
const html = path.join(runtime, 'index.html'); await fs.writeFile(html, `<html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`);
for (const [width, height] of [[1280, 800], [390, 844]]) for (const theme of ['dark', 'light']) for (const scroll of [false, true]) {
  const out = path.join(root, `../../local/screens/worktree-lifecycle/${theme}-${width}${scroll ? '-confirm' : ''}.png`);
  const r = spawnSync(process.argv[2], [`${pathToFileURL(html).href}?theme=${theme}&scroll=${scroll ? 1 : 0}`, out, String(width), String(height)], { encoding: 'utf8', timeout: 40000 });
  if (r.status !== 0) throw Error(`Screenshot failed: ${r.status} ${r.stdout} ${r.stderr}`);
  const data = JSON.parse(await fs.readFile(out + '.json', 'utf8'));
  if (!data.confirm || data.overflow || personalMatch(data.text) || data.calls.length !== 2) throw Error('Fixture/privacy gate failed');
  console.log(`${theme} ${width}×${height}${scroll ? ' confirmation' : ''}: preview, confirm, layout and privacy passed`);
}
